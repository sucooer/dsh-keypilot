/**
 * 校验某个提供商的目录模型**真的能用**——发真请求，而不是看 `/models` 列表。
 *
 * ## 为什么必须这样校验
 *
 * 「出现在 `GET /v1/models` 里」与「这个账号能调用」是两回事。NVIDIA NIM 实测：
 * 端点列出 81 个模型，某个账号真正可用的只有十来个，其余分两种坏法——
 *
 * - `404 … Not found for account '<id>'`：列了，但没对本账号开放；
 * - **挂住，永不响应**：45 秒超时都不回，重试仍挂。对级联目标最危险，它会把整个
 *   agent 回合拖到流空闲超时才失败，且不留下任何可读错误。
 *
 * 目录里曾因此躺着三个「挂住」的模型（`moonshotai/kimi-k3`、
 * `deepseek-ai/deepseek-v4.1-flash`、`z-ai/glm-5.3`），用户一选就是坏回合。
 * 本脚本是那个判据的执行者。
 *
 * ## 用法
 *
 * ```
 * node tools/check-provider-models.mjs --provider nvidia
 * node tools/check-provider-models.mjs --provider nvidia --all      # 扫端点列出的全部模型
 * node tools/check-provider-models.mjs --provider nvidia --key nvapi-xxx
 * ```
 *
 * 密钥默认从宿主的凭据存储里按目录的 `keyEnv` 取值。
 *
 * @module tools/check-provider-models
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 单次请求的上限。「挂住」的模型正是靠它暴露的。 */
const TIMEOUT_MS = 45_000

/** 瞬时过载的重试次数。NIM 的免费共享 worker 经常回 503，那是容量不是能力。 */
const MAX_ATTEMPTS = 3

/** 重试间隔。 */
const RETRY_DELAY_MS = 3_000

/** 默认的宿主凭据存储位置（桌面版）。 */
function defaultCredentialsPath() {
  const appData = process.env.APPDATA
  return typeof appData === 'string' && appData.length > 0
    ? join(appData, 'dsh-desktop', 'harness', '.credentials.yaml')
    : undefined
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--provider' || argv[i] === '-p') out.provider = argv[i + 1] ?? ''
    else if (argv[i] === '--key' || argv[i] === '-k') out.key = argv[i + 1] ?? ''
    else if (argv[i] === '--credentials') out.credentials = argv[i + 1] ?? ''
    else if (argv[i] === '--all') out.all = '1'
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = '1'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help !== undefined || args.provider === undefined || args.provider.length === 0) {
  console.log('用法：node tools/check-provider-models.mjs --provider <目录里的提供商 id> [--all] [--key <密钥>]')
  process.exit(args.help === undefined ? 1 : 0)
}

const { findCatalogProvider } = await import(pathToFileURL(join(ROOT, 'lib/core/provider-catalog.js')).href)
const provider = findCatalogProvider(args.provider)
if (provider === undefined) {
  console.error(`目录里没有提供商 "${args.provider}"`)
  process.exit(1)
}
if (provider.api !== 'openai-completions') {
  console.error(`本脚本只实现 openai-completions 的探测；"${provider.id}" 用的是 ${provider.api}`)
  process.exit(1)
}

/** 解析密钥：显式传入 > 凭据存储 > 环境变量。 */
function resolveKey() {
  if (args.key !== undefined && args.key.length > 0) return args.key
  const path = args.credentials !== undefined && args.credentials.length > 0 ? args.credentials : defaultCredentialsPath()
  if (path !== undefined && existsSync(path)) {
    const text = readFileSync(path, 'utf8')
    // 凭据存储是 `refs:` 下的一层简单映射，不必引入 YAML 解析器。
    const match = text.match(new RegExp(`^\\s{2}${provider.keyEnv}:\\s*(\\S+)\\s*$`, 'm'))
    if (match !== null) return match[1]
  }
  const fromEnv = process.env[provider.keyEnv]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  console.error(`找不到密钥：${provider.keyEnv}（可用 --key 传入，或设置环境变量）`)
  process.exit(1)
}

const key = resolveKey()
const BASE = provider.baseURL

/** 一次尝试的原始结果。 */
async function attempt(model, { withTools }) {
  const started = Date.now()
  const body = {
    model,
    messages: [{ role: 'user', content: withTools ? 'What is the weather in Beijing? Use the tool.' : 'Say OK.' }],
    max_tokens: withTools ? 128 : 8,
    temperature: 0,
    ...(withTools
      ? {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }
      : {}),
  }
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    const ms = Date.now() - started
    if (!res.ok) {
      let detail = text.slice(0, 160)
      try {
        const json = JSON.parse(text)
        detail = json?.error?.message ?? json?.detail ?? json?.title ?? detail
      } catch { /* 保持原文 */ }
      const message = String(detail).replace(/\s+/g, ' ').slice(0, 150)
      // 「未对本账号开放」是终局判定，重试不会改变它。
      const verdict = /not found for account/i.test(message) ? 'NOT-ENABLED' : `HTTP ${res.status}`
      return { verdict, ms, message }
    }
    const json = JSON.parse(text)
    const msg = json?.choices?.[0]?.message ?? {}
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    return {
      verdict: 'OK',
      ms,
      calls: calls.length,
      message: calls.length > 0 ? `发起 ${calls.length} 个工具调用` : String(msg.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'TimeoutError'
    return {
      verdict: aborted ? 'HANG' : 'NETWORK',
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 瞬时错误（容量/过载/网络抖动）值得重试；「未开放」与「挂住」不值得。 */
function isTransient(verdict) {
  return verdict === 'NETWORK' || /^HTTP (429|500|502|503|504)$/.test(verdict)
}

/** 带重试的调用。`attempts` 记录真实尝试次数，用来识别「只是过载」。 */
async function call(model, options) {
  let result = await attempt(model, options)
  let attempts = 1
  while (isTransient(result.verdict) && attempts < MAX_ATTEMPTS) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    result = await attempt(model, options)
    attempts += 1
  }
  return { ...result, attempts, flaky: attempts > 1 && result.verdict === 'OK' }
}

/** 待检模型：目录里的那几个，或端点列出的全部。 */
let models = provider.models
if (args.all === '1') {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) {
    console.error(`GET ${BASE}/models → HTTP ${res.status}`)
    process.exit(1)
  }
  const json = await res.json().catch(() => undefined)
  // 只有 OpenAI 形状的 `/models` 才带 `data` 数组。聚合网关常见的另一种形状是
  // `{ object: 'list', models: [...] }`，甚至有直接回 `{ "error": ... }` 的；
  // 直接 `.data.map` 会抛一个 `Cannot read properties of undefined` —— 那种错看起来
  // 像脚本有 bug，其实只是这家端点不是这个口径。
  if (!Array.isArray(json?.data)) {
    console.error(`GET ${BASE}/models → 200，但响应里没有 data 数组（${describeShape(json)}）`)
    console.error('这个端点不是 OpenAI /v1/models 的形状，--all 用不了；请改用目录里的模型名逐个检。')
    process.exit(1)
  }
  // 数组本身也可能装着怪东西（`null`、`{ noId: true }`），取 `id` 前要挡一下：
  // 别让一个脏项把「列了哪些模型」变成一次崩溃。
  models = json.data
    .map((m) => (m !== null && typeof m === 'object' ? m.id : undefined))
    .filter((id) => typeof id === 'string' && id.length > 0)
  if (models.length === 0) {
    console.error(`GET ${BASE}/models → data 数组是空的，没什么可检的。`)
    process.exit(1)
  }
  console.log(`--all：端点列出 ${models.length} 个模型`)
}

/**
 * 描述一个 JSON 的形状，只为一句话的报错：给出顶层键和数组字段的长度。
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeShape(value) {
  if (value === undefined) return '响应不是 JSON'
  if (value === null) return '响应是 null'
  if (Array.isArray(value)) return `响应是数组（${value.length} 项）`
  if (typeof value !== 'object') return `响应是 ${typeof value}`
  const keys = Object.keys(value)
  if (keys.length === 0) return '响应是空对象'
  return `顶层键：${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ' …' : ''}`
}

console.log(`提供商 ${provider.id}（${BASE}），逐个发真请求，超时上限 ${TIMEOUT_MS}ms\n`)

const tally = { OK: 0, 'NOT-ENABLED': 0, HANG: 0, other: 0 }
const flaky = []
for (const model of models) {
  const inference = await call(model, { withTools: false })
  if (inference.verdict === 'OK') {
    const tools = await call(model, { withTools: true })
    const toolsOk = tools.verdict === 'OK' && tools.calls > 0
    tally.OK += 1
    if (inference.flaky || tools.flaky) flaky.push(model)
    console.log(`✓ ${model.padEnd(46)} 推理 ${String(inference.ms).padStart(6)}ms${inference.flaky ? '(重试后)' : ''}  工具调用 ${toolsOk ? '可用' : `不可用（${tools.verdict}: ${tools.message}）`}`)
  } else {
    if (inference.verdict in tally) tally[inference.verdict] += 1
    else tally.other += 1
    console.log(`✗ ${model.padEnd(46)} ${inference.verdict.padEnd(12)} ${String(inference.ms).padStart(6)}ms ×${inference.attempts}  ${inference.message}`)
  }
}

console.log(`\n汇总：可用 ${tally.OK} / 未对本账号开放 ${tally['NOT-ENABLED']} / 挂住不回 ${tally.HANG} / 其他 ${tally.other}`)
if (flaky.length > 0) {
  console.log(`\n需要重试才成功的（免费共享 worker 容量波动，不是能力问题）：${flaky.join(', ')}`)
}
if (tally.HANG > 0) {
  console.log('\n注意：「挂住不回」的模型不要放进目录或密钥池——它们不报错，只会把回合拖到流空闲超时。')
}
