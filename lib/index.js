/**
 * @sucooer/dsh-keypilot —— DeepSeek Harness 的企业级无感密钥轮换、
 * 预判限流与跨提供商故障转移引擎。
 *
 * ## 一条主线
 *
 * 宿主的模型路由完全不动，插件只在**凭据解析**这一处换手：请求发出去之前，
 * 由密钥池决定这次用哪一把密钥；失败且尚未吐出内容时，换下一把重来。因此
 * 提供商身份自始至终不变，多轮会话、工具状态与可重放性都不受影响。
 *
 * ## 模块划分
 *
 * ```
 * lib/core/      纯逻辑（限流账本、退避、熔断、池选择、路由校验）—— 无宿主依赖，可单测
 * lib/runtime/   宿主接缝（轮换引擎、路由注册、配置、状态、HTTP 桥）
 * lib/index.js   装配：把上面两层接到 cordis 生命周期上
 * lib/client.js  设置面板（浏览器端），把分区接进系统设置的左侧导航
 * ```
 *
 * ## 安全底线
 *
 * 插件**从不保存密钥值**：配置里只有凭据引用名，真实值始终留在宿主的凭证服务里。
 * 唯一的例外是「密钥泄漏探测器」——用户若把密钥本体粘进引用名栏，保存会被拒绝，
 * 因为那会让明文落到磁盘上的配置文件里。
 *
 * @module @sucooer/dsh-keypilot
 */

import Schema from '@deepseek-ai/schemastery'
import { AsyncLocalStorage } from 'node:async_hooks'

import {
  BUILTIN_PROVIDERS,
  ConcurrencyTracker,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_SWITCH_KINDS,
  LatencyHistogram,
  KeyPool,
  NotifyQueue,
  ROUTING_STRATEGIES,
  UsageLedger,
  WEBHOOK_KINDS,
  applyProbeVerdict,
  collectRoutes,
  dayKey,
  estimateCost,
  judgeProbe,
  nowMono,
  planProbes,
  probeEndpointFor,
  usageBreakdown,
} from './core/index.js'
import { createConfigStore } from './runtime/config.js'
import { createStateStore } from './runtime/state.js'
import { createRotationEngine } from './runtime/rotate.js'
import { createCustomRouteRegistry } from './runtime/custom-routes.js'
import { createProbeRunner } from './runtime/probe.js'
import { createNotifier } from './runtime/notifier.js'
import {
  BRIDGE_ACTION_PATH,
  BRIDGE_CONFIG_PATH,
  BRIDGE_STATE_PATH,
  BRIDGE_USAGE_PATH,
  createBridgeHandler,
} from './runtime/http-bridge.js'

/** 插件标识（与 package.json 的 name 一致）。 */
export const name = '@sucooer/dsh-keypilot'

/**
 * 必需的服务。
 *
 * 只声明真正缺了就毫无意义的两个：没有 `llm` 就没有流可拦，没有 `credentials`
 * 就换不了密钥。`webServer` 与 `settings` 一律用可选注入——没有它们插件照样
 * 轮换密钥，只是少了设置面板。
 */
export const inject = ['llm', 'credentials']

/** 参数上限，与 runtime/config.js 保持一致。 */
const BREAKER_THRESHOLD_MAX = 100

/**
 * 插件的配置结构。
 *
 * 这份 schema 的作用是让宿主为这一行生成原生配置页，并且校验用户写在
 * cordis.patch.yml 里的值。运行时真正生效的配置由
 * {@link module:@sucooer/dsh-keypilot/runtime/config} 归一化后决定——它还会叠加
 * 设置面板里的改动。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    keys: Schema.array(Schema.string()).default([]),
    weights: Schema.array(Schema.number()).default([]),
    paused: Schema.array(Schema.boolean()).default([]),
    revoked: Schema.array(Schema.boolean()).default([]),
    expiresAt: Schema.array(Schema.union([Schema.number(), Schema.string()])).default([]),
    rpmLimit: Schema.number().default(0),
    tpmLimit: Schema.number().default(0),
    cooldownMs: Schema.number(),
    maxCooldownMs: Schema.number(),
    concurrencyLimit: Schema.number(),
    routingStrategy: Schema.union([...ROUTING_STRATEGIES]),
    route: Schema.object({
      id: Schema.string(),
      displayName: Schema.string(),
      baseURL: Schema.string(),
      api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
      models: Schema.array(Schema.string()).default([]),
    }),
  })).default([]),
  cascade: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string(),
  })).default([]),
  switchKinds: Schema.array(Schema.string()).default([...DEFAULT_SWITCH_KINDS]),
  cooldownMs: Schema.number().min(1000).default(60_000),
  maxCooldownMs: Schema.number().default(0),
  concurrencyLimit: Schema.number().min(0).default(0),
  rpmLimit: Schema.number().min(0).default(0),
  tpmLimit: Schema.number().min(0).default(0),
  routingStrategy: Schema.union([...ROUTING_STRATEGIES]).default('round-robin'),
  proactiveRateLimitGuard: Schema.boolean().default(true),
  circuitBreakerEnabled: Schema.boolean().default(true),
  circuitBreakerThreshold: Schema.number().min(1).max(BREAKER_THRESHOLD_MAX).default(5),
  circuitBreakerOpenMs: Schema.number().min(1000).default(30_000),
  circuitBreakerHalfOpenProbes: Schema.number().min(1).max(10).default(1),
  latencyAware: Schema.boolean().default(true),
  selfHealIntervalMinutes: Schema.number().min(1).max(1440).default(30),
  quotaResetWindow: Schema.object({
    type: Schema.union(['midnight_utc', 'midnight_pst', 'midnight_local', 'rolling_24h']).default('midnight_utc'),
    hour: Schema.number().min(0).max(23).default(0),
    timeZone: Schema.string(),
  }),
  persistenceEnabled: Schema.boolean().default(true),
  verboseLogging: Schema.boolean().default(false),
  canaryEnabled: Schema.boolean().default(true),
  canaryIntervalMinutes: Schema.number().min(1).max(1440).default(5),
  // URL 里通常嵌着 bot token，标成 secret 让宿主在界面上掩码显示。
  webhookUrl: Schema.string().role('secret').default(''),
  webhookKind: Schema.union([...WEBHOOK_KINDS]).default('generic'),
  webhookEnabled: Schema.boolean().default(false),
  notifyOnSwitch: Schema.boolean().default(true),
  notifyOnCascade: Schema.boolean().default(true),
  notifyOnExhaustion: Schema.boolean().default(true),
  notifyOnProbe: Schema.boolean().default(false),
  usageRetainDays: Schema.number().min(1).max(730).default(30),
  pricingOverrides: Schema.dict(Schema.object({
    input: Schema.number().min(0).required(),
    output: Schema.number().min(0).required(),
    cacheRead: Schema.number().min(0),
  })).default({}),
})

/** 简单日志器：优先用宿主提供的 logger，退化到 console。 */
function makeLogger(ctx) {
  const raw = (() => {
    try {
      return ctx.get?.('logger') ?? ctx.logger
    } catch {
      return undefined
    }
  })()
  const emit = (level, message) => {
    const fn = raw?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(raw, message)
        return
      } catch {
        // 宿主 logger 出错不该影响插件，落到 console。
      }
    }
    if (level === 'debug') return
    if (level === 'warn') console.warn(message)
    else console.log(message)
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    debug: (message) => emit('debug', message),
  }
}

/**
 * 插件主体。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 宿主解析出的这一行的配置
 */
export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx)
  const dispatchStorage = new AsyncLocalStorage()
  const concurrency = new ConcurrencyTracker({ limit: 0 })
  const histogram = new LatencyHistogram()

  // 三个独立的后台能力。它们都只通过事件与轮换引擎耦合——引擎不必知道
  // 「用量要记账」「失败要告警」「冷却中的密钥要去探活」，耦合越少越不容易互相拖累。
  const usageLedger = new UsageLedger({ retainDays: config.usageRetainDays })
  const notifyQueue = new NotifyQueue()
  const probeRunner = createProbeRunner({ debug: (message) => logger.debug(`[keypilot] ${message}`) })
  const notifier = createNotifier({ logger })

  const configStore = createConfigStore({
    base: config,
    persist: config.persistenceEnabled !== false,
    warn: (message) => logger.warn(`[keypilot] ${message}`),
  })

  const stateStore = createStateStore({
    enabled: config.persistenceEnabled !== false,
    warn: (message) => logger.warn(`[keypilot] ${message}`),
  })

  // ── 运行时快照 ────────────────────────────────────────────────────────────
  //
  // 池子只在配置真的变了的时候重建：健康状态活在 stateStore 里，所以重建不会
  // 丢掉冷却与失败计数，但每次请求都重建仍然毫无意义。
  let cachedRuntime
  let cachedConfigRef
  let runtimeVersion = 0

  function buildRuntime() {
    const cfg = configStore.get()
    if (cachedRuntime !== undefined && cachedConfigRef === cfg) return cachedRuntime

    /** @type {KeyPool[]} */
    const pools = []
    /** @type {Map<string, KeyPool>} */
    const byProvider = new Map()
    /** @type {Map<string, KeyPool>} */
    const refToPool = new Map()

    for (const entry of cfg.providers) {
      const provider = entry.provider
      const pool = new KeyPool({
        provider,
        config: { ...entry, __cursor: stateStore.cursorOf(provider) },
        stateStore,
        now: nowMono,
        onCursor: (cursor) => stateStore.setCursor(provider, cursor),
      })
      pools.push(pool)
      byProvider.set(provider, pool)
      for (const slot of pool.slots) {
        // 反查表：凭据被解析时用来判断它属于哪个池子。
        if (!refToPool.has(slot.ref)) refToPool.set(slot.ref, pool)
      }
    }

    concurrency.configure(cfg.concurrencyLimit)

    cachedConfigRef = cfg
    cachedRuntime = {
      version: runtimeVersion,
      enabled: cfg.enabled !== false,
      pools,
      byProvider,
      refToPool,
      cascade: cfg.cascade,
      cascadeEnabled: true,
      switchKinds: cfg.switchKinds,
      routingStrategy: cfg.routingStrategy,
      verboseLogging: cfg.verboseLogging,
      selfHealIntervalMinutes: cfg.selfHealIntervalMinutes,
      config: cfg,
    }
    return cachedRuntime
  }

  /**
   * 配置热应用：重建运行时并同步自定义路由。
   * @returns {Promise<void>}
   */
  async function applyConfig() {
    runtimeVersion += 1
    cachedRuntime = undefined
    cachedConfigRef = undefined
    const runtime = buildRuntime()
    if (logger && runtime.config.verboseLogging) {
      logger.warn(`[keypilot] 配置已更新：${runtime.pools.length} 个密钥池，共 ${runtime.pools.reduce((sum, p) => sum + p.size, 0)} 把密钥`)
    }
    await syncCustomRoutes(true)
  }

  // ── 自定义提供商路由 ──────────────────────────────────────────────────────

  const routeRegistry = createCustomRouteRegistry({ ctx, logger })
  let syncedProviders

  /**
   * 从密钥池取一把密钥的真实值，供声明式路由的适配器使用。
   *
   * 这里走的是**已被本插件接管的** `credentials.resolve`，因此冷却、退避、
   * 预判限流与并发控制在自定义路由上同样生效。
   *
   * @param {string} provider
   * @returns {Promise<string>}
   */
  async function resolveApiKeyForRoute(provider) {
    const runtime = buildRuntime()
    const pool = runtime.byProvider.get(provider)
    if (pool === undefined) {
      throw new Error(`dsh-keypilot：自定义路由 "${provider}" 没有对应的密钥池`)
    }
    let credentials
    try {
      credentials = ctx.get('credentials')
    } catch {
      credentials = undefined
    }
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      throw new Error('dsh-keypilot：宿主没有挂载凭证服务，无法为自定义路由取密钥')
    }
    // 让池子先挑一把（会跳过热密钥），再解析它的值。
    const pick = pool.pick({ concurrency, histogram })
    const ref = pick.slot === undefined ? pool.slots[0]?.ref : pick.slot.ref
    if (ref === undefined) {
      throw new Error(`dsh-keypilot：自定义路由 "${provider}" 的密钥池是空的`)
    }
    const hit = await credentials.resolve(ref)
    const value = hit?.value
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`dsh-keypilot：自定义路由 "${provider}" 没有可用密钥（${ref} 未设置）`)
    }
    return value
  }

  /**
   * 把已注册的路由与当前配置对齐。
   * @param {boolean} [force] 即使配置引用没变也强制同步
   */
  async function syncCustomRoutes(force = false) {
    const providers = configStore.get().providers
    if (!force && providers === syncedProviders) return
    syncedProviders = providers
    try {
      await routeRegistry.sync(providers, {
        resolveApiKey: resolveApiKeyForRoute,
        collectRoutes,
      })
    } catch (error) {
      logger.warn(`[keypilot] 自定义路由同步失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 轮换引擎 ──────────────────────────────────────────────────────────────

  /** 最近的事件（供设置面板的实时事件流）。 */
  const recentEvents = []

  /**
   * 把引擎事件记进用量账本。
   *
   * 只有 `success` 事件带 usage 明细，因此请求数按它计；失败与切换分别记在
   * failures / switches 上——它们同样是「这段时间发生了什么」的事实，
   * 只看请求数会漏掉最该被看见的那部分。
   */
  function recordUsage(event) {
    const cfg = configStore.get()
    if (event.type === 'success') {
      const parts = usageBreakdown(event.usage)
        ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      usageLedger.record({
        provider: event.provider,
        ref: event.ref,
        requests: 1,
        inputTokens: parts.inputTokens,
        outputTokens: parts.outputTokens,
        cacheReadTokens: parts.cacheReadTokens,
        cacheWriteTokens: parts.cacheWriteTokens,
        cost: estimateCost({ model: event.model, ...parts, overrides: cfg.pricingOverrides }),
      })
      return
    }
    if (event.type === 'switch') {
      usageLedger.record({ provider: event.provider, ref: event.from, failures: 1, switches: 1 })
      return
    }
    if (event.type === 'exhaustion') {
      usageLedger.record({ provider: event.provider, failures: 1 })
    }
  }

  /** 按配置决定这条事件要不要推给 Webhook。 */
  function enqueueNotification(event) {
    const cfg = configStore.get()
    if (cfg.webhookEnabled !== true) return
    if (typeof cfg.webhookUrl !== 'string' || cfg.webhookUrl.length === 0) return
    const wanted =
      (event.type === 'switch' && cfg.notifyOnSwitch === true)
      || (event.type === 'cascade' && cfg.notifyOnCascade === true)
      || (event.type === 'exhaustion' && cfg.notifyOnExhaustion === true)
      || (event.type === 'probe' && cfg.notifyOnProbe === true)
    if (!wanted) return
    notifyQueue.push(event)
  }

  const engine = createRotationEngine({
    getRuntime: buildRuntime,
    dispatchStorage,
    concurrency,
    histogram,
    logger,
    onEvent: (event) => {
      const entry = { ...event, at: Date.now() }
      recentEvents.push(entry)
      if (recentEvents.length > 100) recentEvents.shift()
      recordUsage(entry)
      enqueueNotification(entry)
    },
  })

  /**
   * 取未被接管的凭据解析函数。
   *
   * 探测必须读**真实密钥值**，不能走被本插件包装过的 resolve——那个会按池子轮换，
   * 探出来的结果就未必属于被探的那把密钥了。
   *
   * @returns {((ref: string) => Promise<{ value?: string } | undefined>) | undefined}
   */
  function rawResolve() {
    let credentials
    try {
      credentials = ctx.get('credentials')
    } catch {
      return undefined
    }
    if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
    const original = credentials.__dshKeypilotOriginalResolve ?? credentials.resolve
    return typeof original === 'function' ? original.bind(credentials) : undefined
  }

  /**
   * 推出某个提供商用于探活的模型列表端点。
   *
   * 按可靠性从高到低尝试：条目上的显式声明 → 声明式路由的 Base URL → 内置目录
   * 的同名条目 → 宿主自己的提供商信息。全都拿不到就不探测——**猜一个端点去发请求
   * 比不探测更糟**。
   *
   * @param {string} provider
   * @returns {string} 空串表示无法确定
   */
  function probeEndpointForProvider(provider) {
    const entry = configStore.get().providers.find((item) => item.provider === provider)
    if (entry !== undefined) {
      if (typeof entry.probeBaseURL === 'string' && entry.probeBaseURL.length > 0) {
        return probeEndpointFor(entry.probeBaseURL)
      }
      if (typeof entry.route?.baseURL === 'string' && entry.route.baseURL.length > 0) {
        return probeEndpointFor(entry.route.baseURL)
      }
    }
    const preset = BUILTIN_PROVIDERS.find((item) => item.id === provider)
    if (preset !== undefined) return probeEndpointFor(preset.baseURL)
    try {
      const info = typeof ctx.llm?.providerInfo === 'function' ? ctx.llm.providerInfo(provider) : undefined
      const baseURL = info?.baseURL ?? info?.baseUrl
      if (typeof baseURL === 'string' && baseURL.length > 0) return probeEndpointFor(baseURL)
    } catch {
      // 宿主没这个方法或签名不同，忽略——拿不到端点就不探测。
    }
    return ''
  }

  /**
   * 走一轮金丝雀探测：对冷却中的密钥探一次活，成功就让它提前归队。
   *
   * @returns {Promise<number>} 实际探测的密钥数
   */
  async function runProbeSweep() {
    const cfg = configStore.get()
    if (cfg.canaryEnabled !== true) return 0
    const resolveRaw = rawResolve()
    if (resolveRaw === undefined) return 0

    const runtime = buildRuntime()
    const intervalMs = Math.max(60_000, cfg.canaryIntervalMinutes * 60_000)
    let probed = 0

    for (const pool of runtime.pools) {
      if (pool.size === 0) continue
      const endpoint = probeEndpointForProvider(pool.provider)
      if (endpoint.length === 0) continue

      const targets = planProbes(
        pool.slots.map((slot) => ({
          ref: slot.ref,
          cooldownUntil: slot.cooldownUntil,
          lastProbeAt: slot.lastProbeAt,
          revoked: slot.revoked,
          paused: slot.paused,
        })),
        { now: nowMono(), intervalMs },
      )

      for (const ref of targets) {
        const slot = pool.slotOf(ref)
        if (slot === undefined) continue
        try {
          const hit = await resolveRaw(ref)
          const apiKey = hit?.value
          if (typeof apiKey !== 'string' || apiKey.length === 0) {
            // 这把密钥本身没有配置值，探活没有意义，但也要打上时间戳，
            // 否则每一轮巡检都会为它重复走一遍 resolve。
            slot.lastProbeAt = nowMono()
            continue
          }
          const result = await probeRunner.probe({
            endpoint,
            apiKey,
            protocol: configStore.get().providers.find((item) => item.provider === pool.provider)?.route?.api,
            provider: pool.provider,
            ref,
          })
          const verdict = judgeProbe({
            status: result.status,
            currentCooldownMs: slot.cooldownRemainingMs(nowMono()),
            baseCooldownMs: pool.cooldownMs,
            maxCooldownMs: pool.maxCooldownMs,
          })
          applyProbeVerdict(slot, verdict, nowMono())
          probed += 1
          logger.debug(`[keypilot] 探测 ${pool.provider}/${ref}：${verdict.reason}`)
          enqueueNotification({
            type: 'probe',
            provider: pool.provider,
            ref,
            outcome: verdict.action,
            reason: verdict.reason,
            at: Date.now(),
          })
        } catch (error) {
          // 探测失败绝不能冒泡出去打断巡检里的其他密钥。
          logger.debug(`[keypilot] 探测 ${pool.provider}/${ref} 异常：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return probed
  }

  // ── 装配：凭据钩子 ────────────────────────────────────────────────────────
  //
  // 这是整套机制的核心：宿主解析某个凭据引用时，本插件把它换成池子里这次该用的
  // 那一把。提供商 ID 不变，因此会话状态、工具调用与可重放性完全不受影响。

  ctx.effect(() => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      logger.warn('[keypilot] 宿主未挂载凭证服务，密钥轮换不会生效')
      return
    }
    const original = credentials.resolve.bind(credentials)
    // 探测需要「不经池子选择」的原始解析；挂在实例上比闭包更可靠——
    // 插件重载后新一轮 apply 仍能找到它，不会把包装过的函数当成原始版本。
    credentials.__dshKeypilotOriginalResolve = original

    credentials.resolve = async (ref) => {
      const runtime = buildRuntime()
      if (runtime.enabled === false) return original(ref)

      // 本次请求已经选定了密钥：请求内的所有解析都必须复用它，否则会出现
      // 「请求发到 A、重试算在 B 头上」的错乱。
      const store = dispatchStorage.getStore()
      if (store !== undefined) {
        if (store.pickedRef !== null && store.pickedRef !== undefined) {
          return original(store.pickedRef)
        }
        // 请求上下文里但还没选（例如密钥池是空的）：按普通路径解析。
        return original(ref)
      }

      // 不在受管请求里（embedding、批处理、其他插件的独立调用）：按池子挑一把，
      // 让这些调用也能享受轮换与冷却。
      const pool = runtime.refToPool.get(ref)
      if (pool === undefined) return original(ref)
      const pick = pool.pick({ concurrency, histogram })
      if (pick.slot === undefined) {
        // 池子此刻不可用：交回原逻辑，让上游给出它自己的真实错误，
        // 而不是由插件编造一个「密钥耗尽」。
        return original(ref)
      }
      return original(pick.slot.ref)
    }

    return () => {
      // 卸载时还原：留下一个被包装的 resolve 会污染宿主。
      if (credentials.resolve !== original) credentials.resolve = original
      if (credentials.__dshKeypilotOriginalResolve === original) {
        delete credentials.__dshKeypilotOriginalResolve
      }
    }
  }, 'keypilot: 凭据解析拦截')

  // ── 装配：流拦截 ──────────────────────────────────────────────────────────

  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    const runtime = buildRuntime()
    if (runtime.enabled === false) return next()
    return engine.rotate(options, next)
  }), 'keypilot: llm/stream 轮换')

  // ── 装配：自定义路由跟随配置变化 ──────────────────────────────────────────

  ctx.effect(() => {
    let disposed = false
    const run = () => {
      if (disposed) return
      void syncCustomRoutes()
    }
    run()
    /** @type {Array<() => void>} */
    const offs = []
    if (typeof ctx.on === 'function') {
      for (const event of ['settings/document-updated', 'loader/volatile-update', 'config']) {
        try {
          const off = ctx.on(event, run)
          if (typeof off === 'function') offs.push(off)
        } catch {
          // 该事件在当前宿主版本上不存在，忽略。
        }
      }
    }
    return () => {
      disposed = true
      for (const off of offs) {
        try {
          off()
        } catch {
          // 已经注销过了。
        }
      }
      routeRegistry.dispose()
    }
  }, 'keypilot: 自定义路由同步')

  // ── 装配：周期维护 ────────────────────────────────────────────────────────

  ctx.effect(() => {
    /** 上一次金丝雀巡检的时刻（墙钟）。 */
    let lastProbeSweepAt = 0
    /** 防止上一轮巡检还没跑完就又起一轮。 */
    let probeRunning = false

    const timer = setInterval(() => {
      try {
        const runtime = buildRuntime()
        let touched = 0
        for (const pool of runtime.pools) touched += pool.maintain()
        if (touched > 0) logger.debug(`[keypilot] 维护：更新了 ${touched} 个密钥槽状态`)

        // 清理已不在配置里的历史状态，避免状态文件长期增长。
        const liveKeys = new Set()
        for (const pool of runtime.pools) {
          for (const slot of pool.slots) liveKeys.add(`${pool.provider}\u0000${slot.ref}`)
        }
        stateStore.prune(liveKeys)
        stateStore.flush()

        // 用量账本按保留期裁剪：跑几周的任务不能把内存吃光。
        usageLedger.retainDays = runtime.config.usageRetainDays
        const dropped = usageLedger.compact()
        if (dropped > 0) logger.debug(`[keypilot] 用量账本丢弃了 ${dropped} 个过期日期桶`)

        // 通知：窗口到期且不在退避中时推一批出去。推送是异步的，不阻塞巡检。
        if (notifyQueue.ready()) {
          const batch = notifyQueue.take()
          const cfg = runtime.config
          void notifier.send({ url: cfg.webhookUrl, kind: cfg.webhookKind, events: batch })
            .then((ok) => notifyQueue.markResult(ok))
            .catch(() => notifyQueue.markResult(false))
        }

        // 金丝雀巡检：按配置的间隔触发，且同一时刻只跑一轮。
        const canaryDue = runtime.config.canaryEnabled === true
          && Date.now() - lastProbeSweepAt >= Math.max(60_000, runtime.config.canaryIntervalMinutes * 60_000)
        if (canaryDue && !probeRunning) {
          lastProbeSweepAt = Date.now()
          probeRunning = true
          void runProbeSweep()
            .catch((error) => logger.debug(`[keypilot] 巡检出错：${error instanceof Error ? error.message : String(error)}`))
            .finally(() => { probeRunning = false })
        }
      } catch (error) {
        logger.warn(`[keypilot] 维护任务出错：${error instanceof Error ? error.message : String(error)}`)
      }
    }, 30_000)
    if (typeof timer.unref === 'function') timer.unref()

    // 插件一加载就先探一轮：重启后池子里可能全是上次留下的冷却状态。
    lastProbeSweepAt = Date.now() - Math.max(60_000, configStore.get().canaryIntervalMinutes * 60_000)

    return () => clearInterval(timer)
  }, 'keypilot: 周期维护')

  // ── 装配：设置面板的 HTTP 桥 ──────────────────────────────────────────────

  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return

    const handler = createBridgeHandler({
      logger,
      getState: () => {
        const runtime = buildRuntime()
        const routes = routeRegistry.snapshot()
        return {
          ok: true,
          version: runtime.version,
          enabled: runtime.enabled,
          config: runtime.config,
          // 内置提供商目录由主机端下发：面板不重复维护一份副本，
          // 目录更新只改 core/provider-catalog.js 一处。
          catalog: BUILTIN_PROVIDERS,
          paths: { configFile: configStore.file, stateFile: stateStore.file },
          pools: runtime.pools.map((pool) => pool.snapshot({ concurrency, histogram })),
          routes: {
            registered: routes.registered,
            errors: [...routes.errors.entries()].map(([provider, message]) => ({ provider, message })),
          },
          concurrency: concurrency.snapshot(),
          events: recentEvents.slice(-40),
          // 用量只给汇总，明细走 /dsh-keypilot/usage（那个支持 CSV 导出）。
          usage: {
            totals: usageLedger.totals(),
            recent: usageLedger.snapshot().days.slice(-7),
            retainDays: usageLedger.retainDays,
            droppedDays: usageLedger.droppedDays,
          },
          notify: {
            enabled: runtime.config.webhookEnabled === true,
            kind: runtime.config.webhookKind,
            pending: notifyQueue.pending,
            failures: notifyQueue.failures,
            cooling: notifyQueue.cooling,
            backoffMs: notifyQueue.backoffRemainingMs(),
            dropped: notifyQueue.dropped,
          },
          canary: {
            enabled: runtime.config.canaryEnabled === true,
            intervalMinutes: runtime.config.canaryIntervalMinutes,
          },
          warnings: configStore.warnings,
        }
      },
      getUsage: (query) => {
        if (query.format === 'csv') {
          const days = query.days
          return {
            format: 'csv',
            body: usageLedger.toCsv(days),
            // 用本地日期做文件名：用户看到的「今天」是本地日历，不是 UTC。
            filename: `keypilot-usage-${dayKey()}.csv`,
          }
        }
        const snapshot = usageLedger.snapshot()
        return {
          format: 'json',
          body: JSON.stringify({
            ...snapshot,
            byProvider: usageLedger.byProvider(),
            byKey: usageLedger.byKey(),
            recentDays: usageLedger.snapshot().days.slice(-30),
          }),
          filename: 'keypilot-usage.json',
        }
      },
      putConfig: async (payload) => {
        const result = configStore.set(payload)
        if (!result.ok) return { ok: false, message: result.message }
        await applyConfig()
        return {
          ok: true,
          warnings: result.warnings,
          message: result.warnings.length > 0
            ? `已保存，但有 ${result.warnings.length} 条条目被忽略`
            : '已保存并生效',
        }
      },
      runAction: async (payload) => {
        const runtime = buildRuntime()
        const action = payload?.action
        const provider = typeof payload?.provider === 'string' ? payload.provider : undefined
        const ref = typeof payload?.ref === 'string' ? payload.ref : undefined

        if (action === 'reset-cooldown') {
          let cleared = 0
          for (const pool of runtime.pools) {
            if (provider !== undefined && pool.provider !== provider) continue
            for (const slot of pool.slots) {
              if (ref !== undefined && slot.ref !== ref) continue
              if (slot.cooldownUntil > 0 || slot.failures > 0) cleared += 1
              slot.cooldownUntil = 0
              slot.failures = 0
            }
          }
          return { ok: true, message: `已重置 ${cleared} 个密钥槽的冷却与失败计数` }
        }

        if (action === 'toggle-key') {
          const pool = provider === undefined ? undefined : runtime.byProvider.get(provider)
          const slot = pool?.slotOf(ref ?? '')
          if (slot === undefined) return { ok: false, message: '找不到这个密钥' }
          const enabled = payload?.enabled === true
          slot.paused = !enabled
          return { ok: true, message: enabled ? `已启用 ${slot.ref}` : `已停用 ${slot.ref}` }
        }

        if (action === 'sync-routes') {
          await syncCustomRoutes(true)
          const snapshot = routeRegistry.snapshot()
          return {
            ok: true,
            message: `已同步：${snapshot.registered.length} 条路由生效`
              + (snapshot.errors.size > 0 ? `，${snapshot.errors.size} 条失败` : ''),
          }
        }

        if (action === 'probe') {
          const probed = await runProbeSweep()
          return {
            ok: true,
            message: probed === 0
              ? '没有需要探测的密钥（都不在冷却中，或拿不到探测端点）'
              : `已探测 ${probed} 把冷却中的密钥`,
          }
        }

        if (action === 'test-webhook') {
          const cfg = configStore.get()
          if (typeof cfg.webhookUrl !== 'string' || cfg.webhookUrl.length === 0) {
            return { ok: false, message: '还没有填写 Webhook 地址' }
          }
          const result = await notifier.test({ url: cfg.webhookUrl, kind: cfg.webhookKind })
          return result
        }

        if (action === 'clear-usage') {
          usageLedger.clear()
          return { ok: true, message: '用量账本已清空' }
        }

        return { ok: false, message: `未知操作：${String(action)}` }
      },
    })

    /** @type {Array<() => void>} */
    const disposers = []
    for (const path of [BRIDGE_STATE_PATH, BRIDGE_CONFIG_PATH, BRIDGE_ACTION_PATH, BRIDGE_USAGE_PATH]) {
      try {
        const dispose = webServer.register({ kind: 'exact', path, handler })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        logger.warn(`[keypilot] 无法注册设置桥路由 ${path}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    logger.info(`[keypilot] 设置桥已就绪：${BRIDGE_STATE_PATH}`)

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 路由 fiber 已经随着关闭一起没了。
        }
      }
    }
  })

  // ── 装配：自身 Config 变化时热应用 ────────────────────────────────────────
  //
  // 宿主为这一行重建配置（用户编辑了 profile patch、或从原生配置页改了值）时，
  // 用新的 Config 重新归一化。插件自己文件里的改动依然优先，因此面板上的编辑
  // 不会被一次宿主重载冲掉。

  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return
    let off
    try {
      off = ctx.on('settings/document-updated', (ns) => {
        if (typeof ns === 'string' && ns.includes('keypilot')) {
          configStore.rebase(configStore.base)
          void applyConfig()
        }
      })
    } catch {
      // 该宿主版本没有这个事件，忽略。
      return
    }
    return () => {
      if (typeof off === 'function') off()
    }
  }, 'keypilot: 宿主配置变化热应用')

  stateStore.flush()
  logger.info(`[keypilot] 已加载：${configStore.get().providers.length} 个密钥池，共 ${configStore.get().providers.reduce((sum, p) => sum + p.keys.length, 0)} 把密钥`)
}
