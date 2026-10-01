/**
 * 把宿主（DSH 安装目录）里的包取到本仓库的 `node_modules`，让插件能按裸名解析它们。
 *
 * ## 为什么需要
 *
 * `lib/runtime/custom-routes.js` 用裸名动态 import 宿主的包
 * （`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-llm`）。
 * 在宿主的进程里这些当然解析得到；但在仓库里跑验证脚本时解析不到，于是
 * `tools/verify-declared-route.mjs` 连宿主接缝都载不进来。
 *
 * ## 为什么不是「链接」
 *
 * 直觉做法是在 `node_modules/@deepseek-ai` 和宿主的同名目录之间建一个
 * junction。但那样只在这两个前提下才成立：宿主的包**都解在磁盘上**，而且
 * 链接的目标**一直有效**。实测两个前提都会破：
 *
 * - 安装目录换过一次之后，仓库里遗留的 junction 指向 `DSH Desktop\...`，
 *   那个路径已经不存在，于是验证脚本连第一行检查都过不去；
 * - 更根本的是，Electron 只会把 `asarUnpack` 规则挑中的包解到磁盘上。本案里
 *   `@earendil-works` 整体都在 `app.asar` 里，磁盘上根本没有这个目录——
 *   链接无从谈起。
 *
 * 所以这里改成**按需复制**：从三个根包出发，按 `dependencies` 递归算出真正
 * 需要的那一小撮包（本机实测 93 个包 / 约 31 MiB），磁盘上有的直接复制，
 * 只在 asar 里的按偏移抽出来。全量 node_modules 是 12,410 文件 / 347 MiB，
 * 没必要为了跑一个验证脚本摊开。
 *
 * 复制而不是链接还有一个好处：`node_modules` 在 `.gitignore` 里，随时可以
 * 整目录删掉重来，不会留下指向不存在路径的死链接。
 *
 * 用法：
 *
 * ```
 * node tools/link-host-modules.mjs
 * node tools/link-host-modules.mjs --dsh-root "C:\Users\me\AppData\Local\Programs\DeepSeek Harness"
 * node tools/link-host-modules.mjs --dsh-root "<...>/resources/app.asar.unpacked/node_modules"
 * node tools/link-host-modules.mjs --refresh      # 忽略已取好的那份，重新取
 * ```
 *
 * @module tools/link-host-modules
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_PACKAGES,
  collectHostPackages,
  findAppAsar,
  hasFileData,
  hasPackage,
  openAsar,
  resolveHostModules,
} from './lib/host-packages.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 落盘的清单，用来判断「已经取好了，不用重来」。 */
const MANIFEST = join(ROOT, 'node_modules', '.dsh-host-packages.json')

/** 安装目录的常见位置，没给 `--dsh-root` 时按顺序试。 */
function defaultRoots() {
  const local = process.env.LOCALAPPDATA
  if (typeof local !== 'string' || local.length === 0) return []
  return [
    join(local, 'Programs', 'DeepSeek Harness'),
    join(local, 'Programs', 'DSH Desktop'),
    join(local, 'Programs', 'dsh'),
  ]
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dsh-root' || argv[i] === '-r') out.root = argv[i + 1] ?? ''
    else if (argv[i] === '--refresh' || argv[i] === '-f') out.refresh = true
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log('用法：node tools/link-host-modules.mjs [--dsh-root "<DSH 安装目录>"] [--refresh]')
  console.log('  --dsh-root 可给安装根目录、resources、app.asar.unpacked、或 node_modules 本身。')
  console.log('  不给则依次尝试 %LOCALAPPDATA%\\Programs\\{DeepSeek Harness,DSH Desktop,dsh}。')
  process.exit(0)
}

/** 尝试候选项，返回第一个找得到的宿主 node_modules。 */
function locateHostModules() {
  const candidates = typeof args.root === 'string' && args.root.length > 0
    ? [args.root]
    : defaultRoots()
  for (const candidate of candidates) {
    const found = resolveHostModules(candidate)
    if (found !== undefined) return { hostModules: found, from: candidate }
  }
  return undefined
}

const located = locateHostModules()
if (located === undefined) {
  const where = typeof args.root === 'string' && args.root.length > 0
    ? `"${args.root}"`
    : defaultRoots().map((p) => `  ${p}`).join('\n')
  console.error(`找不到宿主的 node_modules（应当含有 @deepseek-ai），试过：\n${where}`)
  console.error('提示：给安装目录即可，例如')
  console.error('  node tools/link-host-modules.mjs --dsh-root "%LOCALAPPDATA%\\Programs\\DeepSeek Harness"')
  process.exit(1)
}

const { hostModules, from } = located
console.log(`宿主 node_modules：${hostModules}`)
if (from !== hostModules) console.log(`（由 "${from}" 推出）`)

const appAsar = findAppAsar(hostModules)
if (appAsar === undefined) {
  console.log('未找到 app.asar：只从磁盘取包。宿主的未解包包将不可用。')
} else {
  console.log(`宿主 app.asar：${appAsar}`)
}

if (args.refresh !== true && existsSync(MANIFEST)) {
  const previous = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const intact = REQUIRED_PACKAGES.every((name) => hasPackage(join(ROOT, 'node_modules'), name))
  if (intact && previous.hostModules === hostModules) {
    console.log(`\n已经取好了（${previous.packages} 个包，源 "${previous.hostModules}"）。`)
    console.log('要重新取请加 --refresh。')
    console.log('\n现在可以运行：node tools/verify-declared-route.mjs')
    process.exit(0)
  }
  if (intact && previous.hostModules !== hostModules) {
    console.log(`\n宿主换了位置（"${previous.hostModules}" → "${hostModules}"），重新取。`)
  }
}

const asar = appAsar === undefined ? undefined : openAsar(appAsar)
try {
  const { packages, missing } = collectHostPackages({ hostModules, asar })

  if (missing.length > 0) {
    console.error(`\n宿主的依赖闭包里缺 ${missing.length} 个包：${missing.join(', ')}`)
    console.error('这份 DSH 安装可能不完整，或者版本比本脚本预期的更新。')
    process.exitCode = 1
  }

  const target = join(ROOT, 'node_modules')
  mkdirSync(target, { recursive: true })

  let files = 0
  let bytes = 0
  let unpackedTaken = 0
  /** @type {string[]} */
  const skipped = []
  for (const entry of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const destination = join(target, entry.name)
    removePackageDir(destination)
    if (entry.disk !== undefined) {
      cpSync(entry.disk, destination, { recursive: true })
      console.log(`  复制 ${entry.name} ← ${entry.disk}`)
      continue
    }
    const result = extractNode({
      asar,
      node: entry.node,
      destination,
      unpackedRoot: join(hostModules, '..', '..'),
      packageName: entry.name,
    })
    files += result.files
    bytes += result.bytes
    unpackedTaken += result.unpacked
    skipped.push(...result.skipped)
  }

  writeFileSync(MANIFEST, `${JSON.stringify({
    hostModules,
    appAsar: appAsar ?? null,
    packages: packages.size,
    files,
    bytes,
    takenAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')

  const fromDisk = [...packages.values()].filter((p) => p.disk !== undefined).length
  console.log(`\n完成：${packages.size} 个包（${fromDisk} 个直接复制磁盘上已解包的那份，其余从 app.asar 抽）。`)
  console.log(`从 asar 抽出 ${files - unpackedTaken} 个文件 / ${(bytes / 1048576).toFixed(1)} MiB，其中 ${unpackedTaken} 个取自 app.asar.unpacked。`)
  if (skipped.length > 0) {
    /** @type {Map<string, number>} */
    const byPackage = new Map()
    for (const item of skipped) {
      const name = item.slice(0, item.indexOf('/'))
      byPackage.set(name, (byPackage.get(name) ?? 0) + 1)
    }
    console.log(`跳过 ${skipped.length} 项（asar 里没有数据，app.asar.unpacked 里也没有）：`)
    for (const [name, count] of [...byPackage].slice(0, 10)) console.log(`  ${name}：${count} 项`)
    console.log(`  例：${skipped[0]}`)
  }
  if (process.exitCode !== 1) {
    console.log('\n现在可以运行：node tools/verify-declared-route.mjs')
  }
} finally {
  asar?.close()
}

/**
 * 删掉一个包目录，并保证它真的没了。
 *
 * 这里比 `rmSync(path, { recursive: true, force: true })` 多做了两件事，两件都
 * 是踩出来的：
 *
 * 1. **先摘掉坏链接。** 本仓库历史上用 junction 指向宿主的包，安装目录改名后
 *    那些链接全部悬空。对悬空 junction，Node 的 `lstatSync` 会**跟随**它去问
 *    目标（目标不存在时把整条路径报成普通目录、`isSymbolicLink()` 返回 false），
 *    于是递归删除走进去就 ENOENT；`force` 把错误吞掉，看着像成功，链接却还在。
 *    接着建目录又走同一个坏链接，报出 `mkdir ... ENOENT`——错误信息完全指不到
 *    真正的原因。所以这里用 `existsSync` 判断本路径是否真的可解析，不可解析就在
 *    原地摘掉这个 reparse point（`rmdirSync` 删链接本身，不碰目标）。
 * 2. **建好父目录。** scope 包（`@scope/name`）的父目录就是 scope 目录，第一次
 *    写它时并不存在。
 *
 * @param {string} path
 */
function removePackageDir(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  else if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) rmdirSync(path)
  mkdirSync(dirname(path), { recursive: true })
}

/**
 * 把一个 asar 里的包目录抽到磁盘。
 *
 * `unpacked: true` 的条目不在 asar 数据区，要去 `app.asar.unpacked/` 下的同名
 * 相对路径拿；找不到就记进 `skipped`，不让整次安装失败——少一个二进制文件
 * 通常不影响「验证声明路由」这类纯 JS 校验。
 *
 * @param {object} options
 * @param {object} options.asar
 * @param {object} options.node asar 文件表里的包目录节点
 * @param {string} options.destination 目标包目录
 * @param {string} options.unpackedRoot `app.asar.unpacked` 目录
 * @param {string} options.packageName 用于拼 unpacked 路径
 * @returns {{ files: number, bytes: number, unpacked: number, skipped: string[] }}
 */
function extractNode({ asar, node, destination, unpackedRoot, packageName }) {
  let files = 0
  let bytes = 0
  let unpacked = 0
  /** @type {string[]} */
  const skipped = []
  mkdirSync(destination, { recursive: true })

  /**
   * @param {object} current
   * @param {string} relative 相对包目录的路径，用 `/` 分隔
   */
  const walk = (current, relative) => {
    for (const [name, value] of Object.entries(current.files ?? {})) {
      const path = relative.length === 0 ? name : `${relative}/${name}`
      if (value.files !== undefined) {
        mkdirSync(join(destination, ...path.split('/')), { recursive: true })
        walk(value, path)
        continue
      }
      if (value.link !== undefined) {
        skipped.push(`${packageName}/${path}（链接）`)
        continue
      }
      const filePath = join(destination, ...path.split('/'))
      if (value.unpacked === true) {
        const source = join(unpackedRoot, 'dsh', 'node_modules', ...packageName.split('/'), ...path.split('/'))
        if (existsSync(source)) {
          cpSync(source, filePath)
          files += 1
          bytes += value.size ?? 0
          unpacked += 1
        } else {
          skipped.push(`${packageName}/${path}（unpacked 但源文件不在）`)
        }
        continue
      }
      if (!hasFileData(value)) {
        skipped.push(`${packageName}/${path}（asar 里没有 offset）`)
        continue
      }
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, asar.read(value.offset, value.size))
      files += 1
      bytes += value.size
    }
  }

  walk(node, '')
  return { files, bytes, unpacked, skipped }
}
