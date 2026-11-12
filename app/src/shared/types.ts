/** 前后端共享：IPC 通道常量、数据模型与 RendererApi 契约（单一来源） */
import type { WorkspaceApi } from './workspace'
import type { DailyApi } from './daily'
import type { CognitionApi } from './cognition'
import type { TodoApi } from './todo'
import type { FeedbackSensitivityLevel, PanelApi } from './panel'
import type { MaterialApi } from './materials'
import type { ZhihuApi } from './zhihu'
export * from './workspace'
export * from './daily'
export * from './cognition'
export * from './mailTags'
export * from './todo'
export * from './panel'
export * from './materials'
export * from './zhihu'

export const IPC = {
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  mailProvidersList: 'mail:providers:list',
  accountsList: 'accounts:list',
  accountsCreate: 'accounts:create',
  accountsUpdate: 'accounts:update',
  accountsDelete: 'accounts:delete',
  accountsClearSecret: 'accounts:clear-secret',
  accountsTest: 'accounts:test',
  accountsOauthBegin: 'accounts:oauth:begin',
  accountsOauthPoll: 'accounts:oauth:poll',
  accountsOauthCancel: 'accounts:oauth:cancel',
  mailSync: 'mail:sync',
  mailSyncAll: 'mail:sync:all',
  mailSyncStatus: 'mail:sync:status',
  mailList: 'mail:list',
  mailTagDefinitionsList: 'mail:tag-definitions:list',
  mailTagDefinitionsCreate: 'mail:tag-definitions:create',
  mailTagDefinitionsDelete: 'mail:tag-definitions:delete',
  mailTagsMatch: 'mail:tags:match',
  mailTagsList: 'mail:tags:list',
  mailTagsGet: 'mail:tags:get',
  mailTagsFeedback: 'mail:tags:feedback',
  tagPreferencesGet: 'mail:tags:preferences:get',
  tagPreferencesSet: 'mail:tags:preferences:set',
  mailGet: 'mail:get',
  mailSetUnread: 'mail:setUnread',
  mailSetStarred: 'mail:setStarred',
  mailAttachmentDownload: 'mail:attachment:download',
  mailFolders: 'mail:folders',
  aiProvidersList: 'ai:providers:list',
  aiTest: 'ai:test',
  aiAnalyze: 'ai:analyze',
  aiAnalyzeAll: 'ai:analyze:all',
  aiStatus: 'ai:status',
  dailySourcesGet: 'daily:sources-get',
  dailySourcesSet: 'daily:sources-set',
  dailyGenerate: 'daily:generate',
  dailyList: 'daily:list',
  dailyStatus: 'daily:status',
  counterToday: 'counter:today',
  counterAct: 'counter:act',
  zhihuStatus: 'zhihu:status',
  zhihuLogin: 'zhihu:login',
  zhihuLogout: 'zhihu:logout',
  zhihuSync: 'zhihu:sync',
  zhihuToday: 'zhihu:today',
  zhihuAct: 'zhihu:act',
  todoSnapshot: 'todo:snapshot',
  todoCreateItem: 'todo:create-item',
  todoUpdateItem: 'todo:update-item',
  todoToggleItem: 'todo:toggle-item',
  todoDeleteItem: 'todo:delete-item',
  todoCreateList: 'todo:create-list',
  todoUpdateList: 'todo:update-list',
  todoDeleteList: 'todo:delete-list',
  panelOverview: 'panel:overview',
  panelContinue: 'panel:continue',
  panelAct: 'panel:act',
  panelIngest: 'panel:ingest',
  panelSources: 'panel:sources',
  panelKeywordProfile: 'panel:keyword-profile',
  panelKeywordSet: 'panel:keyword-set',
  panelKeywordDelete: 'panel:keyword-delete',
  materialsCreateFolder: 'materials:create-folder',
  materialsRenameFolder: 'materials:rename-folder',
  materialsDeleteFolder: 'materials:delete-folder',
  materialsBatch: 'materials:batch',
  materialsCreate: 'materials:create',
  todoBatch: 'todo:batch',
  materialsList: 'materials:list'
} as const

export interface AppInfo {
  version: string
  userDataPath: string
  platform: string
  electron: string
  chrome: string
}

/** 应用设置（key/value 结构的基础版，模块可扩展各自 schema） */
export interface AppSettings {
  reminderEnabled: boolean
  reminderAdvanceMinutes: number
  aiProvider: string
  aiBaseURL: string
  aiModel: string
  aiApiKey: string
  aiIsLocal: boolean
  /** 授权绑定的端点指纹 provider|baseURL，与当前配置不符即视为未授权（A2） */
  aiAuthorizedFor: string
  /** 最近一次授权时间 ISO */
  aiAuthorizedAt: string
  /** 不向 AI 提供附件信息 */
  aiExcludeAttachments: boolean
  /** 适用性上下文（可选，为画像打底）：年级，如「大一」 */
  userGrade: string
  /** 适用性上下文（可选，为画像打底）：专业，如「计算机科学」 */
  userMajor: string
  /** 日报平台源注册表；空数组 = 使用内置默认（B站/抖音/百度） */
  dailySources: DailySourceConfig[]
  /** 开机自启动（P6）；仅打包版写注册表，开发模式只持久化 */
  autoLaunch: boolean
  /** 单条反馈对八维关心雷达权重的影响等级 */
  radarSensitivity: FeedbackSensitivityLevel
  /** 单条反馈对关键词画像权重的影响等级 */
  keywordSensitivity: FeedbackSensitivityLevel
  /** 知乎推荐每天生成条数（1-5） */
  zhihuRecommendCount: number
  /** 知乎反推荐每天生成条数（1-5） */
  zhihuCounterCount: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  reminderEnabled: true,
  reminderAdvanceMinutes: 30,
  aiProvider: '',
  aiBaseURL: '',
  aiModel: '',
  aiApiKey: '',
  aiIsLocal: false,
  aiAuthorizedFor: '',
  aiAuthorizedAt: '',
  aiExcludeAttachments: false,
  userGrade: '',
  userMajor: '',
  dailySources: [],
  autoLaunch: true,
  radarSensitivity: 'standard',
  keywordSensitivity: 'standard',
  zhihuRecommendCount: 3,
  zhihuCounterCount: 3
}

export type SettingsPatch = Partial<AppSettings>

/** 渲染进程可见的应用设置：密钥类字段一律脱敏为布尔标记（A1） */
export interface SettingsView {
  reminderEnabled: boolean
  reminderAdvanceMinutes: number
  aiProvider: string
  aiBaseURL: string
  aiModel: string
  aiIsLocal: boolean
  /** 是否已保存 API Key（永不返回 Key 本体） */
  hasAiKey: boolean
  /** 端点+模型+密钥齐备 = AI 可用 */
  aiConfigured: boolean
  /** 当前端点是否已获用户数据授权（A2） */
  aiAuthorized: boolean
  /** 最近授权时间；未授权为 null */
  aiAuthorizedAt: string | null
  /** 不向 AI 提供附件信息 */
  aiExcludeAttachments: boolean
  /** 适用性上下文：年级（可为空串） */
  userGrade: string
  /** 适用性上下文：专业（可为空串） */
  userMajor: string
  /** 开机自启动（P6） */
  autoLaunch: boolean
  /** 单条反馈对八维关心雷达权重的影响等级 */
  radarSensitivity: FeedbackSensitivityLevel
  /** 单条反馈对关键词画像权重的影响等级 */
  keywordSensitivity: FeedbackSensitivityLevel
  /** 知乎推荐每天生成条数（1-5） */
  zhihuRecommendCount: number
  /** 知乎反推荐每天生成条数（1-5） */
  zhihuCounterCount: number
}

// ---------- 邮件服务商注册表 ----------

export type EncryptionMode = 'ssl' | 'starttls'
type AuthMode = 'appPassword' | 'password' | 'oauth'

/** 邮箱服务商预设：新增服务商 = 注册表追加一条，UI 自动出现入口（不写死） */
export interface MailProviderPreset {
  id: string
  label: string
  /** 自定义预设 host 为空串，由用户填写 */
  host: string
  port: number
  encryption: EncryptionMode
  defaultFolder: string
  authMode: AuthMode
  helpText: string
  helpUrl?: string
  /** true = 自定义 IMAP：主机/端口/加密/文件夹全部手填 */
  custom?: boolean
}

// ---------- 邮箱账号 ----------

/** 渲染进程可见的账号信息（不含凭据） */
export interface AccountInfo {
  id: number
  provider: string
  label: string
  address: string
  host: string
  port: number
  encryption: EncryptionMode
  username: string
  folder: string
  authMode: AuthMode
  hasSecret: boolean
  lastUidvalidity: number | null
  lastUid: number | null
  lastSyncAt: string | null
  syncError: string | null
  /** 该账号邮件是否参与 AI 分析（关闭则保持「待分析」） */
  aiEnabled: boolean
  /** 账号级 AI 端点覆盖；null = 跟随全局配置 */
  aiProvider: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  /** 是否已绑定 OAuth 登录（Outlook/Gmail） */
  oauthBound: boolean
  /** OAuth 服务商标识：'outlook' | 'gmail'，未绑定为 null */
  oauthProvider: string | null
  /** OAuth 客户端 ID（可复用配置显示） */
  oauthClientId: string | null
}

/** 创建/更新账号提交（明文凭据，仅主进程加密） */
export interface AccountInput {
  provider: string
  label: string
  address: string
  host: string
  port: number
  encryption: EncryptionMode
  username: string
  /** 创建必填；编辑留空 = 不修改凭据 */
  secret?: string
  folder: string
  authMode: AuthMode
  /** 该账号邮件是否参与 AI 分析（缺省 true） */
  aiEnabled?: boolean
  /** 账号级 AI 端点覆盖；三项齐全才生效，否则跟随全局配置 */
  aiProvider?: string
  aiBaseUrl?: string
  aiModel?: string
  /** 已完成 OAuth 授权会话的 state：创建/更新时消费 pending flow 写入 oauth_* 列 */
  oauthState?: string
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  folderCount?: number
  folders?: string[]
}

// ---------- Outlook/Gmail OAuth 登录（桌面原生应用 PKCE 流程） ----------

export interface OauthBeginResult {
  ok: boolean
  /** 浏览器授权地址（渲染进程不直接打开，由主进程 shell.openExternal 打开） */
  authUrl?: string
  /** 轮询/取消用会话标识 */
  state?: string
  message?: string
}

export interface OauthPollResult {
  status: 'pending' | 'done' | 'error' | 'cancelled' | 'expired'
  /** 授权成功时从 id_token 解出的邮箱（用于预填表单） */
  email?: string
  message?: string
}

type SyncState = 'never' | 'syncing' | 'idle' | 'error'

export interface AccountSyncStatus {
  accountId: number
  state: SyncState
  lastSyncAt: string | null
  error: string | null
}

export interface SyncResult {
  ok: boolean
  message: string
}

// ---------- 邮件浏览（M5：列表 / 搜索 / 详情） ----------

export type AnalysisStatus = 'pending' | 'analyzed' | 'failed' | 'skipped'

/** AI 分类白名单（主进程 schema 与渲染层筛选共用的单一来源） */
export const ANALYSIS_CATEGORIES = ['需行动', '重要通知', '可选机会', '一般信息', '不确定'] as const
export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number]

export interface MailListQuery {
  /** 自定义标签多选；与其余条件 AND，在计数及分页之前过滤；空数组不筛选。 */
  tagIds?: number[]
  /** 标签内部匹配方式：缺省 any（OR）；all 要求同一邮件包含全部去重标签。 */
  tagMatch?: 'any' | 'all'
  accountId?: number
  folder?: string
  /** 关键词：匹配主题 / 发件人 / 收件人 / 正文纯文本 */
  keyword?: string
  unreadOnly?: boolean
  /** 仅显示带附件的邮件 */
  hasAttachment?: boolean
  /** 仅显示已加星标的邮件 */
  starredOnly?: boolean
  /** 仅显示指定 AI 分类的邮件（A7） */
  category?: string
  /** 仅显示指定分析状态的邮件；未建分析记录的邮件按 pending 计（A7） */
  analysisStatus?: AnalysisStatus
  /** 服务端分页：每页条数（上限 200，默认 50） */
  limit?: number
  offset?: number
}

export interface AttachmentInfo {
  filename: string | null
  contentType: string
  size: number
}

/** 列表行：不含正文，避免一次性传输大字段 */
export interface MailListItem {
  /** 旧 fixtures 可省略；实际列表和详情均返回数组。 */
  tags?: import('./mailLabels').MailTagDefinition[]
  id: number
  accountId: number
  accountLabel: string
  folder: string
  subject: string
  fromAddr: string
  toAddr: string
  dateUtc: string | null
  unread: boolean
  starred: boolean
  size: number
  attachmentCount: number
  /** M6 起由 AI 管线填充，之前恒为 null */
  category: string | null
  analysisStatus: AnalysisStatus | null
}

export interface MailListResult {
  total: number
  items: MailListItem[]
}

/** 左侧文件夹树的一个文件夹（含未读数，全部来自本地数据库） */
export interface MailFolderNode {
  folder: string
  total: number
  unread: number
}

/** 左侧文件夹树的一个账号节点 */
export interface MailAccountNode {
  accountId: number
  provider: string
  label: string
  address: string
  folders: MailFolderNode[]
  total: number
  unread: number
  lastSyncAt: string | null
  syncError: string | null
}

/** 详情里的 AI 分析摘要（M6 前恒为 null） */
export interface MailAnalysisBrief {
  status: AnalysisStatus
  category: string | null
  summary: string | null
  actionRequired: string | null
  deadlineAt: string | null
  confidence: number | null
  model: string | null
  error: string | null
  /** 原文证据（evidence_json 解析后，用于正文定位/高亮） */
  evidence: string[]
}

export interface MailDetail extends MailListItem {
  messageId: string
  cc: string
  dateRaw: string | null
  /** 已在主进程清洗，可直接放进 sandbox iframe 的 srcdoc */
  bodyHtml: string
  bodyText: string
  attachments: AttachmentInfo[]
  analysis: MailAnalysisBrief | null
}

/** 附件下载结果（用户取消也算一次完成，不弹错误） */
export interface AttachmentDownloadResult {
  ok: boolean
  canceled?: boolean
  savedPath?: string
  message: string
}

// ---------- AI 分析（M6） ----------

/** AI 服务商预设：注册表追加一条，设置页自动出现入口 */
export interface AIProviderPreset {
  id: string
  label: string
  /** OpenAI 兼容 baseURL（以 /v1 结尾）；本地/自定义留空由用户填写 */
  baseURL: string
  models: string[]
  apiKeyRequired: boolean
  apiKeyHelp?: string
  /** true = 本地/自托管端点：不强制 Key，请求走用户自填 baseURL */
  isLocal?: boolean
}

/** 连通测试 / 保存时的 AI 配置快照（明文 Key 仅主进程使用，不回传渲染层） */
export interface AiConfigInput {
  provider: string
  baseURL: string
  model: string
  apiKey: string
}

export interface AiTestResult {
  code?: string
  keySource?: 'input' | 'saved' | 'none'
  ok: boolean
  message: string
  latencyMs?: number
}

export interface AiStatus {
  configured: boolean
  provider: string
  model: string
  pending: number
  analyzed: number
  failed: number
  skipped: number
}

export interface AiAnalyzeResult {
  ok: boolean
  message: string
}

// ---------- 日报 ----------

/** P4 日报生成结果：ok=false 时 message 为失败原因 */
export interface DailyOpResult {
  ok: boolean
  message: string
  /** 生成/更新的 info 条目 id */
  id?: number
  /** 各源抓取结果（调试与展示） */
  sources?: { label: string; count: number; error?: string }[]
}

// ---------- P4 日报 ----------

/** 日报平台源：内置源（B站/抖音/百度）端点可改可恢复默认；自定义源可在软件内增删 */
export interface DailySourceConfig {
  id: string
  label: string
  endpoint: string
  enabled: boolean
  builtin: boolean
}

/** 日报条目（info 表 source_type='daily' 的历史记录） */
export interface DailyReportItem {
  id: number
  title: string
  content: string
  createdAt: string
}

export interface DailyStatus {
  /** 最近一次日报生成时间（ISO 本地），无则为 null */
  lastReportAt: string | null
  /** 下一次 8:00 定时生成时间（ISO 本地） */
  nextRunAt: string
  /** 今天是否已生成日报 */
  todayGenerated: boolean
  /** 是否正在生成（并发防护） */
  generating: boolean
  /** 已启用平台源数量 */
  enabledSourceCount: number
}

// ---------- P5 反推荐 ----------

/** 反推荐条目（每日 ≤1 条；以 JARVIS 提问形式出现，答「去」转成事项） */
export interface CounterRecItem {
  id: number
  dateKey: string
  title: string
  sourceLabel: string
  url: string | null
  /** AI 给出的推荐理由（为什么这条值得这个用户知道） */
  reason: string
  status: 'pending' | 'done' | 'ignored'
  /** 「去」后创建的事项 id */
  itemId: number | null
  createdAt: string
}

export interface CounterRecOpResult {
  ok: boolean
  message: string
  /** 处理后的最新条目；生成类失败为 null */
  item?: CounterRecItem | null
}

// ---------- preload 暴露的白名单 API ----------

export interface RendererApi extends WorkspaceApi, DailyApi, CognitionApi, TodoApi, PanelApi, MaterialApi, ZhihuApi {
  appInfo(): Promise<AppInfo>
  appOpenExternal(url: string): Promise<boolean>
  settingsGet(): Promise<SettingsView>
  settingsSet(patch: SettingsPatch): Promise<SettingsView>
  mailProvidersList(): Promise<MailProviderPreset[]>
  accountsList(): Promise<AccountInfo[]>
  accountsCreate(input: AccountInput): Promise<AccountInfo>
  accountsUpdate(id: number, input: AccountInput): Promise<AccountInfo>
  accountsDelete(id: number): Promise<void>
  accountsClearSecret(id: number): Promise<AccountInfo>
  accountsTest(input: AccountInput, accountId?: number): Promise<TestConnectionResult>
  accountsOauthBegin(provider: string, clientId: string): Promise<OauthBeginResult>
  accountsOauthPoll(state: string): Promise<OauthPollResult>
  accountsOauthCancel(state: string): Promise<void>
  mailSync(accountId: number): Promise<SyncResult>
  mailSyncAll(): Promise<void>
  mailSyncStatus(): Promise<AccountSyncStatus[]>
  mailList(query: MailListQuery): Promise<MailListResult>
  mailTagDefinitionsList(): Promise<import('./mailLabels').MailTagDefinition[]>
  mailTagDefinitionsCreate(input: import('./mailLabels').MailTagDefinitionInput): Promise<import('./mailLabels').MailTagDefinition>
  mailTagDefinitionsDelete(id: number): Promise<void>
  mailTagsMatch(): Promise<AiAnalyzeResult>
  mailTagsList(query?: import('./mailTags').MailTagsQuery): Promise<import('./mailTags').MailTagsResult>
  mailTagsGet(emailId: number): Promise<import('./mailTags').MailTagRecord | null>
  mailTagsFeedback(emailId: number, patch: import('./mailTags').MailTagFeedbackPatch): Promise<import('./mailTags').MailTagRecord>
  tagPreferencesGet(): Promise<import('./mailTags').TagPreferences>
  tagPreferencesSet(weights: Record<string, number>): Promise<import('./mailTags').TagPreferences>
  mailGet(id: number): Promise<MailDetail | null>
  mailSetUnread(id: number, unread: boolean): Promise<void>
  mailSetStarred(id: number, starred: boolean): Promise<void>
  mailAttachmentDownload(emailId: number, filename: string | null): Promise<AttachmentDownloadResult>
  mailFolders(): Promise<MailAccountNode[]>
  aiProvidersList(): Promise<AIProviderPreset[]>
  aiTest(config: AiConfigInput): Promise<AiTestResult>
  aiAnalyze(emailId: number): Promise<AiAnalyzeResult>
  aiAnalyzeAll(): Promise<AiAnalyzeResult>
  aiStatus(): Promise<AiStatus>
  /** P4 日报：读取平台源注册表（含内置默认） */
  dailySourcesGet(): Promise<DailySourceConfig[]>
  /** P4 日报：保存平台源注册表（整表覆盖；传空数组恢复内置默认） */
  dailySourcesSet(sources: DailySourceConfig[]): Promise<DailyOpResult>
  /** P4 日报：立即生成（同日已生成则刷新内容） */
  dailyGenerate(): Promise<DailyOpResult>
  /** P4 日报：历史日报列表（新在前，默认 14 条） */
  dailyList(limit?: number): Promise<DailyReportItem[]>
  /** P4 日报：生成状态与下次定时时间 */
  dailyStatus(): Promise<DailyStatus>
  /** P5 反推荐：今天的反推荐条目（无则 null） */
  counterToday(): Promise<CounterRecItem | null>
  /** P5 反推荐：处理今天的反推荐（go=转成事项，ignore=忽略） */
  counterAct(id: number, action: 'go' | 'ignore'): Promise<CounterRecOpResult>
  /** 知乎反推荐：读取登录/同步状态 */
  zhihuStatus(): Promise<import('./zhihu').ZhihuStatus>
  /** 知乎反推荐：打开内嵌登录窗口，成功后复用持久会话 */
  zhihuLogin(): Promise<import('./zhihu').ZhihuOpResult>
  /** 知乎反推荐：清除本机登录态（不删除已生成条目） */
  zhihuLogout(): Promise<import('./zhihu').ZhihuOpResult>
  /** 知乎反推荐：抓取推荐流并生成今日条目（force=true 强制刷新） */
  zhihuSync(force?: boolean): Promise<import('./zhihu').ZhihuOpResult>
  /** 知乎反推荐：今日条目与状态 */
  zhihuToday(): Promise<import('./zhihu').ZhihuTodayResult>
  /** 知乎反推荐：管理条目（已读/存为资料/不感兴趣/恢复） */
  zhihuAct(id: number, action: import('./zhihu').ZhihuPushAction, folder?: string): Promise<import('./zhihu').ZhihuOpResult>
}
