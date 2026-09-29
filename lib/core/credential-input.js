/**
 * 「直接在面板里填密钥」的输入校验与引用名建议。
 *
 * ## 它在这个功能里扮演什么角色
 *
 * 用户在插件面板里粘贴的是**密钥本体**。这个值不会进插件配置——插件把它交给宿主的
 * 凭据服务（`credentials.set`），配置里仍然只留引用名。所以这一层只回答三个问题：
 *
 * 1. 「这个引用名能用吗」——名字会成为环境变量名与凭据文件的键，形状必须收窄；
 * 2. 「这个值像个密钥吗」——两栏填反是这里最容易犯的错，必须挡住；
 * 3. 「给个没被占用的名字」——用户要加第二、第三把密钥时不该自己数到几了。
 *
 * 纯函数、零 I/O，把边界条件一次测干净。
 *
 * @module @sucooer/dsh-keypilot/core/credential-input
 */

import { looksLikeSecret } from './redact.js'

/**
 * 引用名的合法形态：字母开头，只含字母、数字、下划线。
 *
 * 不允许 `-` 与 `.`：宿主的凭据名同时要能当环境变量名用（`.env` 回退那条路径），
 * 而环境变量名里出现连字符或点是不可移植的。
 */
const REF_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

/** 引用名长度上限。 */
export const MAX_REF_LENGTH = 64

/** 密钥值长度上限：任何真实密钥都远小于它，同时挡住「误粘贴一整篇文章」。 */
export const MAX_SECRET_LENGTH = 4096

/**
 * 判断某个字符串像不像「引用名」。
 *
 * 词根可以带序号后缀（`NVIDIA_API_KEY_2` 是最常见的形态），所以匹配词根两边的
 * 位置都不锁死在末尾——只要求「全大写 + 下划线/数字」且含凭据类词根。
 * 规则刻意收窄：误判的代价是把真密钥判成引用名、用户提交不了，不值得为多拦几种
 * 少见命名去冒这个险。
 */
function looksLikeRefName(value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) return false
  return /(?:_API_KEY|_KEY|_TOKEN|_SECRET|_API)(?:_\d+)?$/.test(value)
}

/**
 * 校验用户填的凭据引用名。
 *
 * @param {unknown} raw 用户输入
 * @param {object} [options]
 * @param {readonly string[]} [options.existing] 宿主里已有的引用名（用于提示是否覆盖）
 * @returns {{ ok: true, ref: string, exists: boolean } | { ok: false, message: string }}
 */
export function validateCredentialRef(raw, options = {}) {
  if (typeof raw !== 'string') return { ok: false, message: '引用名必须是字符串' }
  const ref = raw.trim()
  if (ref.length === 0) return { ok: false, message: '引用名不能为空' }
  if (ref.length > MAX_REF_LENGTH) {
    return { ok: false, message: `引用名过长（${ref.length} 字符，上限 ${MAX_REF_LENGTH}）` }
  }
  // 先挡「把密钥本体填进了名字栏」，再报形状错误——否则用户看到的是
  // 「含有非法字符」，得自己猜哪里错了。
  //
  // 注意 `looksLikeSecret` 返回的是 `{ secret, reason }` 而不是布尔：写成
  // `if (looksLikeSecret(...))` 会因为对象恒为真而拒绝掉一切输入。
  const secretCheck = looksLikeSecret(ref)
  if (secretCheck.secret === true) {
    return {
      ok: false,
      message: `${secretCheck.reason ?? '这看起来是密钥本体'}。名字栏只填引用名（如 SENSENOVA_API_KEY），密钥填在旁边的值栏`,
    }
  }
  if (!REF_PATTERN.test(ref)) {
    return { ok: false, message: '引用名只能由字母、数字、下划线组成，且以字母开头（例：SENSENOVA_API_KEY_2）' }
  }

  const existing = Array.isArray(options.existing) ? options.existing : []
  const exists = existing.some((item) => String(item) === ref)
  return { ok: true, ref, exists }
}

/**
 * 校验用户粘贴的密钥值。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export function validateSecret(raw) {
  if (typeof raw !== 'string') return { ok: false, message: '密钥必须是字符串' }
  const value = raw.trim()
  if (value.length === 0) return { ok: false, message: '密钥不能为空' }
  if (value.length > MAX_SECRET_LENGTH) {
    return { ok: false, message: `密钥过长（${value.length} 字符，上限 ${MAX_SECRET_LENGTH}）；是不是粘错了内容？` }
  }
  // 两栏填反的另一种形态：把引用名填进了值栏。填错了要到真正的请求 401 时才会发现，
  // 而那时人会先怀疑密钥失效。
  if (looksLikeRefName(value)) {
    return { ok: false, message: '这看起来是引用名，不是密钥本体。请填密钥本身（如 sk-…），引用名填在名字栏' }
  }
  // 密钥内部带空白几乎一定是复制时夹带了换行或空格。与其存进去等上游报鉴权失败，
  // 不如现在就拒绝。
  if (/\s/.test(value)) {
    return { ok: false, message: '密钥内部不能含空白字符（多半是复制时夹带了换行或空格）' }
  }
  return { ok: true, value }
}

/**
 * 按已有引用名推荐一个没被占用的名字。
 *
 * 沿用用户已经在用的命名：`SENSENOVA_API_KEY` → `SENSENOVA_API_KEY_2` → `_3`…
 * 比较时忽略大小写，因为那更接近「这个名字会不会撞上」（宿主的凭据名虽然区分大小写，
 * 但两份只差大小写的名字只会让人日后认错）。
 *
 * @param {string} base 基础名（通常由提供商名派生）
 * @param {readonly string[]} [existing] 已占用的名字
 * @returns {string} 空串表示给不出建议
 */
export function suggestCredentialRef(base, existing = []) {
  const root = typeof base === 'string' ? base.trim() : ''
  if (root.length === 0) return ''
  const taken = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item).toUpperCase()))
  if (!taken.has(root.toUpperCase())) return root
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${root}_${n}`
    if (!taken.has(candidate.toUpperCase())) return candidate
  }
  return ''
}

/**
 * 由提供商 ID 派生基础引用名，与宿主「设置 → 模型」页的规则保持一致。
 *
 * 宿主那边是 `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`（实测
 * `deriveKeyRef`），照抄一份是为了让面板里预填的名字**正好落在宿主会用的那个名字上**：
 * 用户在宿主页面填过的密钥，插件这边一点就接上了，不用去核对拼写。
 *
 * @param {string} provider
 * @returns {string}
 */
export function baseCredentialRefFor(provider) {
  const id = typeof provider === 'string' ? provider.trim() : ''
  if (id.length === 0) return ''
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
