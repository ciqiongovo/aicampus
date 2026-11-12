/**
 * AI 连接配置解析与故障分类的纯函数模块。
 * - 无 electron / 无网络 / 无 DB 依赖，便于注入 mock 做不触网单测。
 * - 不读取用户真实密钥：已保存密钥由调用方（主进程 ipc/ai.ts）传入，本模块只做解析。
 * - 密钥本体永不进入返回给渲染层的诊断消息（redactSecrets 兜底）。
 */

/** 稳定诊断码：渲染层据此区分处理，不回传密钥本体 */
export type AiDiagnosticCode =
  | 'ok'
  | 'config_missing'
  | 'unauthorized'
  | 'rate_limited'
  | 'network'
  | 'endpoint_error'
  | 'invalid_response'

/** 本次实际使用的密钥来源（只标记来源，不回传密钥本体） */
export type KeySource = 'input' | 'saved' | 'none'

/** 服务商预设的最小结构（供连接解析判断是否需要 Key / 是否本地端点） */
export interface ProviderPresetLike {
  id: string
  apiKeyRequired?: boolean
  isLocal?: boolean
}

/** 解析后的有效连接配置（apiKey 仅主进程内部使用） */
export interface ResolvedConnection {
  provider: string
  baseURL: string
  model: string
  apiKey: string
  keySource: KeySource
  apiKeyRequired: boolean
  isLocal: boolean
}

/** 已保存连接（含授权指纹；apiKey 为解密后明文，仅主进程读取） */
export interface SavedConnectionRef {
  provider: string
  baseURL: string
  apiKey: string
  /** 授权绑定的端点指纹 provider|baseURL；空串 = 从未授权/旧数据 */
  authorizedFor?: string
}

/** 连通测试/保存时的输入配置快照 */
export interface ConnectionInput {
  provider: string
  baseURL: string
  model: string
  apiKey: string
}

export type ResolveResult =
  | { ok: true; connection: ResolvedConnection }
  | { ok: false; code: AiDiagnosticCode; message: string }

/** 连通测试结果：在 AiTestResult 基础上结构兼容扩展 code 与 keySource（不回传密钥） */
export interface ConnectionTestResult {
  ok: boolean
  code: AiDiagnosticCode
  message: string
  latencyMs?: number
  keySource?: KeySource
}

/** 端点归一化：仅协议/host 小写归一化，path 保留原始大小写（/API 与 /api 视为不同端点）；去尾部斜杠。空/非法/非 http(s) 返回空串。 */
export function normalizeEndpoint(baseURL: string): string {
  const raw = (baseURL || '').trim()
  if (!raw) return ''
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  const path = u.pathname.replace(/\/+$/, '')
  return u.protocol + '//' + u.host + path
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/** 在预设注册表里查找服务商；找不到返回 undefined */
export function findProvider(
  id: string,
  providers: ProviderPresetLike[]
): ProviderPresetLike | undefined {
  return providers.find((p) => p.id === id)
}

function sameEndpoint(
  providerA: string,
  baseA: string,
  providerB: string,
  baseB: string
): boolean {
  return providerA === providerB && normalizeEndpoint(baseA) === normalizeEndpoint(baseB)
}

/** 解析授权指纹 provider|baseURL，失败返回 null */
function parseAuthorizedFor(fingerprint: string): { provider: string; baseURL: string } | null {
  const idx = fingerprint.indexOf('|')
  if (idx <= 0) return null
  return { provider: fingerprint.slice(0, idx), baseURL: fingerprint.slice(idx + 1) }
}

function fail(code: AiDiagnosticCode, message: string): ResolveResult {
  return { ok: false, code, message }
}

/**
 * 解析连通测试/保存时的有效连接配置：
 * 1. 配置门禁：provider/baseURL/model 必须齐备（与管线 gate 的 configured 判定一致）。
 * 2. 密钥解析：本次输入（trim 后）优先 → 同 provider+归一化端点复用已存 Key（仅主进程）→ 本地/自托管无需 Key。
 * 3. 换端点不复用：provider 或归一化 baseURL 不同，或已存端点尚未授权（授权指纹指向别处）时，不把旧 Key 发给新端点。
 */
export function resolveEffectiveConnection(
  input: ConnectionInput,
  saved?: SavedConnectionRef | null,
  providers: ProviderPresetLike[] = []
): ResolveResult {
  const provider = (input?.provider ?? '').trim()
  const baseURL = (input?.baseURL ?? '').trim()
  const model = (input?.model ?? '').trim()
  const inputKey = (input?.apiKey ?? '').trim()

  if (!provider) return fail('config_missing', '尚未选择 AI 服务商，请在「设置 → AI 配置」中选择')
  if (!baseURL) return fail('endpoint_error', '尚未填写 baseURL（服务商 API 地址）')
  if (!normalizeEndpoint(baseURL)) {
    return fail('endpoint_error', 'baseURL 无效：请输入合法的 http/https 地址')
  }
  if (!model) return fail('config_missing', '尚未填写模型名')

  const preset = findProvider(provider, providers)
  const apiKeyRequired = preset ? preset.apiKeyRequired !== false : true
  const isLocal = preset ? !!preset.isLocal : false

  // 新 Key 优先
  if (inputKey) {
    return {
      ok: true,
      connection: {
        provider,
        baseURL,
        model,
        apiKey: inputKey,
        keySource: 'input',
        apiKeyRequired,
        isLocal
      }
    }
  }

  // 本地/自托管端点：无需 Key（就绪判定与实际调用门禁一致）
  if (!apiKeyRequired) {
    return {
      ok: true,
      connection: {
        provider,
        baseURL,
        model,
        apiKey: '',
        keySource: 'none',
        apiKeyRequired: false,
        isLocal: true
      }
    }
  }

  // 同 provider + 归一化端点才考虑复用已存 Key
  if (saved && saved.apiKey && sameEndpoint(provider, baseURL, saved.provider, saved.baseURL)) {
    if (saved.authorizedFor) {
      const auth = parseAuthorizedFor(saved.authorizedFor)
      if (auth && sameEndpoint(provider, baseURL, auth.provider, auth.baseURL)) {
        return {
          ok: true,
          connection: {
            provider,
            baseURL,
            model,
            apiKey: saved.apiKey,
            keySource: 'saved',
            apiKeyRequired,
            isLocal
          }
        }
      }
      // 授权指纹指向别处（端点被改后未重新授权）：不复用旧 Key
    } else {
      // 无授权指纹（从未授权/旧数据）：端点匹配即允许复用，保持向后兼容
      return {
        ok: true,
        connection: {
          provider,
          baseURL,
          model,
          apiKey: saved.apiKey,
          keySource: 'saved',
          apiKeyRequired,
          isLocal
        }
      }
    }
  }

  return fail('config_missing', '该服务商需要 API Key：请填写，或确保端点与已保存配置一致后留空复用')
}

/** HTTP 状态 → 故障分类（仅 401/403、429 特殊化，其余 4xx/5xx 归为端点/模型错误） */
export function classifyHttpStatus(status: number): AiDiagnosticCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  return 'endpoint_error'
}

/** 从服务商响应体里提取可诊断的错误信息（JSON error.message 优先，截断 200 字） */
function extractProviderError(body: string): string {
  const t = (body ?? '').trim()
  if (!t) return ''
  try {
    const parsed = JSON.parse(t) as { error?: { message?: unknown } }
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.error &&
      typeof parsed.error === 'object'
    ) {
      const m = parsed.error.message
      if (typeof m === 'string' && m.trim()) return truncate(m.trim(), 200)
    }
  } catch {
    /* 非 JSON：走下方原始截断 */
  }
  return truncate(t, 200)
}

/** 把密钥等敏感片段从文本中替换掉，避免回显（任意非空片段都替换，短 Key 也不回显） */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text
  for (const s of secrets) {
    if (s) out = out.split(s).join('***')
  }
  return out
}

export interface HttpErrorInfo {
  code: AiDiagnosticCode
  status: number
  message: string
}

/** 生成脱敏、分类后的 HTTP 错误诊断（不回显服务商原始密钥） */
export function describeHttpError(status: number, body: string, secret?: string): HttpErrorInfo {
  const code = classifyHttpStatus(status)
  const base =
    code === 'unauthorized'
      ? '鉴权失败（HTTP ' + status + '）：请检查 API Key 是否正确、是否已过期或权限不足'
      : code === 'rate_limited'
        ? '触发限流（HTTP 429）：请求过于频繁，请稍后重试'
        : '端点或模型错误（HTTP ' + status + '）：请检查 baseURL 与模型名是否正确'
  const detail = redactSecrets(extractProviderError(body), [secret])
  return { code, status, message: base + (detail ? '｜' + detail : '') }
}
/** 当前已保存的连接相关字段（主进程读取，apiKey 为解密后明文） */
export interface ConnectionCurrentRef {
  aiProvider: string
  aiBaseURL: string
  aiApiKey: string
  aiAuthorizedFor: string
  aiAuthorizedAt: string
}

/** 保存连接配置时的 patch 片段（对应 AppSettings 里连接相关字段，均为可选） */
export interface ConnectionPatchInput {
  aiProvider?: string
  aiBaseURL?: string
  aiApiKey?: string
  aiAuthorizedFor?: string
  aiAuthorizedAt?: string
}

/** 由 set() 推导出的密钥/授权覆盖字段（用于额外写库） */
export interface ConnectionDerivedPatch {
  aiApiKey?: string
  aiAuthorizedFor?: string
  aiAuthorizedAt?: string
}

/**
 * 由当前连接配置与本次保存 patch 推导出需额外写入的密钥/授权覆盖（纯函数，便于单测）。
 * 修复保存路径缺陷：只合并 patch 会让「换端点但留空 Key」时旧 Key 残留并被授权后发往新端点。
 * - 换端点（provider 或归一化 baseURL 变化）且本次未提供非空新 Key → 清空 aiApiKey。
 * - 换端点且本次未显式把 aiAuthorizedFor 指向新端点 → 清空 aiAuthorizedFor / aiAuthorizedAt。
 */
export function deriveConnectionPatch(
  current: ConnectionCurrentRef,
  patch: ConnectionPatchInput
): ConnectionDerivedPatch {
  const curProvider = current.aiProvider ?? ''
  const curBaseURL = current.aiBaseURL ?? ''
  const effProvider = patch.aiProvider !== undefined ? (patch.aiProvider ?? '').trim() : curProvider
  const effBaseURL = patch.aiBaseURL !== undefined ? (patch.aiBaseURL ?? '').trim() : curBaseURL

  const endpointChanged =
    effProvider !== curProvider || normalizeEndpoint(effBaseURL) !== normalizeEndpoint(curBaseURL)

  const out: ConnectionDerivedPatch = {}
  if (!endpointChanged) return out

  // 换端点且本次没有非空新 Key → 清空旧 Key（旧 Key 不得发往新端点）
  const newKey = (patch.aiApiKey ?? '').trim()
  if (!newKey) out.aiApiKey = ''

  // 换端点且未显式把授权指纹指向新端点 → 旧授权失效
  const reAuthorized =
    patch.aiAuthorizedFor !== undefined && patch.aiAuthorizedFor === effProvider + '|' + effBaseURL
  if (!reAuthorized) {
    out.aiAuthorizedFor = ''
    out.aiAuthorizedAt = ''
  }

  return out
}

