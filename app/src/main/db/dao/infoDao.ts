import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { InfoRow } from '../types'

/** P1 信息流 DAO：info 表（四去向）。纯 SQL，无 electron 依赖，可直接单测 */

export const INFO_DESTINATIONS = ['unverified', 'item', 'keep', 'archive'] as const
export type InfoDestination = (typeof INFO_DESTINATIONS)[number]

export function isInfoDestination(v: unknown): v is InfoDestination {
  return typeof v === 'string' && (INFO_DESTINATIONS as readonly string[]).includes(v)
}

export interface NewInfo {
  source_type?: string
  source_email_id?: number | null
  title?: string
  content?: string
  category?: string | null
  destination?: InfoDestination
  item_id?: number | null
  status?: string
}

export function createInfo(db: DatabaseSync, input: NewInfo): number {
  const r = db
    .prepare(
      'INSERT INTO info (source_type, source_email_id, title, content, category, destination, item_id, status)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.source_type ?? 'email',
      input.source_email_id ?? null,
      input.title ?? '',
      input.content ?? '',
      input.category ?? null,
      input.destination ?? 'unverified',
      input.item_id ?? null,
      input.status ?? 'unverified'
    )
  return Number(r.lastInsertRowid)
}

export function getInfoByEmail(db: DatabaseSync, emailId: number): InfoRow | undefined {
  return db.prepare("SELECT * FROM info WHERE source_type = 'email' AND source_email_id = ?").get(emailId) as
    | InfoRow
    | undefined
}

/**
 * 分析结果同步为信息流条目（幂等：同来源邮件只生成一条）。
 * 分析后统一进入待处置：重点/其他由面板 AI 判断，不能把普通邮件自动塞进资料而绕过“其他邮件”。
 * 已存在的信息保留原去向；不把用户已经存的资料/归档拉回面板。
 */
export function syncAnalysisToInfo(db: DatabaseSync, emailId: number): InfoRow | null {
  const existing = getInfoByEmail(db, emailId)
  if (existing) return existing
  const row = db
    .prepare(
      'SELECT an.email_id, an.category, an.summary, an.action_required, an.tier, an.analyzed_at, e.subject, e.created_at' +
        ' FROM email_analysis an JOIN emails e ON e.id = an.email_id' +
        " WHERE an.email_id = ? AND an.status = 'analyzed'"
    )
    .get(emailId) as
    | { email_id: number; category: string | null; summary: string | null; action_required: string | null; tier: string | null; analyzed_at: string | null; subject: string; created_at: string }
    | undefined
  if (!row) return null
  const id = createInfo(db, {
    source_type: 'email',
    source_email_id: emailId,
    title: row.subject || '(无主题)',
    content: row.summary ?? '',
    category: row.category,
    destination: 'unverified',
    status: 'unverified'
  })
  // 分析时间比 created_at 默认值更能反映条目真实产生时刻
  const createdAt = row.analyzed_at ?? row.created_at
  if (createdAt) db.prepare('UPDATE info SET created_at = ? WHERE id = ?').run(createdAt, id)
  return db.prepare('SELECT * FROM info WHERE id = ?').get(id) as unknown as InfoRow
}

/** 信息流条目（联出邮件发件人与分析证据，渲染层免 N+1） */
export interface InfoFeedRow {
  id: number
  sourceType: string
  sourceEmailId: number | null
  title: string
  content: string
  category: string | null
  destination: string
  itemId: number | null
  createdAt: string
  fromAddr: string | null
  dateUtc: string | null
  deadlineAt: string | null
  actionRequired: string | null
  tier: string | null
  evidence: string[]
  itemTitle: string | null
  itemStatus: string | null
}

export interface InfoFeedQuery {
  destination?: InfoDestination | 'all'
  category?: string
  keyword?: string
  limit?: number
  offset?: number
}

/** 日报结构化表（v10 迁移后）是否就绪：决定信息流搜索是否连日报子资讯返回父汇总组 */
function hasDailyTables(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('daily_report','daily_article','daily_report_article')"
    )
    .get() as { c: number }
  return row.c === 3
}

/** 关键词筛选：命中标题/正文；日报表就绪时，命中日报子资讯则返回其父汇总组，避免子项扁平截断与漏计 */
function buildKeywordClause(db: DatabaseSync, q: InfoFeedQuery, clause: string[], params: SQLInputValue[]): void {
  const kw = q.keyword?.trim()
  if (!kw) return
  if (hasDailyTables(db)) {
    clause.push(
      "(i.title LIKE '%' || ? || '%' OR i.content LIKE '%' || ? || '%'" +
        ' OR i.id IN (SELECT dr.info_id FROM daily_report dr' +
        ' JOIN daily_report_article dra ON dra.report_id = dr.id' +
        ' JOIN daily_article da ON da.id = dra.article_id' +
        " WHERE da.title LIKE '%' || ? || '%' OR da.content LIKE '%' || ? || '%'))"
    )
    params.push(kw, kw, kw, kw)
  } else {
    clause.push("(i.title LIKE '%' || ? || '%' OR i.content LIKE '%' || ? || '%')")
    params.push(kw, kw)
  }
}

export function listInfoFeed(db: DatabaseSync, q: InfoFeedQuery): InfoFeedRow[] {
  const clause: string[] = []
  const params: SQLInputValue[] = []
  if (q.destination && q.destination !== 'all') {
    clause.push('i.destination = ?')
    params.push(q.destination)
  }
  if (q.category) {
    clause.push('i.category = ?')
    params.push(q.category)
  }
  buildKeywordClause(db, q, clause, params)
  const where = clause.length ? ' WHERE ' + clause.join(' AND ') : ''
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
  const offset = Math.max(q.offset ?? 0, 0)
  const rows = db
    .prepare(
      'SELECT i.*, e.from_addr, e.date_utc, an.deadline_at, an.action_required, an.tier, an.evidence_json, it.title AS item_title, it.status AS item_status' +
        ' FROM info i' +
        ' LEFT JOIN emails e ON e.id = i.source_email_id' +
        ' LEFT JOIN email_analysis an ON an.email_id = i.source_email_id' +
        ' LEFT JOIN items it ON it.id = i.item_id' +
        where +
        ' ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?'
    )
    .all(...params, limit, offset) as Array<{
    id: number
    source_type: string
    source_email_id: number | null
    title: string
    content: string
    category: string | null
    destination: string
    item_id: number | null
    status: string
    created_at: string
    routed_at: string | null
    from_addr: string | null
    date_utc: string | null
    deadline_at: string | null
    action_required: string | null
    tier: string | null
    evidence_json: string
    item_title: string | null
    item_status: string | null
  }>
  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceEmailId: row.source_email_id,
    title: row.title,
    content: row.content,
    category: row.category,
    destination: row.destination,
    itemId: row.item_id,
    createdAt: row.created_at,
    fromAddr: row.from_addr,
    dateUtc: row.date_utc,
    deadlineAt: row.deadline_at,
    actionRequired: row.action_required,
    tier: row.tier,
    evidence: parseEvidence(row.evidence_json),
    itemTitle: row.item_title,
    itemStatus: row.item_status
  }))
}

/** evidence_json 兼容两种历史形态：字符串数组与 [{ t: '...' }] 对象数组；损坏时返回空数组 */
export function parseEvidence(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json || '[]')
    if (!Array.isArray(parsed)) return []
    const result: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string') {
        if (item.trim()) result.push(item.trim())
      } else if (item && typeof item === 'object') {
        const t = (item as Record<string, unknown>).t
        if (typeof t === 'string' && t.trim()) result.push(t.trim())
      }
    }
    return result
  } catch {
    return []
  }
}

/** 分流：destination 决定去向；item 去向必须带 item_id；归档≠删除，条目保留可回查 */
export function routeInfo(
  db: DatabaseSync,
  id: number,
  destination: InfoDestination,
  itemId: number | null = null
): boolean {
  if (!isInfoDestination(destination)) return false
  const existing = db.prepare('SELECT id FROM info WHERE id = ?').get(id) as { id: number } | undefined
  if (!existing) return false
  if (destination === 'item' && !itemId) return false
  if (destination === 'unverified') {
    db.prepare("UPDATE info SET destination = 'unverified', item_id = NULL, status = 'unverified', routed_at = NULL WHERE id = ?").run(id)
  } else {
    db.prepare(
      "UPDATE info SET destination = ?, item_id = ?, status = 'routed', routed_at = datetime('now','localtime') WHERE id = ?"
    ).run(destination, destination === 'item' ? itemId : null, id)
  }
  return true
}

/** 来源邮件已确认为事项时，把对应信息流条目标记为已分流到事项（createItemFromEmail 成功后调用） */
export function markInfoAsItem(db: DatabaseSync, emailId: number, itemId: number): void {
  db.prepare(
    "UPDATE info SET destination = 'item', item_id = ?, status = 'routed', routed_at = datetime('now','localtime')" +
      " WHERE source_type = 'email' AND source_email_id = ? AND destination != 'item'"
  ).run(itemId, emailId)
}
