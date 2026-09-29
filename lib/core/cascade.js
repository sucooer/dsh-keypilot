/**
 * 跨提供商级联。
 *
 * 当主提供商的**所有**密钥都在冷却时，继续在主池里空转没有意义——此时应该把
 * 请求交给备用提供商。这是「密钥轮换」和「提供商故障转移」的分界：前者换的是
 * 同一终点上的凭据，后者换的是终点本身。
 *
 * 级联链由用户声明（`cascade: [{provider, model}]`），本模块只负责一件事：
 * **挑出下一个还没试过的目标**。这里必须防住两类事故：
 *
 * - **无限递归**：A 级联到 B、B 又级联回 A，若不记录已试过的目标就会栈溢出。
 *   参考同类插件的修复记录，这是真实发生过的故障，因此这里同时用「已访问集合」
 *   和「深度上限」两道闸。
 * - **级联到不存在的池子**：声明里写错 provider 名时应当明确跳过，而不是生成一个
 *   注定失败的请求。
 *
 * @module @sucooer/dsh-keypilot/core/cascade
 */

/** 一条级联链最多跳几跳。 */
export const MAX_CASCADE_DEPTH = 3

/**
 * 归一化级联声明。
 *
 * @param {unknown} raw 设置里的 `cascade`
 * @returns {Array<{ provider: string, model?: string }>}
 */
export function normalizeCascade(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {Array<{ provider: string, model?: string }>} */
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    if (provider.length === 0 || seen.has(provider)) continue
    seen.add(provider)
    const model = typeof entry.model === 'string' && entry.model.trim().length > 0 ? entry.model.trim() : undefined
    out.push(model === undefined ? { provider } : { provider, model })
  }
  return out
}

/**
 * 挑出下一个级联目标。
 *
 * @param {object} options
 * @param {Array<{ provider: string, model?: string }>} options.cascade
 * @param {string} options.fromProvider 当前（已耗尽的）提供商
 * @param {string} [options.model] 当前请求的模型，链上没有指定模型时沿用
 * @param {Set<string>} [options.attempted] 已经试过的提供商集合
 * @param {number} [options.depth] 当前已跳数
 * @param {(provider: string) => boolean} [options.hasPool] 该提供商是否有密钥池
 * @returns {{ provider: string, model: string, depth: number } | undefined}
 */
export function nextCascadeTarget(options) {
  const cascade = normalizeCascade(options.cascade)
  if (cascade.length === 0) return undefined

  const depth = Number.isFinite(options.depth) && options.depth >= 0 ? options.depth : 0
  if (depth >= MAX_CASCADE_DEPTH) return undefined

  const attempted = options.attempted instanceof Set ? options.attempted : new Set()
  const hasPool = typeof options.hasPool === 'function' ? options.hasPool : () => true

  for (const target of cascade) {
    if (target.provider === options.fromProvider) continue
    if (attempted.has(target.provider)) continue
    // 声明里写了不存在的提供商是个静默失败陷阱：跳过它，让链上后面的目标有机会被用上。
    if (!hasPool(target.provider)) continue
    return {
      provider: target.provider,
      model: target.model ?? options.model ?? '',
      depth: depth + 1,
    }
  }
  return undefined
}

/**
 * 级联的终止说明，用于在池子彻底耗尽时给用户一句有意义的话。
 *
 * @param {object} options
 * @param {Array<{ provider: string, model?: string }>} options.cascade
 * @param {Set<string>} options.attempted
 * @param {number} [options.retryAfterMs] 最早可恢复时间
 * @param {(ms: number) => string} [options.formatCountdown]
 * @returns {string}
 */
export function describeExhaustion(options) {
  const attempted = options.attempted instanceof Set ? [...options.attempted] : []
  const chain = normalizeCascade(options.cascade)
  const parts = [`所有密钥均不可用（已尝试：${attempted.length > 0 ? attempted.join(' → ') : '无'}）`]
  if (chain.length === 0) {
    parts.push('未配置备用提供商级联')
  } else {
    parts.push(`级联链：${chain.map((t) => t.provider).join(' → ')}`)
  }
  const retryAfter = Number(options.retryAfterMs)
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const countdown = typeof options.formatCountdown === 'function'
      ? options.formatCountdown(retryAfter)
      : `${Math.ceil(retryAfter / 1000)}s`
    parts.push(`最早约 ${countdown} 后恢复`)
  }
  return parts.join('；')
}
