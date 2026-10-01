/**
 * 轮换引擎：拦截一次模型调用，在失败时换一把密钥重试。
 *
 * ## 为什么不用「一个密钥一条路由」
 *
 * 宿主的模型选择器只能列出已注册的路由，因此「池里有 3 把密钥就注册 3 条路由」
 * 是最直觉的做法——也是同类实现 bug 最集中的地方（路由撞车、孤儿路由、级联递归）。
 * 这里换一条路：**路由不动，只换解析出来的密钥**。密钥在 `credentials.resolve`
 * 处被替换，提供商身份自始至终一致，多轮会话与工具状态完全不受影响。
 *
 * ## 三个必须守住的不变量
 *
 * 1. **一次请求只用一个密钥**。请求内可能多次解析凭据（例如每个工具调用各解析
 *    一次），必须都拿到同一把，否则会出现「请求发到 A、重试算在 B 头上」的错乱。
 *    用 `AsyncLocalStorage` 把本次选中的引用绑定到调用链上。
 * 2. **只在安全点重试**。一旦有内容块吐给下游，就绝不能再换密钥重试——那会让
 *    用户看到两段拼接起来的回答。重试只发生在首个内容块之前。
 * 3. **用户中断不是失败**。`finish.aborted` 与 `AbortError` 必须原样传递，
 *    绝不能「换个密钥继续」，否则用户按了停止却停不下来。
 *
 * 引擎本身不依赖 DSH 的运行时对象，全部依赖通过参数注入，因此可以用假的
 * `next()` 完整测试（见 test/runtime-rotation.test.mjs）。
 *
 * @module @sucooer/dsh-keypilot/runtime/rotate
 */

import {
  FAILURE_ACTION,
  PICK_REASON,
  classifyFailure,
  estimateRequestTokens,
  nextCascadeTarget,
  parseRetryAfter,
  tokenUsageOf,
} from '../core/index.js'

/**
 * 标记本插件自己发起的请求（级联时重新进入 waterfall）。
 *
 * 用 `Symbol.for` 而不是模块级 Symbol：热重载后新旧实例仍能互相识别同一个标记，
 * 避免级联请求被当成普通请求再次轮换而形成递归。
 */
export const ROTATION_MARKER = Symbol.for('dsh-keypilot.rotation-marker')

/** 一次模型调用内最多换几把密钥。 */
export const MAX_KEY_ATTEMPTS = 4

/** 判定「已经吐出内容」的 chunk 类型。 */
const CONTENT_CHUNK_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'])

/**
 * 判断一个 chunk 是否意味着「内容已经对外可见」。
 *
 * `block-start` 与 `usage` 不算：前者只是块的开头（可能是空块），后者是记账信息。
 * 一旦判定为真，本请求就失去了重试的资格。
 *
 * @param {unknown} chunk
 * @returns {boolean}
 */
export function isContentChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  const type = /** @type {{ type?: unknown }} */ (chunk).type
  return typeof type === 'string' && CONTENT_CHUNK_TYPES.has(type)
}

/**
 * 从 `finish` chunk 里取出完成原因。
 * @param {unknown} chunk
 * @returns {{ kind: string, failure?: unknown } | undefined}
 */
export function finishReasonOf(chunk) {
  if (chunk === null || typeof chunk !== 'object') return undefined
  const record = /** @type {{ type?: unknown, reason?: unknown }} */ (chunk)
  if (record.type !== 'finish') return undefined
  const reason = record.reason
  if (reason === null || typeof reason !== 'object') return undefined
  const kind = /** @type {{ kind?: unknown }} */ (reason).kind
  if (typeof kind !== 'string') return undefined
  return { kind, failure: /** @type {{ failure?: unknown }} */ (reason).failure }
}

/**
 * 把一次 `finish` 的失败原因整理成可分类的错误对象。
 * @param {{ kind: string, failure?: unknown }} reason
 * @returns {{ status?: number, code?: string, message: string }}
 */
export function failureOfFinishReason(reason) {
  const failure = reason.failure
  if (failure !== null && typeof failure === 'object') {
    const record = /** @type {{ code?: unknown, message?: unknown, status?: unknown }} */ (failure)
    return {
      ...(Number.isFinite(Number(record.status)) ? { status: Number(record.status) } : {}),
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      message: typeof record.message === 'string' ? record.message : '',
    }
  }
  return { code: reason.kind, message: '' }
}

/**
 * 从响应头里取出上游要求的等待时长。
 * @param {unknown} headers
 * @returns {number | undefined}
 */
export function retryAfterFromHeaders(headers) {
  if (headers === null || typeof headers !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (headers)
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === 'retry-after') {
      return parseRetryAfter(String(record[key]))
    }
  }
  return undefined
}

/**
 * 建一个轮换引擎。
 *
 * @param {object} deps
 * @param {() => object} deps.getRuntime 取运行时快照（池、级联链、开关）
 * @param {import('node:async_hooks').AsyncLocalStorage<{ pickedRef: string | null }>} deps.dispatchStorage
 * @param {{ acquire: (ref: string) => (() => void) | undefined, snapshot: () => object }} deps.concurrency
 * @param {{ record: (ref: string, ms: number) => void }} deps.histogram
 * @param {object} deps.logger
 * @param {(event: object) => void} [deps.onEvent] 事件流（供界面展示）
 * @param {number} [deps.maxKeyAttempts]
 * @returns {{ rotate: Function, selectPool: Function }}
 */
export function createRotationEngine(deps) {
  const { getRuntime, dispatchStorage, concurrency, histogram, logger } = deps
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {}
  const maxKeyAttempts = Number.isFinite(deps.maxKeyAttempts) && deps.maxKeyAttempts > 0
    ? Math.floor(deps.maxKeyAttempts)
    : MAX_KEY_ATTEMPTS

  /**
   * 按提供商（以及可选的模型）挑池子。
   * @param {object} runtime
   * @param {string} provider
   * @returns {any}
   */
  function selectPool(runtime, provider) {
    if (runtime === null || runtime === undefined) return undefined
    const byProvider = runtime.byProvider
    if (!(byProvider instanceof Map)) return undefined
    return byProvider.get(provider)
  }

  /**
   * 单次尝试：用一把密钥跑一遍流。
   *
   * 这是一个 generator，因为它必须把 chunk 原样转发给下游消费者；返回值通过
   * `return` 语句传出（generator 的 return 值可由 `yield*` 的调用方拿到）。
   *
   * @returns {AsyncGenerator<unknown, { ok: boolean, reason?: string, error?: unknown, retryAt?: number }>}
   */
  async function* attemptWithRetries(pool, options, next, context) {
    const attemptedRefs = new Set()
    let lastError
    let lastReason = 'exhausted'
    let retryAt

    for (let attempt = 0; attempt < maxKeyAttempts; attempt += 1) {
      const pick = pool.pick({
        estimatedTokens: context.estimatedTokens,
        concurrency,
        histogram,
        exclude: attemptedRefs,
      })

      if (pick.slot === undefined) {
        // 池子此刻给不出密钥。区分「耗尽」（该级联）与「饱和」（等一下更划算）。
        lastReason = pick.reason === PICK_REASON.COOLDOWN || pick.reason === PICK_REASON.EMPTY
          ? 'exhausted'
          : 'saturated'
        retryAt = pick.retryAt
        break
      }

      const slot = pick.slot
      attemptedRefs.add(slot.ref)
      const release = concurrency.acquire(slot.ref)
      // 本次请求的凭据绑定：请求内所有 resolve 都复用它。
      const store = { pickedRef: slot.ref }
      const startedAt = Date.now()
      let firstByteAt = 0
      let sawContent = false
      let sawFinish = false
      let finish = undefined
      let usageTokens
      /** 上游回报的原始 usage：保留拆分，供成本估算使用。 */
      let usageRaw
      let settled = false

      try {
        const iterator = dispatchStorage.run(store, () => next()[Symbol.asyncIterator]())
        for (;;) {
          // 每次取值都在上下文内执行：下游在该调用栈里解析凭据时才能看到本次选中的引用。
          const step = await dispatchStorage.run(store, () => iterator.next())
          if (step.done === true) break
          const chunk = step.value

          if (firstByteAt === 0 && isContentChunk(chunk)) {
            firstByteAt = Date.now()
            sawContent = true
            // 首字延迟是唯一对用户体感有意义的延迟指标。
            histogram.record(slot.ref, firstByteAt - startedAt)
          }

          const reason = finishReasonOf(chunk)
          if (reason !== undefined) {
            sawFinish = true
            finish = reason
          }

          if (chunk !== null && typeof chunk === 'object' && /** @type {any} */ (chunk).type === 'usage') {
            const tokens = tokenUsageOf(/** @type {any} */ (chunk).usage)
            if (tokens !== undefined) {
              usageTokens = tokens
              usageRaw = /** @type {any} */ (chunk).usage
              if (!settled) {
                settled = true
                slot.bucket.settle(context.estimatedTokens, tokens)
              }
              slot.usage.tokens += tokens
            }
          }

          yield chunk
        }

        // 流正常结束。判断完成原因。
        if (sawFinish && finish !== undefined) {
          if (finish.kind === 'aborted') {
            // 用户主动中断：绝不换密钥，把控制权交回。
            return { ok: true }
          }
          if (finish.kind === 'error') {
            const classification = classifyFailure(failureOfFinishReason(finish), {
              switchKinds: context.switchKinds,
            })
            if (classification.action === FAILURE_ACTION.ABORT || sawContent) {
              // 已经吐过内容 → 不能重试；中断 → 不换密钥。
              throw context.materializeError(failureOfFinishReason(finish))
            }
            if (!classification.switchable) {
              throw context.materializeError(failureOfFinishReason(finish))
            }
            // 记账必须与下面「抛异常」那条路径一致。上游用 `finish.error` 报告限流
            // 是最常见的形态（429 尤其如此），漏掉这两行会让面板把一把正在冷却的
            // 密钥显示成「原因不明」，切换次数也少算一次。
            slot.usage.switches += 1
            slot.usage.lastFailureKind = classification.kind
            const cooldown = pool.penalize(slot, {
              soft: classification.soft,
              retryAfterMs: undefined,
            })
            lastError = context.materializeError(failureOfFinishReason(finish))
            lastReason = 'retryable'
            onEvent({
              type: 'switch',
              provider: pool.provider,
              from: slot.ref,
              kind: classification.kind,
              cooldownMs: cooldown,
              attempt: attempt + 1,
            })
            logger?.warn?.(`[keypilot] ${pool.provider}：密钥 ${slot.ref} 以 ${classification.kind} 结束（${classification.message}），换下一把重试`)
            continue
          }
        }

        // 既没中断也没报错：真正的成功。
        if (!sawContent) {
          // 空响应：上游偶尔会「成功」返回一个空流，值得换一把试试。
          slot.usage.switches += 1
          slot.usage.lastFailureKind = 'EMPTY_RESPONSE'
          const cooldown = pool.penalize(slot, { soft: true })
          lastError = new Error(`上游返回了空响应（${pool.provider} / ${options.model}）`)
          lastReason = 'retryable'
          onEvent({ type: 'switch', provider: pool.provider, from: slot.ref, kind: 'EMPTY_RESPONSE', cooldownMs: cooldown, attempt: attempt + 1 })
          logger?.warn?.(`[keypilot] ${pool.provider}：密钥 ${slot.ref} 返回空响应，换下一把重试`)
          continue
        }

        pool.markSuccess(slot)
        onEvent({
          type: 'success',
          provider: pool.provider,
          ref: slot.ref,
          model: options.model,
          ttftMs: firstByteAt === 0 ? undefined : firstByteAt - startedAt,
          usage: usageRaw,
        })
        return { ok: true }
      } catch (error) {
        const classification = classifyFailure(error, { switchKinds: context.switchKinds })
        const retryAfterMs = retryAfterFromHeaders(/** @type {any} */ (error)?.headers)

        if (classification.action === FAILURE_ACTION.ABORT) {
          // 用户中断：原样抛出，绝不重试。
          throw error
        }
        if (sawContent) {
          // 已经吐过内容，重试会让用户看到拼接的回答——宁可直接失败。
          throw error
        }
        if (!classification.switchable) {
          // 请求本身有问题（上下文过长、参数非法）：换密钥不会成功。
          throw error
        }

        slot.usage.switches += 1
        slot.usage.lastFailureKind = classification.kind
        const cooldown = pool.penalize(slot, {
          soft: classification.soft,
          retryAfterMs,
        })
        lastError = error
        lastReason = 'retryable'
        onEvent({
          type: 'switch',
          provider: pool.provider,
          from: slot.ref,
          kind: classification.kind,
          status: classification.status,
          cooldownMs: cooldown,
          attempt: attempt + 1,
        })
        logger?.warn?.(`[keypilot] ${pool.provider}：密钥 ${slot.ref} 失败（${classification.kind}${classification.status === undefined ? '' : ` ${classification.status}`}），冷却 ${Math.round(cooldown / 1000)}s 后换下一把`)
      } finally {
        // 幂等释放；即使上面的分支提前 return/throw，额度也一定归还。
        release?.()
      }
    }

    return { ok: false, reason: lastReason, error: lastError, retryAt }
  }

  /**
   * 轮换入口：供 `llm/stream` 钩子调用。
   */
  async function* rotate(options, next, context = {}) {
    const runtime = getRuntime()
    if (runtime === null || runtime === undefined || runtime.enabled === false) {
      yield* next()
      return
    }

    // 已经是本插件发起的级联请求：直接交给下游，避免递归。
    if (/** @type {any} */ (options)?.[ROTATION_MARKER] === true) {
      yield* next()
      return
    }

    let pool = selectPool(runtime, options.provider)
    if (pool === undefined || pool.size === 0) {
      // 这个提供商没有配池子、或池子里还没有密钥：完全不管，让请求照常走。
      // 声明了路由但还没填密钥是很常见的中间状态，此时插件不该破坏正常请求。
      yield* next()
      return
    }

    const switchKinds = Array.isArray(runtime.switchKinds) ? runtime.switchKinds : undefined
    const estimatedTokens = estimateRequestTokens({
      messages: /** @type {any} */ (options).messages,
      system: /** @type {any} */ (options).system,
      tools: /** @type {any} */ (options).tools,
      maxTokens: /** @type {any} */ (options).maxTokens,
    })

    let currentOptions = options
    let currentPool = pool
    const attemptedProviders = new Set([options.provider])
    let depth = 0
    let lastFailure

    for (;;) {
      /** @type {Error | undefined} */
      let materialized

      const attemptContext = {
        estimatedTokens,
        switchKinds,
        materializeError: (failure) => {
          const error = new Error(
            typeof failure?.message === 'string' && failure.message.length > 0
              ? failure.message
              : `模型调用失败（${String(failure?.code ?? 'UNKNOWN')}）`,
          )
          if (typeof failure?.code === 'string') /** @type {any} */ (error).code = failure.code
          if (failure?.status !== undefined) /** @type {any} */ (error).status = failure.status
          return error
        },
      }

      const outcome = yield* attemptWithRetries(currentPool, currentOptions, next, attemptContext)

      if (outcome.ok) return
      lastFailure = outcome

      // 密钥用完/不可用：尝试跨提供商级联。
      const canCascade = runtime.cascadeEnabled !== false && depth < 4
      if (canCascade) {
        const hasPool = (provider) => selectPool(runtime, provider) !== undefined
        const target = nextCascadeTarget({
          cascade: runtime.cascade,
          fromProvider: currentOptions.provider,
          model: currentOptions.model,
          attempted: attemptedProviders,
          depth,
          hasPool,
        })
        if (target !== undefined) {
          const nextPool = selectPool(runtime, target.provider)
          if (nextPool !== undefined && nextPool.size > 0) {
            attemptedProviders.add(target.provider)
            depth += 1
            currentPool = nextPool
            // 请求对象可能是深度冻结的（loop 构造的请求），因此必须新建一个。
            currentOptions = {
              ...currentOptions,
              provider: target.provider,
              model: target.model,
              [ROTATION_MARKER]: true,
            }
            onEvent({
              type: 'cascade',
              from: options.provider,
              to: target.provider,
              model: target.model,
              depth,
            })
            logger?.warn?.(`[keypilot] ${options.provider} 池已耗尽，级联到备用提供商 ${target.provider}（第 ${depth} 跳）`)
            continue
          }
        }
      }

      // 无路可走：把最后一次的真实错误抛出去；没有错误时给一句可读的耗尽说明。
      if (outcome.error !== undefined) throw outcome.error
      const retryHint = Number.isFinite(outcome.retryAt)
        ? `，最早约 ${Math.max(1, Math.round((outcome.retryAt - Date.now()) / 1000))}s 后恢复`
        : ''
      const reasonText = outcome.reason === 'saturated'
        ? '所有密钥此刻都已达到速率/并发上限'
        : '所有密钥均在冷却或被停用'
      // 池子彻底耗尽是要叫人的事件：用户配的 webhook 会收到它。
      onEvent({
        type: 'exhaustion',
        provider: options.provider,
        model: options.model,
        reason: outcome.reason,
        attempted: [...attemptedProviders],
        retryAt: outcome.retryAt,
      })
      throw new Error(
        `dsh-keypilot：${options.provider} ${reasonText}${retryHint}。`
        + `已尝试 ${attemptedProviders.size} 个提供商（${[...attemptedProviders].join(' → ')}）。`
        + '请检查密钥池配置，或调高 rpmLimit / 增加密钥 / 配置 cascade 备用提供商。',
      )
    }
  }

  return { rotate, selectPool, ROTATION_MARKER }
}
