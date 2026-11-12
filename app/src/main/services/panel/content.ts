import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** 只合并完整原文相同的邮件，不用 AI 摘要/相似标题判断，避免把不同通知误吞。 */
export function normalizePanelContent(value: string): string {
  return value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/gu, ' ').trim()
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizePanelContent(value)
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)])
  )
  return value
}

export function mailContentKey(title: string, body: string, attachmentsJson = '[]'): string {
  let attachments: unknown = attachmentsJson
  try { attachments = stableValue(JSON.parse(attachmentsJson)) }
  catch { /* 非法旧元数据按原文比较，不丢失附件差异。 */ }
  return 'email:' + createHash('sha256').update(JSON.stringify([
    normalizePanelContent(title), normalizePanelContent(body), attachments
  ])).digest('hex')
}

/** 不改邮件/去向，不删资料或事项；只维护面板的展示代表。
 * 已处置 > 已推荐 > 最新到达：新副本不会复活已处置内容，也不会挤掉正在阅读的原件。 */
export function refreshPanelDuplicates(db: DatabaseSync): void {
  // Both probes are indexed. A settled read performs no writes (not even a temp-table
  // rebuild); the database, not a JS revision cache, owns invalidation and rollback.
  const dirty = db.prepare('SELECT 1 FROM panel_dirty_content LIMIT 1').get()
  if (!dirty && !db.prepare('SELECT 1 FROM info WHERE panel_content_key IS NULL LIMIT 1').get()) return
  db.exec('SAVEPOINT sp_panel_content')
  try {
    const missing = db.prepare(
      'SELECT i.id, i.source_email_id, e.subject, e.body_text, e.body_html, e.attachments_json' +
      ' FROM info i LEFT JOIN emails e ON e.id = i.source_email_id WHERE i.panel_content_key IS NULL'
    ).all() as unknown as Array<{
      id: number; source_email_id: number | null; subject: string | null;
      body_text: string | null; body_html: string | null; attachments_json: string | null
    }>
    const set = db.prepare('UPDATE info SET panel_content_key = ? WHERE id = ?')
    for (const row of missing) {
      const body = row.body_text?.trim() ? row.body_text : row.body_html ?? ''
      const hasContent = Boolean(normalizePanelContent(row.subject ?? '') || normalizePanelContent(body) || (row.attachments_json && row.attachments_json !== '[]'))
      const key = row.source_email_id && hasContent
        ? mailContentKey(row.subject ?? '', body, row.attachments_json ?? '[]')
        : `info:${row.id}`
      set.run(key, row.id)
    }
    db.exec(
      'WITH ranked AS MATERIALIZED (SELECT i.id, FIRST_VALUE(i.id) OVER (' +
      ' PARTITION BY i.panel_content_key ORDER BY' +
      " CASE WHEN i.destination IN ('item','archive','keep') THEN 0" +
      ' WHEN EXISTS (SELECT 1 FROM recommendation r WHERE r.info_id = i.id) THEN 1 ELSE 2 END, i.id DESC' +
      ' ) AS canonical FROM panel_dirty_content d JOIN info i ON i.panel_content_key = d.content_key),' +
      ' desired AS MATERIALIZED (SELECT id, CASE WHEN canonical = id THEN NULL ELSE canonical END AS duplicate_of FROM ranked)' +
      ' UPDATE info SET panel_duplicate_of = desired.duplicate_of FROM desired' +
      ' WHERE info.id = desired.id AND info.panel_duplicate_of IS NOT desired.duplicate_of'
    )
    db.exec('DELETE FROM panel_dirty_content')
    db.exec('RELEASE sp_panel_content')
  } catch (error) {
    db.exec('ROLLBACK TO sp_panel_content')
    db.exec('RELEASE sp_panel_content')
    throw error
  }
}
