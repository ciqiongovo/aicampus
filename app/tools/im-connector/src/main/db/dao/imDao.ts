/**
 * 聊天记录源 DAO。所有 SQL 集中在这里，service 层只做编排。
 *
 * 注意：独立原型里用一个自带的迁移执行器；接入 InfoAgent 后，
 * 把 imMigrations 追加进 src/main/db/migrations.ts 的 MIGRATIONS 即可，
 * 这里的 applyImMigrations 就可以删掉。
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  ImAccountInfo,
  ImInsightInfo,
  ImInsightKind,
  ImInsightStatus,
  ImMessageInfo,
  ImMessageKind,
  ImPlatform,
  ImSessionInfo,
  ImSessionKind,
  ImWindowInfo
} from '../../../shared/im'
import { imMigrations } from '../imSchema'
import { nowLocal } from '../../../shared/imTime'

// ---------------- 迁移 ----------------

/** 只应用聊天记录源自己的迁移；返回应用后的版本号 */
export function applyImMigrations(db: DatabaseSync): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))'
  )
  const current = (
    db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined
  )?.v ?? 0

  for (const migration of imMigrations) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      for (const sql of migration.up) db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0
}

// ---------------- meta ----------------

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM im_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO im_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  )
}

// ---------------- FTS ----------------

/**
 * 尝试建 FTS5 表并回填。中文用 trigram 分词器（默认 unicode61 会把整句当一个 token）。
 * 失败（打包版 SQLite 未带 FTS5）返回 false，检索自动降级 LIKE。
 */
export function ensureImFts(db: DatabaseSync): boolean {
  if (getMeta(db, 'fts') === '1') return true
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS im_message_fts USING fts5(text, tokenize='trigram')")
    db.exec("INSERT INTO im_message_fts(rowid, text) SELECT id, text FROM im_message WHERE deleted = 0 AND text <> ''")
    setMeta(db, 'fts', '1')
    return true
  } catch {
    try {
      setMeta(db, 'fts', '0')
    } catch {
      // im_meta 不存在时也不该让打开数据库失败
    }
    return false
  }
}

export function hasImFts(db: DatabaseSync): boolean {
  return getMeta(db, 'fts') === '1'
}

function syncFts(db: DatabaseSync, id: number, text: string, deleted: number): void {
  if (!hasImFts(db)) return
  try {
    db.prepare('DELETE FROM im_message_fts WHERE rowid = ?').run(id)
    if (!deleted && text.trim()) db.prepare('INSERT INTO im_message_fts(rowid, text) VALUES (?, ?)').run(id, text)
  } catch {
    // FTS 写失败不影响主数据，下次 ensureImFts 回填
  }
}

// ---------------- 账号 ----------------

interface ImAccountRow {
  id: number
  platform: string
  account_key: string
  display_name: string
  adapter: string
  data_root: string
  state: string
  last_error: string | null
  last_sync_at: string | null
}

export interface ImAccountInput {
  platform: ImPlatform
  accountKey: string
  displayName?: string
  adapter?: string
  dataRoot?: string
}

export function upsertAccount(db: DatabaseSync, input: ImAccountInput): number {
  db.prepare(
    `INSERT INTO im_account (platform, account_key, display_name, adapter, data_root)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(platform, account_key) DO UPDATE SET
       display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE im_account.display_name END,
       adapter = CASE WHEN excluded.adapter <> '' THEN excluded.adapter ELSE im_account.adapter END,
       data_root = CASE WHEN excluded.data_root <> '' THEN excluded.data_root ELSE im_account.data_root END`
  ).run(input.platform, input.accountKey, input.displayName ?? '', input.adapter ?? '', input.dataRoot ?? '')

  const row = db
    .prepare('SELECT id FROM im_account WHERE platform = ? AND account_key = ?')
    .get(input.platform, input.accountKey) as { id: number }
  return row.id
}

export function listAccounts(db: DatabaseSync): ImAccountInfo[] {
  const rows = db
    .prepare('SELECT * FROM im_account ORDER BY platform, account_key')
    .all() as unknown as ImAccountRow[]
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform as ImPlatform,
    accountKey: row.account_key,
    displayName: row.display_name,
    adapter: row.adapter,
    dataRoot: row.data_root,
    state: row.state,
    lastError: row.last_error,
    lastSyncAt: row.last_sync_at
  }))
}

export function setAccountState(db: DatabaseSync, id: number, state: string, lastError: string | null): void {
  db.prepare('UPDATE im_account SET state = ?, last_error = ?, last_sync_at = ? WHERE id = ?').run(
    state,
    lastError,
    state === 'ok' ? nowLocal() : null,
    id
  )
}

// ---------------- 会话 ----------------

interface ImSessionRow {
  id: number
  account_id: number
  platform: string
  platform_session_id: string
  kind: string
  title: string
  member_count: number
  enabled: number
  last_msg_at: string | null
  last_seq: number
  summary: string
  summary_seq: number
  synced_at: string | null
  message_count: number
}

export interface ImSessionInput {
  platformSessionId: string
  title: string
  kind: ImSessionKind
  memberCount?: number
  lastMessageAt?: string | null
  enable?: boolean
}

const SESSION_SELECT = `
  SELECT s.*, (SELECT COUNT(*) FROM im_message m WHERE m.session_id = s.id AND m.deleted = 0) AS message_count
  FROM im_session s`

function mapSession(row: ImSessionRow): ImSessionInfo {
  return {
    id: row.id,
    accountId: row.account_id,
    platform: row.platform as ImPlatform,
    platformSessionId: row.platform_session_id,
    kind: row.kind as ImSessionKind,
    title: row.title,
    memberCount: row.member_count,
    enabled: row.enabled === 1,
    lastMsgAt: row.last_msg_at,
    lastSeq: row.last_seq,
    summarySeq: row.summary_seq,
    messageCount: row.message_count,
    summary: row.summary
  }
}

/** 插入或更新会话；enable 只在新建时生效，避免覆盖用户手动关掉的会话 */
export function upsertSession(db: DatabaseSync, accountId: number, input: ImSessionInput): number {
  const existing = db
    .prepare('SELECT id FROM im_session WHERE account_id = ? AND platform_session_id = ?')
    .get(accountId, input.platformSessionId) as { id: number } | undefined

  if (existing) {
    db.prepare(
      `UPDATE im_session SET title = ?, kind = ?, member_count = COALESCE(?, member_count),
         last_msg_at = COALESCE(?, last_msg_at) WHERE id = ?`
    ).run(
      input.title,
      input.kind,
      input.memberCount ?? null,
      input.lastMessageAt ?? null,
      existing.id
    )
    return existing.id
  }

  const result = db
    .prepare(
      `INSERT INTO im_session (account_id, platform_session_id, kind, title, member_count, enabled, last_msg_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      input.platformSessionId,
      input.kind,
      input.title,
      input.memberCount ?? 0,
      input.enable === false ? 0 : 1,
      input.lastMessageAt ?? null
    )
  return Number(result.lastInsertRowid)
}

export function listSessions(db: DatabaseSync, accountId?: number, onlyEnabled = false): ImSessionInfo[] {
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  if (accountId !== undefined) {
    clauses.push('s.account_id = ?')
    params.push(accountId)
  }
  if (onlyEnabled) clauses.push('s.enabled = 1')
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`${SESSION_SELECT}${where} ORDER BY COALESCE(s.last_msg_at, '') DESC, s.id DESC`)
    .all(...params) as unknown as ImSessionRow[]
  return rows.map(mapSession)
}

export function getSession(db: DatabaseSync, id: number): ImSessionInfo | null {
  const rows = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).all(id) as unknown as ImSessionRow[]
  return rows[0] ? mapSession(rows[0]) : null
}

export function findSessionsByTitle(db: DatabaseSync, title: string): ImSessionInfo[] {
  const rows = db
    .prepare(`${SESSION_SELECT} WHERE s.title LIKE ? ORDER BY COALESCE(s.last_msg_at, '') DESC LIMIT 20`)
    .all(`%${title}%`) as unknown as ImSessionRow[]
  return rows.map(mapSession)
}

export function setSessionEnabled(db: DatabaseSync, id: number, enabled: boolean): void {
  db.prepare('UPDATE im_session SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function updateSessionCursor(db: DatabaseSync, id: number, lastSeq: number, lastMsgAt: string | null): void {
  db.prepare(
    `UPDATE im_session SET last_seq = MAX(last_seq, ?), last_msg_at = COALESCE(?, last_msg_at), synced_at = ? WHERE id = ?`
  ).run(lastSeq, lastMsgAt, nowLocal(), id)
}

export function updateSessionSummary(db: DatabaseSync, id: number, summary: string, summarySeq: number): void {
  db.prepare('UPDATE im_session SET summary = ?, summary_seq = ? WHERE id = ?').run(summary, summarySeq, id)
}

export function countMessages(db: DatabaseSync, sessionId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM im_message WHERE session_id = ? AND deleted = 0')
    .get(sessionId) as { c: number } | undefined
  return row?.c ?? 0
}

// ---------------- 消息 ----------------

interface ImMessageRow {
  id: number
  session_id: number
  platform_msg_id: string
  seq: number
  sent_at: string
  sender_id: string
  sender_name: string
  is_self: number
  kind: string
  text: string
  quote_text: string | null
  media_path: string | null
  deleted: number
}

export interface ImMessageInput {
  platformMsgId: string
  seq: number
  sentAt: string
  senderId?: string
  senderName?: string
  isSelf?: boolean
  kind: ImMessageKind
  text?: string
  quoteText?: string | null
  mediaPath?: string | null
  raw?: unknown
  deleted?: boolean
}

function mapMessage(row: ImMessageRow): ImMessageInfo {
  return {
    id: row.id,
    sessionId: row.session_id,
    platformMsgId: row.platform_msg_id,
    seq: row.seq,
    sentAt: row.sent_at,
    senderId: row.sender_id,
    senderName: row.sender_name,
    isSelf: row.is_self === 1,
    kind: row.kind as ImMessageKind,
    text: row.text,
    quoteText: row.quote_text,
    mediaPath: row.media_path,
    deleted: row.deleted === 1
  }
}

export interface UpsertStat {
  inserted: number
  updated: number
}

function upsertMessageInner(db: DatabaseSync, sessionId: number, input: ImMessageInput, stat: UpsertStat): number {
  const existing = db
    .prepare('SELECT id, text, deleted FROM im_message WHERE session_id = ? AND platform_msg_id = ?')
    .get(sessionId, input.platformMsgId) as { id: number; text: string; deleted: number } | undefined

  const deleted = input.deleted ? 1 : 0
  const text = input.text ?? ''

  if (existing) {
    db.prepare(
      `UPDATE im_message SET seq = ?, sent_at = ?, sender_id = ?, sender_name = ?, is_self = ?, kind = ?,
         text = ?, quote_text = ?, media_path = ?, deleted = ?, raw = COALESCE(?, raw)
       WHERE id = ?`
    ).run(
      input.seq,
      input.sentAt,
      input.senderId ?? '',
      input.senderName ?? '',
      input.isSelf ? 1 : 0,
      input.kind,
      text,
      input.quoteText ?? null,
      input.mediaPath ?? null,
      deleted,
      input.raw === undefined ? null : JSON.stringify(input.raw),
      existing.id
    )
    if (existing.text !== text || existing.deleted !== deleted) syncFts(db, existing.id, text, deleted)
    stat.updated += 1
    return existing.id
  }

  const result = db
    .prepare(
      `INSERT INTO im_message
        (session_id, platform_msg_id, seq, sent_at, sender_id, sender_name, is_self, kind, text, quote_text, media_path, raw, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      input.platformMsgId,
      input.seq,
      input.sentAt,
      input.senderId ?? '',
      input.senderName ?? '',
      input.isSelf ? 1 : 0,
      input.kind,
      text,
      input.quoteText ?? null,
      input.mediaPath ?? null,
      input.raw === undefined ? null : JSON.stringify(input.raw),
      deleted
    )
  const id = Number(result.lastInsertRowid)
  if (!deleted && text.trim()) syncFts(db, id, text, deleted)
  stat.inserted += 1
  return id
}

export function upsertMessage(db: DatabaseSync, sessionId: number, input: ImMessageInput): number {
  const stat: UpsertStat = { inserted: 0, updated: 0 }
  return upsertMessageInner(db, sessionId, input, stat)
}

/** 批量写入，单事务；返回插入/更新计数 */
export function bulkUpsertMessages(
  db: DatabaseSync,
  sessionId: number,
  messages: ImMessageInput[]
): UpsertStat & { lastSeq: number; lastSentAt: string | null } {
  const stat: UpsertStat = { inserted: 0, updated: 0 }
  let lastSeq = 0
  let lastSentAt: string | null = null

  db.exec('BEGIN')
  try {
    for (const msg of messages) {
      upsertMessageInner(db, sessionId, msg, stat)
      if (msg.seq > lastSeq) lastSeq = msg.seq
      if (!lastSentAt || msg.sentAt > lastSentAt) lastSentAt = msg.sentAt
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { ...stat, lastSeq, lastSentAt }
}

export interface MessagePage {
  items: ImMessageInfo[]
  total: number
}

export function listMessages(
  db: DatabaseSync,
  sessionId: number,
  opts: { beforeSeq?: number; limit?: number } = {}
): MessagePage {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const before = opts.beforeSeq
  const where = before === undefined
    ? 'session_id = ? AND deleted = 0'
    : 'session_id = ? AND deleted = 0 AND seq < ?'
  const params: SQLInputValue[] = before === undefined ? [sessionId] : [sessionId, before]

  // 先按 seq 倒序取一页，再正序返回，前端直接渲染
  const rows = db
    .prepare(`SELECT * FROM im_message WHERE ${where} ORDER BY seq DESC, id DESC LIMIT ?`)
    .all(...params, limit) as unknown as ImMessageRow[]

  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM im_message WHERE session_id = ? AND deleted = 0').get(sessionId) as {
      c: number
    }
  ).c

  return { items: rows.map(mapMessage).reverse(), total }
}

/** 取摘要游标之后的新消息（按 seq 升序），用于增量理解 */
export function listMessagesAfterSeq(
  db: DatabaseSync,
  sessionId: number,
  afterSeq: number,
  limit = 2000
): ImMessageInfo[] {
  const rows = db
    .prepare('SELECT * FROM im_message WHERE session_id = ? AND deleted = 0 AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(sessionId, afterSeq, limit) as unknown as ImMessageRow[]
  return rows.map(mapMessage)
}

export function getMessagesByIds(db: DatabaseSync, ids: number[]): ImMessageInfo[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM im_message WHERE id IN (${placeholders}) ORDER BY seq ASC`)
    .all(...ids) as unknown as ImMessageRow[]
  return rows.map(mapMessage)
}

// ---------------- 检索 ----------------

export type SearchMode = 'fts' | 'like'

export interface SearchResult {
  items: ImMessageInfo[]
  total: number
  mode: SearchMode
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * 检索消息正文。FTS5 trigram 支持中文子串；查询短于 3 字或 FTS 不可用时退回 LIKE。
 */
export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: { sessionId?: number; limit?: number } = {}
): SearchResult {
  const trimmed = query.trim()
  if (!trimmed) return { items: [], total: 0, mode: 'like' }
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200)

  const sessionClause = opts.sessionId === undefined ? '' : ' AND m.session_id = ?'
  const sessionParams: SQLInputValue[] = opts.sessionId === undefined ? [] : [opts.sessionId]

  if (hasImFts(db) && Array.from(trimmed).length >= 3) {
    try {
      const ftsQuery = `"${trimmed.replace(/"/g, '""')}"`
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM im_message_fts JOIN im_message m ON m.id = im_message_fts.rowid
             WHERE im_message_fts MATCH ? AND m.deleted = 0${sessionClause}`
          )
          .get(ftsQuery, ...sessionParams) as { c: number }
      ).c
      const rows = db
        .prepare(
          `SELECT m.* FROM im_message_fts JOIN im_message m ON m.id = im_message_fts.rowid
           WHERE im_message_fts MATCH ? AND m.deleted = 0${sessionClause}
           ORDER BY m.sent_at DESC, m.seq DESC LIMIT ?`
        )
        .all(ftsQuery, ...sessionParams, limit) as unknown as ImMessageRow[]
      return { items: rows.map(mapMessage), total, mode: 'fts' }
    } catch {
      // 落到 LIKE
    }
  }

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM im_message m WHERE m.deleted = 0 AND m.text LIKE ? ESCAPE '\\'${sessionClause}`)
      .get(likePattern(trimmed), ...sessionParams) as { c: number }
  ).c
  const rows = db
    .prepare(
      `SELECT m.* FROM im_message m WHERE m.deleted = 0 AND m.text LIKE ? ESCAPE '\\'${sessionClause}
       ORDER BY m.sent_at DESC, m.seq DESC LIMIT ?`
    )
    .all(likePattern(trimmed), ...sessionParams, limit) as unknown as ImMessageRow[]
  return { items: rows.map(mapMessage), total, mode: 'like' }
}

// ---------------- 窗口 ----------------

interface ImWindowRow {
  id: number
  session_id: number
  start_msg_id: number
  end_msg_id: number
  start_seq: number
  end_seq: number
  msg_count: number
  stat_date: string
  state: string
  provider: string
  error: string | null
  created_at: string
}

function mapWindow(row: ImWindowRow): ImWindowInfo {
  return {
    id: row.id,
    sessionId: row.session_id,
    startMsgId: row.start_msg_id,
    endMsgId: row.end_msg_id,
    startSeq: row.start_seq,
    endSeq: row.end_seq,
    msgCount: row.msg_count,
    statDate: row.stat_date,
    state: row.state,
    provider: row.provider,
    created_at: row.created_at
  }
}

export interface ImWindowInput {
  startMsgId: number
  endMsgId: number
  startSeq: number
  endSeq: number
  msgCount: number
  statDate: string
}

/** 窗口按 (session, start_seq, end_seq) 唯一，重复调用返回已有 id */
export function getOrCreateWindow(db: DatabaseSync, sessionId: number, input: ImWindowInput): number {
  const existing = db
    .prepare('SELECT id FROM im_window WHERE session_id = ? AND start_seq = ? AND end_seq = ?')
    .get(sessionId, input.startSeq, input.endSeq) as { id: number } | undefined
  if (existing) return existing.id

  const result = db
    .prepare(
      `INSERT INTO im_window (session_id, start_msg_id, end_msg_id, start_seq, end_seq, msg_count, stat_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, input.startMsgId, input.endMsgId, input.startSeq, input.endSeq, input.msgCount, input.statDate)
  return Number(result.lastInsertRowid)
}

export function markWindow(
  db: DatabaseSync,
  id: number,
  state: string,
  provider: string,
  error: string | null = null
): void {
  db.prepare('UPDATE im_window SET state = ?, provider = ?, error = ? WHERE id = ?').run(state, provider, error, id)
}

export function listWindows(db: DatabaseSync, sessionId?: number): ImWindowInfo[] {
  const rows = sessionId === undefined
    ? (db.prepare('SELECT * FROM im_window ORDER BY id DESC LIMIT 200').all() as unknown as ImWindowRow[])
    : (db
        .prepare('SELECT * FROM im_window WHERE session_id = ? ORDER BY start_seq ASC')
        .all(sessionId) as unknown as ImWindowRow[])
  return rows.map(mapWindow)
}

// ---------------- 洞察 ----------------

interface ImInsightRow {
  id: number
  session_id: number
  window_id: number | null
  kind: string
  title: string
  detail: string
  due_at: string | null
  assignee: string | null
  url: string | null
  confidence: number
  evidence: string
  status: string
  created_at: string
  session_title?: string
  stat_date?: string | null
}

function parseEvidence(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is number => typeof v === 'number' && Number.isInteger(v)).slice(0, 8)
  } catch {
    return []
  }
}

function mapInsight(row: ImInsightRow): ImInsightInfo {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.session_title ?? '',
    windowId: row.window_id,
    kind: row.kind as ImInsightKind,
    title: row.title,
    detail: row.detail,
    dueAt: row.due_at,
    assignee: row.assignee,
    url: row.url,
    confidence: row.confidence,
    evidence: parseEvidence(row.evidence),
    status: row.status as ImInsightStatus,
    createdAt: row.created_at,
    day: row.stat_date ?? null
  }
}

export interface ImInsightInput {
  kind: ImInsightKind
  title: string
  detail?: string
  dueAt?: string | null
  assignee?: string | null
  url?: string | null
  confidence?: number
  evidence?: number[]
}

export function deleteInsightsForWindow(db: DatabaseSync, windowId: number): void {
  db.prepare('DELETE FROM im_insight WHERE window_id = ?').run(windowId)
}

export function insertInsight(
  db: DatabaseSync,
  sessionId: number,
  windowId: number | null,
  input: ImInsightInput
): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO im_insight
        (session_id, window_id, kind, title, detail, due_at, assignee, url, confidence, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      windowId,
      input.kind,
      input.title.slice(0, 200),
      (input.detail ?? '').slice(0, 2000),
      input.dueAt ?? null,
      input.assignee ?? null,
      input.url ?? null,
      Math.min(Math.max(input.confidence ?? 0.5, 0), 1),
      JSON.stringify((input.evidence ?? []).slice(0, 8))
    )
  return Number(result.lastInsertRowid)
}

export function listInsights(
  db: DatabaseSync,
  opts: { sessionId?: number; kind?: ImInsightKind; day?: string; limit?: number; status?: ImInsightStatus } = {}
): ImInsightInfo[] {
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  if (opts.sessionId !== undefined) {
    clauses.push('i.session_id = ?')
    params.push(opts.sessionId)
  }
  if (opts.kind) {
    clauses.push('i.kind = ?')
    params.push(opts.kind)
  }
  if (opts.status) {
    clauses.push('i.status = ?')
    params.push(opts.status)
  }
  if (opts.day) {
    clauses.push('w.stat_date = ?')
    params.push(opts.day)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  const rows = db
    .prepare(
      `SELECT i.*, s.title AS session_title, w.stat_date AS stat_date FROM im_insight i
       JOIN im_session s ON s.id = i.session_id
       LEFT JOIN im_window w ON w.id = i.window_id
       ${where}
       ORDER BY i.kind ASC, i.id ASC
       LIMIT ?`
    )
    .all(...params, limit) as unknown as ImInsightRow[]
  return rows.map(mapInsight)
}

export function updateInsightStatus(db: DatabaseSync, id: number, status: ImInsightStatus): void {
  db.prepare('UPDATE im_insight SET status = ? WHERE id = ?').run(status, id)
}

export function countInsights(db: DatabaseSync, windowId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM im_insight WHERE window_id = ?')
    .get(windowId) as { c: number } | undefined
  return row?.c ?? 0
}

/** 某一天（按窗口统计日期）的全部洞察，供日报聚合 */
export function listInsightsByDay(db: DatabaseSync, day: string): ImInsightInfo[] {
  return listInsights(db, { day, limit: 500 })
}

