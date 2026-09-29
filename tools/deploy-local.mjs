/**
 * 把工作区里的插件同步到某个 DSH profile —— 本地开发时的快速生效通道。
 *
 * ## 为什么需要它
 *
 * 常规做法 `dsh plugin --profile <p> add link:<path>` 在本机不可用：pnpm 生成的相对
 * 符号链接层级算错（链接悬空）；即使换成绝对路径的 junction，Windows 也会以
 * `os error 448 (ERROR_UNTRUSTED_MOUNT_POINT)` 拒绝遍历。
 *
 * 退一步用 `npm pack` + `dsh plugin add <tgz>` 能装上，但**同版本号不会更新**——
 * pnpm 看到 lockfile 里已存在 `0.1.0` 就跳过解包，改完代码也不会生效。每次
 * 改版本号再打包又太琐碎。
 *
 * 因此本地开发阶段直接把文件同步进 `node_modules`：
 *
 * ```
 * node tools/deploy-local.mjs --profile web
 * ```
 *
 * 之后用 patch 覆盖层加载（不动 profile 的插件清单）：
 *
 * ```
 * dsh --profile web --patch ./verify-overlay.cordis.yml --port 34567 --no-open
 * ```
 *
 * 发布时仍然走 `npm pack`，本脚本只是开发期通道。
 *
 * @module tools/deploy-local
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析 DSH 的家目录。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.trim().length > 0) return join(home.trim(), '.dsh')
  throw new Error('无法确定 DSH_HOME，请设置环境变量或传入 --home')
}

/** 递归复制目录。 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else copyFileSync(source, target)
  }
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile' || argv[i] === '-p') out.profile = argv[i + 1] ?? ''
    else if (argv[i] === '--home') out.home = argv[i + 1] ?? ''
    else if (argv[i] === '--package' || argv[i] === '-n') out.package = argv[i + 1] ?? ''
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.profile === undefined || args.profile.length === 0) {
  console.error('用法：node tools/deploy-local.mjs --profile <name> [--home <dsh-home>]')
  process.exit(1)
}

const pkg = JSON.parse(
  (await import('node:fs')).readFileSync(join(ROOT, 'package.json'), 'utf8'),
)
const packageName = args.package ?? pkg.name

const home = args.home ?? resolveDshHome()
const target = join(home, 'profiles', args.profile, 'node_modules', ...packageName.split('/'))

if (!existsSync(join(home, 'profiles', args.profile))) {
  console.error(`profile 不存在：${join(home, 'profiles', args.profile)}`)
  process.exit(1)
}

// 只同步「会真正产出的东西」：源码目录 + 宿主读取的清单文件。
// 不复制 test/、node_modules、临时文件。
const published = ['lib', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md', 'LICENSE']

let copied = 0
mkdirSync(target, { recursive: true })
for (const entry of published) {
  const source = join(ROOT, entry)
  if (!existsSync(source)) continue
  const dest = join(target, entry)
  if (statSync(source).isDirectory()) {
    rmSync(dest, { recursive: true, force: true })
    copyDir(source, dest)
  } else {
    copyFileSync(source, dest)
  }
  copied += 1
}

// 校验：入口文件必须与工作区一致，否则「以为同步了其实没有」会浪费一整轮调试。
const mainTarget = join(target, pkg.main)
const same = existsSync(mainTarget)
  && (await import('node:fs')).readFileSync(mainTarget, 'utf8')
    === (await import('node:fs')).readFileSync(join(ROOT, pkg.main), 'utf8')

console.log(`已同步 ${copied} 项 → ${target}`)
console.log(`入口一致性校验：${same ? '通过' : '失败（内容不一致）'}`)
if (!same) process.exit(1)
