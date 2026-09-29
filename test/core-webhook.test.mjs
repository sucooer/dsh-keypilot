/**
 * Webhook 通知的测试。
 *
 * 重点：队列必须聚合（防告警风暴）、必须有界（防内存增长）、失败必须退避
 * （防把故障放大成 DoS），以及 URL 里的凭据不能泄漏到日志或载荷里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_AGGREGATE_MS,
  MAX_QUEUE,
  NotifyQueue,
  WEBHOOK_KINDS,
  describeEvent,
  detectKind,
  formatPayload,
  validateWebhookUrl,
} from '../lib/core/webhook.js'

/** 可控时钟的队列。 */
function queueAt(clock) {
  return new NotifyQueue({ now: () => clock.value, aggregateMs: 5000 })
}

test('detectKind 按 URL 识别平台', () => {
  assert.equal(detectKind('https://api.telegram.org/bot123/sendMessage'), 'telegram')
  assert.equal(detectKind('https://discord.com/api/webhooks/1/abc'), 'discord')
  assert.equal(detectKind('https://hooks.slack.com/services/T/B/X'), 'slack')
  assert.equal(detectKind('https://example.com/hook'), 'generic')
  assert.equal(detectKind(''), 'generic')
  assert.equal(detectKind(undefined), 'generic')
})

test('Webhook 地址必须是合法 URL', () => {
  assert.equal(validateWebhookUrl('').ok, false)
  assert.equal(validateWebhookUrl('not a url').ok, false)
  assert.equal(validateWebhookUrl('ftp://example.com').ok, false)
  assert.equal(validateWebhookUrl('https://example.com/hook').ok, true)
})

test('明文 http 会被拒绝（URL 里通常带 bot token）', () => {
  const verdict = validateWebhookUrl('http://example.com/hook')
  assert.equal(verdict.ok, false)
  assert.match(verdict.message, /https/)
})

test('本机地址允许明文 http，方便自建服务调试', () => {
  assert.equal(validateWebhookUrl('http://127.0.0.1:9000/hook').ok, true)
  assert.equal(validateWebhookUrl('http://localhost:9000/hook').ok, true)
})

test('显式允许后可放行明文 http', () => {
  assert.equal(validateWebhookUrl('http://example.com/hook', { allowInsecure: true }).ok, true)
})

test('各平台的载荷形状不同', () => {
  const events = [{ type: 'switch', provider: 'p', from: 'A', kind: 'RATE_LIMIT', cooldownMs: 60_000 }]
  assert.ok('text' in formatPayload(events, 'telegram'))
  assert.ok('content' in formatPayload(events, 'discord'))
  assert.ok('text' in formatPayload(events, 'slack'))
  const generic = formatPayload(events, 'generic')
  assert.equal(generic.count, 1)
  assert.ok(Array.isArray(generic.events))
})

test('未知格式退化为 generic', () => {
  const payload = formatPayload([{ type: 'switch', provider: 'p' }], 'carrier-pigeon')
  assert.ok('text' in payload)
})

test('载荷文本里不含密钥形态的内容', () => {
  const events = [{ type: 'switch', provider: 'p', from: 'A', kind: 'AUTH' }]
  const payload = formatPayload(events, 'discord')
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(payload.content), false)
})

test('describeEvent 覆盖各事件类型', () => {
  assert.match(describeEvent({ type: 'switch', provider: 'p', from: 'A', kind: 'QUOTA', cooldownMs: 30_000 }), /30s/)
  assert.match(describeEvent({ type: 'cascade', from: 'a', to: 'b' }), /a → b/)
  assert.match(describeEvent({ type: 'success', provider: 'p', ref: 'A', ttftMs: 120 }), /120ms/)
  assert.match(describeEvent({ type: 'probe', provider: 'p', ref: 'A', outcome: 'release' }), /release/)
})

test('队列：窗口未到期时不给东西', () => {
  const clock = { value: 1000 }
  const queue = queueAt(clock)
  queue.push({ type: 'switch', provider: 'p' })
  assert.equal(queue.ready(), false)
  assert.deepEqual(queue.take(), [])

  clock.value = 1000 + DEFAULT_AGGREGATE_MS
  assert.equal(queue.ready(), true)
  assert.equal(queue.take().length, 1)
})

test('队列：窗口内的多条事件聚合为一批', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  for (let i = 0; i < 5; i += 1) queue.push({ type: 'switch', provider: 'p', from: `K${i}` })
  clock.value = DEFAULT_AGGREGATE_MS
  const batch = queue.take()
  assert.equal(batch.length, 5, '一批取走，而不是逐条')
  assert.deepEqual(queue.take(), [], '取走后窗口关闭')
})

test('队列有界：超出上限丢弃最旧的并计数', () => {
  const clock = { value: 0 }
  const queue = new NotifyQueue({ now: () => clock.value, aggregateMs: 5000, maxQueue: 3 })
  for (let i = 0; i < 5; i += 1) queue.push({ type: 'switch', provider: 'p', from: `K${i}` })
  assert.equal(queue.pending, 3)
  assert.equal(queue.dropped, 2)
  clock.value = 5000
  const batch = queue.take()
  assert.equal(batch[0].from, 'K2', '保留的是较新的')
})

test('队列：默认上限符合常量', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  for (let i = 0; i < MAX_QUEUE + 10; i += 1) queue.push({ type: 'switch' })
  assert.equal(queue.pending, MAX_QUEUE)
})

test('队列：连续失败触发退避', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  assert.equal(queue.cooling, false)
  queue.markResult(false)
  queue.markResult(false)
  assert.equal(queue.cooling, false, '前两次失败还不退避')
  queue.markResult(false)
  assert.equal(queue.cooling, true, '第三次失败开始退避')
  assert.ok(queue.backoffRemainingMs() > 0)
})

test('队列：成功后退避立即解除', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  for (let i = 0; i < 5; i += 1) queue.markResult(false)
  assert.equal(queue.cooling, true)
  queue.markResult(true)
  assert.equal(queue.cooling, false)
  assert.equal(queue.failures, 0)
})

test('队列：退避期间即使窗口到期也不发送', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  queue.push({ type: 'switch' })
  // 失败次数要足够多，让退避长于聚合窗口，才测得到「退避压住发送」。
  for (let i = 0; i < 10; i += 1) queue.markResult(false)
  assert.ok(queue.backoffRemainingMs() > DEFAULT_AGGREGATE_MS)
  clock.value = DEFAULT_AGGREGATE_MS
  assert.equal(queue.ready(), false, '退避中应压住发送')
  assert.deepEqual(queue.take(), [])
})

test('队列：退避时长有上限', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  for (let i = 0; i < 30; i += 1) queue.markResult(false)
  assert.ok(queue.backoffRemainingMs() <= 15 * 60_000)
})

test('队列拒绝非对象事件', () => {
  const clock = { value: 0 }
  const queue = queueAt(clock)
  assert.equal(queue.push(null), false)
  assert.equal(queue.push('text'), false)
  assert.equal(queue.push({ type: 'switch' }), true)
})

test('支持的目标格式集合符合预期', () => {
  assert.deepEqual([...WEBHOOK_KINDS], ['generic', 'telegram', 'discord', 'slack'])
})
