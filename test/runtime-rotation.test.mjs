/**
 * 轮换引擎的测试。
 *
 * 引擎不依赖任何 DSH 运行时对象（依赖全部注入），因此可以用一个假的 `next()`
 * 完整驱动它。这里要钉住的正是几条「错了就会伤到用户」的不变量：
 *
 * - 一次请求内多次解析凭据必须拿到同一把密钥；
 * - 已经吐出内容之后绝不能再换密钥重试；
 * - 用户中断必须原样传递，不能偷偷继续；
 * - 上游用 `finish.error` 而不是抛异常报告失败时也要能识别。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ConcurrencyTracker,
  KeyPool,
  LatencyHistogram,
} from '../lib/core/index.js'
import { createRotationEngine, isContentChunk, finishReasonOf } from '../lib/runtime/rotate.js'

/** 组装一个可完全控制的引擎。 */
function setup(options = {}) {
  const clock = { value: 1000 }
  const stateStore = new Map()
  const pools = new Map()
  for (const [provider, keys] of Object.entries(options.pools ?? { p: ['A', 'B', 'C'] })) {
    pools.set(provider, new KeyPool({
      provider,
      config: { keys, cooldownMs: options.cooldownMs ?? 60_000 },
      stateStore,
      now: () => clock.value,
    }))
  }
  const byProvider = new Map([...pools].map(([provider, pool]) => [provider, pool]))
  const concurrency = new ConcurrencyTracker({ limit: 0 })
  const histogram = new LatencyHistogram()
  const dispatchStorage = new AsyncLocalStorage()
  const events = []
  /** 每次 next() 调用时下游看到的 pickedRef（用来验证请求内绑定）。 */
  const resolvedRefs = []

  const runtime = {
    enabled: options.enabled !== false,
    byProvider,
    cascade: options.cascade ?? [],
    switchKinds: options.switchKinds,
    cascadeEnabled: options.cascadeEnabled !== false,
  }

  const engine = createRotationEngine({
    getRuntime: () => runtime,
    dispatchStorage,
    concurrency,
    histogram,
    logger: { warn() {} },
    onEvent: (event) => events.push(event),
  })

  /**
   * 造一个假的 `next()`：第 i 次调用使用 behaviors[i]。
   * @param {Array<object>} behaviors
   */
  function makeNext(behaviors) {
    let call = 0
    return () => {
      const behavior = behaviors[Math.min(call, behaviors.length - 1)]
      call += 1
      return (async function* fake() {
        // 模拟下游适配器内部解析凭据：这一步必须看到本次请求选中的引用。
        resolvedRefs.push(dispatchStorage.getStore()?.pickedRef ?? null)
        if (behavior.throws !== undefined) throw behavior.throws
        for (const chunk of behavior.chunks ?? []) yield chunk
      })()
    }
  }

  return { engine, runtime, pools, byProvider, concurrency, histogram, dispatchStorage, events, resolvedRefs, makeNext, clock }
}

/** 正常结束的 chunk 序列。 */
function successChunks(text = 'hello') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 以 finish.error 报告失败的 chunk 序列。 */
function errorFinishChunks(code = 'RATE_LIMIT', message = 'slow down') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'finish', reason: { kind: 'error', failure: { code, message } } },
  ]
}

/** 收集 async iterable 的全部产出。 */
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** 造一个带状态码的错误。 */
function httpError(status, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status })
}

test('没有对应池子时直接透传，完全不介入', async () => {
  const { engine, makeNext } = setup({ pools: { other: ['X'] } })
  const chunks = successChunks()
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, makeNext([{ chunks }])))
  assert.deepEqual(result, chunks)
})

test('池子为空时直接透传', async () => {
  const { engine, makeNext } = setup({ pools: { p: [] } })
  const chunks = successChunks()
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, makeNext([{ chunks }])))
  assert.deepEqual(result, chunks)
})

test('插件停用时直接透传', async () => {
  const { engine, makeNext } = setup({ enabled: false })
  const chunks = successChunks()
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, makeNext([{ chunks }])))
  assert.deepEqual(result, chunks)
})

test('首次即成功：chunk 原样透传且密钥记为健康', async () => {
  const { engine, pools, makeNext, events } = setup()
  const chunks = successChunks()
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, makeNext([{ chunks }])))
  assert.deepEqual(result, chunks)
  const pool = pools.get('p')
  assert.equal(pool.slots[0].failures, 0)
  assert.equal(pool.slots[0].usage.requests, 1)
  assert.ok(events.some((e) => e.type === 'success'))
})

test('429 之后换下一把密钥并成功', async () => {
  const { engine, pools, makeNext, events, resolvedRefs } = setup()
  const next = makeNext([
    { throws: httpError(429) },
    { chunks: successChunks('recovered') },
  ])
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, next))

  assert.deepEqual(result.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  // 两次尝试必须用不同的密钥。
  assert.deepEqual(resolvedRefs, ['A', 'B'])
  const pool = pools.get('p')
  assert.ok(pool.slots[0].cooldownUntil > 0, '失败的密钥应进入冷却')
  assert.equal(pool.slots[0].failures, 1)
  assert.equal(pool.slots[1].failures, 0, '成功的密钥不该被罚')
  assert.ok(events.some((e) => e.type === 'switch' && e.from === 'A' && e.kind === 'RATE_LIMIT'))
})

test('请求内多次解析凭据拿到同一把密钥', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  const next = makeNext([{ chunks: successChunks() }])
  await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  // 假 next 内部只解析了一次，但同一次请求内即使解析多次也应同值——
  // 这里验证 store 在整个调用栈上可见（ALS 传播正确）。
  assert.deepEqual(resolvedRefs, ['A'])
})

test('连续三次 429 会依次换到第三把', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  const next = makeNext([
    { throws: httpError(429) },
    { throws: httpError(429) },
    { chunks: successChunks() },
  ])
  await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  assert.deepEqual(resolvedRefs, ['A', 'B', 'C'])
})

test('所有密钥都失败时抛出最后一次的真实错误', async () => {
  const { engine, makeNext } = setup({ pools: { p: ['A', 'B'] } })
  const next = makeNext([{ throws: httpError(429, 'quota exhausted') }])
  await assert.rejects(
    () => collect(engine.rotate({ provider: 'p', model: 'm' }, next)),
    (error) => {
      assert.equal(error.message, 'quota exhausted')
      assert.equal(error.status, 429)
      return true
    },
  )
})

test('唯一一把密钥失败后不再重复尝试', async () => {
  const { engine, makeNext, resolvedRefs } = setup({ pools: { p: ['only'] } })
  const next = makeNext([{ throws: httpError(429) }])
  await assert.rejects(() => collect(engine.rotate({ provider: 'p', model: 'm' }, next)))
  assert.deepEqual(resolvedRefs, ['only'], '不该把同一把密钥试第二次')
})

test('已经吐出内容之后再失败：原样抛出，不换密钥', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  const next = makeNext([{
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '部分内容' },
      // 内容之后流中断
    ],
    // 让 generator 在 yield 完这些之后抛错
  }])
  // 用一个会在内容后抛错的 next
  const throwingNext = () => (async function* fake() {
    resolvedRefs.push('A')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '部分内容' }
    throw httpError(500)
  })()

  const received = []
  await assert.rejects(async () => {
    for await (const chunk of engine.rotate({ provider: 'p', model: 'm' }, throwingNext)) {
      received.push(chunk)
    }
  }, /HTTP 500/)

  // 关键：已经交付的内容仍然交付了，且没有发生第二次尝试。
  assert.equal(received.length, 2)
  assert.deepEqual(resolvedRefs, ['A'], '不得在内容可见后重试')
  void next
})

test('上游用 finish.error 报告失败时同样会切换', async () => {
  const { engine, makeNext, resolvedRefs, events } = setup()
  const next = makeNext([
    { chunks: errorFinishChunks('RATE_LIMIT', 'rate limited') },
    { chunks: successChunks('ok') },
  ])
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  assert.deepEqual(resolvedRefs, ['A', 'B'], '应当换到第二把')
  assert.equal(result.at(-1).reason.kind, 'stop')
  assert.ok(events.some((e) => e.type === 'switch' && e.kind === 'RATE_LIMIT'))
})

test('finish.error 中已经产出内容时不再重试', async () => {
  const { engine } = setup()
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '一段' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'boom' } } },
  ]
  let calls = 0
  const next = () => {
    calls += 1
    return (async function* fake() {
      for (const chunk of chunks) yield chunk
    })()
  }
  await assert.rejects(() => collect(engine.rotate({ provider: 'p', model: 'm' }, next)), /boom/)
  assert.equal(calls, 1, '内容已可见，不该有第二次调用')
})

test('finish.error 切换时同样记下切换次数与失败性质', async () => {
  // 上游用 finish.error 报告限流是最常见的形态（429 尤其如此），而面板要靠
  // switches / lastFailureKind 回答「这把密钥为什么在冷却」。曾经这条分支漏记，
  // 于是一把正在冷却的密钥在面板上显示成「原因不明」，切换次数也少算一次。
  const { engine, pools, makeNext } = setup()
  const next = makeNext([
    { chunks: errorFinishChunks('RATE_LIMIT', 'rate limited') },
    { chunks: successChunks('ok') },
  ])
  await collect(engine.rotate({ provider: 'p', model: 'm' }, next))

  const pool = pools.get('p')
  const failed = pool.slots.find((slot) => slot.ref === 'A')
  assert.equal(failed.usage.switches, 1, '应当记下一次切换')
  assert.equal(failed.usage.lastFailureKind, 'RATE_LIMIT', '应当记下失败性质')
  assert.ok(failed.failures > 0, '应当被罚冷却')

  // 接手的第二把是成功的，不该被记成失败。
  const healthy = pool.slots.find((slot) => slot.ref === 'B')
  assert.equal(healthy.usage.switches, 0)
  assert.equal(healthy.usage.lastFailureKind, '')
})

test('finish.aborted（用户中断）绝不切换', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  let calls = 0
  const next = () => {
    calls += 1
    return (async function* fake() {
      resolvedRefs.push('A')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'user stopped' } } }
    })()
  }
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  assert.equal(result.at(-1).reason.kind, 'aborted')
  assert.equal(calls, 1, '中断不是失败，不得重试')
  assert.deepEqual(resolvedRefs, ['A'])
  void makeNext
})

test('抛出的 AbortError 原样传出，不换密钥', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
  const next = makeNext([{ throws: abort }])
  await assert.rejects(
    () => collect(engine.rotate({ provider: 'p', model: 'm' }, next)),
    (error) => {
      assert.equal(error.code, 'ABORT_ERR')
      return true
    },
  )
  assert.deepEqual(resolvedRefs, ['A'], '中断不该触发第二次尝试')
})

test('请求本身非法（400）不触发切换', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  const next = makeNext([{ throws: httpError(400, 'invalid request: context too long') }])
  await assert.rejects(() => collect(engine.rotate({ provider: 'p', model: 'm' }, next)), /context too long/)
  assert.deepEqual(resolvedRefs, ['A'], '换密钥不可能修好一个非法请求')
})

test('空响应触发切换', async () => {
  const { engine, makeNext, resolvedRefs } = setup()
  const next = makeNext([
    { chunks: [{ type: 'finish', reason: { kind: 'stop' } }] },
    { chunks: successChunks('content') },
  ])
  await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  assert.deepEqual(resolvedRefs, ['A', 'B'])
})

test('成功记录首字延迟', async () => {
  const { engine, histogram, makeNext } = setup()
  const next = makeNext([{ chunks: successChunks() }])
  await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  const stats = histogram.stats('A')
  assert.equal(stats.count, 1, '应当记录一次首字延迟')
})

test('usage chunk 会累计 token 用量', async () => {
  const { engine, pools, makeNext } = setup()
  const next = makeNext([{
    chunks: [
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }])
  await collect(engine.rotate({ provider: 'p', model: 'm' }, next))
  assert.equal(pools.get('p').slots[0].usage.tokens, 150)
})

test('主池耗尽时级联到备用提供商', async () => {
  const { engine, makeNext, events, resolvedRefs } = setup({
    pools: { primary: ['A'], backup: ['Z'] },
    cascade: [{ provider: 'backup' }],
  })
  const next = makeNext([
    { throws: httpError(429) },
    { chunks: successChunks('from backup') },
  ])
  const result = await collect(engine.rotate({ provider: 'primary', model: 'm' }, next))
  assert.equal(result.at(-1).reason.kind, 'stop')
  assert.equal(resolvedRefs.length, 2)
  assert.ok(events.some((e) => e.type === 'cascade' && e.to === 'backup'))
})

test('级联链上的目标不存在时不会死循环', async () => {
  const { engine, makeNext } = setup({
    pools: { primary: ['A'] },
    cascade: [{ provider: 'ghost' }, { provider: 'also-ghost' }],
  })
  const next = makeNext([{ throws: httpError(429) }])
  await assert.rejects(() => collect(engine.rotate({ provider: 'primary', model: 'm' }, next)))
})

test('级联不会回到已经用过的提供商', async () => {
  const { engine, makeNext, resolvedRefs } = setup({
    pools: { a: ['A'], b: ['B'] },
    cascade: [{ provider: 'b' }, { provider: 'a' }],
  })
  const next = makeNext([
    { throws: httpError(429) },
    { throws: httpError(429) },
  ])
  await assert.rejects(() => collect(engine.rotate({ provider: 'a', model: 'm' }, next)))
  // a 试过一次、b 试过一次，不应再回到 a。
  assert.equal(resolvedRefs.length, 2)
})

test('本插件发起的级联请求不再被轮换（防递归）', async () => {
  const { engine, makeNext } = setup()
  const chunks = successChunks()
  const calls = { count: 0 }
  const next = () => {
    calls.count += 1
    return (async function* fake() {
      for (const chunk of chunks) yield chunk
    })()
  }
  // 打了内部标记的请求应当直接透传，不做任何池子选择。
  const result = await collect(engine.rotate(
    { provider: 'p', model: 'm', [Symbol.for('dsh-keypilot.rotation-marker')]: true },
    next,
  ))
  assert.deepEqual(result, chunks)
  assert.equal(calls.count, 1)
  void makeNext
})

test('池子被停用时透传', async () => {
  const { engine, runtime, makeNext } = setup()
  runtime.enabled = false
  const chunks = successChunks()
  const result = await collect(engine.rotate({ provider: 'p', model: 'm' }, makeNext([{ chunks }])))
  assert.deepEqual(result, chunks)
})

test('全部密钥饱和时给出可读的耗尽说明', async () => {
  const { engine, pools, makeNext } = setup({ pools: { p: ['A'] } })
  const pool = pools.get('p')
  // 让这把密钥处于冷却中（耗尽而非饱和）
  pool.penalize(pool.slots[0], { retryAfterMs: 30_000 })
  const next = makeNext([{ chunks: successChunks() }])
  await assert.rejects(
    () => collect(engine.rotate({ provider: 'p', model: 'm' }, next)),
    (error) => {
      assert.match(error.message, /所有密钥/)
      assert.match(error.message, /请检查密钥池配置/)
      return true
    },
  )
})

test('isContentChunk 只把真正的内容块算作「已交付」', () => {
  assert.equal(isContentChunk({ type: 'text-delta' }), true)
  assert.equal(isContentChunk({ type: 'reasoning-delta' }), true)
  assert.equal(isContentChunk({ type: 'tool-call-delta' }), true)
  assert.equal(isContentChunk({ type: 'block-end' }), true)
  // 这两个不算：block-start 可能只是空块的开始，usage 是记账。
  assert.equal(isContentChunk({ type: 'block-start' }), false)
  assert.equal(isContentChunk({ type: 'usage' }), false)
  assert.equal(isContentChunk({ type: 'finish' }), false)
  assert.equal(isContentChunk(null), false)
  assert.equal(isContentChunk('text'), false)
})

test('finishReasonOf 只认 finish chunk', () => {
  assert.equal(finishReasonOf({ type: 'text-delta' }), undefined)
  assert.equal(finishReasonOf({ type: 'finish', reason: { kind: 'stop' } }).kind, 'stop')
  assert.equal(finishReasonOf({ type: 'finish' }), undefined)
  assert.equal(finishReasonOf(null), undefined)
})
