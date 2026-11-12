import type { AIProviderPreset } from '../../../../shared/types'

/** AI 服务商注册表（OpenAI 兼容 chat.completions）：新增服务商 = 追加一条，设置页自动出现入口 */
export const AI_PROVIDERS: AIProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyRequired: true,
    apiKeyHelp: '在 platform.deepseek.com 申请 API Key'
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    apiKeyRequired: true,
    apiKeyHelp: '在 bailian.console.aliyun.com 申请 DashScope API-KEY'
  },
  {
    id: 'zhipu',
    label: '智谱 AI',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
    apiKeyRequired: true,
    apiKeyHelp: '在 open.bigmodel.cn 申请 API Key'
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    apiKeyRequired: true,
    apiKeyHelp: '在 platform.moonshot.cn 申请 API Key'
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat'],
    apiKeyRequired: true,
    apiKeyHelp: '在 cloud.siliconflow.cn 申请 API Key'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
    apiKeyRequired: true,
    apiKeyHelp: '在 platform.openai.com 申请 API Key'
  },
  {
    id: 'local',
    label: '本地 / 自托管',
    baseURL: '',
    models: [],
    apiKeyRequired: false,
    isLocal: true,
    apiKeyHelp: '如 Ollama / LM Studio / vLLM，填形如 http://localhost:11434/v1 的端点'
  },
  {
    id: 'custom',
    label: '自定义端点',
    baseURL: '',
    models: [],
    apiKeyRequired: true,
    apiKeyHelp: '任意 OpenAI 兼容端点，需自填 baseURL 与模型名'
  }
]

