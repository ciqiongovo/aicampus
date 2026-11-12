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
  imImportFile: 'im:import-file',
  imWindows: 'im:windows',
  imUnderstand: 'im:understand',
  imInsights: 'im:insights',
  imDigest: 'im:digest'
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

/** 当天没有任何可跟进结论时的固定提示语 */
export const IM_DIGEST_EMPTY = '这一天没有需要跟进的信息。'
