/**
 * 配置的归一化与持久化。
 *
 * ## 为什么配置要落在插件自己的文件里
 *
 * 插件的 `Config`（由宿主 loader 传入）是**只读初值**：用户改它需要重载插件行。
 * 而设置面板里的编辑（加一把密钥、改一个上限）希望**立刻生效**，不该要求重启。
 * 因此配置有两个来源：
 *
 * 1. 宿主的 `Config` —— 启动时的初值，也是「用配置文件管理配置」的入口；
 * 2. 插件自己的配置文件 —— 面板里改动落在这里，优先生效，并立即热应用。
 *
 * 两者的合并规则很简单：**插件文件里出现过的字段优先**，其余沿用宿主 Config。
 *
 * ## 归一化的职责
 *
 * 面板收到的输入来自浏览器，什么都可能有。这里把任意输入收敛成可信结构：
 * 数值夹到合理区间、字符串去空白、数组去重，并且**拒绝把密钥本体当引用名**——
 * 那会让明文写进磁盘上的配置文件，而用户以为只是填了个名字。
 *
 * @module @sucooer/dsh-keypilot/runtime/config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SOFT_COOLDOWN_MS,
  DEFAULT_SWITCH_KINDS,
  ROUTING_STRATEGIES,
  WEBHOOK_KINDS,
  looksLikeSecret,
  normalizeBaseUrl,
  normalizeCascade,
  normalizePriceOverrides,
  normalizeQuotaWindow,
  normalizeRoute,
} from '../core/index.js'
import { resolveDshHome } from './state.js'

/** 配置文件默认名。 */
export const CONFIG_FILE_NAME = 'keypilot.json'

/** 一个密钥池最多配多少把密钥。 */
export const MAX_KEYS_PER_PROVIDER = 64

/** 冷却时长的上下限。 */
const COOLDOWN_MIN_MS = 1000
const COOLDOWN_MAX_MS = 6 * 3600_000

/** 熔断参数的上下限。 */
const BREAKER_THRESHOLD_MAX = 100
const BREAKER_OPEN_MAX_MS = 3600_000

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  providers: [],
  cascade: [],
  switchKinds: [...DEFAULT_SWITCH_KINDS],
  cooldownMs: 60_000,
  maxCooldownMs: 0,
  concurrencyLimit: 0,
  rpmLimit: 0,
  tpmLimit: 0,
  routingStrategy: 'round-robin',
  proactiveRateLimitGuard: true,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: 5,
  circuitBreakerOpenMs: 30_000,
  circuitBreakerHalfOpenProbes: 1,
  latencyAware: true,
  selfHealIntervalMinutes: 30,
  quotaResetWindow: { type: 'midnight_utc', hour: 0 },
  persistenceEnabled: true,
  verboseLogging: false,
  canaryEnabled: true,
  canaryIntervalMinutes: 5,
  webhookUrl: '',
  webhookKind: 'generic',
  webhookEnabled: false,
  notifyOnSwitch: true,
  notifyOnCascade: true,
  notifyOnExhaustion: true,
  notifyOnProbe: false,
  usageRetainDays: 30,
  pricingOverrides: {},
})

/** 取值工具：合法的有限数或默认值。 */
function num(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** 取值工具：布尔。 */
function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** 取值工具：非空字符串。 */
function str(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

/**
 * 归一化一个密钥池条目。
 *
 * @param {unknown} raw
 * @param {object} [fallback] 用于补全缺省值的全局默认
 * @returns {{ ok: true, provider: object } | { ok: false, message: string, provider: string }}
 */
export function normalizeProviderEntry(raw, fallback = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '条目必须是对象', provider: '' }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const provider = str(record.provider, '')
  if (provider.length === 0) return { ok: false, message: '缺少 provider 字段', provider: '' }
  if (looksLikeSecret(provider).secret) {
    return {
      ok: false,
      provider,
      message: 'provider 看起来是密钥本体；这里要填提供商 ID（如 deepseek），密钥请填在「密钥」栏',
    }
  }

  const rawKeys = Array.isArray(record.keys) ? record.keys : []
  /** @type {string[]} */
  const keys = []
  const seen = new Set()
  for (const item of rawKeys) {
    if (typeof item !== 'string') continue
    const ref = item.trim()
    if (ref.length === 0 || seen.has(ref)) continue
    if (keys.length >= MAX_KEYS_PER_PROVIDER) break
    // 最关键的一条防线：引用名栏里若粘的是密钥本体，明文会落盘。
    const suspicion = looksLikeSecret(ref)
    if (suspicion.secret) {
      return {
        ok: false,
        provider,
        message: `密钥栏里的 "${ref.slice(0, 12)}…" ${suspicion.reason}；这里只能填凭据引用名（如 MY_API_KEY），密钥本身请通过宿主写入凭证存储`,
      }
    }
    seen.add(ref)
    keys.push(ref)
  }

  const entry = {
    provider,
    keys,
    weights: Array.isArray(record.weights) ? record.weights.map((v) => num(v, 1, 1, 100)) : [],
    paused: Array.isArray(record.paused) ? record.paused.map((v) => v === true) : [],
    revoked: Array.isArray(record.revoked) ? record.revoked.map((v) => v === true) : [],
    expiresAt: Array.isArray(record.expiresAt)
      ? record.expiresAt.map((v) => {
        if (typeof v === 'string' && v.trim().length > 0) {
          const parsed = Date.parse(v)
          return Number.isFinite(parsed) ? parsed : 0
        }
        return num(v, 0, 0, Number.MAX_SAFE_INTEGER)
      })
      : [],
    rpmLimit: num(record.rpmLimit, fallback.rpmLimit ?? 0, 0, 1_000_000),
    tpmLimit: num(record.tpmLimit, fallback.tpmLimit ?? 0, 0, 1_000_000_000),
    cooldownMs: num(record.cooldownMs, fallback.cooldownMs ?? DEFAULT_CONFIG.cooldownMs, COOLDOWN_MIN_MS, COOLDOWN_MAX_MS),
    maxCooldownMs: num(record.maxCooldownMs, 0, 0, COOLDOWN_MAX_MS),
    concurrencyLimit: num(record.concurrencyLimit, fallback.concurrencyLimit ?? 0, 0, 1000),
    routingStrategy: ROUTING_STRATEGIES.includes(/** @type {string} */ (record.routingStrategy))
      ? /** @type {string} */ (record.routingStrategy)
      : (fallback.routingStrategy ?? DEFAULT_CONFIG.routingStrategy),
  }

  // 探活端点：可选。宿主自带的提供商往往从 providerInfo 里拿不到端点，
  // 这时用户可以直接指一个（形如 https://api.example.com/v1）。
  const probeBaseURL = str(record.probeBaseURL, '')
  if (probeBaseURL.length > 0) {
    const normalized = normalizeBaseUrl(probeBaseURL, provider)
    if (normalized.errors !== undefined) {
      return { ok: false, provider, message: `探活端点无效：${normalized.errors.map((e) => e.message).join('；')}` }
    }
    entry.probeBaseURL = normalized.baseURL
  }

  // 路由声明：可选。声明了就校验，校验不过就把错误随条目一起返回，
  // 由调用方决定是整体拒绝还是只标记这条路由不可用。
  if (record.route !== undefined && record.route !== null) {
    const normalized = normalizeRoute(record.route, { provider })
    if (!normalized.ok) {
      return {
        ok: false,
        provider,
        message: `路由声明无效：${normalized.errors.map((e) => e.message).join('；')}`,
      }
    }
    entry.route = {
      id: normalized.route.id,
      displayName: normalized.route.displayName,
      baseURL: normalized.route.baseURL,
      api: normalized.route.api,
      models: normalized.route.models,
    }
  }

  return { ok: true, provider: entry }
}

/**
 * 归一化整份配置。
 *
 * 诊断信息**不**放进返回值：它是瞬时的事实，不是配置。混进去会被一起落盘，
 * 下次载入时又变成一个陌生字段。调用方通过 `options.warnings` 数组收取。
 *
 * @param {unknown} raw 面板或文件里读到的原始配置
 * @param {object} [options]
 * @param {object} [options.base] 兜底默认（通常是宿主的 Config）
 * @param {string[]} [options.warnings] 收集被丢弃条目的原因
 * @returns {object}
 */
export function normalizeConfig(raw, options = {}) {
  const base = options.base ?? {}
  const warnings = Array.isArray(options.warnings) ? options.warnings : []
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  // 取值优先级：插件文件（record）→ 宿主 Config（base）→ 内置默认。
  // 「插件文件优先」是设置面板能生效的前提：面板写的就是插件文件，
  // 若这里只读 base，用户在面板上改的冷却时长与限额都会被宿主配置盖掉。
  const fallback = {
    rpmLimit: num(record.rpmLimit ?? base.rpmLimit, DEFAULT_CONFIG.rpmLimit, 0, 1_000_000),
    tpmLimit: num(record.tpmLimit ?? base.tpmLimit, DEFAULT_CONFIG.tpmLimit, 0, 1_000_000_000),
    cooldownMs: num(record.cooldownMs ?? base.cooldownMs, DEFAULT_CONFIG.cooldownMs, COOLDOWN_MIN_MS, COOLDOWN_MAX_MS),
    concurrencyLimit: num(record.concurrencyLimit ?? base.concurrencyLimit, DEFAULT_CONFIG.concurrencyLimit, 0, 1000),
    routingStrategy: ROUTING_STRATEGIES.includes(/** @type {string} */ (record.routingStrategy))
      ? /** @type {string} */ (record.routingStrategy)
      : (ROUTING_STRATEGIES.includes(/** @type {string} */ (base.routingStrategy))
        ? /** @type {string} */ (base.routingStrategy)
        : DEFAULT_CONFIG.routingStrategy),
  }

  /** @type {object[]} */
  const providers = []
  const rawProviders = Array.isArray(record.providers)
    ? record.providers
    : Array.isArray(base.providers) ? base.providers : []
  const seenProviders = new Set()
  for (const item of rawProviders) {
    const result = normalizeProviderEntry(item, fallback)
    if (!result.ok) {
      warnings.push(`${result.provider || '(未命名)'}：${result.message}`)
      continue
    }
    if (seenProviders.has(result.provider.provider)) {
      warnings.push(`${result.provider.provider}：重复的提供商条目，已忽略后一条`)
      continue
    }
    seenProviders.add(result.provider.provider)
    providers.push(result.provider)
  }

  return {
    enabled: bool(record.enabled, bool(base.enabled, DEFAULT_CONFIG.enabled)),
    providers,
    cascade: normalizeCascade(record.cascade ?? base.cascade ?? DEFAULT_CONFIG.cascade),
    switchKinds: Array.isArray(record.switchKinds)
      ? record.switchKinds.filter((v) => typeof v === 'string' && v.length > 0)
      : (Array.isArray(base.switchKinds) ? base.switchKinds : [...DEFAULT_CONFIG.switchKinds]),
    cooldownMs: fallback.cooldownMs,
    maxCooldownMs: num(record.maxCooldownMs, num(base.maxCooldownMs, 0, 0, COOLDOWN_MAX_MS), 0, COOLDOWN_MAX_MS),
    concurrencyLimit: fallback.concurrencyLimit,
    rpmLimit: fallback.rpmLimit,
    tpmLimit: fallback.tpmLimit,
    routingStrategy: fallback.routingStrategy,
    proactiveRateLimitGuard: bool(
      record.proactiveRateLimitGuard,
      bool(base.proactiveRateLimitGuard, DEFAULT_CONFIG.proactiveRateLimitGuard),
    ),
    circuitBreakerEnabled: bool(
      record.circuitBreakerEnabled,
      bool(base.circuitBreakerEnabled, DEFAULT_CONFIG.circuitBreakerEnabled),
    ),
    circuitBreakerThreshold: num(
      record.circuitBreakerThreshold,
      num(base.circuitBreakerThreshold, DEFAULT_CONFIG.circuitBreakerThreshold, 1, BREAKER_THRESHOLD_MAX),
      1,
      BREAKER_THRESHOLD_MAX,
    ),
    circuitBreakerOpenMs: num(
      record.circuitBreakerOpenMs,
      num(base.circuitBreakerOpenMs, DEFAULT_CONFIG.circuitBreakerOpenMs, COOLDOWN_MIN_MS, BREAKER_OPEN_MAX_MS),
      COOLDOWN_MIN_MS,
      BREAKER_OPEN_MAX_MS,
    ),
    circuitBreakerHalfOpenProbes: num(
      record.circuitBreakerHalfOpenProbes,
      num(base.circuitBreakerHalfOpenProbes, DEFAULT_CONFIG.circuitBreakerHalfOpenProbes, 1, 10),
      1,
      10,
    ),
    latencyAware: bool(record.latencyAware, bool(base.latencyAware, DEFAULT_CONFIG.latencyAware)),
    selfHealIntervalMinutes: num(
      record.selfHealIntervalMinutes,
      num(base.selfHealIntervalMinutes, DEFAULT_CONFIG.selfHealIntervalMinutes, 1, 1440),
      1,
      1440,
    ),
    quotaResetWindow: normalizeQuotaWindow(record.quotaResetWindow ?? base.quotaResetWindow),
    persistenceEnabled: bool(record.persistenceEnabled, bool(base.persistenceEnabled, DEFAULT_CONFIG.persistenceEnabled)),
    verboseLogging: bool(record.verboseLogging, bool(base.verboseLogging, DEFAULT_CONFIG.verboseLogging)),
    softCooldownMs: DEFAULT_SOFT_COOLDOWN_MS,
    // 金丝雀探测：冷却中的密钥定期探活，成功即提前归队。
    canaryEnabled: bool(record.canaryEnabled, bool(base.canaryEnabled, DEFAULT_CONFIG.canaryEnabled)),
    canaryIntervalMinutes: num(
      record.canaryIntervalMinutes,
      num(base.canaryIntervalMinutes, DEFAULT_CONFIG.canaryIntervalMinutes, 1, 1440),
      1,
      1440,
    ),
    // Webhook：URL 是凭据（Telegram bot token 就在里面），因此不参与任何日志输出。
    webhookUrl: str(record.webhookUrl ?? base.webhookUrl, DEFAULT_CONFIG.webhookUrl),
    webhookKind: WEBHOOK_KINDS.includes(/** @type {string} */ (record.webhookKind))
      ? /** @type {string} */ (record.webhookKind)
      : (WEBHOOK_KINDS.includes(/** @type {string} */ (base.webhookKind))
        ? /** @type {string} */ (base.webhookKind)
        : DEFAULT_CONFIG.webhookKind),
    webhookEnabled: bool(record.webhookEnabled, bool(base.webhookEnabled, DEFAULT_CONFIG.webhookEnabled)),
    notifyOnSwitch: bool(record.notifyOnSwitch, bool(base.notifyOnSwitch, DEFAULT_CONFIG.notifyOnSwitch)),
    notifyOnCascade: bool(record.notifyOnCascade, bool(base.notifyOnCascade, DEFAULT_CONFIG.notifyOnCascade)),
    notifyOnExhaustion: bool(record.notifyOnExhaustion, bool(base.notifyOnExhaustion, DEFAULT_CONFIG.notifyOnExhaustion)),
    notifyOnProbe: bool(record.notifyOnProbe, bool(base.notifyOnProbe, DEFAULT_CONFIG.notifyOnProbe)),
    usageRetainDays: num(
      record.usageRetainDays,
      num(base.usageRetainDays, DEFAULT_CONFIG.usageRetainDays, 1, 730),
      1,
      730,
    ),
    // 自定义单价：服务商调价时不必等插件发版。
    pricingOverrides: normalizePriceOverrides(record.pricingOverrides ?? base.pricingOverrides),
  }
}

/**
 * 配置存储：读宿主的 Config 作为初值，叠加插件自己的文件。
 *
 * ## 为什么文件里要额外记一份「用户设过哪些字段」
 *
 * 优先级规则是「用户设过的字段」优先于「宿主 Config」。但落盘的必须是**归一化
 * 之后的结果**——否则用户要是把密钥本体粘进引用名栏，那块明文就会跟着原始输入
 * 一起写进磁盘。可一旦落盘的是归一化结果（一份全量对象），下次载入时它就表现得
 * 「每个字段都是用户设过的」，宿主 Config 从此再也影响不到任何字段。
 *
 * 因此文件里额外记一个 `set` 字段：它只列出用户**显式改过**的字段名。载入时只有
 * 这些字段算覆盖，其余一律跟随宿主 Config。`set` 里记的是字段名而不是值，所以
 * 它本身不携带任何敏感内容。
 */
export class ConfigStore {
  /**
   * @param {object} [options]
   * @param {string} [options.file] 配置文件路径；空串表示不落盘
   * @param {unknown} [options.base] 宿主的 Config
   * @param {(message: string) => void} [options.warn]
   */
  constructor(options = {}) {
    this.file = typeof options.file === 'string' ? options.file : ''
    this.base = options.base ?? {}
    this._warn = typeof options.warn === 'function' ? options.warn : () => {}
    /**
     * 用户显式设置过的字段名。
     *
     * `undefined` 表示「还不知道」——用于区分「从未配置过」与「配置过但空」。
     * 见 {@link ConfigStore#load} 对旧格式文件的兼容。
     */
    this._userFields = undefined
    /** 用户显式提供的配置值（已归一化）。 */
    this._raw = {}
    /** @type {string[]} */
    this.warnings = []
    this.current = normalizeConfig({}, { base: this.base, warnings: this.warnings })
  }

  /** 只把用户设过的字段交给归一化，其余交给宿主 Config。 */
  _recompute() {
    this.warnings = []
    /** @type {Record<string, unknown>} */
    const record = {}
    if (this._userFields !== undefined) {
      for (const key of this._userFields) {
        if (Object.prototype.hasOwnProperty.call(this._raw, key)) record[key] = this._raw[key]
      }
    } else {
      // 未知状态（从未载入过、也没有 set）：等同于全部跟随宿主 Config。
      Object.assign(record, this._raw)
    }
    this.current = normalizeConfig(record, { base: this.base, warnings: this.warnings })
    return this.current
  }

  /** 从文件载入并覆盖当前配置。文件不存在是正常情况。 */
  load() {
    if (this.file.length === 0) return false
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return false
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      if ('config' in parsed && typeof parsed.config === 'object' && parsed.config !== null) {
        // 当前格式：{ version, set, config }
        this._raw = parsed.config
        this._userFields = Array.isArray(parsed.set)
          ? new Set(parsed.set.filter((key) => typeof key === 'string'))
          : new Set(Object.keys(parsed.config))
      } else {
        // 旧格式（一份裸的配置对象）：无法区分哪些字段是用户设过的，
        // 一律视为用户设置——宁可让宿主 Config 不生效，也不要悄悄丢掉用户的配置。
        this._raw = parsed
        this._userFields = new Set(Object.keys(parsed))
      }
      this._recompute()
      for (const warning of this.warnings) this._warn(`配置条目被忽略 —— ${warning}`)
      return true
    } catch (error) {
      this._warn(`配置文件无法解析，已退回宿主配置：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 当前生效配置。 */
  get() {
    return this.current
  }

  /**
   * 替换配置并落盘。
   *
   * @param {unknown} raw 面板提交的完整配置
   * @returns {{ ok: true, config: object, warnings: string[] } | { ok: false, message: string }}
   */
  set(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: '配置必须是一个对象' }
    }
    const payload = /** @type {Record<string, unknown>} */ (raw)
    this._userFields = new Set(Object.keys(payload))
    this._raw = payload
    const config = this._recompute()

    if (this.file.length > 0) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        // 落盘的是**归一化结果**：用户粘进引用名栏的密钥本体在这里已经被拒绝，
        // 不会随原始输入一起写到磁盘。
        const document = {
          version: 1,
          savedAt: Date.now(),
          set: [...this._userFields],
          config,
        }
        const temp = `${this.file}.tmp`
        writeFileSync(temp, JSON.stringify(document, null, 2), 'utf8')
        renameSync(temp, this.file)
      } catch (error) {
        return { ok: false, message: `配置写入失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    return { ok: true, config, warnings: this.warnings }
  }

  /**
   * 宿主 Config 变化时重新归一化。
   *
   * 用户从面板设过的字段保持不动，其余跟随新的宿主配置。
   */
  rebase(base) {
    this.base = base ?? {}
    return this._recompute()
  }
}

/**
 * 建一个配置存储。
 * @param {object} [options]
 * @param {string} [options.file] 显式路径
 * @param {unknown} [options.base] 宿主 Config
 * @param {boolean} [options.persist] 是否落盘
 * @param {(message: string) => void} [options.warn]
 */
export function createConfigStore(options = {}) {
  const file = options.persist === false
    ? ''
    : (typeof options.file === 'string' && options.file.trim().length > 0
      ? options.file.trim()
      : join(resolveDshHome(), CONFIG_FILE_NAME))
  const store = new ConfigStore({ file, base: options.base, warn: options.warn })
  store.load()
  return store
}
