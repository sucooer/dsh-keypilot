/**
 * Webhook 发送器：把聚合好的事件推给外部端点。
 *
 * 与 {@link module:@sucooer/dsh-keypilot/core/webhook} 的关系：那边决定「发什么、
 * 什么时候发、失败了退避多久」，这边只负责「把它真的发出去」。
 *
 * 纪律和探测一样：**永不抛出**。通知是纯副作用，Webhook 挂掉只意味着用户少收到
 * 一条告警，绝不能让插件自己报错，更不能影响正在进行的请求。
 *
 * 出于同样的理由，URL 不进日志——Telegram 的 bot token 就写在 URL 里，
 * 打进日志等于把凭据泄漏到磁盘。
 *
 * @module @sucooer/dsh-keypilot/runtime/notifier
 */

import { detectKind, formatPayload, validateWebhookUrl, WEBHOOK_KINDS } from '../core/webhook.js'

/** 单次推送的超时。 */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 8000

/**
 * 建一个发送器。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.logger]
 * @param {boolean} [options.allowInsecure]
 * @returns {{ send: Function, test: Function }}
 */
export function createNotifier(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_NOTIFY_TIMEOUT_MS
  const logger = options.logger
  const allowInsecure = options.allowInsecure === true

  /**
   * 推一批事件。
   *
   * @param {object} target
   * @param {string} target.url
   * @param {string} [target.kind] 见 {@link WEBHOOK_KINDS}；省略时按 URL 自动识别
   * @param {Array<object>} target.events
   * @returns {Promise<boolean>} 是否成功
   */
  async function send(target) {
    const verdict = validateWebhookUrl(target.url, { allowInsecure })
    if (!verdict.ok) return false

    const kind = typeof target.kind === 'string' && WEBHOOK_KINDS.includes(target.kind)
      ? target.kind
      : detectKind(verdict.url)
    const events = Array.isArray(target.events) ? target.events : []
    if (events.length === 0) return true

    const payload = formatPayload(events, kind)
    if (typeof fetchImpl !== 'function') return false

    try {
      const response = await fetchImpl(verdict.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ok = response.ok === true
      // 只记状态码，绝不记 URL——里面可能有 bot token。
      if (!ok) logger?.warn?.(`[keypilot] Webhook 推送失败：HTTP ${response.status}`)
      return ok
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[keypilot] Webhook 推送异常：${message}`)
      return false
    }
  }

  /**
   * 发一条测试消息（用户在设置里点「测试」时用）。
   *
   * @param {object} target
   * @param {string} target.url
   * @param {string} [target.kind]
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async function test(target) {
    const verdict = validateWebhookUrl(target.url, { allowInsecure })
    if (!verdict.ok) return { ok: false, message: verdict.message }
    const ok = await send({
      url: verdict.url,
      kind: target.kind,
      events: [{ type: 'success', provider: '(test)', ref: 'keypilot' }],
    })
    return ok
      ? { ok: true, message: '测试消息已送达' }
      : { ok: false, message: '推送失败，请检查地址是否可用（详见插件日志）' }
  }

  return { send, test }
}
