/**
 * 内置提供商目录 —— 常用服务商的开箱即用预设。
 *
 * 目录只描述「路由形状」（Base URL、线上协议、建议模型 ID、密钥环境变量名），
 * 不包含任何密钥，也不代表该服务商一定可用：模型 ID 与端点会随服务商演进而变化，
 * 因此每个条目都只是**可编辑的默认值**，用户应在设置面板里按自己账号的实际
 * 可用模型做调整。
 *
 * 与「自定义提供商」的关系：目录条目本身就是一条声明式路由。把内置条目加进池子
 * 时，若宿主的提供商目录里没有它，插件就按同一套 route-schema 逻辑向宿主注册路由
 * —— 因此内置条目与手写自定义条目走的是**完全相同**的代码路径，不存在两套实现。
 *
 * @module @sucooer/dsh-keypilot/core/provider-catalog
 */

/** 宿主 pi-ai 适配器支持的线上协议。 */
export const PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/**
 * @typedef {object} CatalogProvider
 * @property {string} id        路由 ID（写入设置后原样用作宿主 provider id）
 * @property {string} label     界面显示名
 * @property {string} group     界面分组
 * @property {string} baseURL   线上端点，必须以 http(s):// 开头
 * @property {string} api       线上协议，见 {@link PROTOCOLS}
 * @property {string} keyEnv    建议的密钥环境变量名
 * @property {string[]} models  建议模型 ID（可编辑）
 * @property {string} [docs]    控制台/文档地址
 * @property {string} [note]    使用提示
 * @property {boolean} [local]  是否为本地/自托管端点
 * @property {boolean} [unauthenticatedProbe] 模型列表无需鉴权（探活成功证明不了密钥有效）
 */

/** @type {readonly CatalogProvider[]} */
export const BUILTIN_PROVIDERS = Object.freeze([
  // ── 国内主流 ──────────────────────────────────────────────────────────────
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    group: '国内主流',
    baseURL: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docs: 'https://platform.deepseek.com',
    note: '官方端点，配额按日/按量计费，是预判限流最典型的场景。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    group: '国内主流',
    baseURL: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
    keyEnv: 'MOONSHOT_API_KEY',
    models: ['kimi-k2-turbo-preview', 'moonshot-v1-128k'],
    docs: 'https://platform.moonshot.cn',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    group: '国内主流',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    keyEnv: 'ZHIPU_API_KEY',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    docs: 'https://open.bigmodel.cn',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    group: '国内主流',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    keyEnv: 'DASHSCOPE_API_KEY',
    models: ['qwen3-max', 'qwen-plus', 'qwen-turbo'],
    docs: 'https://bailian.console.aliyun.com',
    note: '兼容模式端点；部分模型支持 enable_thinking 扩展参数。',
  },
  {
    id: 'ark',
    label: '火山方舟（豆包）',
    group: '国内主流',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'openai-completions',
    keyEnv: 'ARK_API_KEY',
    models: ['doubao-seed-1-6-250615', 'doubao-pro-32k'],
    docs: 'https://console.volcengine.com/ark',
    note: '模型字段通常需要填接入点 ID（ep-…）或模型名，以控制台为准。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    group: '国内主流',
    baseURL: 'https://api.siliconflow.cn/v1',
    api: 'openai-completions',
    keyEnv: 'SILICONFLOW_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-235B-A22B'],
    docs: 'https://cloud.siliconflow.cn',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    group: '国内主流',
    baseURL: 'https://api.minimaxi.com/v1',
    api: 'openai-completions',
    keyEnv: 'MINIMAX_API_KEY',
    models: ['MiniMax-M2', 'abab6.5s-chat'],
    docs: 'https://platform.minimaxi.com',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    group: '国内主流',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    api: 'openai-completions',
    keyEnv: 'HUNYUAN_API_KEY',
    models: ['hunyuan-turbos-latest', 'hunyuan-large'],
    docs: 'https://cloud.tencent.com/product/hunyuan',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    group: '国内主流',
    baseURL: 'https://api.stepfun.com/v1',
    api: 'openai-completions',
    keyEnv: 'STEPFUN_API_KEY',
    models: ['step-2-16k', 'step-1-flash'],
    docs: 'https://platform.stepfun.com',
  },
  {
    id: 'baichuan',
    label: '百川智能',
    group: '国内主流',
    baseURL: 'https://api.baichuan-ai.com/v1',
    api: 'openai-completions',
    keyEnv: 'BAICHUAN_API_KEY',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    docs: 'https://platform.baichuan-ai.com',
  },
  {
    id: 'sensenova',
    label: '商汤日日新',
    group: '国内主流',
    // 新入口是 Responses API：baseURL 只写到 /v1，适配器自己拼 /responses。
    // 把完整端点 https://token.sensenova.cn/v1/responses 整个填进 baseURL 会变成
    // .../v1/responses/responses，所以这里必须停在 /v1。
    baseURL: 'https://token.sensenova.cn/v1',
    api: 'openai-responses',
    keyEnv: 'SENSENOVA_API_KEY',
    // 该端点其实是聚合网关：模型列表里同时有 deepseek / glm / kimi 几家。
    // ID 以 token.sensenova.cn 控制台的模型页为准。
    models: ['deepseek-v4-flash', 'deepseek-flash', 'glm-5.2', 'kimi-k3'],
    docs: 'https://platform.sensenova.cn',
    note: '走 Responses API（POST /v1/responses），且该端点聚合了 deepseek / glm / kimi 等模型。老账号若仍用兼容模式，把 baseURL 换成 https://api.sensenova.cn/compatible-mode/v1 并把协议改回 openai-completions。',
  },

  // ── 国际主流 ──────────────────────────────────────────────────────────────
  {
    id: 'openai',
    label: 'OpenAI',
    group: '国际主流',
    baseURL: 'https://api.openai.com/v1',
    api: 'openai-responses',
    keyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4.1', 'gpt-4o', 'o4-mini'],
    docs: 'https://platform.openai.com',
    note: '默认走 Responses 协议；若网关只兼容 Chat Completions，把协议改成 openai-completions。',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    group: '国际主流',
    baseURL: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    keyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    docs: 'https://console.anthropic.com',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    group: '国际主流',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api: 'openai-completions',
    keyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    docs: 'https://aistudio.google.com',
    note: '使用 Google 的 OpenAI 兼容端点。',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    group: '国际主流',
    baseURL: 'https://api.x.ai/v1',
    api: 'openai-completions',
    keyEnv: 'XAI_API_KEY',
    models: ['grok-4', 'grok-3-mini'],
    docs: 'https://console.x.ai',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    group: '国际主流',
    baseURL: 'https://api.mistral.ai/v1',
    api: 'openai-completions',
    keyEnv: 'MISTRAL_API_KEY',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    docs: 'https://console.mistral.ai',
  },
  {
    id: 'groq',
    label: 'Groq',
    group: '国际主流',
    baseURL: 'https://api.groq.com/openai/v1',
    api: 'openai-completions',
    keyEnv: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    docs: 'https://console.groq.com',
    note: '推理速度极快，适合作为限流时的级联备用提供商。',
  },
  {
    id: 'together',
    label: 'Together AI',
    group: '国际主流',
    baseURL: 'https://api.together.xyz/v1',
    api: 'openai-completions',
    keyEnv: 'TOGETHER_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    docs: 'https://api.together.ai',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    group: '国际主流',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    api: 'openai-completions',
    keyEnv: 'DEEPINFRA_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-235B-A22B'],
    docs: 'https://deepinfra.com',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    group: '国际主流',
    baseURL: 'https://api.cerebras.ai/v1',
    api: 'openai-completions',
    keyEnv: 'CEREBRAS_API_KEY',
    models: ['llama-3.3-70b', 'qwen-3-235b-a22b-instruct-2507'],
    docs: 'https://cloud.cerebras.ai',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    group: '国际主流',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    api: 'openai-completions',
    keyEnv: 'FIREWORKS_API_KEY',
    models: ['accounts/fireworks/models/deepseek-v3'],
    docs: 'https://fireworks.ai',
  },

  // ── 聚合网关 ──────────────────────────────────────────────────────────────
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合网关）',
    group: '聚合网关',
    baseURL: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    keyEnv: 'OPENROUTER_API_KEY',
    models: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4.5', 'openai/gpt-4.1'],
    docs: 'https://openrouter.ai',
    note: '模型 ID 形如 vendor/model，是最省事的跨提供商级联目标。',
  },
  {
    id: 'novita',
    label: 'Novita AI',
    group: '聚合网关',
    baseURL: 'https://api.novita.ai/v3/openai',
    api: 'openai-completions',
    keyEnv: 'NOVITA_API_KEY',
    models: ['deepseek/deepseek-v3', 'meta-llama/llama-3.3-70b-instruct'],
    docs: 'https://novita.ai',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    group: '聚合网关',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    api: 'openai-completions',
    keyEnv: 'NVIDIA_API_KEY',
    // 均实测存在于 `GET /v1/models`（共 81 个）。NIM 的模型上下架频繁、ID 也会改版：
    // 形如 `z-ai/glm-5-3` 的旧写法现在已经不存在，只认 `z-ai/glm-5.3`（连字符变点号）。
    // 以 https://build.nvidia.com 的 model 页为准。
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b',
      'moonshotai/kimi-k3',
      'deepseek-ai/deepseek-v4.1-flash',
      'z-ai/glm-5.3',
    ],
    docs: 'https://build.nvidia.com',
    note: '模型 ID 形如 vendor/model。免费额度按账号发放，用尽后返回 429，适合放在级联靠后位置。注意它的 /models 无需密钥即可访问，因此探活不能用来判断密钥是否有效。',
    unauthenticatedProbe: true,
  },
  {
    id: 'github-models',
    label: 'GitHub Models',
    group: '聚合网关',
    baseURL: 'https://models.github.ai/inference',
    api: 'openai-completions',
    keyEnv: 'GITHUB_MODELS_TOKEN',
    models: ['openai/gpt-4.1', 'deepseek/DeepSeek-V3-0324'],
    docs: 'https://github.com/marketplace/models',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    group: '聚合网关',
    // 写成小写：URL 主机名按规范大小写不敏感，归一化后一律小写，
    // 这里与归一化结果保持一致，免得用户以为要照抄大写。
    baseURL: 'https://your-resource.openai.azure.com/openai/v1',
    api: 'openai-completions',
    keyEnv: 'AZURE_OPENAI_API_KEY',
    models: ['gpt-4.1', 'gpt-4o'],
    docs: 'https://ai.azure.com',
    note: '必须把 your-resource 换成你自己的资源名；部署名常与模型名不同。',
  },

  // ── 本地 / 自托管 ─────────────────────────────────────────────────────────
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    group: '本地 / 自托管',
    baseURL: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    keyEnv: 'OLLAMA_API_KEY',
    models: ['qwen3:32b', 'deepseek-r1:14b'],
    docs: 'https://ollama.com',
    local: true,
    note: '本地端点通常不校验密钥，仍需填一个占位值（如 ollama）才能加入池子。',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    group: '本地 / 自托管',
    baseURL: 'http://127.0.0.1:1234/v1',
    api: 'openai-completions',
    keyEnv: 'LMSTUDIO_API_KEY',
    models: ['local-model'],
    docs: 'https://lmstudio.ai',
    local: true,
    note: '本地端点，密钥可用占位值。',
  },
  {
    id: 'vllm',
    label: 'vLLM / 自建网关',
    group: '本地 / 自托管',
    baseURL: 'http://127.0.0.1:8000/v1',
    api: 'openai-completions',
    keyEnv: 'VLLM_API_KEY',
    models: ['default'],
    docs: 'https://docs.vllm.ai',
    local: true,
    note: '任何 OpenAI 兼容的自建推理服务都可以用这一条，把端点改成实际地址即可。',
  },
])

/** 目录中出现的分组，按界面展示顺序排列。 */
export const CATALOG_GROUPS = Object.freeze(
  [...new Set(BUILTIN_PROVIDERS.map((p) => p.group))],
)

/** 路由 ID → 目录条目。 */
const BY_ID = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]))

/**
 * 按 ID 取一条内置提供商预设。
 * @param {string} id
 * @returns {CatalogProvider | undefined}
 */
export function findCatalogProvider(id) {
  return typeof id === 'string' ? BY_ID.get(id) : undefined
}

/**
 * 判断一个路由 ID 是否是内置目录条目。
 * @param {string} id
 * @returns {boolean}
 */
export function isCatalogProvider(id) {
  return BY_ID.has(id)
}

/**
 * 池中每一把密钥都是一个**独立的凭据引用**（如 `DEEPSEEK_API_KEY`、
 * `DEEPSEEK_API_KEY_2`），因此轮换不需要为每把密钥注册一条路由：宿主解析
 * `ref` 时由插件决定这次返回哪一把的值即可，提供商身份自始至终不变。
 *
 * 这正是不做「克隆路由」的原因——它曾是同类插件的主要故障源（路由撞车、
 * 孤儿路由、级联递归），而对透明轮换毫无必要。
 */
