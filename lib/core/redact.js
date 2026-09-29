/**
 * 脱敏与密钥形态识别。
 *
 * 两条约定：
 *
 * 1. **插件从不保存密钥值**，只保存凭据引用名（如 `DEEPSEEK_API_KEY`），真实值由
 *    宿主的凭证服务保管。因此这里唯一的脱敏需求是**展示**：界面上要让用户能区分
 *    同名前缀的多把密钥，所以只回显末几位。
 * 2. **错误消息可能夹带上游回显的密钥**。上游在 401 里原样回显 `Authorization`
 *    并不罕见，这类消息会被写进日志甚至推到 Webhook，必须先在源头抹掉。
 *
 * @module @sucooer/dsh-keypilot/core/redact
 */

/** 回显末几位，足以区分同一提供商的多个密钥。 */
export const KEY_TAIL_CHARS = 5

/** 太短的密钥不做尾部回显（否则等于把整个密钥显示出来）。 */
export const MIN_LENGTH_FOR_TAIL = 8

/** 尾部回显失败时的统一占位符。 */
export const KEY_TAIL_PLACEHOLDER = '***'

/**
 * 取密钥的尾部用于展示。
 * @param {unknown} value
 * @returns {string} 末 {@link KEY_TAIL_CHARS} 位，或 {@link KEY_TAIL_PLACEHOLDER}
 */
export function keyTail(value) {
  if (typeof value !== 'string') return KEY_TAIL_PLACEHOLDER
  const text = value.trim()
  if (text.length < MIN_LENGTH_FOR_TAIL) return KEY_TAIL_PLACEHOLDER
  return text.slice(-KEY_TAIL_CHARS)
}

/** 已知的密钥前缀形态。 */
const SECRET_PREFIXES = [
  'sk-', 'sk_', 'sk-or-', 'sk-ant-', 'sk-proj-', 'sk-live-', 'sk-test-',
  'api-', 'api_', 'key-', 'gsk_', 'xai-', 'r8_', 'hf_', 'hf-',
  'gl-', 'Bearer ', 'AIza', 'AKIA', 'ghp_', 'gho_', 'github_pat_',
]

/** 形如 JWT（三段 base64url）也当密钥处理。 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

/** 不透明令牌的字符集：base64 / base62 及其常见分隔符。 */
const OPAQUE_TOKEN_CHARSET = /^[A-Za-z0-9_\-+/=.]+$/

/** 「长」的阈值：真实密钥几乎都远长于此。 */
const OPAQUE_TOKEN_MIN_LENGTH = 32

/**
 * 判断串是否大小写字母与数字三种都有。
 *
 * 只靠长度判断会误伤长英文单词、长 URL 路径或长标识符；要求三种字符同时出现
 * 是随机密钥的典型特征，普通标识符极少同时满足。
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasMixedCharset(text) {
  return /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text)
}

/**
 * 判断一段文本**像不像密钥本体**，而不是一个环境变量名。
 *
 * 用途是「密钥泄漏探测器」：设置面板里的「密钥引用名」栏应当填 `MY_KEY`，
 * 若用户误把 `sk-…` 粘进来，就在保存前提醒——填进去的是明文，不是引用。
 *
 * @param {unknown} text
 * @returns {{ secret: boolean, reason?: string }}
 */
export function looksLikeSecret(text) {
  if (typeof text !== 'string') return { secret: false }
  const value = text.trim()
  if (value.length === 0) return { secret: false }

  // 环境变量名按惯例是全大写加下划线；这是合法且预期的输入形态。
  const looksLikeEnvName = /^[A-Z][A-Z0-9_]*$/.test(value)
  if (looksLikeEnvName) return { secret: false }

  const lower = value.toLowerCase()
  for (const prefix of SECRET_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return { secret: true, reason: `看起来是密钥本体（以 ${prefix} 开头）` }
    }
  }
  if (JWT_PATTERN.test(value)) {
    // 全局正则会记住 lastIndex，必须复位，否则下一次调用会从中间开始匹配。
    JWT_PATTERN.lastIndex = 0
    return { secret: true, reason: '看起来是 JWT 形式的令牌' }
  }
  JWT_PATTERN.lastIndex = 0

  if (
    value.length >= OPAQUE_TOKEN_MIN_LENGTH &&
    OPAQUE_TOKEN_CHARSET.test(value) &&
    hasMixedCharset(value)
  ) {
    return { secret: true, reason: '看起来是高熵随机串（很可能是密钥本体）' }
  }
  return { secret: false }
}

/**
 * 从一段可能被上游回显的文本里抹掉密钥。
 *
 * 只处理「看起来确定是密钥」的片段：短随机串（如 request id）保留，否则日志会
 * 被 `***` 淹没而失去诊断价值。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  let out = text.replace(JWT_PATTERN, '***')
  JWT_PATTERN.lastIndex = 0
  out = out.replace(/(sk-[A-Za-z0-9_-]{6,})/g, (match) => `${match.slice(0, 6)}***`)
  out = out.replace(/(?<=Bearer\s)[A-Za-z0-9._\-]{16,}/gi, '***')
  return out
}

/**
 * 把错误对象渲染成一小段可安全落日志/推送的文本。
 *
 * @param {unknown} error
 * @param {number} [maxLength]
 * @returns {string}
 */
export function safeErrorMessage(error, maxLength = 300) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const clean = redactSecrets(raw).replace(/\s+/g, ' ').trim()
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean
}
