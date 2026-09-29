/**
 * 退避、冷却与熔断失败计数。
 *
 * 「失败后冷却多久」是这类插件的核心手感问题，两个方向都会做错：
 *
 * - 冷却太短 → 网络抖一下就反复撞同一把坏密钥，把上游的限流窗口越捅越大；
 * - 冷却太长 → 配额早就重置了密钥还在睡觉，池子白白空转。
 *
 * 因此退避按**故障性质分级**，而不是所有错误一视同仁：
 *
 * | 性质 | 典型场景 | 策略 |
 * |---|---|---|
 * | 软故障 | 套接字重置、502/503、超时 | 短而平的冷却（默认 10 秒），快速回到池子 |
 * | 硬故障 | 429 配额耗尽、401 鉴权拒绝 | 指数退避，逐次翻倍到上限 |
 *
 * 再叠两层修正：**抖动**打散同时到期的密钥（否则一群密钥会在同一秒一起回来，
 * 再把上游撞一次），**惩罚衰减**让长期表现良好的密钥逐步回到正常冷却档位。
 *
 * @module @sucooer/dsh-keypilot/core/backoff
 */

import { nowMono } from './clock.js'

/** 指数退避的上限倍数（base × 8）。 */
export const MAX_BACKOFF_MULTIPLIER = 8

/** 冷启动抖动比例：±12.5%。 */
export const DEFAULT_JITTER_RATIO = 0.125

/** 软故障的默认平缓冷却。 */
export const DEFAULT_SOFT_COOLDOWN_MS = 10_000

/**
 * 任何冷却的绝对上限（30 分钟）。
 *
 * 存在的唯一理由是防病态输入：上游偶发返回 `Retry-After: 86400` 之类的值，
 * 若原样采信会把密钥冻一整天。注意它**不**用 `maxCooldownMs` 代替——
 * 后者是「指数退避增长到多少为止」的旋钮，而上游明确要求等待的时长是权威
 * 指令，不该被本地退避参数压低（那会导致冷却未到就再撞一次上游）。
 */
export const ABSOLUTE_MAX_COOLDOWN_MS = 30 * 60_000

/**
 * 给一个时长加上抖动。
 *
 * @param {number} ms
 * @param {number} [ratio]
 * @param {() => number} [random] 返回 [0,1) 的随机源，测试可注入
 * @returns {number} 非负整数毫秒
 */
export function jitter(ms, ratio = DEFAULT_JITTER_RATIO, random = Math.random) {
  const base = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (base === 0) return 0
  const spread = base * Math.max(0, ratio)
  // 随机源返回 1 或越界时夹回 [0,1)，保证结果永不小于 base - spread。
  const raw = Number(random())
  const unit = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0.5
  const delta = (unit * 2 - 1) * spread
  return Math.max(0, Math.round(base + delta))
}

/**
 * 一次失败之后应当冷却多久。
 *
 * @param {object} options
 * @param {number} options.baseMs     基础冷却（硬故障的第 1 次）
 * @param {number} [options.maxMs]    上限；缺省时取 `baseMs × 8`
 * @param {number} [options.attempt]  连续失败次数，从 1 开始
 * @param {boolean} [options.soft]    是否软故障（网络抖动类）
 * @param {number} [options.softMs]   软故障的平缓冷却
 * @param {number} [options.retryAfterMs] 上游明确要求的等待时长（优先采用）
 * @param {number} [options.jitterRatio]
 * @param {() => number} [options.random]
 * @returns {number} 冷却毫秒
 */
export function computeBackoff(options) {
  const base = Number.isFinite(options.baseMs) && options.baseMs > 0 ? options.baseMs : 60_000
  const max = Number.isFinite(options.maxMs) && options.maxMs > 0 ? options.maxMs : base * MAX_BACKOFF_MULTIPLIER
  const attempt = Number.isFinite(options.attempt) && options.attempt > 0 ? Math.floor(options.attempt) : 1
  const softMs = Number.isFinite(options.softMs) && options.softMs > 0 ? options.softMs : DEFAULT_SOFT_COOLDOWN_MS

  // 上游给了 Retry-After 就是最权威的答案，不必再猜，也不接受本地退避上限的
  // 压低；只加抖动避免同时冲进，并用绝对上限挡住病态值。
  const retryAfter = Number(options.retryAfterMs)
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return jitter(Math.min(retryAfter, ABSOLUTE_MAX_COOLDOWN_MS), options.jitterRatio, options.random)
  }

  if (options.soft === true) {
    return jitter(Math.min(softMs, max), options.jitterRatio, options.random)
  }

  // 指数增长，但乘数封顶：第 1 次 ×1、第 2 次 ×2、第 3 次 ×4，之后固定 ×8。
  const multiplier = Math.min(2 ** (attempt - 1), MAX_BACKOFF_MULTIPLIER)
  return jitter(Math.min(base * multiplier, max), options.jitterRatio, options.random)
}

/**
 * 惩罚衰减：长时间稳定运行的密钥逐级回到正常冷却档位。
 *
 * 只在密钥确实被用过（即有连续失败计数）时衰减，且每次**至少**衰减一档，
 * 避免「衰减了但等于没衰减」的假象。
 *
 * @param {number} failures 当前连续失败次数
 * @param {object} [options]
 * @param {number} [options.perHour] 每小时的衰减步数
 * @param {number} [options.elapsedMs] 距上次衰减的时长
 * @returns {number} 衰减后的失败次数
 */
export function decayPenalty(failures, options = {}) {
  const current = Number.isFinite(failures) && failures > 0 ? failures : 0
  if (current === 0) return 0
  const perHour = Number.isFinite(options.perHour) && options.perHour > 0 ? options.perHour : 1
  const elapsed = Number.isFinite(options.elapsedMs) && options.elapsedMs > 0 ? options.elapsedMs : 0
  const steps = Math.floor((elapsed / 3_600_000) * perHour)
  if (steps <= 0) return current
  return Math.max(0, current - steps)
}

/**
 * 熔断器：一把密钥（或一个提供商）连续失败到阈值后**快速失败**，不再尝试。
 *
 * 状态机：`closed → open → half-open → closed`。
 *
 * - `closed`：正常放行，累计连续失败；
 * - `open`：一律拒绝，直到 `openMs` 到期；
 * - `half-open`：只放行少量探测请求；成功即 `closed` 并清零计数，失败则重新 `open`。
 *
 * 存在的意义是**止损**：当上游整体不可用时，继续按轮换逻辑一把把试过去只会
 * 把每个密钥的冷却都点亮，还可能触发更严厉的限流。
 */
export class CircuitBreaker {
  /**
   * @param {object} [options]
   * @param {number} [options.threshold] 连续失败阈值
   * @param {number} [options.openMs]    打开时长
   * @param {number} [options.halfOpenProbes] 半开期允许的探测次数
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    /** @type {Map<string, { failures: number, opened: boolean, openedAt: number, probes: number }>} */
    this._state = new Map()
    this._threshold = 5
    this._openMs = 30_000
    this._halfOpenProbes = 1
    // 单调时钟：NTP 校时不该让「打开还剩 3 秒」变成负数或几小时。
    /** @type {() => number} */
    this._now = typeof options.now === 'function' ? options.now : nowMono
    this.configure(options)
  }

  /** @param {{ threshold?: number, openMs?: number, halfOpenProbes?: number }} options */
  configure(options = {}) {
    if (Number.isFinite(options.threshold) && options.threshold > 0) {
      this._threshold = Math.floor(options.threshold)
    }
    if (Number.isFinite(options.openMs) && options.openMs > 0) {
      this._openMs = Math.floor(options.openMs)
    }
    if (Number.isFinite(options.halfOpenProbes) && options.halfOpenProbes > 0) {
      this._halfOpenProbes = Math.floor(options.halfOpenProbes)
    }
    // 阈值调大后，已经在 open 状态的名字若不该再 open，交给下一次 evaluate 自动收敛。
  }

  /** @param {string} name @returns {{ failures: number, opened: boolean, openedAt: number, probes: number }} */
  _entry(name) {
    let entry = this._state.get(name)
    if (entry === undefined) {
      entry = { failures: 0, opened: false, openedAt: 0, probes: 0 }
      this._state.set(name, entry)
    }
    return entry
  }

  /**
   * 当前状态。
   *
   * 「是否已打开」用独立的布尔标志而不是「`openedAt` 是否非 0」来表达：单调时钟的
   * 起点可能是 0（例如测试用注入的时钟），把 0 当作「未打开」的哨兵会让刚打开的
   * 熔断器立刻被判回 closed，从而完全失效。
   *
   * @param {string} name
   * @returns {'closed' | 'open' | 'half-open'}
   */
  state(name) {
    const entry = this._state.get(name)
    if (entry === undefined || !entry.opened) return 'closed'
    if (this._now() - entry.openedAt < this._openMs) return 'open'
    return 'half-open'
  }

  /**
   * 是否放行一次尝试。
   *
   * 半开期只放行有限次探测，且**每次放行都立即计数**，避免并发请求同时穿过
   * 半开窗口（那等于没有熔断）。
   *
   * @param {string} name
   * @returns {boolean}
   */
  canAttempt(name) {
    const entry = this._state.get(name)
    if (entry === undefined || !entry.opened) return true
    if (this._now() - entry.openedAt < this._openMs) return false
    if (entry.probes >= this._halfOpenProbes) return false
    entry.probes += 1
    return true
  }

  /**
   * 记一次成功：清零计数并关闭。
   * @param {string} name
   */
  onSuccess(name) {
    const entry = this._state.get(name)
    if (entry === undefined) return
    entry.failures = 0
    entry.opened = false
    entry.openedAt = 0
    entry.probes = 0
  }

  /**
   * 记一次失败，必要时打开熔断。
   * @param {string} name
   * @returns {'closed' | 'open' | 'half-open'} 记完之后的状态
   */
  onFailure(name) {
    const entry = this._entry(name)
    const wasHalfOpen = entry.opened && this._now() - entry.openedAt >= this._openMs

    if (wasHalfOpen) {
      // 半开探测失败 → 立刻重新打开，并从这次失败重新计时。
      entry.openedAt = this._now()
      entry.probes = 0
      entry.failures = this._threshold
      return 'open'
    }

    entry.failures += 1
    if (entry.failures >= this._threshold) {
      entry.opened = true
      entry.openedAt = this._now()
      entry.probes = 0
      return 'open'
    }
    return 'closed'
  }

  /**
   * 立即重置某个名字（用户手动重试、或设置变更后）。
   * @param {string} name
   */
  reset(name) {
    this._state.delete(name)
  }

  /** 全部重置。 */
  resetAll() {
    this._state.clear()
  }

  /**
   * 只读快照，供状态面板使用。
   * @param {string} name
   */
  snapshot(name) {
    const entry = this._state.get(name)
    const state = this.state(name)
    return {
      state,
      failures: entry?.failures ?? 0,
      threshold: this._threshold,
      openedAt: entry?.openedAt ?? 0,
      remainingMs: state === 'open' && entry !== undefined
        ? Math.max(0, this._openMs - (this._now() - entry.openedAt))
        : 0,
    }
  }

  /** 所有已知名字的快照。 */
  snapshotAll() {
    /** @type {Record<string, ReturnType<CircuitBreaker['snapshot']>>} */
    const out = {}
    for (const name of this._state.keys()) out[name] = this.snapshot(name)
    return out
  }
}
