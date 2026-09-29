/**
 * 设置分区渲染检查（浏览器侧的真实验收）。
 *
 * ## 为什么需要它
 *
 * 插件的浏览器端是本项目唯一「单测覆盖不到」的部分：它跑在宿主的模块加载器里，
 * Node 单测只能验证「模块能加载、组件能渲染」到加载态为止。而历史上真出过一次
 * 只在浏览器里发作的崩溃 —— 空池分支把数组写成了单个元素，`...poolCards` 展开时
 * 抛 `Spread syntax requires ...iterable[Symbol.iterator] to be a function`，
 * 宿主记成 `slot entry crashed in 'settings.section'` 并渲染空白。
 *
 * 这个脚本用无头浏览器打开真实界面、点进分区，然后断言四件事：
 * 分区内容出现了、没有崩溃、控制台没有异常、fetch 能通。
 *
 * ## 用法
 *
 * ```bash
 * # 1. 起一个 harness（CLI 或 Desktop 都行，URL 要带 token）
 * dsh --profile web --port 34573 --no-open
 * #    日志里会打印 http://127.0.0.1:34573/?token=...
 *
 * # 2. 起无头浏览器
 * chrome --headless=new --remote-debugging-port=9222 --no-first-run \
 *        --user-data-dir="<临时目录>" about:blank
 *
 * # 3. 跑检查（注意 CDP_HOST：Chrome 可能只绑 IPv4 或只绑 IPv6，先 netstat 确认）
 * CDP_HOST=127.0.0.1 CDP_PORT=9222 KP_URL="http://127.0.0.1:34573/?token=..." \
 *   node tools/check-settings-section.mjs
 * ```
 *
 * 退出码 0 表示分区正常渲染；非 0 会在输出里给出捕获到的异常。
 *
 * @module tools/check-settings-section
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPage, sleep } from 'file:///C:/Users/anyaer/.workbuddy/skills/cdp-headless-visual-verify/cdp-lib.mjs'

/**
 * 截图落地路径：失败时的画面比任何日志都直观，所以成功/失败都要存。
 *
 * 注意用 `dirname(fileURLToPath(...)) + resolve` 而不是 `new URL('..', import.meta.url)`：
 * 下面的 `const URL` 会遮蔽全局 `URL` 构造器，`new URL(...)` 会直接抛 TDZ 错误。
 */
const SHOT_PATH = process.env.KP_SHOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../docs/settings-panel.png')

const URL = process.env.KP_URL
if (URL === undefined || URL.length === 0) {
  console.error('缺少 KP_URL（形如 http://127.0.0.1:PORT/?token=...）')
  process.exit(2)
}

const URL_LOAD_TIMEOUT = 60_000
const SECTION_SETTLE_MS = 20_000

/**
 * 视口：cdp-lib 的默认值是 390x844（移动端），而宿主在窄视口下会把设置面板
 * 压成「左列表 + 极窄右内容」，截出来的图完全不是用户看到的样子。
 * 默认取桌面尺寸，可用 KP_VIEWPORT=1440x960 覆盖。
 */
const [VIEW_W, VIEW_H] = (process.env.KP_VIEWPORT ?? '1280x900').split('x').map(Number)

const page = await openPage(URL, { w: VIEW_W, h: VIEW_H, mobile: false, scale: 1 })
await page.waitFor('!!document.body', URL_LOAD_TIMEOUT)
await sleep(4000)

/** 按 aria-label 点击（比文本匹配稳，文字可能只是裸文本节点）。 */
const clickAria = async (aria) => await page.evalJs(`(() => {
  const el = document.querySelector('[aria-label=${JSON.stringify(aria)}]')
  if (!el) return 'missing'
  el.click()
  return 'clicked'
})()`)

/** 按文本点击：先找叶子，找不到再退回到任何含该文本的元素。 */
const clickText = async (text) => await page.evalJs(`(() => {
  const all = [...document.querySelectorAll('*')]
  let target = all.find((el) => (el.textContent || '').trim() === ${JSON.stringify(text)} && el.children.length === 0)
  if (!target) target = all.reverse().find((el) => (el.textContent || '').trim() === ${JSON.stringify(text)})
  if (!target) return 'missing'
  const clickable = target.closest('button, [role="button"], [role="tab"], li, a') || target
  clickable.click()
  return 'clicked:' + clickable.tagName.toLowerCase()
})()`)

// 收集渲染期日志，便于在失败时给出线索。
await page.evalJs(`(() => {
  if (window.__logs) return 'already'
  window.__logs = []
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      try { window.__logs.push(level + ': ' + args.map((a) => typeof a === 'string' ? a : String(a)).join(' ')) } catch {}
      original(...args)
    }
  }
  return 'hooked'
})()`)

// 展开侧边栏 → 打开设置。
// 注意两点：① 「打开侧边栏」按钮在侧边栏已展开时不存在，点不到不是错误；
// ② 侧边栏展开/收起有动画，必须**轮询**等入口出现，固定 sleep 会偶发失败。
await clickAria('打开侧边栏')
let entryReady = false
for (let i = 0; i < 30; i += 1) {
  const found = await page.evalJs(
    `JSON.stringify(!!document.querySelector('[aria-label="设置"]') || !!document.querySelector('[aria-label="打开使用统计设置"]'))`,
  )
  if (found === 'true') { entryReady = true; break }
  await sleep(1000)
}
if (!entryReady) {
  console.error('侧边栏里没有出现设置入口')
  process.exit(2)
}

// 「使用统计」卡片只在装了 dsh-usage 的 profile 里有，因此必须回退到「设置」按钮。
let opened = await clickAria('打开使用统计设置')
if (opened === 'missing') opened = await clickAria('设置')
if (opened === 'missing') {
  console.error('找不到设置入口')
  process.exit(2)
}
await sleep(3000)
await clickAria('收起侧边栏')
await sleep(1500)

const clicked = await clickText('密钥轮换')
if (clicked === 'missing') {
  console.error('设置面板里找不到「密钥轮换」分区 —— 说明客户端没有注册成功')
  process.exit(1)
}

// 等分区取到数据并渲染（首帧是加载态，需要等 fetch 回来）
await sleep(SECTION_SETTLE_MS)

const state = JSON.parse(await page.evalJs(`JSON.stringify({
  loading: /正在读取状态/.test(document.body.textContent || ''),
  loadFailed: /读取状态失败/.test(document.body.textContent || ''),
  general: /调度策略/.test(document.body.textContent || ''),
  catalog: /内置提供商/.test(document.body.textContent || ''),
  canary: /金丝雀探测/.test(document.body.textContent || ''),
  notify: /Webhook 通知/.test(document.body.textContent || ''),
  usage: /用量与成本/.test(document.body.textContent || ''),
  route: /路由设置/.test(document.body.textContent || ''),
})`))

const crashes = page.errors().filter((line) => /slot entry crashed|TypeError|Spread syntax/.test(line))

try {
  const { mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(SHOT_PATH), { recursive: true })
  // 面板很长，默认截图只拍到顶部。要验证某一块（如池子里的「路由设置」）时，
  // 用 KP_FOCUS=<文案> 先把它滚到视口中央再拍。
  const focusText = process.env.KP_FOCUS
  if (typeof focusText === 'string' && focusText.length > 0) {
    const scrolled = await page.evalJs(`(() => {
      const target = [...document.querySelectorAll('*')].find((el) =>
        el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify(focusText)})
      if (!target) return 'missing'
      target.scrollIntoView({ block: 'center' })
      return 'scrolled'
    })()`)
    console.log('聚焦：', focusText, '→', scrolled)
    await sleep(800)
  }
  await page.shot(SHOT_PATH)
  console.log('截图：', SHOT_PATH)
} catch (error) {
  console.warn('截图失败（不影响判定）：', error instanceof Error ? error.message : String(error))
}

console.log('分区渲染检查：', JSON.stringify(state, null, 2))
const ok = state.general && state.catalog && state.canary && state.usage && crashes.length === 0

if (!ok) {
  console.error('\n✗ 分区未正常渲染')
  if (state.loading) console.error('  · 停在加载态，说明 fetch 没回来（检查插件路由与同源策略）')
  if (state.loadFailed) console.error('  · 组件报出读取失败，错误文案就在界面上')
  if (crashes.length > 0) console.error('  · 捕获到崩溃：\n' + crashes.join('\n'))
  const logs = await page.evalJs(`JSON.stringify((window.__logs || []).filter((l) => /keypilot/.test(l)))`)
  console.error('  · keypilot 日志：', logs)
  process.exit(1)
}

console.log('\n✓ 设置分区渲染正常')
// 必须显式关闭：CDP 的 WebSocket 会一直挂着事件循环，脚本跑完了进程也不退出
// （表现为后台任务永远 running、日志早就写好了）。
page.close()
