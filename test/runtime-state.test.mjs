/**
 * 状态持久化的测试。
 *
 * 持久化的价值全在「重启后还记得」，而它的风险全在「写坏了」——一个半截的
 * JSON 会让下次启动丢掉全部状态，一个抛出的异常会让插件起不来。这两点都要钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore, createStateStore, resolveDshHome, stateKey } from '../lib/runtime/state.js'

/** 造一个临时目录，测试结束清理。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'keypilot-test-'))
}

test('stateKey 用不可见分隔符避免 provider 与 ref 之间产生歧义', () => {
  assert.equal(stateKey('p', 'REF'), 'p\u0000REF')
  // 形如 a + b-c 与 a-b + c 不该撞到同一个键
  assert.notEqual(stateKey('a', 'b-c'), stateKey('a-b', 'c'))
})

test('存写读删的基本行为', () => {
  const store = new StateStore()
  store.set('k', { failures: 2 })
  assert.deepEqual(store.get('k'), { failures: 2 })
  assert.equal(store.has('k'), true)
  assert.equal(store.size, 1)
  store.delete('k')
  assert.equal(store.has('k'), false)
  assert.equal(store.size, 0)
})

test('轮询指针独立存取', () => {
  const store = new StateStore()
  assert.equal(store.cursorOf('p'), 0)
  store.setCursor('p', 3)
  assert.equal(store.cursorOf('p'), 3)
  // 非法值被忽略
  store.setCursor('p', -1)
  assert.equal(store.cursorOf('p'), 3)
  store.setCursor('p', Number.NaN)
  assert.equal(store.cursorOf('p'), 3)
})

test('落盘后能被重新载入', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    const first = new StateStore({ file })
    first.set('p\u0000A', { failures: 3, cooldownUntil: 12345 })
    first.setCursor('p', 2)
    assert.equal(first.flush(), true)
    assert.equal(existsSync(file), true)

    const second = new StateStore({ file })
    assert.equal(second.load(), true)
    assert.deepEqual(second.get('p\u0000A'), { failures: 3, cooldownUntil: 12345 })
    assert.equal(second.cursorOf('p'), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件不存在时载入失败但不抛出', () => {
  const dir = tempDir()
  try {
    const store = new StateStore({ file: join(dir, 'nope.json') })
    assert.equal(store.load(), false)
    assert.equal(store.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏的 JSON 被忽略且不抛出', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    writeFileSync(file, '{ this is not json')
    const warnings = []
    const store = new StateStore({ file, warn: (m) => warnings.push(m) })
    assert.equal(store.load(), false)
    assert.equal(store.size, 0)
    assert.equal(warnings.length, 1, '应当报告一次诊断')
    assert.match(warnings[0], /无法解析/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('结构不合法（非对象、字段类型错）时安全退化', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    // 这些都不是「一个状态文件对象」，应当被判为无效并退回空状态。
    for (const payload of ['null', '"text"', '42', '[]', '[1,2]', 'true']) {
      writeFileSync(file, payload)
      const store = new StateStore({ file })
      assert.equal(store.load(), false, `${payload} 应当被判定为无效`)
      assert.equal(store.size, 0)
    }
    // 这个是合法的状态对象，只是字段类型不对：应判为有效但忽略畸形字段。
    writeFileSync(file, '{"slots":"nope","cursors":[]}')
    const tolerant = new StateStore({ file })
    assert.equal(tolerant.load(), true, '合法对象但字段畸形时应宽容处理')
    assert.equal(tolerant.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('遍历时跳过畸形的槽位条目，保留合法的', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    writeFileSync(file, JSON.stringify({
      slots: { good: { failures: 1 }, bad: 'not-an-object', alsoBad: null },
      cursors: { a: 2, b: 'x', c: -5 },
    }))
    const store = new StateStore({ file })
    assert.equal(store.load(), true)
    assert.deepEqual(store.get('good'), { failures: 1 })
    assert.equal(store.has('bad'), false)
    assert.equal(store.cursorOf('a'), 2)
    assert.equal(store.cursorOf('b'), 0)
    assert.equal(store.cursorOf('c'), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录不存在时会自动创建', () => {
  const dir = tempDir()
  const file = join(dir, 'nested', 'deep', 'state.json')
  try {
    const store = new StateStore({ file })
    store.set('k', { failures: 1 })
    assert.equal(store.flush(), true)
    assert.equal(existsSync(file), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('落盘失败不抛出（例如路径指向一个目录）', () => {
  const dir = tempDir()
  try {
    const warnings = []
    // 把「文件」路径指向一个已存在的目录：writeFileSync 会失败。
    const store = new StateStore({ file: dir, warn: (m) => warnings.push(m) })
    store.set('k', { failures: 1 })
    assert.equal(store.flush(), false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /落盘失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未变更时不重复写盘', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    const store = new StateStore({ file })
    store.set('k', { failures: 1 })
    assert.equal(store.flush(), true)
    const before = readFileSync(file, 'utf8')
    // 没有新变更时，flush 是空操作
    assert.equal(store.flush(), true)
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('关闭时不留下临时文件', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    const store = new StateStore({ file })
    store.set('k', { failures: 1 })
    store.dispose()
    assert.equal(existsSync(file), true, '状态文件应当存在')
    assert.equal(existsSync(`${file}.tmp`), false, '临时文件应当被清理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prune 清理已不在配置里的条目', () => {
  const store = new StateStore()
  store.set('p\u0000A', { failures: 1 })
  store.set('p\u0000B', { failures: 1 })
  store.set('q\u0000C', { failures: 1 })
  const removed = store.prune(new Set(['p\u0000A']))
  assert.equal(removed, 2)
  assert.equal(store.size, 1)
  assert.equal(store.has('p\u0000A'), true)
})

test('未启用持久化时不写盘', () => {
  const store = createStateStore({ enabled: false })
  assert.equal(store.file, '')
  store.set('k', { failures: 1 })
  assert.equal(store.flush(), false)
})

test('createStateStore 在启用时会尝试载入既有文件', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  try {
    const first = new StateStore({ file })
    first.set('p\u0000A', { failures: 7 })
    first.flush()

    const restored = createStateStore({ file })
    assert.deepEqual(restored.get('p\u0000A'), { failures: 7 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveDshHome 优先采用 DSH_HOME 环境变量', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/custom/dsh-home'
    assert.equal(resolveDshHome(), '/custom/dsh-home')
    process.env.DSH_HOME = '   '
    // 空白值应被忽略并退回默认
    assert.notEqual(resolveDshHome(), '   ')
    delete process.env.DSH_HOME
    assert.ok(resolveDshHome().length > 0)
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})
