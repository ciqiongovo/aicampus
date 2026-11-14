/**
 * 跨校对标库 DAO。所有 SQL 集中在这里，service 层只做编排。
 *
 * 表结构由 src/main/db/benchmarkSchema.ts（迁移 v30）创建。
 *
 * 几个刻意的选择：
 * - 入队用 INSERT ... ON CONFLICT(url_key) DO NOTHING，靠唯一键去重，
 *   返回 changes=0 就说明这篇已经在库里，不必先查再插（并发下也安全）。
 * - 状态推进只允许前进，不做回退：parsed 的文章重抽写的是 bench_activity，
 *   不把 status 打回 fetched，否则列表会突然空掉一片。
 * - 正文 body 单独查，列表查询不带它，避免一次拉几十万字进内存。
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  BenchActivityInfo,
  BenchArticleFilter,
  BenchArticleInfo,
  BenchArticleStatus,
  BenchBriefItem,
  BenchMigrationFit,
  BenchNoticeKind,
  BenchSourceCategory,
  BenchSourceInfo,
  BenchStats
} from '../../../shared/benchmark'
import { guessSchool } from '../../../shared/benchmark'
import { nowLocal } from '../../../shared/imTime'

// ---------------- 源 ----------------

interface SourceRow {
  id: number
  gh_id: string
  name: string
  school: string
  category: string
  enabled: number
  article_count: number
  last_article_at: string | null
}

export function listSources(db: DatabaseSync): BenchSourceInfo[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.gh_id, s.name, s.school, s.category, s.enabled,
              (SELECT COUNT(*) FROM bench_article a WHERE a.source_id = s.id) AS article_count,
              (SELECT MAX(a.published_at) FROM bench_article a WHERE a.source_id = s.id) AS last_article_at
         FROM bench_source s
        ORDER BY s.school, s.name`
    )
    .all() as unknown as SourceRow[]
  return rows.map((r) => ({
    id: r.id,
    ghId: r.gh_id,
    name: r.name,
    school: r.school,
    category: r.category as BenchSourceCategory,
    enabled: r.enabled === 1,
    articleCount: r.article_count,
    lastArticleAt: r.last_article_at
  }))
}

/** 同名同校的源只保留一条；重复添加视为「更新」，不报错 */
export function upsertSource(
  db: DatabaseSync,
  input: { ghId?: string; name: string; school: string; category: BenchSourceCategory }
): number {
  const existing = db
    .prepare('SELECT id, gh_id FROM bench_source WHERE name = ? AND school = ?')
    .get(input.name, input.school) as { id: number; gh_id: string } | undefined
  if (existing) {
    // 后补到的 gh_id 不要覆盖已有的非空值：gh_id 一旦填错，整条源的采集都会串
    if (input.ghId && !existing.gh_id) {
      db.prepare('UPDATE bench_source SET gh_id = ? WHERE id = ?').run(input.ghId, existing.id)
    }
    return existing.id
  }
  const info = db
    .prepare('INSERT INTO bench_source (gh_id, name, school, category) VALUES (?, ?, ?, ?)')
    .run(input.ghId ?? '', input.name, input.school, input.category)
  return Number(info.lastInsertRowid)
}

export function setSourceEnabled(db: DatabaseSync, id: number, enabled: boolean): void {
  db.prepare('UPDATE bench_source SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

/** 删源不删文章：历史推文仍有对标价值，只是不再采新的 */
export function removeSource(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM bench_source WHERE id = ?').run(id)
}

// ---------------- 文章 ----------------

interface ArticleRow {
  id: number
  source_id: number | null
  school: string
  source_name: string
  title: string
  url: string
  published_at: string | null
  status: string
  is_activity: number | null
  kind: string
  week_no: number | null
  is_second_notice: number
  notice_kind: string
  migration_fit: string
  fetched_at: string | null
  error: string
}

const ARTICLE_SELECT = `
  SELECT a.id, a.source_id, COALESCE(s.school, '') AS school, COALESCE(s.name, '') AS source_name,
         a.title, a.url, a.published_at, a.status, a.is_activity,
         COALESCE(act.kind, '') AS kind,
         act.week_no,
         COALESCE(act.is_second_notice, 0) AS is_second_notice,
         COALESCE(act.notice_kind, '') AS notice_kind,
         COALESCE(act.migration_fit, '') AS migration_fit,
         a.fetched_at, a.error
    FROM bench_article a
    LEFT JOIN bench_source s ON s.id = a.source_id
    LEFT JOIN bench_activity act ON act.article_id = a.id`

function toArticleInfo(r: ArticleRow): BenchArticleInfo {
  return {
    id: r.id,
    sourceId: r.source_id,
    school: r.school,
    sourceName: r.source_name,
    title: r.title,
    url: r.url,
    publishedAt: r.published_at,
    status: r.status as BenchArticleStatus,
    isActivity: r.is_activity === null ? null : r.is_activity === 1,
    kind: r.kind,
    weekNo: r.week_no,
    isSecondNotice: r.is_second_notice === 1,
    noticeKind: r.notice_kind as BenchNoticeKind,
    migrationFit: r.migration_fit as BenchMigrationFit,
    fetchedAt: r.fetched_at,
    error: r.error
  }
}

/** 入队；返回 true 表示新入队，false 表示已在库里 */
export function enqueueArticle(
  db: DatabaseSync,
  input: { urlKey: string; url: string; sourceId: number | null }
): boolean {
  const info = db
    .prepare(
      `INSERT INTO bench_article (source_id, url_key, url)
       VALUES (?, ?, ?)
       ON CONFLICT(url_key) DO NOTHING`
    )
    .run(input.sourceId, input.urlKey, input.url)
  return info.changes > 0
}

export function listArticles(db: DatabaseSync, filter: BenchArticleFilter): BenchArticleInfo[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (filter.school) {
    where.push('s.school = ?')
    args.push(filter.school)
  }
  if (filter.kind) {
    where.push('act.kind = ?')
    args.push(filter.kind)
  }
  if (filter.from) {
    where.push('substr(a.published_at, 1, 10) >= ?')
    args.push(filter.from)
  }
  if (filter.to) {
    where.push('substr(a.published_at, 1, 10) <= ?')
    args.push(filter.to)
  }
  if (filter.secondNoticeOnly) {
    where.push('act.is_second_notice = 1')
  }
  if (filter.keyword) {
    where.push('a.title LIKE ?')
    args.push(`%${filter.keyword}%`)
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const sql =
    ARTICLE_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY a.published_at IS NULL, a.published_at DESC, a.id DESC LIMIT ? OFFSET ?'
  const rows = db.prepare(sql).all(...args, limit, offset) as unknown as ArticleRow[]
  return rows.map(toArticleInfo)
}

export function getArticle(
  db: DatabaseSync,
  id: number
): (BenchArticleInfo & { body: string }) | null {
  const row = db.prepare(ARTICLE_SELECT + ' WHERE a.id = ?').get(id) as ArticleRow | undefined
  if (!row) return null
  const body = db.prepare('SELECT body FROM bench_article WHERE id = ?').get(id) as
    | { body: string | null }
    | undefined
  return { ...toArticleInfo(row), body: body?.body ?? '' }
}

/**
 * 把握手失败的文章放回队列。
 *
 * unreachable 是「这次没拿到」，不是终态：风控会解、网络会好、页面会恢复。
 * 但也不能无限重试——那等于每次采集都拿同一批死链去撞墙。所以只放回
 * 最近一次失败在 holdMs 之内的，更早的说明反复试过还是不行，留着记录即可。
 */
export function resetUnreachable(db: DatabaseSync, holdMs = 30 * 60 * 1000): number {
  // 必须用本地时间格式化：fetched_at 存的是 nowLocal()，拿 toISOString()（UTC）
  // 去比会差 8 小时，条件永远不成立，一条也放不回来。
  const d = new Date(Date.now() - holdMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  const cutoff = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const info = db
    .prepare(
      `UPDATE bench_article SET status = 'new', error = ''
        WHERE status = 'unreachable' AND (fetched_at IS NULL OR fetched_at <= ?)`
    )
    .run(cutoff)
  return Number(info.changes)
}

/** 待抓取的队列：只要 new 状态的，按入队先后顺序，先来先抓 */
export function pendingArticles(
  db: DatabaseSync,
  limit: number
): { id: number; url: string }[] {
  return db
    .prepare("SELECT id, url FROM bench_article WHERE status = 'new' ORDER BY id LIMIT ?")
    .all(limit) as { id: number; url: string }[]
}

export function markFetched(
  db: DatabaseSync,
  id: number,
  input: { title: string; author: string; publishedAt: string | null; body: string; sourceId?: number }
): void {
  db.prepare(
    `UPDATE bench_article
        SET title = ?, author = ?, published_at = COALESCE(?, published_at),
            body = ?, status = 'fetched', fetched_at = ?, error = '',
            source_id = COALESCE(?, source_id)
      WHERE id = ?`
  ).run(
    input.title,
    input.author,
    input.publishedAt,
    input.body,
    nowLocal(),
    input.sourceId ?? null,
    id
  )
}

/**
 * 按公众号名找源，没有就建一条。
 *
 * 用途：链接是手动导入的，入队时还不知道它属于哪个号；抓完正文拿到 og:article:author，
 * 才第一次知道这是谁的推文。这时顺手把源补上，用户只需要回来填「学校」一格，
 * 不用先把二十个号的名字手工敲一遍。
 */
export function ensureSourceByName(db: DatabaseSync, name: string): number | null {
  const clean = name.trim()
  if (!clean) return null
  const existing = db.prepare('SELECT id FROM bench_source WHERE name = ? LIMIT 1').get(clean) as
    | { id: number }
    | undefined
  if (existing) return existing.id
  // 顺手把学校猜出来：公众号名多半是「学校名+组织后缀」，猜不中留空让用户改，
  // 但一条都不猜的话，采完二十个号要手填二十次学校
  const info = db
    .prepare("INSERT INTO bench_source (name, school, category) VALUES (?, ?, 'student_union')")
    .run(clean, guessSchool(clean))
  return Number(info.lastInsertRowid)
}

/**
 * 抓取失败落状态。
 *
 * deleted 与 unreachable 必须分开：前者是原文没了（分母要剔除），
 * 后者是这次没拿到（下次还要重试）。混成一个状态会让成功率长期停在五成，
 * 也会让重试逻辑把已删除的文章反复抓一遍。
 */
export function markFetchFailed(
  db: DatabaseSync,
  id: number,
  status: 'deleted' | 'unreachable',
  error: string
): void {
  db.prepare('UPDATE bench_article SET status = ?, fetched_at = ?, error = ? WHERE id = ?').run(
    status,
    nowLocal(),
    error.slice(0, 500),
    id
  )
}

export function pendingExtract(
  db: DatabaseSync,
  limit: number
): { id: number; title: string; body: string; publishedAt: string | null }[] {
  const rows = db
    .prepare(
      `SELECT id, title, COALESCE(body, '') AS body, published_at
         FROM bench_article
        WHERE status = 'fetched'
          -- 纯图推送已经归档过了：正文只有署名，抽出来只会是「类型对、其他全空」的假记录，
          -- 混在库里比空着更糟——看上去像有数据，实际什么也没告诉你
          AND COALESCE(error, '') NOT LIKE '%正文为图片%'
        ORDER BY id LIMIT ?`
    )
    .all(limit) as unknown as { id: number; title: string; body: string; published_at: string | null }[]
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, publishedAt: r.published_at }))
}

/**
 * 判定为非活动（或纯图推送）：状态推到 parsed，但不写 bench_activity。
 *
 * note 会存进 error 字段当备注用：这类文章不是失败，但用户点进去该知道
 * 为什么没有字段，而不是对着一片空白猜是不是没跑成功。
 */
export function markSkipped(db: DatabaseSync, id: number, note = ''): void {
  db.prepare("UPDATE bench_article SET status = 'parsed', is_activity = 0, error = ? WHERE id = ?").run(
    note.slice(0, 500),
    id
  )
}

export function markExtractFailed(db: DatabaseSync, id: number, error: string): void {
  // 停在 fetched：下次重试还能捞回来
  db.prepare('UPDATE bench_article SET error = ? WHERE id = ?').run(error.slice(0, 500), id)
}

export interface ActivityInput {
  kind: string
  organizer: string
  startAt: string | null
  endAt: string | null
  weekNo: number | null
  location: string
  audience: string
  orgForm: string
  joinMethod: string
  promoChannels: string[]
  agenda: string[]
  isSecondNotice: boolean
  noticeKind: BenchNoticeKind
  migrationFit: BenchMigrationFit
  migrationNote: string
  confidence: number
  model: string
}

/** 抽好的活动字段落库；同一篇重抽直接覆盖 */
export function upsertActivity(db: DatabaseSync, articleId: number, input: ActivityInput): void {
  db.prepare(
    `INSERT INTO bench_activity
       (article_id, kind, organizer, start_at, end_at, week_no, location, audience, org_form,
        join_method, promo_channels, agenda, is_second_notice, notice_kind,
        migration_fit, migration_note, confidence, model, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       kind = excluded.kind, organizer = excluded.organizer,
       start_at = excluded.start_at, end_at = excluded.end_at, week_no = excluded.week_no,
       location = excluded.location, audience = excluded.audience,
       org_form = excluded.org_form, join_method = excluded.join_method,
       promo_channels = excluded.promo_channels, agenda = excluded.agenda,
       is_second_notice = excluded.is_second_notice, notice_kind = excluded.notice_kind,
       migration_fit = excluded.migration_fit, migration_note = excluded.migration_note,
       confidence = excluded.confidence, model = excluded.model,
       extracted_at = excluded.extracted_at`
  ).run(
    articleId,
    input.kind,
    input.organizer,
    input.startAt,
    input.endAt,
    input.weekNo,
    input.location,
    input.audience,
    input.orgForm,
    input.joinMethod,
    JSON.stringify(input.promoChannels),
    JSON.stringify(input.agenda),
    input.isSecondNotice ? 1 : 0,
    input.noticeKind,
    input.migrationFit,
    input.migrationNote,
    input.confidence,
    input.model,
    nowLocal()
  )
  db.prepare("UPDATE bench_article SET status = 'parsed', is_activity = 1, error = '' WHERE id = ?").run(
    articleId
  )
}

/** 单篇的抽取结果；没有就返回 null（还没抽，或判定为非活动） */
export function getActivity(db: DatabaseSync, articleId: number): BenchActivityInfo | null {
  const row = db
    .prepare(
      `SELECT article_id, kind, organizer, start_at, end_at, week_no, location, audience, org_form,
              join_method, promo_channels, agenda, is_second_notice, notice_kind,
              migration_fit, migration_note, confidence, model, extracted_at
         FROM bench_activity WHERE article_id = ?`
    )
    .get(articleId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    articleId,
    kind: String(row.kind ?? ''),
    organizer: String(row.organizer ?? ''),
    startAt: (row.start_at as string | null) ?? null,
    endAt: (row.end_at as string | null) ?? null,
    weekNo: row.week_no === null || row.week_no === undefined ? null : Number(row.week_no),
    location: String(row.location ?? ''),
    audience: String(row.audience ?? ''),
    orgForm: String(row.org_form ?? ''),
    joinMethod: String(row.join_method ?? ''),
    promoChannels: parseJsonArray(row.promo_channels),
    agenda: parseJsonArray(row.agenda),
    isSecondNotice: Number(row.is_second_notice) === 1,
    noticeKind: String(row.notice_kind ?? '') as BenchNoticeKind,
    migrationFit: String(row.migration_fit ?? '') as BenchMigrationFit,
    migrationNote: String(row.migration_note ?? ''),
    confidence: Number(row.confidence ?? 0),
    model: String(row.model ?? ''),
    extractedAt: (row.extracted_at as string | null) ?? null
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function stats(db: DatabaseSync): BenchStats {
  const one = (sql: string): number =>
    ((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0) as number
  const last = db.prepare('SELECT MAX(fetched_at) AS t FROM bench_article').get() as
    | { t: string | null }
    | undefined
  return {
    sources: one('SELECT COUNT(*) AS n FROM bench_source'),
    articles: one('SELECT COUNT(*) AS n FROM bench_article'),
    activities: one('SELECT COUNT(*) AS n FROM bench_activity'),
    deleted: one("SELECT COUNT(*) AS n FROM bench_article WHERE status = 'deleted'"),
    lastFetchAt: last?.t ?? null
  }
}

/** 库里出现过的活动类型，供「灵活调整标准」那一栏使用 */
export function listKinds(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT DISTINCT kind FROM bench_activity WHERE kind <> '' ORDER BY kind")
    .all() as unknown as { kind: string }[]
  return rows.map((r) => r.kind)
}

/** 库里出现过的学校，供筛选项使用 */
export function listSchools(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT school FROM bench_source WHERE school <> '' ORDER BY school`
    )
    .all() as { school: string }[]
  return rows.map((r) => r.school)
}

/**
 * 简报用的记录集。
 *
 * 与列表查询的区别：这里必然带 activity（只取已抽出活动的），且一次拿全
 * 生成简报需要的字段，避免「列表拿到 100 条、再逐条查详情」那种 N+1。
 * 排序按学校、再按时间，因为简报是分学校念的。
 */
export function briefRows(db: DatabaseSync, filter: BenchArticleFilter): BenchBriefItem[] {
  const where: string[] = ["a.status = 'parsed'", 'act.article_id IS NOT NULL']
  const args: (string | number)[] = []
  if (filter.school) {
    where.push('s.school = ?')
    args.push(filter.school)
  }
  if (filter.kind) {
    where.push('act.kind = ?')
    args.push(filter.kind)
  }
  if (filter.from) {
    where.push('substr(a.published_at, 1, 10) >= ?')
    args.push(filter.from)
  }
  if (filter.to) {
    where.push('substr(a.published_at, 1, 10) <= ?')
    args.push(filter.to)
  }
  if (filter.keyword) {
    where.push('a.title LIKE ?')
    args.push(`%${filter.keyword}%`)
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500)
  const rows = db
    .prepare(
      `SELECT a.id, COALESCE(s.school, '') AS school, COALESCE(s.name, '') AS source_name,
              a.title, a.url, a.published_at,
              act.kind, act.week_no, act.start_at, act.location, act.org_form, act.audience,
              act.agenda, act.promo_channels, act.migration_fit, act.migration_note, act.confidence
         FROM bench_article a
         JOIN bench_source s ON s.id = a.source_id
         JOIN bench_activity act ON act.article_id = a.id
        WHERE ${where.join(' AND ')}
        ORDER BY school, a.published_at DESC, a.id DESC
        LIMIT ?`
    )
    .all(...args, limit) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: Number(r.id),
    school: String(r.school ?? ''),
    sourceName: String(r.source_name ?? ''),
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    publishedAt: (r.published_at as string | null) ?? null,
    kind: String(r.kind ?? ''),
    weekNo: r.week_no === null || r.week_no === undefined ? null : Number(r.week_no),
    startAt: (r.start_at as string | null) ?? null,
    location: String(r.location ?? ''),
    orgForm: String(r.org_form ?? ''),
    audience: String(r.audience ?? ''),
    agenda: parseJsonArray(r.agenda),
    promoChannels: parseJsonArray(r.promo_channels),
    migrationFit: String(r.migration_fit ?? '') as BenchMigrationFit,
    migrationNote: String(r.migration_note ?? ''),
    confidence: Number(r.confidence ?? 0)
  }))
}
