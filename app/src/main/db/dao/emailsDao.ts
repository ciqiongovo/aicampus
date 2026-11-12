import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { EmailRow } from '../types'
import type { MailTagDefinition } from '../../../shared/mailLabels'
import { getMailTagsForEmails, validateTagIds } from './mailTagsDao'

export type NewEmail = Omit<EmailRow, 'id' | 'created_at' | 'starred'>

const COLS = [
  'account_id', 'folder', 'uid', 'message_id', 'subject', 'from_addr', 'to_addr', 'cc',
  'date_utc', 'date_raw', 'unread', 'body_text', 'body_html', 'attachments_json', 'size'
] as const

/** 唯一键 (account_id, folder, uid) 冲突时更新内容；返回行 id */
export function upsertEmail(db: DatabaseSync, e: NewEmail): number {
  // unread 取两者较小值：本地已读（0）不会被服务器仍为未读（1）覆盖回未读
  const updates = COLS.filter((c) => c !== 'account_id' && c !== 'folder' && c !== 'uid')
    .map((c) => (c === 'unread' ? 'unread = MIN(emails.unread, excluded.unread)' : `${c} = excluded.${c}`))
    .join(', ')
  db.prepare(
    `INSERT INTO emails (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})` +
    ` ON CONFLICT(account_id, folder, uid) DO UPDATE SET ${updates}`
  ).run(e.account_id, e.folder, e.uid, e.message_id, e.subject, e.from_addr, e.to_addr, e.cc, e.date_utc, e.date_raw, e.unread, e.body_text, e.body_html, e.attachments_json, e.size)
  const row = db.prepare('SELECT id FROM emails WHERE account_id = ? AND folder = ? AND uid = ?').get(e.account_id, e.folder, e.uid) as { id: number }
  return row.id
}

export function getEmail(db: DatabaseSync, id: number): EmailRow | undefined {
  return db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as EmailRow | undefined
}

export function findByUid(db: DatabaseSync, accountId: number, folder: string, uid: number): EmailRow | undefined {
  return db.prepare('SELECT * FROM emails WHERE account_id = ? AND folder = ? AND uid = ?').get(accountId, folder, uid) as EmailRow | undefined
}

export interface ListEmailsOptions {
  accountId?: number
  folder?: string
  limit?: number
  offset?: number
}

export function listEmails(db: DatabaseSync, opts: ListEmailsOptions = {}): EmailRow[] {
  const where: string[] = []
  const values: SQLInputValue[] = []
  if (opts.accountId !== undefined) {
    where.push('account_id = ?')
    values.push(opts.accountId)
  }
  if (opts.folder !== undefined) {
    where.push('folder = ?')
    values.push(opts.folder)
  }
  const sql = `SELECT * FROM emails${where.length ? ' WHERE ' + where.join(' AND ') : ''}` +
    ` ORDER BY COALESCE(date_utc, created_at) DESC, id DESC LIMIT ? OFFSET ?`
  values.push(opts.limit ?? 50, opts.offset ?? 0)
  return db.prepare(sql).all(...values) as unknown as EmailRow[]
}

/** 统计某账号下主题等于给定标记的邮件数（用于识别需要重新解析的历史数据） */
export function countEmailsBySubject(db: DatabaseSync, accountId: number, subject: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM emails WHERE account_id = ? AND subject = ?')
    .get(accountId, subject) as { c: number }
  return row.c
}

export function countEmails(db: DatabaseSync, accountId?: number): number {
  const row = accountId === undefined
    ? db.prepare('SELECT COUNT(*) AS c FROM emails').get() as { c: number }
    : db.prepare('SELECT COUNT(*) AS c FROM emails WHERE account_id = ?').get(accountId) as { c: number }
  return row.c
}

/** 左侧文件夹树的计数行：按 (账号, 文件夹) 分组的总数与未读数 */
interface FolderCountRow {
  account_id: number
  folder: string
  total: number
  unread: number
}

export function countEmailsByFolder(db: DatabaseSync, accountId?: number): FolderCountRow[] {
  const sql =
    'SELECT account_id, folder, COUNT(*) AS total, SUM(unread) AS unread FROM emails' +
    (accountId === undefined ? '' : ' WHERE account_id = ?') +
    ' GROUP BY account_id, folder ORDER BY account_id, folder'
  const rows = (accountId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(accountId)) as Array<{
    account_id: number
    folder: string
    total: number
    unread: number | null
  }>
  return rows.map((row) => ({
    account_id: row.account_id,
    folder: row.folder,
    total: row.total,
    unread: row.unread ?? 0
  }))
}

/** 列表用行：附带账号名称与 AI 分析摘要（M5 列表与详情共用） */
export interface EmailListRow {
  tags?: MailTagDefinition[]
  id: number
  account_id: number
  account_label: string
  folder: string
  uid: number
  message_id: string
  subject: string
  body_text: string
  from_addr: string
  to_addr: string
  cc: string
  date_utc: string | null
  date_raw: string | null
  unread: number
  starred: number
  attachments_json: string
  size: number
  analysis_status: string | null
  category: string | null
}

export interface SearchEmailsOptions {
  tagIds?: number[]
  /** 缺省 any（OR）；all 要求同一邮件覆盖全部去重标签。 */
  tagMatch?: 'any' | 'all'
  accountId?: number
  folder?: string
  /** 关键词：主题 / 发件人 / 收件人 / 正文纯文本 */
  keyword?: string
  unreadOnly?: boolean
  /** 仅显示带附件的邮件 */
  hasAttachment?: boolean
  /** 仅显示已加星标的邮件 */
  starredOnly?: boolean
  /** 仅显示指定 AI 分类的邮件（A7） */
  category?: string
  /** 仅显示指定分析状态的邮件；未建分析记录的邮件按 pending 计（A7） */
  analysisStatus?: string
  limit?: number
  offset?: number
}

export interface SearchEmailsResult {
  total: number
  rows: EmailListRow[]
}

const LIST_FROM =
  ' FROM emails e' +
  ' LEFT JOIN accounts a ON a.id = e.account_id' +
  ' LEFT JOIN email_analysis an ON an.email_id = e.id'
const LIST_SELECT =
  "SELECT e.id, e.account_id, COALESCE(a.label, '') AS account_label, e.folder, e.uid, e.message_id," +
  ' e.subject, substr(e.body_text, 1, 1200) AS body_text, e.from_addr, e.to_addr, e.cc, e.date_utc, e.date_raw, e.unread, e.starred, e.attachments_json, e.size,' +
  ' an.status AS analysis_status, an.category AS category' +
  LIST_FROM

/** 关键词过滤：≥3 字纯 CJK/字母/数字走 FTS5 trigram 快速检索，其余（短词/含特殊字符）回退 LIKE */
function buildEmailFilter(opts: SearchEmailsOptions): { clause: string; values: SQLInputValue[] } {
  const where: string[] = []
  const values: SQLInputValue[] = []
  if (opts.accountId !== undefined) {
    where.push('e.account_id = ?')
    values.push(opts.accountId)
  }
  if (opts.folder) {
    where.push('e.folder = ?')
    values.push(opts.folder)
  }
  if (opts.unreadOnly) where.push('e.unread = 1')
  if (opts.starredOnly) where.push('e.starred = 1')
  if (opts.hasAttachment) where.push("e.attachments_json IS NOT NULL AND e.attachments_json NOT IN ('', '[]')")
  // A7：分类 / 分析状态筛选（分析状态按分析表视图过滤，未分析邮件视为 pending）
  if (opts.category) {
    where.push('an.category = ?')
    values.push(opts.category)
  }
  if (opts.analysisStatus) {
    where.push("COALESCE(an.status, 'pending') = ?")
    values.push(opts.analysisStatus)
  }
  if (opts.tagIds !== undefined) {
    const tagIds = validateTagIds(opts.tagIds)
    if (tagIds.length) {
      const tagFilter = ' FROM email_custom_tags ct WHERE ct.email_id = e.id AND ct.tag_id IN (' + tagIds.map(() => '?').join(',') + ')'
      if (opts.tagMatch === 'all') {
        where.push('(SELECT COUNT(DISTINCT ct.tag_id)' + tagFilter + ') = ?')
        values.push(...tagIds, tagIds.length)
      } else {
        where.push('EXISTS (SELECT 1' + tagFilter + ')')
        values.push(...tagIds)
      }
    }
  }
  const keyword = opts.keyword?.trim()
  if (keyword) {
    // trigram 短语须 ≥3 字符，且不掺引号/特殊字符，否则走 LIKE（含 %/_ 转义）保证语义不变
    if (/^[\u4e00-\u9fffA-Za-z0-9]+$/.test(keyword) && keyword.length >= 3) {
      where.push('e.id IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)')
      values.push('"' + keyword + '"')
    } else {
      const like = '%' + keyword.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%'
      where.push(
        "(e.subject LIKE ? ESCAPE '\\' OR e.from_addr LIKE ? ESCAPE '\\'" +
        " OR e.to_addr LIKE ? ESCAPE '\\' OR e.body_text LIKE ? ESCAPE '\\')"
      )
      values.push(like, like, like, like)
    }
  }
  return { clause: where.length ? ' WHERE ' + where.join(' AND ') : '', values }
}

/** 邮件列表查询：服务端过滤 + 分页，返回 total 供分页器使用 */
export function searchEmails(db: DatabaseSync, opts: SearchEmailsOptions = {}): SearchEmailsResult {
  const filter = buildEmailFilter(opts)
  // count 与列表使用同一 FROM/WHERE，确保联表过滤（分类/分析状态）下 total 准确
  const countRow = db
    .prepare('SELECT COUNT(*) AS c' + LIST_FROM + filter.clause)
    .get(...filter.values) as { c: number }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = db
    .prepare(
      LIST_SELECT + filter.clause +
      ' ORDER BY COALESCE(e.date_utc, e.created_at) DESC, e.id DESC LIMIT ? OFFSET ?'
    )
    .all(...filter.values, limit, offset) as unknown as EmailListRow[]
  const tags = getMailTagsForEmails(db, rows.map(row => row.id))
  for (const row of rows) row.tags = tags.get(row.id) ?? []
  return { total: countRow.c, rows }
}

export function getEmailListItem(db: DatabaseSync, id: number): EmailListRow | undefined {
  const row = db.prepare(LIST_SELECT + ' WHERE e.id = ?').get(id) as EmailListRow | undefined
  if (row) row.tags = getMailTagsForEmails(db, [id]).get(id) ?? []
  return row
}

/** 标签回填用：取最近若干封邮件（含正文片段），不附加自定义标签，避免一次加载过多关联数据。 */
export function listEmailRowsForTagging(db: DatabaseSync, limit = 5000): EmailListRow[] {
  return db
    .prepare(LIST_SELECT + ' ORDER BY COALESCE(e.date_utc, e.created_at) DESC, e.id DESC LIMIT ?')
    .all(limit) as unknown as EmailListRow[]
}

/** 只改本地已读标记，不回写服务器（M5 约定） */
export function setEmailUnread(db: DatabaseSync, id: number, unread: number): void {
  db.prepare('UPDATE emails SET unread = ? WHERE id = ?').run(unread ? 1 : 0, id)
}

/** 只改本地星标（纯本地状态，同步不会覆盖它） */
export function setEmailStarred(db: DatabaseSync, id: number, starred: boolean): void {
  db.prepare('UPDATE emails SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id)
}
