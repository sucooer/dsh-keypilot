/**
 * 设置面板（浏览器端）。
 *
 * 通过 `settings.section` slot 在系统设置的左侧导航里占一个一级分区，与
 * 「通用设置」「模型」「插件市场」并列。
 *
 * 本文件是宿主的模块加载器格式（`window.__ModuleLoader__.load`）而不是普通 ESM：
 * 浏览器侧的依赖（react 等）由宿主的加载器注入，不能用 Node 的模块解析。因此
 * 这里不 import 任何东西，全部能力通过 `require()` 向宿主索取。
 *
 * ## 样式为什么不用主题变量名
 *
 * 宿主的 CSS 变量名不是稳定契约，写死变量名会在换个宿主版本时变成一片看不见的
 * 文字。这里改用**中性透明度**（`rgba(128,128,128,α)` 做边框与底色、`currentColor`
 * 做文字与图标），深浅两套主题下都能正常呈现。
 *
 * @module @sucooer/dsh-keypilot/client
 */

window.__ModuleLoader__.load({
  id: '@sucooer/dsh-keypilot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ── 文案 ────────────────────────────────────────────────────────────────

    const NS = 'dsh-keypilot'

    const zh = {
      'keypilot.title': '密钥轮换',
      'keypilot.subtitle': '多密钥自动轮换、预判限流与跨提供商故障转移',
      'keypilot.loading': '正在读取状态…',
      'keypilot.error': '读取状态失败：{error}',
      'keypilot.retry': '重试',
      'keypilot.refresh': '刷新',
      'keypilot.save': '保存',
      'keypilot.saving': '保存中…',
      'keypilot.saved': '已保存并生效',
      'keypilot.reset': '重置冷却',
      'keypilot.syncRoutes': '重新注册路由',
      'keypilot.healthy': '正常',
      'keypilot.cooling': '存在冷却',
      'keypilot.exhausted': '密钥池耗尽',
      'keypilot.disabled': '已停用',
      'keypilot.pools': '{n} 个密钥池',
      'keypilot.keys': '{n} 把密钥',
      'keypilot.sectionGeneral': '常规',
      'keypilot.sectionFailover': '故障转移与限流',
      'keypilot.sectionPools': '密钥池',
      'keypilot.sectionCatalog': '内置提供商',
      'keypilot.sectionCustom': '自定义提供商',
      'keypilot.sectionCascade': '跨提供商级联',
      'keypilot.sectionEvents': '实时事件流',
      'keypilot.enable': '启用密钥轮换',
      'keypilot.enableDesc': '关闭后所有请求按宿主原生逻辑解析凭据，池子与冷却状态保留。',
      'keypilot.strategy': '调度策略',
      'keypilot.strategyDesc': '轮询：依次使用；最小负载：优先最闲的；最低延迟：优先首字最快的。',
      'keypilot.concurrency': '每把密钥的并发上限',
      'keypilot.concurrencyDesc': '0 表示不限。防止并发洪峰把单把密钥的连接额度打满。',
      'keypilot.rpm': '每分钟请求上限（每把密钥）',
      'keypilot.tpm': '每分钟 token 上限（每把密钥）',
      'keypilot.cooldown': '失败冷却',
      'keypilot.cooldownDesc': '硬故障按指数退避逐次翻倍，软故障（网络抖动）使用固定的短冷却。',
      'keypilot.switchKinds': '触发切换的错误类型',
      'keypilot.switchKindsDesc': '只有这里勾选的错误才会换密钥重试。用户中断与请求非法永远不会触发切换。',
      'keypilot.breaker': '熔断器',
      'keypilot.breakerDesc': '连续失败达到阈值后快速失败，避免把池子里每把密钥都撞一遍。',
      'keypilot.threshold': '连续失败阈值',
      'keypilot.openMs': '熔断打开时长',
      'keypilot.quotaWindow': '配额重置窗口',
      'keypilot.quotaWindowDesc': '日配额按哪个时区的午夜重置。太平洋时间会自动处理夏令时。',
      'keypilot.addProvider': '添加提供商',
      'keypilot.addKey': '添加密钥引用',
      'keypilot.keyPlaceholder': '凭据引用名，如 DEEPSEEK_API_KEY_2',
      'keypilot.keyHint': '这里只填引用名，密钥本体由宿主的凭证存储保管。',
      'keypilot.credentialSection': '直接填密钥',
      'keypilot.credentialRefPlaceholder': '引用名（如 SENSENOVA_API_KEY_2）',
      'keypilot.credentialValuePlaceholder': '密钥本体',
      'keypilot.credentialSave': '写入并加入池子',
      'keypilot.credentialHint': '密钥会写进宿主的凭证服务，插件配置里只留引用名。',
      'keypilot.providerPlaceholder': '提供商 ID，如 deepseek',
      'keypilot.noProviders': '还没有配置任何密钥池。从下面的「内置提供商」里挑一个开始。',
      'keypilot.noKeys': '这个池还没有密钥，请求不会被轮换。',
      'keypilot.statusReady': '就绪',
      'keypilot.statusCooling': '冷却中',
      'keypilot.statusPaused': '已停用',
      'keypilot.statusRevoked': '已作废',
      'keypilot.statusExpired': '已过期',
      'keypilot.statusThrottled': '已限流',
      'keypilot.used': '已用 {n} 次',
      'keypilot.tokens': '{n} tokens',
      'keypilot.ttft': '首字 p95 {n}ms',
      'keypilot.failures': '连续失败 {n} 次',
      'keypilot.delete': '删除',
      'keypilot.pause': '停用',
      'keypilot.resume': '启用',
      'keypilot.catalogHint': '点一下即可添加预设；端点、协议与模型会带进池子的「路由设置」，随时可改。',
      'keypilot.customHint': '宿主的提供商目录里没有的网关，在这里声明一条真正的模型路由。',
      'keypilot.routeId': '路由 ID',
      'keypilot.routeName': '显示名',
      'keypilot.routeBaseUrl': 'Base URL',
      'keypilot.routeApi': '线上协议',
      'keypilot.routeModels': '模型 ID（逗号分隔）',
      'keypilot.routeSection': '路由设置',
      'keypilot.routeFromPreset': '当前值来自内置预设，可直接修改',
      'keypilot.routeAdd': '注册这条路由',
      'keypilot.routeErrors': '路由注册诊断',
      'keypilot.cascadeHint': '主提供商的密钥全部冷却时，按这个顺序尝试备用提供商。',
      'keypilot.cascadeFrom': '备用提供商 ID',
      'keypilot.cascadeModel': '替代模型（可选）',
      'keypilot.cascadeAdd': '添加级联目标',
      'keypilot.noEvents': '暂无事件。发生切换时会在这里实时显示。',
      'keypilot.eventSwitch': '{provider}：{ref} → {kind}（冷却 {s}s）',
      'keypilot.eventSuccess': '{provider}：{ref} 成功（首字 {ms}ms）',
      'keypilot.eventCascade': '级联：{from} → {to}',
      'keypilot.warnings': '配置提示',
      'keypilot.configFile': '配置文件',
      'keypilot.healthScore': '健康度',

      'keypilot.sectionCanary': '金丝雀探测',
      'keypilot.canaryEnable': '冷却中密钥探活',
      'keypilot.canaryDesc': '对冷却中的密钥发一次免费的 /models 请求。成功即让它提前归队，不必干等整个冷却期；确认仍在限流的则继续等待，鉴权失败的直接长期隔离。',
      'keypilot.canaryInterval': '探测间隔',
      'keypilot.canaryIntervalUnit': '分钟',
      'keypilot.canaryRun': '立即探测',
      'keypilot.canaryHint': '探测只会打到能确定端点的提供商：声明式路由、内置目录里的条目，或你在池子里显式填的探活端点。',

      'keypilot.sectionNotify': 'Webhook 通知',
      'keypilot.notifyEnable': '启用推送',
      'keypilot.notifyUrl': 'Webhook 地址',
      'keypilot.notifyUrlPlaceholder': 'https://api.telegram.org/bot…/sendMessage?chat_id=…',
      'keypilot.notifyUrlHint': '支持 Telegram / Discord / Slack，也接受任意 HTTP 端点（发 JSON）。地址里常带 token，请用 https。',
      'keypilot.notifyKind': '载荷格式',
      'keypilot.notifyTest': '发送测试',
      'keypilot.notifyEvents': '推送哪些事件',
      'keypilot.notifyPending': '待发 {n} 条',
      'keypilot.notifyDropped': '已丢弃 {n} 条',
      'keypilot.notifyCooling': '推送失败，退避中（{s}s）',
      'keypilot.eventSwitchLabel': '密钥切换',
      'keypilot.eventCascadeLabel': '提供商级联',
      'keypilot.eventExhaustionLabel': '池子耗尽',
      'keypilot.eventProbeLabel': '探测结果',

      'keypilot.sectionUsage': '用量与成本',
      'keypilot.usageToday': '今日',
      'keypilot.usageTotal': '累计',
      'keypilot.usageRequests': '请求',
      'keypilot.usageTokens': 'token',
      'keypilot.usageCost': '估算成本',
      'keypilot.usageFailures': '失败',
      'keypilot.usageSwitches': '切换',
      'keypilot.usageHint': '成本按内置价目估算，只适合用来比较不同密钥/提供商的相对开销——请以服务商账单为准。',
      'keypilot.usageExportCsv': '导出 CSV',
      'keypilot.usageExportJson': '导出 JSON',
      'keypilot.usageClear': '清空账本',
      'keypilot.usageEmpty': '暂无用量数据（统计自插件启用起）',
      'keypilot.usageByProvider': '按提供商',
      'keypilot.usageRetain': '保留 {n} 天',
    }

    const en = {
      'keypilot.title': 'Key Rotation',
      'keypilot.subtitle': 'Multi-key rotation, predictive rate-limit guard and cross-provider failover',
      'keypilot.loading': 'Loading state…',
      'keypilot.error': 'Failed to load state: {error}',
      'keypilot.retry': 'Retry',
      'keypilot.refresh': 'Refresh',
      'keypilot.save': 'Save',
      'keypilot.saving': 'Saving…',
      'keypilot.saved': 'Saved and applied',
      'keypilot.reset': 'Reset cooldowns',
      'keypilot.syncRoutes': 'Re-register routes',
      'keypilot.healthy': 'Healthy',
      'keypilot.cooling': 'Cooling down',
      'keypilot.exhausted': 'Pool exhausted',
      'keypilot.disabled': 'Disabled',
      'keypilot.pools': '{n} pool(s)',
      'keypilot.keys': '{n} key(s)',
      'keypilot.sectionGeneral': 'General',
      'keypilot.sectionFailover': 'Failover & rate limits',
      'keypilot.sectionPools': 'Key pools',
      'keypilot.sectionCatalog': 'Built-in providers',
      'keypilot.sectionCustom': 'Custom providers',
      'keypilot.sectionCascade': 'Cross-provider cascade',
      'keypilot.sectionEvents': 'Live event stream',
      'keypilot.enable': 'Enable key rotation',
      'keypilot.enableDesc': 'When off, credentials resolve natively; pools and cooldowns are preserved.',
      'keypilot.strategy': 'Routing strategy',
      'keypilot.strategyDesc': 'Round-robin, least-loaded, or lowest-latency.',
      'keypilot.concurrency': 'Concurrency limit per key',
      'keypilot.concurrencyDesc': '0 means unlimited.',
      'keypilot.rpm': 'Requests per minute (per key)',
      'keypilot.tpm': 'Tokens per minute (per key)',
      'keypilot.cooldown': 'Failure cooldown',
      'keypilot.cooldownDesc': 'Hard failures back off exponentially; soft failures use a short flat cooldown.',
      'keypilot.switchKinds': 'Errors that trigger a switch',
      'keypilot.switchKindsDesc': 'Only these kinds rotate to the next key. User aborts and bad requests never switch.',
      'keypilot.breaker': 'Circuit breaker',
      'keypilot.breakerDesc': 'Fail fast after consecutive failures instead of hammering every key.',
      'keypilot.threshold': 'Failure threshold',
      'keypilot.openMs': 'Open duration',
      'keypilot.quotaWindow': 'Quota reset window',
      'keypilot.quotaWindowDesc': 'Which midnight resets the daily quota. Pacific handles DST automatically.',
      'keypilot.addProvider': 'Add provider',
      'keypilot.addKey': 'Add key reference',
      'keypilot.keyPlaceholder': 'Credential ref, e.g. DEEPSEEK_API_KEY_2',
      'keypilot.keyHint': 'Reference names only here; secrets live in the host credential store.',
      'keypilot.credentialSection': 'Save a key directly',
      'keypilot.credentialRefPlaceholder': 'Reference name (e.g. SENSENOVA_API_KEY_2)',
      'keypilot.credentialValuePlaceholder': 'Secret value',
      'keypilot.credentialSave': 'Save & add to pool',
      'keypilot.credentialHint': 'The secret goes to the host credential service; only the reference name stays in the plugin config.',
      'keypilot.providerPlaceholder': 'Provider id, e.g. deepseek',
      'keypilot.noProviders': 'No key pools yet. Pick one from Built-in providers below.',
      'keypilot.noKeys': 'This pool has no keys, so requests are not rotated.',
      'keypilot.statusReady': 'Ready',
      'keypilot.statusCooling': 'Cooling',
      'keypilot.statusPaused': 'Paused',
      'keypilot.statusRevoked': 'Revoked',
      'keypilot.statusExpired': 'Expired',
      'keypilot.statusThrottled': 'Throttled',
      'keypilot.used': '{n} used',
      'keypilot.tokens': '{n} tokens',
      'keypilot.ttft': 'TTFT p95 {n}ms',
      'keypilot.failures': '{n} consecutive failures',
      'keypilot.delete': 'Delete',
      'keypilot.pause': 'Pause',
      'keypilot.resume': 'Resume',
      'keypilot.catalogHint': 'Click to add a preset; endpoint, protocol and models land in the pool\'s Route section and stay editable.',
      'keypilot.customHint': 'Declare a real model route for a gateway the host does not serve.',
      'keypilot.routeId': 'Route id',
      'keypilot.routeName': 'Display name',
      'keypilot.routeBaseUrl': 'Base URL',
      'keypilot.routeApi': 'Wire protocol',
      'keypilot.routeModels': 'Model ids (comma separated)',
      'keypilot.routeSection': 'Route',
      'keypilot.routeFromPreset': 'currently from the built-in preset — editable',
      'keypilot.routeAdd': 'Register route',
      'keypilot.routeErrors': 'Route diagnostics',
      'keypilot.cascadeHint': 'When every key of the primary provider is cooling, try these in order.',
      'keypilot.cascadeFrom': 'Fallback provider id',
      'keypilot.cascadeModel': 'Replacement model (optional)',
      'keypilot.cascadeAdd': 'Add cascade target',
      'keypilot.noEvents': 'No events yet. Switches appear here in real time.',
      'keypilot.eventSwitch': '{provider}: {ref} → {kind} (cooldown {s}s)',
      'keypilot.eventSuccess': '{provider}: {ref} ok (TTFT {ms}ms)',
      'keypilot.eventCascade': 'Cascade: {from} → {to}',
      'keypilot.warnings': 'Configuration notes',
      'keypilot.configFile': 'Config file',
      'keypilot.healthScore': 'Health',

      'keypilot.sectionCanary': 'Canary probe',
      'keypilot.canaryEnable': 'Probe cooling keys',
      'keypilot.canaryDesc': 'Sends one free /models request to cooling keys. Success returns the key early instead of waiting out the whole cooldown; still-rate-limited keys keep waiting; auth failures get quarantined.',
      'keypilot.canaryInterval': 'Probe interval',
      'keypilot.canaryIntervalUnit': 'min',
      'keypilot.canaryRun': 'Probe now',
      'keypilot.canaryHint': 'Probing only runs for providers with a known endpoint: a declared route, a built-in preset, or an explicit probe endpoint on the pool.',

      'keypilot.sectionNotify': 'Webhook notifications',
      'keypilot.notifyEnable': 'Enable push',
      'keypilot.notifyUrl': 'Webhook URL',
      'keypilot.notifyUrlPlaceholder': 'https://api.telegram.org/bot…/sendMessage?chat_id=…',
      'keypilot.notifyUrlHint': 'Telegram / Discord / Slack, or any HTTP endpoint receiving JSON. URLs often embed tokens — use https.',
      'keypilot.notifyKind': 'Payload format',
      'keypilot.notifyTest': 'Send test',
      'keypilot.notifyEvents': 'Push which events',
      'keypilot.notifyPending': '{n} pending',
      'keypilot.notifyDropped': '{n} dropped',
      'keypilot.notifyCooling': 'Push failed, backing off ({s}s)',
      'keypilot.eventSwitchLabel': 'Key switch',
      'keypilot.eventCascadeLabel': 'Provider cascade',
      'keypilot.eventExhaustionLabel': 'Pool exhausted',
      'keypilot.eventProbeLabel': 'Probe result',

      'keypilot.sectionUsage': 'Usage & cost',
      'keypilot.usageToday': 'Today',
      'keypilot.usageTotal': 'Total',
      'keypilot.usageRequests': 'requests',
      'keypilot.usageTokens': 'tokens',
      'keypilot.usageCost': 'Estimated cost',
      'keypilot.usageFailures': 'failures',
      'keypilot.usageSwitches': 'switches',
      'keypilot.usageHint': 'Cost is estimated from a built-in price table — good for comparing keys/providers, not for reconciliation. Trust your provider invoice.',
      'keypilot.usageExportCsv': 'Export CSV',
      'keypilot.usageExportJson': 'Export JSON',
      'keypilot.usageClear': 'Clear ledger',
      'keypilot.usageEmpty': 'No usage recorded yet (counted since the plugin loaded)',
      'keypilot.usageByProvider': 'By provider',
      'keypilot.usageRetain': 'Keep {n} days',
    }

    /** 取词典里的文案并做占位符替换。 */
    function makeT(dict) {
      return function t(key, params) {
        const template = dict[key] ?? zh[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (
          params[name] === undefined ? match : String(params[name])
        ))
      }
    }

    /**
     * 跟随浏览器的语言偏好，而不是写死中文：用户的宿主界面是英文时，
     * 一个中文面板会显得格格不入。
     */
    const prefersEnglish = (() => {
      try {
        const langs = Array.isArray(navigator?.languages) && navigator.languages.length > 0
          ? navigator.languages
          : [navigator?.language ?? 'zh']
        return !String(langs[0]).toLowerCase().startsWith('zh')
      } catch {
        return false
      }
    })()
    const t = makeT(prefersEnglish ? en : zh)

    // ── 与主机通信 ──────────────────────────────────────────────────────────

    const STATE_PATH = 'dsh-keypilot/state'
    const CONFIG_PATH = 'dsh-keypilot/config'
    const ACTION_PATH = 'dsh-keypilot/action'
    const FETCH_TIMEOUT_MS = 15_000

    /** 文档相对路径：GUI 用 `<base href="./">` 部署在子路径下时也能正确解析。 */
    async function api(path, init) {
      // 只在**真的有请求体**时才声明 Content-Type。
      //
      // 给 GET 也加上 `Content-Type: application/json` 会让服务端（或它的 body
      // parser）认为后面还跟着一个 JSON 请求体，于是挂起等待一个永远不会到达的
      // 数据流 —— 表现为请求既不成功也不失败，组件就一直停在加载态。这条
      // 只在浏览器里发作，用 curl 测同一路径完全正常，因此极具迷惑性。
      const headers = { ...(init?.headers ?? {}) }
      if (init?.body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch(path, {
        ...init,
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const text = await response.text()
      let payload
      try {
        payload = text.length > 0 ? JSON.parse(text) : {}
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok) {
        throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    // ── 基础控件 ────────────────────────────────────────────────────────────

    const S = {
      card: {
        border: '1px solid rgba(128,128,128,0.22)',
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 12,
        background: 'rgba(128,128,128,0.04)',
      },
      cardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
      cardDesc: { fontSize: 12, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '9px 0',
        borderTop: '1px solid rgba(128,128,128,0.14)',
      },
      rowFirst: { borderTop: 'none', paddingTop: 0 },
      label: { fontSize: 13, fontWeight: 500 },
      sub: { fontSize: 11.5, opacity: 0.58, marginTop: 2, lineHeight: 1.5 },
      input: {
        background: 'rgba(128,128,128,0.1)',
        border: '1px solid rgba(128,128,128,0.24)',
        borderRadius: 6,
        color: 'inherit',
        padding: '5px 9px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        minWidth: 0,
        flex: 1,
      },
      button: {
        background: 'rgba(128,128,128,0.13)',
        border: '1px solid rgba(128,128,128,0.26)',
        borderRadius: 6,
        color: 'inherit',
        padding: '5px 11px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        background: 'rgba(99,102,241,0.22)',
        borderColor: 'rgba(99,102,241,0.5)',
      },
      buttonDanger: {
        background: 'rgba(239,68,68,0.14)',
        borderColor: 'rgba(239,68,68,0.34)',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.3)',
        whiteSpace: 'nowrap',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      grid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
    }

    /** 状态 → 颜色。中性色系，深浅主题下都可见。 */
    const STATUS_COLOR = {
      ready: '#22c55e',
      cooling: '#f59e0b',
      throttled: '#eab308',
      paused: '#94a3b8',
      revoked: '#ef4444',
      expired: '#a855f7',
    }

    function Card(props) {
      return h('div', { style: S.card },
        props.title !== undefined && h('div', { style: S.cardTitle }, props.title),
        props.desc !== undefined && h('div', { style: S.cardDesc }, props.desc),
        props.children)
    }

    function Row(props) {
      return h('div', { style: { ...S.row, ...(props.first === true ? S.rowFirst : {}) } },
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: S.label }, props.label),
          props.desc !== undefined && h('div', { style: S.sub }, props.desc)),
        h('div', { style: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 } }, props.children))
    }

    /** 胶囊开关。 */
    function Toggle(props) {
      const on = props.checked === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        onClick: () => props.onChange?.(!on),
        style: {
          width: 40,
          height: 22,
          borderRadius: 999,
          border: '1px solid rgba(128,128,128,0.3)',
          background: on ? 'rgba(99,102,241,0.85)' : 'rgba(128,128,128,0.25)',
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 140ms',
          flexShrink: 0,
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: on ? 20 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 140ms',
        },
      }))
    }

    function Badge(props) {
      const color = props.color ?? STATUS_COLOR[props.status] ?? '#94a3b8'
      return h('span', { style: { ...S.badge, ...(props.style ?? {}) } },
        h('span', { style: { ...S.dot, background: color } }),
        props.children)
    }

    function Button(props) {
      return h('button', {
        type: 'button',
        disabled: props.disabled === true,
        onClick: props.onClick,
        style: {
          ...S.button,
          ...(props.primary === true ? S.buttonPrimary : {}),
          ...(props.danger === true ? S.buttonDanger : {}),
          ...(props.disabled === true ? { opacity: 0.45, cursor: 'default' } : {}),
          ...(props.style ?? {}),
        },
      }, props.children)
    }

    /** 数字输入：本地暂存，失焦或回车时提交，避免每敲一个字符就写一次配置。 */
    function NumberField(props) {
      const [draft, setDraft] = useState(String(props.value ?? 0))
      const focused = useRef(false)
      useEffect(() => {
        if (!focused.current) setDraft(String(props.value ?? 0))
      }, [props.value])
      const commit = () => {
        const parsed = Number(draft)
        if (Number.isFinite(parsed) && parsed !== props.value) props.onChange?.(parsed)
        else setDraft(String(props.value ?? 0))
      }
      return h('input', {
        type: 'number',
        value: draft,
        min: props.min,
        max: props.max,
        onFocus: () => { focused.current = true },
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => { focused.current = false; commit() },
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
        style: { ...S.input, width: 96, flex: 'none', textAlign: 'right' },
      })
    }

    /** 文本输入：同样在提交时才回写。 */
    function TextField(props) {
      const [draft, setDraft] = useState(props.value ?? '')
      useEffect(() => { setDraft(props.value ?? '') }, [props.value])
      return h('input', {
        type: 'text',
        value: draft,
        placeholder: props.placeholder,
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => { if (draft !== props.value) props.onCommit?.(draft) },
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
        style: { ...S.input, ...(props.style ?? {}) },
      })
    }

    /**
     * 实时回写的文本输入。
     *
     * 与 {@link TextField} 的区别在回写时机：后者刻意等失焦才回写（避免每敲一个键
     * 就触发一次配置保存）。这里回写的只是组件内的草稿，不必省那几次 setState；
     * 而且**必须**实时——「填密钥」的提交按钮一按下去就要读草稿，若还等失焦回写，
     * 按下时读到的会是按下之前的旧值（失焦与点击挤在同一批事件里，处理函数仍是旧闭包）。
     */
    function LiveField(props) {
      return h('input', {
        type: props.type ?? 'text',
        value: props.value ?? '',
        placeholder: props.placeholder,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event) => props.onChange?.(event.target.value),
        style: { ...S.input, ...(props.style ?? {}) },
      })
    }

    // ── 面板主体 ────────────────────────────────────────────────────────────

    const STRATEGY_LABEL = {
      'round-robin': '轮询 / Round-robin',
      'least-loaded': '最小负载 / Least-loaded',
      'lowest-latency': '最低延迟 / Lowest-latency',
    }

    /**
     * 线上协议下拉的选项（自定义提供商与池子路由设置共用一份）。
     *
     * 必须与 `lib/core/provider-catalog.js` 的 `PROTOCOLS` 一致——浏览器端是自包含
     * 模块（只能向宿主 `require`），没法 import core，只能各写一份，所以
     * `tools/verify.mjs` 里有一条断言盯着这两处别漂移。
     */
    const PROTOCOL_OPTIONS = ['openai-completions', 'openai-responses', 'anthropic-messages']

    const KIND_LABEL = {
      RATE_LIMIT: '限流 429',
      QUOTA: '配额耗尽',
      AUTH: '鉴权失败',
      SERVER: '服务端 5xx',
      TIMEOUT: '超时',
      TRANSPORT: '传输错误',
      EMPTY_RESPONSE: '空响应',
      UNKNOWN_MODEL: '模型不存在',
      UNKNOWN: '未知错误',
    }

    /** 可单独开关的通知事件。 */
    const NOTIFY_EVENTS = [
      { key: 'notifyOnSwitch', labelKey: 'keypilot.eventSwitchLabel' },
      { key: 'notifyOnCascade', labelKey: 'keypilot.eventCascadeLabel' },
      { key: 'notifyOnExhaustion', labelKey: 'keypilot.eventExhaustionLabel' },
      { key: 'notifyOnProbe', labelKey: 'keypilot.eventProbeLabel' },
    ]

    /** 紧凑 token 数：12345 → 12.3k。 */
    function formatTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n < 1000) return String(n)
      if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
      if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
      return `${(n / 1_000_000_000).toFixed(1)}B`
    }

    /** 人民币展示：小额保留两位、大额取整。 */
    function formatCost(amount) {
      const value = Number(amount)
      if (!Number.isFinite(value)) return '—'
      if (value === 0) return '¥0'
      if (value < 0.01) return '¥<0.01'
      if (value < 100) return `¥${value.toFixed(2)}`
      return `¥${Math.round(value)}`
    }

    /**
     * 触发一次用量报表下载。
     *
     * 用文档相对路径：GUI 部署在子路径下时也能正确解析（宿主的 `<base href="./">`）。
     * 文件名由服务端的 Content-Disposition 决定，这里给的是兜底名。
     */
    function downloadUsage(format) {
      try {
        const link = document.createElement('a')
        link.href = `dsh-keypilot/usage?format=${format}`
        link.download = `keypilot-usage.${format}`
        document.body.appendChild(link)
        link.click()
        link.remove()
      } catch {
        // 下载失败不该让面板崩掉。
      }
    }

    /** 一行统计：数值 + 标签。 */
    function Stat(props) {
      return h('div', { style: { minWidth: 88, flex: '1 1 88px' } },
        h('div', { style: { fontSize: 15, fontWeight: 500, fontVariantNumeric: 'tabular-nums' } }, props.value),
        h('div', { style: { fontSize: 11.5, opacity: 0.58, marginTop: 2 } }, props.label))
    }

    /**
     * 状态徽章：把整体健康度压成一句话。
     * @returns {{ text: string, color: string }}
     */
    function healthOf(state) {
      if (state === undefined) return { text: t('keypilot.loading'), color: '#94a3b8' }
      if (state.enabled === false) return { text: t('keypilot.disabled'), color: '#94a3b8' }
      let keys = 0
      let cooling = 0
      for (const pool of state.pools ?? []) {
        for (const key of pool.keys) {
          keys += 1
          if (key.status === 'cooling' || key.status === 'expired' || key.status === 'revoked') cooling += 1
        }
      }
      if (keys === 0) return { text: t('keypilot.exhausted'), color: '#ef4444' }
      if (cooling >= keys) return { text: t('keypilot.exhausted'), color: '#ef4444' }
      if (cooling > 0) return { text: t('keypilot.cooling'), color: '#f59e0b' }
      return { text: t('keypilot.healthy'), color: '#22c55e' }
    }

    function formatCountdown(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000))
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m ${total % 60}s`
      const hours = Math.floor(minutes / 60)
      return `${hours}h ${minutes % 60}m`
    }

    /**
     * 「直接填密钥」表单。
     *
     * 写成**只吃 props 的纯组件**（不用任何 hook）是刻意的：这样才能在 Node 里直接
     * 渲染它、断言「有数据时这一块长什么样」。面板主体靠 `useEffect` 取数，服务端
     * 渲染只能到加载态为止——而历史教训恰恰是「只在某个数据分支里崩」。
     *
     * 密钥值只经 `onSubmit` 交给主机端，由主机写进宿主的凭据服务；插件自己的配置里
     * 永远只有引用名。
     */
    function CredentialForm(props) {
      const { t, pool, credentials, busy, draft, onPatch, onSubmit } = props
      // 宿主没暴露凭据写入接口时整块不渲染——省得用户填完才发现写不进去。
      if (credentials?.writable !== true) return null

      const refName = draft?.ref ?? credentials.suggestedRefs?.[pool.provider] ?? ''
      const secret = draft?.value ?? ''
      const ready = secret.trim().length > 0

      return h('div', { style: { marginTop: 9 } },
        h('div', { style: { fontSize: 11.5, opacity: 0.65, marginBottom: 5 } }, t('keypilot.credentialSection')),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h(LiveField, {
            value: refName,
            placeholder: t('keypilot.credentialRefPlaceholder'),
            onChange: (value) => onPatch({ ref: value }),
            style: { flex: 1, minWidth: 170 },
          }),
          h(LiveField, {
            value: secret,
            type: 'password',
            placeholder: t('keypilot.credentialValuePlaceholder'),
            onChange: (value) => onPatch({ value }),
            style: { flex: 1, minWidth: 170 },
          }),
          h(Button, {
            primary: true,
            disabled: busy === true || !ready,
            onClick: () => { if (ready) onSubmit(refName, secret) },
          }, t('keypilot.credentialSave'))),
        h('div', { style: { fontSize: 11.5, opacity: 0.55, marginTop: 5 } }, t('keypilot.credentialHint')))
    }

    function KeypilotSection(props) {
      const { close } = props ?? {}
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(undefined)
      const [routeDraft, setRouteDraft] = useState({ id: '', displayName: '', baseURL: '', api: 'openai-completions', models: '' })
      const [cascadeDraft, setCascadeDraft] = useState({ provider: '', model: '' })
      const [newProvider, setNewProvider] = useState('')
      // 「直接填密钥」表单的草稿，按提供商分开存：一个池子填到一半时切去看别的池子，
      // 回来不该发现输入被清空了。密钥值只活在这个 state 里，提交后立刻丢弃。
      const [credentialDrafts, setCredentialDrafts] = useState({})
      const pollTimer = useRef(undefined)

      const refresh = useCallback(async () => {
        try {
          const next = await api(STATE_PATH)
          setState(next)
          setError(undefined)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      // 只在分区打开时轮询；页面隐藏时暂停，避免白烧请求。
      useEffect(() => {
        let alive = true
        const tick = () => { if (alive && document.visibilityState !== 'hidden') void refresh() }
        void refresh()
        pollTimer.current = setInterval(tick, 5000)
        document.addEventListener('visibilitychange', tick)
        return () => {
          alive = false
          if (pollTimer.current !== undefined) clearInterval(pollTimer.current)
          document.removeEventListener('visibilitychange', tick)
        }
      }, [refresh])

      const config = state?.config

      /** 写配置：整体保存。 */
      const save = useCallback(async (patch) => {
        if (config === undefined) return
        setBusy(true)
        try {
          const payload = { ...config, ...patch }
          const result = await api(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(payload) })
          setNotice({ kind: 'ok', text: result.message ?? t('keypilot.saved') })
          await refresh()
        } catch (failure) {
          setNotice({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          setBusy(false)
        }
      }, [config, refresh])

      /** 写配置：只改某一个提供商条目。 */
      const saveProvider = useCallback((providerId, mutate) => {
        if (config === undefined) return
        const providers = config.providers.map((entry) => (
          entry.provider === providerId ? mutate({ ...entry }) : entry
        ))
        void save({ providers })
      }, [config, save])

      const addProvider = useCallback((providerId, route) => {
        if (config === undefined) return
        const id = String(providerId).trim()
        if (id.length === 0) return
        if (config.providers.some((entry) => entry.provider === id)) {
          setNotice({ kind: 'error', text: `提供商 ${id} 已经在池子里了` })
          return
        }
        const entry = { provider: id, keys: [] }
        if (route !== undefined) {
          entry.route = route
          entry.rpmLimit = config.rpmLimit
          entry.tpmLimit = config.tpmLimit
          entry.cooldownMs = config.cooldownMs
          entry.concurrencyLimit = config.concurrencyLimit
          entry.routingStrategy = config.routingStrategy
        }
        void save({ providers: [...config.providers, entry] })
      }, [config, save])

      const removeProvider = useCallback((providerId) => {
        if (config === undefined) return
        void save({ providers: config.providers.filter((entry) => entry.provider !== providerId) })
      }, [config, save])

      const runAction = useCallback(async (payload) => {
        setBusy(true)
        try {
          const result = await api(ACTION_PATH, { method: 'POST', body: JSON.stringify(payload) })
          setNotice({ kind: 'ok', text: result.message })
          await refresh()
          // 返回结果，让调用方知道这一步到底成不成（例如「填密钥」成功后才清空输入框）。
          return result
        } catch (failure) {
          setNotice({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
          return undefined
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const catalog = state?.catalog ?? []
      const health = healthOf(state)

      const totalKeys = useMemo(
        () => (state?.pools ?? []).reduce((sum, pool) => sum + pool.size, 0),
        [state],
      )

      // ── 加载 / 错误 ───────────────────────────────────────────────────────

      if (error !== undefined && state === undefined) {
        return h('div', { style: { padding: 16 } },
          h('div', { style: { color: '#ef4444', fontSize: 13, marginBottom: 10 } }, t('keypilot.error', { error })),
          h(Button, { onClick: refresh, primary: true }, t('keypilot.retry')))
      }

      if (state === undefined || config === undefined) {
        return h('div', { style: { padding: 16, opacity: 0.6, fontSize: 13 } }, t('keypilot.loading'))
      }

      // ── 顶部 ──────────────────────────────────────────────────────────────

      const header = h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' },
      },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, t('keypilot.title')),
        h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2 } }, t('keypilot.subtitle'))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h(Badge, { color: health.color }, health.text),
        h(Badge, {}, t('keypilot.pools', { n: state.pools.length })),
        h(Badge, {}, t('keypilot.keys', { n: totalKeys })),
        h(Button, { onClick: refresh, disabled: busy }, t('keypilot.refresh')),
        close !== undefined && h(Button, { onClick: close }, '关闭')))

      const noticeBar = notice !== undefined && h('div', {
        style: {
          fontSize: 12,
          padding: '7px 11px',
          borderRadius: 6,
          marginBottom: 10,
          background: notice.kind === 'ok' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
          border: `1px solid ${notice.kind === 'ok' ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`,
        },
      }, notice.text)

      const warnings = (state.warnings ?? []).length > 0 && h(Card, { title: t('keypilot.warnings') },
        ...(state.warnings).map((warning, index) => h('div', {
          key: index,
          style: { fontSize: 12, opacity: 0.75, padding: '3px 0', ...S.mono },
        }, `· ${warning}`)))

      // ── 常规 ──────────────────────────────────────────────────────────────

      const general = h(Card, { title: t('keypilot.sectionGeneral') },
        h(Row, {
          label: t('keypilot.enable'),
          desc: t('keypilot.enableDesc'),
          first: true,
        }, h(Toggle, { checked: config.enabled !== false, onChange: (value) => save({ enabled: value }) })),

        h(Row, { label: t('keypilot.strategy'), desc: t('keypilot.strategyDesc') },
          h('select', {
            value: config.routingStrategy,
            onChange: (event) => save({ routingStrategy: event.target.value }),
            style: { ...S.input, width: 200, flex: 'none' },
          }, ...Object.entries(STRATEGY_LABEL).map(([value, label]) => h('option', { key: value, value }, label)))),

        h(Row, { label: t('keypilot.concurrency'), desc: t('keypilot.concurrencyDesc') },
          h(NumberField, { value: config.concurrencyLimit, min: 0, max: 1000, onChange: (value) => save({ concurrencyLimit: value }) })),

        h(Row, { label: t('keypilot.rpm') },
          h(NumberField, { value: config.rpmLimit, min: 0, onChange: (value) => save({ rpmLimit: value }) })),

        h(Row, { label: t('keypilot.tpm') },
          h(NumberField, { value: config.tpmLimit, min: 0, onChange: (value) => save({ tpmLimit: value }) })),

        h(Row, { label: t('keypilot.quotaWindow'), desc: t('keypilot.quotaWindowDesc') },
          h('select', {
            value: config.quotaResetWindow?.type ?? 'midnight_utc',
            onChange: (event) => save({ quotaResetWindow: { type: event.target.value, hour: 0 } }),
            style: { ...S.input, width: 200, flex: 'none' },
          },
          h('option', { value: 'midnight_utc' }, 'UTC 午夜'),
          h('option', { value: 'midnight_pst' }, '太平洋时间午夜'),
          h('option', { value: 'midnight_local' }, '本地时区午夜'),
          h('option', { value: 'rolling_24h' }, '滚动 24 小时'))))

      // ── 故障转移与限流 ────────────────────────────────────────────────────

      const switchKinds = config.switchKinds ?? []
      const toggleKind = (kind) => {
        const next = switchKinds.includes(kind)
          ? switchKinds.filter((item) => item !== kind)
          : [...switchKinds, kind]
        void save({ switchKinds: next })
      }

      const failover = h(Card, { title: t('keypilot.sectionFailover') },
        h('div', { style: { paddingBottom: 10 } },
          h('div', { style: S.label }, t('keypilot.switchKinds')),
          h('div', { style: S.sub }, t('keypilot.switchKindsDesc')),
          h('div', { style: { ...S.chips, marginTop: 10 } },
            ...Object.entries(KIND_LABEL).map(([kind, label]) => {
              const active = switchKinds.includes(kind)
              return h('button', {
                key: kind,
                type: 'button',
                onClick: () => toggleKind(kind),
                style: {
                  ...S.badge,
                  cursor: 'pointer',
                  background: active ? 'rgba(99,102,241,0.2)' : 'transparent',
                  borderColor: active ? 'rgba(99,102,241,0.55)' : 'rgba(128,128,128,0.3)',
                  opacity: active ? 1 : 0.6,
                  padding: '3px 10px',
                  fontSize: 11.5,
                },
              }, label)
            }))),

        h(Row, { label: t('keypilot.cooldown'), desc: t('keypilot.cooldownDesc') },
          h(NumberField, { value: config.cooldownMs, min: 1000, onChange: (value) => save({ cooldownMs: value }) })),

        h(Row, { label: t('keypilot.breaker'), desc: t('keypilot.breakerDesc') },
          h(Toggle, { checked: config.circuitBreakerEnabled !== false, onChange: (value) => save({ circuitBreakerEnabled: value }) })),

        h(Row, { label: t('keypilot.threshold') },
          h(NumberField, { value: config.circuitBreakerThreshold, min: 1, max: 100, onChange: (value) => save({ circuitBreakerThreshold: value }) })),

        h(Row, { label: t('keypilot.openMs') },
          h(NumberField, { value: config.circuitBreakerOpenMs, min: 1000, onChange: (value) => save({ circuitBreakerOpenMs: value }) })))

      // ── 密钥池 ────────────────────────────────────────────────────────────

      const pools = state.pools ?? []
      // 必须始终返回**数组**：下面用 `...poolCards` 把它展开成 children。
      // 「池子为空」时若直接返回单个元素，spread 会抛
      // `Spread syntax requires ...iterable[Symbol.iterator] to be a function`，
      // 宿主会把它记成 `slot entry crashed in 'settings.section'` 并渲染空白 ——
      // 而空池恰是新装插件的默认状态，所以这条路径一定会被走到。
      const poolCards = pools.length === 0
        ? [h('div', {
          key: 'empty-pools',
          style: { fontSize: 12.5, opacity: 0.6, padding: '6px 0' },
        }, t('keypilot.noProviders'))]
        : pools.map((pool) => {
          const entry = config.providers.find((item) => item.provider === pool.provider) ?? { provider: pool.provider, keys: [] }
          return h('div', {
            key: pool.provider,
            style: {
              border: '1px solid rgba(128,128,128,0.2)',
              borderRadius: 8,
              padding: '11px 13px',
              marginBottom: 10,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: 13, fontWeight: 600, ...S.mono } }, pool.provider),
              h('div', { style: S.sub },
                `${pool.keys.length} 把密钥 · ${STRATEGY_LABEL[pool.strategy] ?? pool.strategy}`
                + (pool.limits.rpm > 0 ? ` · ${pool.limits.rpm} rpm` : '')
                + (pool.limits.tpm > 0 ? ` · ${pool.limits.tpm} tpm` : ''))),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h(Button, {
                onClick: () => runAction({ action: 'reset-cooldown', provider: pool.provider }),
                disabled: busy,
              }, t('keypilot.reset')),
              h(Button, {
                danger: true,
                onClick: () => removeProvider(pool.provider),
                disabled: busy,
              }, t('keypilot.delete')))),

          pool.keys.length === 0 && h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 8 } }, t('keypilot.noKeys')),

          ...pool.keys.map((key) => {
            const label = {
              ready: t('keypilot.statusReady'),
              cooling: t('keypilot.statusCooling'),
              paused: t('keypilot.statusPaused'),
              revoked: t('keypilot.statusRevoked'),
              expired: t('keypilot.statusExpired'),
              throttled: t('keypilot.statusThrottled'),
            }[key.status] ?? key.status
            const details = []
            if (key.usage.requests > 0) details.push(t('keypilot.used', { n: key.usage.requests }))
            if (key.usage.tokens > 0) details.push(t('keypilot.tokens', { n: key.usage.tokens }))
            if (key.latency?.p95 !== undefined) details.push(t('keypilot.ttft', { n: Math.round(key.latency.p95) }))
            if (key.failures > 0) details.push(t('keypilot.failures', { n: key.failures }))
            if (key.cooldownMs > 0) details.push(formatCountdown(key.cooldownMs))

            return h('div', {
              key: key.ref,
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '7px 0',
                borderTop: '1px solid rgba(128,128,128,0.14)',
                flexWrap: 'wrap',
              },
            },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
                h(Badge, { status: key.status }, label),
                h('span', { style: { fontSize: 12.5, ...S.mono } }, key.ref),
                key.inFlight > 0 && h('span', { style: { fontSize: 11, opacity: 0.6 } }, `· ${key.inFlight} 在飞`)),
              details.length > 0 && h('div', { style: { ...S.sub, ...S.mono } }, details.join(' · '))),

            h('div', { style: { display: 'flex', gap: 6 } },
              h(Button, {
                onClick: () => runAction({
                  action: 'toggle-key',
                  provider: pool.provider,
                  ref: key.ref,
                  enabled: key.status === 'paused',
                }),
                disabled: busy,
              }, key.status === 'paused' ? t('keypilot.resume') : t('keypilot.pause')),
              h(Button, {
                danger: true,
                disabled: busy,
                onClick: () => saveProvider(pool.provider, (next) => ({
                  ...next,
                  keys: (next.keys ?? []).filter((item) => item !== key.ref),
                })),
              }, t('keypilot.delete'))))
          }),

          h('div', { style: { display: 'flex', gap: 6, marginTop: 10 } },
            h(TextField, {
              value: '',
              placeholder: t('keypilot.keyPlaceholder'),
              onCommit: (value) => {
                const ref = value.trim()
                if (ref.length === 0) return
                saveProvider(pool.provider, (next) => ({ ...next, keys: [...(next.keys ?? []), ref] }))
              },
            }),
            h('span', { style: { fontSize: 11.5, opacity: 0.55, alignSelf: 'center' } }, t('keypilot.keyHint'))),

          // ── 直接填密钥 ────────────────────────────────────────────────────
          h(CredentialForm, {
            key: 'credential',
            t,
            pool,
            credentials: state.credentials,
            busy,
            draft: credentialDrafts[pool.provider] ?? {},
            onPatch: (patch) => setCredentialDrafts((all) => ({
              ...all,
              [pool.provider]: { ...(all[pool.provider] ?? {}), ...patch },
            })),
            onSubmit: (ref, value) => {
              void runAction({ action: 'set-credential', provider: pool.provider, ref, value }).then((result) => {
                // 只有真写成功了才清空密钥框：失败时留着，用户改改就能重提，
                // 不用重新粘一次。
                if (result !== undefined) {
                  setCredentialDrafts((all) => ({
                    ...all,
                    [pool.provider]: { ...(all[pool.provider] ?? {}), value: '' },
                  }))
                }
              })
            },
          }),

          // ── 路由设置 ──────────────────────────────────────────────────────
          //
          // 没有这一块，「点一下预设」就只剩「接受」一个选项：端点、协议、模型
          // 都是写死的默认值，而预设值一定会过期（服务商改端点、模型上下架）。
          // 这里让每一项都能原地改——改完立即重新注册路由。
          (() => {
            const preset = catalog.find((item) => item.id === pool.provider)
            // 池子没有自己的 route 时，把目录预设作为**待编辑的初始值**显示出来，
            // 让用户看见「点预设到底写入了什么」，而不是面对一片空白。
            const shown = entry.route ?? (preset === undefined ? undefined : {
              id: preset.id,
              displayName: preset.label,
              baseURL: preset.baseURL,
              api: preset.api,
              models: preset.models,
            })
            const modelsText = (shown?.models ?? []).join(', ')
            const fromPreset = entry.route === undefined && preset !== undefined

            const writeRoute = (patch) => {
              const baseURL = (patch.baseURL ?? shown?.baseURL ?? '').trim()
              const api = patch.api ?? shown?.api ?? PROTOCOL_OPTIONS[0]
              const models = String(patch.models ?? modelsText)
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
              saveProvider(pool.provider, (next) => {
                // 端点与模型都清空 → 去掉 route，交回宿主自己的路由。
                if (baseURL.length === 0 && models.length === 0) {
                  const { route: _dropped, ...rest } = next
                  return rest
                }
                return {
                  ...next,
                  route: {
                    id: pool.provider,
                    displayName: next.route?.displayName ?? shown?.displayName ?? pool.provider,
                    baseURL,
                    api,
                    models,
                  },
                }
              })
            }

            return h('div', {
              style: {
                marginTop: 11,
                paddingTop: 10,
                borderTop: '1px solid rgba(128,128,128,0.14)',
              },
            },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('span', { style: { fontSize: 11.5, opacity: 0.65 } }, t('keypilot.routeSection')),
              fromPreset && h('span', {
                style: { fontSize: 11, opacity: 0.5 },
              }, t('keypilot.routeFromPreset'))),
            h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
              h(TextField, {
                value: shown?.baseURL ?? '',
                placeholder: `${t('keypilot.routeBaseUrl')} — https://api.example.com/v1`,
                onCommit: (value) => writeRoute({ baseURL: value }),
                style: { flex: 1, minWidth: 200 },
              }),
              h('select', {
                value: shown?.api ?? PROTOCOL_OPTIONS[0],
                onChange: (event) => writeRoute({ api: event.target.value }),
                style: { ...S.input, maxWidth: 190 },
              },
              ...PROTOCOL_OPTIONS.map((protocol) => h('option', { key: protocol, value: protocol }, protocol)))),
            h(TextField, {
              value: modelsText,
              placeholder: t('keypilot.routeModels'),
              onCommit: (value) => writeRoute({ models: value }),
            }))
          })())
        })

      const poolsCard = h(Card, { title: t('keypilot.sectionPools') },
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
          h(TextField, {
            value: newProvider,
            placeholder: t('keypilot.providerPlaceholder'),
            onCommit: setNewProvider,
            style: { maxWidth: 260 },
          }),
          h(Button, {
            primary: true,
            disabled: busy,
            onClick: () => {
              addProvider(newProvider)
              setNewProvider('')
            },
          }, t('keypilot.addProvider'))),
        ...poolCards)

      // ── 内置提供商目录 ────────────────────────────────────────────────────

      const groups = new Map()
      for (const item of catalog) {
        if (!groups.has(item.group)) groups.set(item.group, [])
        groups.get(item.group).push(item)
      }

      const catalogCard = h(Card, { title: t('keypilot.sectionCatalog'), desc: t('keypilot.catalogHint') },
        ...[...groups.entries()].map(([group, items]) => h('div', { key: group, style: { marginBottom: 10 } },
          h('div', { style: { fontSize: 11.5, opacity: 0.6, marginBottom: 5 } }, group),
          h('div', { style: S.grid },
            ...items.map((item) => {
              const already = config.providers.some((entry) => entry.provider === item.id)
              return h('button', {
                key: item.id,
                type: 'button',
                disabled: already || busy,
                title: `${item.baseURL}\n${item.note ?? ''}`,
                onClick: () => addProvider(item.id, {
                  id: item.id,
                  displayName: item.label,
                  baseURL: item.baseURL,
                  api: item.api,
                  models: item.models,
                }),
                style: {
                  ...S.badge,
                  padding: '5px 11px',
                  fontSize: 12,
                  cursor: already ? 'default' : 'pointer',
                  opacity: already ? 0.4 : 1,
                  background: already ? 'rgba(34,197,94,0.1)' : 'rgba(128,128,128,0.08)',
                },
              }, item.label)
            })))))

      // ── 自定义提供商 ──────────────────────────────────────────────────────

      const routeErrors = state.routes?.errors ?? []
      const customCard = h(Card, { title: t('keypilot.sectionCustom'), desc: t('keypilot.customHint') },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
          h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
            h(TextField, {
              value: routeDraft.id,
              placeholder: t('keypilot.routeId'),
              onCommit: (value) => setRouteDraft((draft) => ({ ...draft, id: value })),
            }),
            h(TextField, {
              value: routeDraft.displayName,
              placeholder: t('keypilot.routeName'),
              onCommit: (value) => setRouteDraft((draft) => ({ ...draft, displayName: value })),
            })),
          h(TextField, {
            value: routeDraft.baseURL,
            placeholder: `${t('keypilot.routeBaseUrl')} — https://api.example.com/v1`,
            onCommit: (value) => setRouteDraft((draft) => ({ ...draft, baseURL: value })),
          }),
          h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
            h('select', {
              value: routeDraft.api,
              onChange: (event) => setRouteDraft((draft) => ({ ...draft, api: event.target.value })),
              style: { ...S.input, maxWidth: 220 },
            },
            ...PROTOCOL_OPTIONS.map((protocol) => h('option', { key: protocol, value: protocol }, protocol))),
            h(TextField, {
              value: routeDraft.models,
              placeholder: t('keypilot.routeModels'),
              onCommit: (value) => setRouteDraft((draft) => ({ ...draft, models: value })),
            })),
          h('div', { style: { display: 'flex', gap: 7 } },
            h(Button, {
              primary: true,
              disabled: busy || routeDraft.id.trim().length === 0,
              onClick: () => {
                const models = routeDraft.models.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
                addProvider(routeDraft.id.trim(), {
                  id: routeDraft.id.trim(),
                  displayName: routeDraft.displayName.trim() || routeDraft.id.trim(),
                  baseURL: routeDraft.baseURL.trim(),
                  api: routeDraft.api,
                  models,
                })
                setRouteDraft({ id: '', displayName: '', baseURL: '', api: 'openai-completions', models: '' })
              },
            }, t('keypilot.routeAdd')),
            h(Button, { onClick: () => runAction({ action: 'sync-routes' }), disabled: busy }, t('keypilot.syncRoutes')))),

        routeErrors.length > 0 && h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, t('keypilot.routeErrors')),
          ...routeErrors.map((item) => h('div', {
            key: item.provider,
            style: { fontSize: 11.5, opacity: 0.75, padding: '3px 0', ...S.mono },
          }, `${item.provider}：${item.message}`))))

      // ── 级联 ──────────────────────────────────────────────────────────────

      const cascade = config.cascade ?? []
      const cascadeCard = h(Card, { title: t('keypilot.sectionCascade'), desc: t('keypilot.cascadeHint') },
        cascade.length === 0 && h('div', { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 } }, '未配置级联目标'),
        ...cascade.map((target, index) => h('div', {
          key: `${target.provider}-${index}`,
          style: { ...S.row, ...(index === 0 ? S.rowFirst : {}) },
        },
        h('span', { style: S.mono }, `${index + 1}. ${target.provider}${target.model === undefined ? '' : ` → ${target.model}`}`),
        h(Button, {
          danger: true,
          disabled: busy,
          onClick: () => save({ cascade: cascade.filter((_, i) => i !== index) }),
        }, t('keypilot.delete')))),
        h('div', { style: { display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' } },
          h(TextField, {
            value: cascadeDraft.provider,
            placeholder: t('keypilot.cascadeFrom'),
            onCommit: (value) => setCascadeDraft((draft) => ({ ...draft, provider: value })),
          }),
          h(TextField, {
            value: cascadeDraft.model,
            placeholder: t('keypilot.cascadeModel'),
            onCommit: (value) => setCascadeDraft((draft) => ({ ...draft, model: value })),
          }),
          h(Button, {
            primary: true,
            disabled: busy || cascadeDraft.provider.trim().length === 0,
            onClick: () => {
              const provider = cascadeDraft.provider.trim()
              const target = { provider }
              if (cascadeDraft.model.trim().length > 0) target.model = cascadeDraft.model.trim()
              void save({ cascade: [...cascade, target] })
              setCascadeDraft({ provider: '', model: '' })
            },
          }, t('keypilot.cascadeAdd'))))

      // ── 金丝雀探测 ────────────────────────────────────────────────────────

      const canaryCard = h(Card, { title: t('keypilot.sectionCanary'), desc: t('keypilot.canaryDesc') },
        h(Row, { label: t('keypilot.canaryEnable'), first: true },
          h(Toggle, {
            checked: config.canaryEnabled !== false,
            onChange: (value) => save({ canaryEnabled: value }),
          })),
        h(Row, { label: t('keypilot.canaryInterval'), desc: t('keypilot.canaryHint') },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(NumberField, {
              value: config.canaryIntervalMinutes,
              min: 1,
              max: 1440,
              onChange: (value) => save({ canaryIntervalMinutes: value }),
            }),
            h('span', { style: { fontSize: 12, opacity: 0.6 } }, t('keypilot.canaryIntervalUnit')))),
        h('div', { style: { marginTop: 10 } },
          h(Button, {
            disabled: busy,
            onClick: () => void runAction({ action: 'probe' }),
          }, t('keypilot.canaryRun'))))

      // ── Webhook 通知 ──────────────────────────────────────────────────────

      const notify = state.notify ?? {}
      const notifyCard = h(Card, { title: t('keypilot.sectionNotify') },
        h(Row, { label: t('keypilot.notifyEnable'), first: true },
          h(Toggle, {
            checked: config.webhookEnabled === true,
            onChange: (value) => save({ webhookEnabled: value }),
          })),

        h(Row, { label: t('keypilot.notifyUrl'), desc: t('keypilot.notifyUrlHint') },
          h(TextField, {
            value: config.webhookUrl ?? '',
            placeholder: t('keypilot.notifyUrlPlaceholder'),
            onCommit: (value) => save({ webhookUrl: value.trim() }),
          })),

        h(Row, { label: t('keypilot.notifyKind') },
          h('select', {
            value: config.webhookKind ?? 'generic',
            onChange: (event) => save({ webhookKind: event.target.value }),
            style: { ...S.input, width: 160, flex: 'none' },
          }, ...['generic', 'telegram', 'discord', 'slack'].map((kind) => h('option', { key: kind, value: kind }, kind)))),

        h('div', { style: { paddingTop: 10 } },
          h('div', { style: S.label }, t('keypilot.notifyEvents')),
          h('div', { style: { ...S.chips, marginTop: 8 } },
            ...NOTIFY_EVENTS.map((item) => {
              const active = config[item.key] === true
              return h('button', {
                key: item.key,
                type: 'button',
                onClick: () => save({ [item.key]: !active }),
                style: {
                  ...S.badge,
                  cursor: 'pointer',
                  padding: '3px 10px',
                  fontSize: 11.5,
                  background: active ? 'rgba(99,102,241,0.2)' : 'transparent',
                  borderColor: active ? 'rgba(99,102,241,0.55)' : 'rgba(128,128,128,0.3)',
                  opacity: active ? 1 : 0.6,
                },
              }, t(item.labelKey))
            }))),

        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 } },
          h(Button, {
            disabled: busy,
            onClick: () => void runAction({ action: 'test-webhook' }),
          }, t('keypilot.notifyTest')),
          notify.pending > 0 && h(Badge, {}, t('keypilot.notifyPending', { n: notify.pending })),
          notify.dropped > 0 && h(Badge, {}, t('keypilot.notifyDropped', { n: notify.dropped })),
          notify.cooling === true && h(Badge, { color: '#f59e0b' },
            t('keypilot.notifyCooling', { s: Math.round((notify.backoffMs ?? 0) / 1000) }))))

      // ── 用量与成本 ────────────────────────────────────────────────────────

      const usage = state.usage ?? { totals: undefined, recent: [] }
      const todayTotals = Array.isArray(usage.recent) && usage.recent.length > 0
        ? usage.recent[usage.recent.length - 1].totals
        : undefined
      const totalTotals = usage.totals

      /** 一行统计组。 */
      const statsRow = (totals, label) => totals === undefined
        ? null
        : h('div', { style: { marginBottom: 10 } },
          h('div', { style: { fontSize: 11.5, opacity: 0.6, marginBottom: 6 } }, label),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            h(Stat, { value: formatTokens(totals.requests), label: t('keypilot.usageRequests') }),
            h(Stat, {
              value: formatTokens(
                totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
              ),
              label: t('keypilot.usageTokens'),
            }),
            h(Stat, { value: formatCost(totals.cost), label: t('keypilot.usageCost') }),
            h(Stat, { value: formatTokens(totals.failures), label: t('keypilot.usageFailures') }),
            h(Stat, { value: formatTokens(totals.switches), label: t('keypilot.usageSwitches') })))

      const hasUsage = totalTotals !== undefined && Number(totalTotals.requests) > 0

      const usageCard = h(Card, {
        title: t('keypilot.sectionUsage'),
        desc: `${t('keypilot.usageHint')}（${t('keypilot.usageRetain', { n: usage.retainDays ?? 30 })}）`,
      },
      hasUsage ? statsRow(totalTotals, t('keypilot.usageTotal')) : h('div', { style: { fontSize: 12, opacity: 0.6 } }, t('keypilot.usageEmpty')),
      hasUsage ? statsRow(todayTotals, t('keypilot.usageToday')) : null,

      hasUsage && h('div', { style: { marginTop: 4 } },
        h('div', { style: { fontSize: 11.5, opacity: 0.6, marginBottom: 6 } }, t('keypilot.usageByProvider')),
        ...(usage.recent?.[usage.recent.length - 1]?.providers ?? []).map((provider) => h('div', {
          key: provider.provider,
          style: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 12 },
        },
        h('span', { style: { ...S.mono, opacity: 0.9 } }, provider.provider),
        h('span', { style: { opacity: 0.65, fontVariantNumeric: 'tabular-nums' } },
          `${provider.totals.requests} 次 · ${formatTokens(provider.totals.inputTokens + provider.totals.outputTokens)} · ${formatCost(provider.totals.cost)}`)))),

      h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
        h(Button, {
          disabled: !hasUsage,
          onClick: () => { downloadUsage('csv') },
        }, t('keypilot.usageExportCsv')),
        h(Button, {
          disabled: !hasUsage,
          onClick: () => { downloadUsage('json') },
        }, t('keypilot.usageExportJson')),
        h(Button, {
          danger: true,
          disabled: busy || !hasUsage,
          onClick: () => void runAction({ action: 'clear-usage' }),
        }, t('keypilot.usageClear'))))

      // ── 事件流 ────────────────────────────────────────────────────────────

      const events = state.events ?? []
      const eventsCard = h(Card, { title: t('keypilot.sectionEvents') },
        events.length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, t('keypilot.noEvents'))
          : h('div', { style: { maxHeight: 220, overflowY: 'auto' } },
            ...[...events].reverse().map((event, index) => {
              let text
              if (event.type === 'switch') {
                text = t('keypilot.eventSwitch', {
                  provider: event.provider,
                  ref: event.from,
                  kind: KIND_LABEL[event.kind] ?? event.kind,
                  s: Math.round((event.cooldownMs ?? 0) / 1000),
                })
              } else if (event.type === 'cascade') {
                text = t('keypilot.eventCascade', { from: event.from, to: event.to })
              } else if (event.type === 'exhaustion') {
                const chain = Array.isArray(event.attempted) && event.attempted.length > 0
                  ? `（已尝试 ${event.attempted.join(' → ')}）`
                  : ''
                text = `${t('keypilot.eventExhaustionLabel')}：${event.provider}${chain}`
              } else if (event.type === 'probe') {
                text = `${t('keypilot.eventProbeLabel')}：${event.provider}/${event.ref} → ${event.outcome}`
              } else {
                text = t('keypilot.eventSuccess', {
                  provider: event.provider,
                  ref: event.ref,
                  ms: Math.round(event.ttftMs ?? 0),
                })
              }
              const color = event.type === 'success'
                ? '#22c55e'
                : event.type === 'cascade'
                  ? '#a855f7'
                  : event.type === 'exhaustion'
                    ? '#ef4444'
                    : '#f59e0b'
              return h('div', {
                key: index,
                style: {
                  fontSize: 11.5,
                  padding: '4px 0',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  ...S.mono,
                },
              },
              h('span', { style: { opacity: 0.5, flexShrink: 0 } }, new Date(event.at).toLocaleTimeString()),
              h('span', { style: { ...S.dot, background: color, alignSelf: 'center' } }),
              h('span', { style: { opacity: 0.85 } }, text))
            })))

      const footer = h('div', { style: { fontSize: 11, opacity: 0.45, marginTop: 4, ...S.mono } },
        `${t('keypilot.configFile')}：${state.paths?.configFile ?? '—'}`)

      return h('div', { style: { padding: '0 2px 24px' } },
        header, noticeBar, warnings, general, failover,
        poolsCard, catalogCard, customCard, cascadeCard,
        canaryCard, notifyCard, usageCard, eventsCard, footer)
    }

    // ── 插件装配 ────────────────────────────────────────────────────────────

    /** 分区在左侧导航里的排序位置。 */
    const SECTION_ORDER = 152

    /**
     * 内置提供商目录随状态一起下发（主机端是唯一事实来源），这里只留一个兜底，
     * 避免主机不可用时面板整个空掉。
     */
    exports.inject = ['slots', 'locale']

    /**
     * 客户端插件主体。
     * @param {object} ctx
     */
    // 供测试直接渲染：这个纯组件走的正是「有数据时」的渲染路径，而面板主体在
    // 服务端渲染里只能到加载态为止。下划线前缀表示它不是给宿主用的公开导出。
    exports.__CredentialForm = CredentialForm

    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return () => {}
        }
      }, 'keypilot: 文案')

      ctx.slots.inject('settings.section', () => {
        try {
          const unregister = ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-keypilot',
            order: SECTION_ORDER,
            label: () => {
              try {
                return ctx.locale.bind(NS)('keypilot.title')
              } catch (error) {
                console.warn('[keypilot] label 取值失败，退回字面量：', error)
                return '密钥轮换'
              }
            },
            locale: NS,
            inject: () => ({ keypilot: true }),
          }, KeypilotSection)
          return () => {
            try {
              unregister()
            } catch {
              // 分区已随面板一起卸载。
            }
          }
        } catch (error) {
          console.error('[keypilot] 注册设置分区失败：', error)
          return () => {}
        }
      })
    }

    return module.exports
  },
})
