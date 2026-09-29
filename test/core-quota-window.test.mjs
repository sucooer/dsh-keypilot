/**
 * 配额窗口的测试。
 *
 * 重点是**夏令时**：把「太平洋时间」硬编码成 UTC-8 是同类实现的常见错误，
 * 它会让重置时刻在夏季整体偏一小时。这里用冬夏两个时间点把正确性钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUOTA_WINDOW_TYPES,
  formatCountdown,
  msUntilReset,
  nextMidnightInZone,
  nextResetAt,
  normalizeQuotaWindow,
  zoneOffsetMs,
} from '../lib/core/index.js'

test('UTC 偏移：冬季是 UTC-8，夏季是 UTC-7', () => {
  const winter = Date.parse('2026-01-15T12:00:00Z')
  const summer = Date.parse('2026-07-15T12:00:00Z')
  assert.equal(zoneOffsetMs('America/Los_Angeles', winter), -8 * 3600_000)
  assert.equal(zoneOffsetMs('America/Los_Angeles', summer), -7 * 3600_000)
  assert.equal(zoneOffsetMs('UTC', winter), 0)
})

test('太平洋时间午夜在夏令时期间按 UTC-7 换算', () => {
  // 2026-07-15 12:00 UTC 当地是 05:00（PDT, UTC-7）
  // → 下一个当地午夜是 07-16 00:00 PDT = 07-16 07:00 UTC
  const from = Date.parse('2026-07-15T12:00:00Z')
  assert.equal(nextMidnightInZone('America/Los_Angeles', from), Date.parse('2026-07-16T07:00:00Z'))
})

test('太平洋时间午夜在冬令时期间按 UTC-8 换算', () => {
  // 2026-01-15 12:00 UTC 当地是 04:00（PST, UTC-8）
  // → 下一个当地午夜是 01-16 00:00 PST = 01-16 08:00 UTC
  const from = Date.parse('2026-01-15T12:00:00Z')
  assert.equal(nextMidnightInZone('America/Los_Angeles', from), Date.parse('2026-01-16T08:00:00Z'))
})

test('UTC 午夜总是对齐到下一个整点日界', () => {
  const from = Date.parse('2026-07-15T12:34:56Z')
  assert.equal(nextMidnightInZone('UTC', from), Date.parse('2026-07-16T00:00:00Z'))
})

test('恰好处于午夜时刻时取下一个午夜而不是当前', () => {
  const atMidnight = Date.parse('2026-07-16T00:00:00Z')
  assert.equal(nextMidnightInZone('UTC', atMidnight), Date.parse('2026-07-17T00:00:00Z'))
})

test('nextResetAt 支持四种窗口类型', () => {
  const from = Date.parse('2026-07-15T12:00:00Z')
  const utc = nextResetAt({ type: 'midnight_utc' }, from)
  assert.equal(utc, Date.parse('2026-07-16T00:00:00Z'))

  const pst = nextResetAt({ type: 'midnight_pst' }, from)
  assert.equal(pst, Date.parse('2026-07-16T07:00:00Z'))

  const local = nextResetAt({ type: 'midnight_local', timeZone: 'Asia/Shanghai' }, from)
  // 上海 UTC+8：当地 20:00 → 下一个当地午夜 = 07-16 00:00 CST = 07-15 16:00 UTC
  assert.equal(local, Date.parse('2026-07-15T16:00:00Z'))

  const rolling = nextResetAt({ type: 'rolling_24h' }, from)
  assert.ok(rolling > from && rolling - from <= 24 * 3600_000)
})

test('midnight_local 在缺省时区时退回系统时区且不抛出', () => {
  const value = nextResetAt({ type: 'midnight_local' }, Date.parse('2026-07-15T12:00:00Z'))
  assert.ok(Number.isFinite(value) && value > 0)
})

test('rolling_24h 对齐到 24 小时栅格', () => {
  const day = 24 * 3600_000
  const from = Date.parse('2026-07-15T12:00:00Z')
  const reset = nextResetAt({ type: 'rolling_24h' }, from)
  assert.equal(reset % day, 0, '应落在 UTC 栅格上')
  assert.ok(reset > from)
})

test('msUntilReset 返回非负值', () => {
  const from = Date.parse('2026-07-15T12:00:00Z')
  const ms = msUntilReset({ type: 'midnight_utc' }, from)
  assert.ok(ms > 0)
  assert.equal(ms, Date.parse('2026-07-16T00:00:00Z') - from)
  // 已过度的时间点不应给出负数
  assert.ok(msUntilReset({ type: 'midnight_utc' }, Date.parse('2030-01-01T00:00:00Z')) >= 0)
})

test('normalizeQuotaWindow 容错并收敛非法值', () => {
  assert.deepEqual(normalizeQuotaWindow(undefined), { type: 'midnight_utc', hour: 0 })
  assert.deepEqual(normalizeQuotaWindow(null), { type: 'midnight_utc', hour: 0 })
  assert.deepEqual(normalizeQuotaWindow('text'), { type: 'midnight_utc', hour: 0 })
  assert.deepEqual(normalizeQuotaWindow({ type: 'nope' }), { type: 'midnight_utc', hour: 0 })
  assert.equal(normalizeQuotaWindow({ type: 'midnight_pst', hour: 99 }).hour, 23)
  assert.equal(normalizeQuotaWindow({ type: 'midnight_pst', hour: -5 }).hour, 0)
  assert.equal(normalizeQuotaWindow({ type: 'midnight_pst', hour: 'x' }).hour, 0)
})

test('normalizeQuotaWindow 保留合法的时区字段', () => {
  const parsed = normalizeQuotaWindow({ type: 'midnight_local', timeZone: 'Asia/Tokyo' })
  assert.equal(parsed.timeZone, 'Asia/Tokyo')
  // 非 local 类型忽略时区字段
  assert.equal(normalizeQuotaWindow({ type: 'midnight_utc', timeZone: 'Asia/Tokyo' }).timeZone, undefined)
})

test('未知时区不会让计算抛出', () => {
  const value = nextMidnightInZone('Not/AZone', Date.parse('2026-07-15T12:00:00Z'))
  assert.ok(Number.isFinite(value), '应退回 UTC 而不是抛')
})

test('窗口类型常量与实现保持一致', () => {
  assert.deepEqual([...QUOTA_WINDOW_TYPES], ['midnight_utc', 'midnight_pst', 'midnight_local', 'rolling_24h'])
})

test('倒计时格式化', () => {
  assert.equal(formatCountdown(0), '0s')
  assert.equal(formatCountdown(45_000), '45s')
  assert.equal(formatCountdown(90_000), '1m 30s')
  assert.equal(formatCountdown(3_600_000), '1h 0m')
  assert.equal(formatCountdown(90_000_000), '1d 1h')
  assert.equal(formatCountdown(-100), '0s')
})
