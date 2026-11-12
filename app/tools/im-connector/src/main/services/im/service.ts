/**
 * 对外的服务门面：IPC 和 CLI 都只调这里，保证两边行为一致。
 *
 * 这里刻意不 import electron，接入 InfoAgent 时可以直接注入已有的 db。
 */

import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  IM_DIGEST_EMPTY,
  type ImDigestResult,
  type ImDoctorCheck,
  type ImDoctorReport,
  type ImInsightInfo,
  type ImInsightKind,
  type ImSessionInfo,
  type ImSyncRequest,
  type ImSyncResult,
  type ImUnderstandRequest,
  type ImUnderstandResult,
  type ImWindowInfo
} from '../../../shared/im'
import { dayOf, formatLocalDate } from '../../../shared/imTime'
import * as dao from '../../db/dao/imDao'
import { ChatlogAdapter, ChatlogClient } from './chatlog'
import { ingestAccount, type IngestResult } from './ingest'
import type { CompleteFn } from './llm'
import { QqExportAdapter } from './qqExport'
import { understandSession } from './understand'

export interface ImServiceDeps {
  db: DatabaseSync
  dbPath?: string
  complete?: CompleteFn
  log?: (message: string) => void
}

export interface ImportOutcome {
  accountId: number
  result: IngestResult
  sessions: ImSessionInfo[]
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

  async importQqFiles(files: string[], options: { title?: string; enable?: boolean } = {}): Promise<ImportOutcome> {
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

    return { accountId, result, sessions: dao.listSessions(this.db, accountId) }
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
