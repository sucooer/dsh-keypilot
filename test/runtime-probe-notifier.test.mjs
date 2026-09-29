/**
 * 探测执行器与通知发送器的集成测试。
 *
 * 上一层的判据（该不该解除冷却、要不要退避）已经由纯逻辑测试覆盖，这里补的是
 * **真实 HTTP 那一段**：请求真的发出去了吗？认证头对不对？超时会不会把插件拖死？
 * 用一个真的本地 HTTP 服务来回答，而不是 mock fetch——mock 里的假设往往是错的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { authHeadersFor, createProbeRunner } from '../lib/runtime/probe.js'
import { createNotifier } from '../lib/runtime/notifier.js'

/**
 * 起一个临时 HTTP 服务（随机端口）。
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: Array<object> }>}
 */
function startServer(handler) {
  return new Promise((resolve) => {
    /** @type {Array<object>} */
    const requests = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body })
        handler(req, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

// ── 认证头 ──────────────────────────────────────────────────────────────────

test('OpenAI 系协议用 Bearer 认证头', () => {
  const headers = authHeadersFor('openai-completions', 'sk-test')
  assert.equal(headers.Authorization, 'Bearer sk-test')
})

test('Anthropic 协议用自己的认证头', () => {
  const headers = authHeadersFor('anthropic-messages', 'sk-ant-test')
  assert.equal(headers['x-api-key'], 'sk-ant-test')
  assert.equal(headers.Authorization, undefined, '不该同时发 Bearer')
  assert.ok(typeof headers['anthropic-version'] === 'string')
})

// ── 探测 ────────────────────────────────────────────────────────────────────

test('探测成功：请求打到 /models 且带认证头', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"data":[]}')
  })
  try {
    const runner = createProbeRunner()
    const result = await runner.probe({
      endpoint: `${server.url}/v1/models`,
      apiKey: 'sk-probe-test',
      protocol: 'openai-completions',
      provider: 'p',
      ref: 'K',
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].method, 'GET')
    assert.equal(server.requests[0].url, '/v1/models')
    assert.equal(server.requests[0].headers.authorization, 'Bearer sk-probe-test')
  } finally {
    await server.close()
  }
})

test('探测拿到 401 时如实报告状态码', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":"invalid api key"}')
  })
  try {
    const result = await createProbeRunner().probe({
      endpoint: `${server.url}/models`,
      apiKey: 'bad-key',
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
    // 关键：不把响应体带回来——上游可能在错误里回显密钥。
    assert.equal('body' in result, false)
  } finally {
    await server.close()
  }
})

test('探测遇到 429 时报告状态码而非抛错', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(429, { 'Retry-After': '30' })
    res.end()
  })
  try {
    const result = await createProbeRunner().probe({ endpoint: `${server.url}/models`, apiKey: 'k' })
    assert.equal(result.status, 429)
    assert.equal(result.ok, false)
  } finally {
    await server.close()
  }
})

test('探测超时被收敛为失败，不会抛出去', async () => {
  const server = await startServer(() => {
    // 故意不响应
  })
  try {
    const runner = createProbeRunner({ timeoutMs: 300 })
    const result = await runner.probe({ endpoint: `${server.url}/models`, apiKey: 'k' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 0)
    assert.ok(typeof result.error === 'string')
  } finally {
    await server.close()
  }
})

test('连接被拒时返回失败而不是抛出', async () => {
  // 9999 之外的未监听端口
  const result = await createProbeRunner({ timeoutMs: 500 }).probe({
    endpoint: 'http://127.0.0.1:1/models',
    apiKey: 'k',
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
})

test('缺少端点或密钥时立即返回失败（不发请求）', async () => {
  const runner = createProbeRunner()
  assert.equal((await runner.probe({ endpoint: '', apiKey: 'k' })).ok, false)
  assert.equal((await runner.probe({ endpoint: 'http://127.0.0.1:1/models', apiKey: '' })).ok, false)
  assert.equal((await runner.probe({ endpoint: 'http://127.0.0.1:1/models' })).ok, false)
})

test('运行环境没有 fetch 时优雅退化', async () => {
  const result = await createProbeRunner({ fetchImpl: undefined }).probe({
    endpoint: 'http://127.0.0.1:1/models',
    apiKey: 'k',
  })
  // 全局 fetch 存在时走真实请求（连接失败），不存在时给出可读错误。
  assert.equal(result.ok, false)
})

// ── 通知 ────────────────────────────────────────────────────────────────────

test('通知真的发出去了，载荷形状与格式匹配', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const notifier = createNotifier()
    const ok = await notifier.send({
      url: `${server.url}/hook`,
      kind: 'discord',
      events: [{ type: 'switch', provider: 'p', from: 'K1', kind: 'RATE_LIMIT', cooldownMs: 60_000 }],
    })
    assert.equal(ok, true)
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].method, 'POST')
    const payload = JSON.parse(server.requests[0].body)
    assert.ok('content' in payload, 'discord 格式应有 content 字段')
    assert.match(payload.content, /RATE_LIMIT|限流/)
  } finally {
    await server.close()
  }
})

test('通知遇到非 2xx 时返回 false 而不是抛出', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(500)
    res.end('boom')
  })
  try {
    const ok = await createNotifier().send({
      url: `${server.url}/hook`,
      events: [{ type: 'switch', provider: 'p' }],
    })
    assert.equal(ok, false)
  } finally {
    await server.close()
  }
})

test('无事件时不发请求', async () => {
  const server = await startServer((req, res) => { res.writeHead(200); res.end() })
  try {
    const ok = await createNotifier().send({ url: `${server.url}/hook`, events: [] })
    assert.equal(ok, true)
    assert.equal(server.requests.length, 0, '空批次不该产生网络请求')
  } finally {
    await server.close()
  }
})

test('非法地址被拒绝，不发请求', async () => {
  const server = await startServer((req, res) => { res.writeHead(200); res.end() })
  try {
    const notifier = createNotifier()
    assert.equal(await notifier.send({ url: 'not-a-url', events: [{ type: 'switch' }] }), false)
    assert.equal(await notifier.send({ url: 'ftp://example.com/hook', events: [{ type: 'switch' }] }), false)
    assert.equal(await notifier.send({ url: '', events: [{ type: 'switch' }] }), false)
    assert.equal(server.requests.length, 0, '被拒的地址不该产生任何请求')
  } finally {
    await server.close()
  }
})

test('测试推送返回可读结果', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const result = await createNotifier().test({ url: `${server.url}/hook` })
    assert.equal(result.ok, true)
    assert.match(result.message, /已送达/)

    const bad = await createNotifier().test({ url: 'not-a-url' })
    assert.equal(bad.ok, false)
    assert.equal(typeof bad.message, 'string')
  } finally {
    await server.close()
  }
})

test('本机地址允许明文 http，外部域名要求 https', async () => {
  const server = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
  try {
    const notifier = createNotifier()
    // 本机明文：可以发
    assert.equal(await notifier.send({ url: `${server.url}/hook`, events: [{ type: 'switch' }] }), true)
    assert.equal(server.requests.length, 1)
    // 外部明文：被拒
    assert.equal(await notifier.send({ url: 'http://example.com/hook', events: [{ type: 'switch' }] }), false)
    assert.equal(server.requests.length, 1, '被拒的地址不该产生请求')
  } finally {
    await server.close()
  }
})
