/**
 * 设置桥的安全测试。
 *
 * 这个桥能改密钥池、能读状态，所以「它只能被本机宿主界面调用」必须是被验证过的
 * 事实，而不是一句注释。这里逐条打攻击面：远程来源、DNS rebinding、跨站写请求、
 * 超大请求体、方法越权。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_ACTION_PATH,
  BRIDGE_CONFIG_PATH,
  BRIDGE_STATE_PATH,
  checkBridgeRequest,
  createBridgeHandler,
  isLoopbackAddress,
  parseHostHeader,
} from '../lib/runtime/http-bridge.js'

/** 造一个假的请求对象。 */
function makeReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    on() {},
    destroy() {},
    ...overrides,
  }
}

/** 造一个假响应对象，收集状态码与响应体。 */
function makeRes() {
  const captured = { status: 0, body: '', headers: {} }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end(body) {
      captured.body = typeof body === 'string' ? body : ''
    },
  }
}

// ── 地址判定 ────────────────────────────────────────────────────────────────

test('isLoopbackAddress 认得 IPv4 / IPv6 / IPv4-mapped / 全域 127/8', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.0.53'), true)
  assert.equal(isLoopbackAddress('127.255.255.254'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('localhost'), true)
})

test('isLoopbackAddress 拒绝非环回与畸形输入', () => {
  for (const value of ['192.168.1.5', '10.0.0.1', '8.8.8.8', '0.0.0.0', '::2', '128.0.0.1', '127.0.0.256', '', null, undefined, 42]) {
    assert.equal(isLoopbackAddress(value), false, `${String(value)} 不该被判为环回`)
  }
})

test('parseHostHeader 处理主机名、端口与 IPv6 字面量', () => {
  assert.deepEqual(parseHostHeader('127.0.0.1:3080'), { hostname: '127.0.0.1', port: '3080' })
  assert.deepEqual(parseHostHeader('localhost'), { hostname: 'localhost', port: '' })
  assert.deepEqual(parseHostHeader('[::1]:3080'), { hostname: '::1', port: '3080' })
  assert.equal(parseHostHeader(''), undefined)
  assert.equal(parseHostHeader(undefined), undefined)
})

// ── 请求可信性 ──────────────────────────────────────────────────────────────

test('环回来源 + 环回 Host 的读请求被信任', () => {
  assert.equal(checkBridgeRequest(makeReq()).trusted, true)
})

test('来自局域网/公网的连接被拒绝', () => {
  const verdict = checkBridgeRequest(makeReq({ socket: { remoteAddress: '192.168.1.20' } }))
  assert.equal(verdict.trusted, false)
  assert.match(verdict.reason, /不是环回地址/)
})

test('Host 指向外部域名时被拒绝（DNS rebinding）', () => {
  const verdict = checkBridgeRequest(makeReq({ headers: { host: 'evil.example.com' } }))
  assert.equal(verdict.trusted, false)
  assert.match(verdict.reason, /未解析到环回地址/)
})

test('缺少 Host 头时被拒绝', () => {
  const verdict = checkBridgeRequest(makeReq({ headers: {} }))
  assert.equal(verdict.trusted, false)
  assert.match(verdict.reason, /缺少 Host/)
})

test('跨站 Origin 的读请求被拒绝', () => {
  const verdict = checkBridgeRequest(makeReq({
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.example.com' },
  }))
  assert.equal(verdict.trusted, false)
  assert.match(verdict.reason, /不是环回地址/)
})

test('同主机但不同端口的 Origin 被拒绝', () => {
  const verdict = checkBridgeRequest(makeReq({
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' },
  }))
  assert.equal(verdict.trusted, false)
  assert.match(verdict.reason, /不同源/)
})

test('同源 Origin 的写请求被信任', () => {
  const verdict = checkBridgeRequest(makeReq({
    method: 'PUT',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  }))
  assert.equal(verdict.trusted, true)
})

test('改变状态的方法缺少 Origin 时被拒绝', () => {
  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
    const verdict = checkBridgeRequest(makeReq({ method, headers: { host: '127.0.0.1:3080' } }))
    assert.equal(verdict.trusted, false, `${method} 无 Origin 应被拒绝`)
    assert.match(verdict.reason, /缺少 Origin/)
  }
})

test('读方法缺少 Origin 是允许的（浏览器同源 GET 本就不发该头）', () => {
  for (const method of ['GET', 'HEAD']) {
    const verdict = checkBridgeRequest(makeReq({ method, headers: { host: '127.0.0.1:3080' } }))
    assert.equal(verdict.trusted, true, `${method} 无 Origin 应被允许`)
  }
})

test('Origin 为畸形 URL 时被拒绝', () => {
  const verdict = checkBridgeRequest(makeReq({
    headers: { host: '127.0.0.1:3080', origin: 'not a url' },
  }))
  assert.equal(verdict.trusted, false)
})

test('Origin 为 "null"（沙箱 iframe）时按缺少 Origin 处理', () => {
  const read = checkBridgeRequest(makeReq({
    headers: { host: '127.0.0.1:3080', origin: 'null' },
  }))
  assert.equal(read.trusted, true, 'GET 允许')

  const write = checkBridgeRequest(makeReq({
    method: 'PUT',
    headers: { host: '127.0.0.1:3080', origin: 'null' },
  }))
  assert.equal(write.trusted, false, '写请求仍然要求真实来源')
})

// ── 处理器行为 ──────────────────────────────────────────────────────────────

test('不可信请求得到 403 且不触碰业务逻辑', async () => {
  let touched = false
  const handler = createBridgeHandler({
    getState: () => { touched = true; return {} },
    putConfig: () => { touched = true; return { ok: true } },
    runAction: () => { touched = true; return { ok: true } },
  })
  const res = makeRes()
  await handler(makeReq({ socket: { remoteAddress: '203.0.113.5' }, url: BRIDGE_STATE_PATH }), res)
  assert.equal(res.captured.status, 403)
  assert.equal(touched, false, '被拒绝的请求不该进入业务逻辑')
  assert.match(res.captured.body, /forbidden/)
})

test('状态路由在错误的方法上返回 405', async () => {
  const handler = createBridgeHandler({
    getState: () => ({ ok: true }),
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const res = makeRes()
  await handler(makeReq({ method: 'GET', url: BRIDGE_STATE_PATH }), res)
  assert.equal(res.captured.status, 200)

  const posted = makeRes()
  await handler(makeReq({
    method: 'POST',
    url: BRIDGE_STATE_PATH,
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  }), posted)
  assert.equal(posted.captured.status, 405)
})

test('未知路径返回 404', async () => {
  const handler = createBridgeHandler({
    getState: () => ({}),
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const res = makeRes()
  await handler(makeReq({ url: '/dsh-keypilot/nope' }), res)
  assert.equal(res.captured.status, 404)
})

test('写配置返回 422 时携带原因', async () => {
  const handler = createBridgeHandler({
    getState: () => ({}),
    putConfig: () => ({ ok: false, message: '密钥栏里填的是密钥本体' }),
    runAction: () => ({ ok: true }),
  })
  const res = makeRes()
  // 直接调用处理器时手动喂 body：这里用一个可读的流。
  const req = makeReq({
    method: 'PUT',
    url: BRIDGE_CONFIG_PATH,
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  Object.assign(req, {
    on(event, handler2) {
      if (event === 'data') handler2(Buffer.from(JSON.stringify({ providers: [] })))
      if (event === 'end') handler2()
    },
  })
  await handler(req, res)
  assert.equal(res.captured.status, 422)
  assert.match(res.captured.body, /密钥本体/)
})

test('畸形 JSON 请求体返回 400', async () => {
  const handler = createBridgeHandler({
    getState: () => ({}),
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const req = makeReq({
    method: 'PUT',
    url: BRIDGE_CONFIG_PATH,
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  Object.assign(req, {
    on(event, handler2) {
      if (event === 'data') handler2(Buffer.from('{ not json'))
      if (event === 'end') handler2()
    },
  })
  const res = makeRes()
  await handler(req, res)
  assert.equal(res.captured.status, 400)
})

test('超出体积上限的请求体被拒绝', async () => {
  const handler = createBridgeHandler({
    getState: () => ({}),
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const req = makeReq({
    method: 'PUT',
    url: BRIDGE_CONFIG_PATH,
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  Object.assign(req, {
    on(event, handler2) {
      if (event === 'data') handler2(Buffer.alloc(1024 * 1024 + 10, 0x61))
      if (event === 'end') handler2()
    },
    destroy() {},
  })
  const res = makeRes()
  await handler(req, res)
  assert.equal(res.captured.status, 413)
})

test('操作路由只接受 POST', async () => {
  const handler = createBridgeHandler({
    getState: () => ({}),
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const res = makeRes()
  await handler(makeReq({ method: 'GET', url: BRIDGE_ACTION_PATH }), res)
  assert.equal(res.captured.status, 405)
})

test('业务逻辑抛出时返回 500 而不是让连接挂住', async () => {
  const handler = createBridgeHandler({
    getState: () => { throw new Error('数据库炸了') },
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const res = makeRes()
  await handler(makeReq({ url: BRIDGE_STATE_PATH }), res)
  assert.equal(res.captured.status, 500)
  assert.match(res.captured.body, /数据库炸了/)
})

test('响应带 no-store 与 nosniff', async () => {
  const handler = createBridgeHandler({
    getState: () => ({ ok: true }),
    putConfig: () => ({ ok: true }),
    runAction: () => ({ ok: true }),
  })
  const res = makeRes()
  await handler(makeReq({ url: BRIDGE_STATE_PATH }), res)
  assert.equal(res.captured.headers['Cache-Control'], 'no-store')
  assert.equal(res.captured.headers['X-Content-Type-Options'], 'nosniff')
})
