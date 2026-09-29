/**
 * 「直接填密钥」输入校验的测试。
 *
 * 这一层的价值几乎全在边界上：引用名会成为环境变量名与凭据文件的键，密钥值会被交给
 * 宿主的凭据服务。而这里最常见的错误不是「格式不对」，是**两栏填反**——把密钥粘进
 * 名字栏，或把名字粘进值栏。两者都必须在提交前挡住：前者会写出一批没法用的凭据名，
 * 后者会存进去一个假密钥、直到某次请求 401 才暴露（而那时人会先怀疑密钥失效）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_REF_LENGTH,
  MAX_SECRET_LENGTH,
  baseCredentialRefFor,
  suggestCredentialRef,
  validateCredentialRef,
  validateSecret,
} from '../lib/core/index.js'

test('合法引用名通过', () => {
  for (const ref of ['SENSENOVA_API_KEY', 'NVIDIA_API_KEY_2', 'a', 'A_1_b']) {
    const result = validateCredentialRef(ref)
    assert.equal(result.ok, true, `${ref} 应当通过`)
    assert.equal(result.ref, ref)
  }
})

test('引用名两侧空白被裁掉', () => {
  const result = validateCredentialRef('  NVIDIA_API_KEY \n')
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'NVIDIA_API_KEY')
})

test('引用名拒绝：空、非字符串、超长、形状非法', () => {
  assert.equal(validateCredentialRef('').ok, false)
  assert.equal(validateCredentialRef('   ').ok, false)
  assert.equal(validateCredentialRef(undefined).ok, false)
  assert.equal(validateCredentialRef(42).ok, false)
  assert.equal(validateCredentialRef('A'.repeat(MAX_REF_LENGTH + 1)).ok, false)
  // 连字符与点：这个名字还要能当环境变量名用，带这些字符不可移植
  assert.equal(validateCredentialRef('SENSE-NOVA_API_KEY').ok, false)
  assert.equal(validateCredentialRef('SENSENOVA.API_KEY').ok, false)
  assert.equal(validateCredentialRef('2KEY').ok, false)
})

test('引用名栏里填了密钥本体 → 明确拒绝并说清该怎么改', () => {
  const result = validateCredentialRef('sk-abcdefghijklmnopqrstuvwxyz123456')
  assert.equal(result.ok, false)
  assert.match(result.message, /密钥本体/)
  assert.match(result.message, /名字栏/)
})

test('引用名已存在不算错，但要标出来（UI 好提示「将覆盖」）', () => {
  const result = validateCredentialRef('NVIDIA_API_KEY', { existing: ['NVIDIA_API_KEY', 'OTHER_KEY'] })
  assert.equal(result.ok, true)
  assert.equal(result.exists, true)

  const fresh = validateCredentialRef('NEW_KEY', { existing: ['NVIDIA_API_KEY'] })
  assert.equal(fresh.exists, false)
})

test('合法密钥通过，两侧空白被裁掉', () => {
  const result = validateSecret('  sk-abcdefghijklmnopqrstuvwxyz  ')
  assert.equal(result.ok, true)
  assert.equal(result.value, 'sk-abcdefghijklmnopqrstuvwxyz')
})

test('密钥拒绝：空、非字符串、超长、内部带空白', () => {
  assert.equal(validateSecret('').ok, false)
  assert.equal(validateSecret('   ').ok, false)
  assert.equal(validateSecret(null).ok, false)
  assert.equal(validateSecret('x'.repeat(MAX_SECRET_LENGTH + 1)).ok, false)
  const spaced = validateSecret('sk-abc def')
  assert.equal(spaced.ok, false)
  assert.match(spaced.message, /空白/)
})

test('密钥栏里填了引用名 → 拒绝（两栏填反的另一半）', () => {
  for (const wrong of ['SENSENOVA_API_KEY', 'NVIDIA_API_KEY_2', 'MY_TOKEN', 'SOME_SECRET']) {
    const result = validateSecret(wrong)
    assert.equal(result.ok, false, `${wrong} 应当被拒绝`)
    assert.match(result.message, /引用名/)
  }
  // 但不能误伤真正的密钥：普通随机串不该被判成引用名
  assert.equal(validateSecret('aB3xY9zQ7w').ok, true)
})

test('suggestCredentialRef 优先返回未被占用的原名', () => {
  assert.equal(suggestCredentialRef('SENSENOVA_API_KEY', []), 'SENSENOVA_API_KEY')
  assert.equal(suggestCredentialRef('SENSENOVA_API_KEY', ['OTHER']), 'SENSENOVA_API_KEY')
})

test('suggestCredentialRef 按 _2 _3 递增，比较时忽略大小写', () => {
  assert.equal(suggestCredentialRef('SENSENOVA_API_KEY', ['SENSENOVA_API_KEY']), 'SENSENOVA_API_KEY_2')
  assert.equal(
    suggestCredentialRef('SENSENOVA_API_KEY', ['SENSENOVA_API_KEY', 'SENSENOVA_API_KEY_2']),
    'SENSENOVA_API_KEY_3',
  )
  // 大小写不同也算占用：两份只差大小写的名字只会让人日后认错
  assert.equal(suggestCredentialRef('NVIDIA_API_KEY', ['nvidia_api_key']), 'NVIDIA_API_KEY_2')
})

test('suggestCredentialRef 给不出建议时返回空串，而不是乱编一个', () => {
  assert.equal(suggestCredentialRef('', []), '')
  assert.equal(suggestCredentialRef(undefined, []), '')
  const used = Array.from({ length: 99 }, (_, i) => (i === 0 ? 'K_API_KEY' : `K_API_KEY_${i + 1}`))
  assert.equal(suggestCredentialRef('K_API_KEY', used), '')
})

test('baseCredentialRefFor 与宿主的 deriveKeyRef 规则保持一致', () => {
  assert.equal(baseCredentialRefFor('sensenova'), 'SENSENOVA_API_KEY')
  assert.equal(baseCredentialRefFor('nvidia'), 'NVIDIA_API_KEY')
  assert.equal(baseCredentialRefFor('minimax-cn'), 'MINIMAX_CN_API_KEY')
  assert.equal(baseCredentialRefFor('my.gw v2'), 'MY_GW_V2_API_KEY')
  assert.equal(baseCredentialRefFor(''), '')
})
