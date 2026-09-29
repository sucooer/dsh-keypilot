/**
 * 预判限流（令牌桶 + 响应头自适应）。
 *
 * 目标不是「被限流后重试」，而是**在发出请求之前就跳过已经饱和的密钥**。429 的代价
 * 不只是那一次失败：它会让整个 agent 回合重来，丢掉已经产生的 token，破坏会话的
 * 可重放性。因此在本地维护一份 RPM / TPM 账本，比等到上游拒绝再切换划算得多。
 *
 * 两个设计取舍：
 *
 * - **本地账本是估计，上游响应头是事实**。只要响应头带 `x-ratelimit-remaining-*`，
 *   就以其为准覆盖本地计数（{@link TokenBucket#syncFromHeaders}）。不同上游的窗口
 *   语义差别很大，本地估计只用来在没有响应头时提供一个保守的兜底。
 * - **宁可保守**。账本按固定窗口统计，且不回收窗口内的失败请求，因此可能略微低估
 *   余量。对一个「避免 429」的组件来说，低估是安全的偏差方向。
 *
 * 纯逻辑，无 I/O，可独立单测。
 *
 * @module @sucooer/dsh-keypilot/core/token-bucket
 */

/** 默认窗口：上游的 RPM/TPM 通常按分钟计。 */
export const DEFAULT_WINDOW_MS = 60_000

/**
 * 从各种形状的响应头容器里取一个头。
 *
 * 上游 SDK 可能交出 `Headers`、普通对象、`Map` 或 `[[k,v]]` 数组，四种都要认。
 * 查找不区分大小写，且只做一次 lowercase 归一（热路径）。
 *
 * @param {unknown} headers
 * @param {string} name 小写头名
 * @returns {string | undefined}
 */
export function readHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value === null || value === undefined ? undefined : String(value)
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2 && String(pair[0]).toLowerCase() === name) {
        return String(pair[1])
      }
    }
    return undefined
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) {
        const value = headers[key]
        if (value === undefined || value === null) continue
        return Array.isArray(value) ? String(value[0]) : String(value)
      }
    }
  }
  return undefined
}

/**
 * 解析上游给的额度余量。
 *
 * @param {unknown} headers
 * @returns {{ requests?: number, tokens?: number, resetRequestsMs?: number, resetTokensMs?: number }}
 */
export function extractRateLimit(headers) {
  /** @type {{ requests?: number, tokens?: number, resetRequestsMs?: number, resetTokensMs?: number }} */
  const out = {}
  const read = (name) => {
    const raw = readHeader(headers, name)
    if (raw === undefined) return undefined
    const value = Number(raw.trim())
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  const requests = read('x-ratelimit-remaining-requests')
  if (requests !== undefined) out.requests = requests
  const tokens = read('x-ratelimit-remaining-tokens')
  if (tokens !== undefined) out.tokens = tokens
  const resetRequests = readHeader(headers, 'x-ratelimit-reset-requests')
  if (resetRequests !== undefined) {
    const ms = parseDuration(resetRequests)
    if (ms !== undefined) out.resetRequestsMs = ms
  }
  const resetTokens = readHeader(headers, 'x-ratelimit-reset-tokens')
  if (resetTokens !== undefined) {
    const ms = parseDuration(resetTokens)
    if (ms !== undefined) out.resetTokensMs = ms
  }
  return out
}

/**
 * 解析上游的时长写法：`1s` / `500ms` / `2m` / `1m30s` / 纯秒数。
 * @param {string} raw
 * @returns {number | undefined} 毫秒
 */
export function parseDuration(raw) {
  const text = String(raw).trim()
  if (text.length === 0) return undefined
  if (/^\d+(\.\d+)?$/.test(text)) {
    // 纯数字：OpenAI 系按秒解释。
    return Number(text) * 1000
  }
  let total = 0
  let matched = false
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    matched = true
    const value = Number(match[1])
    const unit = match[2].toLowerCase()
    total += unit === 'ms' ? value : unit === 's' ? value * 1000 : unit === 'm' ? value * 60_000 : value * 3_600_000
  }
  return matched ? total : undefined
}

/**
 * 解析 `Retry-After`：既可能是秒数，也可能是 HTTP 日期。
 * @param {string | undefined} raw
 * @param {number} now
 * @returns {number | undefined} 毫秒
 */
export function parseRetryAfter(raw, now = Date.now()) {
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  if (text.length === 0) return undefined
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  const delta = at - now
  return delta > 0 ? delta : 0
}

/**
 * 单个密钥的 RPM / TPM 账本。
 *
 * 一个实例只服务一把密钥，因此状态极小：固定窗口起点 + 窗口内已用量 + 上游校正值。
 */
export class TokenBucket {
  /**
   * @param {object} [options]
   * @param {number} [options.rpm] 每分钟请求上限，0 表示不限
   * @param {number} [options.tpm] 每分钟 token 上限，0 表示不限
   * @param {number} [options.windowMs] 窗口长度
   * @param {() => number} [options.now] 取当前时间的函数（测试可注入）
   */
  constructor(options = {}) {
    /** @type {() => number} */
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this.windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : DEFAULT_WINDOW_MS
    /** @type {number} */
    this.rpm = 0
    /** @type {number} */
    this.tpm = 0
    this.configure({ rpm: options.rpm, tpm: options.tpm })
    this._reset()
  }

  /** 把两个计数器、窗口起点与上游校正值全部清空。 */
  _reset() {
    this._windowStart = this._now()
    this._requests = 0
    this._tokens = 0
    /** 上游报回的绝对余量；undefined 表示本轮没有上游事实。 */
    this._upstreamRemainingRequests = undefined
    /** @type {number | undefined} */
    this._upstreamRemainingTokens = undefined
    /** @type {number} */
    this._upstreamResetRequestsMs = 0
    /** @type {number} */
    this._upstreamResetTokensMs = 0
  }

  /**
   * 更新上限。上限变化不会清空本窗口已用量（改配置不该凭空多出配额）。
   * @param {{ rpm?: unknown, tpm?: unknown }} limits
   */
  configure(limits = {}) {
    const rpm = Number(limits.rpm)
    const tpm = Number(limits.tpm)
    this.rpm = Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : 0
    this.tpm = Number.isFinite(tpm) && tpm > 0 ? Math.floor(tpm) : 0
  }

  /** 窗口是否已经滚过。 */
  _rollIfNeeded() {
    const now = this._now()
    if (now - this._windowStart < this.windowMs) return false
    // 整窗滚动：上游事实随窗口一起作废，否则会把上一分钟的余量当成这一分钟的。
    this._reset()
    return true
  }

  /**
   * 距离窗口重置还有多久（毫秒）。
   * @returns {number}
   */
  resetInMs() {
    this._rollIfNeeded()
    const elapsed = this._now() - this._windowStart
    const left = this.windowMs - elapsed
    // 上游给了更明确的窗口余量时以它为准（可能长于本地窗口）。
    const upstream = Math.max(this._upstreamResetRequestsMs, this._upstreamResetTokensMs)
    return Math.max(0, Math.max(left, upstream))
  }

  /**
   * 预判：再发一次请求会不会超限。
   *
   * @param {object} [cost]
   * @param {number} [cost.requests] 本次请求数（默认 1）
   * @param {number} [cost.tokens] 预估消耗的 token
   * @returns {boolean} true 表示**会**超限，应当跳过这把密钥
   */
  wouldExceed(cost = {}) {
    this._rollIfNeeded()
    const requests = Number.isFinite(cost.requests) ? cost.requests : 1
    const tokens = Number.isFinite(cost.tokens) && cost.tokens > 0 ? cost.tokens : 0

    // 上游事实优先：它是唯一能反映「别的进程也在用同一把密钥」的信息。
    if (this._upstreamRemainingRequests !== undefined) {
      if (this._upstreamRemainingRequests < requests) return true
    } else if (this.rpm > 0 && this._requests + requests > this.rpm) {
      return true
    }

    if (this._upstreamRemainingTokens !== undefined) {
      if (this._upstreamRemainingTokens < tokens) return true
    } else if (this.tpm > 0 && this._tokens + tokens > this.tpm) {
      return true
    }
    return false
  }

  /**
   * 记账：请求发出前调用。
   * @param {{ requests?: number, tokens?: number }} [cost]
   */
  charge(cost = {}) {
    this._rollIfNeeded()
    const requests = Number.isFinite(cost.requests) ? cost.requests : 1
    const tokens = Number.isFinite(cost.tokens) && cost.tokens > 0 ? cost.tokens : 0
    this._requests += requests
    this._tokens += tokens
    if (this._upstreamRemainingRequests !== undefined) {
      this._upstreamRemainingRequests = Math.max(0, this._upstreamRemainingRequests - requests)
    }
    if (this._upstreamRemainingTokens !== undefined) {
      this._upstreamRemainingTokens = Math.max(0, this._upstreamRemainingTokens - tokens)
    }
  }

  /**
   * 校正：收到真实用量后，把之前的预估差值补上。
   *
   * 请求前只能猜 token 数，响应后的 `usage` 才是真的。不做这一步，账本会随
   * 预估偏差越飘越远。
   *
   * @param {number} estimated 请求前计入的预估值
   * @param {number} actual    上游回报的真实值
   */
  settle(estimated, actual) {
    const est = Number.isFinite(estimated) && estimated > 0 ? estimated : 0
    const act = Number.isFinite(actual) && actual > 0 ? actual : 0
    const delta = act - est
    if (delta === 0) return
    this._tokens = Math.max(0, this._tokens + delta)
    if (this._upstreamRemainingTokens !== undefined) {
      this._upstreamRemainingTokens = Math.max(0, this._upstreamRemainingTokens - delta)
    }
  }

  /**
   * 用上游响应头校正本地账本。
   *
   * @param {unknown} headers
   * @returns {boolean} 是否拿到了至少一项上游事实
   */
  syncFromHeaders(headers) {
    const info = extractRateLimit(headers)
    let touched = false
    if (info.requests !== undefined) {
      this._upstreamRemainingRequests = info.requests
      touched = true
    }
    if (info.tokens !== undefined) {
      this._upstreamRemainingTokens = info.tokens
      touched = true
    }
    if (info.resetRequestsMs !== undefined) {
      this._upstreamResetRequestsMs = info.resetRequestsMs
      touched = true
    }
    if (info.resetTokensMs !== undefined) {
      this._upstreamResetTokensMs = info.resetTokensMs
      touched = true
    }
    return touched
  }

  /**
   * 余量占比（0..1），用于界面上的饱和度条。
   *
   * 两个上限都没配时返回 undefined：没有上限就没有「饱和」这个概念。
   *
   * @returns {number | undefined}
   */
  saturation() {
    this._rollIfNeeded()
    /** @type {number[]} */
    const ratios = []
    if (this.rpm > 0) {
      const used = this._upstreamRemainingRequests !== undefined
        ? Math.max(0, this.rpm - this._upstreamRemainingRequests)
        : this._requests
      ratios.push(used / this.rpm)
    }
    if (this.tpm > 0) {
      const used = this._upstreamRemainingTokens !== undefined
        ? Math.max(0, this.tpm - this._upstreamRemainingTokens)
        : this._tokens
      ratios.push(used / this.tpm)
    }
    if (ratios.length === 0) return undefined
    return Math.min(1, Math.max(...ratios))
  }

  /** 供界面与持久化使用的只读快照。 */
  snapshot() {
    this._rollIfNeeded()
    return {
      rpm: this.rpm,
      tpm: this.tpm,
      requests: this._requests,
      tokens: this._tokens,
      upstream: this._upstreamRemainingRequests !== undefined || this._upstreamRemainingTokens !== undefined
        ? {
          requests: this._upstreamRemainingRequests,
          tokens: this._upstreamRemainingTokens,
        }
        : undefined,
      resetInMs: this.resetInMs(),
      saturation: this.saturation(),
    }
  }
}
