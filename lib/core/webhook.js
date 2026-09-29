/**
 * Webhook 通知：把轮换事件推到 Telegram / Discord / Slack 或任意 HTTP 端点。
 *
 * ## 三个必须守住的规矩
 *
 * 1. **绝不阻塞轮换**。通知是副作用，一次超时的 Webhook 不能拖慢模型调用。因此
 *    事件先进有界队列，发送在别处进行；队列满了就丢弃最旧的（告警可以丢，
 *    请求不能卡）。
 * 2. **必须聚合**。池子出问题时，几秒内会产生几十条切换事件。逐条推送等于
 *    用告警轰炸用户，聚合窗口把它们合成一条摘要。
 * 3. **失败要退避**。Webhook 挂了就指数退避，而不是每秒重试一次——那只会把
 *    故障放大成 DoS。
 *
 * 另外，URL 本身是凭据（Telegram 的 bot token 就在 URL 里），因此它永远不进日志，
 * 也不出现在错误信息里。
 *
 * @module @sucooer/dsh-keypilot/core/webhook
 */

import { redactSecrets } from './redact.js'

/** 支持的推送格式。 */
export const WEBHOOK_KINDS = Object.freeze(['generic', 'telegram', 'discord', 'slack'])

/** 聚合窗口：这段时间内的事件合成一条。 */
export const DEFAULT_AGGREGATE_MS = 5000

/** 队列上限：超出后丢弃最旧事件。 */
export const MAX_QUEUE = 50

/** 连续失败多少次之后开始退避。 */
const FAILURES_BEFORE_BACKOFF = 3

/** 退避上限。 */
const MAX_BACKOFF_MS = 15 * 60_000

/**
 * 把一条内部事件渲染成一行文本。
 *
 * @param {object} event
 * @returns {string}
 */
export function describeEvent(event) {
  const provider = event?.provider ?? '?'
  if (event?.type === 'cascade') {
    return `级联：${event.from ?? '?'} → ${event.to ?? '?'}`
  }
  if (event?.type === 'success') {
    const ms = Number(event.ttftMs)
    return `${provider}：${event.ref ?? '?'} 成功${Number.isFinite(ms) ? `（首字 ${Math.round(ms)}ms）` : ''}`
  }
  if (event?.type === 'probe') {
    return `${provider}：探测 ${event.ref ?? '?'} → ${event.outcome ?? '?'}`
  }
  const seconds = Number.isFinite(Number(event?.cooldownMs)) ? Math.round(Number(event.cooldownMs) / 1000) : 0
  return `${provider}：${event?.from ?? '?'} 触发 ${event?.kind ?? '?'}，冷却 ${seconds}s`
}

/**
 * 把一批事件格式化成目标平台需要的载荷。
 *
 * @param {Array<object>} events
 * @param {string} [kind] 见 {@link WEBHOOK_KINDS}
 * @returns {object} 可直接作为 JSON 请求体
 */
export function formatPayload(events, kind = 'generic') {
  const list = Array.isArray(events) ? events : []
  const lines = list.map((event) => `· ${describeEvent(event)}`).map((line) => redactSecrets(line))
  const text = lines.length > 0
    ? `dsh-keypilot：${list.length} 条事件\n${lines.join('\n')}`
    : 'dsh-keypilot：无事件'

  if (kind === 'telegram') {
    // Telegram Bot API 的 sendMessage 需要 chat_id，通常已包含在用户填的 URL 查询串里。
    return { text, disable_web_page_preview: true }
  }
  if (kind === 'discord') {
    // Discord webhook 接受 content；超过 2000 字符会被拒，这里截断。
    return { content: text.slice(0, 1900) }
  }
  if (kind === 'slack') {
    return { text: text.slice(0, 1900) }
  }
  return { text, count: list.length, events: list }
}

/**
 * 从 URL 猜平台，省得用户再选一次。
 *
 * @param {string} url
 * @returns {string}
 */
export function detectKind(url) {
  if (typeof url !== 'string') return 'generic'
  if (url.includes('api.telegram.org')) return 'telegram'
  if (url.includes('discord.com') || url.includes('discordapp.com')) return 'discord'
  if (url.includes('hooks.slack.com')) return 'slack'
  return 'generic'
}

/**
 * 校验一个 Webhook URL 是否可用。
 *
 * 只接受 http(s)，且**默认要求 https**——Webhook URL 里往往带着 bot token，
 * 走明文 http 等于把凭据裸奔到网络上。localhost 例外（方便自建服务调试）。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.allowInsecure] 是否允许 http
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export function validateWebhookUrl(url, options = {}) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { ok: false, message: 'Webhook 地址为空' }
  }
  const trimmed = url.trim()
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, message: 'Webhook 地址不是合法 URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'Webhook 地址必须是 http 或 https' }
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol === 'http:' && !isLocal && options.allowInsecure !== true) {
    return { ok: false, message: 'Webhook 地址含凭据，请使用 https（本机地址除外）' }
  }
  return { ok: true, url: trimmed }
}

/**
 * 有界聚合队列。
 *
 * 用法：事件来了 `push()`；发送端用 `take()` 取走一批（只在窗口到期后才有东西），
 * 发完用 `markResult()` 回报结果。
 */
export class NotifyQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.aggregateMs]
   * @param {number} [options.maxQueue]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.aggregateMs = Number.isFinite(options.aggregateMs) && options.aggregateMs >= 0
      ? options.aggregateMs
      : DEFAULT_AGGREGATE_MS
    this.maxQueue = Number.isFinite(options.maxQueue) && options.maxQueue > 0
      ? Math.floor(options.maxQueue)
      : MAX_QUEUE
    this._now = typeof options.now === 'function' ? options.now : Date.now
    /** @type {Array<object>} */
    this._pending = []
    /** 窗口起点；undefined 表示窗口未开启。 */
    this._windowStart = undefined
    this._consecutiveFailures = 0
    this._backoffUntil = 0
    /** 累计丢弃的事件数，供诊断。 */
    this.dropped = 0
  }

  /**
   * 放入一个事件。
   * @param {object} event
   * @returns {boolean} 是否成功入队（队列满时被丢弃）
   */
  push(event) {
    if (event === null || typeof event !== 'object') return false
    const now = this._now()
    if (this._windowStart === undefined) this._windowStart = now
    if (this._pending.length >= this.maxQueue) {
      // 丢弃最旧的：告警可以丢，请求不能卡。
      this._pending.shift()
      this.dropped += 1
    }
    this._pending.push(event)
    return true
  }

  /**
   * 窗口是否已到期（即可以取走一批）。
   * @returns {boolean}
   */
  ready() {
    if (this._windowStart === undefined || this._pending.length === 0) return false
    if (this._now() < this._backoffUntil) return false
    return this._now() - this._windowStart >= this.aggregateMs
  }

  /**
   * 取走当前批次并关闭窗口。
   * @returns {Array<object>} 未到期时返回空数组
   */
  take() {
    if (!this.ready()) return []
    const batch = this._pending
    this._pending = []
    this._windowStart = undefined
    return batch
  }

  /**
   * 回报发送结果，并据此退避。
   * @param {boolean} ok
   */
  markResult(ok) {
    if (ok) {
      this._consecutiveFailures = 0
      this._backoffUntil = 0
      return
    }
    this._consecutiveFailures += 1
    const failures = this._consecutiveFailures - FAILURES_BEFORE_BACKOFF
    if (failures < 0) return
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures)
    this._backoffUntil = this._now() + backoff
  }

  /**
   * 还有多久才允许下一次发送（毫秒）。
   * @returns {number}
   */
  backoffRemainingMs() {
    return Math.max(0, this._backoffUntil - this._now())
  }

  /** 是否处于退避中。 */
  get cooling() {
    return this._now() < this._backoffUntil
  }

  /** 待发事件数。 */
  get pending() {
    return this._pending.length
  }

  /** 连续失败次数。 */
  get failures() {
    return this._consecutiveFailures
  }
}
