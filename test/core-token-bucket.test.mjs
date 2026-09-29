/**
 * 预判限流账本的测试。
 *
 * 重点是两件事：**各种形状的响应头都要认得**（上游 SDK 给什么形状不由我们决定），
 * 以及**窗口滚过之后不能把上一分钟的余量当成这一分钟的**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TokenBucket,
  extractRateLimit,
  parseDuration,
  parseRetryAfter,
  readHeader,
} from '../lib/core/index.js'

test('readHeader 支持 Headers 对象、普通对象、Map 与键值数组', () => {
  const headers = new Headers({ 'x-ratelimit-remaining-requests': '42' })
  assert.equal(readHeader(headers, 'x-ratelimit-remaining-requests'), '42')

  assert.equal(readHeader({ 'X-RateLimit-Remaining-Requests': '7' }, 'x-ratelimit-remaining-requests'), '7')
  assert.equal(readHeader(new Map([['x-ratelimit-remaining-tokens', '99']]), 'x-ratelimit-remaining-tokens'), '99')
  assert.equal(readHeader([['X-RateLimit-Remaining-Tokens', '5']], 'x-ratelimit-remaining-tokens'), '5')
  assert.equal(readHeader(undefined, 'x'), undefined)
  assert.equal(readHeader({}, 'x'), undefined)
  // 数组值取第一项（多值头的情形）
  assert.equal(readHeader({ 'x-test': ['a', 'b'] }, 'x-test'), 'a')
})

test('parseDuration 认得多种上游写法', () => {
  assert.equal(parseDuration('1s'), 1000)
  assert.equal(parseDuration('500ms'), 500)
  assert.equal(parseDuration('2m'), 120_000)
  assert.equal(parseDuration('1m30s'), 90_000)
  assert.equal(parseDuration('1h'), 3_600_000)
  // OpenAI 系的裸数字按秒解释
  assert.equal(parseDuration('30'), 30_000)
  assert.equal(parseDuration('nonsense'), undefined)
  assert.equal(parseDuration(''), undefined)
})

test('parseRetryAfter 认得秒数与 HTTP 日期', () => {
  const now = Date.parse('2026-07-15T12:00:00Z')
  assert.equal(parseRetryAfter('5', now), 5000)
  assert.equal(parseRetryAfter('Wed, 15 Jul 2026 12:00:30 GMT', now), 30_000)
  // 过去的日期钳到 0，而不是负数
  assert.equal(parseRetryAfter('Wed, 15 Jul 2026 11:59:00 GMT', now), 0)
  assert.equal(parseRetryAfter(undefined, now), undefined)
  assert.equal(parseRetryAfter('garbage', now), undefined)
})

test('extractRateLimit 只取合法的非负数值', () => {
  const info = extractRateLimit({
    'x-ratelimit-remaining-requests': '10',
    'x-ratelimit-remaining-tokens': '5000',
    'x-ratelimit-reset-requests': '1.5s',
  })
  assert.equal(info.requests, 10)
  assert.equal(info.tokens, 5000)
  assert.equal(info.resetRequestsMs, 1500)

  const bad = extractRateLimit({ 'x-ratelimit-remaining-requests': 'abc' })
  assert.equal(bad.requests, undefined)
  const negative = extractRateLimit({ 'x-ratelimit-remaining-requests': '-3' })
  assert.equal(negative.requests, undefined)
})

test('未配置上限时永不判定超限', () => {
  const bucket = new TokenBucket()
  assert.equal(bucket.wouldExceed({ requests: 1000, tokens: 10_000_000 }), false)
  bucket.charge({ requests: 1000 })
  assert.equal(bucket.wouldExceed({ requests: 1000 }), false)
})

test('RPM 边界：等于上限仍放行，超过才拦', () => {
  const bucket = new TokenBucket({ rpm: 3 })
  bucket.charge({ requests: 2 })
  assert.equal(bucket.wouldExceed({ requests: 1 }), false, '2+1=3 不该被拦')
  bucket.charge({ requests: 1 })
  assert.equal(bucket.wouldExceed({ requests: 1 }), true, '3+1 超过上限，应被拦')
})

test('TPM 与 RPM 各自独立判定', () => {
  const bucket = new TokenBucket({ rpm: 100, tpm: 1000 })
  bucket.charge({ requests: 1, tokens: 900 })
  assert.equal(bucket.wouldExceed({ tokens: 200 }), true, 'token 侧超限即应拦')
  assert.equal(bucket.wouldExceed({ tokens: 50 }), false)
})

test('窗口滚过后账本清零', () => {
  let clock = 0
  const bucket = new TokenBucket({ rpm: 2, windowMs: 1000, now: () => clock })
  bucket.charge({ requests: 2 })
  assert.equal(bucket.wouldExceed({ requests: 1 }), true)

  clock = 1000
  assert.equal(bucket.wouldExceed({ requests: 1 }), false, '窗口滚动后应重新有额度')
  assert.equal(bucket.snapshot().requests, 0)
})

test('窗口滚动时上游事实一并作废', () => {
  let clock = 0
  const bucket = new TokenBucket({ rpm: 100, windowMs: 1000, now: () => clock })
  // 上游说这个窗口只剩 1 次
  bucket.syncFromHeaders({ 'x-ratelimit-remaining-requests': '1' })
  assert.equal(bucket.wouldExceed({ requests: 2 }), true)

  clock = 1000
  // 新窗口里上一轮的「只剩 1 次」不该继续生效
  assert.equal(bucket.wouldExceed({ requests: 2 }), false)
})

test('上游余量优先于本地计数', () => {
  const bucket = new TokenBucket({ rpm: 100 })
  // 本地只记了 1 次，但上游说只剩 0 次（说明别的进程也在用同一把密钥）
  bucket.syncFromHeaders({ 'x-ratelimit-remaining-requests': '0' })
  assert.equal(bucket.wouldExceed({ requests: 1 }), true, '应以上游事实为准')
})

test('charge 会扣减已知的上游余量', () => {
  const bucket = new TokenBucket({ rpm: 100 })
  bucket.syncFromHeaders({ 'x-ratelimit-remaining-requests': '2' })
  bucket.charge({ requests: 1 })
  assert.equal(bucket.snapshot().upstream.requests, 1)
})

test('settle 用真实用量校正预估值', () => {
  const bucket = new TokenBucket({ tpm: 10_000 })
  bucket.charge({ requests: 1, tokens: 100 })
  assert.equal(bucket.snapshot().tokens, 100)
  // 实际用了 400：账本应变成 400 而不是 100
  bucket.settle(100, 400)
  assert.equal(bucket.snapshot().tokens, 400)
  // 实际比预估少也要校正
  bucket.settle(400, 50)
  assert.equal(bucket.snapshot().tokens, 50)
})

test('settle 不会把计数压成负数', () => {
  const bucket = new TokenBucket({ tpm: 1000 })
  bucket.settle(5000, 10)
  assert.equal(bucket.snapshot().tokens, 0)
})

test('resetInMs 报出窗口剩余时间', () => {
  let clock = 0
  const bucket = new TokenBucket({ rpm: 10, windowMs: 1000, now: () => clock })
  clock = 400
  assert.equal(bucket.resetInMs(), 600)
})

test('saturation 在未配置上限时为 undefined', () => {
  const bucket = new TokenBucket()
  assert.equal(bucket.saturation(), undefined)
})

test('saturation 反映最紧的那一侧', () => {
  const bucket = new TokenBucket({ rpm: 10, tpm: 1000 })
  bucket.charge({ requests: 5, tokens: 100 })
  // RPM 用了 50%，TPM 用了 10% → 取最紧的 50%
  assert.equal(bucket.saturation(), 0.5)
})

test('configure 更新上限但不凭空清空本窗口已用量', () => {
  const bucket = new TokenBucket({ rpm: 10 })
  bucket.charge({ requests: 5 })
  bucket.configure({ rpm: 20 })
  assert.equal(bucket.snapshot().requests, 5, '改配置不该把已用量抹掉')
  assert.equal(bucket.snapshot().rpm, 20)
})

test('configure 接受非法值时回退为不限', () => {
  const bucket = new TokenBucket({ rpm: 10 })
  bucket.configure({ rpm: -1, tpm: 'abc' })
  assert.equal(bucket.snapshot().rpm, 0)
  assert.equal(bucket.snapshot().tpm, 0)
  assert.equal(bucket.wouldExceed({ requests: 9999 }), false)
})
