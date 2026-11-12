import type { DatabaseSync } from 'node:sqlite'
import type { EmailAnalysisRow } from '../types'

export type NewAnalysis = Omit<EmailAnalysisRow, 'id'>

/** email_id 唯一冲突时整体覆盖 */
export function upsertAnalysis(db: DatabaseSync, a: NewAnalysis): number {
  db.prepare(
    `INSERT INTO email_analysis (email_id, status, category, summary, action_required, deadline_raw, deadline_at, deadline_kind, event_start_at, applicable_to, confidence, tier, evidence_json, model, provider, error, analyzed_at)` +
    ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` +
    ` ON CONFLICT(email_id) DO UPDATE SET status = excluded.status, category = excluded.category, summary = excluded.summary, action_required = excluded.action_required, deadline_raw = excluded.deadline_raw, deadline_at = excluded.deadline_at, deadline_kind = excluded.deadline_kind, event_start_at = excluded.event_start_at, applicable_to = excluded.applicable_to, confidence = excluded.confidence, tier = excluded.tier, evidence_json = excluded.evidence_json, model = excluded.model, provider = excluded.provider, error = excluded.error, analyzed_at = excluded.analyzed_at`
  ).run(a.email_id, a.status, a.category, a.summary, a.action_required, a.deadline_raw, a.deadline_at, a.deadline_kind, a.event_start_at, a.applicable_to, a.confidence, a.tier, a.evidence_json, a.model, a.provider, a.error, a.analyzed_at)
  const row = db.prepare('SELECT id FROM email_analysis WHERE email_id = ?').get(a.email_id) as { id: number }
  return row.id
}

export function getByEmailId(db: DatabaseSync, emailId: number): EmailAnalysisRow | undefined {
  return db.prepare('SELECT * FROM email_analysis WHERE email_id = ?').get(emailId) as EmailAnalysisRow | undefined
}

export function listByStatus(db: DatabaseSync, status: EmailAnalysisRow['status'], limit = 100): EmailAnalysisRow[] {
  return db.prepare('SELECT * FROM email_analysis WHERE status = ? ORDER BY id LIMIT ?').all(status, limit) as unknown as EmailAnalysisRow[]
}

export interface PendingAnalysisWithAccount extends EmailAnalysisRow {
  account_id: number
}

/**
 * 批处理取待分析邮件：只取账号 AI 已开启的行（关闭账号的行保持 pending 不消费，
 * 避免 analyzePending 的死循环，重开后自动恢复分析）
 */
export function listPendingWithAccount(db: DatabaseSync, limit = 20): PendingAnalysisWithAccount[] {
  return db
    .prepare(
      'SELECT ea.*, e.account_id FROM email_analysis ea ' +
      'JOIN emails e ON e.id = ea.email_id ' +
      'JOIN accounts a ON a.id = e.account_id ' +
      'WHERE ea.status = ? AND a.ai_enabled = 1 ORDER BY ea.id LIMIT ?'
    )
    .all('pending', limit) as unknown as PendingAnalysisWithAccount[]
}

