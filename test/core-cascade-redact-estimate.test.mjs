/**
 * 级联与脱敏、token 预估的测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CASCADE_DEPTH,
  describeExhaustion,
  estimateRequestTokens,
  estimateTextTokens,
  keyTail,
  looksLikeSecret,
  nextCascadeTarget,
  normalizeCascade,
  redactSecrets,
  safeErrorMessage,
  tokenUsageOf,
} from '../lib/core/index.js'

// ── 级联 ────────────────────────────────────────────────────────────────────

test('normalizeCascade 去重、去空、忽略畸形条目', () => {
  const parsed = normalizeCascade([
    { provider: 'a' },
    { provider: 'a', model: 'm2' },
    { provider: '  ' },
    null,
    42,
    { provider: 'b', model: '  ' },
  ])
  assert.deepEqual(parsed, [{ provider: 'a' }, { provider: 'b' }])
  assert.deepEqual(normalizeCascade('not-an-array'), [])
})

test('挑选下一个级联目标时会跳过自己', () => {
  const target = nextCascadeTarget({
    cascade: [{ provider: 'primary' }, { provider: 'backup' }],
    fromProvider: 'primary',
    model: 'm',
  })
  assert.equal(target.provider, 'backup')
  assert.equal(target.model, 'm')
  assert.equal(target.depth, 1)
})

test('已尝试过的目标不会被再次选中（防循环级联）', () => {
  const attempted = new Set(['a', 'b'])
  const target = nextCascadeTarget({
    cascade: [{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }],
    fromProvider: 'a',
    attempted,
  })
  assert.equal(target.provider, 'c')
})

test('链上全部试过时返回 undefined 而不是回绕', () => {
  const target = nextCascadeTarget({
    cascade: [{ provider: 'a' }, { provider: 'b' }],
    fromProvider: 'b',
    attempted: new Set(['a', 'b']),
  })
  assert.equal(target, undefined)
})

test('深度上限阻止无限级联', () => {
  const target = nextCascadeTarget({
    cascade: [{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }],
    fromProvider: 'a',
    depth: MAX_CASCADE_DEPTH,
  })
  assert.equal(target, undefined)
  // 刚好在边界内仍然放行
  const allowed = nextCascadeTarget({
    cascade: [{ provider: 'z' }],
    fromProvider: 'a',
    depth: MAX_CASCADE_DEPTH - 1,
  })
  assert.equal(allowed.provider, 'z')
})

test('声明里不存在密钥池的目标被跳过，链上后面的目标仍可用', () => {
  const target = nextCascadeTarget({
    cascade: [{ provider: 'ghost' }, { provider: 'real' }],
    fromProvider: 'primary',
    hasPool: (provider) => provider === 'real',
  })
  assert.equal(target.provider, 'real', '不该被一个拼错的名字卡住整条链')
})

test('空级联链返回 undefined', () => {
  assert.equal(nextCascadeTarget({ cascade: [], fromProvider: 'a' }), undefined)
  assert.equal(nextCascadeTarget({ cascade: undefined, fromProvider: 'a' }), undefined)
})

test('级联目标可覆盖模型', () => {
  const target = nextCascadeTarget({
    cascade: [{ provider: 'backup', model: 'backup-model' }],
    fromProvider: 'primary',
    model: 'original',
  })
  assert.equal(target.model, 'backup-model')
})

test('耗尽说明包含已尝试链与恢复倒计时', () => {
  const text = describeExhaustion({
    cascade: [{ provider: 'backup' }],
    attempted: new Set(['primary', 'backup']),
    retryAfterMs: 90_000,
    formatCountdown: (ms) => `${ms / 1000}s`,
  })
  assert.match(text, /primary → backup/)
  assert.match(text, /90s/)
})

test('未配置级联时耗尽说明明确指出这一点', () => {
  const text = describeExhaustion({ cascade: [], attempted: new Set(['solo']) })
  assert.match(text, /未配置备用提供商级联/)
})

// ── 脱敏 ────────────────────────────────────────────────────────────────────

test('keyTail 只回显末几位，短密钥不回显', () => {
  assert.equal(keyTail('sk-1234567890abcdef'), 'bcdef')
  assert.equal(keyTail('short'), '***')
  assert.equal(keyTail(''), '***')
  assert.equal(keyTail(undefined), '***')
  assert.equal(keyTail(12345), '***')
})

test('环境变量名不被误判为密钥本体', () => {
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY_2', 'MY_KEY_BACKUP']) {
    assert.equal(looksLikeSecret(name).secret, false, `${name} 是合法的引用名`)
  }
})

test('常见的密钥形态被识别出来', () => {
  assert.equal(looksLikeSecret('sk-abcdefghijklmnopqrstuvwxyz').secret, true)
  assert.equal(looksLikeSecret('sk-ant-api03-abcdefghijklmnop').secret, true)
  assert.equal(looksLikeSecret('gsk_abcdefghijklmnopqrstuvwxyz').secret, true)
  assert.equal(looksLikeSecret('xai-abcdefghijklmnopqrstuvwxyz').secret, true)
})

test('JWT 形式被识别', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  assert.equal(looksLikeSecret(jwt).secret, true)
})

test('高熵长串被识别为疑似密钥', () => {
  assert.equal(looksLikeSecret('aB3xK9mQ2pL7vN4zR8tY1wE5sD6fG0hJ').secret, true)
})

test('普通文本不被误判', () => {
  assert.equal(looksLikeSecret('my-provider').secret, false)
  assert.equal(looksLikeSecret('deepseek').secret, false)
  assert.equal(looksLikeSecret('').secret, false)
  assert.equal(looksLikeSecret(null).secret, false)
})

test('redactSecrets 抹掉密钥但保留其余文本', () => {
  const text = 'Authorization failed for sk-abcdefghijklmnop with status 401'
  const redacted = redactSecrets(text)
  assert.ok(!redacted.includes('sk-abcdefghijklmnop'), '密钥本体必须被抹掉')
  assert.match(redacted, /status 401/, '诊断信息应当保留')
})

test('redactSecrets 抹掉 Bearer 令牌与 JWT', () => {
  const bearer = redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz123456')
  assert.ok(!bearer.includes('abcdefghijklmnopqrstuvwxyz123456'))

  const jwt = redactSecrets('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop')
  assert.ok(!jwt.includes('eyJhbGciOiJIUzI1NiJ9'))
})

test('redactSecrets 对非字符串输入返回空串', () => {
  assert.equal(redactSecrets(undefined), '')
  assert.equal(redactSecrets(null), '')
  assert.equal(redactSecrets(42), '')
})

test('safeErrorMessage 折叠空白并截断', () => {
  assert.equal(safeErrorMessage(new Error('a\n\n  b   c')), 'a b c')
  assert.equal(safeErrorMessage(new Error('x'.repeat(500)), 20).length, 20)
  assert.equal(safeErrorMessage(undefined), '')
})

// ── token 预估 ──────────────────────────────────────────────────────────────

test('估算：拉丁文本约 4 字符 1 token', () => {
  assert.equal(estimateTextTokens('abcd'), 1)
  assert.equal(estimateTextTokens('a'.repeat(400)), 100)
})

test('估算：中文按更高密度计量', () => {
  const cjk = estimateTextTokens('这是一段中文文本')
  const ascii = estimateTextTokens('aaaaaaaa')
  assert.ok(cjk > ascii, '同样 8 个字符，中文应当估得更多')
})

test('估算：混合文本与空输入', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(estimateTextTokens(null), 0)
  assert.ok(estimateTextTokens('中文 abc') > 0)
})

test('请求估算计入消息、系统提示、工具与输出预留', () => {
  const minimal = estimateRequestTokens({ messages: [{ role: 'user', content: 'hi' }] })
  const withSystem = estimateRequestTokens({
    messages: [{ role: 'user', content: 'hi' }],
    system: '你是一个助手',
  })
  assert.ok(withSystem > minimal, '系统提示应当计入')

  const withTools = estimateRequestTokens({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search', description: 'x'.repeat(400) }],
  })
  assert.ok(withTools > minimal, '工具 schema 应当计入')

  const withOutput = estimateRequestTokens({
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 4096,
  })
  assert.ok(withOutput >= 4096, '输出额度应当预留')
})

test('请求估算从各种消息形状里抽取文本', () => {
  const arrayContent = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }],
  })
  assert.ok(arrayContent > 50, '数组形式的 content 应被计量')

  const toolArgs = estimateRequestTokens({
    messages: [{ role: 'assistant', toolCalls: [{ arguments: { q: 'x'.repeat(400) } }] }],
  })
  assert.ok(toolArgs > 50, '工具入参应被计量')
})

test('请求估算对畸形输入不抛出', () => {
  assert.ok(estimateRequestTokens({}) >= 0)
  assert.ok(estimateRequestTokens({ messages: 'nope' }) >= 0)
  assert.ok(estimateRequestTokens({ messages: [null, 42, 'text'] }) >= 0)
})

test('请求估算有上限，挡住病态输入', () => {
  const huge = estimateRequestTokens({ messages: [{ role: 'user', content: 'x'.repeat(10_000_000) }] })
  assert.ok(huge <= 2_000_000)
})

test('tokenUsageOf 合并不同适配器的字段命名', () => {
  assert.equal(tokenUsageOf({ inputTokens: 10, outputTokens: 5 }), 15)
  assert.equal(tokenUsageOf({ input_tokens: 10, output_tokens: 5 }), 15)
  assert.equal(tokenUsageOf({ promptTokens: 10, completionTokens: 5 }), 15)
  assert.equal(tokenUsageOf({ prompt_tokens: 10, completion_tokens: 5 }), 15)
  assert.equal(tokenUsageOf({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }), 115)
})

test('tokenUsageOf 在字段缺失时返回 undefined', () => {
  assert.equal(tokenUsageOf({}), undefined)
  assert.equal(tokenUsageOf(null), undefined)
  assert.equal(tokenUsageOf('text'), undefined)
  assert.equal(tokenUsageOf({ inputTokens: 'x' }), undefined)
})
