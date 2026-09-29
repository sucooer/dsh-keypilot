/**
 * 用量账本：按天、按提供商、按密钥记录请求数、token 与估算成本。
 *
 * 设计约束只有两条，但都很硬：
 *
 * 1. **长期运行不能无限长胖**。账本按天分桶，超过保留期的桶会被丢弃
 *    （{@link UsageLedger#compact}），否则一个跑了几周的任务会把内存吃光。
 * 2. **只是估算，不是账单**。成本由 {@link module:@sucooer/dsh-keypilot/core/pricing}
 *    的价目表推算，而价目表会随服务商调整。它用来回答「哪把密钥烧得更快」这种
 *    **相对**问题，不能用来对账。
 *
 * @module @sucooer/dsh-keypilot/core/usage
 */

/** 默认保留天数。 */
export const DEFAULT_RETAIN_DAYS = 30

/** 一天的毫秒数（仅用于生成日期键）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 生成一个日期键（本地日期的 YYYY-MM-DD）。
 *
 * 用本地日期而不是 UTC：用户看报表时用自己所在的日历更自然，而「今天」的边界
 * 也要和用户体感一致。
 *
 * @param {number} [at]
 * @returns {string}
 */
export function dayKey(at = Date.now()) {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 一份空白统计。 */
function emptyStats() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    failures: 0,
    switches: 0,
  }
}

/** 把一份统计加到另一份上。 */
function addStats(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += Number(source[key]) || 0
  }
  return target
}

export class UsageLedger {
  /**
   * @param {object} [options]
   * @param {number} [options.retainDays]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.retainDays = Number.isFinite(options.retainDays) && options.retainDays > 0
      ? Math.floor(options.retainDays)
      : DEFAULT_RETAIN_DAYS
    this._now = typeof options.now === 'function' ? options.now : Date.now
    /** @type {Map<string, { totals: object, byProvider: Map<string, { totals: object, byKey: Map<string, object> }> }>} */
    this._days = new Map()
    /** 最近一次压缩丢弃的桶数，供诊断。 */
    this.droppedDays = 0
  }

  /**
   * 取（必要时创建）某一天的桶。
   * @param {string} key
   */
  _day(key) {
    let bucket = this._days.get(key)
    if (bucket === undefined) {
      bucket = { totals: emptyStats(), byProvider: new Map() }
      this._days.set(key, bucket)
    }
    return bucket
  }

  /**
   * 记一次用量。
   *
   * @param {object} entry
   * @param {string} entry.provider
   * @param {string} [entry.ref] 密钥引用名；省略时只按提供商统计
   * @param {number} [entry.requests]
   * @param {number} [entry.inputTokens]
   * @param {number} [entry.outputTokens]
   * @param {number} [entry.cacheReadTokens]
   * @param {number} [entry.cacheWriteTokens]
   * @param {number} [entry.cost]
   * @param {number} [entry.failures]
   * @param {number} [entry.switches]
   * @param {number} [entry.at]
   */
  record(entry) {
    if (entry === null || typeof entry !== 'object') return
    const provider = typeof entry.provider === 'string' ? entry.provider : '(unknown)'
    const bucket = this._day(dayKey(entry.at ?? this._now()))

    const delta = emptyStats()
    delta.requests = Math.max(0, Number(entry.requests) || 0)
    delta.inputTokens = Math.max(0, Number(entry.inputTokens) || 0)
    delta.outputTokens = Math.max(0, Number(entry.outputTokens) || 0)
    delta.cacheReadTokens = Math.max(0, Number(entry.cacheReadTokens) || 0)
    delta.cacheWriteTokens = Math.max(0, Number(entry.cacheWriteTokens) || 0)
    delta.cost = Number.isFinite(Number(entry.cost)) ? Math.max(0, Number(entry.cost)) : 0
    delta.failures = Math.max(0, Number(entry.failures) || 0)
    delta.switches = Math.max(0, Number(entry.switches) || 0)

    addStats(bucket.totals, delta)

    let providerBucket = bucket.byProvider.get(provider)
    if (providerBucket === undefined) {
      providerBucket = { totals: emptyStats(), byKey: new Map() }
      bucket.byProvider.set(provider, providerBucket)
    }
    addStats(providerBucket.totals, delta)

    if (typeof entry.ref === 'string' && entry.ref.length > 0) {
      let keyStats = providerBucket.byKey.get(entry.ref)
      if (keyStats === undefined) {
        keyStats = emptyStats()
        providerBucket.byKey.set(entry.ref, keyStats)
      }
      addStats(keyStats, delta)
    }
  }

  /**
   * 某一天（或全部）的汇总。
   * @param {string} [day]
   * @returns {object}
   */
  totals(day) {
    if (typeof day === 'string') {
      const bucket = this._days.get(day)
      return bucket === undefined ? emptyStats() : { ...bucket.totals }
    }
    const out = emptyStats()
    for (const bucket of this._days.values()) addStats(out, bucket.totals)
    return out
  }

  /**
   * 按提供商聚合。
   * @param {string} [day]
   * @returns {Array<{ provider: string, totals: object }>}
   */
  byProvider(day) {
    /** @type {Map<string, object>} */
    const merged = new Map()
    const buckets = typeof day === 'string'
      ? (this._days.has(day) ? [this._days.get(day)] : [])
      : [...this._days.values()]
    for (const bucket of buckets) {
      if (bucket === undefined) continue
      for (const [provider, providerBucket] of bucket.byProvider) {
        let target = merged.get(provider)
        if (target === undefined) {
          target = emptyStats()
          merged.set(provider, target)
        }
        addStats(target, providerBucket.totals)
      }
    }
    return [...merged.entries()]
      .map(([provider, totals]) => ({ provider, totals }))
      .sort((a, b) => b.totals.requests - a.totals.requests)
  }

  /**
   * 某个提供商下按密钥聚合；省略 provider 时跨提供商合并同名密钥。
   * @param {string} [provider]
   * @param {string} [day]
   * @returns {Array<{ ref: string, provider?: string, totals: object }>}
   */
  byKey(provider, day) {
    /** @type {Map<string, { provider: string, totals: object }>} */
    const merged = new Map()
    const buckets = typeof day === 'string'
      ? (this._days.has(day) ? [this._days.get(day)] : [])
      : [...this._days.values()]
    for (const bucket of buckets) {
      if (bucket === undefined) continue
      for (const [name, providerBucket] of bucket.byProvider) {
        if (typeof provider === 'string' && name !== provider) continue
        for (const [ref, stats] of providerBucket.byKey) {
          const mergeKey = typeof provider === 'string' ? ref : `${name}\u0000${ref}`
          let target = merged.get(mergeKey)
          if (target === undefined) {
            target = { provider: name, totals: emptyStats() }
            merged.set(mergeKey, target)
          }
          addStats(target.totals, stats)
        }
      }
    }
    return [...merged.entries()]
      .map(([key, value]) => ({
        ref: key.includes('\u0000') ? key.slice(key.indexOf('\u0000') + 1) : key,
        provider: value.provider,
        totals: value.totals,
      }))
      .sort((a, b) => b.totals.requests - a.totals.requests)
  }

  /**
   * 丢弃过期的桶。
   * @param {number} [retainDays]
   * @returns {number} 丢弃的桶数
   */
  compact(retainDays) {
    const keep = Number.isFinite(retainDays) && retainDays > 0
      ? Math.floor(retainDays)
      : this.retainDays
    if (this._days.size <= keep) return 0

    // 按日期字符串排序即可：YYYY-MM-DD 的字典序等于时间序。
    const keys = [...this._days.keys()].sort()
    const cutoff = keys.length - keep
    let dropped = 0
    for (let i = 0; i < cutoff; i += 1) {
      this._days.delete(keys[i])
      dropped += 1
    }
    this.droppedDays += dropped
    return dropped
  }

  /** 清空全部。 */
  clear() {
    this._days.clear()
    this.droppedDays = 0
  }

  /** 已记录的天数。 */
  get size() {
    return this._days.size
  }

  /** 导出为可 JSON 化的快照。 */
  snapshot() {
    /** @type {Array<{ day: string, totals: object, providers: Array<object> }>} */
    const days = []
    for (const [day, bucket] of [...this._days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      days.push({
        day,
        totals: { ...bucket.totals },
        providers: [...bucket.byProvider.entries()].map(([provider, providerBucket]) => ({
          provider,
          totals: { ...providerBucket.totals },
          keys: [...providerBucket.byKey.entries()].map(([ref, stats]) => ({ ref, totals: { ...stats } })),
        })),
      })
    }
    return { retainDays: this.retainDays, droppedDays: this.droppedDays, days, totals: this.totals() }
  }

  /**
   * 导出 CSV。
   *
   * 一行一条「天 × 提供商 × 密钥」的明细，方便直接丢进表格软件做透视。
   *
   * @param {number} [days] 最近几天；省略时全部
   * @returns {string}
   */
  toCsv(days) {
    const header = [
      'day', 'provider', 'key',
      'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
      'cost', 'failures', 'switches',
    ]
    const rows = [header.join(',')]
    const snapshot = this.snapshot()
    const limited = Number.isFinite(days) && days > 0 ? snapshot.days.slice(-Math.floor(days)) : snapshot.days
    for (const day of limited) {
      for (const provider of day.providers) {
        for (const key of provider.keys) {
          rows.push([
            day.day,
            csvCell(provider.provider),
            csvCell(key.ref),
            key.totals.requests,
            key.totals.inputTokens,
            key.totals.outputTokens,
            key.totals.cacheReadTokens,
            key.totals.cacheWriteTokens,
            key.totals.cost.toFixed(6),
            key.totals.failures,
            key.totals.switches,
          ].join(','))
        }
        // 也给出每个提供商的小计行（key 列留空），便于不透视也能看总量。
        rows.push([
          day.day,
          csvCell(provider.provider),
          '',
          provider.totals.requests,
          provider.totals.inputTokens,
          provider.totals.outputTokens,
          provider.totals.cacheReadTokens,
          provider.totals.cacheWriteTokens,
          provider.totals.cost.toFixed(6),
          provider.totals.failures,
          provider.totals.switches,
        ].join(','))
      }
    }
    return rows.join('\n')
  }
}

/** 转义 CSV 单元格。 */
function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 按天生成一段日期序列（供界面画趋势图）。
 *
 * @param {number} count
 * @param {number} [at]
 * @returns {string[]}
 */
export function recentDays(count, at = Date.now()) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 7
  /** @type {string[]} */
  const out = []
  for (let i = n - 1; i >= 0; i -= 1) out.push(dayKey(at - i * DAY_MS))
  return out
}
