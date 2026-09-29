/**
 * 并发槽位的测试。
 *
 * 核心是**泄漏**：一条流异常结束而没释放槽位，这把密钥就会永久变「忙」，
 * 表现成「密钥看着正常但再也不会被选中」。因此这里重点测释放的幂等性与兜底回收。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConcurrencyTracker } from '../lib/core/index.js'

test('limit 为 0 表示不限并发', () => {
  const tracker = new ConcurrencyTracker({ limit: 0 })
  const releases = []
  for (let i = 0; i < 50; i += 1) {
    const release = tracker.acquire('A')
    assert.ok(release !== undefined, '不限并发时不应拒绝')
    releases.push(release)
  }
  assert.equal(tracker.inFlight('A'), 50)
  for (const release of releases) release()
  assert.equal(tracker.inFlight('A'), 0)
})

test('达到上限后拒绝新的获取', () => {
  const tracker = new ConcurrencyTracker({ limit: 2 })
  const a = tracker.acquire('A')
  const b = tracker.acquire('A')
  assert.ok(a !== undefined && b !== undefined)
  assert.equal(tracker.acquire('A'), undefined, '第 3 条应被拒绝')
  assert.equal(tracker.inFlight('A'), 2)
})

test('不同密钥的额度互相独立', () => {
  const tracker = new ConcurrencyTracker({ limit: 1 })
  assert.ok(tracker.acquire('A') !== undefined)
  assert.equal(tracker.acquire('A'), undefined)
  assert.ok(tracker.acquire('B') !== undefined, 'B 的额度不该被 A 占用')
})

test('释放后额度归还', () => {
  const tracker = new ConcurrencyTracker({ limit: 1 })
  const release = tracker.acquire('A')
  assert.equal(tracker.inFlight('A'), 1)
  release()
  assert.equal(tracker.inFlight('A'), 0)
  assert.ok(tracker.acquire('A') !== undefined, '释放后应能再次获取')
})

test('重复释放是幂等的，不会把计数减成负数', () => {
  const tracker = new ConcurrencyTracker({ limit: 5 })
  const release = tracker.acquire('A')
  release()
  release()
  release()
  assert.equal(tracker.inFlight('A'), 0, '重复释放不得让计数变负')

  // 幂等性还必须保证不会误扣其他在飞请求的额度。
  const first = tracker.acquire('A')
  const second = tracker.acquire('A')
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(tracker.inFlight('A'), 2)
  first()
  first()
  assert.equal(tracker.inFlight('A'), 1, '第二次释放已失效，不该动到第二条')
  second()
  assert.equal(tracker.inFlight('A'), 0)
})

test('超时的在飞记录被 sweep 回收（泄漏兜底）', () => {
  let clock = 0
  const tracker = new ConcurrencyTracker({ limit: 1, staleMs: 1000, now: () => clock })
  const release = tracker.acquire('A')
  assert.equal(tracker.acquire('A'), undefined, '未超时时第 2 条应被拒')

  clock = 1500
  // 即使调用方永远没释放，超时兜底也必须把额度还回来，否则这把密钥就废了。
  // acquire 内部会先 sweep，因此这一次应当直接成功。
  const recovered = tracker.acquire('A')
  assert.ok(recovered !== undefined, 'sweep 应已回收超时记录并归还额度')
  assert.equal(tracker.inFlight('A'), 1, '回收后只应有新获取的这一条')
  assert.equal(tracker.leakedCount, 1, '被回收的那条应计入泄漏统计')

  // 迟到的释放是幂等的：它属于已经被回收的记录，不该误动新记录。
  release()
  assert.equal(tracker.inFlight('A'), 1)
  recovered()
  assert.equal(tracker.inFlight('A'), 0)
})

test('sweep 统计泄漏条数供诊断', () => {
  let clock = 0
  const tracker = new ConcurrencyTracker({ limit: 5, staleMs: 100, now: () => clock })
  tracker.acquire('A')
  tracker.acquire('A')
  clock = 500
  assert.equal(tracker.sweep(), 2)
  assert.equal(tracker.leakedCount, 2)
})

test('未超时的记录不会被 sweep 误回收', () => {
  let clock = 0
  const tracker = new ConcurrencyTracker({ limit: 1, staleMs: 1000, now: () => clock })
  tracker.acquire('A')
  clock = 500
  assert.equal(tracker.sweep(), 0)
  assert.equal(tracker.inFlight('A'), 1)
})

test('一个已释放的槽位不会被后来的 sweep 二次回收', () => {
  let clock = 0
  const tracker = new ConcurrencyTracker({ limit: 5, staleMs: 1000, now: () => clock })
  const release = tracker.acquire('A')
  release()
  clock = 5000
  assert.equal(tracker.sweep(), 0, '已释放的记录不该算作泄漏')
})

test('hasCapacity 与 limit 一致', () => {
  const tracker = new ConcurrencyTracker({ limit: 2 })
  assert.equal(tracker.hasCapacity('A'), true)
  tracker.acquire('A')
  tracker.acquire('A')
  assert.equal(tracker.hasCapacity('A'), false)
  // 不限并发时永远有空位
  const unlimited = new ConcurrencyTracker({ limit: 0 })
  for (let i = 0; i < 10; i += 1) unlimited.acquire('B')
  assert.equal(unlimited.hasCapacity('B'), true)
})

test('total 汇总所有密钥的在飞数', () => {
  const tracker = new ConcurrencyTracker({ limit: 5 })
  tracker.acquire('A')
  tracker.acquire('B')
  tracker.acquire('B')
  assert.equal(tracker.total(), 3)
  assert.deepEqual(tracker.snapshot().byRef, { A: 1, B: 2 })
})

test('configure 允许在运行期调整上限', () => {
  const tracker = new ConcurrencyTracker({ limit: 1 })
  assert.equal(tracker.acquire('A') !== undefined, true)
  assert.equal(tracker.acquire('A'), undefined)
  tracker.configure(3)
  assert.ok(tracker.acquire('A') !== undefined, '放宽上限后应立即生效')
})
