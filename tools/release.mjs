/**
 * 按 GitHub 分发的方式发一版：打 tag、推送、建 Release，并打印用户侧该怎么升级。
 *
 * ## 为什么需要它
 *
 * 本插件只通过 GitHub 分发。用户侧的安装规格是
 * `github:<owner>/<repo>#vX.Y.Z`，pnpm 会把解析出的**提交哈希**写进锁文件并缓存——
 * 这意味着发布侧有两个只能靠纪律保证、一旦漏掉就静默失效的前提：
 *
 * 1. `package.json` 的 `version` 必须与 tag 同名。用户看锁文件里的提交、看 tag 列表，
 *    两边对不上时无法判断自己装的是哪一版。
 * 2. tag 必须是**全新的、从不移动的**。复用同一个 tag 时 pnpm 直接从缓存取旧提交，
 *    用户执行了升级命令却仍停在旧代码上，且不会有任何报错。
 *
 * 这两条都由本脚本检查或生成，而不是靠人记住。
 *
 * ```
 * node tools/release.mjs                        # 打 v<package.json version> 并推送
 * node tools/release.mjs --notes <file>         # 用 markdown 文件作为 Release 说明
 * node tools/release.mjs --dry-run              # 只打印将要做什么
 * node tools/release.mjs --no-push              # 只在本机打 tag
 * ```
 *
 * ## 依赖
 *
 * `git` 必需。`gh`（GitHub CLI）可选：装了且已登录就顺带建 Release，没装就只打 tag
 * 并推送，并提示手动建 Release 的方式。绝不为了让脚本跑通而要求额外授权。
 *
 * @module tools/release
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 运行外部命令并返回标准输出；失败时抛出带 stderr 的错误。 */
function run(command, args, { allowFailure = false, inherit = false } = {}) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (allowFailure) return undefined
    // 受限沙箱禁止创建命名管道，任何子进程都会以 EPERM 直接失败。这里不装作是 git 的问题。
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      console.error(`\n无法启动 ${command}（${error.code}）：当前环境不允许创建子进程管道。`)
      console.error('请在普通终端里运行本脚本，或对本命令授予更宽的沙箱权限。')
      process.exit(1)
    }
    const detail = error.stderr?.toString().trim() ?? error.message
    throw new Error(`${command} ${args.join(' ')} 失败：${detail}`)
  }
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { notes: undefined, dryRun: false, noPush: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--notes' || argv[i] === '-n') out.notes = argv[i + 1] ?? ''
    else if (argv[i] === '--dry-run') out.dryRun = true
    else if (argv[i] === '--no-push') out.noPush = true
  }
  return out
}

/** 找出 origin 指向的 GitHub 仓库，形如 `owner/repo`。 */
function resolveGitHubRepo() {
  const url = run('git', ['remote', 'get-url', 'origin'])?.trim()
  if (url === undefined || url.length === 0) return undefined
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url)
  return match === undefined ? undefined : `${match[1]}/${match[2]}`
}

const args = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tag = `v${pkg.version}`

console.log(`包名：${pkg.name}`)
console.log(`版本：${pkg.version} → tag ${tag}`)

// 1. 工作区必须干净：从脏工作区打 tag，release 里的代码与 tag 指向的提交就不是同一份。
const status = run('git', ['status', '--porcelain']) ?? ''
if (status.trim().length > 0) {
  console.error('\n工作区有未提交改动，先提交或 stash 再发布：')
  console.error(status.trimEnd())
  process.exit(1)
}

// 2. tag 已存在就停下。移动已有 tag 会让已安装的用户拿不到新代码（pnpm 按 tag 缓存）。
if (run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true }) !== undefined) {
  console.error(`\ntag ${tag} 已存在。`)
  console.error('要发新版本就先把 package.json 的 version 改大，再重跑本脚本。')
  console.error('不要删掉重建同名 tag —— 已按该 tag 安装的 pnpm 会用缓存里的旧提交。')
  process.exit(1)
}

// 3. 版本号必须往回涨，否则用户无法从数字上判断新旧。
const previous = (run('git', ['tag', '--list', 'v*', '--sort=-v:refname']) ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)[0]
if (previous !== undefined) {
  const compare = (a, b) => {
    const pa = a.replace(/^v/u, '').split('.').map(Number)
    const pb = b.replace(/^v/u, '').split('.').map(Number)
    for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
    return 0
  }
  if (compare(tag, previous) <= 0) {
    console.error(`\n新版本 ${tag} 不大于已有的 ${previous}。`)
    console.error('pnpm 按字符串解析 spec，版本号必须严格递增才能让用户看出该升级。')
    process.exit(1)
  }
  console.log(`上一版：${previous}`)
}

const repo = resolveGitHubRepo()
const message = `${pkg.version} —— ${pkg.description.split('.')[0]}.`

if (args.dryRun) {
  console.log('\n--dry-run，将执行：')
  console.log(`  git tag -a ${tag} -m "<发布说明>"`)
  if (!args.noPush) console.log(`  git push origin ${tag}`)
  console.log('  （若 gh 可用且已登录）gh release create ' + tag)
  process.exit(0)
}

// 4. 打 tag。用附注 tag 而非轻量 tag：git describe 能报出它，也带得住发布说明。
run('git', ['tag', '-a', tag, '-m', message])
console.log(`\n已打 tag ${tag}`)

if (args.noPush) {
  console.log('--no-push：未推送。')
} else {
  run('git', ['push', 'origin', tag], { inherit: true })
  console.log(`已推送 ${tag}`)
}

// 5. Release 是「有没有新版」在 GitHub 上唯一一眼可见的地方。gh 缺失时不阻断发布。
let released = false
if (args.noPush) {
  console.log('\n未推送，跳过建 Release。')
} else if (run('gh', ['--version'], { allowFailure: true }) === undefined) {
  console.log('\n未检测到 gh（GitHub CLI），跳过建 Release。')
  console.log(`手动建：https://github.com/${repo ?? '<owner>/<repo>'}/releases/new?tag=${tag}`)
} else {
  const ghArgs = ['release', 'create', tag, '--title', tag]
  if (args.notes !== undefined && args.notes.length > 0) {
    ghArgs.push('--notes-file', resolve(args.notes))
  } else {
    ghArgs.push('--generate-notes')
  }
  try {
    run('gh', ghArgs, { inherit: true })
    released = true
  } catch {
    console.error('\ngh release create 失败。tag 已经推上去了，可以稍后重试：')
    console.error(`  gh release create ${tag} --title ${tag}${args.notes === undefined ? ' --generate-notes' : ` --notes-file "${args.notes}"`}`)
  }
}

const spec = repo === undefined ? `github:<owner>/<repo>#${tag}` : `github:${repo}#${tag}`
console.log(`\n发布完成${released ? '（已建 Release）' : ''}。`)
console.log('用户侧升级命令（可直接复制给对方）：')
console.log(`  dsh plugin --profile desktop add ${spec}`)
console.log('\n提醒用户：装完要完整退出并重开 DSH —— 插件在宿主进程启动时加载。')
