/**
 * 极简 OpenAI 兼容补全客户端（DeepSeek / OpenAI / 通义 / 本地 vLLM 都走这套）。
 *
 * 之所以不直接复用 InfoAgent 的 analyzer：这是独立原型，等接进去时
 * 把 createComplete 换成项目里已有的 chatCompletion 即可，签名一致。
 */

export type CompleteFn = (system: string, user: string, jsonMode: boolean) => Promise<string>

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
}

export function createComplete(config: LlmConfig): CompleteFn {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 60_000

  return async (system, user, jsonMode) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: controller.signal
      })

      const body = await response.text()
      if (!response.ok) {
        throw new Error(`LLM 请求失败 HTTP ${response.status}：${body.slice(0, 300)}`)
      }

      let parsed: ChatCompletionResponse
      try {
        parsed = JSON.parse(body) as ChatCompletionResponse
      } catch {
        throw new Error(`LLM 返回非 JSON：${body.slice(0, 200)}`)
      }
      const content = parsed.choices?.[0]?.message?.content
      if (!content || !content.trim()) throw new Error('LLM 返回内容为空')
      return content
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 从环境变量读配置；没有任何可用 Key 时返回 null（此时只能走规则抽取） */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.IM_LLM_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY
  if (!apiKey) return null

  const isDeepSeek = Boolean(env.DEEPSEEK_API_KEY) && !env.IM_LLM_BASE_URL && !env.OPENAI_API_KEY
  const baseUrl = env.IM_LLM_BASE_URL || (isDeepSeek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')
  const model = env.IM_LLM_MODEL || (isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini')
  return { baseUrl, apiKey, model }
}
