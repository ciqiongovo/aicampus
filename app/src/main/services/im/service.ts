/**
 * 对外的服务门面：IPC 和 CLI 都只调这里，保证两边行为一致。
 *
 * 这里刻意不 import electron，接入 InfoAgent 时可以直接注入已有的 db。
 */

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  IM_DIGEST_EMPTY,
  type ImDigestResult,
  type ImImportResult,
  type ImDoctorCheck,
  type ImDoctorReport,
  type ImInsightInfo,
  type ImInsightKind,
  type ImSessionInfo,
  type ImQceStatus,
  type ImSyncRequest,
  type ImSyncQceRequest,
  type ImSyncQceResult,
  type ImSyncResult,
  type ImDailyQqItem,
  type ImDailyQqSummary,
  type ImMessageInfo,
  type QqPanelRange,
  type ImQqItemGroup,
  type ImQqSource,
  type ImUnderstandRequest,
  type ImUnderstandResult,
  type ImWindowInfo
} from '../../../shared/im'
import { dayOf, formatLocalDate } from '../../../shared/imTime'
import * as dao from '../../db/dao/imDao'
import { ChatlogAdapter, ChatlogClient } from './chatlog'
import { ingestAccount } from './ingest'
import type { CompleteFn } from './llm'
import { QceAdapter, QceClient, QCE_DEFAULT_URL, readQceToken } from './qce'
import { QqExportAdapter } from './qqExport'
import { WechatExportAdapter } from './wechatExport'
import { understandSession } from './understand'
import { applyQqKeywordFeedback } from '../panel/keywordProfile'

export interface ImServiceDeps {
  db: DatabaseSync
  dbPath?: string
  complete?: CompleteFn
  log?: (message: string) => void
}

const KIND_LABEL: Record<ImInsightKind, string> = {
  topic: '主题',
  decision: '决定',
  todo: '待办',
  fact: '事实',
  link: '链接',
  question: '待确认'
}

const EMPTY_COUNTS: Record<ImInsightKind, number> = {
  topic: 0,
  decision: 0,
  todo: 0,
  fact: 0,
  link: 0,
  question: 0
}

/** 默认微信数据目录：优先环境变量，其次常见位置 */
export function defaultWechatDataDir(): string | null {
  const candidates = [
    process.env.IM_WECHAT_DIR,
    'D:\\WeChat Files',
    path.join(os.homedir(), 'Documents', 'xwechat_files'),
    path.join(os.homedir(), 'Documents', 'WeChat Files')
  ].filter((value): value is string => Boolean(value))
  return candidates.find((dir) => existsSync(dir)) ?? null
}

export function defaultQqDataDir(): string | null {
  const candidates = [
    process.env.IM_QQ_DIR,
    path.join(os.homedir(), 'Documents', 'Tencent Files'),
    path.join(os.homedir(), 'Documents', 'Tencent Files (NT)')
  ].filter((value): value is string => Boolean(value))
  return candidates.find((dir) => existsSync(dir)) ?? null
}

/** 微信 4.x 的账号目录（db_storage 的上一级） */
export function wechatAccountDirs(root: string): string[] {
  // 3.x：WeChat Files/wxid_xxx/db_storage
  // 4.x：WeChat Files/xwechat_files/wxid_xxx/db_storage
  const found: string[] = []
  const scan = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name)
      if (existsSync(path.join(child, 'db_storage'))) {
        found.push(child)
      } else if (depth > 0) {
        scan(child, depth - 1)
      }
    }
  }
  scan(root, 1)
  return found
}

function renderInsight(item: ImInsightInfo): string {
  const label = KIND_LABEL[item.kind]
  if (item.kind === 'link' && item.url) return `${label}：[${item.title}](${item.url})`
  if (item.kind === 'todo') {
    const meta = [item.assignee ? `@${item.assignee}` : '', item.dueAt ? `截止 ${item.dueAt}` : '']
      .filter(Boolean)
      .join('，')
    return `${label}：${item.title}${meta ? `（${meta}）` : ''}`
  }
  if (item.kind === 'topic') return `${label}：${item.title}`
  return `${label}：${item.title}`
}

export class ImService {
  private readonly db: DatabaseSync
  private readonly log: (message: string) => void

  constructor(private readonly deps: ImServiceDeps) {
    this.db = deps.db
    this.log = deps.log ?? (() => {})
    dao.ensureImFts(this.db)
  }

  // ---------------- 自检 ----------------

  async doctor(options: { chatlogUrl?: string } = {}): Promise<ImDoctorReport> {
    const checks: ImDoctorCheck[] = []
    const hints: string[] = []

    let dbOk = true
    try {
      this.db.prepare('SELECT 1 AS ok').get()
    } catch (error) {
      dbOk = false
      hints.push(`数据库不可用：${error instanceof Error ? error.message : String(error)}`)
    }
    checks.push({ name: '数据库', ok: dbOk, detail: this.deps.dbPath ?? '已打开' })

    const fts = dao.hasImFts(this.db)
    checks.push({
      name: 'FTS5 中文检索',
      ok: fts,
      detail: fts ? 'trigram 分词可用' : '不可用，检索降级为 LIKE'
    })
    if (!fts) hints.push('当前 SQLite 未启用 FTS5，短消息量下 LIKE 够用；数据量大时建议换成带 FTS5 的运行时')

    const wechatDir = defaultWechatDataDir()
    const accountDirs = wechatDir ? wechatAccountDirs(wechatDir) : []
    checks.push({
      name: '微信数据目录',
      ok: Boolean(wechatDir),
      detail: wechatDir ? `${wechatDir}（${accountDirs.length} 个账号目录）` : '未找到，可设置 IM_WECHAT_DIR'
    })
    if (!wechatDir) hints.push('没找到微信数据目录：设置 IM_WECHAT_DIR 指向 WeChat Files 根目录')

    const qqDir = defaultQqDataDir()
    checks.push({
      name: 'QQ 数据目录',
      ok: Boolean(qqDir),
      detail: qqDir ? qqDir : '未找到，可设置 IM_QQ_DIR'
    })
    if (!qqDir) hints.push('没找到 QQ 数据目录：设置 IM_QQ_DIR，或在消息管理器里导出 txt 后用 import-qq')

    const chatlogUrl = options.chatlogUrl ?? process.env.IM_CHATLOG_URL ?? 'http://127.0.0.1:5030'
    const health = await new ChatlogClient({ baseUrl: chatlogUrl, timeoutMs: 1500 }).health()
    checks.push({
      name: 'chatlog 侧车',
      ok: health.ok,
      detail: health.ok ? `${chatlogUrl} 可达` : `${chatlogUrl} 不可达（微信同步需要它）`
    })
    if (!health.ok) hints.push('启动 chatlog：chatlog server --addr 127.0.0.1:5030；QQ 可先用 export 的 txt 导入')

    const llmOk = Boolean(this.deps.complete)
    checks.push({
      name: '模型配置',
      ok: llmOk,
      detail: llmOk ? '已配置，可做语义理解' : '未配置，只能走规则抽取'
    })
    if (!llmOk) hints.push('设置 IM_LLM_API_KEY（或 DEEPSEEK_API_KEY）后启用模型理解')

    const ok = dbOk && (Boolean(wechatDir) || Boolean(qqDir))
    return { ok, database: this.deps.dbPath ?? ':memory:', fts, checks, hints }
  }

  // ---------------- 查询 ----------------

  listSessions(accountId?: number): ImSessionInfo[] {
    return dao.listSessions(this.db, accountId)
  }

  listAccounts() {
    return dao.listAccounts(this.db)
  }

  listMessages(sessionId: number, beforeSeq?: number, limit?: number) {
    return dao.listMessages(this.db, sessionId, { beforeSeq, limit })
  }

  search(query: string, sessionId?: number, limit?: number) {
    return dao.searchMessages(this.db, query, { sessionId, limit })
  }

  listInsights(options: { sessionId?: number; kind?: ImInsightKind; day?: string; status?: 'new' | 'accepted' | 'dismissed' } = {}) {
    return dao.listInsights(this.db, options)
  }

  /** 面板“原文”：按结论 ID 取证据消息，避免渲染层直接接触消息 ID */
  insightSource(id: number): ImMessageInfo[] {
    return dao.getInsightSourceMessages(this.db, id)
  }

  listWindows(sessionId?: number): ImWindowInfo[] {
    return dao.listWindows(this.db, sessionId)
  }

  setSessionEnabled(sessionId: number, enabled: boolean): boolean {
    const session = dao.getSession(this.db, sessionId)
    if (!session) return false
    dao.setSessionEnabled(this.db, sessionId, enabled)
    return true
  }

  findSessionByTitle(title: string): ImSessionInfo[] {
    return dao.findSessionsByTitle(this.db, title)
  }

  // ---------------- 采集 ----------------

  async importQqFiles(files: string[], options: { title?: string; enable?: boolean } = {}): Promise<ImImportResult> {
    const existing = files.filter((file) => existsSync(file))
    if (existing.length === 0) throw new Error('没有可读的导出文件')

    const accountId = dao.upsertAccount(this.db, {
      platform: 'qq',
      accountKey: 'qq-export',
      displayName: 'QQ 导出记录',
      adapter: 'qq-export',
      dataRoot: path.dirname(existing[0])
    })

    const adapter = new QqExportAdapter(existing, { title: options.title })
    const result = await ingestAccount(this.db, accountId, adapter, {
      enableNew: options.enable !== false,
      limit: 100_000,
      log: this.log
    })

    return {
      accountId,
      sessions: result.sessions,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors
    }
  }

  async importWechatFiles(files: string[], options: { title?: string; enable?: boolean } = {}): Promise<ImImportResult> {
    const existing = files.filter((file) => existsSync(file))
    if (existing.length === 0) throw new Error('没有可读的微信导出文件')

    const accountId = dao.upsertAccount(this.db, {
      platform: 'wechat',
      accountKey: 'wechat-export',
      displayName: '微信导出记录',
      adapter: 'wechat-export',
      dataRoot: path.dirname(existing[0])
    })

    const adapter = new WechatExportAdapter(existing, { title: options.title })
    const result = await ingestAccount(this.db, accountId, adapter, {
      enableNew: options.enable !== false,
      limit: 100_000,
      log: this.log
    })

    return { accountId, sessions: result.sessions, inserted: result.inserted, updated: result.updated, errors: result.errors }
  }

  /**
   * 自动识别导入文件的来源：QQ 消息管理器导出（有「消息记录（此记录未加密）」等表头）
   * 走 QQ 适配器，其余按微信文本导出处理。两类文件可以一起选。
   */
  async importExportFiles(files: string[], options: { title?: string; enable?: boolean } = {}): Promise<ImImportResult> {
    const existing = files.filter((file) => existsSync(file))
    if (existing.length === 0) throw new Error('没有可读的导出文件')

    const qqFiles: string[] = []
    const wechatFiles: string[] = []
    for (const file of existing) {
      const head = (await readFile(file, 'utf8')).slice(0, 400)
      if (/消息记录（此记录未加密）|消息对象[:：]|消息分组[:：]/.test(head)) qqFiles.push(file)
      else wechatFiles.push(file)
    }

    const parts: ImImportResult[] = []
    if (qqFiles.length > 0) parts.push(await this.importQqFiles(qqFiles, options))
    if (wechatFiles.length > 0) parts.push(await this.importWechatFiles(wechatFiles, options))
    if (parts.length === 0) throw new Error('没有可读的导出文件')
    if (parts.length === 1) return parts[0]

    return {
      accountId: parts[0].accountId,
      sessions: parts.reduce((sum, item) => sum + item.sessions, 0),
      inserted: parts.reduce((sum, item) => sum + item.inserted, 0),
      updated: parts.reduce((sum, item) => sum + item.updated, 0),
      errors: parts.flatMap((item) => item.errors)
    }
  }

  async syncWechat(request: ImSyncRequest = {}): Promise<ImSyncResult> {
    const baseUrl = request.baseUrl ?? process.env.IM_CHATLOG_URL ?? 'http://127.0.0.1:5030'
    const token = request.token ?? process.env.IM_CHATLOG_TOKEN
    const client = new ChatlogClient({ baseUrl, token })
    const health = await client.health()
    if (!health.ok) {
      return {
        ok: false,
        message: `chatlog 不可达（${baseUrl}）：${health.detail}`,
        sessions: 0,
        inserted: 0,
        updated: 0,
        errors: []
      }
    }

    let accountKey = 'chatlog-local'
    try {
      accountKey = `chatlog-${new URL(baseUrl).host}`
    } catch {
      // 保留默认 key
    }

    const dataRoot = defaultWechatDataDir()
    const accountId = dao.upsertAccount(this.db, {
      platform: 'wechat',
      accountKey,
      displayName: '微信（chatlog）',
      adapter: 'chatlog',
      dataRoot: dataRoot ?? ''
    })

    const adapter = new ChatlogAdapter(client, dataRoot)
    const result = await ingestAccount(this.db, accountId, adapter, {
      onlyEnabled: request.onlyEnabled,
      enableNew: request.enableNew,
      limit: request.limit,
      log: this.log
    })

    return {
      ok: result.errors.length === 0,
      message:
        result.errors.length === 0
          ? `同步完成：${result.sessions} 个会话，新增 ${result.inserted} 条，更新 ${result.updated} 条`
          : `部分会话同步失败（${result.errors.length} 个）`,
      sessions: result.sessions,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors
    }
  }

  /** 只探测 QCE 状态，不落库；设置页用来显示「在线 / 未登录 / 未启动」 */
  async qceStatus(baseUrlInput?: string): Promise<ImQceStatus> {
    const baseUrl = baseUrlInput?.trim() || process.env.IM_QCE_URL || QCE_DEFAULT_URL
    const token = readQceToken()
    if (!token) {
      return {
        online: false,
        mode: null,
        baseUrl,
        tokenFound: false,
        message: '未找到令牌：先启动 QCE 并登录 QQ，令牌会写到 ~/.qq-chat-exporter/security.json'
      }
    }
    try {
      const state = await new QceClient({ baseUrl, token }).health()
      return {
        online: state.online,
        mode: state.mode ?? null,
        baseUrl,
        tokenFound: true,
        message: state.online
          ? `QCE 在线（${state.mode ?? '未知模式'}），可以同步`
          : `QCE 已启动（${baseUrl}）但 QQ 未登录，请在 QCE 控制台扫码或快速登录`
      }
    } catch (error) {
      return {
        online: false,
        mode: null,
        baseUrl,
        tokenFound: true,
        message: `QCE 不可达（${baseUrl}）：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  async syncQce(request: ImSyncQceRequest = {}): Promise<ImSyncQceResult> {
    const baseUrl = request.baseUrl?.trim() || process.env.IM_QCE_URL || QCE_DEFAULT_URL
    const token = request.token?.trim() || readQceToken()
    const empty = { accountId: 0, sessions: 0, inserted: 0, updated: 0, errors: [] as string[] }
    if (!token) {
      return {
        ...empty,
        online: false,
        message: '未找到 QCE 访问令牌：请先启动 QCE 并登录过 QQ（~/.qq-chat-exporter/security.json）'
      }
    }

    const client = new QceClient({ baseUrl, token })
    try {
      const state = await client.health()
      if (!state.online) {
        return { ...empty, online: false, message: `QCE 已启动（${baseUrl}）但 QQ 未登录，请先在 QCE 里登录 QQ` }
      }
    } catch (error) {
      return {
        ...empty,
        online: false,
        message: `QCE 不可达（${baseUrl}）：${error instanceof Error ? error.message : String(error)}`
      }
    }

    let accountKey = 'qce-local'
    try {
      accountKey = `qce-${new URL(baseUrl).host}`
    } catch {
      // 保留默认 key
    }

    const accountId = dao.upsertAccount(this.db, {
      platform: 'qq',
      accountKey,
      displayName: 'QQ（QCE 同步）',
      adapter: 'qce',
      dataRoot: baseUrl
    })

    const adapter = new QceAdapter(client, { maxMessages: request.limitPerSession ?? 2000 })
    const result = await ingestAccount(this.db, accountId, adapter, {
      enableNew: request.enableNew,
      limit: request.limitPerSession,
      log: this.log
    })

    return {
      accountId,
      sessions: result.sessions,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors,
      online: true,
      message:
        result.errors.length === 0
          ? `QCE 同步完成：${result.sessions} 个会话，新增 ${result.inserted} 条，更新 ${result.updated} 条`
          : `QCE 同步完成，但有 ${result.errors.length} 个会话失败`
    }
  }

  // ---------------- 理解 ----------------

  async understand(sessionId: number, request: ImUnderstandRequest = {}): Promise<ImUnderstandResult> {
    const outcome = await understandSession(
      { db: this.db, complete: this.deps.complete, log: this.log },
      sessionId,
      { provider: request.provider, force: request.force, maxWindows: request.maxWindows }
    )

    return {
      ok: true,
      message:
        outcome.windows === 0
          ? '没有新的消息需要理解'
          : `理解 ${outcome.windows} 个窗口，产出 ${outcome.insights} 条结论（${outcome.provider}）`,
      windows: outcome.windows,
      insights: outcome.insights,
      provider: outcome.provider
    }
  }

  // ---------------- AI 信息来源（QQ 群） ----------------

  /** 可选群列表：按最近消息数从多到少，标记是否已选为 AI 信息来源 */
  listQqSources(): ImQqSource[] {
    const selected = this.getSelectedSourceIds()
    return dao
      .listSessions(this.db)
      .filter((item) => item.platform === 'qq')
      .map((item) => ({
        sessionId: item.id,
        title: item.title,
        messageCount: item.messageCount,
        lastMessageAt: item.lastMsgAt,
        selected: selected.includes(item.id)
      }))
      .sort((a, b) => b.messageCount - a.messageCount)
  }

  /** 保存选中的群（只接受 qq 会话，返回实际落库的 id） */
  setQqSources(sessionIds: number[]): number[] {
    const valid = new Set(
      dao
        .listSessions(this.db)
        .filter((item) => item.platform === 'qq')
        .map((item) => item.id)
    )
    const ids = Array.from(new Set(sessionIds.filter((id) => valid.has(id))))
    dao.setMeta(this.db, 'ai_sources', JSON.stringify(ids))
    return ids
  }

  getSelectedSourceIds(): number[] {
    const raw = dao.getMeta(this.db, 'ai_sources')
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
    } catch {
      return []
    }
  }

  /** 更新单条结论的处理状态（采纳/忽略），同时把反馈计入全局关键词画像。 */
  setInsightStatus(id: number, status: 'new' | 'accepted' | 'dismissed'): boolean {
    this.db.exec('SAVEPOINT sp_im_insight_status')
    try {
      dao.updateInsightStatus(this.db, id, status)
      applyQqKeywordFeedback(this.db, id, status)
      this.db.exec('RELEASE sp_im_insight_status')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK TO sp_im_insight_status')
      this.db.exec('RELEASE sp_im_insight_status')
      throw error
    }
  }

  /**
   * 日报用的 QQ 栏：先确保选中群已按“清洗 → 切窗格式化 → 模型抽取”走过一遍，
   * 再取出当天的结论，拆成“实际动作（已发生/已定）”和“建议动作（待办/待确认）”。
   */
  async dailyQq(dateKey?: string, options: { extract?: boolean; range?: QqPanelRange } = {}): Promise<ImDailyQqSummary> {
    const date = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : formatLocalDate(new Date())
    const sources = this.listQqSources()
    const selected = sources.filter((item) => item.selected)
    const errors: string[] = []

    if (options.extract !== false) {
      for (const source of selected) {
        try {
          await this.understand(source.sessionId, {})
        } catch (error) {
          errors.push(`${source.title}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const range = [1, 3, 7, 30, 'older30'].includes(options.range!) ? options.range! : 3
    const day = new Date(`${date}T12:00:00`)
    day.setDate(day.getDate() - (range === 'older30' ? 30 : range - 1))
    const boundary = formatLocalDate(day)
    const insights = dao.listQqInsightsInRange(
      this.db, selected.map((item) => item.sessionId),
      range === 'older30' ? null : boundary,
      range === 'older30' ? boundary : date
    )
    // 一次取齐证据消息的发送时间，供面板显示“消息时间”和“原文”
    const evidenceMessages = dao.getMessagesByIds(
      this.db,
      [...new Set(insights.flatMap((item) => item.evidence))]
    )
    const sentAtById = new Map(evidenceMessages.map((message) => [message.id, message.sentAt]))
    const items: ImDailyQqItem[] = insights.map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      sessionTitle: item.sessionTitle,
      kind: item.kind,
      group: (item.kind === 'decision' || item.kind === 'fact' ? 'actual' : 'suggested') as ImQqItemGroup,
      title: item.title,
      detail: item.detail,
      dueAt: item.dueAt,
      status: item.status,
      sentAt: item.evidence
        .map((id) => sentAtById.get(id))
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null
    }))

    return {
      dateKey: date,
      sources,
      items,
      stats: {
        actual: items.filter((item) => item.group === 'actual').length,
        suggested: items.filter((item) => item.group === 'suggested').length,
        accepted: items.filter((item) => item.status === 'accepted').length,
        dismissed: items.filter((item) => item.status === 'dismissed').length
      }
    }
  }

  // ---------------- 日报 ----------------

  digest(day?: string): ImDigestResult {
    const date = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : formatLocalDate(new Date())
    const insights = dao.listInsightsByDay(this.db, date)
    const counts: Record<ImInsightKind, number> = { ...EMPTY_COUNTS }
    for (const item of insights) counts[item.kind] += 1

    if (insights.length === 0) {
      return { date, markdown: `${IM_DIGEST_EMPTY}\n\n日期：${date}`, counts }
    }

    const groups = new Map<string, ImInsightInfo[]>()
    for (const item of insights) {
      const title = item.sessionTitle || `会话 ${item.sessionId}`
      const list = groups.get(title) ?? []
      list.push(item)
      groups.set(title, list)
    }

    const lines: string[] = [`# ${date} 聊天摘要`, '']
    lines.push(`共 ${groups.size} 个会话、${insights.length} 条结论。`, '')

    for (const [title, items] of groups) {
      lines.push(`## ${title}`, '')
      for (const item of items) lines.push(`- ${renderInsight(item)}`)
      lines.push('')
    }

    return { date, markdown: lines.join('\n').trimEnd(), counts }
  }

  /** 调试用：某天的消息条数 */
  countDayMessages(day: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM im_message WHERE substr(sent_at, 1, 10) = ? AND deleted = 0")
      .get(day) as { c: number } | undefined
    return row?.c ?? 0
  }
}

export { dayOf }
