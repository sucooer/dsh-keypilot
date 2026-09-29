/**
 * 运行期状态存储与持久化。
 *
 * 有两类状态必须活过「设置重载」：
 *
 * 1. **健康状态**（冷却截止、失败计数、用量统计）——用户改一下 RPM 上限不该让
 *    所有密钥的冷却凭空消失；
 * 2. **轮询指针**——重载后从同一个位置继续，而不是每次都从第一把密钥开始。
 *
 * 因此配置（`providers` 数组）与状态（本模块）分开：前者每次变更都重建，后者
 * 以 `provider\0ref` 为键长期保留。
 *
 * 落盘是可选的，且**失败不影响运行**：状态文件损坏、磁盘只读、目录不存在，
 * 都只让持久化静默退化为内存态，绝不能让插件因此起不来。
 *
 * @module @sucooer/dsh-keypilot/runtime/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 状态文件的默认位置（相对 DSH_HOME）。 */
export const STATE_FILE_NAME = 'keypilot-state.json'

/** 落盘的最小间隔：健康状态变化很频繁，不能每变一次就写盘。 */
export const DEFAULT_PERSIST_DEBOUNCE_MS = 5000

/**
 * 解析 DSH 的家目录。
 *
 * 优先用环境变量（这是宿主的约定），退化到用户主目录下的 `.dsh`，让插件在
 * 没有该环境变量的场合也能落盘。
 *
 * @returns {string}
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.trim().length > 0) return join(home.trim(), '.dsh')
  return process.cwd()
}

/** 状态文件的键：provider 与 ref 之间用不可见字符分隔，避免与 ref 内容冲突。 */
export function stateKey(provider, ref) {
  return `${provider}\u0000${ref}`
}

/**
 * 运行期状态仓库。
 *
 * 提供 `Map` 接口（`KeyPool` 直接把它当 stateStore 用），额外负责节流落盘。
 */
export class StateStore {
  /**
   * @param {object} [options]
   * @param {string} [options.file] 状态文件路径；空字符串表示不落盘
   * @param {number} [options.debounceMs] 落盘节流间隔
   * @param {(message: string) => void} [options.warn] 诊断输出
   */
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this._map = new Map()
    /** @type {Map<string, number>} */
    this._cursors = new Map()
    this.file = typeof options.file === 'string' ? options.file : ''
    this.debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0
      ? options.debounceMs
      : DEFAULT_PERSIST_DEBOUNCE_MS
    this._warn = typeof options.warn === 'function' ? options.warn : () => {}
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this._timer = undefined
    this._dirty = false
  }

  /**
   * 载入状态文件。
   *
   * 任何异常都被吞掉并仅作诊断：一个损坏的状态文件最多让冷却从零开始，
   * 但绝不该阻止插件加载。
   *
   * @param {string} [file]
   * @returns {boolean} 是否成功载入了内容
   */
  load(file = this.file) {
    if (file.length === 0) return false
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      // 首次运行没有状态文件，是完全正常的路径。
      return false
    }
    try {
      const parsed = JSON.parse(raw)
      // 必须是普通对象：数组、字符串、数字都是「文件被别的东西覆盖了」的信号，
      // 静默当作空状态比让人以为「状态还在」更安全。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      const slots = parsed.slots
      if (slots !== null && typeof slots === 'object') {
        for (const [key, value] of Object.entries(slots)) {
          if (value !== null && typeof value === 'object') this._map.set(key, value)
        }
      }
      const cursors = parsed.cursors
      if (cursors !== null && typeof cursors === 'object') {
        for (const [key, value] of Object.entries(cursors)) {
          const num = Number(value)
          if (Number.isFinite(num) && num >= 0) this._cursors.set(key, num)
        }
      }
      return true
    } catch (error) {
      this._warn(`状态文件无法解析，已忽略并从空状态开始：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Map 兼容：读。 */
  get(key) {
    return this._map.get(key)
  }

  /** Map 兼容：写，并标记需要落盘。 */
  set(key, value) {
    this._map.set(key, value)
    this._markDirty()
  }

  /** Map 兼容：判断存在。 */
  has(key) {
    return this._map.has(key)
  }

  /** Map 兼容：删除。 */
  delete(key) {
    this._map.delete(key)
    this._markDirty()
  }

  /** 轮询指针（与健康状态分开存放，避免被逐槽遍历影响）。 */
  cursorOf(provider) {
    return this._cursors.get(provider) ?? 0
  }

  /** 记录轮询指针。 */
  setCursor(provider, value) {
    const num = Number(value)
    if (!Number.isFinite(num) || num < 0) return
    this._cursors.set(provider, num)
    this._markDirty()
  }

  /**
   * 清掉已不在配置里的条目，防止长期运行后文件无限增长。
   * @param {Set<string>} liveKeys 当前仍有效的键集合
   * @returns {number} 清理条数
   */
  prune(liveKeys) {
    let removed = 0
    for (const key of [...this._map.keys()]) {
      if (!liveKeys.has(key)) {
        this._map.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this._markDirty()
    return removed
  }

  /** 标记有变更，并安排一次节流落盘。 */
  _markDirty() {
    this._dirty = true
    if (this.file.length === 0 || this._timer !== undefined) return
    this._timer = setTimeout(() => {
      this._timer = undefined
      this.flush()
    }, this.debounceMs)
    // 定时器不该拖着进程不退出。
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  /**
   * 立即落盘。
   *
   * 用「写临时文件 + 重命名」而不是直接覆盖：重命名在同一文件系统上是原子的，
   * 因此中途崩溃或断电不会留下一个半截的 JSON——那会让下次启动丢掉全部状态。
   *
   * @returns {boolean} 是否写入成功
   */
  flush() {
    if (this.file.length === 0) return false
    if (!this._dirty) return true
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload = JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        slots: Object.fromEntries(this._map),
        cursors: Object.fromEntries(this._cursors),
      })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, this.file)
      this._dirty = false
      return true
    } catch (error) {
      // 落盘失败只影响「重启后是否记住」这一个小功能，不值得打断用户。
      this._dirty = false
      this._warn(`状态落盘失败（不影响本次运行）：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 取消挂起的落盘并做一次最终写入。 */
  dispose() {
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    this.flush()
    // 清理临时文件：正常路径下 rename 已经把它搬走了，这里兜底极端情况。
    if (this.file.length > 0) {
      try {
        unlinkSync(`${this.file}.tmp`)
      } catch {
        // 不存在就是正常情况。
      }
    }
  }

  /** 条目数，供诊断。 */
  get size() {
    return this._map.size
  }
}

/**
 * 建一个状态仓库并尝试载入既有内容。
 *
 * @param {object} [options]
 * @param {string} [options.file] 显式路径；缺省时落在 DSH_HOME 下
 * @param {boolean} [options.enabled] 是否启用持久化
 * @param {(message: string) => void} [options.warn]
 * @returns {StateStore}
 */
export function createStateStore(options = {}) {
  const enabled = options.enabled !== false
  const file = !enabled
    ? ''
    : (typeof options.file === 'string' && options.file.trim().length > 0
      ? options.file.trim()
      : join(resolveDshHome(), STATE_FILE_NAME))
  const store = new StateStore({ file, warn: options.warn })
  if (file.length > 0) store.load(file)
  return store
}
