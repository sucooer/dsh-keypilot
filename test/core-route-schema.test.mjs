/**
 * 路由声明校验的测试。
 *
 * 这一组用例是刻意围绕**参考实现踩过的坑**写的：那条路径上的 bug 几乎都来自
 * 「用户输入的字符串直接决定宿主行为」，所以这里重点打边界与畸形输入，而不是
 * 只验证 happy path。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectRoutes,
  describeRegistrationError,
  normalizeBaseUrl,
  normalizeModels,
  normalizeProtocol,
  normalizeRoute,
  normalizeRouteId,
  withCatalogRoutes,
  checkProtocolAvailability,
} from '../lib/core/index.js'

test('合法自定义路由全部通过并归一化', () => {
  const result = normalizeRoute({
    id: 'my-gateway',
    displayName: '我的网关',
    baseURL: 'https://gw.example.com/v1',
    api: 'openai-completions',
    models: ['gpt-4o', 'claude-3'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.route.id, 'my-gateway')
  assert.equal(result.route.baseURL, 'https://gw.example.com/v1')
  assert.deepEqual(result.route.models, ['gpt-4o', 'claude-3'])
  assert.equal(result.route.builtin, false)
})

test('内置提供商只需给 id，其余字段从目录补全', () => {
  const result = normalizeRoute({ id: 'deepseek' })
  assert.equal(result.ok, true)
  assert.equal(result.route.id, 'deepseek')
  assert.equal(result.route.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(result.route.api, 'openai-completions')
  assert.equal(result.route.builtin, true)
  assert.ok(result.route.models.length > 0, '内置条目必须带建议模型')
  assert.equal(result.route.displayName, 'DeepSeek 官方')
})

test('内置条目允许覆盖预设的端点与模型', () => {
  const result = normalizeRoute({
    id: 'deepseek',
    baseURL: 'https://my-proxy.example.com/v1',
    models: ['my-model'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.route.baseURL, 'https://my-proxy.example.com/v1')
  assert.deepEqual(result.route.models, ['my-model'])
})

test('路由 ID 非法字符被拒绝且指明字段', () => {
  const result = normalizeRoute({ id: 'my gateway', baseURL: 'https://a.com/v1', models: ['m'] })
  assert.equal(result.ok, false)
  const error = result.errors.find((e) => e.field === 'provider')
  assert.ok(error !== undefined)
  assert.match(error.message, /非法字符/)
})

test('路由 ID 首字符为符号时被拒绝', () => {
  const result = normalizeRouteId('-leading-dash')
  assert.ok(result.errors !== undefined)
  assert.match(result.errors[0].message, /首字符/)
})

test('路由 ID 为空、非字符串、超长均被拒绝', () => {
  assert.ok(normalizeRouteId('   ').errors !== undefined)
  assert.ok(normalizeRouteId(42).errors !== undefined)
  assert.ok(normalizeRouteId(null).errors !== undefined)
  assert.ok(normalizeRouteId('a'.repeat(65)).errors !== undefined)
  assert.equal(normalizeRouteId('a'.repeat(64)).id, 'a'.repeat(64))
})

test('相对路径的 Base URL 被拒绝', () => {
  for (const value of ['/v1', './v1', '../v1']) {
    const result = normalizeBaseUrl(value, 'r')
    assert.ok(result.errors !== undefined, `${value} 应当被拒绝`)
    assert.match(result.errors[0].message, /相对路径/)
  }
})

test('非 http(s) 协议的 Base URL 被拒绝', () => {
  const result = normalizeBaseUrl('ftp://example.com/v1', 'r')
  assert.ok(result.errors !== undefined)
  assert.match(result.errors[0].message, /只支持 http 与 https/)
})

test('内嵌用户名口令的 Base URL 被拒绝', () => {
  const result = normalizeBaseUrl('https://user:pass@example.com/v1', 'r')
  assert.ok(result.errors !== undefined)
  assert.match(result.errors[0].message, /不要写进 URL/)
})

test('Base URL 尾部斜杠被归一化，且归一化是幂等的', () => {
  const first = normalizeBaseUrl('https://example.com/v1/', 'r')
  assert.equal(first.baseURL, 'https://example.com/v1')
  const second = normalizeBaseUrl(first.baseURL, 'r')
  assert.equal(second.baseURL, first.baseURL, '归一化必须幂等，否则设置重载会反复抖动')
})

test('根路径的 Base URL 保留其单个斜杠', () => {
  const result = normalizeBaseUrl('https://example.com/', 'r')
  assert.equal(result.baseURL, 'https://example.com/')
})

test('Base URL 前后的空白被裁剪', () => {
  const result = normalizeBaseUrl('  https://example.com/v1  ', 'r')
  assert.equal(result.baseURL, 'https://example.com/v1')
})

test('协议缺省时回退到内置预设', () => {
  assert.equal(normalizeProtocol(undefined, 'anthropic-messages').api, 'anthropic-messages')
  assert.equal(normalizeProtocol('', 'openai-responses').api, 'openai-responses')
})

test('未知协议被拒绝并列出可选项', () => {
  const result = normalizeProtocol('grpc', 'openai-completions')
  assert.ok(result.errors !== undefined)
  assert.match(result.errors[0].message, /不受支持/)
})

test('模型列表去重且保序', () => {
  const result = normalizeModels(['b', 'a', 'b', ' a ', ''], 'r')
  assert.deepEqual(result.models, ['b', 'a'])
})

test('模型列表含非字符串项时被拒绝', () => {
  const result = normalizeModels(['ok', 42], 'r')
  assert.ok(result.errors !== undefined)
  assert.match(result.errors[0].message, /非字符串项/)
})

test('模型列表为空是允许的（只声明端点不预置模型）', () => {
  assert.deepEqual(normalizeModels(undefined, 'r').models, [])
  assert.deepEqual(normalizeModels([], 'r').models, [])
})

test('模型列表不是数组时被拒绝', () => {
  const result = normalizeModels('gpt-4o', 'r')
  assert.ok(result.errors !== undefined)
})

test('畸形 route 输入一律以错误返回而不是抛出', () => {
  for (const value of [null, 42, 'text', [], true]) {
    const result = normalizeRoute(value, { provider: 'p' })
    assert.equal(result.ok, false, `${JSON.stringify(value)} 应当被拒绝`)
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0)
  }
})

test('缺少 baseURL 且非内置时给出可读报错', () => {
  const result = normalizeRoute({ id: 'unknown-gw' })
  assert.equal(result.ok, false)
  const error = result.errors.find((e) => e.field === 'baseURL')
  assert.ok(error !== undefined)
  assert.match(error.message, /不能为空/)
})

test('collectRoutes 跳过未声明 route 的条目', () => {
  const { routes, errors } = collectRoutes([
    { provider: 'deepseek', keys: ['A'] },
    { provider: 'my-gw', keys: ['K'], route: { id: 'my-gw', baseURL: 'https://gw.example.com/v1', models: ['m'] } },
  ])
  assert.equal(errors.size, 0)
  assert.deepEqual([...routes.keys()], ['my-gw'])
})

test('collectRoutes 对 providers 非数组返回空结果且不抛出', () => {
  for (const value of [undefined, null, 'x', 42, {}]) {
    const { routes, errors } = collectRoutes(value)
    assert.equal(routes.size, 0)
    assert.equal(errors.size, 0)
  }
})

test('withCatalogRoutes 只为「目录内 + 宿主不认识」的条目补出路由', () => {
  const providers = [
    { provider: 'nvidia', keys: ['NVIDIA_API_KEY'] },
    { provider: 'deepseek', keys: ['D'] },
    { provider: 'my-gw', keys: ['K'] },
    { provider: 'sensenova', keys: ['S'], route: { id: 'sensenova', baseURL: 'https://x.example.com/v1', models: ['m'] } },
  ]
  const result = withCatalogRoutes(providers, (id) => id === 'deepseek')

  // 目录内 + 宿主不认识 → 补
  assert.deepEqual(result[0].route, { id: 'nvidia' })
  // 目录内但宿主已经认识 → 绝不能重复注册，会顶掉宿主自己的实现
  assert.equal(result[1].route, undefined)
  // 不在目录里 → 由用户显式声明，不猜
  assert.equal(result[2].route, undefined)
  // 已有显式声明 → 原样保留
  assert.equal(result[3].route.baseURL, 'https://x.example.com/v1')

  // 纯函数：不修改入参
  assert.equal(providers[0].route, undefined)
})

test('withCatalogRoutes 判定「宿主认不认识」时抛错 → 保守跳过注册', () => {
  const result = withCatalogRoutes([{ provider: 'nvidia', keys: [] }], () => {
    throw new Error('providerInfo 不可用')
  })
  assert.equal(result[0].route, undefined, '宁可少注册，也不能冒顶掉宿主实现的风险')
})

test('withCatalogRoutes 补出的路由能直接通过 collectRoutes 校验', () => {
  // 这条链路对应真实场景：配置里只写了 provider + keys，插件照样能把
  // 宿主不认识的提供商注册成可用路由。
  const providers = withCatalogRoutes([{ provider: 'nvidia', keys: ['K'] }], () => false)
  const { routes, errors } = collectRoutes(providers)
  assert.equal(errors.size, 0)
  assert.deepEqual([...routes.keys()], ['nvidia'])
  assert.equal(routes.get('nvidia').baseURL, 'https://integrate.api.nvidia.com/v1')
  assert.ok(routes.get('nvidia').models.length > 0, '模型列表应从目录一并补出')
})

test('collectRoutes 记录校验失败的路由而不是抛出', () => {
  const { routes, errors } = collectRoutes([
    { provider: 'bad-gw', route: { id: 'bad-gw', baseURL: '/relative', models: ['m'] } },
  ])
  assert.equal(routes.size, 0)
  assert.equal(errors.size, 1)
  assert.match(errors.get('bad-gw')[0].message, /相对路径/)
})

test('collectRoutes 对重复路由 ID 报错并保留后者', () => {
  const { routes, errors } = collectRoutes([
    { provider: 'a', route: { id: 'dup', baseURL: 'https://one.example.com/v1', models: ['m1'] } },
    { provider: 'b', route: { id: 'dup', baseURL: 'https://two.example.com/v1', models: ['m2'] } },
  ])
  assert.equal(routes.size, 1)
  assert.equal(routes.get('dup').baseURL, 'https://two.example.com/v1')
  assert.match(errors.get('dup')[0].message, /多次/)
})

test('collectRoutes 忽略数组里的畸形条目', () => {
  const { routes, errors } = collectRoutes([null, 42, 'text', [], { provider: '' }])
  assert.equal(routes.size, 0)
  assert.equal(errors.size, 0)
})

test('注册错误被翻译成可照做的说明', () => {
  const duplicate = Object.assign(new Error('route x is already registered'), { code: 'DUPLICATE_ADAPTER' })
  const translated = describeRegistrationError(duplicate, 'x')
  assert.match(translated, /已被宿主或其他插件占用/)

  const missing = new Error('pi-ai adapter seam not found')
  assert.match(describeRegistrationError(missing, 'y'), /没有暴露 pi-ai 适配器接缝/)

  const other = new Error('something else entirely')
  assert.equal(describeRegistrationError(other, 'z'), 'something else entirely')
})

test('协议可用性检查在宿主未报告协议时不做限制', () => {
  const route = { api: 'openai-completions' }
  assert.equal(checkProtocolAvailability(route, []), undefined)
  assert.equal(checkProtocolAvailability(route, ['openai-completions']), undefined)
  assert.ok(checkProtocolAvailability(route, ['anthropic-messages']) !== undefined)
})
