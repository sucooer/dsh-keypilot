/**
 * 并发槽位跟踪（最小连接数负载均衡的基础）。
 *
 * 上游的并发限制往往和速率限制分开计：RPM 没超，但同时在飞的 10 条流可能已经把
 * 连接额度吃满。因此每把密钥要有一个在飞计数，选密钥时优先给最闲的。
 *
 * 这里最需要防的是**计数泄漏**：一条流因为客户端断开、超时或异常而没有走到释放
 * 分支，计数就永远留在那里，这把密钥从此再也不会被选中——表现为「密钥看着正常，
 * 却再也不被使用」，且只有重启才能恢复。三重防护：
 *
 * 1. `acquire()` 返回**幂等的释放函数**，重复调用不会把计数减成负数；
 * 2. 调用方用 `try/finally` 保证正常路径一定释放；
 * 3. 后台 `sweep()` 兜底回收超时占用，即使前两者都失败也能自愈。
 *
 * @module @sucooer/dsh-keypilot/core/concurrency
 */

import { nowMono } from './clock.js'

/** 超过这个时长的在飞记录视为泄漏并回收（5 分钟，远长于任何正常流）。 */
export const DEFAULT_STALE_MS = 5 * 60_000

export class ConcurrencyTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.limit] 每把密钥的并发上限，0 表示不限
   * @param {number} [options.staleMs] 泄漏兜底阈值
   * @param {() => number} [options.now] 单调时钟
   */
  constructor(options = {}) {
    /** @type {() => number} */
    this._now = typeof options.now === 'function' ? options.now : nowMono
    this.limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 0
    this.staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0 ? options.staleMs : DEFAULT_STALE_MS
    /** @type {Map<string, Array<{ id: number, at: number }>>} */
    this._held = new Map()
    this._seq = 0
    this._leaked = 0
  }

  /** @param {number} limit */
  configure(limit) {
    const next = Number(limit)
    this.limit = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0
  }

  /**
   * 取得一个槽位。
   *
   * @param {string} ref 凭据引用名
   * @returns {(() => void) | undefined} 释放函数；返回 `undefined` 表示已满
   */
  acquire(ref) {
    this.sweep()
    const list = this._held.get(ref) ?? []
    if (this.limit > 0 && list.length >= this.limit) return undefined
    const id = ++this._seq
    list.push({ id, at: this._now() })
    this._held.set(ref, list)

    let released = false
    return () => {
      // 幂等：调用方在 finally 里释放，而 sweep 可能已经先回收过这一条。
      if (released) return
      released = true
      this._release(ref, id)
    }
  }

  /** @param {string} ref @param {number} id */
  _release(ref, id) {
    const list = this._held.get(ref)
    if (list === undefined) return
    const index = list.findIndex((entry) => entry.id === id)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) this._held.delete(ref)
  }

  /**
   * 回收超时的在飞记录。
   * @returns {number} 本次回收的条数
   */
  sweep() {
    const now = this._now()
    let reclaimed = 0
    for (const [ref, list] of this._held) {
      const alive = list.filter((entry) => now - entry.at < this.staleMs)
      reclaimed += list.length - alive.length
      if (alive.length === 0) this._held.delete(ref)
      else if (alive.length !== list.length) this._held.set(ref, alive)
    }
    this._leaked += reclaimed
    return reclaimed
  }

  /**
   * 某把密钥当前的在飞数。
   * @param {string} ref
   * @returns {number}
   */
  inFlight(ref) {
    this.sweep()
    return this._held.get(ref)?.length ?? 0
  }

  /** 全部在飞总数。 */
  total() {
    this.sweep()
    let total = 0
    for (const list of this._held.values()) total += list.length
    return total
  }

  /** 累计回收过的泄漏条数（诊断用）。 */
  get leakedCount() {
    return this._leaked
  }

  /** 是否还有空位。 */
  hasCapacity(ref) {
    if (this.limit === 0) return true
    return this.inFlight(ref) < this.limit
  }

  /** 供界面使用的只读快照。 */
  snapshot() {
    this.sweep()
    /** @type {Record<string, number>} */
    const byRef = {}
    for (const [ref, list] of this._held) byRef[ref] = list.length
    return { limit: this.limit, byRef, total: this.total(), leaked: this._leaked }
  }

  /** 清空（测试与热重载用）。 */
  clear() {
    this._held.clear()
  }
}
