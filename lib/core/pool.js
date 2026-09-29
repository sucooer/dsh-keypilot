/**
 * 密钥池：一组凭据引用 + 它们各自的健康状态。
 *
 * 池子要回答的只有一个问题：**这一次请求该用哪把密钥**。但回答它需要同时照顾
 * 四件事，任何一件做漏都会表现为「插件没起作用」：
 *
 * 1. **可不可用**：冷却中、被暂停、被吊销、已过期的密钥一律不选；
 * 2. **会不会超限**：按本地 RPM/TPM 账本预判，饱和的不选——这是「预判限流」；
 * 3. **忙不忙**：在飞请求已满的不选——这是「最小连接数」；
 * 4. **怎么选**：轮询 / 最小负载 / 最低延迟三种策略。
 *
 * 关键在于**区分「耗尽」与「饱和」**：
 *
 * - 全部密钥都在冷却 → 这个池子短期没救了，应该**级联到备用提供商**；
 * - 全部密钥都被预判限流或并发占满 → 它们其实都是好的，只是此刻忙，
 *   **等一下比换提供商更划算**（换过去也是同样的限流）。
 *
 * 因此 {@link KeyPool#pick} 不只返回「选了谁」，还返回「为什么没选成」。
 *
 * @module @sucooer/dsh-keypilot/core/pool
 */

import { nowMono } from './clock.js'
import { TokenBucket } from './token-bucket.js'
import { computeBackoff, decayPenalty } from './backoff.js'

/** 可选的调度策略。 */
export const ROUTING_STRATEGIES = Object.freeze(['round-robin', 'least-loaded', 'lowest-latency'])

/** pick 的返回原因。 */
export const PICK_REASON = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  COOLDOWN: 'cooldown',
  PAUSED: 'paused',
  RATE_LIMITED: 'rate-limited',
  CONCURRENCY: 'concurrency',
})

/** 默认冷却。 */
export const DEFAULT_COOLDOWN_MS = 60_000

/**
 * 把原始输入收敛成合法策略名。
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeStrategy(raw, fallback = 'round-robin') {
  return typeof raw === 'string' && ROUTING_STRATEGIES.includes(raw) ? raw : fallback
}

/** 把「第 i 把密钥」的开关数组取成布尔。 */
function flagAt(list, index) {
  return Array.isArray(list) && list[index] === true
}

/** 把数字数组取成有限数。 */
function numberAt(list, index, fallback = 0) {
  if (!Array.isArray(list)) return fallback
  const value = Number(list[index])
  return Number.isFinite(value) ? value : fallback
}

/**
 * 一个密钥槽：引用名 + 全部运行时健康状态。
 *
 * 状态与配置**分开存放**：`KeySlot` 由设置构建，而冷却、失败计数、用量这些
 * 运行时事实存放在 {@link AbstractStateStore} 里，配置重载时不会丢。
 */
export class KeySlot {
  /**
   * @param {object} options
   * @param {string} options.ref 凭据引用名
   * @param {number} [options.weight] 加权轮询的票数
   * @param {boolean} [options.paused] 用户手动暂停
   * @param {boolean} [options.revoked] 用户标记为已泄露/作废
   * @param {number} [options.expiresAt] 墙钟过期时间戳
   * @param {TokenBucket} options.bucket
   * @param {object} [options.state] 已有的运行时状态
   */
  constructor(options) {
    this.ref = options.ref
    this.weight = Number.isFinite(options.weight) && options.weight > 0 ? Math.floor(options.weight) : 1
    this.paused = options.paused === true
    this.revoked = options.revoked === true
    this.expiresAt = Number.isFinite(options.expiresAt) ? options.expiresAt : 0
    this.bucket = options.bucket

    const state = options.state ?? {}
    /** 冷却截止（单调时间）。 */
    this.cooldownUntil = Number.isFinite(state.cooldownUntil) ? state.cooldownUntil : 0
    /** 连续失败次数，用于指数退避。 */
    this.failures = Number.isFinite(state.failures) ? state.failures : 0
    /** 最后一次使用时刻（单调）。 */
    this.lastUsedAt = Number.isFinite(state.lastUsedAt) ? state.lastUsedAt : 0
    /** 最后一次惩罚衰减时刻（单调）。 */
    this.lastDecayAt = Number.isFinite(state.lastDecayAt) ? state.lastDecayAt : 0
    /** 累计用量。 */
    this.usage = {
      requests: Number.isFinite(state.usage?.requests) ? state.usage.requests : 0,
      tokens: Number.isFinite(state.usage?.tokens) ? state.usage.tokens : 0,
      switches: Number.isFinite(state.usage?.switches) ? state.usage.switches : 0,
      lastFailureKind: typeof state.usage?.lastFailureKind === 'string' ? state.usage.lastFailureKind : '',
    }
    /** 最后一次失败的性质（诊断用）。 */
    this.lastFailureAt = Number.isFinite(state.lastFailureAt) ? state.lastFailureAt : 0
  }

  /** 是否在冷却中。 */
  isCooling(now) {
    return this.cooldownUntil > now
  }

  /** 是否已过有效期（墙钟）。 */
  isExpired(wall) {
    return this.expiresAt > 0 && this.expiresAt <= wall
  }

  /** 冷却剩余毫秒。 */
  cooldownRemainingMs(now) {
    return Math.max(0, this.cooldownUntil - now)
  }

  /** 导出可持久化的状态。 */
  exportState() {
    return {
      cooldownUntil: this.cooldownUntil,
      failures: this.failures,
      lastUsedAt: this.lastUsedAt,
      lastDecayAt: this.lastDecayAt,
      lastFailureAt: this.lastFailureAt,
      usage: { ...this.usage },
    }
  }
}

/**
 * 密钥池。
 */
export class KeyPool {
  /**
   * @param {object} options
   * @param {string} options.provider 提供商 ID
   * @param {object} options.config   该提供商的设置条目
   * @param {Map<string, object>} [options.stateStore] 跨重载保留的运行时状态
   * @param {() => number} [options.now] 单调时钟
   */
  constructor(options) {
    this.provider = options.provider
    const config = options.config ?? {}
    this.config = config
    /** @type {() => number} */
    this.now = typeof options.now === 'function' ? options.now : nowMono
    this._stateStore = options.stateStore

    this.cooldownMs = Number.isFinite(Number(config.cooldownMs)) && Number(config.cooldownMs) > 0
      ? Number(config.cooldownMs)
      : DEFAULT_COOLDOWN_MS
    this.maxCooldownMs = Number.isFinite(Number(config.maxCooldownMs)) && Number(config.maxCooldownMs) > 0
      ? Number(config.maxCooldownMs)
      : this.cooldownMs * 8
    this.rpmLimit = Number.isFinite(Number(config.rpmLimit)) && Number(config.rpmLimit) > 0 ? Number(config.rpmLimit) : 0
    this.tpmLimit = Number.isFinite(Number(config.tpmLimit)) && Number(config.tpmLimit) > 0 ? Number(config.tpmLimit) : 0
    this.concurrencyLimit = Number.isFinite(Number(config.concurrencyLimit)) && Number(config.concurrencyLimit) > 0
      ? Math.floor(Number(config.concurrencyLimit))
      : 0
    this.strategy = normalizeStrategy(config.routingStrategy)

    /** @type {KeySlot[]} */
    this.slots = []
    const keys = Array.isArray(config.keys) ? config.keys : []
    const seen = new Set()
    keys.forEach((rawRef, index) => {
      if (typeof rawRef !== 'string') return
      const ref = rawRef.trim()
      // 同一把密钥在一个池子里出现两次没有意义，而且会让权重与状态都错乱。
      if (ref.length === 0 || seen.has(ref)) return
      seen.add(ref)
      const stateKey = `${this.provider}\u0000${ref}`
      const state = this._stateStore?.get(stateKey)
      this.slots.push(new KeySlot({
        ref,
        weight: numberAt(config.weights, index, 1),
        paused: flagAt(config.paused, index),
        revoked: flagAt(config.revoked, index),
        expiresAt: numberAt(config.expiresAt, index, 0),
        bucket: new TokenBucket({ rpm: this.rpmLimit, tpm: this.tpmLimit, now: this.now }),
        state,
      }))
    })

    /** 轮询指针。 */
    this._cursor = Number.isFinite(config.__cursor) ? config.__cursor : 0
    /** 指针推进时的回调，用于把「下次从哪把开始」也持久化下来。 */
    this._onCursor = typeof options.onCursor === 'function' ? options.onCursor : undefined
    /** 按权重展开的固定票序列，见 {@link KeyPool#_roundRobin}。 */
    this._plan = []
    this._buildPlan()
    /** @type {KeySlot | undefined} 最近一次选中的槽位，用于失败归因。 */
    this.lastUsed = undefined
  }

  /**
   * 按权重把密钥展开成票序列。
   *
   * 票序列的位置是**固定的**（只随池子成员变化），轮询指针指向票序列而不是
   * 「过滤后候选集」的下标。这个区别很关键：候选集随时在变（冷却、饱和、被本次
   * 调用排除），若用过滤后的下标定位，一次失败之后本该轮到第二把却可能跳到第三把，
   * 用户看到的就不是「依次换过去」而是「随机乱跳」。
   */
  _buildPlan() {
    /** @type {KeySlot[]} */
    const plan = []
    for (const slot of this.slots) {
      for (let i = 0; i < slot.weight; i += 1) plan.push(slot)
    }
    this._plan = plan
    if (plan.length > 0) this._cursor = ((this._cursor % plan.length) + plan.length) % plan.length
  }

  /** 池中密钥数。 */
  get size() {
    return this.slots.length
  }

  /** 按引用名取槽位。 */
  slotOf(ref) {
    return this.slots.find((slot) => slot.ref === ref)
  }

  /** 当前时刻。 */
  _now() {
    return this.now()
  }

  /**
   * 罚一次失败的冷却。
   *
   * @param {KeySlot} slot
   * @param {object} [details]
   * @param {boolean} [details.soft] 软故障
   * @param {number} [details.retryAfterMs] 上游要求的等待
   * @returns {number} 实际应用的冷却毫秒
   */
  penalize(slot, details = {}) {
    const now = this._now()
    slot.failures += 1
    const ms = computeBackoff({
      baseMs: this.cooldownMs,
      maxMs: this.maxCooldownMs,
      attempt: slot.failures,
      soft: details.soft === true,
      retryAfterMs: details.retryAfterMs,
    })
    slot.cooldownUntil = Math.max(slot.cooldownUntil, now + ms)
    slot.lastFailureAt = now
    this._persist(slot)
    return ms
  }

  /**
   * 记一次成功：清空失败链、解冻冷却。
   *
   * 「成功即清零」是有意的：一次成功证明这把密钥此刻完全健康，继续让它背着
   * 之前的指数退避只会白白浪费池子容量。
   *
   * @param {KeySlot} slot
   */
  markSuccess(slot) {
    slot.failures = 0
    slot.cooldownUntil = 0
    slot.lastUsedAt = this._now()
    this._persist(slot)
  }

  /** 把槽位状态写回 store，供持久化与状态面板读取。 */
  _persist(slot) {
    if (this._stateStore === undefined) return
    this._stateStore.set(`${this.provider}\u0000${slot.ref}`, slot.exportState())
  }

  /**
   * 惩罚衰减与冷却清扫。
   * @returns {number} 本次衰减/清理的条数
   */
  maintain() {
    const now = this._now()
    let touched = 0
    for (const slot of this.slots) {
      // 冷却已过：把失败计数按运行时长衰减，但不直接清零——
      // 间歇性故障的密钥不该因为「安静了一小时」就被当成健康。
      if (slot.cooldownUntil > 0 && slot.cooldownUntil <= now) {
        slot.cooldownUntil = 0
        touched += 1
      }
      if (slot.failures > 0) {
        const since = now - (slot.lastDecayAt || slot.lastFailureAt || now)
        const next = decayPenalty(slot.failures, { perHour: 1, elapsedMs: since })
        if (next !== slot.failures) {
          slot.failures = next
          slot.lastDecayAt = now
          if (next === 0 && slot.cooldownUntil <= now) slot.cooldownUntil = 0
          touched += 1
        }
      }
      this._persist(slot)
    }
    return touched
  }

  /**
   * 选出这一次要用的密钥。
   *
   * @param {object} [options]
   * @param {number} [options.estimatedTokens] 本次预估 token 消耗（用于 TPM 预判）
   * @param {ConcurrencyTracker} [options.concurrency] 并发跟踪器
   * @param {import('./histogram.js').LatencyHistogram} [options.histogram] 延迟直方图
   * @param {Set<string>} [options.exclude] 本次调用中已经试过、不应再选的引用名
   * @returns {{
   *   slot?: KeySlot,
   *   reason: string,
   *   retryAt?: number,
   *   eligible: number,
   *   total: number,
   *   detail: Record<string, number>,
   * }}
   */
  pick(options = {}) {
    const now = this._now()
    const wall = Date.now()
    const estimatedTokens = Number.isFinite(options.estimatedTokens) && options.estimatedTokens > 0
      ? Math.floor(options.estimatedTokens)
      : 0
    const concurrency = options.concurrency
    const histogram = options.histogram
    const exclude = options.exclude instanceof Set ? options.exclude : undefined

    /** @type {Record<string, number>} */
    const detail = { cooldown: 0, paused: 0, expired: 0, rateLimited: 0, concurrency: 0, excluded: 0 }
    /** @type {KeySlot[]} */
    const eligible = []
    /** @type {number[]} 每把被排除密钥最早可能可用的时刻。 */
    const comeback = []

    for (const slot of this.slots) {
      // 本次调用里已经试过的密钥不再选：它刚才失败过，再撞一次只是浪费一次请求。
      if (exclude !== undefined && exclude.has(slot.ref)) {
        detail.excluded += 1
        continue
      }
      if (slot.revoked) {
        detail.paused += 1
        continue
      }
      if (slot.paused) {
        detail.paused += 1
        continue
      }
      if (slot.isExpired(wall)) {
        detail.expired += 1
        continue
      }
      if (slot.isCooling(now)) {
        detail.cooldown += 1
        comeback.push(slot.cooldownUntil)
        continue
      }
      // 预判限流：本地账本说这次会超限就直接跳过，省下一次必然的 429。
      if (slot.bucket.wouldExceed({ requests: 1, tokens: estimatedTokens })) {
        detail.rateLimited += 1
        comeback.push(now + slot.bucket.resetInMs())
        continue
      }
      // 并发已满：不是坏密钥，只是忙。
      if (concurrency !== undefined && !concurrency.hasCapacity(slot.ref)) {
        detail.concurrency += 1
        // 忙的密钥没有「到期时刻」，只能等某条流结束。
        continue
      }
      eligible.push(slot)
    }

    if (this.slots.length === 0) {
      return { slot: undefined, reason: PICK_REASON.EMPTY, eligible: 0, total: 0, detail }
    }
    if (eligible.length === 0) {
      // 区分「耗尽」与「饱和」：前者该级联到别的提供商，后者等一下更划算。
      const starved = detail.cooldown + detail.expired + detail.paused
      const busy = detail.rateLimited + detail.concurrency
      const reason = starved > 0 ? PICK_REASON.COOLDOWN : busy > 0 ? PICK_REASON.RATE_LIMITED : PICK_REASON.EMPTY
      const retryAt = comeback.length > 0 ? Math.min(...comeback) : undefined
      return {
        slot: undefined,
        reason,
        ...(retryAt === undefined ? {} : { retryAt }),
        eligible: 0,
        total: this.slots.length,
        detail,
      }
    }

    const slot = this._select(eligible, { histogram, concurrency })
    this.lastUsed = slot
    slot.lastUsedAt = now
    slot.usage.requests += 1
    this._persist(slot)
    return { slot, reason: PICK_REASON.OK, eligible: eligible.length, total: this.slots.length, detail }
  }

  /**
   * 在候选集中施策略。
   * @param {KeySlot[]} eligible
   * @param {{
   *   histogram?: import('./histogram.js').LatencyHistogram,
   *   concurrency?: ConcurrencyTracker,
   * }} options
   * @returns {KeySlot}
   */
  _select(eligible, options) {
    if (this.strategy === 'least-loaded') {
      const concurrency = options.concurrency
      let best = eligible[0]
      let bestLoad = Infinity
      for (const slot of eligible) {
        const inFlight = concurrency?.inFlight?.(slot.ref) ?? 0
        // 除以权重：权重高的密钥本来就应该多担一些。
        const load = inFlight / slot.weight
        if (load < bestLoad) {
          best = slot
          bestLoad = load
        }
      }
      return best
    }

    if (this.strategy === 'lowest-latency') {
      const histogram = options.histogram
      if (histogram !== undefined) {
        // 样本不足的密钥不给分数：宁可轮询它来积累样本，也不要凭一次慢请求就判死刑。
        let best
        let bestScore = Infinity
        let scored = 0
        for (const slot of eligible) {
          const score = histogram.score(slot.ref)
          if (score === undefined) continue
          scored += 1
          if (score < bestScore) {
            best = slot
            bestScore = score
          }
        }
        if (best !== undefined) return best
        // 一条样本都没有：退回轮询，让数据先攒起来。
      }
    }

    // round-robin（也作为其他策略的兜底）：按权重展开后推进指针。
    return this._roundRobin(eligible)
  }

  /**
   * 轮询：在固定的票序列上环形前进，取第一个可用的票。
   *
   * 指针在**选中时**立刻推进，这样两个并发请求不会拿到同一把密钥——它们是先后
   * 同步执行的，不存在竞态；若把推进推迟到请求结束，并发洪峰会全部压在同一个
   * 槽位上。
   *
   * @param {KeySlot[]} eligible
   * @returns {KeySlot}
   */
  _roundRobin(eligible) {
    const plan = this._plan
    const total = plan.length
    if (total === 0) return eligible[0]
    const allowed = new Set(eligible)
    const start = this._cursor % total
    for (let offset = 0; offset < total; offset += 1) {
      const index = (start + offset) % total
      const slot = plan[index]
      if (allowed.has(slot)) {
        this._cursor = (index + 1) % total
        this._onCursor?.(this._cursor)
        return slot
      }
    }
    // 理论上不可达：eligible 非空就意味着票序列里至少有一张可用的票。
    return eligible[0]
  }

  /**
   * 供设置面板使用的状态快照。
   * @param {object} [options]
   * @param {ConcurrencyTracker} [options.concurrency]
   * @param {import('./histogram.js').LatencyHistogram} [options.histogram]
   */
  snapshot(options = {}) {
    const now = this._now()
    const wall = Date.now()
    return {
      provider: this.provider,
      strategy: this.strategy,
      size: this.slots.length,
      limits: { rpm: this.rpmLimit, tpm: this.tpmLimit, concurrency: this.concurrencyLimit, cooldownMs: this.cooldownMs },
      keys: this.slots.map((slot) => {
        const inFlight = options.concurrency?.inFlight?.(slot.ref) ?? 0
        const latency = options.histogram?.stats?.(slot.ref) ?? { count: 0 }
        let status = 'ready'
        if (slot.revoked) status = 'revoked'
        else if (slot.paused) status = 'paused'
        else if (slot.isExpired(wall)) status = 'expired'
        else if (slot.isCooling(now)) status = 'cooling'
        else if (slot.bucket.wouldExceed({ requests: 1 })) status = 'throttled'
        return {
          ref: slot.ref,
          status,
          cooldownMs: slot.cooldownRemainingMs(now),
          failures: slot.failures,
          inFlight,
          weight: slot.weight,
          expiresAt: slot.expiresAt,
          usage: { ...slot.usage },
          latency,
          bucket: slot.bucket.snapshot(),
          lastFailureKind: slot.usage.lastFailureKind,
        }
      }),
    }
  }
}

/**
 * 从一组设置条目构建全部密钥池。
 *
 * @param {object} options
 * @param {unknown} options.providers 设置里的 `providers` 数组
 * @param {Map<string, object>} [options.stateStore] 跨重载状态
 * @param {() => number} [options.now]
 * @returns {{ pools: KeyPool[], byProvider: Map<string, KeyPool> }}
 */
export function buildPools(options = {}) {
  const providers = Array.isArray(options.providers) ? options.providers : []
  /** @type {KeyPool[]} */
  const pools = []
  /** @type {Map<string, KeyPool>} */
  const byProvider = new Map()
  for (const entry of providers) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    if (provider.length === 0) continue
    // 后一条同名覆盖前一条：宿主的 provider id 唯一，保留两个池子只会互相打架。
    const pool = new KeyPool({
      provider,
      config: entry,
      stateStore: options.stateStore,
      now: options.now,
    })
    if (byProvider.has(provider)) {
      const index = pools.indexOf(byProvider.get(provider))
      if (index !== -1) pools.splice(index, 1)
    }
    pools.push(pool)
    byProvider.set(provider, pool)
  }
  return { pools, byProvider }
}
