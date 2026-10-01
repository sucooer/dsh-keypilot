/**
 * 宿主接缝验证：把插件**真的要交给宿主的东西**交给真正的宿主，看它收不收。
 *
 * ## 为什么单测不够
 *
 * `test/` 里的测试不加载宿主模块（要能在任何机器上跑），所以「插件交出去的形状」
 * 与「宿主真正接受的形状」之间永远隔着一层假设。这一层出过一次真事故：
 * 设置里的模型列表是**字符串数组**，而 pi-ai 要的是对象；把字符串当成对象取
 * `.id` 得到 `undefined`，宿主的 `LlmRuntime.listModels()` 随即让整条路由
 * 报 `adapter returned invalid or duplicate model metadata for provider "..."`——
 * 模型选择器里这一家直接「加载失败」，密钥池再满也没用，因为失败在模型目录层。
 *
 * 单测钉得住「我们的形状没变」，钉不住「宿主改了口径」。本脚本负责后者：它用
 * 真实的 `PiAiAdapter`、真实的 `@earendil-works/pi-ai`、真实的宿主校验规则，
 * 把一份真实的配置从头跑一遍。
 *
 * ## 用法
 *
 * 先让插件能解析到宿主的包（只需一次；node_modules 已在 .gitignore 里）：
 *
 * ```
 * node tools/link-host-modules.mjs --dsh-root "%LOCALAPPDATA%\Programs\DeepSeek Harness"
 * ```
 *
 * 不给 `--dsh-root` 时它会自己依次试 `%LOCALAPPDATA%\Programs` 下的常见安装目录。
 *
 * 然后：
 *
 * ```
 * node tools/verify-declared-route.mjs
 * node tools/verify-declared-route.mjs --config "%APPDATA%\dsh-desktop\harness\keypilot.json"
 * ```
 *
 * @module tools/verify-declared-route
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { REQUIRED_PACKAGES, hasPackage } from './lib/host-packages.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析命令行参数。 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' || argv[i] === '-c') out.config = argv[i + 1] ?? ''
    else if (argv[i] === '--known' || argv[i] === '-k') out.known = argv[i + 1] ?? ''
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = '1'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help !== undefined) {
  console.log('用法：node tools/verify-declared-route.mjs [--config <keypilot.json>] [--known <宿主已认识的提供商,逗号分隔>]')
  console.log('  --known 留空表示「宿主谁都不认识」，此时目录内的提供商会被自动补出路由。')
  process.exit(0)
}

/**
 * 宿主的包必须能被插件按裸名解析到，否则整条 pi-ai 接缝都载不进来。
 *
 * 这里查的是**具体那几个包的 `package.json`**，不是 `node_modules/@scope` 目录
 * 存不存在。差别不是吹毛求疵：这个仓库早先用 junction 把两个 scope 目录指到宿主
 * 安装目录，安装目录改名后链接全部悬空——目录**还在**，只是走进去全是空的。按目录
 * 判就会放行，然后脚本崩在 `import('@earendil-works/pi-ai')` 的
 * `ERR_MODULE_NOT_FOUND` 上，看不出是环境问题还是代码问题。
 */
function assertHostModulesLinked() {
  const nodeModules = join(ROOT, 'node_modules')
  const missing = REQUIRED_PACKAGES.filter((name) => !hasPackage(nodeModules, name))
  if (missing.length === 0) return

  console.error(`宿主的包没准备好：${missing.join(', ')}`)
  if (!existsSync(nodeModules)) {
    console.error('（本仓库还没有 node_modules。）')
  } else {
    /** 是不是「scope 目录在、包里没有 package.json」——那多半是悬空链接或没取完。 */
    const hollowed = missing.filter((name) => existsSync(join(nodeModules, name.split('/')[0])))
    if (hollowed.length > 0) {
      console.error('（对应的 scope 目录存在，但里面没有包——多半是悬空链接，或上次没取完。）')
    }
  }
  console.error('请先运行：')
  console.error('  node tools/link-host-modules.mjs --dsh-root "%LOCALAPPDATA%\\Programs\\DeepSeek Harness"')
  console.error('它会按依赖闭包把宿主的包取到本仓库的 node_modules 里（约 31 MiB，只需一次）。')
  process.exit(1)
}

assertHostModulesLinked()

/** 默认找桌面版 harness 里的那份真实配置。 */
function defaultConfig() {
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData.length > 0) {
    const candidate = join(appData, 'dsh-desktop', 'harness', 'keypilot.json')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 没给配置时用一份最小的声明，至少把「模型列表 → 宿主目录」这段跑通。 */
const SAMPLE = {
  config: {
    providers: [{
      provider: 'sample-gw',
      keys: ['SAMPLE_API_KEY'],
      route: {
        id: 'sample-gw',
        displayName: 'Sample gateway',
        baseURL: 'https://gw.example.com/v1',
        api: 'openai-completions',
        models: ['gpt-4o', 'plain-id'],
      },
    }],
  },
}

const configPath = args.config !== undefined && args.config.length > 0 ? args.config : defaultConfig()
const raw = configPath === undefined
  ? SAMPLE
  : JSON.parse(readFileSync(configPath, 'utf8'))
const providers = raw.config?.providers ?? raw.providers ?? []
console.log(`配置来源：${configPath ?? '(内置样例)'}`)
console.log(`声明的池子：${providers.map((p) => `${p.provider}[${p.keys?.length ?? 0} 密钥${p.route === undefined ? '' : `, 路由 ${p.route.id}`}]`).join(', ') || '(空)'}`)

const { collectRoutes, withCatalogRoutes } = await import(pathToFileURL(join(ROOT, 'lib/core/route-schema.js')).href)
const { createCustomRouteRegistry } = await import(pathToFileURL(join(ROOT, 'lib/runtime/custom-routes.js')).href)

/**
 * 宿主已认识的提供商。
 *
 * 必须与 `lib/index.js` 的组合方式一致：先 `withCatalogRoutes` 给「目录内 + 宿主不认识」
 * 的条目补出路由，再 `collectRoutes` 校验。漏掉前一步，配置里没写 `route` 的条目
 * 就会「什么都没注册」——那是脚本的失真，不是插件的问题。
 */
const known = new Set((args.known ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0))
const hostKnowsProvider = (provider) => known.has(provider)
const composed = withCatalogRoutes(providers, hostKnowsProvider)
console.log(`宿主已认识的提供商：${known.size === 0 ? '(无)' : [...known].join(', ')}`)

/** 截获插件交给宿主的适配器，并模拟 `ctx.llm.registerAdapter` 的返回值契约。 */
const registered = new Map()
const ctx = {
  llm: {
    registerAdapter: (ids, adapter) => {
      for (const id of ids) registered.set(id, adapter)
      return () => {
        for (const id of ids) registered.delete(id)
      }
    },
  },
}

const registry = createCustomRouteRegistry({
  ctx,
  logger: {
    info: (message) => console.log(`  · ${message}`),
    warn: (message) => console.log(`  ! ${message}`),
  },
})

await registry.sync(composed, { resolveApiKey: async () => 'sk-verification-placeholder', collectRoutes })

const snapshot = registry.snapshot()
for (const [provider, message] of snapshot.errors) console.log(`注册失败 ${provider}：${message}`)

/**
 * 宿主的模型目录校验，逐字复刻 `dsh-llm/lib/index.js` 的 `LlmRuntime.listModels()`。
 *
 * @param {object[]} models 适配器交出的模型元数据
 * @param {string} provider 被查询的路由
 * @returns {string | undefined} 失败说明；通过时为 undefined
 */
function hostCatalogFailure(models, provider) {
  const seen = new Set()
  for (const model of models) {
    if (typeof model.provider !== 'string' || model.provider !== provider) return `provider 不是 "${provider}"`
    if (typeof model.id !== 'string' || model.id.length === 0) return `id 不是非空字符串（收到 ${JSON.stringify(model.id)}）`
    if (typeof model.name !== 'string' || model.name.length === 0) return `name 不是非空字符串（收到 ${JSON.stringify(model.name)}）`
    if (model.description !== undefined && typeof model.description !== 'string') return 'description 类型不对'
    if (seen.has(model.id)) return `id "${model.id}" 重复`
    seen.add(model.id)
  }
  return undefined
}

let failures = 0
const checked = registered.size
for (const [provider, adapter] of registered) {
  let models
  try {
    models = await adapter.listModels(provider)
  } catch (error) {
    console.log(`✗ ${provider}：listModels 抛出 ${error instanceof Error ? error.message : String(error)}`)
    failures += 1
    continue
  }
  const failure = hostCatalogFailure(models, provider)
  if (failure === undefined) {
    console.log(`✓ ${provider}：${models.length} 个模型，宿主目录校验通过（${models.map((m) => m.id).join(', ')}）`)
  } else {
    console.log(`✗ ${provider}：adapter returned invalid or duplicate model metadata for provider "${provider}" —— ${failure}`)
    failures += 1
  }
}

// 声明了路由却一个都没注册成功，同样是失败。
const { routes, errors } = collectRoutes(composed)
for (const [provider, list] of errors) {
  console.log(`✗ ${provider}：声明本身就没通过校验 —— ${list.map((e) => e.message).join('；')}`)
  failures += 1
}
for (const provider of routes.keys()) {
  if (!registered.has(provider)) {
    console.log(`✗ ${provider}：声明了路由但没有注册成功`)
    failures += 1
  }
}

registry.dispose()

if (failures > 0) {
  console.error(`\n${failures} 处未通过。`)
  process.exit(1)
}
console.log(`\n全部通过（${checked} 条路由）。`)
