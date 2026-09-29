/**
 * 金丝雀探测的执行器：真的发一次 `GET /models`。
 *
 * 这里只做一件事，且刻意做得很薄——探测的判定全在
 * {@link module:@sucooer/dsh-keypilot/core/canary} 里，是可测的纯逻辑；
 * 本模块只负责把 HTTP 打出去并把结果收成一个稳定的形状。
 *
 * 两条纪律：
 *
 * - **永不抛出**。探测是后台维护动作，它的失败最多让密钥多躺一会儿，
 *   绝不能反过来打断正在进行的请求或让插件报错。
 * - **密钥不进日志**。探测用到的 Authorization 头只存在于这一次请求的局部，
 *   错误日志里只留状态码。
 *
 * @module @sucooer/dsh-keypilot/runtime/probe
 */

import { DEFAULT_PROBE_TIMEOUT_MS } from '../core/canary.js'

/**
 * 按协议给出认证头。
 *
 * @param {string} protocol
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function authHeadersFor(protocol, apiKey) {
  if (protocol === 'anthropic-messages') {
    // Anthropic 用自己的头，不是 Bearer。
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { Authorization: `Bearer ${apiKey}` }
}

/**
 * 建一个探测执行器。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {(message: string) => void} [options.debug]
 * @returns {{ probe: Function }}
 */
export function createProbeRunner(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS
  const debug = typeof options.debug === 'function' ? options.debug : () => {}

  /**
   * 探测一把密钥。
   *
   * @param {object} target
   * @param {string} target.endpoint  完整的 /models 地址
   * @param {string} target.apiKey    这次要验的密钥值（用完即弃，不落盘不进日志）
   * @param {string} [target.protocol]
   * @param {string} [target.provider]
   * @param {string} [target.ref]
   * @returns {Promise<{ status: number, ok: boolean, error?: string }>}
   */
  async function probe(target) {
    const endpoint = typeof target.endpoint === 'string' ? target.endpoint.trim() : ''
    if (endpoint.length === 0) return { status: 0, ok: false, error: '缺少探测端点' }
    if (typeof target.apiKey !== 'string' || target.apiKey.length === 0) {
      return { status: 0, ok: false, error: '没有可用的密钥值' }
    }
    if (typeof fetchImpl !== 'function') {
      return { status: 0, ok: false, error: '本运行环境没有 fetch' }
    }

    const headers = { ...authHeadersFor(target.protocol ?? 'openai-completions', target.apiKey) }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const status = Number(response.status) || 0
      if (status >= 200 && status < 300) {
        debug(`探测 ${target.provider ?? '?'}/${target.ref ?? '?'} → ${status}`)
        return { status, ok: true }
      }
      // 非 2xx：只把状态码带回去，不读响应体（省一次传输，也避免把回显的密钥带进内存）。
      return { status, ok: false, error: `HTTP ${status}` }
    } catch (error) {
      // 超时、DNS、连接重置都归到这里：既不能证明恢复，也不能证明坏了。
      const message = error instanceof Error ? error.message : String(error)
      return { status: 0, ok: false, error: message }
    }
  }

  return { probe }
}
