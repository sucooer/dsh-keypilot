/**
 * 请求 token 预估。
 *
 * 预判限流需要在**发请求之前**知道这次大概要花多少 token，但真实用量只有响应
 * 回来才知道。这里只求量级正确——预判的价值在于「这把密钥已经用了 95% 的额度，
 * 别再用它了」，而不是精确计费。
 *
 * 刻意**偏保守（高估）**：高估会让插件提前一点跳过密钥，代价是偶尔多切一次；
 * 低估则会让它放心地用一把已经见底的密钥，代价是一整个回合的 429。
 *
 * @module @sucooer/dsh-keypilot/core/estimate
 */

/** 拉丁文本的粗略字符/token 比。 */
const CHARS_PER_TOKEN_ASCII = 4

/** CJK 字符密集，一字往往就是一 token 上下。 */
const CHARS_PER_TOKEN_CJK = 1.6

/** 每条消息的固定开销（角色标记、分隔符）。 */
const PER_MESSAGE_OVERHEAD = 4

/** 单次请求的预估上限，避免超长上下文把预判值撑到离谱。 */
export const MAX_ESTIMATE_TOKENS = 2_000_000

/**
 * 估算一段文本的 token 数。
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // CJK 统一表意文字、假名、谚文、全角标点：按 CJK 比例计。
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk / CHARS_PER_TOKEN_CJK + other / CHARS_PER_TOKEN_ASCII)
}

/** 从各种消息形状里抽出可计量的文本。 */
function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (Array.isArray(value.content)) return value.content.map(textOf).join('\n')
    if (typeof value.arguments === 'string') return value.arguments
    if (value.arguments !== undefined) return safeJson(value.arguments)
  }
  return ''
}

/** 序列化，失败返回空串而不是抛出。 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * 估算一次模型调用的输入 token。
 *
 * @param {object} options
 * @param {unknown} [options.messages] 会话消息
 * @param {string} [options.system] 系统提示
 * @param {unknown} [options.tools] 工具 schema
 * @param {number} [options.maxTokens] 期望的输出上限
 * @param {number} [options.safetyFactor] 安全系数
 * @returns {number}
 */
export function estimateRequestTokens(options = {}) {
  let total = 0
  const messages = Array.isArray(options.messages) ? options.messages : []
  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD
    if (message === null || typeof message !== 'object') {
      total += estimateTextTokens(textOf(message))
      continue
    }
    // 只计内容与可能很大的工具入参，不计 id/时间戳等噪声字段。
    total += estimateTextTokens(textOf(message.content ?? message.text))
    if (message.tool_calls !== undefined) total += estimateTextTokens(textOf(message.tool_calls))
    if (message.toolCalls !== undefined) total += estimateTextTokens(textOf(message.toolCalls))
  }
  if (typeof options.system === 'string') total += estimateTextTokens(options.system)
  if (options.tools !== undefined) total += estimateTextTokens(safeJson(options.tools))
  // 输出也要预留，否则会用光输入余量后被限流。
  const maxTokens = Number(options.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) total += Math.floor(maxTokens)
  const factor = Number(options.safetyFactor)
  const scaled = Number.isFinite(factor) && factor > 0 ? total * factor : total * 1.1
  return Math.min(MAX_ESTIMATE_TOKENS, Math.ceil(scaled))
}

/**
 * 把上游 `usage` 拆成逐项字段。
 *
 * 与 {@link tokenUsageOf} 的区别：那个只求总数（用于校正限流账本），这个保留
 * 输入/输出/缓存的拆分——成本估算里这几项的单价差好几倍，合成一个数就没法算了。
 *
 * @param {unknown} usage
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number } | undefined}
 */
export function usageBreakdown(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const pick = (...names) => {
    for (const name of names) {
      const value = Number(usage[name])
      if (Number.isFinite(value) && value >= 0) return value
    }
    return 0
  }
  const inputTokens = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const outputTokens = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  const cacheReadTokens = pick('cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens')
  const cacheWriteTokens = pick('cacheWriteTokens', 'cache_write_tokens')
  // 三者全为 0 说明这个 usage 对象根本没带我们认识的字段。
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return undefined
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/**
 * 从上游 `usage` 里取真实消耗的 token 数。
 *
 * 字段名在不同适配器间不统一，因此做一次宽容的合并。
 *
 * @param {unknown} usage
 * @returns {number | undefined} 取不到时 undefined（调用方此时不要校正账本）
 */
export function tokenUsageOf(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const pick = (...names) => {
    for (const name of names) {
      const value = Number(usage[name])
      if (Number.isFinite(value) && value >= 0) return value
    }
    return undefined
  }
  const input = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const output = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  const cacheRead = pick('cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens') ?? 0
  const cacheWrite = pick('cacheWriteTokens', 'cache_write_tokens') ?? 0
  if (input === undefined && output === undefined) return undefined
  return (input ?? 0) + (output ?? 0) + cacheRead + cacheWrite
}
