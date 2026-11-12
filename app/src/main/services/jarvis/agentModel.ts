import type { AiConfigInput } from '../../../shared/types'
export interface ToolCall { id: string; name: string; arguments: string }
export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
export interface ModelReply { content: string; toolCalls: ToolCall[]; reasoning: string }
export interface ModelDelta { content: string; reasoning: string }
export type ModelDeltaHandler = (delta: ModelDelta) => void
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type AgentModelFn = (cfg: AiConfigInput, messages: ModelMessage[], tools: ToolDefinition[], signal?: AbortSignal, onDelta?: ModelDeltaHandler) => Promise<ModelReply>
interface StreamedCall { id: string; name: string; arguments: string }
type StreamChunk = { choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] } }[] }
/** 兼容 OpenAI 兼容端点的 SSE 流：逐帧累积正文、思考与工具调用。 */
async function readEventStream(res: Response, onDelta?: ModelDeltaHandler): Promise<ModelReply> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const calls = new Map<number, StreamedCall>()
  let buffer = '', content = '', reasoning = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let lineEnd = buffer.indexOf('\n')
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd).trim()
      buffer = buffer.slice(lineEnd + 1)
      lineEnd = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let chunk: StreamChunk
      try { chunk = JSON.parse(payload) as StreamChunk } catch { continue }
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      const thought = delta.reasoning_content ?? delta.reasoning
      if (typeof thought === 'string' && thought) reasoning += thought
      if (typeof delta.content === 'string' && delta.content) content += delta.content
      for (const part of delta.tool_calls ?? []) {
        const index = typeof part.index === 'number' ? part.index : calls.size
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (part.id) call.id = part.id
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
        calls.set(index, call)
      }
      if (thought || delta.content || delta.tool_calls?.length) onDelta?.({ content, reasoning })
    }
  }
  const toolCalls = [...calls.values()].filter(c => c.name).map(c => ({ id: c.id || 'call_' + Math.random().toString(36).slice(2, 12), name: c.name, arguments: c.arguments || '{}' }))
  if (!content.trim() && !toolCalls.length) throw new Error('模型回复为空')
  return { content, toolCalls, reasoning }
}
/** Separate native tool adapter. The email analyzer keeps its JSON response contract. */
export const agentCompletion: AgentModelFn = async (cfg, messages, tools, signal, onDelta) => {
  const timeout = AbortSignal.timeout(120_000)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey
  try {
    const res = await fetch(cfg.baseURL.trim().replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: 'auto', temperature: 0, stream: true })
    })
    if (!res.ok) {
      const label = res.status === 401 || res.status === 403 ? '鉴权失败，请检查模型与端点的密钥权限' : res.status === 429 ? '服务限流，请稍后重试' : res.status === 400 || res.status === 404 ? '端点/模型或工具调用协议不支持，请检查连接；不会伪装成已执行' : '模型服务请求失败'
      throw new Error(label + '（HTTP ' + res.status + '）')
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream') && res.body) {
      const streamed = await readEventStream(res, onDelta)
      if (streamed.toolCalls.length > 12) throw new Error('单轮工具调用超过安全上限')
      return streamed
    }
    const data = await res.json() as { choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[] } }[] }
    const message = data.choices?.[0]?.message
    if (!message) throw new Error('模型未返回有效消息')
    const toolCalls = (message.tool_calls ?? []).map(c => {
      if (!c.id || c.type !== 'function' || !c.function?.name || typeof c.function.arguments !== 'string') throw new Error('模型工具协议无效')
      return { id: c.id, name: c.function.name, arguments: c.function.arguments }
    })
    if (toolCalls.length > 12) throw new Error('单轮工具调用超过安全上限')
    if (!message.content && !toolCalls.length) throw new Error('模型回复为空')
    return { content: message.content ?? '', toolCalls, reasoning: message.reasoning_content ?? message.reasoning ?? '' }
  } catch (error) {
    if (signal?.aborted) throw new Error('任务已停止；已提交操作不会回滚')
    if (timeout.aborted) throw new Error('模型请求超时（120秒）')
    const text = error instanceof Error ? error.message : String(error)
    throw new Error(cfg.apiKey ? text.split(cfg.apiKey).join('[密钥已隐藏]') : text)
  }
}
