/**
 * 自定义路由的适配器装配测试。
 *
 * 这里的核心不变量只有一条：**交给 pi-ai 的模型描述必须条条可用**。
 *
 * 宿主在 `LlmRuntime.listModels()` 里逐条校验每个模型（`dsh-llm/lib/index.js`）：
 * `provider` 必须等于被查询的路由、`id` 与 `name` 都必须是非空字符串、`id` 不能
 * 重复。任何一条不合格，整条路由报
 * `adapter returned invalid or duplicate model metadata for provider "..."`——
 * 模型选择器里这一家直接「加载失败」，密钥池再满也救不回来，因为失败发生在模型
 * 目录层而不是请求层。
 *
 * 设置里的模型列表是**字符串数组**（`Schema.array(Schema.string())`），而 pi-ai
 * 要的是对象。这两种形态之间的转换曾经漏掉：字符串被当成对象取 `.id`，于是每条
 * 模型的 id/name 都是 `undefined`，一条路由整体报废。下面第一条测试就是钉住它。
 *
 * 本文件不加载真实宿主模块（测试要能在任何机器上跑），而是用一个最小的
 * `createProvider` 替身把「交给 pi-ai 的东西」原样截获下来，再套用宿主的校验规则。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCustomAdapter } from '../lib/runtime/custom-routes.js'

/**
 * 最小 pi-ai 替身：`createProvider` 只保留真实实现里对本测试有意义的部分
 * （`pi-ai/dist/models.js` 的 `getModels` 就是把 `models` 原样交出来），
 * 并把入参截获下来供断言。
 */
function stubRuntime() {
  const built = []
  return {
    built,
    runtime: {
      createProvider: (input) => {
        built.push(input)
        return {
          id: input.id,
          name: input.name,
          getModels: () => input.models,
        }
      },
      PiAiAdapter: class {
        constructor(config) {
          this.config = config
        }
      },
      apiFactories: {
        'openai-completions': () => ({ stream() {} }),
        'openai-responses': () => ({ stream() {} }),
      },
    },
  }
}

/** 路由声明的归一化结果：`models` 是字符串数组。 */
function route(overrides = {}) {
  return {
    id: 'sensenova',
    displayName: '商汤日日新',
    baseURL: 'https://token.sensenova.cn/v1',
    api: 'openai-responses',
    models: ['deepseek-v4-flash', 'glm-5.2'],
    ...overrides,
  }
}

/**
 * 宿主的模型目录校验，逐字复刻 `dsh-llm/lib/index.js` 的 `listModels()`。
 *
 * @param {object[]} models 适配器交出的模型元数据
 * @param {string} provider 被查询的路由
 */
function assertHostCatalogValid(models, provider) {
  const seen = new Set()
  for (const model of models) {
    const invalid = typeof model.provider !== 'string' || model.provider !== provider
      || typeof model.id !== 'string' || model.id.length === 0
      || typeof model.name !== 'string' || model.name.length === 0
      || (model.description !== undefined && typeof model.description !== 'string')
      || seen.has(model.id)
    assert.equal(
      invalid,
      false,
      `adapter returned invalid or duplicate model metadata for provider "${provider}"（收到 ${JSON.stringify(model)}）`,
    )
    seen.add(model.id)
  }
}

test('字符串模型列表 → 每条模型都有可用的 id 与 name（回归：曾经是 undefined）', () => {
  const { runtime, built } = stubRuntime()
  buildCustomAdapter({ runtime, provider: 'sensenova', route: route(), resolveApiKey: async () => 'k' })

  assert.equal(built.length, 1, 'createProvider 应当被调用一次')
  const models = built[0].models
  assert.deepEqual(models.map((m) => m.id), ['deepseek-v4-flash', 'glm-5.2'])
  assert.deepEqual(models.map((m) => m.name), ['deepseek-v4-flash', 'glm-5.2'])
  assertHostCatalogValid(models, 'sensenova')
})

test('模型 id 与 name 都是字符串，且 provider 归属正确', () => {
  const { runtime, built } = stubRuntime()
  buildCustomAdapter({ runtime, provider: 'sensenova', route: route(), resolveApiKey: async () => 'k' })

  for (const model of built[0].models) {
    assert.equal(typeof model.id, 'string')
    assert.equal(typeof model.name, 'string')
    assert.equal(model.provider, 'sensenova')
    // 模型自己指回路由的端点与协议，否则 pi-ai 会去猜。
    assert.equal(model.api, 'openai-responses')
    assert.equal(model.baseUrl, 'https://token.sensenova.cn/v1')
  }
})

test('对象形态的模型项仍然可用（name / contextWindow / maxTokens / supportsImages）', () => {
  const { runtime, built } = stubRuntime()
  buildCustomAdapter({
    runtime,
    provider: 'my-gw',
    route: route({
      id: 'my-gw',
      api: 'openai-completions',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 200_000, maxTokens: 16_384, supportsImages: true },
        { id: 'plain' },
      ],
    }),
    resolveApiKey: async () => 'k',
  })

  const [rich, plain] = built[0].models
  assert.equal(rich.name, 'GPT-4o')
  assert.equal(rich.contextWindow, 200_000)
  assert.equal(rich.maxTokens, 16_384)
  assert.deepEqual(rich.input, ['text', 'image'])
  // 只给 id 时 name 退回 id，而不是留空——空 name 会让整条路由加载失败。
  assert.equal(plain.name, 'plain')
  assert.deepEqual(plain.input, ['text'])
  assertHostCatalogValid(built[0].models, 'my-gw')
})

test('空模型列表不产生任何模型，也不抛出', () => {
  const { runtime, built } = stubRuntime()
  buildCustomAdapter({ runtime, provider: 'my-gw', route: route({ models: [] }), resolveApiKey: async () => 'k' })
  assert.deepEqual(built[0].models, [])
})

test('模型 id 两端的空白被去掉', () => {
  const { runtime, built } = stubRuntime()
  buildCustomAdapter({
    runtime,
    provider: 'my-gw',
    route: route({ models: ['  gpt-4o  '] }),
    resolveApiKey: async () => 'k',
  })
  assert.equal(built[0].models[0].id, 'gpt-4o')
  assertHostCatalogValid(built[0].models, 'my-gw')
})

test('宿主未提供该协议时抛出可读错误，而不是静默注册一条死路由', () => {
  const { runtime } = stubRuntime()
  assert.throws(
    () => buildCustomAdapter({
      runtime,
      provider: 'my-gw',
      route: route({ api: 'anthropic-messages' }),
      resolveApiKey: async () => 'k',
    }),
    /本宿主不提供 anthropic-messages 协议/,
  )
})

test('update() 就地重建模型列表，无需重新注册', () => {
  const { runtime, built } = stubRuntime()
  const { update } = buildCustomAdapter({
    runtime,
    provider: 'sensenova',
    route: route(),
    resolveApiKey: async () => 'k',
  })

  update(route({ models: ['kimi-k3'] }))
  assert.equal(built.length, 2, 'update 应当再装配一次 provider')
  assert.deepEqual(built[1].models.map((m) => m.id), ['kimi-k3'])
  assertHostCatalogValid(built[1].models, 'sensenova')
})
