/**
 * 退避、抖动与熔断状态机的测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSOLUTE_MAX_COOLDOWN_MS,
  CircuitBreaker,
  computeBackoff,
  decayPenalty,
  jitter,
} from '../lib/core/index.js'

test('抖动落在 ±ratio 区间内', () => {
  const low = jitter(1000, 0.125, () => 0)
  const high = jitter(1000, 0.125, () => 0.999999)
  assert.ok(low >= 875 && low <= 1000, `实际 ${low}`)
  assert.ok(high <= 1125 && high >= 1000, `实际 ${high}`)
})

test('抖动在随机源返回越界值时不产生负时长', () => {
  assert.equal(jitter(1000, 0.5, () => 5), 1500)
  assert.ok(jitter(1000, 0.5, () => -3) >= 0)
  assert.ok(jitter(1000, 0.125, () => Number.NaN) >= 0)
})

test('抖动对 0 与非法输入返回 0', () => {
  assert.equal(jitter(0), 0)
  assert.equal(jitter(-100), 0)
  assert.equal(jitter(Number.NaN), 0)
})

test('指数退避逐次翻倍并封顶在 ×8', () => {
  const opts = { baseMs: 1000, random: () => 0.5 }
  assert.equal(computeBackoff({ ...opts, attempt: 1 }), 1000)
  assert.equal(computeBackoff({ ...opts, attempt: 2 }), 2000)
  assert.equal(computeBackoff({ ...opts, attempt: 3 }), 4000)
  assert.equal(computeBackoff({ ...opts, attempt: 4 }), 8000)
  assert.equal(computeBackoff({ ...opts, attempt: 9 }), 8000, '乘数封顶在 ×8')
})

test('显式的 maxMs 优先于默认倍数', () => {
  const ms = computeBackoff({ baseMs: 1000, maxMs: 3000, attempt: 5, random: () => 0.5 })
  assert.equal(ms, 3000)
})

test('软故障使用固定的平缓冷却且不随次数增长', () => {
  const opts = { baseMs: 60_000, random: () => 0.5 }
  const first = computeBackoff({ ...opts, soft: true, attempt: 1 })
  const tenth = computeBackoff({ ...opts, soft: true, attempt: 10 })
  assert.equal(first, 10_000)
  assert.equal(tenth, 10_000, '软故障不该指数增长')
})

test('软故障冷却仍受 maxMs 约束', () => {
  const ms = computeBackoff({ baseMs: 1000, maxMs: 5000, soft: true, attempt: 1, random: () => 0.5 })
  assert.equal(ms, 5000, '用户显式设的上限应当生效')
})

test('Retry-After 优先且不被 maxMs 压低', () => {
  // 这是关键行为：上游说 30s，本地 maxMs 只有 8s，也必须听上游的。
  const ms = computeBackoff({ baseMs: 1000, maxMs: 8000, retryAfterMs: 30_000, attempt: 1, random: () => 0.5 })
  assert.equal(ms, 30_000)
})

test('Retry-After 受绝对上限保护，挡住病态值', () => {
  const ms = computeBackoff({ baseMs: 1000, retryAfterMs: 90 * 24 * 3600_000, attempt: 1, random: () => 0.5 })
  assert.equal(ms, ABSOLUTE_MAX_COOLDOWN_MS)
})

test('惩罚衰减按运行时长逐级降低失败计数', () => {
  assert.equal(decayPenalty(5, { perHour: 1, elapsedMs: 3_600_000 }), 4)
  assert.equal(decayPenalty(5, { perHour: 2, elapsedMs: 3_600_000 }), 3)
  assert.equal(decayPenalty(5, { perHour: 1, elapsedMs: 30 * 60_000 }), 5, '不足一档时不衰减')
  assert.equal(decayPenalty(5, { perHour: 10, elapsedMs: 3_600_000 }), 0, '下限为 0')
})

test('无失败计数时衰减是空操作', () => {
  assert.equal(decayPenalty(0, { elapsedMs: 999_999_999 }), 0)
})

test('熔断器初始为 closed', () => {
  const breaker = new CircuitBreaker({ threshold: 3 })
  assert.equal(breaker.state('p'), 'closed')
  assert.equal(breaker.canAttempt('p'), true)
})

test('连续失败到阈值后打开', () => {
  const breaker = new CircuitBreaker({ threshold: 3, openMs: 1000 })
  breaker.onFailure('p')
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'closed', '未到阈值不该打开')
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'open')
  assert.equal(breaker.canAttempt('p'), false)
})

test('一次成功清零计数，不会累积到阈值', () => {
  const breaker = new CircuitBreaker({ threshold: 3 })
  breaker.onFailure('p')
  breaker.onFailure('p')
  breaker.onSuccess('p')
  breaker.onFailure('p')
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'closed', '成功应打断累积')
})

test('openMs 到期后转入半开并放行有限探测', () => {
  let clock = 0
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 1000, halfOpenProbes: 2, now: () => clock })
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'open')

  clock = 999
  assert.equal(breaker.canAttempt('p'), false, '未到期仍应拒绝')

  clock = 1000
  assert.equal(breaker.state('p'), 'half-open')
  assert.equal(breaker.canAttempt('p'), true, '第 1 次探测放行')
  assert.equal(breaker.canAttempt('p'), true, '第 2 次探测放行')
  assert.equal(breaker.canAttempt('p'), false, '第 3 次应被拒，避免并发把半开窗口冲垮')
})

test('半开探测成功即关闭', () => {
  let clock = 0
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 1000, now: () => clock })
  breaker.onFailure('p')
  clock = 1000
  assert.equal(breaker.canAttempt('p'), true)
  breaker.onSuccess('p')
  assert.equal(breaker.state('p'), 'closed')
  assert.equal(breaker.snapshot('p').failures, 0)
})

test('半开探测失败则重新打开并重新计时', () => {
  let clock = 0
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 1000, now: () => clock })
  breaker.onFailure('p')
  clock = 1000
  breaker.canAttempt('p')
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'open')
  clock = 1500
  assert.equal(breaker.state('p'), 'open', '应从本次失败重新计时')
  clock = 2000
  assert.equal(breaker.state('p'), 'half-open')
})

test('不同名字的熔断状态互相独立', () => {
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 1000 })
  breaker.onFailure('a')
  assert.equal(breaker.state('a'), 'open')
  assert.equal(breaker.state('b'), 'closed')
  assert.equal(breaker.canAttempt('b'), true)
})

test('reset 立即恢复', () => {
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 10_000 })
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'open')
  breaker.reset('p')
  assert.equal(breaker.state('p'), 'closed')
  assert.equal(breaker.canAttempt('p'), true)
})

test('snapshot 给出剩余打开时长', () => {
  let clock = 0
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 5000, now: () => clock })
  breaker.onFailure('p')
  clock = 1200
  const snapshot = breaker.snapshot('p')
  assert.equal(snapshot.state, 'open')
  assert.equal(snapshot.remainingMs, 3800)
  assert.equal(snapshot.threshold, 1)
})

test('threshold 可被调大，已打开的名字在下一次判定时收敛', () => {
  let clock = 0
  const breaker = new CircuitBreaker({ threshold: 2, openMs: 1000, now: () => clock })
  breaker.onFailure('p')
  breaker.onFailure('p')
  assert.equal(breaker.state('p'), 'open')
  breaker.configure({ threshold: 10 })
  clock = 1000
  // 半开成功即回到 closed，计数清零。
  breaker.canAttempt('p')
  breaker.onSuccess('p')
  assert.equal(breaker.state('p'), 'closed')
})
