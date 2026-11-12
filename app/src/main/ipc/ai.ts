import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { AiConfigInput } from '../../shared/types'
import type { AnalysisPipeline } from '../services/ai/pipeline'
import type { SettingsStore } from '../store/settings'
import { AI_PROVIDERS } from '../services/ai/providers'
import { AiCallError, chatCompletion } from '../services/ai/analyzer'
import { resolveEffectiveConnection } from '../services/ai/connection'
import type { ConnectionTestResult } from '../services/ai/connection'

/**
 * 连通测试：先解析有效连接（本次输入优先，同 provider+归一化端点复用已存 Key，本地无需 Key），
 * 再打一次极短 chat.completions 测端到端可达性（不落库）。
 * 返回脱敏诊断（code + message + keySource），永不回传密钥本体。
 */
async function testConnection(
  store: SettingsStore,
  input: AiConfigInput
): Promise<ConnectionTestResult> {
  const saved = await store.get()
  const resolved = resolveEffectiveConnection(
    { provider: input.provider, baseURL: input.baseURL, model: input.model, apiKey: input.apiKey },
    {
      provider: saved.aiProvider,
      baseURL: saved.aiBaseURL,
      apiKey: saved.aiApiKey,
      authorizedFor: saved.aiAuthorizedFor
    },
    AI_PROVIDERS
  )
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message }

  const started = Date.now()
  try {
    await chatCompletion(resolved.connection, '你是一个连通测试助手。', '请只回复两个字母：ok', false)
    const hint =
      resolved.connection.keySource === 'saved'
        ? '（使用已保存的 API Key）'
        : resolved.connection.keySource === 'none'
          ? '（本地/自托管端点，无需 API Key）'
          : ''
    return {
      ok: true,
      code: 'ok',
      message: '连通成功' + hint,
      latencyMs: Date.now() - started,
      keySource: resolved.connection.keySource
    }
  } catch (error) {
    const e =
      error instanceof AiCallError
        ? error
        : new AiCallError(error instanceof Error ? error.message : String(error))
    return { ok: false, code: e.code ?? 'endpoint_error', message: e.message }
  }
}

export function registerAiIpc(pipeline: AnalysisPipeline, store: SettingsStore): void {
  ipcMain.handle(IPC.aiProvidersList, () => AI_PROVIDERS)
  ipcMain.handle(IPC.aiTest, (_event, config: AiConfigInput) => testConnection(store, config))
  ipcMain.handle(IPC.aiAnalyze, (_event, emailId: number) => pipeline.analyzeOne(emailId))
  ipcMain.handle(IPC.aiAnalyzeAll, () => pipeline.analyzePending(true))
  ipcMain.handle(IPC.aiStatus, () => pipeline.status())
}
