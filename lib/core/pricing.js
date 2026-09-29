/**
 * 成本估算。
 *
 * ## 这里的数字只能用来比较，不能用来对账
 *
 * 内置价目表是**示例值**：服务商的定价、币种与计费口径（是否计入缓存、是否区分
 * 推理 token）都会随版本调整，而插件不可能联网去查实时价格。它的用途是回答
 * 「哪把密钥烧得更快」「这个提供商是不是比那个贵」这类**相对**问题。
 *
 * 需要对账时，请在设置里用自己的真实单价覆盖（`pricingOverrides`），或者干脆
 * 看服务商控制台——那才是权威来源。
 *
 * @module @sucooer/dsh-keypilot/core/pricing
 */

/**
 * 内置价目：**每百万 token 的人民币单价**（示例值，按实际账单校准）。
 *
 * 匹配规则是「模型 ID 小写后包含 `match`」，因此更具体的条目必须排在前面：
 * `deepseek-reasoner` 要在 `deepseek` 之前，否则永远命不中。
 *
 * @type {ReadonlyArray<{ match: string, input: number, output: number, cacheRead?: number }>}
 */
export const DEFAULT_PRICES = Object.freeze([
  { match: 'deepseek-reasoner', input: 4, output: 16, cacheRead: 1 },
  { match: 'deepseek', input: 2, output: 8, cacheRead: 0.5 },
  { match: 'gpt-4o-mini', input: 1.1, output: 4.4, cacheRead: 0.275 },
  { match: 'gpt-4o', input: 18, output: 72, cacheRead: 9 },
  { match: 'gpt-4.1', input: 14, output: 58, cacheRead: 3.5 },
  { match: 'o4-mini', input: 8, output: 33, cacheRead: 2 },
  { match: 'claude-opus', input: 110, output: 550, cacheRead: 11 },
  { match: 'claude-haiku', input: 6, output: 30, cacheRead: 0.6 },
  { match: 'claude', input: 22, output: 110, cacheRead: 2.2 },
  { match: 'gemini-2.5-pro', input: 9, output: 75, cacheRead: 2.25 },
  { match: 'gemini', input: 8, output: 30, cacheRead: 2 },
  { match: 'kimi', input: 4, output: 16, cacheRead: 1 },
  { match: 'glm', input: 3, output: 12, cacheRead: 0.5 },
  { match: 'qwen', input: 3, output: 12, cacheRead: 0.5 },
  { match: 'doubao', input: 2, output: 8, cacheRead: 0.5 },
  { match: 'grok', input: 22, output: 88, cacheRead: 5.5 },
  { match: 'llama', input: 2, output: 6, cacheRead: 0.5 },
  { match: 'mistral', input: 4, output: 14, cacheRead: 1 },
])

/** 未命中任何条目时使用的兜底单价。 */
export const FALLBACK_PRICE = Object.freeze({ input: 5, output: 15, cacheRead: 1 })

/**
 * 归一化用户提供的覆盖价目。
 *
 * @param {unknown} raw 形如 `{ 'deepseek': { input: 2, output: 8 } }`
 * @returns {Record<string, { input: number, output: number, cacheRead?: number }>}
 */
export function normalizePriceOverrides(raw) {
  /** @type {Record<string, { input: number, output: number, cacheRead?: number }>} */
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [match, value] of Object.entries(raw)) {
    if (typeof match !== 'string' || match.trim().length === 0) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const input = Number(value.input)
    const output = Number(value.output)
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue
    const cacheRead = Number(value.cacheRead)
    out[match.trim().toLowerCase()] = Number.isFinite(cacheRead) && cacheRead >= 0
      ? { input, output, cacheRead }
      : { input, output }
  }
  return out
}

/**
 * 为某个模型找单价。
 *
 * @param {string} model
 * @param {Record<string, { input: number, output: number, cacheRead?: number }>} [overrides]
 * @returns {{ input: number, output: number, cacheRead: number, matched: boolean }}
 */
export function priceFor(model, overrides = {}) {
  const needle = typeof model === 'string' ? model.toLowerCase() : ''
  if (needle.length > 0) {
    // 用户覆盖优先，这样官方价目变动时不必等插件发版。
    const overrideKeys = Object.keys(overrides).sort((a, b) => b.length - a.length)
    for (const key of overrideKeys) {
      if (needle.includes(key)) {
        const entry = overrides[key]
        return {
          input: entry.input,
          output: entry.output,
          cacheRead: Number.isFinite(entry.cacheRead) ? entry.cacheRead : 0,
          matched: true,
        }
      }
    }
    for (const entry of DEFAULT_PRICES) {
      if (needle.includes(entry.match)) {
        return {
          input: entry.input,
          output: entry.output,
          cacheRead: entry.cacheRead ?? 0,
          matched: true,
        }
      }
    }
  }
  return { ...FALLBACK_PRICE, matched: false }
}

/**
 * 估算一次调用的开销（人民币）。
 *
 * 缓存写入通常按输入价计费，缓存读取按单独的折后价计。
 *
 * @param {object} usage
 * @param {string} [usage.model]
 * @param {number} [usage.inputTokens]
 * @param {number} [usage.outputTokens]
 * @param {number} [usage.cacheReadTokens]
 * @param {number} [usage.cacheWriteTokens]
 * @param {Record<string, { input: number, output: number, cacheRead?: number }>} [usage.overrides]
 * @returns {number}
 */
export function estimateCost(usage = {}) {
  const price = priceFor(usage.model ?? '', usage.overrides)
  const per = (tokens, unitPrice) => (Math.max(0, Number(tokens) || 0) / 1_000_000) * unitPrice
  const input = per(usage.inputTokens, price.input)
  const cacheWrite = per(usage.cacheWriteTokens, price.input)
  const cacheRead = per(usage.cacheReadTokens, price.cacheRead)
  const output = per(usage.outputTokens, price.output)
  const total = input + cacheWrite + cacheRead + output
  return Number.isFinite(total) ? total : 0
}

/**
 * 把金额格式化成展示文本。
 * @param {number} amount 人民币
 * @returns {string}
 */
export function formatCost(amount) {
  const value = Number(amount)
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '¥0'
  if (value < 0.01) return '¥<0.01'
  if (value < 100) return `¥${value.toFixed(2)}`
  return `¥${Math.round(value)}`
}
