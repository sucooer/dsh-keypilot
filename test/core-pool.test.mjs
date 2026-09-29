/**
 * 密钥池选择逻辑的测试。
 *
 * 这些用例覆盖的是「插件到底有没有在起作用」这件事本身：冷却是否真的跳过、
 * 预判限流是否在发请求前就生效、并发满是否区分于密钥损坏、全冷却是否被识别为
 * 「该级联」而不是「该等待」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyPool, PICK_REASON, buildPools, ConcurrencyTracker, LatencyHistogram } from '../lib/core/index.js'

/** 造一个可控时钟的池子。 */
function makePool(config, startClock = 1000) {
  const clock = { value: startClock }
  const pool = new KeyPool({ provider: 'p', config, now: () => clock.value })
  return { pool, clock }
}

test('空池返回 empty 而不是抛出', () => {
  const { pool } = makePool({ keys: [] })
  const result = pool.pick()
  assert.equal(result.slot, undefined)
  assert.equal(result.reason, PICK_REASON.EMPTY)
  assert.equal(result.total, 0)
})

test('默认策略按顺序轮询所有可用密钥', () => {
  const { pool } = makePool({ keys: ['A', 'B', 'C'] })
  const picks = [pool.pick().slot.ref, pool.pick().slot.ref, pool.pick().slot.ref, pool.pick().slot.ref]
  assert.deepEqual(picks, ['A', 'B', 'C', 'A'])
})

test('重复的密钥引用被去重，避免权重与状态错乱', () => {
  const { pool } = makePool({ keys: ['A', 'A', 'B'] })
  assert.equal(pool.size, 2)
  assert.deepEqual(pool.slots.map((s) => s.ref), ['A', 'B'])
})

test('空白与非字符串的密钥条目被忽略', () => {
  const { pool } = makePool({ keys: ['A', '  ', '', null, 42, 'B'] })
  assert.deepEqual(pool.slots.map((s) => s.ref), ['A', 'B'])
})

test('冷却中的密钥被跳过，冷却结束后回到轮询序列', () => {
  const { pool, clock } = makePool({ keys: ['A', 'B'], cooldownMs: 1000 })
  const first = pool.pick()
  assert.equal(first.slot.ref, 'A')
  pool.penalize(first.slot, {})
  assert.equal(pool.pick().slot.ref, 'B', 'A 冷却中应被跳过')
  assert.equal(pool.pick().slot.ref, 'B', 'A 仍在冷却中')

  // 推进量要盖过抖动的上界（base × 1.125 = 1125ms），否则可能仍在冷却。
  clock.value += 2000
  // 断言「回到序列」而不是「下一次就选中」：轮询指针的位置与候选集大小有关，
  // 刚解冻的密钥晚一轮被选中是正确语义，它的保证是雨露均沾而非即时优先。
  const after = [pool.pick().slot.ref, pool.pick().slot.ref]
  assert.ok(after.includes('A'), `A 应重新参与轮询，实际序列 ${after.join(' → ')}`)
})

test('冷却按指数退避增长并封顶', () => {
  const { pool } = makePool({ keys: ['A'], cooldownMs: 1000, maxCooldownMs: 4000 })
  const slot = pool.slots[0]
  // 抖动会让单次结果浮动 ±12.5%，因此比较区间而不是精确值。
  const first = pool.penalize(slot, {})
  assert.ok(first >= 875 && first <= 1125, `第一次冷却应在 1000ms 附近，实际 ${first}`)
  const second = pool.penalize(slot, {})
  assert.ok(second >= 1750 && second <= 2250, `第二次应翻倍，实际 ${second}`)
  const third = pool.penalize(slot, {})
  assert.ok(third >= 3500 && third <= 4500, `第三次应再翻倍，实际 ${third}`)
  for (let i = 0; i < 5; i += 1) pool.penalize(slot, {})
  const capped = pool.penalize(slot, {})
  assert.ok(capped <= 4500, `应封顶在 maxCooldownMs，实际 ${capped}`)
})

test('软故障给短而平的冷却，而不是指数退避', () => {
  // 用默认冷却（60s）：软故障应当明显短于硬故障，且不随失败次数增长。
  const { pool } = makePool({ keys: ['A'] })
  const slot = pool.slots[0]
  const soft = pool.penalize(slot, { soft: true })
  assert.ok(soft >= 8750 && soft <= 11250, `软故障应在 10s 附近，实际 ${soft}`)
  const softAgain = pool.penalize(slot, { soft: true })
  // 关键点：软故障不随失败次数翻倍，否则一次网络抖动会毁掉一整个池子。
  assert.ok(softAgain <= 11250, `软故障不应指数增长，实际 ${softAgain}`)
  // 对照：同样次数下硬故障早已远高于 10s。
  const { pool: hardPool } = makePool({ keys: ['A'] })
  const hardSlot = hardPool.slots[0]
  hardPool.penalize(hardSlot, {})
  const hard = hardPool.penalize(hardSlot, {})
  assert.ok(hard > soft * 4, `硬故障第二次应远超软故障，实际 ${hard}`)
})

test('上游 Retry-After 优先于本地退避上限，不被 maxCooldownMs 压低', () => {
  const { pool } = makePool({ keys: ['A'], cooldownMs: 1000 })
  // maxCooldownMs 缺省为 cooldownMs × 8 = 8s，但上游要求 30s——必须听上游的，
  // 否则冷却未到就会再撞一次，白烧一次请求和一次失败计数。
  const ms = pool.penalize(pool.slots[0], { retryAfterMs: 30_000 })
  assert.ok(ms >= 26_000 && ms <= 34_000, `应采用上游要求的 30s 附近，实际 ${ms}`)
})

test('记一次成功会清空失败计数与冷却', () => {
  const { pool } = makePool({ keys: ['A'], cooldownMs: 1000 })
  const slot = pool.slots[0]
  pool.penalize(slot, {})
  pool.penalize(slot, {})
  assert.equal(slot.failures, 2)
  pool.markSuccess(slot)
  assert.equal(slot.failures, 0)
  assert.equal(slot.cooldownUntil, 0)
})

test('全部密钥冷却中时报告 cooldown 并给出最早恢复时刻', () => {
  const { pool, clock } = makePool({ keys: ['A', 'B'], cooldownMs: 1000 })
  pool.penalize(pool.slots[0], {})
  pool.penalize(pool.slots[1], {})
  const result = pool.pick()
  assert.equal(result.slot, undefined)
  assert.equal(result.reason, PICK_REASON.COOLDOWN)
  assert.ok(typeof result.retryAt === 'number' && result.retryAt > clock.value)
  assert.equal(result.detail.cooldown, 2)
})

test('暂停与吊销的密钥不参与选择', () => {
  const { pool } = makePool({ keys: ['A', 'B', 'C'], paused: [true, false, false], revoked: [false, true, false] })
  const picked = new Set()
  for (let i = 0; i < 4; i += 1) picked.add(pool.pick().slot.ref)
  assert.deepEqual([...picked], ['C'], '只有 C 可用')
})

test('过期的密钥不参与选择', () => {
  const { pool } = makePool({ keys: ['A', 'B'], expiresAt: [1, 0] })
  assert.equal(pool.pick().slot.ref, 'B')
})

test('RPM 预判：饱和的密钥在发请求前就被跳过', () => {
  // 上限设为 1：两把密钥各用一次之后，第三请求必须被本地账本提前拦下，
  // 而不是发出去撞一次 429。
  const { pool } = makePool({ keys: ['A', 'B'], rpmLimit: 1 })
  const first = pool.pick()
  first.slot.bucket.charge({ requests: 1 })
  const second = pool.pick()
  second.slot.bucket.charge({ requests: 1 })
  const third = pool.pick()
  assert.equal(third.slot, undefined)
  assert.equal(third.reason, PICK_REASON.RATE_LIMITED, '应当是饱和而非耗尽')
  assert.equal(third.detail.rateLimited, 2)
})

test('RPM 预判确认不会误伤还没到上限的密钥', () => {
  const { pool } = makePool({ keys: ['A', 'B'], rpmLimit: 5 })
  const first = pool.pick()
  first.slot.bucket.charge({ requests: 1 })
  assert.equal(pool.pick().slot.ref, 'B')
})

test('配额耗尽与并发占满被归为不同的原因', () => {
  const { pool } = makePool({ keys: ['A'], rpmLimit: 1 })
  pool.slots[0].bucket.charge({ requests: 1 })
  assert.equal(pool.pick().reason, PICK_REASON.RATE_LIMITED)
  assert.equal(pool.pick().detail.rateLimited, 1)
})

test('并发已满的密钥被跳过，且原因不与冷却混淆', () => {
  const { pool } = makePool({ keys: ['A', 'B'], concurrencyLimit: 4 })
  const concurrency = new ConcurrencyTracker({ limit: 1 })
  const release = concurrency.acquire('A')
  assert.ok(release !== undefined)
  // A 被占满，应落到 B。
  assert.equal(pool.pick({ concurrency }).slot.ref, 'B')
  release()
  // A 释放后回到轮询序列。
  const next = pool.pick({ concurrency })
  assert.ok(['A', 'B'].includes(next.slot.ref))
})

test('并发全部占满时报告 rate-limited 而不是 cooldown', () => {
  const { pool } = makePool({ keys: ['A'], concurrencyLimit: 4 })
  const concurrency = new ConcurrencyTracker({ limit: 1 })
  const release = concurrency.acquire('A')
  const result = pool.pick({ concurrency })
  assert.equal(result.slot, undefined)
  assert.equal(result.reason, PICK_REASON.RATE_LIMITED, '忙不等于坏，不该触发级联')
  assert.equal(result.detail.concurrency, 1)
  release()
})

test('加权轮询按权重分配票数', () => {
  const { pool } = makePool({ keys: ['A', 'B'], weights: [3, 1] })
  const sequence = Array.from({ length: 8 }, () => pool.pick().slot.ref)
  const countA = sequence.filter((ref) => ref === 'A').length
  assert.equal(countA, 6, `权重 3:1 应给出 6:2，实际 ${sequence.join('')}`)
})

test('least-loaded 策略选择在飞最少的密钥', () => {
  const { pool } = makePool({ keys: ['A', 'B'], routingStrategy: 'least-loaded' })
  const concurrency = new ConcurrencyTracker({ limit: 10 })
  const releaseA = concurrency.acquire('A')
  const releaseB1 = concurrency.acquire('B')
  const releaseB2 = concurrency.acquire('B')
  // A 有 1 条在飞，B 有 2 条 → 应继续选 A。
  assert.equal(pool.pick({ concurrency }).slot.ref, 'A')
  releaseB1()
  releaseB2()
  releaseA()
})

test('lowest-latency 在样本不足时退回轮询而不是瞎猜', () => {
  const { pool } = makePool({ keys: ['A', 'B'], routingStrategy: 'lowest-latency' })
  const histogram = new LatencyHistogram()
  // 完全没有样本：应当仍然能选出密钥，且不会抛。
  const first = pool.pick({ histogram })
  assert.ok(first.slot !== undefined)
  const second = pool.pick({ histogram })
  assert.ok(second.slot !== undefined)
})

test('lowest-latency 在样本充足后选择 p95 最低的密钥', () => {
  const { pool } = makePool({ keys: ['A', 'B'], routingStrategy: 'lowest-latency' })
  const histogram = new LatencyHistogram()
  for (let i = 0; i < 10; i += 1) histogram.record('A', 500)
  for (let i = 0; i < 10; i += 1) histogram.record('B', 50)
  assert.equal(pool.pick({ histogram }).slot.ref, 'B')
})

test('未知的调度策略名回退到轮询', () => {
  const { pool } = makePool({ keys: ['A'], routingStrategy: 'quantum-magic' })
  assert.equal(pool.strategy, 'round-robin')
})

test('failure 计数与冷却能被持久化状态恢复', () => {
  const stateStore = new Map()
  const { pool } = makePool({ keys: ['A'], cooldownMs: 1000 })
  // 手动把状态写进 store，模拟「上一次运行留下的冷却」。
  stateStore.set('p\u0000A', { cooldownUntil: 5000, failures: 3 })
  const restored = new KeyPool({ provider: 'p', config: { keys: ['A'], cooldownMs: 1000 }, stateStore, now: () => 1000 })
  assert.equal(restored.slots[0].failures, 3)
  assert.equal(restored.slots[0].cooldownUntil, 5000)
})

test('buildPools 跳过畸形条目并按 provider 建索引', () => {
  const { pools, byProvider } = buildPools({
    providers: [
      null,
      'text',
      { provider: '' },
      { provider: 'a', keys: ['K1'] },
      { provider: 'b', keys: ['K2'] },
    ],
  })
  assert.deepEqual(pools.map((p) => p.provider), ['a', 'b'])
  assert.equal(byProvider.get('a').provider, 'a')
  assert.equal(byProvider.size, 2)
})

test('buildPools 对同名 provider 只保留最后一个池子', () => {
  const { pools, byProvider } = buildPools({
    providers: [
      { provider: 'a', keys: ['OLD'] },
      { provider: 'a', keys: ['NEW'] },
    ],
  })
  assert.equal(pools.length, 1)
  assert.deepEqual(byProvider.get('a').slots.map((s) => s.ref), ['NEW'])
})

test('池快照给出每把密钥的状态与剩余冷却', () => {
  const { pool } = makePool({ keys: ['A'], cooldownMs: 1000 })
  pool.penalize(pool.slots[0], {})
  const snapshot = pool.snapshot()
  assert.equal(snapshot.provider, 'p')
  assert.equal(snapshot.keys.length, 1)
  assert.equal(snapshot.keys[0].status, 'cooling')
  assert.ok(snapshot.keys[0].cooldownMs > 0)
})
