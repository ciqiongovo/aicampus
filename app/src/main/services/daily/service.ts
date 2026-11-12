import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { ANALYSIS_CATEGORIES } from '../../../shared/types'
import type { DailyOpResult, DailyReportItem, DailySourceConfig, DailyStatus } from '../../../shared/types'
import {
  classifyDailyTitle,
  dailyTopicLabel,
  DAILY_TOPICS,
  type DailyArticle,
  type DailyArticleContentQuery,
  type DailyArticleContentResult,
  type DailyArticleOpResult,
  type DailyArticleStatus,
  type DailyArticlesPage,
  type DailyArticlesQuery,
  type DailyBoard,
  type DailyBoardColumn,
  type DailyReportDetail,
  type DailyReportStatus,
  type DailyReportSummary,
  type DailyReportsQuery,
  type DailyReportsResult,
  type DailySearchQuery,
  type DailySearchResult,
  type DailySourceReport
} from '../../../shared/daily'
import { getSettingOr, setSetting } from '../../db/dao/settingsDao'
import { createItem } from '../../db/dao/itemsDao'
import type { SettingsStore } from '../../store/settings'

/** P4/P5 日报：三源直连 + 平台源注册表 + 8:00 定时/补生成 + 立即生成按钮 → 信息流（资料）。
 * P5 日报结构化：日报汇总(daily_report) + 独立资讯(daily_article) + 关联(daily_report_article)。
 * 无 electron 依赖，fetch 可注入，可直接单测。 */

export const DAILY_SOURCE_PRESETS: DailySourceConfig[] = [
  {
    id: 'bilibili',
    label: 'B站热搜',
    endpoint: 'https://api.bilibili.com/x/web-interface/search/square?limit=20',
    enabled: true,
    builtin: true
  },
  {
    id: 'douyin',
    label: '抖音热榜',
    endpoint: 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/',
    enabled: true,
    builtin: true
  },
  {
    id: 'baidu',
    label: '百度热搜',
    endpoint: 'https://top.baidu.com/api/board?platform=wise&tab=realtime',
    enabled: true,
    builtin: true
  }
]

export interface DailySourceItem {
  title: string
  score: number | null
  url: string | null
  /** 源真实提供的内容（可选）；不伪造新闻全文/AI 摘要 */
  content?: string
}

/** 反推荐候选条目（P5）：热榜条目 + 来源标签 */
export interface HotlistCandidate {
  title: string
  score: number | null
  url: string | null
  sourceLabel: string
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) InfoAgent/0.1'
const FETCH_TIMEOUT_MS = 15_000
const MAX_ITEMS_PER_SOURCE = 20
const FOCUS_SETTING_KEY = 'dailyFocusTopics'

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asUrl(v: unknown): string | null {
  const s = asString(v)
  if (!s) return null
  return /^https?:\/\//.test(s) ? s.slice(0, 500) : null
}

function pickContent(o: Record<string, unknown>): unknown {
  return o['content'] ?? o['summary'] ?? o['desc'] ?? o['abstract'] ?? o['excerpt'] ?? o['description']
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeItems(raw: { title: unknown; score?: unknown; url?: unknown; content?: unknown }[]): DailySourceItem[] {
  const out: DailySourceItem[] = []
  for (const it of raw) {
    const title = asString(it.title)
    if (!title) continue
    const content = asString(it.content)
    out.push({
      title: title.slice(0, 200),
      score: asNumber(it.score),
      url: asUrl(it.url),
      content: content ? content.slice(0, 10_000) : undefined
    })
  }
  return out
}

/**
 * 热榜响应解析（形状级联，兼容内置三源与自定义聚合端点）：
 * - B站：data.trending.list[] {show_name|keyword, heat_score}
 * - 抖音：word_list[] {word, hot_value}
 * - 百度：data.cards[0].content[0].content[] {word}（无热度值，按榜序）
 * - 自定义约定：{items:[{title,score?,url?,content?}]} 或 [{title,...}]，也兼容 {data:{list:[...]}}
 */
export function parseHotlist(payload: unknown): DailySourceItem[] {
  if (Array.isArray(payload)) {
    return normalizeItems(
      (payload as unknown[]).map((it) => {
        const o = asObj(it) ?? {}
        return { title: o['title'] ?? o['word'] ?? o['show_name'] ?? o['keyword'], score: o['score'] ?? o['hot_value'] ?? o['heat_score'], url: o['url'], content: pickContent(o) }
      })
    )
  }
  const obj = asObj(payload)
  if (!obj) return []
  const data = asObj(obj['data'])

  // B站：data.trending.list
  const trending = data ? asObj(data['trending']) : null
  if (trending && Array.isArray(trending['list'])) {
    return normalizeItems(
      (trending['list'] as unknown[]).map((it) => {
        const o = asObj(it) ?? {}
        return { title: o['show_name'] ?? o['keyword'], score: o['heat_score'], content: pickContent(o) }
      })
    )
  }
  // 抖音：word_list
  if (Array.isArray(obj['word_list'])) {
    return normalizeItems(
      (obj['word_list'] as unknown[]).map((it) => {
        const o = asObj(it) ?? {}
        return { title: o['word'], score: o['hot_value'], content: pickContent(o) }
      })
    )
  }
  // 百度：data.cards[] → content[0].content[]（或 content 本身即条目数组）
  if (data && Array.isArray(data['cards'])) {
    for (const cardRaw of data['cards'] as unknown[]) {
      const card = asObj(cardRaw)
      if (!card || !Array.isArray(card['content'])) continue
      const first = card['content'][0]
      if (asObj(first) && Array.isArray((asObj(first) as Record<string, unknown>)['content'])) {
        const items = (asObj(first) as Record<string, unknown>)['content'] as unknown[]
        return normalizeItems(items.map((it) => {
          const o = asObj(it) ?? {}
          return { title: o['word'] ?? o['title'], url: o['url'], content: pickContent(o) }
        }))
      }
      return normalizeItems((card['content'] as unknown[]).map((it) => {
        const o = asObj(it) ?? {}
        return { title: o['word'] ?? o['title'], score: o['score'] ?? o['hot_value'], url: o['url'], content: pickContent(o) }
      }))
    }
  }
  // 通用 data.list
  if (data && Array.isArray(data['list'])) {
    return normalizeItems((data['list'] as unknown[]).map((it) => {
      const o = asObj(it) ?? {}
      return { title: o['title'] ?? o['word'], score: o['score'] ?? o['hot_value'], url: o['url'], content: pickContent(o) }
    }))
  }
  // 自定义约定：{items:[...]}
  if (Array.isArray(obj['items'])) {
    return normalizeItems((obj['items'] as unknown[]).map((it) => {
      const o = asObj(it) ?? {}
      return { title: o['title'] ?? o['word'], score: o['score'] ?? o['hot_value'] ?? o['heat_score'], url: o['url'], content: pickContent(o) }
    }))
  }
  return []
}

/** 本地日期 YYYY-MM-DD（不用 toISOString，避免 UTC 跨日） */
export function todayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 下一次本地 8:00（已过则顺延一天） */
export function nextDailyRunAt(now: Date): Date {
  const next = new Date(now)
  next.setHours(8, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/** 启动补生成：现在已过 8:00 且今天还没有日报 */
export function shouldBootstrapGenerate(now: Date, todayReportExists: boolean): boolean {
  return now.getHours() >= 8 && !todayReportExists
}

/** 定时窗口：每天 08:00–08:01（60s 轮询容错） */
export function isInGenerateWindow(now: Date): boolean {
  return now.getHours() === 8 && (now.getMinutes() === 0 || now.getMinutes() === 1)
}

interface DailyReportRow {
  id: number
  date_key: string
  title: string
  intro: string
  status: string
  sources_json: string
  info_id: number | null
  generated_at: string | null
  created_at: string
}

interface DailyArticleRow {
  id: number
  dedup_key: string
  title: string
  content: string
  url: string | null
  source_id: string
  source_label: string
  score: number | null
  topic: string | null
  topic_matches_json: string
  category: string | null
  status: string
  user_acted: number
  item_id: number | null
  published_at: string | null
  first_seen_at: string | null
  created_at: string
}

function parseStringArray(json: string): string[] {
  try {
    const p: unknown = JSON.parse(json || '[]')
    if (!Array.isArray(p)) return []
    return p.filter((x): x is string => typeof x === 'string' && x !== '')
  } catch {
    return []
  }
}

function parseSourceReports(json: string): DailySourceReport[] {
  try {
    const p: unknown = JSON.parse(json || '[]')
    if (!Array.isArray(p)) return []
    const out: DailySourceReport[] = []
    for (const it of p) {
      if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>
        out.push({
          sourceId: typeof o.sourceId === 'string' ? o.sourceId : '',
          label: typeof o.label === 'string' ? o.label : '',
          count: typeof o.count === 'number' ? o.count : 0,
          error: typeof o.error === 'string' ? o.error : null
        })
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 时间戳序列化：已含时区/已是 ISO（含 'T' 或以 Z/±hh:mm 结尾）保留原语义；
 * 旧 SQLite naive 'YYYY-MM-DD HH:MM:SS'（本模块历史约定来自 datetime('now') = UTC）按 UTC 归一为 ISO。
 * 不做「本地时间盲加 Z」：本地语义旧值不在此处强行解释。
 */
function toIsoString(value: string | null | undefined): string | null {
  if (!value) return null
  const s = value.trim()
  if (!s) return null
  if (s.includes('T') || /Z$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const d = new Date(s.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const ARTICLE_STATUSES: readonly DailyArticleStatus[] = ['keep', 'archive', 'item', 'unverified']

function isArticleStatus(v: string): v is DailyArticleStatus {
  return (ARTICLE_STATUSES as readonly string[]).includes(v)
}

export class DailyService {
  private generating = false

  constructor(
    private db: DatabaseSync,
    private store: SettingsStore,
    private fetchFn: typeof globalThis.fetch = (...args) => fetch(...args),
    /** 时间源注入（测试用），默认取系统时钟 */
    private now: () => Date = () => new Date()
  ) {}

  /** 生效源列表：设置里保存过则整体覆盖，否则用内置默认；空数组=恢复默认，零启用可表达 */
  effectiveSources(): DailySourceConfig[] {
    const stored = this.store.peek().dailySources
    if (Array.isArray(stored) && stored.length > 0) return stored.map((s) => ({ ...s }))
    return DAILY_SOURCE_PRESETS.map((s) => ({ ...s }))
  }

  private todayTitle(d: Date = this.now()): string {
    return `${todayKey(d)} 每日热点日报`
  }

  private async fetchSource(source: DailySourceConfig): Promise<{ items: DailySourceItem[]; error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await this.fetchFn(source.endpoint, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
        signal: controller.signal
      })
      if (!res.ok) return { items: [], error: `HTTP ${res.status}` }
      let payload: unknown
      try {
        payload = JSON.parse(await res.text())
      } catch {
        return { items: [], error: '响应不是 JSON' }
      }
      const items = parseHotlist(payload).slice(0, MAX_ITEMS_PER_SOURCE)
      if (items.length === 0) return { items: [], error: '未解析出条目' }
      return { items }
    } catch (error) {
      const e = error as Error
      return { items: [], error: e?.name === 'AbortError' ? '请求超时' : e?.message ?? '请求失败' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** P5 反推荐候选：抓取全部启用源的热榜条目（每源限 limitPerSource 条），打上来源标签后合并 */
  async fetchEnabledItems(limitPerSource = 10): Promise<HotlistCandidate[]> {
    const sources = this.effectiveSources().filter((s) => s.enabled)
    if (sources.length === 0) return []
    const results = await Promise.all(sources.map((s) => this.fetchSource(s)))
    const out: HotlistCandidate[] = []
    for (const [i, r] of results.entries()) {
      if (!r.items.length) continue
      for (const it of r.items.slice(0, Math.max(1, limitPerSource))) {
        out.push({ title: it.title, score: it.score, url: it.url, sourceLabel: sources[i].label })
      }
    }
    return out.slice(0, 30)
  }

  /**
   * 反推荐候选（已落库快照，扁平列表，最多 limit 条）：counterRec 生成时优先调用，避免重复抓取。
   * 仅读当天已成功落库的 daily_article，保证与日报内容一致，无副作用。
   */
  snapshotCandidates(limit = 30): HotlistCandidate[] {
    const n = Math.min(Math.max(Math.floor(limit) || 1, 1), 100)
    const dateKey = todayKey(this.now())
    const rows = this.db
      .prepare(
        'SELECT a.title, a.score, a.url, a.source_label FROM daily_article a' +
          ' JOIN daily_report_article ra ON ra.article_id = a.id' +
          ' JOIN daily_report dr ON dr.id = ra.report_id' +
          ' WHERE dr.date_key = ? ORDER BY a.score DESC, a.id DESC LIMIT ?'
      )
      .all(dateKey, n) as { title: string; score: number | null; url: string | null; source_label: string }[]
    return rows.map((row) => ({ title: row.title, score: row.score, url: row.url, sourceLabel: row.source_label }))
  }

  /**
   * 反推荐候选（已落库快照，按来源限条）：读取今天已成功落库的资讯，避免 counterRec 重复抓取、保证与日报内容一致。
   * 主代理可把 CounterRecService 的 fetcher 换成读取本方法（或按需改造），本方法保持无副作用。
   */
  readSnapshotCandidates(limitPerSource = 10): HotlistCandidate[] {
    const dateKey = todayKey(this.now())
    const rows = this.db
      .prepare(
        'SELECT a.title, a.score, a.url, a.source_label FROM daily_article a' +
          ' JOIN daily_report_article ra ON ra.article_id = a.id' +
          ' JOIN daily_report dr ON dr.id = ra.report_id' +
          ' WHERE dr.date_key = ? ORDER BY a.score DESC, a.id DESC'
      )
      .all(dateKey) as { title: string; score: number | null; url: string | null; source_label: string }[]
    const perSource = new Map<string, number>()
    const out: HotlistCandidate[] = []
    for (const r of rows) {
      const n = perSource.get(r.source_label) ?? 0
      if (n >= Math.max(1, limitPerSource)) continue
      perSource.set(r.source_label, n + 1)
      out.push({ title: r.title, score: r.score, url: r.url, sourceLabel: r.source_label })
      if (out.length >= 30) break
    }
    return out
  }

  // ---------- 日报汇总 / 资讯明细（结构化） ----------

  private buildIntro(status: DailyReportStatus, sourceReports: DailySourceReport[]): string {
    const total = sourceReports.reduce((n, s) => n + s.count, 0)
    if (status === 'complete') return `今日共收录 ${total} 条热点。`
    if (status === 'partial') {
      const failed = sourceReports.filter((s) => s.error).map((s) => s.label).join('、')
      return `今日共收录 ${total} 条热点；部分源获取失败：${failed}。`
    }
    return '今日无可用热点。'
  }

  private buildLegacyContent(sources: DailySourceConfig[], results: { items: DailySourceItem[]; error?: string }[]): string {
    let content = ''
    for (const [i, source] of sources.entries()) {
      const r = results[i]
      content += `## ${source.label}\n`
      if (r.error || r.items.length === 0) {
        content += `（获取失败：${r.error ?? '无条目'}）\n\n`
      } else {
        for (const [j, it] of r.items.entries()) {
          content += `${j + 1}. ${it.title}${it.score !== null ? `（热度 ${Math.round(it.score)}）` : ''}\n`
        }
        content += '\n'
      }
    }
    const stamp = this.now().toISOString()
    content += `\n— 生成于 ${stamp.replace('T', ' ').slice(0, 19)} —\n`
    return content
  }

  private upsertReport(dateKey: string, title: string, status: DailyReportStatus, sourceReports: DailySourceReport[], infoId: number | null): number {
    const intro = this.buildIntro(status, sourceReports)
    const sourcesJson = JSON.stringify(sourceReports)
    const stamp = this.now().toISOString()
    const existing = this.db.prepare('SELECT id FROM daily_report WHERE date_key = ?').get(dateKey) as { id: number } | undefined
    if (existing) {
      this.db
        .prepare(
          'UPDATE daily_report SET title = ?, intro = ?, status = ?, sources_json = ?, info_id = ?, generated_at = ?, updated_at = ? WHERE id = ?'
        )
        .run(title, intro, status, sourcesJson, infoId, stamp, stamp, existing.id)
      return existing.id
    }
    const r = this.db
      .prepare(
        'INSERT INTO daily_report (date_key, title, intro, status, sources_json, info_id, generated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(dateKey, title, intro, status, sourcesJson, infoId, stamp, stamp, stamp)
    return Number(r.lastInsertRowid)
  }

  private upsertArticle(source: DailySourceConfig, item: DailySourceItem): number {
    const title = item.title.slice(0, 200)
    const dedupKey = source.id + '::' + normalizeTitle(title)
    const topic = classifyDailyTitle(title)
    const topicId = topic ? topic.topicId : null
    const topicMatches = topic ? topic.matches : []
    const content = (item.content ?? '').slice(0, 10_000)
    const stamp = this.now().toISOString()
    const existing = this.db.prepare('SELECT id FROM daily_article WHERE dedup_key = ?').get(dedupKey) as { id: number } | undefined
    if (existing) {
      // force 刷新只更新内容类字段，保留 status/user_acted/item_id（用户处理状态）与原文链接
      this.db
        .prepare(
          'UPDATE daily_article SET title = ?, content = ?, url = ?, source_label = ?, score = ?, topic = ?, topic_matches_json = ?, updated_at = ? WHERE id = ?'
        )
        .run(title, content, item.url, source.label, item.score, topicId, JSON.stringify(topicMatches), stamp, existing.id)
      return existing.id
    }
    const r = this.db
      .prepare(
        'INSERT INTO daily_article (dedup_key, title, content, url, source_id, source_label, score, topic, topic_matches_json, status, user_acted, item_id, first_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(dedupKey, title, content, item.url, source.id, source.label, item.score, topicId, JSON.stringify(topicMatches), 'keep', 0, null, stamp, stamp, stamp)
    return Number(r.lastInsertRowid)
  }

  /** 写入/更新旧 info 汇总行（面板/旧阅读器兼容），返回 info 行 id */
  private upsertLegacyInfo(title: string, content: string): number {
    const stamp = this.now().toISOString()
    const existing = this.db.prepare("SELECT id FROM info WHERE source_type = 'daily' AND title = ?").get(title) as { id: number } | undefined
    if (existing) {
      this.db.prepare('UPDATE info SET content = ? WHERE id = ?').run(content, existing.id)
      return existing.id
    }
    const r = this.db
      .prepare('INSERT INTO info (source_type, title, content, category, destination, status, created_at, routed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('daily', title, content, '一般信息', 'keep', 'routed', stamp, stamp)
    return Number(r.lastInsertRowid)
  }

  /**
   * 生成日报（幂等）：同一天已有报告且非 force 直接返回；force 刷新内容。
   * 产物：daily_report 汇总 + daily_article 明细（去重保留用户状态）+ 旧 info 汇总行（兼容）。
   */
  async generate(force = false): Promise<DailyOpResult> {
    if (this.generating) return { ok: false, message: '正在生成中，请稍候' }
    const sources = this.effectiveSources().filter((s) => s.enabled)
    if (sources.length === 0) return { ok: false, message: '没有启用任何平台源，请先开启至少一个源' }
    const dateKey = todayKey(this.now())
    const title = this.todayTitle()
    const existingReport = this.db.prepare('SELECT id FROM daily_report WHERE date_key = ?').get(dateKey) as { id: number } | undefined
    if (existingReport && !force) {
      const summary = this.reportSummaryById(existingReport.id)
      return { ok: true, id: existingReport.id, message: '今天的日报已生成', sources: summary ? summary.sources.map((s) => ({ label: s.label, count: s.count, error: s.error ?? undefined })) : [] }
    }
    this.generating = true
    try {
      const results = await Promise.all(sources.map((s) => this.fetchSource(s)))
      const sourceReports: DailySourceReport[] = sources.map((s, i) => ({
        sourceId: s.id,
        label: s.label,
        count: results[i].items.length,
        error: results[i].error ?? null
      }))
      const fetched = results.filter((r) => !r.error && r.items.length > 0)
      if (fetched.length === 0) {
        const firstError = results.find((r) => r.error)?.error
        return {
          ok: false,
          message: `生成失败：${firstError ?? '所有源均无可用条目'}，请检查网络或源配置`,
          sources: sourceReports.map((s) => ({ label: s.label, count: s.count, error: s.error ?? undefined }))
        }
      }
      const status: DailyReportStatus = results.some((r) => r.error || r.items.length === 0) ? 'partial' : 'complete'

      // 1. 旧 info 汇总行（先建，拿到 infoId 关联回 daily_report）
      const content = this.buildLegacyContent(sources, results)
      const infoId = this.upsertLegacyInfo(title, content)

      // 2. 日报汇总
      const reportId = this.upsertReport(dateKey, title, status, sourceReports, infoId)

      // 3. 资讯明细 + 关联（去重）
      for (const [i, source] of sources.entries()) {
        const r = results[i]
        if (r.error || r.items.length === 0) continue
        for (const it of r.items) {
          const articleId = this.upsertArticle(source, it)
          this.db.prepare('INSERT OR IGNORE INTO daily_report_article (report_id, article_id) VALUES (?, ?)').run(reportId, articleId)
        }
      }

      return { ok: true, id: reportId, message: '日报已生成，并作为资料进入信息流', sources: sourceReports.map((s) => ({ label: s.label, count: s.count, error: s.error ?? undefined })) }
    } finally {
      this.generating = false
    }
  }

  /** 历史日报（旧 info 行，新在前，保留旧读者兼容） */
  listReports(limit = 14): DailyReportItem[] {
    const rows = this.db
      .prepare("SELECT id, title, content, created_at FROM info WHERE source_type = 'daily' ORDER BY id DESC LIMIT ?")
      .all(limit) as { id: number; title: string; content: string; created_at: string }[]
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      createdAt: toIsoString(row.created_at) ?? row.created_at
    }))
  }

  status(): DailyStatus {
    const todayGenerated = !!this.db
      .prepare("SELECT id FROM info WHERE source_type = 'daily' AND title = ?")
      .get(this.todayTitle())
    const last = this.db
      .prepare("SELECT created_at FROM info WHERE source_type = 'daily' ORDER BY id DESC LIMIT 1")
      .get() as { created_at: string } | undefined
    return {
      lastReportAt: last ? toIsoString(last.created_at) : null,
      nextRunAt: nextDailyRunAt(this.now()).toISOString(),
      todayGenerated,
      generating: this.generating,
      enabledSourceCount: this.effectiveSources().filter((s) => s.enabled).length
    }
  }

  // ---------- 结构化读取 ----------

  private reportSummaryById(id: number): DailyReportSummary | null {
    const row = this.db.prepare('SELECT * FROM daily_report WHERE id = ?').get(id) as unknown as DailyReportRow | undefined
    return row ? this.reportRowToSummary(row) : null
  }

  private reportSummaryByDateKey(dateKey: string): DailyReportSummary | null {
    const row = this.db.prepare('SELECT * FROM daily_report WHERE date_key = ?').get(dateKey) as unknown as DailyReportRow | undefined
    return row ? this.reportRowToSummary(row) : null
  }

  private reportRowToSummary(row: DailyReportRow): DailyReportSummary {
    const articleCount = (this.db.prepare('SELECT COUNT(*) AS c FROM daily_report_article WHERE report_id = ?').get(row.id) as { c: number }).c
    const status: DailyReportStatus = row.status === 'partial' || row.status === 'failed' ? row.status : 'complete'
    return {
      id: row.id,
      dateKey: row.date_key,
      title: row.title,
      intro: row.intro,
      status,
      articleCount,
      infoId: row.info_id,
      generatedAt: toIsoString(row.generated_at),
      createdAt: toIsoString(row.created_at) ?? row.created_at,
      sources: parseSourceReports(row.sources_json)
    }
  }

  private itemTitle(itemId: number): string | null {
    const row = this.db.prepare('SELECT title FROM items WHERE id = ?').get(itemId) as { title: string } | undefined
    return row ? row.title : null
  }

  private articleReportDateKeys(articleId: number): string[] {
    const rows = this.db
      .prepare('SELECT dr.date_key FROM daily_report_article ra JOIN daily_report dr ON dr.id = ra.report_id WHERE ra.article_id = ? ORDER BY dr.date_key DESC')
      .all(articleId) as { date_key: string }[]
    return rows.map((r) => r.date_key)
  }

  private articleRowToDto(row: DailyArticleRow): DailyArticle {
    const status = isArticleStatus(row.status) ? row.status : 'keep'
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      url: row.url,
      sourceId: row.source_id,
      sourceLabel: row.source_label,
      score: row.score,
      topic: row.topic,
      topicLabel: row.topic ? dailyTopicLabel(row.topic) : null,
      topicMatches: parseStringArray(row.topic_matches_json),
      category: row.category,
      status,
      userActed: row.user_acted === 1,
      itemId: row.item_id,
      itemTitle: row.item_id ? this.itemTitle(row.item_id) : null,
      publishedAt: toIsoString(row.published_at),
      createdAt: toIsoString(row.created_at) ?? row.created_at,
      reportDateKeys: this.articleReportDateKeys(row.id)
    }
  }

  /** 固定关注话题（用户管理，空数组 = 无固定关注） */
  getFocusTopics(): string[] {
    const v = getSettingOr<string[]>(this.db, FOCUS_SETTING_KEY, [])
    if (!Array.isArray(v)) return []
    const valid = new Set(DAILY_TOPICS.map((t) => t.id))
    return v.filter((t): t is string => typeof t === 'string' && valid.has(t))
  }

  setFocusTopics(topics: unknown): DailyOpResult {
    if (!Array.isArray(topics)) return { ok: false, message: '关注话题格式无效' }
    const valid = new Set(DAILY_TOPICS.map((t) => t.id))
    const seen = new Set<string>()
    const clean: string[] = []
    for (const t of topics) {
      if (typeof t !== 'string' || !valid.has(t) || seen.has(t)) continue
      seen.add(t)
      clean.push(t)
      if (clean.length >= 20) break
    }
    setSetting(this.db, FOCUS_SETTING_KEY, clean)
    return { ok: true, message: clean.length > 0 ? `已更新 ${clean.length} 个固定关注话题` : '已清空固定关注话题' }
  }

  /** 历史日报分页（超过 14 天仍可遍历） */
  listReportsPaged(query: DailyReportsQuery = {}): DailyReportsResult {
    const limit = Math.min(Math.max(query.limit ?? 14, 1), 100)
    const offset = Math.max(query.offset ?? 0, 0)
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM daily_report').get() as { c: number }).c
    const rows = this.db.prepare('SELECT * FROM daily_report ORDER BY date_key DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as DailyReportRow[]
    return { total, items: rows.map((r) => this.reportRowToSummary(r)) }
  }

  private groupColumns(articles: DailyArticle[], focus: string[]): DailyBoardColumn[] {
    const columns: DailyBoardColumn[] = []
    for (const tid of focus) {
      columns.push({ topicId: tid, topicLabel: dailyTopicLabel(tid), kind: 'focus', articles: articles.filter((a) => a.topic === tid) })
    }
    const discoveryIds = new Set<string>()
    for (const a of articles) {
      if (a.topic && !focus.includes(a.topic)) discoveryIds.add(a.topic)
    }
    const ordered = DAILY_TOPICS.map((t) => t.id).filter((id) => discoveryIds.has(id))
    for (const id of discoveryIds) if (!ordered.includes(id)) ordered.push(id)
    for (const tid of ordered) {
      columns.push({ topicId: tid, topicLabel: dailyTopicLabel(tid), kind: 'discovery', articles: articles.filter((a) => a.topic === tid) })
    }
    const unfiled = articles.filter((a) => !a.topic)
    if (unfiled.length > 0) {
      columns.push({ topicId: null, topicLabel: '未归类', kind: 'unfiled', articles: unfiled })
    }
    return columns
  }

  private articlesOfReport(reportId: number): DailyArticle[] {
    const rows = this.db
      .prepare('SELECT a.* FROM daily_article a JOIN daily_report_article ra ON ra.article_id = a.id WHERE ra.report_id = ? ORDER BY a.score DESC, a.id DESC')
      .all(reportId) as unknown as DailyArticleRow[]
    return rows.map((r) => this.articleRowToDto(r))
  }

  /** 某日看板：固定关注 + 发现 + 未归类分列 */
  getBoard(dateKey?: string): DailyBoard {
    const key = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : todayKey(this.now())
    const focus = this.getFocusTopics()
    const report = this.reportSummaryByDateKey(key)
    if (!report) return { dateKey: key, report: null, focusTopicIds: focus, columns: [] }
    const articles = this.articlesOfReport(report.id)
    return { dateKey: key, report, focusTopicIds: focus, columns: this.groupColumns(articles, focus) }
  }

  /** 某日日报详情（汇总 + 全部明细） */
  getReportDetail(dateKey: string): DailyReportDetail | null {
    const report = this.reportSummaryByDateKey(dateKey)
    if (!report) return null
    return { report, articles: this.articlesOfReport(report.id) }
  }

  /** 按 info 汇总行 id 反查日报详情（信息流展开明细用；旧数据无对应 daily_report 返回 null） */
  getReportDetailByInfo(infoId: number): DailyReportDetail | null {
    if (!Number.isInteger(infoId) || infoId <= 0) return null
    const row = this.db.prepare('SELECT id FROM daily_report WHERE info_id = ?').get(infoId) as { id: number } | undefined
    if (!row) return null
    return { report: this.reportSummaryById(row.id) as DailyReportSummary, articles: this.articlesOfReport(row.id) }
  }

  /** 某日报的资讯明细分页（Agent 分页读取，body 分块不截断） */
  getReportArticles(reportId: number, query: DailyArticlesQuery = {}): DailyArticlesPage | null {
    if (!Number.isInteger(reportId) || reportId <= 0) return null
    const exists = this.db.prepare('SELECT id FROM daily_report WHERE id = ?').get(reportId)
    if (!exists) return null
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM daily_report_article WHERE report_id = ?').get(reportId) as { c: number }).c
    const rows = this.db
      .prepare(
        'SELECT a.* FROM daily_article a JOIN daily_report_article ra ON ra.article_id = a.id WHERE ra.report_id = ? ORDER BY a.score DESC, a.id DESC LIMIT ? OFFSET ?'
      )
      .all(reportId, limit, offset) as unknown as DailyArticleRow[]
    return { reportId, total, items: rows.map((r) => this.articleRowToDto(r)) }
  }

  /** 资讯检索：关键词 / 来源 / 话题 */
  searchArticles(query: DailySearchQuery = {}): DailySearchResult {
    const clause: string[] = []
    const params: SQLInputValue[] = []
    if (query.keyword && query.keyword.trim()) {
      clause.push("(a.title LIKE '%' || ? || '%' OR a.content LIKE '%' || ? || '%' OR a.url LIKE '%' || ? || '%' OR a.source_label LIKE '%' || ? || '%')")
      const k = query.keyword.trim()
      params.push(k, k, k, k)
    }
    if (query.sourceId) {
      clause.push('a.source_id = ?')
      params.push(query.sourceId)
    }
    if (query.topicId) {
      clause.push('a.topic = ?')
      params.push(query.topicId)
    }
    if (query.status && query.status !== 'all' && isArticleStatus(query.status)) {
      clause.push('a.status = ?')
      params.push(query.status)
    }
    const where = clause.length ? ' WHERE ' + clause.join(' AND ') : ''
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM daily_article a' + where).get(...params) as { c: number }).c
    const rows = this.db.prepare('SELECT a.* FROM daily_article a' + where + ' ORDER BY a.id DESC LIMIT ? OFFSET ?').all(...params, limit, offset) as unknown as DailyArticleRow[]
    return { total, items: rows.map((r) => this.articleRowToDto(r)) }
  }

  /** 单条资讯详情 */
  getArticle(id: number): DailyArticle | null {
    if (!Number.isInteger(id) || id <= 0) return null
    const row = this.db.prepare('SELECT * FROM daily_article WHERE id = ?').get(id) as unknown as DailyArticleRow | undefined
    return row ? this.articleRowToDto(row) : null
  }

  /** 单条资讯正文分块（Agent 读取，避免全文截断） */
  getArticleContent(id: number, query: DailyArticleContentQuery = {}): DailyArticleContentResult | null {
    if (!Number.isInteger(id) || id <= 0) return null
    const row = this.db.prepare('SELECT id, title, content FROM daily_article WHERE id = ?').get(id) as { id: number; title: string; content: string } | undefined
    if (!row) return null
    const total = row.content.length
    const limit = Math.min(Math.max(query.limit ?? 4000, 1), 20000)
    const offset = Math.max(query.offset ?? 0, 0)
    const slice = row.content.slice(offset, offset + limit)
    return { id: row.id, title: row.title, content: slice, offset, limit, total, hasMore: offset + slice.length < total }
  }

  /** 反推荐快照 fetcher 适配器：主代理可 new CounterRecService(db, store, daily.snapshotFetcher())，避免重复抓取 */
  snapshotFetcher(): { fetchEnabledItems(limitPerSource?: number): Promise<HotlistCandidate[]> } {
    return {
      fetchEnabledItems: async (limitPerSource = 10) => this.readSnapshotCandidates(limitPerSource)
    }
  }

  /**
   * 单条 keep/archive/item/unverified 处理（复用 info 语义）。
   * 内部用 SAVEPOINT（而非 BEGIN）保证在 Agent 外层事务中可安全嵌套；item 去向直接 createItem 建真实事项。
   */
  setArticleStatus(id: number, status: DailyArticleStatus): DailyArticleOpResult {
    if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '无效的资讯条目' }
    if (!isArticleStatus(status)) return { ok: false, message: '无效的状态' }
    const row = this.db.prepare('SELECT * FROM daily_article WHERE id = ?').get(id) as unknown as DailyArticleRow | undefined
    if (!row) return { ok: false, message: '资讯条目不存在' }
    const sp = 'daily_status_' + id
    this.db.exec('SAVEPOINT ' + sp)
    try {
      if (status === 'item') {
        if (row.item_id) {
          this.db.prepare("UPDATE daily_article SET status = 'item', user_acted = 1, updated_at = datetime('now','localtime') WHERE id = ?").run(id)
          this.db.exec('RELEASE ' + sp)
          return { ok: true, message: '已转事项', id, itemId: row.item_id }
        }
        const notes = ['来源日报：' + (row.source_label || '未知来源')]
        if (row.url) notes.push('原文：' + row.url)
        if (row.topic) notes.push('话题：' + dailyTopicLabel(row.topic))
        const itemId = createItem(this.db, {
          title: row.title || '未命名事项',
          category: row.category || '一般信息',
          status: '待处理',
          notes: notes.join('；')
        })
        this.db.prepare("UPDATE daily_article SET status = 'item', item_id = ?, user_acted = 1, updated_at = datetime('now','localtime') WHERE id = ?").run(itemId, id)
        this.db.exec('RELEASE ' + sp)
        return { ok: true, message: '已转为事项', id, itemId }
      }
      this.db.prepare("UPDATE daily_article SET status = ?, item_id = NULL, user_acted = 1, updated_at = datetime('now','localtime') WHERE id = ?").run(status, id)
      this.db.exec('RELEASE ' + sp)
      const label = status === 'keep' ? '已保留为资料' : status === 'archive' ? '已归档' : '已退回待核实'
      return { ok: true, message: label, id }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK TO ' + sp)
        this.db.exec('RELEASE ' + sp)
      } catch {
        /* 回滚失败忽略 */
      }
      return { ok: false, message: '操作失败：' + (error instanceof Error ? error.message : String(error)) }
    }
  }

  /** 单条行动分类（与话题 topic 独立）：复用 ANALYSIS_CATEGORIES 白名单 */
  setArticleCategory(id: number, category: string): DailyArticleOpResult {
    if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '无效的资讯条目' }
    if (!(ANALYSIS_CATEGORIES as readonly string[]).includes(category)) return { ok: false, message: '无效的分类' }
    const row = this.db.prepare('SELECT id FROM daily_article WHERE id = ?').get(id) as { id: number } | undefined
    if (!row) return { ok: false, message: '资讯条目不存在' }
    this.db.prepare("UPDATE daily_article SET category = ?, user_acted = 1, updated_at = datetime('now','localtime') WHERE id = ?").run(category, id)
    return { ok: true, message: '已更新分类：' + category, id }
  }

  /** 别名：与主代理 Agent 工具约定的命名保持一致（等价 setArticleStatus） */
  articleStatus(id: number, status: DailyArticleStatus): DailyArticleOpResult {
    return this.setArticleStatus(id, status)
  }

  /** 别名：与主代理 Agent 工具约定的命名保持一致（等价 setArticleCategory） */
  articleCategory(id: number, category: string): DailyArticleOpResult {
    return this.setArticleCategory(id, category)
  }
}

/** 8:00 定时器 + 启动补生成。随主进程存活，默认 60s 轮询一次。
 * 失败退避：当天最多重试 maxRetries 次、每次间隔 ≥ retryIntervalMs，8:00 后任意时刻可重试；
 * 仅生成成功（result.ok）才触发 afterGenerate 并视为当天完成，全部失败不触发反推荐联动。 */
export class DailyScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private attemptedKey = ''
  private attempts = 0
  private lastAttemptAt = 0

  constructor(
    private service: DailyService,
    /** 时间源注入（测试用），默认取系统时钟 */
    private now: () => Date = () => new Date(),
    /** 日报生成成功后的联动（P5 反推荐生成）；仅成功触发，异常不影响主流程 */
    private afterGenerate?: () => Promise<void>,
    /** 当天失败重试上限（可注入，测试用） */
    private maxRetries = 3,
    /** 轮询/重试最小间隔 ms（可注入，测试用） */
    private retryIntervalMs = 60_000
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.retryIntervalMs)
  }

  /** 跨天时重置当天的重试状态 */
  private resetIfNewDay(key: string): void {
    if (this.attemptedKey !== key) {
      this.attemptedKey = key
      this.attempts = 0
      this.lastAttemptAt = 0
    }
  }

  /** 单次尝试：成功即完成；失败累计重试次数（不触发联动），留给后续 tick 退避重试 */
  private async attempt(): Promise<void> {
    if (this.inFlight) return
    const now = this.now()
    const key = todayKey(now)
    this.resetIfNewDay(key)
    if (this.service.status().todayGenerated) return
    if (now.getHours() < 8) return
    if (this.attempts >= this.maxRetries) return
    if (this.lastAttemptAt > 0 && now.getTime() - this.lastAttemptAt < this.retryIntervalMs) return

    this.inFlight = true
    this.lastAttemptAt = now.getTime()
    try {
      const result = await this.service.generate(false)
      if (result.ok) {
        this.attempts = 0
        await this.runAfterGenerate()
      } else {
        this.attempts += 1
      }
    } finally {
      this.inFlight = false
    }
  }

  /** 定时轮询入口（测试可直接调用模拟一次 tick） */
  async tick(): Promise<void> {
    await this.attempt()
  }

  /** 启动补生成：错过 8:00 后下次启动立即尝试；失败后由定时 tick 按退避重试 */
  async bootstrap(): Promise<void> {
    await this.attempt()
  }

  private async runAfterGenerate(): Promise<void> {
    if (!this.afterGenerate) return
    try {
      await this.afterGenerate()
    } catch {
      /* 联动失败不影响日报主流程 */
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
