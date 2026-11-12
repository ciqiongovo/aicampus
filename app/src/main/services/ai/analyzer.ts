import type { AiConfigInput } from '../../../shared/types'
import { describeHttpError, redactSecrets } from './connection'
import type { AiDiagnosticCode } from './connection'

/** 调用失败时携带分类信息，便于 UI 展示；code/status 供分类处理（旧调用只传 message 仍兼容） */
export class AiCallError extends Error {
  readonly code?: AiDiagnosticCode
  readonly status?: number
  constructor(message: string, code?: AiDiagnosticCode, status?: number) {
    super(message)
    this.name = 'AiCallError'
    this.code = code
    this.status = status
  }
}

export type { AiDiagnosticCode }

function endpoint(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '') + '/chat/completions'
}

/**
 * 单次 OpenAI 兼容 chat.completions 调用。
 * 走主进程 Node 全局 fetch，避开渲染层生产 CSP 的 connect-src 'self'。
 * 保持旧 JSON 分析契约：成功返回 choices[0].message.content 原文（jsonMode 只影响请求体），
 * 失败抛 AiCallError（带 code/status），诊断信息脱敏，不回显密钥。
 */
export async function chatCompletion(
  cfg: AiConfigInput,
  system: string,
  user: string,
  jsonMode: boolean
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0
    }
    if (jsonMode) body.response_format = { type: 'json_object' }

    const res = await fetch(endpoint(cfg.baseURL), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const text = await res.text()
    if (!res.ok) {
      const info = describeHttpError(res.status, text, cfg.apiKey)
      throw new AiCallError(info.message, info.code, info.status)
    }
    let data: { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      throw new AiCallError('模型返回了无法解析的内容', 'invalid_response')
    }
    if (data.error?.message) {
      throw new AiCallError(redactSecrets(data.error.message, [cfg.apiKey]), 'endpoint_error')
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new AiCallError('模型返回为空', 'invalid_response')
    return content
  } catch (error) {
    if (error instanceof AiCallError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiCallError('请求超时（60s）：请检查网络或端点可达性', 'network')
    }
    if (error instanceof TypeError) {
      throw new AiCallError('网络连接失败：无法访问该端点', 'network')
    }
    throw new AiCallError(error instanceof Error ? error.message : String(error), 'endpoint_error')
  } finally {
    clearTimeout(timer)
  }
}
