/**
 * 微信 / QQ 聊天记录源：共享契约（类型 + IPC 通道）。
 *
 * 与 InfoAgent 里 shared/daily.ts 的做法一致：新通道单独成文件，
 * 不去改 shared/types.ts 里已有的 IPC 常量，接入时由主进程/预加载汇总。
 */

// ---------- IPC 通道 ----------

export const IM_IPC = {
  imDoctor: 'im:doctor',
  imSessions: 'im:sessions',
  imSessionToggle: 'im:session-toggle',
  imMessages: 'im:messages',
  imSearch: 'im:search',
  imSync: 'im:sync',
  imSyncQce: 'im:sync-qce',
  imQceStatus: 'im:qce-status',
  imQceRuntime: 'im:qce-runtime',
  imQceLaunch: 'im:qce-launch',
  imQceLogout: 'im:qce-logout',
  imQceReveal: 'im:qce-reveal',
  imQcePickQq: 'im:qce-pick-qq',
  imQceLogTail: 'im:qce-log-tail',
  imImportFile: 'im:import-file',
  imPickImportFiles: 'im:pick-import-files',
  imWindows: 'im:windows',
  imUnderstand: 'im:understand',
  imInsights: 'im:insights',
  imDigest: 'im:digest',
  imQqSources: 'im:qq-sources',
  imQqSourcesSet: 'im:qq-sources-set',
  imQqDaily: 'im:qq-daily',
  imInsightSource: 'im:insight-source',
  imInsightStatus: 'im:insight-status'
} as const

export type ImIpcChannel = (typeof IM_IPC)[keyof typeof IM_IPC]

// ---------- 基本枚举 ----------

export type ImPlatform = 'wechat' | 'qq'
export type ImSessionKind = 'peer' | 'group' | 'official'
export type ImMessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'link'
  | 'quote'
  | 'sticker'
  | 'location'
  | 'system'
  | 'redpacket'
  | 'merge'
  | 'call'
  | 'other'
export type ImInsightKind = 'topic' | 'decision' | 'todo' | 'fact' | 'link' | 'question'
export type ImInsightStatus = 'new' | 'accepted' | 'dismissed'
export type ImUnderstandProvider = 'heuristic' | 'llm'

// ---------- 数据视图 ----------

export interface ImAccountInfo {
  id: number
  platform: ImPlatform
  accountKey: string
  displayName: string
  adapter: string
  dataRoot: string
  state: string
  lastError: string | null
  lastSyncAt: string | null
}

export interface ImSessionInfo {
  id: number
  accountId: number
  platform: ImPlatform
  platformSessionId: string
  kind: ImSessionKind
  title: string
  memberCount: number
  enabled: boolean
  lastMsgAt: string | null
  lastSeq: number
  /** 已理解到的消息序号（增量理解游标） */
  summarySeq: number
  messageCount: number
  summary: string
}

export interface ImMessageInfo {
  id: number
  sessionId: number
  platformMsgId: string
  seq: number
  sentAt: string
  senderId: string
  senderName: string
  isSelf: boolean
  kind: ImMessageKind
  text: string
  quoteText: string | null
  mediaPath: string | null
  deleted: boolean
}

export interface ImWindowInfo {
  id: number
  sessionId: number
  startMsgId: number
  endMsgId: number
  startSeq: number
  endSeq: number
  msgCount: number
  statDate: string
  state: string
  provider: string
  created_at: string
}

export interface ImInsightInfo {
  id: number
  sessionId: number
  sessionTitle: string
  windowId: number | null
  kind: ImInsightKind
  title: string
  detail: string
  dueAt: string | null
  assignee: string | null
  url: string | null
  confidence: number
  evidence: number[]
  status: ImInsightStatus
  createdAt: string
  /** 所属窗口的统计日期（YYYY-MM-DD），没有窗口时为 null */
  day: string | null
}

/** QQ 群作为 AI 信息来源的可选条目（按最近消息数排序） */
export interface ImQqSource {
  sessionId: number
  title: string
  messageCount: number
  lastMessageAt: string | null
  selected: boolean
}

/** 日报里的 QQ 条目标签：actual=实际动作（已发生/已定），suggested=建议动作（待办/待确认） */
export type ImQqItemGroup = 'actual' | 'suggested'

export interface ImDailyQqItem {
  id: number
  sessionId: number
  sessionTitle: string
  kind: ImInsightKind
  group: ImQqItemGroup
  title: string
  detail: string
  dueAt: string | null
  status: ImInsightStatus
  /** 支撑这条结论的最早一条原文消息的发送时间；没有证据时为 null */
  sentAt: string | null
}

export interface ImDailyQqSummary {
  dateKey: string
  sources: ImQqSource[]
  items: ImDailyQqItem[]
  /** 实际/建议/已采纳/已忽略 的计数，用于日报里的反馈对照 */
  stats: { actual: number; suggested: number; accepted: number; dismissed: number }
}

export type QqPanelRange = 1 | 3 | 7 | 30 | 'older30'

// ---------- 理解结果（模型 / 规则共用同一形状） ----------

export interface ImEvidenceItem {
  text: string
  evidence: number[]
}

export interface ImTodoItem extends ImEvidenceItem {
  dueAt: string | null
  assignee: string | null
}

export interface ImLinkItem {
  url: string
  title: string | null
  evidence: number[]
}

export interface ImExtraction {
  topic: string
  summary: string
  decisions: ImEvidenceItem[]
  todos: ImTodoItem[]
  facts: ImEvidenceItem[]
  links: ImLinkItem[]
  questions: ImEvidenceItem[]
  urgency: 'low' | 'normal' | 'high'
  confidence: number
}

// ---------- 请求 / 响应 ----------

export interface ImMessageQuery {
  sessionId: number
  beforeSeq?: number
  limit?: number
}

export interface ImSearchQuery {
  query: string
  sessionId?: number
  limit?: number
}

export interface ImSyncRequest {
  baseUrl?: string
  token?: string
  /** 只同步用户勾选过的会话 */
  onlyEnabled?: boolean
  /** 首次同步时自动勾选发现的会话 */
  enableNew?: boolean
  limit?: number
}

export interface ImSyncResult {
  ok: boolean
  message: string
  sessions: number
  inserted: number
  updated: number
  errors: string[]
}

export interface ImImportRequest {
  files: string[]
  title?: string
  enable?: boolean
}

export interface ImUnderstandRequest {
  /** 冗余字段：IPC 已单独传 sessionId，调用服务层时可省略 */
  sessionId?: number
  provider?: ImUnderstandProvider
  force?: boolean
  maxWindows?: number
}

export interface ImUnderstandResult {
  ok: boolean
  message: string
  windows: number
  insights: number
  provider: string
}

export interface ImDigestResult {
  date: string
  markdown: string
  counts: Record<ImInsightKind, number>
}

export interface ImDoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ImDoctorReport {
  ok: boolean
  database: string
  fts: boolean
  checks: ImDoctorCheck[]
  hints: string[]
}

// ---------- 渲染层 API ----------

export interface ImMessagePage {
  items: ImMessageInfo[]
  total: number
}

export interface ImSearchResult {
  items: ImMessageInfo[]
  total: number
  mode: 'fts' | 'like'
}

export interface ImImportResult {
  accountId: number
  sessions: number
  inserted: number
  updated: number
  errors: string[]
}

/** 从 QCE（NapCat）本地服务同步：令牌缺省时主进程自己读取 QCE 的 security.json */
export interface ImSyncQceRequest {
  baseUrl?: string
  token?: string
  enableNew?: boolean
  limitPerSession?: number
}

/** QCE（NapCat + qq-chat-exporter）本地服务的连接状态 */
export interface ImQceStatus {
  online: boolean
  mode: string | null
  baseUrl: string
  tokenFound: boolean
  message: string
}

/** 内置 QCE 运行集的阶段（与 main/services/im/qceRuntime.ts 保持一致） */
export type ImQcePhase =
  | 'unsupported'
  | 'missing_runtime'
  | 'qq_not_found'
  | 'stopped'
  | 'starting'
  | 'waiting_login'
  | 'online'
  | 'error'

/** 内置 QCE 运行集的完整状态，供设置页展示与按钮禁用判断 */
export interface ImQceRuntimeStatus {
  phase: ImQcePhase
  detail: string
  code: string | null
  baseUrl: string
  qceDir: string | null
  qqPath: string | null
  runtimeVersion: string | null
  qqRunning: boolean
  tokenFound: boolean
  online: boolean
  mode: string | null
  launchedAt: string | null
  logPath: string | null
}

export interface ImSyncQceResult extends ImImportResult {
  online: boolean
  message: string
}

/** preload 通过 contextBridge 暴露给渲染层的 IM 接口 */
export interface ImApi {
  imDoctor(): Promise<ImDoctorReport>
  imSessions(accountId?: number): Promise<ImSessionInfo[]>
  imSessionToggle(sessionId: number, enabled: boolean): Promise<boolean>
  imMessages(sessionId: number, beforeSeq?: number, limit?: number): Promise<ImMessagePage>
  imSearch(query: string, sessionId?: number, limit?: number): Promise<ImSearchResult>
  imSync(request?: ImSyncRequest): Promise<ImSyncResult>
  imSyncQce(request?: ImSyncQceRequest): Promise<ImSyncQceResult>
  imQceStatus(baseUrl?: string): Promise<ImQceStatus>
  imQceRuntime(baseUrl?: string): Promise<ImQceRuntimeStatus>
  imQceLaunch(baseUrl?: string): Promise<ImQceRuntimeStatus>
  imQceLogout(): Promise<ImQceRuntimeStatus>
  imQceReveal(): Promise<boolean>
  imQcePickQq(): Promise<string | null>
  imQceLogTail(limit?: number): Promise<string[]>
  imPickImportFiles(): Promise<string[]>
  imImportFile(files: string[], options?: { title?: string; enable?: boolean }): Promise<ImImportResult>
  imWindows(sessionId?: number): Promise<ImWindowInfo[]>
  imUnderstand(sessionId: number, request?: ImUnderstandRequest): Promise<ImUnderstandResult>
  imInsights(query?: { sessionId?: number; kind?: ImInsightKind; day?: string; status?: string }): Promise<ImInsightInfo[]>
  imDigest(day?: string): Promise<ImDigestResult>
  imQqSources(): Promise<ImQqSource[]>
  imQqSourcesSet(sessionIds: number[]): Promise<number[]>
  imQqDaily(dateKey?: string, options?: { extract?: boolean; range?: QqPanelRange }): Promise<ImDailyQqSummary>
  imInsightSource(id: number): Promise<ImMessageInfo[]>
  imInsightStatus(id: number, status: ImInsightStatus): Promise<boolean>
}

/** 当天没有任何可跟进结论时的固定提示语 */
export const IM_DIGEST_EMPTY = '这一天没有需要跟进的信息。'
