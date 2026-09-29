/**
 * 设置面板与主机之间的 HTTP 桥。
 *
 * ## 安全模型：Fail-Closed 的同源环回
 *
 * 这个桥能读配置、改密钥池、触发操作，因此它**只能**被本机的宿主界面调用。
 * 浏览器里的任意一个网页都可能向 `127.0.0.1` 发请求（DNS rebinding / CSRF），
 * 所以「监听在环回地址」本身不是安全边界，必须逐请求校验：
 *
 * | 检查 | 拒绝的情形 |
 * |---|---|
 * | TCP 对端必须是环回 | 来自局域网/公网的任何连接 |
 * | `Host` 头必须解析到环回 | DNS rebinding（Host 是攻击者域名） |
 * | 带 `Origin` 时必须与 `Host` 同源 | 跨站页面发起的写请求 |
 * | 改变状态的方法必须带 `Origin` | 无法表明来源的写请求 |
 *
 * 前两条挡外面，后两条挡里面。注意 GET/HEAD **允许**缺 `Origin`——浏览器对同源
 * 的 GET 本就不发送该头部，强制要求会让正常读请求也失败。
 *
 * ## 体积上限
 *
 * 请求体上限 1 MiB：配置本身只有几十 KB，超出的都是异常流量，读满内存没有意义。
 *
 * @module @sucooer/dsh-keypilot/runtime/http-bridge
 */

/** 桥的路径前缀。 */
export const BRIDGE_PREFIX = '/dsh-keypilot'

/** 路由：读状态（池健康、诊断、生效配置）。 */
export const BRIDGE_STATE_PATH = `${BRIDGE_PREFIX}/state`

/** 路由：写配置。 */
export const BRIDGE_CONFIG_PATH = `${BRIDGE_PREFIX}/config`

/** 路由：执行操作（重置冷却、暂停密钥、探测、测试 Webhook）。 */
export const BRIDGE_ACTION_PATH = `${BRIDGE_PREFIX}/action`

/** 路由：用量报表（支持 CSV / JSON 两种格式）。 */
export const BRIDGE_USAGE_PATH = `${BRIDGE_PREFIX}/usage`

/** 请求体上限。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 允许读取的方法。 */
const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * 判断一个地址是否是环回。
 *
 * 要认 IPv4、IPv6 以及 IPv4-mapped 三种写法：Node 在不同平台上给出的形态不同。
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.trim().toLowerCase()
  if (value === '::1' || value === 'localhost') return true
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value
  if (mapped === '::1') return true
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(mapped)) return false
  const octets = mapped.split('.').map(Number)
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  // 整个 127.0.0.0/8 都是环回，不只是 127.0.0.1。
  return octets[0] === 127
}

/**
 * 解析 `Host` 头，取出主机名与端口。
 * @param {unknown} host
 * @returns {{ hostname: string, port: string } | undefined}
 */
export function parseHostHeader(host) {
  if (typeof host !== 'string' || host.trim().length === 0) return undefined
  const value = host.trim()
  // IPv6 字面量：[::1]:8080
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return undefined
    const hostname = value.slice(1, end)
    const rest = value.slice(end + 1)
    const port = rest.startsWith(':') ? rest.slice(1) : ''
    return { hostname, port }
  }
  const colon = value.lastIndexOf(':')
  if (colon === -1) return { hostname: value, port: '' }
  const hostname = value.slice(0, colon)
  const port = value.slice(colon + 1)
  if (!/^\d*$/.test(port)) return { hostname: value, port: '' }
  return { hostname, port }
}

/**
 * 判断这次请求是否可信。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ trusted: boolean, reason?: string }}
 */
export function checkBridgeRequest(req) {
  const remote = req.socket?.remoteAddress
  if (!isLoopbackAddress(remote)) {
    return { trusted: false, reason: `来源地址 ${String(remote)} 不是环回地址` }
  }

  const hostHeader = req.headers.host
  const parsed = parseHostHeader(hostHeader)
  if (parsed === undefined) {
    return { trusted: false, reason: '缺少 Host 头' }
  }
  if (!isLoopbackAddress(parsed.hostname)) {
    return { trusted: false, reason: `Host "${String(hostHeader)}" 未解析到环回地址` }
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const origin = req.headers.origin

  if (origin !== undefined && origin !== null && String(origin) !== 'null') {
    let parsedOrigin
    try {
      parsedOrigin = new URL(String(origin))
    } catch {
      return { trusted: false, reason: `Origin "${String(origin)}" 不是合法 URL` }
    }
    if (!isLoopbackAddress(parsedOrigin.hostname)) {
      return { trusted: false, reason: `Origin "${String(origin)}" 不是环回地址` }
    }
    // 同源比较按 host:port，避免 127.0.0.1:1 与 127.0.0.1:2 互相冒充。
    const originPort = parsedOrigin.port.length > 0 ? parsedOrigin.port : (parsedOrigin.protocol === 'https:' ? '443' : '80')
    const hostPort = parsed.port.length > 0 ? parsed.port : originPort
    if (parsedOrigin.hostname !== parsed.hostname || originPort !== hostPort) {
      return { trusted: false, reason: `Origin "${String(origin)}" 与 Host "${String(hostHeader)}" 不同源` }
    }
  } else if (!READ_METHODS.has(method)) {
    // 写请求必须能表明来源；读请求浏览器本来就不发 Origin。
    return { trusted: false, reason: `${method} 请求缺少 Origin，拒绝改变状态` }
  }

  return { trusted: true }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/**
 * 写一个文本响应（用作量报表的 CSV 下载）。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {object} [headers]
 */
export function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

/**
 * 读取请求体（带上限）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ ok: true, text: string } | { ok: false, message: string }>}
 */
export function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, message: `请求体超过上限 ${MAX_BODY_BYTES} 字节` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', (error) => finish({ ok: false, message: error.message }))
  })
}

/**
 * 建一个路由处理器。
 *
 * @param {object} options
 * @param {() => Promise<unknown> | unknown} options.getState 读状态
 * @param {(payload: unknown) => Promise<{ ok: boolean, message?: string, warnings?: string[] }>} options.putConfig 写配置
 * @param {(payload: unknown) => Promise<{ ok: boolean, message?: string }>} options.runAction 执行操作
 * @param {(query: { format: string, days?: number }) => { format: string, body: string, filename: string }} [options.getUsage] 用量报表
 * @param {object} [options.logger]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createBridgeHandler({ getState, putConfig, runAction, getUsage, logger }) {
  return async function handle(req, res) {
    // 无论后续走到哪一步，安全校验都是第一道闸。
    const verdict = checkBridgeRequest(req)
    if (!verdict.trusted) {
      logger?.warn?.(`[keypilot] 拒绝了一个设置桥请求：${verdict.reason}`)
      sendJson(res, 403, { error: 'forbidden', message: `拒绝访问：${verdict.reason}` })
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (pathname === BRIDGE_STATE_PATH) {
        if (!READ_METHODS.has(method)) {
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        sendJson(res, 200, await getState())
        return
      }

      if (pathname === BRIDGE_USAGE_PATH) {
        if (!READ_METHODS.has(method)) {
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        if (typeof getUsage !== 'function') {
          sendJson(res, 404, { error: 'not_found', message: '用量报表未启用' })
          return
        }
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
        const rawDays = Number(url.searchParams.get('days'))
        const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : undefined
        const report = getUsage(days === undefined ? { format } : { format, days })
        if (format === 'csv') {
          sendText(res, 200, report.body, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${report.filename}"`,
          })
          return
        }
        sendJson(res, 200, { ok: true, ...JSON.parse(report.body) })
        return
      }

      if (pathname === BRIDGE_CONFIG_PATH) {
        if (method === 'GET') {
          const state = await getState()
          sendJson(res, 200, state)
          return
        }
        if (method === 'PUT' || method === 'POST') {
          const body = await readBody(req)
          if (!body.ok) {
            sendJson(res, 413, { error: 'payload_too_large', message: body.message })
            return
          }
          let payload
          try {
            payload = JSON.parse(body.text)
          } catch {
            sendJson(res, 400, { error: 'invalid_json', message: '请求体不是合法 JSON' })
            return
          }
          const result = await putConfig(payload)
          sendJson(res, result.ok ? 200 : 422, result)
          return
        }
        sendJson(res, 405, { error: 'method_not_allowed' })
        return
      }

      if (pathname === BRIDGE_ACTION_PATH) {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        const body = await readBody(req)
        if (!body.ok) {
          sendJson(res, 413, { error: 'payload_too_large', message: body.message })
          return
        }
        let payload = {}
        if (body.text.trim().length > 0) {
          try {
            payload = JSON.parse(body.text)
          } catch {
            sendJson(res, 400, { error: 'invalid_json', message: '请求体不是合法 JSON' })
            return
          }
        }
        const result = await runAction(payload)
        sendJson(res, result.ok ? 200 : 422, result)
        return
      }

      sendJson(res, 404, { error: 'not_found', message: `未知的设置桥路径：${pathname}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[keypilot] 设置桥处理 ${method} ${pathname} 时出错：${message}`)
      sendJson(res, 500, { error: 'internal_error', message })
    }
  }
}
