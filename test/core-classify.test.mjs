/**
 * 错误分类矩阵的测试。
 *
 * 分类错了会直接伤害用户：把「用户按停止」当成失败就会偷偷重试；把「请求非法」
 * 当成失败就会把所有密钥白撞一遍。因此这里逐条钉住判定结果。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SWITCH_KINDS,
  FAILURE_ACTION,
  FAILURE_KIND,
  classifyFailure,
  extractFailure,
  isEmptyResponse,
  isSwitchable,
} from '../lib/core/index.js'

/** 断言快捷方式。 */
function expectKind(error, kind, action = FAILURE_ACTION.SWITCH, soft = false) {
  const result = classifyFailure(error)
  assert.equal(result.kind, kind, `期望 ${kind}，实际 ${result.kind}（message=${result.message}）`)
  assert.equal(result.action, action)
  assert.equal(result.soft, soft)
  return result
}

test('HTTP 状态码映射', () => {
  expectKind({ status: 429, message: 'x' }, FAILURE_KIND.RATE_LIMIT)
  expectKind({ status: 401, message: 'x' }, FAILURE_KIND.AUTH)
  expectKind({ status: 403, message: 'x' }, FAILURE_KIND.AUTH)
  expectKind({ status: 404, message: 'x' }, FAILURE_KIND.UNKNOWN_MODEL)
  expectKind({ status: 408, message: 'x' }, FAILURE_KIND.TIMEOUT, FAILURE_ACTION.SWITCH, true)
  expectKind({ status: 425, message: 'x' }, FAILURE_KIND.RATE_LIMIT)
  expectKind({ status: 500, message: 'x' }, FAILURE_KIND.SERVER, FAILURE_ACTION.SWITCH, true)
  expectKind({ status: 502, message: 'x' }, FAILURE_KIND.SERVER, FAILURE_ACTION.SWITCH, true)
  expectKind({ status: 503, message: 'x' }, FAILURE_KIND.SERVER, FAILURE_ACTION.SWITCH, true)
  expectKind({ status: 504, message: 'x' }, FAILURE_KIND.TIMEOUT, FAILURE_ACTION.SWITCH, true)
  expectKind({ status: 529, message: 'x' }, FAILURE_KIND.SERVER, FAILURE_ACTION.SWITCH, true)
})

test('其余 4xx 视为请求本身有问题，不触发切换', () => {
  expectKind({ status: 400, message: 'x' }, FAILURE_KIND.BAD_REQUEST, FAILURE_ACTION.SURFACE)
  expectKind({ status: 422, message: 'x' }, FAILURE_KIND.BAD_REQUEST, FAILURE_ACTION.SURFACE)
  assert.equal(classifyFailure({ status: 400 }).switchable, false)
})

test('用户中断永远不触发切换', () => {
  // code 是 AbortSignal 的典型产物
  const byCode = classifyFailure({ code: 'ABORT_ERR', message: 'The operation was aborted' })
  assert.equal(byCode.kind, FAILURE_KIND.ABORTED)
  assert.equal(byCode.action, FAILURE_ACTION.ABORT)
  assert.equal(byCode.switchable, false)

  // 即使有人把它塞进 switchKinds，也不能被切换
  const forced = classifyFailure({ code: 'ABORTED', message: 'aborted' }, { switchKinds: ['ABORTED'] })
  assert.equal(forced.action, FAILURE_ACTION.ABORT)

  for (const text of ['Request aborted', 'user cancelled', 'cancelled by user', 'interrupted by user']) {
    const result = classifyFailure({ message: text })
    assert.equal(result.kind, FAILURE_KIND.ABORTED, `"${text}" 应被判为用户中断`)
  }
})

test('中断判定优先于其他规则', () => {
  // 文本里同时出现网络与中断关键词时，必须判为中断（否则会偷偷重试）
  const result = classifyFailure({ message: 'ECONNRESET after user cancel' })
  assert.equal(result.kind, FAILURE_KIND.ABORTED)
})

test('gRPC 状态码映射', () => {
  expectKind({ grpcStatus: 'RESOURCE_EXHAUSTED', message: 'x' }, FAILURE_KIND.QUOTA)
  expectKind({ grpcStatus: 8, message: 'x' }, FAILURE_KIND.QUOTA)
  expectKind({ grpcStatus: 'UNAVAILABLE', message: 'x' }, FAILURE_KIND.TRANSPORT, FAILURE_ACTION.SWITCH, true)
  expectKind({ grpcStatus: 'DEADLINE_EXCEEDED', message: 'x' }, FAILURE_KIND.TIMEOUT, FAILURE_ACTION.SWITCH, true)
  expectKind({ grpcStatus: 'UNAUTHENTICATED', message: 'x' }, FAILURE_KIND.AUTH)
  expectKind({ grpcStatus: 'PERMISSION_DENIED', message: 'x' }, FAILURE_KIND.AUTH)
})

test('传输层错误码映射', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET']) {
    expectKind({ code, message: 'y' }, FAILURE_KIND.TRANSPORT, FAILURE_ACTION.SWITCH, true)
  }
})

test('只有文本线索时的关键词判定', () => {
  expectKind(new Error('429 Too Many Requests'), FAILURE_KIND.RATE_LIMIT)
  expectKind(new Error('You exceeded your current quota, please check your plan'), FAILURE_KIND.QUOTA)
  expectKind(new Error('Incorrect API key provided'), FAILURE_KIND.AUTH)
  expectKind(new Error('The model `gpt-9` does not exist'), FAILURE_KIND.UNKNOWN_MODEL)
  expectKind(new Error('This model maximum context length is 8192 tokens'), FAILURE_KIND.BAD_REQUEST, FAILURE_ACTION.SURFACE)
  expectKind(new Error('The engine is currently overloaded, please try again later'), FAILURE_KIND.SERVER, FAILURE_ACTION.SWITCH, true)
  expectKind(new Error('socket hang up'), FAILURE_KIND.TRANSPORT, FAILURE_ACTION.SWITCH, true)
  expectKind(new Error('request timed out after 30s'), FAILURE_KIND.TIMEOUT, FAILURE_ACTION.SWITCH, true)
})

test('中文错误信息也能识别', () => {
  expectKind(new Error('账户余额不足，请充值'), FAILURE_KIND.QUOTA)
  expectKind(new Error('请求过于频繁，请稍后再试'), FAILURE_KIND.RATE_LIMIT)
  expectKind(new Error('鉴权失败：API Key 无效'), FAILURE_KIND.AUTH)
})

test('状态码优先于文本线索', () => {
  // 文本里有 "quota" 但状态码是 400：应以状态码为准（请求非法，不该换密钥）
  const result = classifyFailure({ status: 400, message: 'quota field missing in request' })
  assert.equal(result.kind, FAILURE_KIND.BAD_REQUEST)
  assert.equal(result.action, FAILURE_ACTION.SURFACE)
})

test('完全未知的错误默认可切换（保守地给一次重试机会）', () => {
  const result = classifyFailure({ message: 'something inexplicable happened' })
  assert.equal(result.kind, FAILURE_KIND.UNKNOWN)
  assert.equal(result.action, FAILURE_ACTION.SWITCH, '默认应允许换一把密钥试试')
})

test('可自定义允许切换的性质集合', () => {
  const result = classifyFailure({ message: 'unknown thing' }, { switchKinds: [FAILURE_KIND.RATE_LIMIT] })
  assert.equal(result.kind, FAILURE_KIND.UNKNOWN)
  assert.equal(result.action, FAILURE_ACTION.SURFACE)
})

test('空 switchKinds 回退到默认集合而不是什么都不切', () => {
  const result = classifyFailure({ status: 429, message: 'x' }, { switchKinds: [] })
  assert.equal(result.action, FAILURE_ACTION.SWITCH)
  assert.ok(DEFAULT_SWITCH_KINDS.includes(FAILURE_KIND.RATE_LIMIT))
})

test('extractFailure 能从嵌套结构里捞出字段', () => {
  const extracted = extractFailure({
    failure: { status: 429, code: 'RATE_LIMIT', message: 'slow down' },
  })
  assert.equal(extracted.status, 429)
  assert.equal(extracted.code, 'RATE_LIMIT')
  assert.equal(extracted.message, 'slow down')
})

test('extractFailure 认得 statusCode / errno 等别名', () => {
  assert.equal(extractFailure({ statusCode: 503 }).status, 503)
  assert.equal(extractFailure({ httpStatus: 401 }).status, 401)
  assert.equal(extractFailure({ errno: 'ECONNRESET' }).code, 'ECONNRESET')
})

test('extractFailure 对循环引用与深层嵌套不炸', () => {
  const a = { message: 'boom' }
  a.cause = a
  assert.equal(extractFailure(a).message, 'boom')

  let deep = { message: 'deep' }
  for (let i = 0; i < 10; i += 1) deep = { error: deep }
  assert.equal(typeof extractFailure(deep).message, 'string')
})

test('extractFailure 对非对象输入不抛出', () => {
  for (const value of [null, undefined, 42, 'plain text', true]) {
    const result = extractFailure(value)
    assert.equal(typeof result.message, 'string')
  }
})

test('状态码超出 HTTP 范围时不当作状态码', () => {
  assert.equal(extractFailure({ status: 999 }).status, undefined)
  assert.equal(extractFailure({ status: 99 }).status, undefined)
  assert.equal(extractFailure({ status: 'oops' }).status, undefined)
})

test('isSwitchable 便捷判断与 classifyFailure 一致', () => {
  assert.equal(isSwitchable({ status: 429 }), true)
  assert.equal(isSwitchable({ status: 400 }), false)
  assert.equal(isSwitchable({ code: 'ABORT_ERR' }), false)
})

test('isEmptyResponse 只在完全没有内容时成立', () => {
  assert.equal(isEmptyResponse({ chunks: 0, sawContent: false }), true)
  assert.equal(isEmptyResponse({ sawContent: false }), true)
  assert.equal(isEmptyResponse({ chunks: 0, sawContent: true }), false)
  assert.equal(isEmptyResponse({ chunks: 5, sawContent: true }), false)
  assert.equal(isEmptyResponse(null), false)
  assert.equal(isEmptyResponse(undefined), false)
})
