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
  BenchProspectInfo,
  BenchProspectStatus,
  BenchSchoolInfo,
  BenchSourceCategory,
  BenchSourceInfo,
  BenchSuspiciousSource,
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

/**
 * 改一个公众号的学校归属。
 *
 * 传空字符串表示「还是不知道是哪所」，不是删除——把人认出来的号当成垃圾删掉，
 * 比留着一条归不了的记录糟得多。
 */
export function setSourceSchool(db: DatabaseSync, id: number, school: string): boolean {
  const name = school.trim()
  const before = db.prepare('SELECT school FROM bench_source WHERE id = ?').get(id) as
    | { school: string }
    | undefined
  if (!before) return false
  db.prepare('UPDATE bench_source SET school = ? WHERE id = ?').run(name, id)
  return before.school !== name
}

/**
 * 把一篇判为「不是活动」：删掉抽取结果，保留原文。
 *
 * 只删 bench_activity 这一行就够——简报、对比、统计都从那张表出发。
 * 文章本身留着（status 仍是 parsed），用户随时能点开看原文，也能重新抽。
 */
export function markNotActivity(db: DatabaseSync, articleId: number): boolean {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM bench_activity WHERE article_id = ?').run(articleId)
    const info = db.prepare('UPDATE bench_article SET is_activity = 0 WHERE id = ?').run(articleId)
    db.exec('COMMIT')
    return Number(info.changes) > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 找出不属于任何已知学校的源。
 *
 * 判定只看一件事：这个号被归到哪个学校。学校空着（搜索时看不出归属），
 * 或者被归到清单以外（早期没加引号的搜索把「北京科技大学学生会」的稿子
 * 也带了进来），两种都算。是否真的该删由人决定——「青春SUES」这种名字里
 * 没有校名的号是正牌学生会，机器判不出来。
 */
export function auditSources(db: DatabaseSync, allowedSchools: string[]): BenchSuspiciousSource[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.school,
              (SELECT COUNT(*) FROM bench_article a WHERE a.source_id = s.id) AS article_count,
              (SELECT a.title FROM bench_article a
                WHERE a.source_id = s.id AND a.title <> ''
                ORDER BY a.published_at DESC, a.id DESC LIMIT 1) AS sample
         FROM bench_source s`
    )
    .all() as unknown as {
    id: number
    name: string
    school: string
    article_count: number
    sample: string | null
  }[]
  const allowed = new Set(allowedSchools)
  return rows
    .filter((r) => r.article_count > 0 && (!r.school || !allowed.has(r.school)))
    .map((r) => ({
      id: r.id,
      name: r.name,
      school: r.school ?? '',
      articleCount: r.article_count,
      sample: r.sample ?? ''
    }))
    .sort((a, b) => b.articleCount - a.articleCount || a.name.localeCompare(b.name))
}

/**
 * 删掉这些源，连同它们名下的文章与活动。
 *
 * 活动表虽然有 ON DELETE CASCADE，但那是靠 foreign_keys pragma 生效的，
 * 而 pragma 是连接级设置、每次打开都要重设——不能拿它当保障，显式删一遍。
 */
export function purgeSources(
  db: DatabaseSync,
  ids: number[]
): { articles: number; sources: number } {
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0)
  if (!clean.length) return { articles: 0, sources: 0 }
  const marks = clean.map(() => '?').join(',')
  db.exec('BEGIN')
  try {
    db.prepare(
      `DELETE FROM bench_activity
        WHERE article_id IN (SELECT id FROM bench_article WHERE source_id IN (${marks}))`
    ).run(...clean)
    const articles = Number(
      db.prepare(`DELETE FROM bench_article WHERE source_id IN (${marks})`).run(...clean).changes
    )
    const sources = Number(
      db.prepare(`DELETE FROM bench_source WHERE id IN (${marks})`).run(...clean).changes
    )
    db.exec('COMMIT')
    return { articles, sources }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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
  is_home: number
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
         COALESCE(sch.is_home, 0) AS is_home,
         a.fetched_at, a.error
    FROM bench_article a
    LEFT JOIN bench_source s ON s.id = a.source_id
    LEFT JOIN bench_activity act ON act.article_id = a.id
    LEFT JOIN bench_school sch ON sch.name = s.school`

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
    isHome: r.is_home === 1,
    fetchedAt: r.fetched_at,
    error: r.error
  }
}

/** 入队；返回 true 表示新入队，false 表示已在库里 */
export function enqueueArticle(
  db: DatabaseSync,
  input: { urlKey: string; url: string; sourceId: number | null; hintSchool?: string }
): boolean {
  const info = db
    .prepare(
      `INSERT INTO bench_article (source_id, url_key, url, hint_school)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(url_key) DO NOTHING`
    )
    .run(input.sourceId, input.urlKey, input.url, input.hintSchool ?? '')
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
): { id: number; url: string; hintSchool: string }[] {
  const rows = db
    .prepare(
      "SELECT id, url, COALESCE(hint_school, '') AS hint_school FROM bench_article WHERE status = 'new' ORDER BY id LIMIT ?"
    )
    .all(limit) as unknown as { id: number; url: string; hint_school: string }[]
  return rows.map((r) => ({ id: r.id, url: r.url, hintSchool: r.hint_school }))
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
export function ensureSourceByName(
  db: DatabaseSync,
  name: string,
  /** 按学校发现时留下的线索：猜不出学校时用它兜底，总比留空强 */
  hintSchool = ''
): number | null {
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
    .run(clean, guessSchool(clean) || schoolOfKnownAccount(db, clean) || hintSchool)
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
  coOrganizer: string
  duration: string
  scale: string
  promoChannels: string[]
  agenda: string[]
  highlights: string[]
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
        join_method, co_organizer, duration, scale, promo_channels, agenda, highlights,
        is_second_notice, notice_kind, migration_fit, migration_note, confidence, model, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       kind = excluded.kind, organizer = excluded.organizer,
       start_at = excluded.start_at, end_at = excluded.end_at, week_no = excluded.week_no,
       location = excluded.location, audience = excluded.audience,
       org_form = excluded.org_form, join_method = excluded.join_method,
       co_organizer = excluded.co_organizer, duration = excluded.duration,
       scale = excluded.scale,
       promo_channels = excluded.promo_channels, agenda = excluded.agenda,
       highlights = excluded.highlights,
       is_second_notice = excluded.is_second_notice, notice_kind = excluded.notice_kind,
       migration_fit = excluded.migration_fit, migration_note = excluded.migration_note,
       confidence = excluded.confidence, model = excluded.model,
       extracted_at = excluded.extracted_at`
  ).run(
    articleId,
    input.kind ?? '',
    input.organizer ?? '',
    input.startAt ?? null,
    input.endAt ?? null,
    input.weekNo ?? null,
    input.location ?? '',
    input.audience ?? '',
    input.orgForm ?? '',
    input.joinMethod ?? '',
    // 新加的字段一律兜底：调用方少传一个，node:sqlite 会把 undefined 当类型错误抛出来，
    // 整个抽取流程就断在这一篇上。缺字段应该写成空，不该让一篇坏掉一整批。
    input.coOrganizer ?? '',
    input.duration ?? '',
    input.scale ?? '',
    JSON.stringify(input.promoChannels ?? []),
    JSON.stringify(input.agenda ?? []),
    JSON.stringify(input.highlights ?? []),
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
              join_method, co_organizer, duration, scale, promo_channels, agenda, highlights,
              is_second_notice, notice_kind,
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
    coOrganizer: String(row.co_organizer ?? ''),
    duration: String(row.duration ?? ''),
    scale: String(row.scale ?? ''),
    promoChannels: parseJsonArray(row.promo_channels),
    agenda: parseJsonArray(row.agenda),
    highlights: parseJsonArray(row.highlights),
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
    // 队列里还剩多少：按钮上直接写出来，省得点下去才知道有没有东西可采
    pending: one("SELECT COUNT(*) AS n FROM bench_article WHERE status = 'new'"),
    unparsed: one("SELECT COUNT(*) AS n FROM bench_article WHERE status = 'fetched'"),
    unreachable: one("SELECT COUNT(*) AS n FROM bench_article WHERE status = 'unreachable'"),
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
              act.co_organizer, act.duration, act.scale,
              act.agenda, act.highlights, act.promo_channels,
              act.migration_fit, act.migration_note, act.confidence,
              COALESCE(sch.is_home, 0) AS is_home
         FROM bench_article a
         JOIN bench_source s ON s.id = a.source_id
         JOIN bench_activity act ON act.article_id = a.id
         LEFT JOIN bench_school sch ON sch.name = s.school
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
    coOrganizer: String(r.co_organizer ?? ''),
    duration: String(r.duration ?? ''),
    scale: String(r.scale ?? ''),
    agenda: parseJsonArray(r.agenda),
    highlights: parseJsonArray(r.highlights),
    promoChannels: parseJsonArray(r.promo_channels),
    migrationFit: String(r.migration_fit ?? '') as BenchMigrationFit,
    migrationNote: String(r.migration_note ?? ''),
    isHome: Number(r.is_home) === 1,
    confidence: Number(r.confidence ?? 0)
  }))
}

// ---------------- 学校与候选账号（v31） ----------------

interface SchoolRow {
  id: number
  name: string
  short_name: string
  known_accounts: string
  is_home: number
  enabled: number
  source_count: number
  article_count: number
  activity_count: number
}

/**
 * 把内置名单写进表，缺哪所补哪所。
 *
 * 用 INSERT ... ON CONFLICT DO NOTHING 而不是 REPLACE：用户可能改过本校、
 * 关掉了某几所，升级时不该把他改的东西盖回去。新版本新增的学校才插进去。
 */
export function seedSchools(
  db: DatabaseSync,
  schools: { name: string; shortName: string; aliases: string[] }[],
  homeName: string,
  /** 已查证的公众号名，按校名索引。查证过的不再用套路去猜 */
  known: Record<string, string[]> = {}
): number {
  const insert = db.prepare(
    `INSERT INTO bench_school (name, short_name, aliases, is_home, sort_order, known_accounts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO NOTHING`
  )
  // 只在「还没有记录」时补已知账号：用户删掉过的号不该被升级又塞回来
  const fillKnown = db.prepare(
    `UPDATE bench_school SET known_accounts = ?
      WHERE name = ? AND (known_accounts = '[]' OR known_accounts = '')`
  )
  let added = 0
  for (const [index, s] of schools.entries()) {
    const accounts = known[s.name] ?? []
    const info = insert.run(
      s.name,
      s.shortName,
      JSON.stringify(s.aliases),
      s.name === homeName ? 1 : 0,
      index,
      JSON.stringify(accounts)
    )
    added += Number(info.changes)
    if (accounts.length) fillKnown.run(JSON.stringify(accounts), s.name)
  }
  // 老库里可能一所本校都没有（首次升级），补一个默认本校，界面才有基准行
  const home = db.prepare('SELECT COUNT(*) AS n FROM bench_school WHERE is_home = 1').get() as {
    n: number
  }
  if (home.n === 0) {
    db.prepare('UPDATE bench_school SET is_home = 1 WHERE name = ?').run(homeName)
  }
  return added
}

export function listSchoolInfos(
  db: DatabaseSync,
  candidatesOf: (name: string, known: string[]) => string[]
): BenchSchoolInfo[] {
  const rows = db
    .prepare(
      `SELECT sch.id, sch.name, sch.short_name, COALESCE(sch.known_accounts, '[]') AS known_accounts,
              sch.is_home, sch.enabled,
              (SELECT COUNT(*) FROM bench_source s WHERE s.school = sch.name) AS source_count,
              (SELECT COUNT(*) FROM bench_article a JOIN bench_source s2 ON s2.id = a.source_id
                WHERE s2.school = sch.name) AS article_count,
              (SELECT COUNT(*) FROM bench_activity act
                 JOIN bench_article a2 ON a2.id = act.article_id
                 JOIN bench_source s3 ON s3.id = a2.source_id
                WHERE s3.school = sch.name) AS activity_count
         FROM bench_school sch
        ORDER BY sch.is_home DESC, sch.sort_order, sch.id`
    )
    .all() as unknown as SchoolRow[]
  return rows.map((r) => {
    const known = parseJsonArray(r.known_accounts)
    return {
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      isHome: r.is_home === 1,
      enabled: r.enabled === 1,
      articleCount: r.article_count,
      activityCount: r.activity_count,
      sourceCount: r.source_count,
      candidates: candidatesOf(r.name, known),
      knownAccounts: known
    }
  })
}

/**
 * 反查：这个公众号是不是哪所学校的已知账号。
 *
 * 「书院的天空」「团聚上大」「社彩同济」这类花名里根本没有校名，
 * 光看名字永远猜不出归属。但只要这个号被记进过某校的已知清单，
 * 归属就是确定的，比任何猜测都可靠。
 */
export function schoolOfKnownAccount(db: DatabaseSync, accountName: string): string {
  const clean = accountName.trim()
  if (!clean) return ''
  const rows = db
    .prepare("SELECT name, COALESCE(known_accounts, '[]') AS known FROM bench_school")
    .all() as unknown as { name: string; known: string }[]
  for (const row of rows) {
    if (parseJsonArray(row.known).includes(clean)) return row.name
  }
  return ''
}

/** 某所学校已查证的公众号名 */
export function knownAccountsOf(db: DatabaseSync, name: string): string[] {
  const row = db
    .prepare("SELECT COALESCE(known_accounts, '[]') AS known FROM bench_school WHERE name = ?")
    .get(name) as { known: string } | undefined
  return parseJsonArray(row?.known)
}

/** 把一个号记为该学校「查证存在」的号，下次直接用它，不再搜名字 */
export function rememberAccount(db: DatabaseSync, school: string, accountName: string): void {
  const current = knownAccountsOf(db, school)
  const clean = accountName.trim()
  if (!clean || current.includes(clean)) return
  db.prepare('UPDATE bench_school SET known_accounts = ? WHERE name = ?').run(
    JSON.stringify([...current, clean]),
    school
  )
}

export function setSchoolEnabled(db: DatabaseSync, name: string, enabled: boolean): void {
  db.prepare('UPDATE bench_school SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name)
}

/** 本校只能有一个：先全部清零再置一，避免出现两个基准行 */
export function setHomeSchool(db: DatabaseSync, name: string): void {
  db.prepare('UPDATE bench_school SET is_home = 0').run()
  db.prepare('UPDATE bench_school SET is_home = 1 WHERE name = ?').run(name)
}

export function homeSchoolName(db: DatabaseSync): string {
  const row = db.prepare('SELECT name FROM bench_school WHERE is_home = 1 LIMIT 1').get() as
    | { name: string }
    | undefined
  return row?.name ?? ''
}

/** 候选账号入库；已存在的不动，保留上次试过的结果 */
export function upsertProspects(
  db: DatabaseSync,
  school: string,
  accounts: { name: string; category: BenchSourceCategory }[]
): void {
  const stmt = db.prepare(
    `INSERT INTO bench_prospect (school, account_name, category)
     VALUES (?, ?, ?)
     ON CONFLICT(school, account_name) DO NOTHING`
  )
  for (const a of accounts) stmt.run(school, a.name, a.category)
}

interface ProspectRow {
  id: number
  school: string
  account_name: string
  category: string
  status: string
  hit_count: number
  last_tried_at: string | null
  note: string
}

export function listProspects(db: DatabaseSync, school?: string): BenchProspectInfo[] {
  const rows = (
    school
      ? db
          .prepare(
            `SELECT * FROM bench_prospect WHERE school = ?
              ORDER BY status = 'found' DESC, hit_count DESC, id`
          )
          .all(school)
      : db
          .prepare(
            `SELECT * FROM bench_prospect
              ORDER BY school, status = 'found' DESC, hit_count DESC, id`
          )
          .all()
  ) as unknown as ProspectRow[]
  return rows.map((r) => ({
    id: r.id,
    school: r.school,
    accountName: r.account_name,
    category: r.category as BenchSourceCategory,
    status: r.status as BenchProspectStatus,
    hitCount: r.hit_count,
    lastTriedAt: r.last_tried_at,
    note: r.note
  }))
}

export function markProspect(
  db: DatabaseSync,
  school: string,
  accountName: string,
  input: { status: BenchProspectStatus; hitCount: number; note?: string }
): void {
  db.prepare(
    `UPDATE bench_prospect
        SET status = ?, hit_count = ?, last_tried_at = ?, note = ?
      WHERE school = ? AND account_name = ?`
  ).run(
    input.status,
    input.hitCount,
    nowLocal(),
    (input.note ?? '').slice(0, 200),
    school,
    accountName
  )
}

/**
 * 本校同类活动。
 *
 * 举出一个外校活动的做法之后，人紧接着会问「那我们呢」，这一条就是回答。
 * 只按类型匹配，不按时间：本校一年可能只办一次，卡时间窗口就永远配不上。
 */
export function homePeerArticleIds(db: DatabaseSync, articleId: number, limit = 3): number[] {
  const rows = db
    .prepare(
      `SELECT a.id
         FROM bench_article a
         JOIN bench_source s ON s.id = a.source_id
         JOIN bench_school sch ON sch.name = s.school AND sch.is_home = 1
         JOIN bench_activity act ON act.article_id = a.id
        WHERE a.id <> ?
          AND act.kind <> ''
          AND act.kind = (SELECT kind FROM bench_activity WHERE article_id = ?)
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT ?`
    )
    .all(articleId, articleId, limit) as unknown as { id: number }[]
  return rows.map((r) => r.id)
}
