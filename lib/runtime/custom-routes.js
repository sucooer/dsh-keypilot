/**
 * 自定义提供商路由：为宿主尚不认识的网关声明一条真正的模型路由。
 *
 * ## 为什么需要它
 *
 * 密钥池只能为**已存在的路由**轮换密钥。宿主自带的提供商目录决定了模型选择器
 * 里能选什么，因此用户自己的网关（公司内网、聚合站、自建 vLLM）根本没有路由可挂，
 * 池子再满也是死的。本模块按与宿主相同的方式补上这条路由：一个 pi-ai 适配器，
 * 通过 `ctx.llm.registerAdapter()` 注册，注册后它和内置提供商一样出现在选择器里。
 *
 * ## 这里的 bug 为什么特别多
 *
 * 这条路是唯一一处「用户输入的字符串直接决定宿主行为」的接缝，而且跨越了插件与
 * 宿主内部模块的边界。常见故障：路由 ID 与宿主已注册的撞车、Base URL 是相对路径、
 * 宿主缺少 pi-ai 接缝导致静默失败、设置反复重载导致重复注册或孤儿注册。本模块
 * 逐条应对：
 *
 * - **注册与撤回都走同一个 registry**，`sync()` 幂等，按 diff 决定增删改；
 * - **`sync()` 串行化**。设置变更可能连续触发，两次异步 sync 交叠会重复注册或
 *   释放错乱——这是同时存在「注册中」与「已注册」两个真相的经典竞态；
 * - **每条路由的失败互相隔离**，一条配置错不该让其他可用路由一起消失；
 * - **失败被翻译成人话**并保留在诊断里，而不是等到首次请求才炸出看不懂的流式错误。
 *
 * ## 优雅降级
 *
 * 全部宿主模块都通过带 try/catch 的动态 import 取得。宿主不提供 pi-ai 接缝时，
 * 自定义路由给出可读诊断，而插件的其余部分（内置提供商的密钥轮换）完全不受影响。
 *
 * @module @sucooer/dsh-keypilot/runtime/custom-routes
 */

import { PROTOCOLS } from '../core/index.js'
import { describeRegistrationError } from '../core/route-schema.js'

/** pi-ai 对单次流式读取的默认空闲上限。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** 与 dsh-llm-pi-ai 默认值一致的图片请求预算。 */
const IMAGE_BUDGETS = Object.freeze({
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
})

/**
 * 惰性认证面。
 *
 * 这条路由的凭据完全由本插件按请求提供，pi-ai 自己的凭据生命周期必须**永不**
 * 为它制造、读取或保存任何东西——否则会出现「插件给了一把密钥，pi-ai 又从
 * 别处读了一把」的双重真相。
 */
const INERT_AUTH = Object.freeze({
  credentials: {
    async read() {},
    async list() { return [] },
    async modify() { throw new Error('dsh-keypilot：声明式自定义路由没有 pi-ai 凭据生命周期') },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false },
  },
})

let runtimePromise

/**
 * 载入声明路由所需的宿主接缝，每个进程只成功载入一次。
 *
 * 失败**不**污染记忆：用户可能刚装上缺的包，下次调用应当重新尝试。
 *
 * @returns {Promise<object>}
 */
export function loadPiAiRuntime() {
  runtimePromise ??= (async () => {
    const [piAi, piAiAdapter, llm] = await Promise.all([
      import('@earendil-works/pi-ai'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
      import('@deepseek-ai/dsh-llm'),
    ])
    const [completions, responses, anthropic] = await Promise.all([
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      import('@earendil-works/pi-ai/api/openai-responses.lazy'),
      import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
    ])
    if (typeof piAi.createProvider !== 'function') {
      throw new Error('@earendil-works/pi-ai 没有导出 createProvider')
    }
    if (typeof piAiAdapter.PiAiAdapter !== 'function') {
      throw new Error('@deepseek-ai/dsh-llm-pi-ai 没有导出 PiAiAdapter')
    }
    const protocols = typeof piAiAdapter.supportedProtocols === 'function'
      ? piAiAdapter.supportedProtocols()
      : [...PROTOCOLS]
    return {
      createProvider: piAi.createProvider,
      PiAiAdapter: piAiAdapter.PiAiAdapter,
      resolveRetryPolicy: llm.resolveRetryPolicy,
      resolveImageAttachmentAccess: llm.resolveImageAttachmentAccess,
      apiFactories: {
        'openai-completions': completions.openAICompletionsApi,
        'openai-responses': responses.openAIResponsesApi,
        'anthropic-messages': anthropic.anthropicMessagesApi,
      },
      protocols,
    }
  })().catch((error) => {
    // 不缓存失败：装上缺的包之后重试应当能成功。
    runtimePromise = undefined
    throw error
  })
  return runtimePromise
}

/** 宿主当前支持的协议列表（未载入时给出保守的默认）。 */
let loadedProtocols
export function knownProtocols() {
  return loadedProtocols === undefined ? [...PROTOCOLS] : [...loadedProtocols]
}

/**
 * 这条路由用来认证自己的 api-key 认证面。
 *
 * pi-ai 解析请求的 `apiKey` 时，会把它包成一个凭据交给这个条目，并**以条目的
 * 返回值为准**。因此「声明了条目」还不够：返回空会让 pi-ai 认为该提供商未配置，
 * 于是每个请求都在离开进程之前就失败成 `Provider is not configured`——无论池子里
 * 有多少密钥。这里不查任何东西，只是把池子已经决定好的那把密钥原样报告回去。
 *
 * @param {string} provider
 * @returns {object}
 */
function poolApiKeyAuth(provider) {
  const name = `${provider} 密钥池凭据`
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/**
 * 把一条路由的模型描述转成 pi-ai 期望的形状。
 *
 * **这个转换必须做对，否则整条路由一起报废。** 设置里的模型列表是**字符串数组**
 * （`Schema.array(Schema.string())`，见 `lib/index.js`；`normalizeModels` 也只产出
 * 字符串），而 pi-ai 要的是对象。把字符串当成对象去取 `.id` / `.name` 会得到
 * `undefined`，宿主随后在 `LlmRuntime.listModels()` 里逐条校验
 * `provider` / `id` / `name` 都是非空字符串，于是整个提供商报
 * `adapter returned invalid or duplicate model metadata for provider "..."`——
 * 密钥池再好也加载不出来，因为失败发生在模型目录层，不在请求层。
 *
 * 因此这里接受两种形态：
 * - **字符串**（设置里的正常形态）：`"deepseek-v4-flash"` → id 与 name 都是它；
 * - **对象**（`{ id, name?, contextWindow?, maxTokens?, supportsImages? }`）：
 *   为将来带上上下文长度等元数据留的口子。
 *
 * @param {object} route 归一化后的路由声明
 * @param {string | object} model 模型项
 * @returns {object} pi-ai 的模型描述
 */
function toPiModel(route, model) {
  const source = typeof model === 'string' ? { id: model } : (model ?? {})
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const explicitName = typeof source.name === 'string' ? source.name.trim() : ''
  const contextWindow = Number(source.contextWindow)
  const maxTokens = Number(source.maxTokens)
  return {
    id,
    // name 为空时退回 id：宿主同样要求它是非空字符串。
    name: explicitName.length > 0 ? explicitName : id,
    api: route.api,
    baseUrl: route.baseURL,
    input: source.supportsImages === true ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128_000,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8192,
    reasoning: false,
  }
}

/**
 * 为一条声明路由组装适配器。
 *
 * @param {object} options
 * @param {object} options.runtime {@link loadPiAiRuntime} 的结果
 * @param {string} options.provider 路由 ID
 * @param {object} options.route 归一化后的路由声明
 * @param {(provider: string) => Promise<string>} options.resolveApiKey 从轮换池取密钥
 * @returns {{ adapter: object, update: (route: object) => void }}
 */
export function buildCustomAdapter({ runtime, provider, route, resolveApiKey }) {
  const factory = runtime.apiFactories?.[route.api]
  if (typeof factory !== 'function') {
    throw new TypeError(`路由 "${provider}"：本宿主不提供 ${route.api} 协议`)
  }
  let profiles = new Map()

  const rebuild = (next) => {
    const models = next.models.map((model) => ({ ...toPiModel(next, model), provider }))
    const piProvider = runtime.createProvider({
      id: provider,
      name: next.displayName,
      auth: { apiKey: poolApiKeyAuth(provider) },
      models,
      api: factory(),
    })
    // profiles() 交出一份**新的 Map 标识**，PiAiAdapter 以此判断「配置变了」，
    // 因此改个显示名或加个模型不需要重新注册路由。
    profiles = new Map([[provider, {
      provider,
      displayName: next.displayName,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: runtime.resolveRetryPolicy?.(undefined, `dsh-keypilot：路由 "${provider}" 的 retryPolicy`),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...IMAGE_BUDGETS,
      piProvider,
    }]])
  }
  rebuild(route)

  const adapter = new runtime.PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: (routeProvider) => resolveApiKey(routeProvider),
  })

  return { adapter, update: (next) => rebuild(next) }
}

/**
 * 建一个自定义路由注册表。
 *
 * @param {object} options
 * @param {object} options.ctx cordis 上下文；`ctx.llm.registerAdapter` 是接缝
 * @param {object} [options.logger]
 * @returns {{ sync: Function, dispose: Function, snapshot: Function, baseUrlFor: Function }}
 */
export function createCustomRouteRegistry({ ctx, logger }) {
  /** @type {Map<string, { route: object, update: Function, release: Function }>} */
  const held = new Map()
  /** @type {Map<string, string>} */
  const errors = new Map()
  /** 最后一次同步声明，即使注册失败也保留：探针需要知道端点。 */
  let declared = new Map()
  /** 串行化队列：防止两次 sync 交叠。 */
  let queue = Promise.resolve()
  let disposed = false

  /** 释放一条路由，任何异常都只记诊断。 */
  function release(provider) {
    const entry = held.get(provider)
    if (entry === undefined) return
    held.delete(provider)
    try {
      entry.release?.()
    } catch (error) {
      logger?.warn?.(`[keypilot] 释放自定义路由 "${provider}" 时出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 真正执行一次同步（已被队列串行化）。 */
  async function doSync(providers, options) {
    if (disposed) return [...held.keys()]
    const { routes, errors: validationErrors } = options.collectRoutes(providers)
    declared = routes
    errors.clear()
    for (const [provider, list] of validationErrors) {
      errors.set(provider, list.map((e) => e.message).join('；'))
    }

    // 先撤回不再声明的路由。
    for (const provider of [...held.keys()]) {
      if (!routes.has(provider)) release(provider)
    }
    if (routes.size === 0) return [...held.keys()]

    let runtime
    try {
      runtime = await loadPiAiRuntime()
      loadedProtocols = runtime.protocols
    } catch (error) {
      const message = `本宿主没有暴露 pi-ai 适配器接缝（${error instanceof Error ? error.message : String(error)}）；`
        + '声明式自定义路由需要 @deepseek-ai/dsh-llm-pi-ai 与 @earendil-works/pi-ai。'
        + '内置提供商与密钥轮换不受影响。'
      for (const provider of routes.keys()) errors.set(provider, message)
      return [...held.keys()]
    }

    for (const [provider, route] of routes) {
      const current = held.get(provider)
      if (current !== undefined) {
        // 已注册：就地更新（改显示名、加模型都不需要重新注册）。
        try {
          current.update(route)
          current.route = route
          errors.delete(provider)
        } catch (error) {
          errors.set(provider, describeRegistrationError(error, provider))
        }
        continue
      }
      try {
        const built = buildCustomAdapter({ runtime, provider, route, resolveApiKey: options.resolveApiKey })
        const handle = ctx.llm.registerAdapter([provider], built.adapter)
        held.set(provider, {
          route,
          update: built.update,
          release: typeof handle === 'function' ? handle : () => {},
        })
        errors.delete(provider)
        logger?.info?.(`[keypilot] 已注册自定义路由 "${provider}" → ${route.baseURL}（${route.models.length} 个模型，${route.api}）`)
      } catch (error) {
        errors.set(provider, describeRegistrationError(error, provider))
        logger?.warn?.(`[keypilot] 自定义路由 "${provider}" 注册失败：${describeRegistrationError(error, provider)}`)
      }
    }
    return [...held.keys()]
  }

  /**
   * 让已注册的路由与配置保持一致。幂等，可从任意次数调用。
   *
   * @param {unknown} providers 设置里的 `providers` 数组
   * @param {object} options
   * @param {(provider: string) => Promise<string>} options.resolveApiKey
   * @param {(providers: unknown) => { routes: Map<string, object>, errors: Map<string, object[]> }} options.collectRoutes
   * @returns {Promise<string[]>}
   */
  function sync(providers, options) {
    // 排在上一次之后：两次交叠的 sync 会各自认为「路由还没注册」而重复注册，
    // 或者各自认为「该释放」而释放掉对方刚建好的路由。
    const run = queue.then(
      () => doSync(providers, options),
      () => doSync(providers, options),
    )
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 撤回本注册表注册的全部路由。 */
  function dispose() {
    disposed = true
    for (const provider of [...held.keys()]) release(provider)
    declared = new Map()
    errors.clear()
  }

  /**
   * 一条声明路由的端点，供健康探测使用。
   *
   * 宿主的提供商目录里没有这条路由，因此探测只能靠这里的声明。
   *
   * @param {string} provider
   * @returns {string | undefined}
   */
  function baseUrlFor(provider) {
    const route = declared.get(provider)
    return route !== undefined && typeof route.baseURL === 'string' && route.baseURL.length > 0
      ? route.baseURL
      : undefined
  }

  /** 当前状态，供设置面板展示「哪些生效、哪些失败」。 */
  function snapshot() {
    return {
      registered: [...held.keys()],
      errors: new Map(errors),
      declared: new Map(declared),
    }
  }

  return { sync, dispose, snapshot, baseUrlFor }
}
