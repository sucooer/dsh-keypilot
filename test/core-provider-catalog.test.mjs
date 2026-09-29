/**
 * 内置提供商目录自洽性测试。
 *
 * 目录里的每一条都是**会直接变成宿主路由**的声明，一个拼错的端点或重复的 ID
 * 会在用户点「添加」时才炸出来。因此这里不测「目录里有哪些条目」（那会随目录
 * 变化而失效），而是测**所有条目是否都满足同一套不变量**——这样以后往目录里
 * 加新服务商时，测试会自动替新条目把关。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_PROVIDERS,
  CATALOG_GROUPS,
  PROTOCOLS,
  findCatalogProvider,
  isCatalogProvider,
  normalizeBaseUrl,
  normalizeRoute,
} from '../lib/core/index.js'

test('目录非空且每条都带齐必需字段', () => {
  assert.ok(BUILTIN_PROVIDERS.length >= 20, `目录应当覆盖常用服务商，实际 ${BUILTIN_PROVIDERS.length} 条`)
  for (const provider of BUILTIN_PROVIDERS) {
    assert.equal(typeof provider.id, 'string', 'id 必须是字符串')
    assert.ok(provider.id.length > 0, 'id 不能为空')
    assert.equal(typeof provider.label, 'string')
    assert.ok(provider.label.length > 0, `${provider.id} 缺少显示名`)
    assert.equal(typeof provider.group, 'string')
    assert.ok(provider.group.length > 0, `${provider.id} 缺少分组`)
    assert.equal(typeof provider.keyEnv, 'string')
    assert.ok(provider.keyEnv.length > 0, `${provider.id} 缺少建议的密钥环境变量名`)
    assert.ok(Array.isArray(provider.models), `${provider.id} 的 models 必须是数组`)
  }
})

test('提供商 ID 全局唯一', () => {
  const seen = new Set()
  for (const provider of BUILTIN_PROVIDERS) {
    assert.equal(seen.has(provider.id), false, `重复的提供商 ID: ${provider.id}`)
    seen.add(provider.id)
  }
})

test('建议的密钥环境变量名是合法的引用名，且不作为他人 ID', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    assert.match(provider.keyEnv, /^[A-Z][A-Z0-9_]*$/, `${provider.id} 的 keyEnv "${provider.keyEnv}" 不是规范的环境变量名`)
  }
})

test('每条 Base URL 都能通过校验（错误消息给出具体条目）', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    const result = normalizeBaseUrl(provider.baseURL, provider.id)
    assert.equal(
      result.errors,
      undefined,
      `${provider.id} 的 baseURL "${provider.baseURL}" 校验失败：${result.errors?.map((e) => e.message).join('；')}`,
    )
  }
})

test('每条协议都在支持列表内', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    assert.ok(PROTOCOLS.includes(provider.api), `${provider.id} 的协议 "${provider.api}" 不受支持`)
  }
})

test('每条都能走通完整路由校验（只给 id 即可补全）', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    const result = normalizeRoute({ id: provider.id })
    assert.equal(
      result.ok,
      true,
      `${provider.id} 无法仅靠 id 补全为合法路由：${result.ok ? '' : JSON.stringify(result.errors)}`,
    )
    assert.equal(result.route.builtin, true)
    // 与目录原文比较归一化后的形态：URL 主机名按规范会被小写化，直接比原文
    // 会因为大小写差异误报。
    const expectedBaseUrl = normalizeBaseUrl(provider.baseURL, provider.id).baseURL
    assert.equal(result.route.baseURL, expectedBaseUrl)
    assert.equal(result.route.api, provider.api)
  }
})

test('本地端点的判定标记与实际端点一致', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(provider.baseURL)
    if (isLoopback) {
      assert.equal(provider.local, true, `${provider.id} 是本地端点，应标记 local: true`)
    }
  }
})

test('目录分组与条目里出现的分组一致且保序', () => {
  const fromEntries = [...new Set(BUILTIN_PROVIDERS.map((p) => p.group))]
  assert.deepEqual([...CATALOG_GROUPS], fromEntries)
})

test('findCatalogProvider / isCatalogProvider 行为一致', () => {
  const sample = BUILTIN_PROVIDERS[0]
  assert.equal(findCatalogProvider(sample.id), sample)
  assert.equal(isCatalogProvider(sample.id), true)
  assert.equal(findCatalogProvider('definitely-not-a-provider'), undefined)
  assert.equal(isCatalogProvider('definitely-not-a-provider'), false)
  assert.equal(findCatalogProvider(undefined), undefined)
})

test('目录覆盖用户最关心的几类服务商', () => {
  const ids = new Set(BUILTIN_PROVIDERS.map((p) => p.id))
  // 这些是国内/国际最常用的几类，缺失会让「内置提供商」这个功能名不副实。
  for (const required of ['deepseek', 'openai', 'anthropic', 'google', 'moonshot', 'zhipu', 'openrouter', 'ollama']) {
    assert.ok(ids.has(required), `目录缺少常用服务商：${required}`)
  }
})

test('模型建议值不含空白项且已去重', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    const seen = new Set()
    for (const model of provider.models) {
      assert.equal(typeof model, 'string')
      assert.equal(model, model.trim(), `${provider.id} 的模型 "${model}" 含首尾空白`)
      assert.ok(model.length > 0, `${provider.id} 含空的模型 ID`)
      assert.equal(seen.has(model), false, `${provider.id} 的模型列表含重复项 "${model}"`)
      seen.add(model)
    }
  }
})
