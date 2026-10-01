/**
 * 无头 Chrome（CDP）验收脚手架 —— 供 `tools/check-*.mjs` 复用。
 *
 * ## 为什么在仓库里，而不是外部依赖
 *
 * 这个文件原本放在仓库外的个人技能目录里，靠 `file:///C:/Users/<me>/...` 绝对路径
 * 引入。那样一来 `tools/check-settings-section.mjs` **在别人的机器上必然跑不起来**：
 * 路径不存在，而且 import 失败发生在脚本第一行，连一句能看懂的报错都没有。
 * 这份拷贝随仓库走，任何克隆下来的人都能直接用。
 *
 * ## 依赖
 *
 * Node 22+（自带全局 WebSocket / fetch），**不需要** ws / puppeteer / playwright。
 *
 * 启动浏览器（后台进程，端口固定 9222）：
 *
 * ```bash
 * chrome --headless=new --remote-debugging-port=9222 --no-first-run \
 *        --disable-extensions --user-data-dir="<每次都换的新目录>" about:blank
 * ```
 *
 * ## 用法
 *
 * ```js
 * import { openPage, freshUrl, sleep } from './lib/cdp.mjs'
 * const page = await openPage(freshUrl('http://127.0.0.1:5188/'))
 * await page.waitFor(`document.querySelectorAll('button').length > 0`)
 * await page.clickAt(x, y)
 * console.log(page.errors())
 * ```
 *
 * ## 设计取舍（都是踩过的坑）
 *
 * - 点击一律用 `Input.dispatchMouseEvent` 真实指针事件，不要用 `el.click()`：
 *   后者绕过命中测试，会漏掉「有别的元素盖在上面把点击吃掉」这类问题。
 * - 导航必须带变化的查询参数（`freshUrl`），否则 SPA 同文档跳转不重新初始化。
 * - `waitFor` 用轮询而不是固定 `sleep`，动画/网络抖动才不会变成偶发失败。
 *
 * @module tools/lib/cdp
 */

import http from 'node:http'

const CDP_HOST = process.env.CDP_HOST || '::1' // 监听地址 IPv4/IPv6 不固定，先 netstat 确认
const CDP_PORT = Number(process.env.CDP_PORT || 9222)

function httpJson(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: CDP_HOST, port: CDP_PORT, path, method }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(body)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 带变化的查询参数，强制一次跨文档加载；hash 必须拼在参数**之后** */
export function freshUrl(base, hash = '') {
  return base + (base.includes('?') ? '&' : '?') + 'probe=' + Date.now() + hash
}

/**
 * 开新标签页、连上 CDP、设好视口并导航。
 * @param {string} url
 * @param {{w?:number,h?:number,mobile?:boolean,scale?:number}} [viewport]
 */
export async function openPage(url, viewport = {}) {
  const { w = 390, h = 844, mobile = true, scale = 2 } = viewport
  const target = await httpJson(`/json/new?${encodeURIComponent(url)}`, 'PUT')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败（检查 netstat 看是 [::1] 还是 127.0.0.1）'))
  })

  let id = 0
  const pending = new Map()
  const logs = []

  ws.onmessage = (ev) => {
    const message = JSON.parse(ev.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      logs.push(
        `[${message.params.type}] ` +
          message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
      )
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      logs.push('[EXCEPTION] ' + (details.exception?.description || details.text))
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, (message) =>
        message.error ? reject(new Error(method + ': ' + message.error.message)) : resolve(message.result))
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  /*
   * 浏览器进程被杀（或调试端口断开）时，正在等回包的 send() 会永远挂着 ——
   * Node 的表现是 `Detected unsettled top-level await` 加一个莫名其妙的退出码，
   * 完全看不出真正原因是「浏览器没了」。这里在 socket 关闭时把所有待决请求
   * 一次性拒掉，错误信息直接点名。
   */
  ws.onclose = () => {
    for (const [, settle] of pending) settle({ error: { message: 'CDP 连接已关闭（浏览器进程退出了？）' } })
    pending.clear()
  }
  ws.onerror = () => {
    for (const [, settle] of pending) settle({ error: { message: 'CDP 连接出错' } })
    pending.clear()
  }

  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error('EVAL: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    }
    return result.result.value
  }

  /** 真实指针事件：moved → pressed → released */
  const clickAt = async (x, y) => {
    const common = { x, y, button: 'left', clickCount: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  }

  /** 取某点最上层命中的元素栈，用来判断「谁把点击吃掉了」 */
  const hitStack = (x, y) =>
    evalJs(`document.elementsFromPoint(${x},${y}).slice(0,5).map(e=>
      e.tagName.toLowerCase()+'.'+String(e.className||'').split(/\\s+/).slice(0,3).join('.')).join('  <  ')`)

  const shot = async (file, clip) => {
    const result = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
    const fs = await import('node:fs')
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: scale,
    mobile,
  })
  await send('Page.navigate', { url })

  return {
    send,
    evalJs,
    clickAt,
    hitStack,
    shot,
    logs,
    /** 轮询等待条件成立，超时回 false（不要用固定 sleep 赌） */
    waitFor(expr, timeout = 25000) {
      return evalJs(`new Promise(r=>{const t0=Date.now();const f=()=>{
        try{ if(${expr}) return r(true) }catch{}
        if(Date.now()-t0>${timeout}) return r(false); setTimeout(f,300)};f()})`)
    },
    /** 报错行过滤：列表非空就说明页面上真出过异常，别忽略 */
    errors() {
      return logs.filter((line) => line.startsWith('[EXCEPTION]') || line.includes('[error]'))
    },
    close() {
      ws.close()
    },
  }
}
