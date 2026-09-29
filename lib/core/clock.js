/**
 * 时间来源。
 *
 * 冷却、熔断、退避这些**进程内的时长计算**一律用单调时钟：NTP 校时或用户改系统
 * 时间都会让 `Date.now()` 跳变，跳变会让「还剩 30 秒冷却」变成负数或遥遥无期。
 *
 * 但持久化必须用墙钟：单调时钟的零点是进程启动时刻，重启后毫无意义，写进文件
 * 只会让重启后的冷却时间彻底错乱。因此两套时间分开取，且**跨重启的状态一律存
 * 绝对墙钟时间戳**，载入时再换算。
 *
 * @module @sucooer/dsh-keypilot/core/clock
 */

/** 单调时钟（毫秒，进程内有效，用于所有时长计算）。 */
export function nowMono() {
  // Node ≥16 提供全局 performance；退化到 Date.now 只是丢失抗跳变能力，不会崩。
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** 墙钟时间戳（毫秒，用于持久化与展示）。 */
export function nowWall() {
  return Date.now()
}

/**
 * 把「剩余毫秒」换算成墙钟时间戳，用于落盘。
 * @param {number} remainingMs
 * @param {number} [wall]
 * @returns {number}
 */
export function toWallDeadline(remainingMs, wall = nowWall()) {
  return wall + Math.max(0, remainingMs)
}

/**
 * 把落盘的墙钟时间戳换算成「剩余毫秒」。
 *
 * 已过期的返回 0；时钟被往回拨（deadline 在未来很远）时按上限截断，
 * 避免一条损坏的记录把密钥永久锁死。
 *
 * @param {number} deadline 墙钟时间戳
 * @param {number} [wall]
 * @param {number} [capMs] 上限
 * @returns {number}
 */
export function fromWallDeadline(deadline, wall = nowWall(), capMs = 24 * 60 * 60 * 1000) {
  if (!Number.isFinite(deadline)) return 0
  const delta = deadline - wall
  if (delta <= 0) return 0
  return Math.min(delta, capMs)
}
