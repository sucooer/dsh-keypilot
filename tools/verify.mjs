/**
 * 发布前静态自检。
 *
 * 单测保证的是「逻辑对」，这个脚本保证的是「包能装、能被宿主加载」——两类问题
 * 完全不同，且后者的失败通常在用户安装之后才暴露。这里逐条检查包在宿主眼里
 * 是否成立：
 *
 * - `package.json` 的入口、`exports`、`dsh.bundle.patch`、`dsh.client` 是否齐全；
 * - 每个 `exports` 目标是否真的存在（打包遗漏是最常见的发布事故）；
 * - 客户端产物是否真的是宿主模块加载器格式（写成了普通 ESM 会在浏览器里静默失效）；
 * - 主机入口是否导出了 `name` / `inject` / `apply`；
 * - 仓库里有没有不小心带上密钥形态的字符串。
 *
 * 运行：node tools/verify.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROTOCOLS } from '../lib/core/provider-catalog.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {string[]} */
const failures = []
/** @type {string[]} */
const passes = []

function check(label, condition, detail) {
  if (condition) passes.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` —— ${detail}`}`)
}

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
}

function readText(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

// ── package.json ────────────────────────────────────────────────────────────

const pkg = readJson('package.json')
check('name 是 scoped 且非空', typeof pkg.name === 'string' && pkg.name.includes('/'))
check('type 为 module', pkg.type === 'module')
check('main 指向 lib/index.js', pkg.main === 'lib/index.js', `实际 ${String(pkg.main)}`)
check('声明了 dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string')
check('声明了 dsh.client', pkg.dsh?.client !== undefined)
check('dsh.client.platform 为 web', pkg.dsh?.client?.platform === 'web')
check('声明了 node engine', typeof pkg.engines?.node === 'string')
check('声明了 dsh engine', typeof pkg.dsh?.engines?.dsh === 'string')

// ── exports 目标存在性 ──────────────────────────────────────────────────────

if (pkg.exports !== undefined) {
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : (value.default ?? value.types)
    if (typeof target !== 'string') {
      failures.push(`exports["${key}"] 没有可解析的目标`)
      continue
    }
    check(`exports["${key}"] 的目标存在`, existsSync(join(ROOT, target)), target)
  }
}

// ── files 白名单覆盖关键产物 ────────────────────────────────────────────────

const files = Array.isArray(pkg.files) ? pkg.files : []
for (const required of ['lib', 'cordis.patch.yml']) {
  check(`files 包含 ${required}`, files.includes(required))
}

// ── bundle patch 内容 ───────────────────────────────────────────────────────

const patchPath = pkg.dsh?.bundle?.patch
if (typeof patchPath === 'string' && existsSync(join(ROOT, patchPath))) {
  const patch = readText(patchPath)
  check('cordis.patch.yml 含 insert 节点', patch.includes('insert:'))
  check('cordis.patch.yml 含插件 id', patch.includes('id:'))
  check('cordis.patch.yml 引用了包名', patch.includes(pkg.name), `应为 ${pkg.name}`)
} else {
  failures.push('dsh.bundle.patch 指向的文件不存在')
}

// ── 主机入口 ────────────────────────────────────────────────────────────────

const mainPath = join(ROOT, pkg.main)
check('主机入口存在', existsSync(mainPath), pkg.main)
if (existsSync(mainPath)) {
  const source = readText(pkg.main)
  check('主机入口导出 name', /export const name\s*=/.test(source))
  check('主机入口导出 inject', /export const inject\s*=/.test(source))
  check('主机入口导出 apply', /export function apply\s*\(/.test(source))
  check('主机入口导出 Config schema', /export const Config\s*=/.test(source))
  check('主机入口含凭据解析拦截', source.includes('credentials.resolve'))
  check('主机入口监听 llm/stream', source.includes("'llm/stream'"))
}

// ── 客户端产物格式 ──────────────────────────────────────────────────────────

const clientTarget = pkg.exports?.['./client']
const clientPath = typeof clientTarget === 'string' ? clientTarget : clientTarget?.default
if (typeof clientPath === 'string' && existsSync(join(ROOT, clientPath))) {
  const client = readText(clientPath)
  // 浏览器侧依赖由宿主的模块加载器注入，写成普通 ESM import 会在浏览器里静默失效。
  check('客户端产物是 ModuleLoader 格式', client.includes('__ModuleLoader__'))
  // 引号风格不是契约，两种都接受；关键是 id 必须与包名一致。
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  check(
    '客户端产物声明了模块 id',
    new RegExp(`id:\\s*['"]${escaped}['"]`).test(client),
    `应为 ${pkg.name}`,
  )
  check('客户端注册了 settings.section 分区', client.includes('settings.section'))
  check('客户端导出了 inject', /exports\.inject\s*=/.test(client))
  check('客户端导出了 apply', /exports\.apply\s*=/.test(client))
  check('客户端未使用裸 ESM import 拉取宿主模块', !/^\s*import\s+.*from\s+['"]@deepseek-ai/m.test(client))
}

// ── 目录完整性 ──────────────────────────────────────────────────────────────

for (const relative of [
  'lib/core/index.js',
  'lib/core/provider-catalog.js',
  'lib/core/route-schema.js',
  'lib/core/pool.js',
  'lib/core/classify.js',
  'lib/core/canary.js',
  'lib/core/usage.js',
  'lib/core/pricing.js',
  'lib/core/webhook.js',
  'lib/runtime/rotate.js',
  'lib/runtime/custom-routes.js',
  'lib/runtime/config.js',
  'lib/runtime/state.js',
  'lib/runtime/http-bridge.js',
  'lib/runtime/probe.js',
  'lib/runtime/notifier.js',
  'tools/deploy-local.mjs',
  'icon.svg',
  'README.zh.md',
  'LICENSE',
  'docs/settings-panel.png',
]) {
  check(`${relative} 存在`, existsSync(join(ROOT, relative)))
}

// 截图进 README 了，就得保证它同时进了 npm 包，否则发布后图片 404。
check('package.json 的 files 含 docs（README 截图随包发布）',
  JSON.parse(readText('package.json')).files.includes('docs'))

// 浏览器端是自包含模块（只能向宿主 require，不能 import core），协议列表没法派生，
// 只能各写一份 —— 那就必须断言两处一致，否则将来加了新协议，界面上根本选不到。
{
  const clientSource = readText('lib/client.js')
  const missing = PROTOCOLS.filter((protocol) => !clientSource.includes(`'${protocol}'`))
  check('客户端协议下拉覆盖 core 的全部 PROTOCOLS', missing.length === 0,
    `客户端缺少：${missing.join(', ')}`)
}

check('主机入口注册了用量报表路由', readText('lib/index.js').includes('BRIDGE_USAGE_PATH'))
check('主机入口接入了金丝雀探测', readText('lib/index.js').includes('runProbeSweep'))
check('主机入口接入了 Webhook 队列', readText('lib/index.js').includes('NotifyQueue'))
  check('客户端含用量面板', readText('lib/client.js').includes('keypilot.sectionUsage'))
  check('客户端含通知面板', readText('lib/client.js').includes('keypilot.sectionNotify'))
  check('客户端含探测面板', readText('lib/client.js').includes('keypilot.sectionCanary'))

// 回归锁：被 `...` 展开成 children 的列表必须保证是数组。
// 曾经写在「池子为空」分支里直接返回单个元素，导致宿主报
// `slot entry crashed in 'settings.section': Spread syntax requires ...iterable`
// 并渲染空白 —— 而空池正是新装插件的默认状态，所以必然踩到。
check(
  'poolCards 在空池分支也返回数组（spread 安全）',
  /poolCards = pools\.length === 0\s*\?\s*\[/.test(readText('lib/client.js')),
  '空池分支必须写成 [element]，不能直接返回元素',
)

check('core 层不依赖任何 @deepseek-ai 包', (() => {
  const coreDir = join(ROOT, 'lib/core')
  for (const file of [
    'index.js', 'provider-catalog.js', 'route-schema.js', 'pool.js', 'classify.js',
    'backoff.js', 'token-bucket.js', 'concurrency.js', 'quota-window.js', 'cascade.js',
    'estimate.js', 'histogram.js', 'redact.js', 'clock.js',
    'canary.js', 'usage.js', 'pricing.js', 'webhook.js',
  ]) {
    const path = join(coreDir, file)
    if (!existsSync(path)) continue
    if (/from\s+['"]@deepseek-ai/.test(readText(`lib/core/${file}`))) return false
  }
  return true
})(), 'core 层必须可脱离宿主运行')

// ── 安全自检 ────────────────────────────────────────────────────────────────

const SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./
for (const relative of ['lib/index.js', 'lib/client.js', 'README.zh.md', 'package.json']) {
  if (!existsSync(join(ROOT, relative))) continue
  check(`${relative} 不含硬编码密钥`, !SECRET_PATTERN.test(readText(relative)))
}

// ── 体积 ────────────────────────────────────────────────────────────────────

const libSize = (() => {
  // 只统计 lib 目录下已列出的文件，避免依赖递归遍历。
  let total = 0
  for (const file of ['index.js', 'client.js']) {
    const path = join(ROOT, 'lib', file)
    if (existsSync(path)) total += statSync(path).size
  }
  return total
})()
check('lib 体积在合理范围（< 400KB）', libSize < 400 * 1024, `${Math.round(libSize / 1024)}KB`)

// ── 输出 ────────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passes.length} 项`)
if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部检查通过。\n')
