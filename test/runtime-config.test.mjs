/**
 * 配置归一化与持久化的测试。
 *
 * 最要紧的一条：**密钥本体不能被当成引用名写进配置**。那会让明文落到磁盘上的
 * JSON 文件里，而用户以为自己只是填了个名字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, createConfigStore, normalizeConfig, normalizeProviderEntry } from '../lib/runtime/config.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'keypilot-cfg-'))
}

test('空输入产出可用的默认配置', () => {
  const config = normalizeConfig({})
  assert.equal(config.enabled, true)
  assert.deepEqual(config.providers, [])
  assert.equal(config.routingStrategy, 'round-robin')
  assert.ok(config.switchKinds.includes('RATE_LIMIT'))
  assert.deepEqual(config.quotaResetWindow, { type: 'midnight_utc', hour: 0 })
})

test('非法输入一律退化到默认而不是抛出', () => {
  for (const value of [null, undefined, 'text', 42, [], true]) {
    const config = normalizeConfig(value)
    assert.equal(typeof config, 'object')
    assert.deepEqual(config.providers, [])
  }
})

test('提供商条目缺 provider 时被拒绝', () => {
  const result = normalizeProviderEntry({ keys: ['A'] })
  assert.equal(result.ok, false)
  assert.match(result.message, /缺少 provider/)
})

test('密钥栏里填密钥本体时整条被拒绝', () => {
  const result = normalizeProviderEntry({
    provider: 'deepseek',
    keys: ['sk-abcdefghijklmnopqrstuvwxyz'],
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /密钥本体|凭据引用名/)
})

test('密钥栏里填合法引用名时通过', () => {
  const result = normalizeProviderEntry({
    provider: 'deepseek',
    keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.provider.keys, ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'])
})

test('provider 名字里填密钥本体也被拒绝', () => {
  const result = normalizeProviderEntry({ provider: 'sk-live-abcdefghijklmnop', keys: [] })
  assert.equal(result.ok, false)
  assert.match(result.message, /provider 看起来是密钥本体/)
})

test('密钥去重、去空白，超量截断', () => {
  const many = Array.from({ length: 100 }, (_, i) => `KEY_${i}`)
  const result = normalizeProviderEntry({ provider: 'p', keys: ['A', 'A', '  ', 'B', ...many] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.provider.keys.slice(0, 3), ['A', 'B', 'KEY_0'])
  assert.ok(result.provider.keys.length <= 64)
})

test('数值被夹到合法区间', () => {
  const result = normalizeProviderEntry({
    provider: 'p',
    keys: [],
    rpmLimit: -5,
    cooldownMs: 10,
  })
  assert.equal(result.ok, true)
  assert.equal(result.provider.rpmLimit, 0, '负数夹到 0')
  assert.equal(result.provider.cooldownMs, 1000, '低于下限的夹到下限')
})

test('未知的调度策略回退到默认', () => {
  const result = normalizeProviderEntry({ provider: 'p', keys: [], routingStrategy: 'magic' })
  assert.equal(result.ok, true)
  assert.equal(result.provider.routingStrategy, 'round-robin')
})

test('过期时间接受 ISO 字符串与数字', () => {
  const iso = normalizeProviderEntry({ provider: 'p', keys: [], expiresAt: ['2030-01-01T00:00:00Z'] })
  assert.equal(iso.ok, true)
  assert.ok(iso.provider.expiresAt[0] > 0)

  const numeric = normalizeProviderEntry({ provider: 'p', keys: [], expiresAt: [1893456000000] })
  assert.equal(numeric.provider.expiresAt[0], 1893456000000)

  const garbage = normalizeProviderEntry({ provider: 'p', keys: [], expiresAt: ['不是日期'] })
  assert.equal(garbage.provider.expiresAt[0], 0)
})

test('路由声明合法时被保留并归一化', () => {
  const result = normalizeProviderEntry({
    provider: 'my-gw',
    keys: ['MY_KEY'],
    route: { id: 'my-gw', baseURL: 'https://gw.example.com/v1/', api: 'openai-completions', models: ['m'] },
  })
  assert.equal(result.ok, true)
  assert.equal(result.provider.route.baseURL, 'https://gw.example.com/v1', '尾部斜杠应被归一化')
  assert.deepEqual(result.provider.route.models, ['m'])
})

test('路由声明非法时整条被拒绝并说明原因', () => {
  const result = normalizeProviderEntry({
    provider: 'my-gw',
    keys: ['MY_KEY'],
    route: { id: 'my-gw', baseURL: '/relative', models: ['m'] },
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /相对路径/)
})

test('内置提供商的 route 可以只给 id', () => {
  const result = normalizeProviderEntry({
    provider: 'deepseek',
    keys: ['DEEPSEEK_API_KEY'],
    route: { id: 'deepseek' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.provider.route.baseURL, 'https://api.deepseek.com/v1')
  assert.ok(result.provider.route.models.length > 0)
})

test('重复的提供商条目被丢弃并记入 warnings', () => {
  const warnings = []
  const config = normalizeConfig({
    providers: [
      { provider: 'p', keys: ['A'] },
      { provider: 'p', keys: ['B'] },
    ],
  }, { warnings })
  assert.equal(config.providers.length, 1)
  assert.deepEqual(config.providers[0].keys, ['A'], '保留先出现的那条')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /重复/)
})

test('非法条目被跳过但不影响其他条目', () => {
  const warnings = []
  const config = normalizeConfig({
    providers: [
      { provider: 'good', keys: ['A'] },
      { keys: ['B'] },
      { provider: 'bad', keys: ['sk-tooleakwhatever1234567890'] },
      { provider: 'alsoGood', keys: ['C'] },
    ],
  }, { warnings })
  assert.deepEqual(config.providers.map((p) => p.provider), ['good', 'alsoGood'])
  assert.equal(warnings.length, 2)
})

test('布尔值接受字符串形式', () => {
  assert.equal(normalizeConfig({ enabled: 'false' }).enabled, false)
  assert.equal(normalizeConfig({ enabled: 'true' }).enabled, true)
  assert.equal(normalizeConfig({ enabled: 'nonsense' }).enabled, true, '无法解析时回退默认')
})

test('熔断参数被夹到区间内', () => {
  const high = normalizeConfig({ circuitBreakerThreshold: 9999 })
  assert.equal(high.circuitBreakerThreshold, 100)
  const low = normalizeConfig({ circuitBreakerThreshold: 0 })
  assert.equal(low.circuitBreakerThreshold, 1)
})

test('级联链被归一化并去重', () => {
  const config = normalizeConfig({
    cascade: [{ provider: 'a' }, { provider: 'a' }, { provider: '  ' }, { provider: 'b', model: 'm' }],
  })
  assert.deepEqual(config.cascade, [{ provider: 'a' }, { provider: 'b', model: 'm' }])
})

test('宿主的 Config 作为缺省值参与归一化', () => {
  const config = normalizeConfig({}, { base: { cooldownMs: 12345, providers: [{ provider: 'fromHost', keys: ['H'] }] } })
  assert.equal(config.cooldownMs, 12345)
  assert.deepEqual(config.providers.map((p) => p.provider), ['fromHost'])
})

test('插件文件里的值优先于宿主 Config', () => {
  const config = normalizeConfig(
    { cooldownMs: 7000 },
    { base: { cooldownMs: 12345 } },
  )
  assert.equal(config.cooldownMs, 7000)
})

test('ConfigStore 落盘后能重新载入', () => {
  const dir = tempDir()
  const file = join(dir, 'keypilot.json')
  try {
    const store = new ConfigStore({ file })
    const result = store.set({ providers: [{ provider: 'p', keys: ['K1'] }], cooldownMs: 5000 })
    assert.equal(result.ok, true)
    assert.equal(existsSync(file), true)

    const restored = new ConfigStore({ file })
    assert.equal(restored.load(), true)
    assert.equal(restored.get().cooldownMs, 5000)
    assert.deepEqual(restored.get().providers[0].keys, ['K1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ConfigStore 写入失败时返回错误而不是抛出', () => {
  const dir = tempDir()
  try {
    // 把文件路径指向已存在的目录 → 写入必失败。
    const store = new ConfigStore({ file: dir })
    const result = store.set({ cooldownMs: 1234 })
    assert.equal(result.ok, false)
    assert.match(result.message, /配置写入失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏的配置文件被忽略并退回宿主配置', () => {
  const dir = tempDir()
  const file = join(dir, 'keypilot.json')
  try {
    writeFileSync(file, '{ broken json')
    const warnings = []
    const store = new ConfigStore({ file, base: { cooldownMs: 9999 }, warn: (m) => warnings.push(m) })
    assert.equal(store.load(), false)
    assert.equal(store.get().cooldownMs, 9999, '应退回宿主配置')
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未启用持久化时不落盘', () => {
  const store = createConfigStore({ persist: false })
  assert.equal(store.file, '')
  assert.equal(store.set({ cooldownMs: 2000 }).ok, true)
  assert.equal(store.get().cooldownMs, 2000, '内存里仍然生效')
})

test('rebase：用户设过的字段保持，其余跟随新的宿主配置', () => {
  const store = new ConfigStore({ base: { cooldownMs: 1000, tpmLimit: 555 } })
  assert.equal(store.get().cooldownMs, 1000)
  assert.equal(store.get().tpmLimit, 555)

  // 用户显式设置了一个字段
  store.set({ cooldownMs: 2000 })
  assert.equal(store.get().cooldownMs, 2000)

  // 宿主配置变了
  store.rebase({ cooldownMs: 8000, tpmLimit: 999 })
  assert.equal(store.get().cooldownMs, 2000, '用户设过的值不该被宿主覆盖')
  assert.equal(store.get().tpmLimit, 999, '用户没设过的值应跟随宿主')
})

test('rebase：从未配置过时全部跟随宿主 Config', () => {
  const store = new ConfigStore({ base: { cooldownMs: 1000 } })
  store.rebase({ cooldownMs: 8000 })
  assert.equal(store.get().cooldownMs, 8000)
})

test('落盘记录「用户设过哪些字段」，重载后宿主配置仍能影响未覆盖字段', () => {
  const dir = tempDir()
  const file = join(dir, 'keypilot.json')
  try {
    const first = new ConfigStore({ file, base: { cooldownMs: 1000, tpmLimit: 555 } })
    // 只显式改一个字段
    first.set({ cooldownMs: 2000 })

    // 新实例 + 换了宿主配置
    const second = new ConfigStore({ file, base: { cooldownMs: 8000, tpmLimit: 777 } })
    assert.equal(second.load(), true)
    assert.equal(second.get().cooldownMs, 2000, '用户设过的字段应保持')
    assert.equal(second.get().tpmLimit, 777, '用户没设过的字段应跟随新宿主配置')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧格式（裸配置对象）被容忍并按「全部为用户设置」处理', () => {
  const dir = tempDir()
  const file = join(dir, 'keypilot.json')
  try {
    // 早期版本写的就是一份裸配置
    writeFileSync(file, JSON.stringify({ cooldownMs: 4321, providers: [{ provider: 'p', keys: ['K'] }] }))
    const store = new ConfigStore({ file, base: { cooldownMs: 1000 } })
    assert.equal(store.load(), true)
    assert.equal(store.get().cooldownMs, 4321, '旧格式的配置不该被宿主配置盖掉')
    assert.deepEqual(store.get().providers[0].keys, ['K'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('归一化结果里不含 warnings 字段（诊断不是配置）', () => {
  const config = normalizeConfig({
    providers: [{ keys: ['A'] }],
  })
  // 这条条目非法，会产生一条诊断；但它不该出现在配置对象里，
  // 否则会被一起落盘，下次载入时变成一个陌生字段。
  assert.equal('warnings' in config, false)
  assert.deepEqual(config.providers, [])
})

test('落盘内容里也没有 warnings 字段', () => {
  const dir = tempDir()
  const file = join(dir, 'keypilot.json')
  try {
    const store = new ConfigStore({ file })
    store.set({ providers: [{ keys: ['A'] }] })
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal('warnings' in parsed.config, false, '落盘的 config 里不该有 warnings')
    assert.equal(typeof parsed.set, 'object')
    assert.ok(Array.isArray(parsed.set))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('落盘的 JSON 里不含任何看起来像密钥的内容', () => {
  const dir = tempDir()
  const file = join(dir, 'keypilot.json')
  try {
    const store = new ConfigStore({ file })
    store.set({
      providers: [{ provider: 'deepseek', keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'] }],
    })
    const text = readFileSync(file, 'utf8')
    assert.equal(/sk-|Bearer /.test(text), false, `落盘内容不应出现密钥形态：${text.slice(0, 200)}`)
    assert.match(text, /DEEPSEEK_API_KEY/, '只应出现引用名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
