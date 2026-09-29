/**
 * 金丝雀探测的测试。
 *
 * 重点是判定表：探测成功/鉴权失败/仍在限流/网络不通，这四种结果必须给出不同处置，
 * 判错了要么白白缩小池子，要么让一把坏密钥被反复探活。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROBE_INTERVAL_MS,
  MAX_PROBES_PER_SWEEP,
  applyProbeVerdict,
  judgeProbe,
  planProbes,
  probeEndpointFor,
  shouldProbe,
} from '../lib/core/canary.js'

test('probeEndpointFor 只做最保守的路径拼接', () => {
  assert.equal(probeEndpointFor('https://api.example.com/v1'), 'https://api.example.com/v1/models')
  assert.equal(probeEndpointFor('https://api.example.com/v1/'), 'https://api.example.com/v1/models')
  assert.equal(probeEndpointFor('https://api.example.com'), 'https://api.example.com/models')
  assert.equal(probeEndpointFor(''), '')
  assert.equal(probeEndpointFor(undefined), '')
})

test('只有冷却中的密钥才需要探活', () => {
  assert.equal(shouldProbe({ cooldownUntil: 1000, now: 500 }), true, '冷却中应探测')
  assert.equal(shouldProbe({ cooldownUntil: 500, now: 1000 }), false, '已过冷却不该探测')
  assert.equal(shouldProbe({ cooldownUntil: 0, now: 1000 }), false, '没有冷却不该探测')
})

test('探测间隔未到时不重复探测', () => {
  const now = 100_000
  assert.equal(shouldProbe({ cooldownUntil: now + 60_000, lastProbeAt: now - 1000, now, intervalMs: 5000 }), false)
  assert.equal(shouldProbe({ cooldownUntil: now + 60_000, lastProbeAt: now - 6000, now, intervalMs: 5000 }), true)
  assert.equal(shouldProbe({ cooldownUntil: now + 60_000, lastProbeAt: 0, now }), true, '从未探测过应放行')
})

test('用户停用或已作废的密钥不探测', () => {
  assert.equal(shouldProbe({ cooldownUntil: 1000, now: 500, paused: true }), false)
  assert.equal(shouldProbe({ cooldownUntil: 1000, now: 500, revoked: true }), false)
})

test('非法的时间输入不会误判为可探测', () => {
  assert.equal(shouldProbe({ cooldownUntil: Number.NaN, now: 1 }), false)
  assert.equal(shouldProbe({ cooldownUntil: 1000, now: Number.NaN }), false)
})

test('planProbes 优先探测剩余冷却最长的密钥', () => {
  const now = 1000
  const slots = [
    { ref: 'short', cooldownUntil: now + 10_000 },
    { ref: 'long', cooldownUntil: now + 600_000 },
    { ref: 'mid', cooldownUntil: now + 100_000 },
  ]
  assert.deepEqual(planProbes(slots, { now }), ['long', 'mid', 'short'])
})

test('planProbes 受单次上限约束', () => {
  const now = 0
  const slots = Array.from({ length: 10 }, (_, i) => ({ ref: `K${i}`, cooldownUntil: 10_000 - i }))
  const picked = planProbes(slots, { now })
  assert.equal(picked.length, MAX_PROBES_PER_SWEEP)
})

test('planProbes 跳过刚探测过的', () => {
  const now = 100_000
  const slots = [
    { ref: 'recent', cooldownUntil: now + 600_000, lastProbeAt: now - 1000 },
    { ref: 'stale', cooldownUntil: now + 100_000, lastProbeAt: now - DEFAULT_PROBE_INTERVAL_MS },
  ]
  assert.deepEqual(planProbes(slots, { now }), ['stale'])
})

test('planProbes 对畸形输入返回空数组', () => {
  assert.deepEqual(planProbes(undefined, { now: 0 }), [])
  assert.deepEqual(planProbes([], { now: 0 }), [])
  assert.deepEqual(planProbes([{ ref: 'a', cooldownUntil: 100 }], { now: Number.NaN }), [])
})

test('探测成功 → 解除冷却', () => {
  const verdict = judgeProbe({ status: 200, currentCooldownMs: 60_000 })
  assert.equal(verdict.action, 'release')
  assert.equal(verdict.cooldownMs, 0)
})

test('探测成功只减一档失败计数，而不是清零', () => {
  const verdict = judgeProbe({ status: 204, currentCooldownMs: 60_000 })
  assert.equal(verdict.decayFailures, 1, '一次探活不足以证明完全健康')
})

test('无鉴权端点的探活成功：放回池子，但不减免失败计数', () => {
  // 实测 NVIDIA NIM 的 `GET /v1/models` 无密钥也返回 200，那种 200 只能证明
  // 「服务可达」，证明不了「这把密钥还有效」。
  const verdict = judgeProbe({
    status: 200,
    currentCooldownMs: 60_000,
    probeAuthenticated: false,
  })
  assert.equal(verdict.action, 'release', '探活的主要收益（提前归队）不能丢')
  assert.equal(verdict.cooldownMs, 0)
  assert.equal(verdict.decayFailures, 0, '不能因为一次无鉴权的 200 就减免失败计数')
  assert.match(verdict.reason, /无需鉴权/)

  // 同样的 200，在有鉴权的端点上应当减一档。
  assert.equal(judgeProbe({ status: 200, currentCooldownMs: 60_000 }).decayFailures, 1)
})

test('鉴权失败的判定不受 probeAuthenticated 影响', () => {
  // 401 是端点明确拒绝这把密钥，无论探测端点本身是否鉴权，结论都成立。
  for (const probeAuthenticated of [true, false]) {
    const verdict = judgeProbe({ status: 401, currentCooldownMs: 60_000, probeAuthenticated })
    assert.equal(verdict.action, 'break', `probeAuthenticated=${probeAuthenticated} 时应长期隔离`)
  }
})

test('探测返回 401/403 → 长期隔离', () => {
  for (const status of [401, 403]) {
    const verdict = judgeProbe({ status, currentCooldownMs: 60_000, baseCooldownMs: 60_000 })
    assert.equal(verdict.action, 'break', `${status} 应判为密钥本身不可用`)
    assert.ok(verdict.cooldownMs >= 60_000)
  }
})

test('探测确认仍在限流 → 维持冷却等配额', () => {
  const verdict = judgeProbe({ status: 429, currentCooldownMs: 120_000, baseCooldownMs: 60_000 })
  assert.equal(verdict.action, 'keep')
  assert.ok(verdict.cooldownMs >= 120_000, '不该缩短原本的冷却')
})

test('服务端错误与传输失败 → 维持冷却', () => {
  for (const status of [500, 502, 503, 0, -1]) {
    const verdict = judgeProbe({ status, currentCooldownMs: 60_000, baseCooldownMs: 60_000 })
    assert.equal(verdict.action, 'keep', `status=${status} 不该解除冷却`)
    assert.ok(verdict.cooldownMs > 0)
  }
})

test('冷却不会超过上限', () => {
  const verdict = judgeProbe({ status: 500, currentCooldownMs: 10 * 60_000, baseCooldownMs: 60_000, maxCooldownMs: 120_000 })
  assert.ok(verdict.cooldownMs <= 120_000)
})

test('applyProbeVerdict：成功时解除冷却并缩减失败计数', () => {
  const slot = { failures: 3, cooldownUntil: 10_000, lastProbeAt: 0 }
  applyProbeVerdict(slot, judgeProbe({ status: 200 }), 5000)
  assert.equal(slot.cooldownUntil, 0)
  assert.equal(slot.failures, 2)
  assert.equal(slot.lastProbeAt, 5000)
})

test('applyProbeVerdict：失败时延长冷却且不减失败计数', () => {
  const slot = { failures: 3, cooldownUntil: 10_000, lastProbeAt: 0 }
  applyProbeVerdict(slot, judgeProbe({ status: 503, currentCooldownMs: 5000, baseCooldownMs: 60_000 }), 4000)
  assert.ok(slot.cooldownUntil > 4000)
  assert.equal(slot.failures, 3, '失败不该减档')
})

test('applyProbeVerdict：不会缩短已有的更长冷却', () => {
  const slot = { failures: 1, cooldownUntil: 1_000_000, lastProbeAt: 0 }
  applyProbeVerdict(slot, judgeProbe({ status: 503, currentCooldownMs: 1000, baseCooldownMs: 60_000 }), 1000)
  assert.equal(slot.cooldownUntil, 1_000_000, '探测失败只能延长，不能把冷却改短')
})

test('失败计数不会被减成负数', () => {
  const slot = { failures: 0, cooldownUntil: 10_000, lastProbeAt: 0 }
  applyProbeVerdict(slot, judgeProbe({ status: 200 }), 5000)
  assert.equal(slot.failures, 0)
})
