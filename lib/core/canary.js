/**
 * 金丝雀探测：用一次几乎免费的连通性检查，判断冷却中的密钥是否已经恢复。
 *
 * ## 为什么需要它
 *
 * 冷却时长是**猜**出来的。配额按 UTC 午夜重置、上游几分钟就恢复、或者只是一个
 * 短暂的网络抖动——在这些情况下让密钥躺满整个冷却期，等于白白缩小池子。金丝雀
 * 探测就是去问一次「现在好了吗」。
 *
 * ## 为什么必须便宜且克制
 *
 * 探测本身就是请求，搞砸了会变成新的限流来源。三条约束：
 *
 * 1. **探测 `/models`，不生成内容**。`GET /models` 在 OpenAI 兼容端点上不消耗 token，
 *    是唯一适合做这件事的接口。
 * 2. **同一把密钥有最小探测间隔**，且一次最多探测几把（{@link MAX_PROBES_PER_SWEEP}），
 *    否则池子一大就会在探测上打爆上游。
 * 3. **失败要付出代价**。探测失败会拉长冷却并记一次失败，否则一把坏密钥会被
 *    无限重试，探测流量反噬掉真正请求的额度。
 *
 * ## 成功不等于「完全健康」
 *
 * 一次探活成功只证明「这个端点认这把密钥」，不代表它还有额度。因此成功只
 * **减一档**失败计数并解除冷却，而不是把失败计数清零——间歇性故障的密钥
 * 不该因为一次探活成功就被当成全新密钥。
 *
 * @module @sucooer/dsh-keypilot/core/canary
 */

import { FAILURE_KIND } from './classify.js'

/** 一次巡检最多探测几把密钥。 */
export const MAX_PROBES_PER_SWEEP = 3

/** 同一把密钥两次探测之间的最小间隔。 */
export const DEFAULT_PROBE_INTERVAL_MS = 5 * 60_000

/** 探测本身的超时（远短于正常请求）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 8000

/**
 * 由 Base URL 推出探测端点。
 *
 * OpenAI 兼容端点的模型列表挂在 `/models` 上（baseURL 通常已经含 `/v1`）。
 * 这里只做最保守的拼接：补一个 `/models`，不做任何路径猜测。
 *
 * @param {string} baseURL
 * @returns {string}
 */
export function probeEndpointFor(baseURL) {
  const trimmed = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : ''
  if (trimmed.length === 0) return ''
  return `${trimmed}/models`
}

/**
 * 判断一把密钥是否应当纳入本次探测。
 *
 * @param {object} options
 * @param {number} options.cooldownUntil 冷却截止（单调时间）
 * @param {number} [options.lastProbeAt] 上次探测时刻（单调时间）
 * @param {number} options.now
 * @param {number} [options.intervalMs]
 * @param {boolean} [options.revoked] 已作废的密钥不探测（省一次请求）
 * @param {boolean} [options.paused] 用户手动停用的不探测（尊重用户意图）
 * @returns {boolean}
 */
export function shouldProbe(options) {
  if (options.revoked === true || options.paused === true) return false
  const now = Number(options.now)
  if (!Number.isFinite(now)) return false
  const until = Number(options.cooldownUntil)
  // 没在冷却中就不需要探活。
  if (!Number.isFinite(until) || until <= now) return false

  const interval = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_PROBE_INTERVAL_MS
  const last = Number(options.lastProbeAt)
  if (!Number.isFinite(last) || last <= 0) return true
  return now - last >= interval
}

/**
 * 从一批密钥中挑出本次要探测的目标。
 *
 * 优先探测「快到期」的密钥：它们的冷却马上就结束了，探活成功的收益最小，
 * 因此反过来——优先探测**剩余时间最长**的那几把，那才是探活真正能省下的时间。
 *
 * @param {Array<{ ref: string, cooldownUntil: number, lastProbeAt?: number, revoked?: boolean, paused?: boolean }>} slots
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.intervalMs]
 * @param {number} [options.maxProbes]
 * @returns {string[]} 本次要探测的引用名
 */
export function planProbes(slots, options = {}) {
  const now = Number(options.now)
  if (!Array.isArray(slots) || !Number.isFinite(now)) return []
  const interval = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_PROBE_INTERVAL_MS
  const max = Number.isFinite(options.maxProbes) && options.maxProbes > 0
    ? Math.floor(options.maxProbes)
    : MAX_PROBES_PER_SWEEP

  const candidates = slots.filter((slot) => shouldProbe({
    cooldownUntil: slot.cooldownUntil,
    lastProbeAt: slot.lastProbeAt,
    now,
    intervalMs: interval,
    revoked: slot.revoked,
    paused: slot.paused,
  }))

  // 剩余冷却时间从长到短：先救那些还躺很久的。
  candidates.sort((a, b) => b.cooldownUntil - a.cooldownUntil)
  return candidates.slice(0, max).map((slot) => slot.ref)
}

/**
 * 判定一次探测的结果，给出应当采取的处置。
 *
 * @param {object} options
 * @param {number} options.status HTTP 状态码（0 或负数表示传输层失败）
 * @param {string} [options.kind] 已分类的失败性质
 * @param {number} [options.currentCooldownMs] 当前剩余冷却
 * @param {number} [options.baseCooldownMs] 基础冷却，用于失败时拉长
 * @param {number} [options.maxCooldownMs]
 * @returns {{
 *   action: 'release' | 'keep' | 'break',
 *   cooldownMs: number,
 *   reason: string,
 *   decayFailures: number,
 * }}
 */
export function judgeProbe(options) {
  const status = Number(options.status)
  const kind = typeof options.kind === 'string' ? options.kind : ''
  const remaining = Number.isFinite(options.currentCooldownMs) && options.currentCooldownMs > 0
    ? options.currentCooldownMs
    : 0
  const base = Number.isFinite(options.baseCooldownMs) && options.baseCooldownMs > 0
    ? options.baseCooldownMs
    : 60_000
  const max = Number.isFinite(options.maxCooldownMs) && options.maxCooldownMs > 0
    ? options.maxCooldownMs
    : base * 8

  // 成功：端点认可这把密钥 → 解除冷却，但只减一档失败计数。
  if (status >= 200 && status < 300) {
    return {
      action: 'release',
      cooldownMs: 0,
      reason: '探测成功，提前解除冷却',
      decayFailures: 1,
    }
  }

  // 鉴权失败：探活恰恰证明这把密钥本身有问题，而不是限流。
  // 这类密钥不该反复探活，直接长期隔离。
  if (status === 401 || status === 403 || kind === FAILURE_KIND.AUTH) {
    return {
      action: 'break',
      cooldownMs: Math.min(max, Math.max(base * 4, remaining)),
      reason: '探测返回鉴权失败，密钥本身不可用，延长隔离',
      decayFailures: 0,
    }
  }

  // 限流：说明密钥是好的，只是还没额度——保持冷却，等配额窗口。
  if (status === 429 || kind === FAILURE_KIND.RATE_LIMIT || kind === FAILURE_KIND.QUOTA) {
    return {
      action: 'keep',
      cooldownMs: Math.min(max, Math.max(remaining, base)),
      reason: '探测确认仍在限流，维持冷却等配额恢复',
      decayFailures: 0,
    }
  }

  // 服务端错误 / 超时 / 传输失败：既不能证明恢复，也不能证明坏了。
  // 保持冷却并轻微延长，避免一把抖动中的密钥被高频探测。
  return {
    action: 'keep',
    cooldownMs: Math.min(max, Math.max(remaining, Math.round(base / 2))),
    reason: '探测未成功，维持冷却',
    decayFailures: 0,
  }
}

/**
 * 把探测结果写回密钥槽（纯函数，方便测试）。
 *
 * @param {object} slot 需要含 `failures`、`cooldownUntil`、`lastProbeAt`
 * @param {ReturnType<typeof judgeProbe>} verdict
 * @param {number} now
 * @returns {object} 同一个 slot 对象（原地修改）
 */
export function applyProbeVerdict(slot, verdict, now) {
  slot.lastProbeAt = now
  if (verdict.action === 'release') {
    slot.cooldownUntil = 0
    slot.failures = Math.max(0, Number(slot.failures) - Math.max(1, verdict.decayFailures))
  } else {
    slot.cooldownUntil = Math.max(Number(slot.cooldownUntil) || 0, now + verdict.cooldownMs)
  }
  return slot
}
