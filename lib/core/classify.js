/**
 * 错误分类：判断一次失败「该不该换密钥」。
 *
 * 这是整个轮换逻辑里**最容易做错**的一步，因为判断错了会直接伤害用户：
 *
 * - 把「用户按下停止」当成失败 → 悄悄换一把密钥重新发起，用户以为没停下；
 * - 把「请求本身非法（400/上下文超长）」当成失败 → 把所有密钥各撞一遍，
 *   白白烧掉额度，最后还是同一个错误；
 * - 把「上游短暂抖动」当成密钥损坏 → 把这把好密钥冷却很久，池子无谓变小。
 *
 * 因此分类先回答两个正交的问题：
 *
 * 1. **性质**（kind）：这次失败是什么？限流、配额、鉴权、服务端、超时、传输、
 *    空响应、模型不存在、请求非法，还是用户中断；
 * 2. **处置**（action）：换密钥（switch）、原样上报（surface），还是按用户意图
 *    中止（abort）。
 *
 * 只有 kind 属于「换一把密钥真的可能成功」的那几类，action 才是 switch。
 *
 * @module @sucooer/dsh-keypilot/core/classify
 */

/** 失败性质。 */
export const FAILURE_KIND = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  AUTH: 'AUTH',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  BAD_REQUEST: 'BAD_REQUEST',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
})

/** 处置动作。 */
export const FAILURE_ACTION = Object.freeze({
  /** 换一把密钥重试。 */
  SWITCH: 'switch',
  /** 原样上报，不要重试（重试只会重复同一个错误）。 */
  SURFACE: 'surface',
  /** 用户主动中断，立刻停下，绝不换密钥。 */
  ABORT: 'abort',
})

/**
 * 默认触发切换的失败性质。
 *
 * 注意这里**不含** BAD_REQUEST 与 ABORTED：前者换密钥无用，后者必须尊重用户意图。
 * UNKNOWN_MODEL 保留在列表里，是因为它虽然换密钥无用，却是「级联到别的提供商」
 * 的信号——同样的模型 ID 在备用提供商那里可能是有效的。
 */
export const DEFAULT_SWITCH_KINDS = Object.freeze([
  FAILURE_KIND.RATE_LIMIT,
  FAILURE_KIND.QUOTA,
  FAILURE_KIND.AUTH,
  FAILURE_KIND.SERVER,
  FAILURE_KIND.TIMEOUT,
  FAILURE_KIND.TRANSPORT,
  FAILURE_KIND.EMPTY_RESPONSE,
  FAILURE_KIND.UNKNOWN_MODEL,
  FAILURE_KIND.UNKNOWN,
])

/** HTTP 状态码 → 性质。 */
const STATUS_KIND = new Map([
  [401, FAILURE_KIND.AUTH],
  [403, FAILURE_KIND.AUTH],
  [404, FAILURE_KIND.UNKNOWN_MODEL],
  [408, FAILURE_KIND.TIMEOUT],
  [425, FAILURE_KIND.RATE_LIMIT],
  [429, FAILURE_KIND.RATE_LIMIT],
  [500, FAILURE_KIND.SERVER],
  [502, FAILURE_KIND.SERVER],
  [503, FAILURE_KIND.SERVER],
  [504, FAILURE_KIND.TIMEOUT],
  [529, FAILURE_KIND.SERVER],
])

/** gRPC 状态码（数字与名字都认）→ 性质。 */
const GRPC_KIND = new Map([
  ['4', FAILURE_KIND.TIMEOUT],
  ['deadline_exceeded', FAILURE_KIND.TIMEOUT],
  ['7', FAILURE_KIND.AUTH],
  ['permission_denied', FAILURE_KIND.AUTH],
  ['8', FAILURE_KIND.QUOTA],
  ['resource_exhausted', FAILURE_KIND.QUOTA],
  ['14', FAILURE_KIND.TRANSPORT],
  ['unavailable', FAILURE_KIND.TRANSPORT],
  ['16', FAILURE_KIND.AUTH],
  ['unauthenticated', FAILURE_KIND.AUTH],
])

/** 传输层错误码 → 性质。 */
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE',
])

/** 文本特征 → 性质。按顺序匹配，先命中者胜。 */
const MESSAGE_RULES = [
  // 用户主动中断必须最先判定，否则会被后面的「网络中断」规则抢走。
  [/abort|user cancel|cancelled by user|interrupted by user/i, FAILURE_KIND.ABORTED],
  [/insufficient_quota|exceeded your current quota|quota exceeded|out of credit|balance is insufficient|欠费|余额不足|配额/i, FAILURE_KIND.QUOTA],
  [/rate.?limit|too many requests|requests per (minute|second)|rpm exceeded|tpm exceeded|限流|限速|频率|频繁|请求过快/i, FAILURE_KIND.RATE_LIMIT],
  [/invalid api key|incorrect api key|unauthor|authentication|permission denied|api key not valid|鉴权|未授权/i, FAILURE_KIND.AUTH],
  [/model not found|unknown model|does not exist|no such model|模型不存在|invalid model/i, FAILURE_KIND.UNKNOWN_MODEL],
  // 「请求非法」放在服务端之前：它带 4xx 语义，重试无意义。
  [/context length|too long|maximum context|invalid request|bad request|content (filter|policy)|unsupported|参数错误|内容过长/i, FAILURE_KIND.BAD_REQUEST],
  [/overloaded|temporarily unavailable|service unavailable|internal server|bad gateway|gateway time|服务异常/i, FAILURE_KIND.SERVER],
  [/timed? ?out|timeout|deadline/i, FAILURE_KIND.TIMEOUT],
  [/socket hang up|fetch failed|network error|connection (reset|refused|closed)|econn|epipe|network/i, FAILURE_KIND.TRANSPORT],
]

/** 软故障（短冷却即回到池子）的性质。 */
const SOFT_KINDS = new Set([
  FAILURE_KIND.TRANSPORT,
  FAILURE_KIND.TIMEOUT,
  FAILURE_KIND.SERVER,
])

/**
 * 从任意形状的错误里抽出 `{ status, code, grpc, message }`。
 *
 * 上游可能给出 `Error`、`{status, code, message}`、嵌套的 `failure`、甚至是
 * provider SDK 自定义的错误类，字段名也不统一（`statusCode`/`status`、
 * `errno`/`code`）。这里做一次宽容的抽取，抽不到就交给文本规则。
 *
 * @param {unknown} error
 * @returns {{ status?: number, code?: string, grpc?: string, message: string }}
 */
export function extractFailure(error) {
  /** @type {{ status?: number, code?: string, grpc?: string, message: string }} */
  const out = { message: '' }
  const seen = new Set()

  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (node === undefined || node === null || depth > 3) return
    if (typeof node === 'string') {
      if (out.message.length === 0) out.message = node
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (out.status === undefined) {
      const status = node.status ?? node.statusCode ?? node.httpStatus
      const numeric = Number(status)
      if (Number.isFinite(numeric) && numeric >= 100 && numeric < 600) out.status = Math.floor(numeric)
    }
    if (out.code === undefined && typeof node.code === 'string') out.code = node.code
    if (out.code === undefined && typeof node.errno === 'string') out.code = node.errno
    if (out.grpc === undefined) {
      const grpc = node.grpcStatus ?? node.grpcCode ?? node.grpc
      if (grpc !== undefined && grpc !== null) out.grpc = String(grpc)
    }
    if (out.message.length === 0 && typeof node.message === 'string' && node.message.length > 0) {
      out.message = node.message
    }
    // 常见嵌套：{ failure: {...} } / { error: {...} } / { cause: {...} }
    walk(node.failure, depth + 1)
    walk(node.error, depth + 1)
    walk(node.cause, depth + 1)
    walk(node.data, depth + 1)
  }

  walk(error, 0)
  return out
}

/**
 * 判定一次失败。
 *
 * @param {unknown} error
 * @param {object} [options]
 * @param {readonly string[]} [options.switchKinds] 允许切换的性质集合
 * @returns {{
 *   kind: string,
 *   action: string,
 *   soft: boolean,
 *   status?: number,
 *   code?: string,
 *   message: string,
 *   retryAfterMs?: number,
 *   switchable: boolean,
 * }}
 */
export function classifyFailure(error, options = {}) {
  const { status, code, grpc, message } = extractFailure(error)
  const switchKinds = Array.isArray(options.switchKinds) && options.switchKinds.length > 0
    ? new Set(options.switchKinds)
    : new Set(DEFAULT_SWITCH_KINDS)

  let kind
  // 显式的中断信号优先于一切（AbortSignal 触发的错误常带 code='ABORT_ERR'）。
  if (code === 'ABORT_ERR' || code === 'ABORTED' || code === 'ERR_CANCELED') {
    kind = FAILURE_KIND.ABORTED
  } else if (grpc !== undefined && GRPC_KIND.has(grpc.toLowerCase())) {
    kind = GRPC_KIND.get(grpc.toLowerCase())
  } else if (status !== undefined && STATUS_KIND.has(status)) {
    kind = STATUS_KIND.get(status)
  } else if (status !== undefined && status >= 400 && status < 500) {
    // 其余 4xx 一律是「请求本身有问题」，换密钥没有意义。
    kind = FAILURE_KIND.BAD_REQUEST
  } else if (status !== undefined && status >= 500) {
    kind = FAILURE_KIND.SERVER
  } else if (code !== undefined && TRANSPORT_CODES.has(code)) {
    kind = FAILURE_KIND.TRANSPORT
  } else {
    kind = FAILURE_KIND.UNKNOWN
    const haystack = message.length > 0 ? message : code ?? ''
    for (const [pattern, candidate] of MESSAGE_RULES) {
      if (pattern.test(haystack)) {
        kind = candidate
        break
      }
    }
  }

  // 有文本线索时再纠正一次「UNKNOWN」：SDK 常常只给 message 不给状态码。
  if (kind === FAILURE_KIND.UNKNOWN && message.length > 0) {
    for (const [pattern, candidate] of MESSAGE_RULES) {
      if (pattern.test(message)) {
        kind = candidate
        break
      }
    }
  }

  // 配额耗尽（而非瞬时限流）通常是「这一段时间内都不会好」，属于硬故障。
  const soft = SOFT_KINDS.has(kind)

  let action = switchKinds.has(kind) ? FAILURE_ACTION.SWITCH : FAILURE_ACTION.SURFACE
  if (kind === FAILURE_KIND.ABORTED) action = FAILURE_ACTION.ABORT

  return {
    kind,
    action,
    soft,
    status,
    code,
    message,
    switchable: action === FAILURE_ACTION.SWITCH,
  }
}

/**
 * 便捷判断：这次失败是否应当换一把密钥。
 * @param {unknown} error
 * @param {object} [options]
 * @returns {boolean}
 */
export function isSwitchable(error, options) {
  return classifyFailure(error, options).switchable
}

/**
 * 空响应：流正常结束，但一个内容块都没吐出来。
 *
 * 上游偶尔会「成功」返回一个空流（尤其是被软限流时），这在 agent 循环里表现为
 * 一轮对话莫名其妙地结束。它值得换一把密钥重试，但**只有在还没向用户发出内容
 * 之前**才能安全重试——这个前提由调用方（轮换器）保证。
 *
 * @param {{ chunks?: number, sawContent?: boolean }} state
 * @returns {boolean}
 */
export function isEmptyResponse(state) {
  if (state === null || typeof state !== 'object') return false
  const sawContent = state.sawContent === true
  const chunks = Number(state.chunks)
  return !sawContent && (!Number.isFinite(chunks) || chunks === 0)
}
