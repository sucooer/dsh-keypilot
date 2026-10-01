/**
 * 宿主包的接缝：定位 DSH 安装目录，并把插件开发期需要的宿主包取到仓库里。
 *
 * ## 为什么需要
 *
 * `lib/runtime/custom-routes.js` 用裸名动态 import 宿主的三个包
 * （`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-llm`）。
 * 在宿主的进程里这些当然解析得到；从仓库里跑验证脚本时解析不到。
 *
 * 而它们**通常不在磁盘上**——只有被 `asarUnpack` 规则挑中的包才会解到
 * `resources/app.asar.unpacked/`，其余全在 `resources/app.asar` 里面。
 * 本模块负责三件事：
 *
 * 1. `resolveHostModules()`：从用户给的位置（安装根目录 / `resources` /
 *    `app.asar.unpacked` / `node_modules` 本身）推出宿主的 node_modules；
 * 2. `openAsar()`：读 asar 的文件表，按 `offset` + `size` 取出任意一个文件；
 * 3. `collectHostPackages()`：从三个根包出发，按 `dependencies` 递归算出
 *    真正需要的那一小撮包（本机实测 93 个包 / 约 31 MiB，而不是全量 347 MiB）。
 *
 * 递归里有一处必须与 Node 的解析顺序一致：**先在包的嵌套 `node_modules`
 * 里找，再回到宿主顶层找**。宿主的所有包共用一份扁平安装，但 pi-ai 就带了
 * 自己的嵌套依赖（`https-proxy-agent`），漏掉这一步会把它解析成「缺失」。
 *
 * @module tools/lib/host-packages
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 声明路由真正依赖的三个宿主包，缺一不可。 */
export const REQUIRED_PACKAGES = Object.freeze([
  '@earendil-works/pi-ai',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
])

/** Electron 的 asar 头：16 字节定长 prefix + JSON 文件表。 */
const ASAR_HEADER_PREFIX = 16

/**
 * 从用户给的位置推出宿主的 `node_modules`。
 *
 * 五种常见输入都要接受，用户不必知道目录层级：
 *
 * - 安装根目录（`...\Programs\DeepSeek Harness`）
 * - `resources` 目录
 * - `resources\app.asar.unpacked`
 * - `resources\app.asar.unpacked\dsh`
 * - `node_modules` 本身
 *
 * @param {string} input
 * @returns {string | undefined} 找到的 node_modules 绝对路径
 */
export function resolveHostModules(input) {
  const candidates = [
    input,
    join(input, 'node_modules'),
    join(input, 'resources', 'app.asar.unpacked', 'node_modules'),
    join(input, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'),
    join(input, 'app.asar.unpacked', 'node_modules'),
    join(input, 'app.asar.unpacked', 'dsh', 'node_modules'),
  ]
  return candidates.find((candidate) => isNodeModules(candidate))
}

/**
 * 一个目录看起来像宿主的 node_modules 吗？
 *
 * 判据是「含有 @deepseek-ai 作用域」——DSH 自己的包必然在里面。
 * 注意不能只判目录存在：安装目录底下也有个 `node_modules`（Electron 自己的）。
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isNodeModules(candidate) {
  try {
    return statSync(join(candidate, '@deepseek-ai')).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从宿主 node_modules 往上找 `app.asar`。
 *
 * `app.asar` 与 `app.asar.unpacked` 并排放在 `resources/` 下，所以从
 * `<...>/app.asar.unpacked/dsh/node_modules` 出发要往上走三层。
 *
 * @param {string} hostModules
 * @returns {string | undefined}
 */
export function findAppAsar(hostModules) {
  let current = hostModules
  for (let depth = 0; depth < 5; depth += 1) {
    current = join(current, '..')
    const candidate = join(current, 'app.asar')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 打开 asar，返回一个按文件表随机读取的句柄。
 *
 * 文件数据的定位公式（Electron 的 pickle 布局，实测确认）：
 *
 * ```
 * 数据起点 = 16 + readUInt32LE(12) + node.offset
 * ```
 *
 * 头 16 字节里前 8 个是 pickle 的长度字段，真正承载文件表的是第 12 字节处
 * 的 u32（本机 = 3,392,048），JSON 从第 16 字节开始。`node.offset` 已经是
 * 相对数据起点的偏移，**不要**再加 8。
 *
 * @param {string} asarPath
 * @returns {{ header: object, read(offset: number, size: number): Buffer, close(): void }}
 */
export function openAsar(asarPath) {
  const fd = openSync(asarPath, 'r')
  const prefix = Buffer.alloc(ASAR_HEADER_PREFIX)
  readSync(fd, prefix, 0, ASAR_HEADER_PREFIX, 0)
  const headerSize = prefix.readUInt32LE(12)
  const headerBytes = Buffer.alloc(headerSize)
  readSync(fd, headerBytes, 0, headerSize, ASAR_HEADER_PREFIX)
  const header = JSON.parse(headerBytes.toString('utf8'))
  const dataStart = ASAR_HEADER_PREFIX + headerSize

  return {
    header,
    /**
     * 读一段文件数据。
     *
     * `offset` 在文件表里是**字符串**（asar 的 offset 可以超过 Number 的精确
     * 表示范围，所以序列化成了十进制字符串），这里统一转成数字。
     *
     * @param {number | string} offset `node.offset`
     * @param {number} size 字节数
     * @returns {Buffer}
     */
    read(offset, size) {
      const buffer = Buffer.alloc(size)
      readSync(fd, buffer, 0, size, dataStart + Number(offset))
      return buffer
    },
    close() {
      closeQuietly(fd)
    },
  }
}

/**
 * 一个 asar 条目是否有可读的文件数据。
 *
 * 目录条目没有 `offset`；`unpacked: true` 的条目只有 `size`，数据在
 * `app.asar.unpacked/` 下。两种情况都不能按 offset 读。
 *
 * @param {object | undefined} entry
 * @returns {boolean}
 */
export function hasFileData(entry) {
  return entry !== undefined && entry.offset !== undefined
}

/**
 * asar 里 `dsh/node_modules` 这一层。
 *
 * @param {object} asar {@link openAsar} 的结果
 * @returns {object | undefined}
 */
export function hostTree(asar) {
  return asar.header?.files?.dsh?.files?.node_modules?.files
}

/**
 * 在 asar 文件表里找一个包目录。
 *
 * @param {object} asar
 * @param {string} packageName 例如 `@deepseek-ai/dsh-llm`
 * @returns {object | undefined}
 */
export function lookupAsarPackage(asar, packageName) {
  const tree = hostTree(asar)
  if (tree === undefined) return undefined
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/')
    return tree[scope]?.files?.[name]
  }
  return tree[packageName]
}

/**
 * 在包的嵌套 `node_modules` 里找依赖。
 *
 * @param {object} packageNode
 * @param {string} dep
 * @returns {object | undefined}
 */
function lookupNested(packageNode, dep) {
  const nested = packageNode?.files?.node_modules?.files
  if (nested === undefined) return undefined
  if (dep.startsWith('@')) {
    const [scope, name] = dep.split('/')
    return nested[scope]?.files?.[name]
  }
  return nested[dep]
}

/**
 * 算出三个根包真正需要的宿主包集合。
 *
 * 每个条目的 `disk` / `node` 说明「从哪里取」：`disk` 非空表示这个包被
 * asarUnpack 解到了磁盘上，直接复制；否则用 `node` 按 offset 从 asar 里抽。
 *
 * 解析顺序与 Node 一致：先嵌套，再顶层。顶层优先取磁盘上的
 * `node_modules/<name>`，因为那正是宿主运行期用的那一份。
 *
 * @param {object} options
 * @param {string} options.hostModules 宿主的 node_modules
 * @param {object | undefined} options.asar {@link openAsar} 的结果，没装 asar 时可为空
 * @returns {{ packages: Map<string, object>, missing: string[], unpackedFiles: string[] }}
 */
export function collectHostPackages({ hostModules, asar }) {
  /** @type {Map<string, object>} */
  const packages = new Map()
  /** @type {Set<string>} */
  const missing = new Set()
  /** @type {Set<string>} */
  const unpackedFiles = new Set()
  /** @type {Array<{ name: string, node: object | undefined, disk: string | undefined }>} */
  const queue = REQUIRED_PACKAGES.map((name) => ({ name, node: undefined, disk: join(hostModules, name) }))

  while (queue.length > 0) {
    const item = queue.shift()
    if (packages.has(item.name)) continue

    const disk = item.disk !== undefined && existsSync(join(item.disk, 'package.json')) ? item.disk : undefined
    // 队列里的 `node` 是显式 undefined（嵌套里没找到），所以这里不能写 `item.node ?? ...`。
    const node = item.node !== undefined
      ? item.node
      : (asar === undefined ? undefined : lookupAsarPackage(asar, item.name))
    if (disk === undefined && node === undefined) {
      missing.add(item.name)
      continue
    }

    const manifest = readManifest({ disk, node, asar })
    if (manifest === undefined) {
      missing.add(item.name)
      continue
    }

    packages.set(item.name, { name: item.name, version: manifest.version, disk, node })
    if (node !== undefined) collectUnpacked(node, unpackedFiles)

    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (typeof dep !== 'string') continue
      if (packages.has(dep)) continue
      const nested = lookupNested(node, dep)
      if (nested !== undefined && nested.files !== undefined) {
        queue.push({ name: dep, node: nested, disk: undefined })
        continue
      }
      const nestedDisk = disk === undefined ? undefined : join(disk, 'node_modules', dep)
      const topDisk = join(hostModules, dep)
      queue.push({
        name: dep,
        node: undefined,
        disk: nestedDisk !== undefined && existsSync(join(nestedDisk, 'package.json'))
          ? nestedDisk
          : (existsSync(join(topDisk, 'package.json')) ? topDisk : undefined),
      })
    }
  }

  return { packages, missing: [...missing].sort(), unpackedFiles: [...unpackedFiles].sort() }
}

/**
 * 读一个包的 package.json。
 *
 * 磁盘上的优先——宿主运行期用的就是那一份，asar 里的可能与它不同步。
 *
 * @param {{ disk?: string, node?: object, asar?: object }} options
 * @returns {object | undefined}
 */
function readManifest({ disk, node, asar }) {
  try {
    if (disk !== undefined) return JSON.parse(readFileSync(join(disk, 'package.json'), 'utf8'))
    const entry = node?.files?.['package.json']
    if (entry === undefined || asar === undefined) return undefined
    if (!hasFileData(entry)) return undefined
    return JSON.parse(asar.read(entry.offset, entry.size).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 收集一个包目录里 `unpacked: true` 的文件。
 *
 * 这些文件不在 asar 数据区里，要去 `app.asar.unpacked/` 同名路径取。
 *
 * @param {object} node
 * @param {Set<string>} into
 * @param {string} prefix
 */
function collectUnpacked(node, into, prefix = '') {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix.length === 0 ? name : `${prefix}/${name}`
    if (value.files !== undefined) collectUnpacked(value, into, path)
    else if (value.unpacked === true) into.add(path)
  }
}

/**
 * 判断一个目录是否包含某个包（用于 workspace 里 `node_modules` 的自检）。
 *
 * @param {string} nodeModules
 * @param {string} packageName
 * @returns {boolean}
 */
export function hasPackage(nodeModules, packageName) {
  return existsSync(join(nodeModules, packageName, 'package.json'))
}

/** 关文件描述符，失败就算了（不外抛，避免掩盖真正的错）。 */
function closeQuietly(fd) {
  try {
    closeSync(fd)
  } catch {
    // 已经关了就算了。
  }
}
