import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { PanelOverviewQuery } from '../../../shared/panel'

/** 面板推荐 DAO：来源目录、候选、批次、推荐、反馈事件与偏好信号。纯 SQL，无 electron 依赖。 */

export interface InboxSourceRow {
  key: string
  label: string
  kind: string
  enabled: number
  pending: number
}

export interface PanelCandidateRow {
  id: number
  panel_content_key: string | null
  source_type: string
  source_email_id: number | null
  /** inbox_source.kind；未登记的动态来源为 NULL，按非邮件处理 */
  source_kind: string | null
  title: string
  content: string
  destination: string
  created_at: string
  from_addr: string | null
  subject: string | null
  date_utc: string | null
  analysis_summary: string | null
  action_required: string | null
  deadline_at: string | null
  event_start_at: string | null
  tier: string | null
  analysis_confidence: number | null
}

export interface RecommendationBatchRow {
  id: number
  mode: string
  window_days: number | null
  total: number
  ai_configured: number
  ai_message: string
  created_at: string
}

export interface RecommendationRow {
  id: number
  batch_id: number
  info_id: number
  source_key: string
  title: string
  summary: string
  reason: string
  recommended_action: string
  confidence: number
  score: number
  topic: string | null
  priority: 'focus' | 'other' | null
  received_at: string
  action_required: string | null
  deadline_at: string | null
  event_start_at: string | null
  suggested_at: string | null
  status: string
  chosen_action: string | null
  created_at: string
  acted_at: string | null
  /** 仅带来源目录的查询会填充；缺失按非邮件处理 */
  source_kind?: string | null
  urgent?: number
  source_email_id?: number | null
}

export interface RecommendationDetailRow extends RecommendationRow {
  content: string
  destination: string
  info_item_id: number | null
  from_addr: string | null
  source_email_id: number | null
}

export interface PreferenceSignalRow {
  id: number
  dimension: string
  key: string
  weight: number
  confidence: number
  evidence_count: number
  last_reinforced_at: string
  created_at: string
  updated_at: string
}

/** 来源目录：内置行 + info 里出现过但未登记的 source_type（动态兜底，避免新来源被 UI 丢掉） */
export function listInboxSources(db: DatabaseSync): InboxSourceRow[] {
  return db.prepare(
    'WITH pending AS MATERIALIZED (' +
    ' SELECT i.source_type, SUM(CASE WHEN' +
    " i.destination NOT IN ('item','archive','keep') AND i.panel_duplicate_of IS NULL" +
    ' AND NOT EXISTS (SELECT 1 FROM recommendation r WHERE r.info_id = i.id) THEN 1 ELSE 0 END) AS n' +
    ' FROM info i GROUP BY i.source_type),' +
    ' sources AS (' +
    ' SELECT s.key, s.label, s.kind, s.enabled, COALESCE(p.n, 0) AS pending, s.id AS ordering' +
    ' FROM inbox_source s LEFT JOIN pending p ON p.source_type = s.key UNION ALL' +
    ' SELECT p.source_type, p.source_type, p.source_type, 1, p.n, NULL FROM pending p' +
    ' WHERE NOT EXISTS (SELECT 1 FROM inbox_source s WHERE s.key = p.source_type))' +
    ' SELECT key, label, kind, enabled, pending FROM sources ORDER BY ordering IS NULL, ordering, key'
  ).all() as unknown as InboxSourceRow[]
}

export function getInboxSource(db: DatabaseSync, key: string): InboxSourceRow | undefined {
  return db
    .prepare(
      'SELECT s.key, s.label, s.kind, s.enabled,' +
        " (SELECT COUNT(*) FROM info i WHERE i.source_type = s.key AND i.destination NOT IN ('item','archive','keep') AND i.panel_duplicate_of IS NULL AND NOT EXISTS (SELECT 1 FROM recommendation r WHERE r.info_id = i.id)) AS pending" +
        ' FROM inbox_source s WHERE s.key = ?'
    )
    .get(key) as InboxSourceRow | undefined
}

function scopeSql(sourceKey: string | undefined, clause: string[], params: SQLInputValue[]): void {
  if (sourceKey) {
    clause.push('i.source_type = ?')
    params.push(sourceKey)
  }
}

/** 尚未分流、且从未进过推荐的条数（remaining 的口径） */
export function countPanelCandidates(db: DatabaseSync, sourceKey?: string): number {
  const clause = ["i.destination NOT IN ('item','archive','keep') AND i.panel_duplicate_of IS NULL", 'r.id IS NULL', '(s.enabled = 1 OR s.id IS NULL)']
  const params: SQLInputValue[] = []
  scopeSql(sourceKey, clause, params)
  const row = db
    .prepare(
      'SELECT COUNT(*) AS c FROM info i' +
        ' LEFT JOIN recommendation r ON r.info_id = i.id' +
        ' LEFT JOIN inbox_source s ON s.key = i.source_type' +
        ' WHERE ' + clause.join(' AND ')
    )
    .get(...params) as { c: number }
  return row.c
}

function windowClause(windowDays: number | null | undefined, clause: string[], params: SQLInputValue[]): void {
  if (windowDays === null || windowDays === undefined) return
  const days = Math.max(1, Math.min(Math.trunc(windowDays), 3650))
  clause.push("datetime(COALESCE(e.date_utc, i.created_at)) >= datetime('now', ?)")
  params.push(`-${days} days`)
}

/** 候选：仅待核实（未分流），排除已推荐、已转事项、已归档、已存资料；windowDays 只用于首批“近期”窗口 */
export function listPanelCandidates(
  db: DatabaseSync,
  input: { limit: number; sourceKey?: string; windowDays?: number | null; excludeRecommendation?: boolean; afterInfoId?: number; legacyOnly?: boolean }
): PanelCandidateRow[] {
  const clause = ["i.destination NOT IN ('item','archive','keep') AND i.panel_duplicate_of IS NULL", '(s.enabled = 1 OR s.id IS NULL)']
  const params: SQLInputValue[] = []
  if (input.legacyOnly) clause.push("r.status = 'pending' AND r.priority IS NULL")
  else if (input.excludeRecommendation !== false) clause.push('r.id IS NULL')
  scopeSql(input.sourceKey, clause, params)
  windowClause(input.windowDays, clause, params)
  if (input.afterInfoId !== undefined) {
    clause.push('i.id > ?')
    params.push(input.afterInfoId)
  }
  const limit = Math.max(1, Math.min(Math.trunc(input.limit), 200))
  return db
    .prepare(
      'SELECT i.id, i.panel_content_key, i.source_type, i.source_email_id, s.kind AS source_kind, i.title, COALESCE(NULLIF(e.body_text, \'\'), NULLIF(e.body_html, \'\'), i.content) AS content, i.destination, i.created_at,' +
        ' e.from_addr, e.subject, e.date_utc,' +
        ' an.summary AS analysis_summary, an.action_required, an.deadline_at, an.event_start_at, an.tier, an.confidence AS analysis_confidence' +
        ' FROM info i' +
        ' LEFT JOIN inbox_source s ON s.key = i.source_type' +
        ' LEFT JOIN recommendation r ON r.info_id = i.id' +
        ' LEFT JOIN emails e ON e.id = i.source_email_id' +
        ' LEFT JOIN email_analysis an ON an.email_id = i.source_email_id' +
        ' WHERE ' + clause.join(' AND ') +
        // 有截止时间的近三天未读邮件先进入下一批，即使个性化模型会把它排低。
        ' ORDER BY CASE WHEN s.kind=\'email\' AND e.unread=1 AND an.deadline_at IS NOT NULL' +
        " AND date(e.date_utc,'localtime') BETWEEN date('now','localtime','-2 days') AND date('now','localtime') THEN 0 ELSE 1 END," +
        ' i.id DESC LIMIT ?'
    )
    .all(...params, limit) as unknown as PanelCandidateRow[]
}

export function createRecommendationBatch(
  db: DatabaseSync,
  mode: 'initial' | 'continue',
  windowDays: number | null,
  total: number
): number {
  const r = db
    .prepare('INSERT INTO recommendation_batch (mode, window_days, total) VALUES (?, ?, ?)')
    .run(mode, windowDays, total)
  return Number(r.lastInsertRowid)
}

export function latestRecommendationBatch(db: DatabaseSync): RecommendationBatchRow | undefined {
  return db.prepare('SELECT * FROM recommendation_batch ORDER BY id DESC LIMIT 1').get() as
    | RecommendationBatchRow
    | undefined
}

export interface NewRecommendation {
  batch_id: number
  info_id: number
  source_key: string
  title: string
  summary: string
  reason: string
  recommended_action: string
  confidence: number
  score: number
  topic: string
  priority: 'focus' | 'other'
  action_required: string | null
  deadline_at: string | null
  event_start_at: string | null
  suggested_at: string | null
}

export function insertRecommendation(db: DatabaseSync, input: NewRecommendation): number {
  const r = db
    .prepare(
      'INSERT OR IGNORE INTO recommendation (batch_id, info_id, source_key, title, summary, reason, recommended_action, confidence, score, topic, priority, action_required, deadline_at, event_start_at, suggested_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.batch_id,
      input.info_id,
      input.source_key,
      input.title,
      input.summary,
      input.reason,
      input.recommended_action,
      input.confidence,
      input.score,
      input.topic,
      input.priority,
      input.action_required,
      input.deadline_at,
      input.event_start_at,
      input.suggested_at
    )
  return Number(r.lastInsertRowid)
}

const urgentSql = "(s.kind='email' AND e.unread=1 AND r.deadline_at IS NOT NULL AND date(e.date_utc,'localtime') BETWEEN date('now','localtime','-2 days') AND date('now','localtime'))"
const pendingPrioritySql = "CASE WHEN " + urgentSql + " THEN 'focus' ELSE COALESCE(r.priority, CASE WHEN r.score >= 38 OR r.recommended_action IN ('todo','schedule') THEN 'focus' ELSE 'other' END) END"
const pendingWhereSql = "r.status = 'pending' AND i.destination NOT IN ('item','archive','keep') AND i.panel_duplicate_of IS NULL AND (s.enabled = 1 OR s.id IS NULL)"

function mailDateSql(query?: PanelOverviewQuery): string {
  const range = query?.mailDateRange
  if (!range || ![1, 3, 7, 14, 30, 'older30'].includes(range)) return ''
  // 按本地自然日计算：近 N 天包含今天，30 天前为其补集；仅筛选邮件。
  const age = "julianday(date('now','localtime')) - julianday(date(e.date_utc,'localtime'))"
  return " AND (COALESCE(s.kind,'') != 'email' OR (" +
    (range === 'older30' ? age + ' >= 30' : age + ' >= 0 AND ' + age + ' < ' + range) + '))'
}
export function countPendingRecommendationsBySource(db: DatabaseSync, query?: PanelOverviewQuery): Array<{ source_key: string; priority: string; n: number }> {
  return db.prepare(
    'SELECT r.source_key, ' + pendingPrioritySql + ' AS priority, COUNT(*) AS n' +
    ' FROM recommendation r JOIN info i ON i.id = r.info_id LEFT JOIN emails e ON e.id = i.source_email_id' +
    ' LEFT JOIN inbox_source s ON s.key = r.source_key WHERE ' + pendingWhereSql + mailDateSql(query) +
    ' GROUP BY r.source_key, ' + pendingPrioritySql
  ).all() as unknown as Array<{ source_key: string; priority: string; n: number }>
}

/** 所有批次的未处置推荐一起读；新批次不能把旧批次剩余内容遮住。 */
export function listPendingRecommendations(db: DatabaseSync, sourceKey?: string, query?: Required<Pick<PanelOverviewQuery, 'limit'>> & PanelOverviewQuery): RecommendationRow[] {
  const clause = [pendingWhereSql + mailDateSql(query)]
  const params: SQLInputValue[] = []
  if (sourceKey) { clause.push('r.source_key = ?'); params.push(sourceKey) }
  if (query?.priority) { clause.push(pendingPrioritySql + ' = ?'); params.push(query.priority) }
  if (query?.beforeInfoId !== undefined) { clause.push('r.info_id < ?'); params.push(query.beforeInfoId) }
  if (query) params.push(query.limit + 1)
  return db.prepare(
    'SELECT r.*, s.kind AS source_kind, i.source_email_id, ' + urgentSql + ' AS urgent, COALESCE(e.date_utc, i.created_at) AS received_at FROM recommendation r' +
    ' JOIN info i ON i.id = r.info_id LEFT JOIN emails e ON e.id = i.source_email_id' +
    ' LEFT JOIN inbox_source s ON s.key = r.source_key WHERE ' + clause.join(' AND ') +
    ' ORDER BY r.info_id DESC, r.score DESC, r.id DESC' + (query ? ' LIMIT ?' : '')
  ).all(...params) as unknown as RecommendationRow[]
}

export function getRecommendationDetail(db: DatabaseSync, id: number): RecommendationDetailRow | undefined {
  return db
    .prepare(
      'SELECT r.*, s.kind AS source_kind, i.content, i.destination, i.item_id AS info_item_id, i.source_email_id, e.from_addr, COALESCE(e.date_utc, i.created_at) AS received_at' +
        ' FROM recommendation r' +
        ' JOIN info i ON i.id = r.info_id' +
        ' LEFT JOIN emails e ON e.id = i.source_email_id' +
        ' LEFT JOIN inbox_source s ON s.key = r.source_key' +
        ' WHERE r.id = ?'
    )
    .get(id) as RecommendationDetailRow | undefined
}

export function markRecommendation(
  db: DatabaseSync,
  id: number,
  status: 'accepted' | 'corrected' | 'dismissed',
  chosenAction: string
): boolean {
  const r = db
    .prepare("UPDATE recommendation SET status = ?, chosen_action = ?, acted_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'")
    .run(status, chosenAction, id)
  return r.changes > 0
}

export interface NewFeedback {
  recommendation_id: number
  info_id: number
  source_key: string
  recommended_action: string
  chosen_action: string
  outcome: 'accepted' | 'corrected' | 'dismissed'
  reason: string
}

export function insertFeedback(db: DatabaseSync, input: NewFeedback): number {
  const r = db
    .prepare(
      'INSERT INTO feedback_event (recommendation_id, info_id, source_key, recommended_action, chosen_action, outcome, reason)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.recommendation_id,
      input.info_id,
      input.source_key,
      input.recommended_action,
      input.chosen_action,
      input.outcome,
      input.reason
    )
  return Number(r.lastInsertRowid)
}

export function getPreferenceSignal(
  db: DatabaseSync,
  dimension: string,
  key: string
): PreferenceSignalRow | undefined {
  return db
    .prepare('SELECT * FROM preference_signal WHERE dimension = ? AND key = ?')
    .get(dimension, key) as PreferenceSignalRow | undefined
}

export function upsertPreferenceSignal(
  db: DatabaseSync,
  input: {
    dimension: string
    key: string
    weight: number
    confidence: number
    evidenceCount: number
  }
): void {
  db.prepare(
    "INSERT INTO preference_signal (dimension, key, weight, confidence, evidence_count, last_reinforced_at, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))" +
      ' ON CONFLICT(dimension, key) DO UPDATE SET' +
      ' weight = excluded.weight, confidence = excluded.confidence, evidence_count = excluded.evidence_count,' +
      " last_reinforced_at = datetime('now','localtime'), updated_at = datetime('now','localtime')"
  ).run(input.dimension, input.key, input.weight, input.confidence, input.evidenceCount)
}

export function listPreferenceSignals(db: DatabaseSync, limit = 8): PreferenceSignalRow[] {
  return db
    .prepare('SELECT * FROM preference_signal ORDER BY ABS(weight) DESC, evidence_count DESC LIMIT ?')
    .all(Math.max(1, Math.min(Math.trunc(limit), 50))) as unknown as PreferenceSignalRow[]
}

export interface SourcePreferenceRow {
  id: number
  source_key: string
  dimension: string
  key: string
  weight: number
  confidence: number
  evidence_count: number
  last_reinforced_at: string
  created_at: string
  updated_at: string
}

/** 非邮件来源的独立偏好：与 preference_signal（八类主题雷达）无关，也不展示给用户。 */
export function getSourcePreference(
  db: DatabaseSync,
  sourceKey: string,
  dimension: string,
  key: string
): SourcePreferenceRow | undefined {
  return db
    .prepare('SELECT * FROM source_preference WHERE source_key = ? AND dimension = ? AND key = ?')
    .get(sourceKey, dimension, key) as SourcePreferenceRow | undefined
}

export function upsertSourcePreference(
  db: DatabaseSync,
  input: {
    sourceKey: string
    dimension: 'source' | 'keyword'
    key: string
    weight: number
    confidence: number
    evidenceCount: number
  }
): void {
  db.prepare(
    "INSERT INTO source_preference (source_key, dimension, key, weight, confidence, evidence_count, last_reinforced_at, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))" +
      ' ON CONFLICT(source_key, dimension, key) DO UPDATE SET' +
      ' weight = excluded.weight, confidence = excluded.confidence, evidence_count = excluded.evidence_count,' +
      " last_reinforced_at = datetime('now','localtime'), updated_at = datetime('now','localtime')"
  ).run(input.sourceKey, input.dimension, input.key, input.weight, input.confidence, input.evidenceCount)
}

export function listSourcePreferences(db: DatabaseSync, sourceKey: string, limit = 120): SourcePreferenceRow[] {
  return db
    .prepare('SELECT * FROM source_preference WHERE source_key = ? ORDER BY ABS(weight) DESC, evidence_count DESC LIMIT ?')
    .all(sourceKey, Math.max(1, Math.min(Math.trunc(limit), 500))) as unknown as SourcePreferenceRow[]
}

/** 关键词是隐式学习出来的，数量要有上限，避免长期使用后表无限增长。 */
export function pruneSourcePreferences(db: DatabaseSync, sourceKey: string, keep = 200): void {
  db.prepare(
    "DELETE FROM source_preference WHERE source_key = ? AND dimension = 'keyword' AND key NOT IN (" +
      "SELECT key FROM source_preference WHERE source_key = ? AND dimension = 'keyword'" +
      ' ORDER BY ABS(weight) DESC, evidence_count DESC LIMIT ?)'
  ).run(sourceKey, sourceKey, Math.max(20, Math.trunc(keep)))
}

// 资料栏查询已迁到 materialsDao.ts；面板只保留推荐与反馈。
