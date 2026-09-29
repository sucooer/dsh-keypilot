/**
 * 用量账本的测试。
 *
 * 重点：长期运行不能让账本无限增长（compact），以及成本估算只是相对参考。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RETAIN_DAYS,
  UsageLedger,
  dayKey,
  recentDays,
} from '../lib/core/usage.js'
import { estimateCost, formatCost, normalizePriceOverrides, priceFor } from '../lib/core/pricing.js'

/** 固定时钟的账本，便于构造确定的日期。 */
function ledgerAt(ms, options) {
  return new UsageLedger({ ...options, now: () => ms })
}

test('dayKey 产出本地日历的 YYYY-MM-DD', () => {
  const key = dayKey(new Date(2026, 8, 29, 12, 0, 0).getTime())
  assert.equal(key, '2026-09-29')
  assert.match(dayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/)
})

test('记录并汇总请求与 token', () => {
  const now = new Date(2026, 8, 29, 10, 0, 0).getTime()
  const ledger = ledgerAt(now)
  ledger.record({ provider: 'p', ref: 'A', requests: 2, inputTokens: 100, outputTokens: 50, cost: 0.01 })
  ledger.record({ provider: 'p', ref: 'B', requests: 1, inputTokens: 10, outputTokens: 5, cost: 0.001 })
  const totals = ledger.totals()
  assert.equal(totals.requests, 3)
  assert.equal(totals.inputTokens, 110)
  assert.equal(totals.outputTokens, 55)
  assert.ok(Math.abs(totals.cost - 0.011) < 1e-9)
})

test('按提供商聚合', () => {
  const now = Date.now()
  const ledger = ledgerAt(now)
  ledger.record({ provider: 'a', ref: 'A1', requests: 5 })
  ledger.record({ provider: 'b', ref: 'B1', requests: 1 })
  const byProvider = ledger.byProvider()
  assert.deepEqual(byProvider.map((entry) => entry.provider), ['a', 'b'], '按请求数降序')
  assert.equal(byProvider[0].totals.requests, 5)
})

test('按密钥聚合，并可限定单个提供商', () => {
  const now = Date.now()
  const ledger = ledgerAt(now)
  ledger.record({ provider: 'p', ref: 'K1', requests: 3 })
  ledger.record({ provider: 'p', ref: 'K2', requests: 1 })
  ledger.record({ provider: 'q', ref: 'K1', requests: 2 })
  assert.equal(ledger.byKey('p').length, 2)
  assert.equal(ledger.byKey('p')[0].ref, 'K1')
  // 不限提供商时，同名 ref 分属不同服务商，仍然是两把不同的密钥——不该合并。
  const all = ledger.byKey()
  assert.equal(all.length, 3)
  const k1 = all.filter((entry) => entry.ref === 'K1')
  assert.equal(k1.length, 2)
  assert.equal(k1.find((entry) => entry.provider === 'p').totals.requests, 3)
  assert.equal(k1.find((entry) => entry.provider === 'q').totals.requests, 2)
})

test('负数与非法值被当作 0，不会污染账本', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record({ provider: 'p', ref: 'A', requests: -5, inputTokens: Number.NaN, outputTokens: undefined })
  const totals = ledger.totals()
  assert.equal(totals.requests, 0)
  assert.equal(totals.inputTokens, 0)
})

test('省略 provider 时归入 unknown 而不是丢弃', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record({ ref: 'A', requests: 1 })
  assert.equal(ledger.totals().requests, 1)
  assert.equal(ledger.byProvider()[0].provider, '(unknown)')
})

test('畸形条目被忽略', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record(null)
  ledger.record('text')
  ledger.record({})
  assert.equal(ledger.totals().requests, 0)
})

test('compact 丢弃超出保留期的天', () => {
  const day = 24 * 3600_000
  const start = new Date(2026, 8, 1, 12, 0, 0).getTime()
  const ledger = ledgerAt(start)
  for (let i = 0; i < 40; i += 1) {
    ledger.record({ provider: 'p', ref: 'A', requests: 1, at: start + i * day })
  }
  assert.equal(ledger.size, 40)
  const dropped = ledger.compact()
  assert.equal(dropped, 40 - DEFAULT_RETAIN_DAYS)
  assert.equal(ledger.size, DEFAULT_RETAIN_DAYS)
  // 保留的是最近的，不是最早的
  const days = ledger.snapshot().days.map((entry) => entry.day)
  assert.ok(days[0] > days[days.length - 1] === false, '应按时间升序')
  const last = ledger.snapshot().days[days.length - 1].day
  assert.ok(last > days[0])
})

test('compact 在天数未超限时什么都不做', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record({ provider: 'p', ref: 'A', requests: 1 })
  assert.equal(ledger.compact(), 0)
  assert.equal(ledger.size, 1)
})

test('CSV 导出包含表头与明细，且金额可解析', () => {
  const now = Date.now()
  const ledger = ledgerAt(now)
  ledger.record({ provider: 'p', ref: 'A', requests: 2, inputTokens: 100, outputTokens: 20, cost: 0.5 })
  const csv = ledger.toCsv()
  const lines = csv.split('\n')
  assert.match(lines[0], /^day,provider,key,requests/)
  assert.ok(lines.length >= 3, '应有明细行与小计行')
  const cells = lines[1].split(',')
  assert.equal(cells[3], '2', 'requests 列')
  assert.equal(Number(cells[8]), 0.5, 'cost 列')
})

test('CSV 对含逗号的名称做转义', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record({ provider: 'a,b', ref: 'key,1', requests: 1 })
  const csv = ledger.toCsv()
  assert.match(csv, /"a,b"/)
  assert.match(csv, /"key,1"/)
})

test('recentDays 给出升序的日期序列', () => {
  const days = recentDays(3)
  assert.equal(days.length, 3)
  assert.ok(days[0] < days[2])
})

test('快照可被 JSON 序列化（供设置面板使用）', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record({ provider: 'p', ref: 'A', requests: 1 })
  const text = JSON.stringify(ledger.snapshot())
  const parsed = JSON.parse(text)
  assert.equal(parsed.totals.requests, 1)
  assert.equal(parsed.days[0].providers[0].keys[0].ref, 'A')
})

test('clear 清空全部', () => {
  const ledger = ledgerAt(Date.now())
  ledger.record({ provider: 'p', ref: 'A', requests: 1 })
  ledger.clear()
  assert.equal(ledger.size, 0)
  assert.equal(ledger.totals().requests, 0)
})

// ── 成本估算 ────────────────────────────────────────────────────────────────

test('具体条目优先于宽泛条目', () => {
  assert.equal(priceFor('deepseek-reasoner').input, 4)
  assert.equal(priceFor('deepseek-chat').input, 2)
})

test('未知模型走兜底单价并标记为未命中', () => {
  const price = priceFor('totally-unknown-model')
  assert.equal(price.matched, false)
  assert.equal(price.input, 5)
})

test('用户覆盖优先于内置价目', () => {
  const overrides = normalizePriceOverrides({ deepseek: { input: 99, output: 199 } })
  assert.equal(priceFor('deepseek-chat', overrides).input, 99)
})

test('覆盖项按长度优先匹配，避免短条目抢走长条目', () => {
  const overrides = normalizePriceOverrides({
    'gpt': { input: 1, output: 1 },
    'gpt-4o': { input: 50, output: 50 },
  })
  assert.equal(priceFor('gpt-4o', overrides).input, 50)
})

test('非法覆盖项被忽略', () => {
  const overrides = normalizePriceOverrides({
    bad1: { input: 'x', output: 1 },
    bad2: { input: -1, output: 1 },
    bad3: 'not an object',
    good: { input: 3, output: 4 },
  })
  assert.deepEqual(Object.keys(overrides), ['good'])
})

test('estimateCost 按每百万 token 计费', () => {
  // deepseek-chat：输入 2 / 输出 8（每百万，CNY）
  const cost = estimateCost({ model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 1_000_000 })
  assert.ok(Math.abs(cost - 10) < 1e-9)
})

test('缓存读取按折后价计', () => {
  const cost = estimateCost({ model: 'deepseek-chat', cacheReadTokens: 1_000_000 })
  assert.ok(Math.abs(cost - 0.5) < 1e-9)
})

test('estimateCost 对非法输入返回 0', () => {
  assert.equal(estimateCost({}), 0)
  assert.equal(estimateCost({ model: 'x', inputTokens: Number.NaN }), 0)
  assert.equal(estimateCost({ model: 'x', inputTokens: -1000 }), 0)
})

test('formatCost 按量级切换精度', () => {
  assert.equal(formatCost(0), '¥0')
  assert.equal(formatCost(0.005), '¥<0.01')
  assert.equal(formatCost(1.234), '¥1.23')
  assert.equal(formatCost(123.4), '¥123')
  assert.equal(formatCost(Number.NaN), '—')
})
