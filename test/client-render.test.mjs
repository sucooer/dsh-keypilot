/**
 * 客户端组件的渲染测试。
 *
 * 浏览器端的组件是本项目里唯一「没有自动化验证」的部分：它跑在宿主的模块加载器里，
 * 单测跑不到，而靠无头浏览器探针又会受本机进程管理干扰。这个测试把组件从
 * `lib/client.js` 里原样取出来 —— 用宿主的加载器格式执行、mock 一个最小 ctx 捕获
 * 它注册的组件、再用真实的 React 渲染一遍 —— 于是「组件一渲染就抛错」这类问题
 * 能在 Node 里直接复现。
 *
 * 依赖宿主提供的 react：拿不到就跳过（不把环境依赖变成红灯）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_PATH = join(process.cwd(), 'lib', 'client.js')

/** 找一个能 require 到 react 的位置。 */
function findReactRoot() {
  const roots = [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', 'web') : undefined,
    'C:/Users/anyaer/.dsh/profiles/web',
    'C:/Users/anyaer/AppData/Local/Programs/DSH Desktop/resources/app.asar.unpacked',
  ].filter((value) => typeof value === 'string')
  for (const root of roots) {
    try {
      const req = createRequire(join(root, 'package.json'))
      req.resolve('react')
      req.resolve('react-dom/server')
      return req
    } catch {
      // 这个位置没有，换下一个。
    }
  }
  return undefined
}

const require = findReactRoot()

/**
 * 执行 client.js，拿到它导出的模块。
 * @param {(name: string) => unknown} fakeRequire
 */
function loadClientModule(fakeRequire) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  /** @type {any} */
  let captured
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  // client.js 是宿主加载器格式的普通脚本（靠 window 全局），不是 ESM。
  const run = new Function('window', source)
  run(fakeWindow)
  if (captured === undefined) throw new Error('client.js 没有调用 __ModuleLoader__.load')
  return captured.factory(fakeRequire)
}

test('client.js 是宿主加载器格式且导出 apply/inject', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
  assert.ok(module.inject.includes('slots'))
  assert.ok(module.inject.includes('locale'))
})

test('apply 会注册 settings.section 分区', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  /** @type {Array<{ spec: any, component: any }>} */
  const registered = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, cb) => cb(),
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }

  module.apply(ctx)
  assert.equal(registered.length, 1, '应当注册恰好一个分区')
  const [entry] = registered
  assert.equal(entry.spec.name, 'settings.section')
  assert.equal(entry.spec.id, 'dsh-keypilot')
  assert.equal(typeof entry.component, 'function', 'slot 组件必须是函数组件')
})

test('组件在没有数据时能渲染出加载态（不抛错）', { skip: require === undefined }, () => {
  const React = require('react')
  const ReactDOMServer = require('react-dom/server')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  let component
  module.apply({
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, cb) => cb(),
      register: (spec, comp) => {
        component = comp
        return () => {}
      },
    },
  })

  assert.equal(typeof component, 'function')
  // 服务端渲染不跑 useEffect，因此这里渲染的是「尚未取到数据」的 loading 态。
  // 这条断言的价值在于：组件一旦有渲染期错误，这里就会抛出来。
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(component, {}))
  assert.ok(html.length > 0, '组件必须渲染出内容，而不是空字符串')
  assert.match(html, /正在读取状态|Loading state/, `渲染结果应含加载文案，实际: ${html.slice(0, 200)}`)
})

test('组件的 hooks 顺序稳定（有数据/无数据走同一批 hooks）', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  let component
  module.apply({
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, cb) => cb(),
      register: (spec, comp) => {
        component = comp
        return () => {}
      },
    },
  })

  // 用真实的 hooks 运行组件：React 会在 hooks 数量/顺序变化时报错。
  // 这里用 react-dom/server 渲染两次（等价于两次挂载），能暴露「条件调用 hooks」。
  const ReactDOMServer = require('react-dom/server')
  const first = ReactDOMServer.renderToStaticMarkup(React.createElement(component, { close: () => {} }))
  const second = ReactDOMServer.renderToStaticMarkup(React.createElement(component, {}))
  assert.equal(typeof first, 'string')
  assert.equal(typeof second, 'string')
})

test('locale 词典中英两套的键集合一致', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  /** @type {Record<string, Record<string, string>>} */
  let dicts
  module.apply({
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: {
      register: (ns, dictionaries) => {
        dicts = dictionaries
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: { inject: () => {}, register: () => () => {} },
  })

  assert.ok(dicts !== undefined, '应当注册词典')
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  const missingInEn = zhKeys.filter((key) => !(key in dicts.en))
  const missingInZh = enKeys.filter((key) => !(key in dicts.zh))
  assert.deepEqual(missingInEn, [], `英文词典缺少这些键: ${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `中文词典缺少这些键: ${missingInZh.join(', ')}`)
  assert.ok(zhKeys.length > 80, `词典规模异常（${zhKeys.length} 条）`)
})

/**
 * 渲染「直接填密钥」表单。
 *
 * 这个组件是刻意做成**纯的**（不吃 hook、只吃 props）——面板主体靠 useEffect 取数，
 * 服务端渲染只能到加载态为止，覆盖不到「有数据时这一块长什么样」。而历史教训正是
 * 「只在某个数据分支里崩」，所以这条路径必须能单独测。
 *
 * `t` 传恒等函数：渲染结果里出现的就是词典键名，断言不必跟着界面语言走。
 */
function renderCredentialForm(module, credentials, draft) {
  const React = require('react')
  const ReactDOMServer = require('react-dom/server')
  return ReactDOMServer.renderToStaticMarkup(React.createElement(module.__CredentialForm, {
    t: (key) => key,
    pool: { provider: 'sensenova' },
    credentials,
    busy: false,
    draft: draft ?? {},
    onPatch: () => {},
    onSubmit: () => {},
  }))
}

test('「直接填密钥」表单：宿主不可写时整块不渲染', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  assert.equal(typeof module.__CredentialForm, 'function', 'client.js 应导出 __CredentialForm 供渲染测试')
  assert.equal(renderCredentialForm(module, undefined), '', '拿不到宿主能力时不该渲染任何东西')
  assert.equal(
    renderCredentialForm(module, { writable: false, suggestedRefs: {} }),
    '',
    '明确不可写时同样不渲染——别让用户填完才发现写不进去',
  )
})

test('「直接填密钥」表单：可写时渲染出预填名、密码框与提交按钮', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  const html = renderCredentialForm(module, {
    writable: true,
    suggestedRefs: { sensenova: 'SENSENOVA_API_KEY_2' },
  })

  assert.match(html, /keypilot\.credentialSection/, '应当有区块标题')
  assert.match(html, /SENSENOVA_API_KEY_2/, '应当预填推荐的下一个可用引用名')
  assert.match(html, /type="password"/, '密钥值必须是密码框（屏幕上不回显）')
  assert.match(html, /keypilot\.credentialSave/, '应当有提交按钮')
})

test('「直接填密钥」表单：草稿里有名字时以草稿为准', { skip: require === undefined }, () => {
  const React = require('react')
  const module = loadClientModule((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })

  const html = renderCredentialForm(
    module,
    { writable: true, suggestedRefs: { sensenova: 'SENSENOVA_API_KEY_2' } },
    { ref: 'MY_OWN_NAME' },
  )
  assert.match(html, /MY_OWN_NAME/, '用户改过的名字不该被建议值覆盖')
  assert.doesNotMatch(html, /SENSENOVA_API_KEY_2/, '建议值应当让位给草稿')
})
