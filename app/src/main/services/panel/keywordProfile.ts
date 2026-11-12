import type { DatabaseSync } from 'node:sqlite'
import type { AnalysisKeyword } from '../ai/schema'
import { FEEDBACK_BASE } from '../../../shared/panel'
import type { PanelActionKey, PanelKeywordProfile } from '../../../shared/panel'
import { keywordSensitivityGain } from '../feedbackSensitivity'

/** 关键词画像是全局画像：邮件与 QQ 的处置反馈写入同一份关键词，邮件单次反馈权重更高。
 * 同一来源条目重复反馈不加权；归档中性；仅另一条 14 天内也被正向处置时算重复。
 */
export const KEYWORD_REPEAT_WINDOW_DAYS = 14
export const KEYWORD_BASE_HALF_LIFE_DAYS = 21
/** 邮件是画像主来源，QQ 反馈计入同一画像但权重减半。 */
export const EMAIL_KEYWORD_FEEDBACK_WEIGHT = FEEDBACK_BASE.emailKeyword
export const QQ_KEYWORD_FEEDBACK_WEIGHT = FEEDBACK_BASE.qqKeyword
export const EMAIL_KEYWORD_REPEAT_BONUS = FEEDBACK_BASE.emailRepeat
export const QQ_KEYWORD_REPEAT_BONUS = FEEDBACK_BASE.qqRepeat
/** 单条 QQ 结论一次最多带入的新词，避免一段总结把画像冲散。 */
const QQ_MAX_NEW_KEYWORDS = 3
const QQ_MAX_KEYWORDS = 8

type FeedbackSource = 'email' | 'qq'
type FeedbackStatus = 'new' | 'accepted' | 'dismissed'

interface KeywordRow {
  keyword: string
  weight: number
  evidence_count: number
  repeat_count: number
  email_count: number
  qq_count: number
  last_feedback_at: string
  last_seen_at: string
}

interface FeedbackRow {
  sentiment: number
  weight: number
}

interface FeedbackEvent {
  source: FeedbackSource
  sourceId: number
  keyword: string
  sentiment: number
  baseWeight: number
  repeatBonus: number
  allowChange: boolean
  now: Date
}

function daysSince(iso: string, now: Date): number {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 86_400_000) : 0
}

export function keywordHalfLife(repeatCount: number): number {
  return KEYWORD_BASE_HALF_LIFE_DAYS * (1 + Math.min(4, Math.max(0, repeatCount)) * 0.5)
}

export function effectiveKeywordWeight(row: KeywordRow, now = new Date()): number {
  return row.weight * Math.pow(0.5, daysSince(row.last_feedback_at, now) / keywordHalfLife(row.repeat_count))
}

function clampWeight(value: number): number {
  return Math.max(-3, Math.min(3, value))
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function parseEvidence(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is number => typeof value === 'number' && Number.isInteger(value)).slice(0, 8)
  } catch {
    return []
  }
}

function profileRow(db: DatabaseSync, keyword: string): KeywordRow | undefined {
  return db.prepare('SELECT * FROM keyword_profile WHERE keyword = ?').get(keyword) as unknown as KeywordRow | undefined
}

function feedbackRow(db: DatabaseSync, source: FeedbackSource, sourceId: number, keyword: string): FeedbackRow | undefined {
  return db
    .prepare('SELECT sentiment, weight FROM keyword_feedback WHERE source = ? AND source_id = ? AND keyword = ?')
    .get(source, sourceId, keyword) as unknown as FeedbackRow | undefined
}

function refreshSourceCounts(db: DatabaseSync, keyword: string): void {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN source = 'email' THEN 1 ELSE 0 END) AS email_count,
              SUM(CASE WHEN source = 'qq' THEN 1 ELSE 0 END) AS qq_count
       FROM keyword_feedback WHERE keyword = ?`
    )
    .get(keyword) as unknown as { email_count: number | null; qq_count: number | null } | undefined
  db.prepare('UPDATE keyword_profile SET email_count = ?, qq_count = ? WHERE keyword = ?').run(
    Number(row?.email_count ?? 0),
    Number(row?.qq_count ?? 0),
    keyword
  )
}

function saveProfile(
  db: DatabaseSync,
  keyword: string,
  weight: number,
  old: KeywordRow | undefined,
  evidenceDelta: number,
  repeatDelta: number,
  now: Date
): void {
  const timestamp = now.toISOString()
  if (old) {
    db.prepare(
      `UPDATE keyword_profile
       SET weight = ?, evidence_count = MAX(0, evidence_count + ?), repeat_count = MAX(0, repeat_count + ?),
           last_feedback_at = ?, last_seen_at = ?
       WHERE keyword = ?`
    ).run(clampWeight(weight), evidenceDelta, repeatDelta, timestamp, timestamp, keyword)
  } else {
    db.prepare(
      `INSERT INTO keyword_profile(keyword, weight, evidence_count, repeat_count, email_count, qq_count, last_feedback_at, last_seen_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
    ).run(keyword, clampWeight(weight), Math.max(0, evidenceDelta), Math.max(0, repeatDelta), timestamp, timestamp)
  }
  refreshSourceCounts(db, keyword)
}

function hasPositiveRepeat(db: DatabaseSync, keyword: string, source: FeedbackSource, sourceId: number, now: Date): boolean {
  const windowStart = new Date(now.getTime() - KEYWORD_REPEAT_WINDOW_DAYS * 86_400_000).toISOString()
  const row = db
    .prepare(
      `SELECT 1 FROM keyword_feedback
       WHERE keyword = ? AND sentiment > 0 AND created_at >= ? AND created_at <= ?
         AND NOT (source = ? AND source_id = ?)
       LIMIT 1`
    )
    .get(keyword, windowStart, now.toISOString(), source, sourceId)
  return row !== undefined
}

function applyFeedbackEvent(db: DatabaseSync, event: FeedbackEvent): void {
  const { source, sourceId, keyword, sentiment, baseWeight, repeatBonus, allowChange, now } = event
  const existing = feedbackRow(db, source, sourceId, keyword)
  const old = profileRow(db, keyword)
  const current = old ? effectiveKeywordWeight(old, now) : 0

  if (existing) {
    if (!allowChange || existing.sentiment === sentiment) return
    const weight = current + (sentiment - existing.sentiment) * Number(existing.weight)
    db.prepare('UPDATE keyword_feedback SET sentiment = ?, created_at = ? WHERE source = ? AND source_id = ? AND keyword = ?').run(
      sentiment,
      now.toISOString(),
      source,
      sourceId,
      keyword
    )
    saveProfile(db, keyword, weight, old, 0, 0, now)
    return
  }

  const repeated = sentiment > 0 && !!old && old.weight > 0 && hasPositiveRepeat(db, keyword, source, sourceId, now)
  const weight = current + sentiment * baseWeight + (repeated ? repeatBonus : 0)
  db.prepare(
    `INSERT INTO keyword_feedback(source, source_id, keyword, sentiment, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(source, sourceId, keyword, sentiment, baseWeight, now.toISOString())
  saveProfile(db, keyword, weight, old, 1, repeated ? 1 : 0, now)
}

function removeFeedbackEvent(db: DatabaseSync, source: FeedbackSource, sourceId: number, keyword: string, now: Date): void {
  const existing = feedbackRow(db, source, sourceId, keyword)
  if (!existing) return
  const old = profileRow(db, keyword)
  const current = old ? effectiveKeywordWeight(old, now) : 0
  const weight = current - existing.sentiment * Number(existing.weight)
  db.prepare('DELETE FROM keyword_feedback WHERE source = ? AND source_id = ? AND keyword = ?').run(source, sourceId, keyword)
  if (old) saveProfile(db, keyword, weight, old, -1, 0, now)
}

/** 模型字段仅是候选词；证据必须存在于本次实际发送的标题/正文中。 */
export function recordEmailKeywords(db: DatabaseSync, emailId: number, keywords: AnalysisKeyword[], sourceText: string, now = new Date()): void {
  const source = sourceText.replace(/\s+/g, '')
  const accepted = keywords.filter(item => source.includes(item.evidence.replace(/\s+/g, '')))
  db.exec('SAVEPOINT sp_email_keywords')
  try {
    db.prepare('DELETE FROM email_keyword WHERE email_id = ?').run(emailId)
    const insert = db.prepare('INSERT INTO email_keyword(email_id, keyword, kind, evidence, confidence) VALUES (?, ?, ?, ?, ?)')
    const seen = db.prepare('UPDATE keyword_profile SET last_seen_at = ? WHERE keyword = ?')
    for (const item of accepted) {
      insert.run(emailId, item.keyword, item.kind, item.evidence, item.confidence)
      seen.run(now.toISOString(), item.keyword)
    }
    db.exec('RELEASE sp_email_keywords')
  } catch (error) {
    db.exec('ROLLBACK TO sp_email_keywords')
    db.exec('RELEASE sp_email_keywords')
    throw error
  }
}

/** 面板成功处置的同一事务内更新，唯一约束阻止同一封邮件重复反馈。 */
export function applyKeywordFeedback(
  db: DatabaseSync,
  emailId: number | null,
  recommendationId: number,
  action: PanelActionKey,
  now = new Date()
): void {
  void recommendationId
  if (emailId === null || action === 'archive') return
  const gain = keywordSensitivityGain(db)
  const sentiment = action === 'ignore' ? -1 : 1
  const keywords = db.prepare('SELECT keyword FROM email_keyword WHERE email_id = ?').all(emailId) as unknown as Array<{ keyword: string }>
  db.exec('SAVEPOINT sp_email_keyword_feedback')
  try {
    for (const item of keywords) {
      applyFeedbackEvent(db, {
        source: 'email',
        sourceId: emailId,
        keyword: item.keyword,
        sentiment,
        baseWeight: EMAIL_KEYWORD_FEEDBACK_WEIGHT * gain,
        repeatBonus: EMAIL_KEYWORD_REPEAT_BONUS * gain,
        allowChange: false,
        now
      })
    }
    db.exec('RELEASE sp_email_keyword_feedback')
  } catch (error) {
    db.exec('ROLLBACK TO sp_email_keyword_feedback')
    db.exec('RELEASE sp_email_keyword_feedback')
    throw error
  }
}

/** QQ 结论的采纳/忽略计入同一份关键词画像；撤销时撤回该条带来的权重。 */
export function applyQqKeywordFeedback(db: DatabaseSync, insightId: number, status: FeedbackStatus, now = new Date()): void {
  const insight = db.prepare('SELECT title, detail, evidence FROM im_insight WHERE id = ?').get(insightId) as
    | { title: string; detail: string; evidence: string }
    | undefined
  if (!insight) return

  const gain = keywordSensitivityGain(db)
  db.exec('SAVEPOINT sp_qq_keyword_feedback')
  try {
    if (status === 'new') {
      const rows = db
        .prepare('SELECT keyword FROM keyword_feedback WHERE source = ? AND source_id = ?')
        .all('qq', insightId) as unknown as Array<{ keyword: string }>
      for (const row of rows) removeFeedbackEvent(db, 'qq', insightId, row.keyword, now)
    } else {
      const sentiment = status === 'accepted' ? 1 : -1
      const evidenceText = readEvidenceText(db, insight.evidence)
      const keywords = qqKeywords(db, insight.title, insight.detail, evidenceText, sentiment > 0)
      for (const keyword of keywords) {
        applyFeedbackEvent(db, {
          source: 'qq',
          sourceId: insightId,
          keyword,
          sentiment,
          baseWeight: QQ_KEYWORD_FEEDBACK_WEIGHT * gain,
          repeatBonus: QQ_KEYWORD_REPEAT_BONUS * gain,
          allowChange: true,
          now
        })
      }
    }
    db.exec('RELEASE sp_qq_keyword_feedback')
  } catch (error) {
    db.exec('ROLLBACK TO sp_qq_keyword_feedback')
    db.exec('RELEASE sp_qq_keyword_feedback')
    throw error
  }
}

function readEvidenceText(db: DatabaseSync, raw: string): string {
  const ids = parseEvidence(raw)
  if (ids.length === 0) return ''
  try {
    const rows = db
      .prepare(`SELECT text FROM im_message WHERE deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as unknown as Array<{ text: string }>
    return rows.map((row) => row.text).join('\n')
  } catch {
    return ''
  }
}

/** 已有关键词按原文匹配；正向反馈可从总结里再带入少量新词，负向反馈不制造新词。 */
function qqKeywords(db: DatabaseSync, title: string, detail: string, evidenceText: string, allowNew: boolean): string[] {
  const haystack = normalizeText(`${title}\n${detail}\n${evidenceText}`)
  const known = db
    .prepare('SELECT keyword FROM keyword_profile UNION SELECT keyword FROM email_keyword')
    .all() as unknown as Array<{ keyword: string }>
  const result: string[] = []
  const seen = new Set<string>()
  for (const row of known) {
    const key = normalizeText(row.keyword)
    if (key.length < 2 || seen.has(key) || !haystack.includes(key)) continue
    seen.add(key)
    result.push(row.keyword.trim())
    if (result.length >= QQ_MAX_KEYWORDS) return result
  }
  if (!allowNew) return result

  let added = 0
  for (const word of segmentCandidates(`${title}\n${detail}`)) {
    const key = normalizeText(word)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(word)
    added += 1
    if (added >= QQ_MAX_NEW_KEYWORDS || result.length >= QQ_MAX_KEYWORDS) break
  }
  return result
}

const STOPWORDS = new Set([
  '今天', '明天', '后天', '昨天', '现在', '目前', '已经', '还是', '就是', '这个', '那个', '这些', '那些',
  '什么', '怎么', '为什么', '因为', '所以', '如果', '但是', '然后', '以及', '并且', '而且', '可以', '需要',
  '应该', '可能', '没有', '不是', '我们', '你们', '他们', '大家', '自己', '一下', '一些', '有关', '相关',
  '关于', '进行', '通过', '一个', '两个', '时候', '问题', '情况', '内容', '消息', '群里', '群聊', '同学',
  '老师', '会议', '安排', '通知', '提醒', '确认', '参加', '参与', '截止', '时间', '大家', '这次', '那边',
  '这里', '那里', '准备', '觉得', '知道', '看看', '回复', '收到'
])

type SegmenterLike = { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> }
const SegmenterCtor = (Intl as unknown as {
  Segmenter?: new (locale: string, options: { granularity: 'word' }) => SegmenterLike
}).Segmenter

function segmentCandidates(text: string): string[] {
  if (!SegmenterCtor) return []
  const segmenter = new SegmenterCtor('zh-CN', { granularity: 'word' })
  const counts = new Map<string, number>()
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue
    const word = part.segment.trim()
    if (!isCandidateWord(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word)
}

function isCandidateWord(word: string): boolean {
  if (word.length < 2 || word.length > 12) return false
  if (STOPWORDS.has(word)) return false
  if (/^\d+$/.test(word)) return false
  if (/^[\d./:-]+$/.test(word)) return false
  if (/^[a-z]{1,2}$/i.test(word)) return false
  if (/[@#]/.test(word)) return false
  if (/(https?|www\.)/i.test(word)) return false
  return /[\u3400-\u9fff]/.test(word) || /^[a-zA-Z][a-zA-Z0-9+.#-]{2,}$/.test(word)
}

export function listKeywordProfile(db: DatabaseSync, now = new Date(), limit = 18): PanelKeywordProfile[] {
  const rows = db.prepare('SELECT * FROM keyword_profile ORDER BY ABS(weight) DESC LIMIT 500').all() as unknown as KeywordRow[]
  return rows
    .map(row => ({
      keyword: row.keyword,
      weight: Math.round(effectiveKeywordWeight(row, now) * 100) / 100,
      evidenceCount: row.evidence_count,
      repeatCount: row.repeat_count,
      emailCount: row.email_count ?? 0,
      qqCount: row.qq_count ?? 0,
      halfLifeDays: keywordHalfLife(row.repeat_count),
      lastSeenAt: row.last_seen_at
    }))
    .filter(row => Math.abs(row.weight) >= 0.05)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, Math.max(0, Math.min(200, limit)))
}

/** 用户手动改权重：以当前时刻重新起算衰减，0 视为移出画像。 */
export function setKeywordProfileWeight(
  db: DatabaseSync,
  rawKeyword: unknown,
  rawWeight: unknown,
  now = new Date()
): PanelKeywordProfile[] {
  const keyword = typeof rawKeyword === 'string' ? rawKeyword.trim().replace(/\s+/g, ' ') : ''
  const weight = typeof rawWeight === 'number' ? rawWeight : Number.NaN
  if (keyword.length < 1 || keyword.length > 24 || !Number.isFinite(weight)) {
    throw new Error('关键词为空或权重无效')
  }
  if (Math.abs(weight) < 0.05) return deleteKeywordProfile(db, keyword)

  const clamped = clampWeight(Math.round(weight * 100) / 100)
  const timestamp = now.toISOString()
  const old = profileRow(db, keyword)
  if (old) {
    db.prepare(
      `UPDATE keyword_profile
       SET weight = ?, last_feedback_at = ?, last_seen_at = ?
       WHERE keyword = ?`
    ).run(clamped, timestamp, timestamp, keyword)
  } else {
    db.prepare(
      `INSERT INTO keyword_profile(keyword, weight, evidence_count, repeat_count, email_count, qq_count, last_feedback_at, last_seen_at)
       VALUES (?, ?, 0, 0, 0, 0, ?, ?)`
    ).run(keyword, clamped, timestamp, timestamp)
  }
  return listKeywordProfile(db, now, 200)
}

/** 手动删除：同时清掉该词的反馈与邮件匹配，避免继续影响推荐分数。 */
export function deleteKeywordProfile(db: DatabaseSync, rawKeyword: unknown): PanelKeywordProfile[] {
  const keyword = typeof rawKeyword === 'string' ? rawKeyword.trim().replace(/\s+/g, ' ') : ''
  if (!keyword) throw new Error('关键词为空')
  db.exec('SAVEPOINT sp_keyword_delete')
  try {
    db.prepare('DELETE FROM email_keyword WHERE keyword = ?').run(keyword)
    db.prepare('DELETE FROM keyword_feedback WHERE keyword = ?').run(keyword)
    db.prepare('DELETE FROM keyword_profile WHERE keyword = ?').run(keyword)
    db.exec('RELEASE sp_keyword_delete')
  } catch (error) {
    db.exec('ROLLBACK TO sp_keyword_delete')
    db.exec('RELEASE sp_keyword_delete')
    throw error
  }
  return listKeywordProfile(db, new Date(), 200)
}

/** 只给实际出现在该封邮件中的关键词加分；单封上限 ±12，避免频繁词压住截止时间。 */
export function keywordBoosts(db: DatabaseSync, emailIds: number[], now = new Date()): Map<number, { score: number; matches: string[] }> {
  const result = new Map<number, { score: number; matches: string[] }>()
  const ids = [...new Set(emailIds.filter(Number.isSafeInteger))]
  if (!ids.length) return result
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const rows = db
      .prepare(`SELECT ek.email_id, kp.* FROM email_keyword ek JOIN keyword_profile kp ON kp.keyword = ek.keyword WHERE ek.email_id IN (${batch.map(() => '?').join(',')})`)
      .all(...batch) as unknown as Array<KeywordRow & { email_id: number }>
    for (const row of rows) {
      const weight = effectiveKeywordWeight(row, now)
      const entry = result.get(row.email_id) ?? { score: 0, matches: [] }
      entry.score += weight * 4
      if (Math.abs(weight) >= 0.1 && entry.matches.length < 5) entry.matches.push(`${row.keyword}(${weight > 0 ? '+' : ''}${weight.toFixed(2)})`)
      result.set(row.email_id, entry)
    }
  }
  for (const entry of result.values()) entry.score = Math.round(Math.max(-12, Math.min(12, entry.score)) * 10) / 10
  return result
}
