/**
 * 配额重置窗口。
 *
 * 判断「冷却到什么时候」时，最准的锚点是**上游的配额重置时刻**：很多服务商的日
 * 配额在某个固定时区的午夜清零，而不是从你上次失败起算 24 小时。押对了，密钥在
 * 重置后立刻复活；押错了，要么白等一段，要么提前撞墙。
 *
 * 太平洋时间的处理是这里的经典陷阱：`PST` 不等于 `UTC-8`。洛杉矶一年里有一半时间
 * 用 PDT（UTC-7），把它硬编码成 `-8` 会让重置时刻在夏令时期间整体偏一小时。因此
 * 这里一律通过 `Intl` 的时区数据库换算，绝不写死偏移量。
 *
 * @module @sucooer/dsh-keypilot/core/quota-window
 */

/** 支持的窗口类型。 */
export const QUOTA_WINDOW_TYPES = Object.freeze([
  'midnight_utc',
  'midnight_pst',
  'midnight_local',
  'rolling_24h',
])

/** 各「午夜型」窗口对应的 IANA 时区。 */
const ZONE_BY_TYPE = Object.freeze({
  midnight_utc: 'UTC',
  // 服务商常说的「太平洋时间」指美国西部时间，含夏令时。
  midnight_pst: 'America/Los_Angeles',
})

/** 24 小时。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 求某个 IANA 时区在给定时刻的 UTC 偏移（毫秒）。
 *
 * @param {string} timeZone
 * @param {number} atWall
 * @returns {number} 偏移毫秒（东为正）
 */
export function zoneOffsetMs(timeZone, atWall) {
  if (timeZone === 'UTC') return 0
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    /** @type {Record<string, string>} */
    const parts = {}
    for (const part of formatter.formatToParts(new Date(atWall))) {
      if (part.type !== 'literal') parts[part.type] = part.value
    }
    // en-US 在午夜可能给出 "24" 表示 0 点，取模拉回。
    const hour = Number(parts.hour) % 24
    const asUTC = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second),
    )
    if (!Number.isFinite(asUTC)) return 0
    // 抹掉毫秒：格式化只到秒，否则会引入 <1s 的抖动。
    return asUTC - Math.floor(atWall / 1000) * 1000
  } catch {
    // 该运行时没有这个时区数据时退回 UTC，宁可保守也不要抛。
    return 0
  }
}

/**
 * 求某时区中「下一个当地午夜」对应的 UTC 时间戳。
 *
 * 用两次迭代收敛：先按当前偏移猜一个候选，再用候选时刻的偏移修正。夏令时切换
 * 当天两次偏移不同，第二次迭代即可对上。
 *
 * @param {string} timeZone
 * @param {number} atWall
 * @returns {number}
 */
export function nextMidnightInZone(timeZone, atWall) {
  const offset = zoneOffsetMs(timeZone, atWall)
  // 当地「今天」的日期：把墙钟时刻搬到当地坐标系上，取日期部分。
  const localNow = atWall + offset
  const localDate = new Date(localNow)
  const nextLocalMidnightAsUTC = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate() + 1,
    0, 0, 0, 0,
  )
  // 候选 UTC 时刻（用当前偏移换算）。
  let candidate = nextLocalMidnightAsUTC - offset
  // 用候选时刻的真实偏移再修正一次，处理夏令时切换。
  const correctedOffset = zoneOffsetMs(timeZone, candidate)
  if (correctedOffset !== offset) candidate = nextLocalMidnightAsUTC - correctedOffset
  // 若修正后落到了过去（极端边界），退一步保证返回值在将来。
  if (candidate <= atWall) candidate += DAY_MS
  return candidate
}

/**
 * 归一化窗口配置。
 *
 * @param {unknown} raw 设置里的 `quotaResetWindow`
 * @returns {{ type: string, hour: number, timeZone?: string }}
 */
export function normalizeQuotaWindow(raw) {
  const fallback = { type: 'midnight_utc', hour: 0 }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const type = typeof raw.type === 'string' && QUOTA_WINDOW_TYPES.includes(raw.type) ? raw.type : fallback.type
  const hour = Number.isFinite(Number(raw.hour)) ? Math.min(23, Math.max(0, Math.floor(Number(raw.hour)))) : 0
  /** @type {{ type: string, hour: number, timeZone?: string }} */
  const out = { type, hour }
  if (type === 'midnight_local' && typeof raw.timeZone === 'string' && raw.timeZone.length > 0) {
    out.timeZone = raw.timeZone
  }
  return out
}

/** 取运行时默认时区。 */
export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 下一次配额重置的墙钟时间戳。
 *
 * @param {{ type: string, hour?: number, timeZone?: string } | undefined} window
 * @param {number} [atWall]
 * @returns {number}
 */
export function nextResetAt(window, atWall = Date.now()) {
  const { type, hour, timeZone } = normalizeQuotaWindow(window)
  const zone = ZONE_BY_TYPE[type] ?? (type === 'midnight_local' ? (timeZone ?? systemTimeZone()) : undefined)

  if (type === 'rolling_24h') {
    // 滚动窗口按 epoch 对齐的固定 24 小时栅格推进；没有上游信息时这是最中性的假设。
    return (Math.floor(atWall / DAY_MS) + 1) * DAY_MS
  }

  const midnight = nextMidnightInZone(zone ?? 'UTC', atWall)
  if (hour === 0) return midnight
  // 非零整点：从当地午夜偏移 hour 小时（把小时当当地小时处理，跨夏令时误差可接受）。
  const offset = zoneOffsetMs(zone ?? 'UTC', midnight)
  return midnight + hour * 60 * 60 * 1000 + (zoneOffsetMs(zone ?? 'UTC', midnight + hour * 3600_000) - offset)
}

/**
 * 距下一次配额重置还有多久。
 * @param {Parameters<typeof nextResetAt>[0]} window
 * @param {number} [atWall]
 * @returns {number} 毫秒，最小 0
 */
export function msUntilReset(window, atWall = Date.now()) {
  return Math.max(0, nextResetAt(window, atWall) - atWall)
}

/**
 * 把毫秒格式化成「1h 23m」「45s」这类倒计时文本。
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}
