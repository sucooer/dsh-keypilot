/**
 * 路由声明校验与归一化。
 *
 * 「自定义提供商」是这类插件最容易出问题的地方，因为它是唯一一处**由用户输入的
 * 字符串直接决定宿主行为**的接缝：一个不合法的路由 ID 会让注册整个失败，一个相对
 * 路径的 Base URL 会让请求在首次流式响应时才炸出看不懂的错误，一个空的模型列表
 * 会让路由注册成功但模型选择器里空无一物。
 *
 * 本模块因此坚持两条原则：
 *
 * 1. **在写入设置时就拒绝，并指名到字段**。任何一条不合格的声明都在保存前被挡下，
 *    错误信息带上字段名与用户填的原始值，而不是等到首次请求才报错。
 * 2. **归一化是幂等的**。同一份输入永远产出同一份输出，设置重载时才能靠比较做
 *    「什么都没变就什么都不做」的短路，也才能让「修改就地生效」可靠。
 *
 * 本模块是纯函数，不接触任何 DSH 服务，可独立单测。
 *
 * @module @sucooer/dsh-keypilot/core/route-schema
 */

import { PROTOCOLS, findCatalogProvider, isCatalogProvider } from './provider-catalog.js'

/** 路由 ID 的上限，避免把整段配置当 ID 用。 */
export const MAX_ROUTE_ID_LENGTH = 64

/** Base URL 的上限。 */
export const MAX_BASE_URL_LENGTH = 2048

/** 模型 ID 的上限。 */
export const MAX_MODEL_ID_LENGTH = 200

/** 一个路由最多声明的模型数。 */
export const MAX_MODELS_PER_ROUTE = 64

/**
 * 本地可判定的路由 ID 形态。
 *
 * 故意比主机的真实约束更宽松：宿主才是权威判定者，本地的职责是挡掉显然不可能的
 * 输入并给出可读报错。注册失败时再由 {@link describeRegistrationError} 把宿主的
 * 判定翻译成人话。
 */
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** 同上的全局版本，用于一次扫描找出所有违规字符。 */
const ROUTE_ID_GLOBAL = /[^A-Za-z0-9._:-]/g

/**
 * @typedef {object} RouteDeclaration
 * @property {string} id           路由 ID
 * @property {string} displayName  显示名
 * @property {string} baseURL      归一化后的端点
 * @property {string} api          线上协议
 * @property {string[]} models     归一化后的模型 ID 列表
 * @property {boolean} builtin     是否来自内置目录
 */

/**
 * @typedef {object} FieldError
 * @property {string} field    出错的字段名
 * @property {string} message  可直接展示给用户的说明
 * @property {string} [value]  被拒绝的原始值（已截断）
 */

/** 把任意输入安全地渲染成一小段可展示文本。 */
function show(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value
  if (Array.isArray(value)) return `Array(${value.length})`
  if (typeof value === 'object') return 'Object'
  return String(value)
}

/**
 * 校验并归一化路由 ID。
 * @param {unknown} raw
 * @returns {{ id: string } | { errors: FieldError[] }}
 */
export function normalizeRouteId(raw) {
  if (typeof raw !== 'string') {
    return { errors: [{ field: 'provider', message: `路由 ID 必须是字符串，收到 ${show(raw)}`, value: show(raw) }] }
  }
  const id = raw.trim()
  if (id.length === 0) {
    return { errors: [{ field: 'provider', message: '路由 ID 不能为空', value: '' }] }
  }
  if (id.length > MAX_ROUTE_ID_LENGTH) {
    return {
      errors: [{
        field: 'provider',
        message: `路由 ID 过长（${id.length} 字符，上限 ${MAX_ROUTE_ID_LENGTH}）`,
        value: show(id),
      }],
    }
  }
  if (!ROUTE_ID_PATTERN.test(id)) {
    const bad = [...new Set(id.match(ROUTE_ID_GLOBAL) ?? [])].slice(0, 5).map((c) => JSON.stringify(c))
    return {
      errors: [{
        field: 'provider',
        message: `路由 ID 含非法字符 ${bad.join(' ')}；只允许字母、数字与 . _ : - ，且首字符必须是字母或数字`,
        value: show(id),
      }],
    }
  }
  return { id }
}

/**
 * 校验并归一化 Base URL。
 *
 * 归一化内容：去掉首尾空白、`URL` 解析、去掉路径尾部的多余斜杠。**不**改写协议、
 * 端口或路径本身——用户填的端点就是用户要的端点，插件只负责让它成为合法 URL。
 *
 * @param {unknown} raw
 * @param {string} routeId 仅用于错误信息
 * @returns {{ baseURL: string } | { errors: FieldError[] }}
 */
export function normalizeBaseUrl(raw, routeId) {
  const label = routeId === undefined ? 'Base URL' : `路由 "${routeId}" 的 Base URL`
  // 「没填」和「填错类型」是两种不同的用户动作：前者提示缺什么，后者提示格式。
  if (raw === undefined || raw === null) {
    return { errors: [{ field: 'baseURL', message: `${label} 不能为空` }] }
  }
  if (typeof raw !== 'string') {
    return { errors: [{ field: 'baseURL', message: `${label} 必须是字符串，收到 ${show(raw)}` }] }
  }
  const text = raw.trim()
  if (text.length === 0) {
    return { errors: [{ field: 'baseURL', message: `${label} 不能为空` }] }
  }
  if (text.length > MAX_BASE_URL_LENGTH) {
    return { errors: [{ field: 'baseURL', message: `${label} 过长（${text.length} 字符，上限 ${MAX_BASE_URL_LENGTH}）` }] }
  }
  // 以 / 或 ./ 开头是相对路径：宿主解析不出主机，请求必失败。
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) {
    return {
      errors: [{
        field: 'baseURL',
        message: `${label} 是相对路径（${show(text)}），必须是带主机的绝对地址，例如 https://api.example.com/v1`,
        value: show(text),
      }],
    }
  }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return {
      errors: [{
        field: 'baseURL',
        message: `${label} 不是合法 URL（${show(text)}），需要形如 https://api.example.com/v1`,
        value: show(text),
      }],
    }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      errors: [{
        field: 'baseURL',
        message: `${label} 的协议是 ${parsed.protocol || '(空)'}，只支持 http 与 https`,
        value: show(text),
      }],
    }
  }
  if (parsed.hostname.length === 0) {
    return { errors: [{ field: 'baseURL', message: `${label} 缺少主机名（${show(text)}）`, value: show(text) }] }
  }
  // 用户名/口令内嵌在 URL 里会被写进设置文件，且宿主不使用它——直接拒绝以免误以为生效。
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return {
      errors: [{
        field: 'baseURL',
        message: `${label} 内嵌了用户名或口令；密钥请填到「密钥」栏，不要写进 URL`,
        value: show(text),
      }],
    }
  }
  // 末尾多余的 / 会让某些网关把 /chat/completions 拼成 //chat/completions。
  let normalized = parsed.toString()
  if (parsed.pathname !== '/' && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return { baseURL: normalized }
}

/**
 * 校验并归一化协议。
 * @param {unknown} raw
 * @param {string} [fallback] 缺省时使用的协议
 * @returns {{ api: string } | { errors: FieldError[] }}
 */
export function normalizeProtocol(raw, fallback = 'openai-completions') {
  if (raw === undefined || raw === null || raw === '') {
    if (PROTOCOLS.includes(fallback)) return { api: fallback }
    return { errors: [{ field: 'api', message: `默认协议 ${show(fallback)} 不在支持列表内` }] }
  }
  if (typeof raw !== 'string') {
    return { errors: [{ field: 'api', message: `协议必须是字符串，收到 ${show(raw)}` }] }
  }
  const api = raw.trim()
  if (!PROTOCOLS.includes(api)) {
    return {
      errors: [{
        field: 'api',
        message: `协议 "${api}" 不受支持；可选 ${PROTOCOLS.join(' / ')}`,
        value: api,
      }],
    }
  }
  return { api }
}

/**
 * 校验并归一化模型列表：去空白、去空项、去重、保序。
 *
 * 保序很重要——它是用户在界面上排出的优先级，也是模型选择器里的展示顺序。
 *
 * @param {unknown} raw
 * @param {string} routeId
 * @returns {{ models: string[] } | { errors: FieldError[] }}
 */
export function normalizeModels(raw, routeId) {
  const label = routeId === undefined ? '模型列表' : `路由 "${routeId}" 的模型列表`
  if (raw === undefined || raw === null) {
    return { models: [] }
  }
  if (!Array.isArray(raw)) {
    // 允许用户贴一段逗号/换行分隔的文本，这比要求 JSON 数组更符合实际使用。
    return { errors: [{ field: 'models', message: `${label} 必须是数组或逗号分隔的文本，收到 ${show(raw)}` }] }
  }
  const seen = new Set()
  const models = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { errors: [{ field: 'models', message: `${label} 含非字符串项 ${show(item)}` }] }
    }
    const id = item.trim()
    if (id.length === 0) continue
    if (id.length > MAX_MODEL_ID_LENGTH) {
      return { errors: [{ field: 'models', message: `模型 ID 过长：${show(id)}（上限 ${MAX_MODEL_ID_LENGTH}）` }] }
    }
    if (seen.has(id)) continue
    seen.add(id)
    models.push(id)
    if (models.length > MAX_MODELS_PER_ROUTE) {
      return { errors: [{ field: 'models', message: `${label} 超过上限 ${MAX_MODELS_PER_ROUTE} 条` }] }
    }
  }
  return { models }
}

/**
 * 校验一条路由声明。
 *
 * @param {unknown} raw 设置里的 `providers[].route` 对象
 * @param {object} [options]
 * @param {string} [options.provider] 所属池子的提供商 ID（缺失时从 raw 取）
 * @returns {{ ok: true, route: RouteDeclaration } | { ok: false, errors: FieldError[] }}
 */
export function normalizeRoute(raw, options = {}) {
  if (raw === undefined || raw === null) {
    return { ok: false, errors: [{ field: 'route', message: '缺少路由声明（route）' }] }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'route', message: `路由声明必须是对象，收到 ${show(raw)}` }] }
  }

  /** @type {FieldError[]} */
  const errors = []
  const push = (result) => {
    if (result.errors !== undefined) errors.push(...result.errors)
    return result.errors === undefined ? result : undefined
  }

  // 路由 ID：显式声明的优先，否则退回池子的 provider 名。
  const explicitId = raw.id ?? raw.provider ?? options.provider
  const idResult = push(normalizeRouteId(explicitId))
  const builtin = typeof idResult?.id === 'string' ? isCatalogProvider(idResult.id) : false
  const preset = builtin ? findCatalogProvider(idResult.id) : undefined

  // Base URL / 协议 / 模型：显式声明优先，否则用内置目录的预设补全。
  // 这条回退链是「内置提供商一键添加」能复用同一套校验的关键。
  const baseResult = push(normalizeBaseUrl(raw.baseURL ?? raw.baseUrl ?? preset?.baseURL, idResult?.id))
  const apiResult = push(normalizeProtocol(raw.api ?? preset?.api, preset?.api ?? 'openai-completions'))
  const modelsResult = push(normalizeModels(raw.models ?? preset?.models, idResult?.id))

  const displayName = typeof raw.displayName === 'string' && raw.displayName.trim().length > 0
    ? raw.displayName.trim()
    : preset?.label ?? idResult?.id ?? ''

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    route: {
      id: idResult.id,
      displayName,
      baseURL: baseResult.baseURL,
      api: apiResult.api,
      models: modelsResult.models,
      builtin,
    },
  }
}

/**
 * 判断一份 `providers` 数组里哪些条目声明了路由，并逐条校验。
 *
 * 未声明 `route` 的条目直接跳过——它们复用宿主已有的路由，不需要插件注册任何东西。
 *
 * 重复 ID 会让后一条覆盖前一条（并记为一次错误），因为宿主侧只可能存在一个适配器；
 * 静默覆盖比崩溃好，但必须让用户知道。
 *
 * @param {unknown} providers 设置里的 `providers` 数组
 * @returns {{ routes: Map<string, RouteDeclaration>, errors: Map<string, FieldError[]> }}
 */
export function collectRoutes(providers) {
  /** @type {Map<string, RouteDeclaration>} */
  const routes = new Map()
  /** @type {Map<string, FieldError[]>} */
  const errors = new Map()
  if (!Array.isArray(providers)) return { routes, errors }

  for (const entry of providers) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const declared = entry.route
    const hasRoute = declared !== null && typeof declared === 'object' && !Array.isArray(declared)
    if (!hasRoute) continue

    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : undefined
    const result = normalizeRoute(declared, { provider })
    if (!result.ok) {
      errors.set(provider ?? show(declared.id ?? declared.provider), result.errors)
      continue
    }
    const { id } = result.route
    if (routes.has(id)) {
      const previous = routes.get(id)
      errors.set(id, [{
        field: 'provider',
        message: `路由 ID "${id}" 被声明了多次（后者覆盖前者）；请给每个网关一个唯一 ID`,
      }])
      // 覆盖时保留先到者的顺序语义：后者生效，但让用户看到报错。
      routes.set(id, { ...result.route, displayName: result.route.displayName || previous.displayName })
      continue
    }
    routes.set(id, result.route)
  }
  return { routes, errors }
}

/**
 * 把宿主抛出的注册错误翻译成可读诊断。
 *
 * 注册失败是**必然会发生**的正常情况（ID 撞车、主机缺 pi-ai 接缝），因此这里不抛出，
 * 只把技术信息转成用户能照做的说明。
 *
 * @param {unknown} error
 * @param {string} routeId
 * @returns {string}
 */
export function describeRegistrationError(error, routeId) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'DUPLICATE_ADAPTER' || /already (registered|serves)/i.test(message)) {
    return `路由 ID "${routeId}" 已被宿主或其他插件占用；换一个 ID，或删掉这条自定义路由改用宿主已有的提供商`
  }
  if (/pi-ai|adapter/i.test(message) && /not (found|available|exposed)/i.test(message)) {
    return `当前宿主没有暴露 pi-ai 适配器接缝，无法注册自定义路由（${message}）`
  }
  return message
}

/**
 * 判断在给定协议集合下，这条路由能否被本宿主服务。
 *
 * @param {RouteDeclaration} route
 * @param {readonly string[]} availableProtocols
 * @returns {FieldError | undefined}
 */
export function checkProtocolAvailability(route, availableProtocols) {
  if (availableProtocols.length === 0) return undefined
  if (availableProtocols.includes(route.api)) return undefined
  return {
    field: 'api',
    message: `本宿主未提供 ${route.api} 协议（可用：${availableProtocols.join(' / ')}）`,
    value: route.api,
  }
}
