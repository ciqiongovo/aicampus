import type { DatabaseSync } from 'node:sqlite'
import type { BrowserWindow } from 'electron'
import type { AiConfigInput, AppSettings } from '../../../shared/types'
import type {
  ZhihuBoard,
  ZhihuOpResult,
  ZhihuPush,
  ZhihuPushAction,
  ZhihuPushStatus,
  ZhihuStatus,
  ZhihuTodayResult
} from '../../../shared/zhihu'
import type { SettingsStore } from '../../store/settings'
import { chatCompletion } from '../ai/analyzer'
import { todayKey } from '../daily/service'
import { listKeywordProfile } from '../panel/keywordProfile'
import { CognitionService } from '../jarvis/cognition'
import { PANEL_TOPICS } from '../../../shared/topics'
import { createInfo } from '../../db/dao/infoDao'
import { saveMaterial } from '../materials/service'
import { ZhihuAuthError } from './feed'
import type { ZhihuFeedItem, ZhihuGateway } from './feed'
import { classifyJunk } from './junkFilter'

/**
 * 知乎反推荐服务：
 * 1) 从登录态推荐流抓取候选（gateway 可注入，测试不触网）；
 * 2) 先用本地关键词画像算「离画像多远」，质量/猎奇/广告过滤；
 * 3) 有可用 AI 时再让模型精选少量条目并写理由；AI 失败退回本地排序；
 * 4) 每天落库一批，用户可逐条已读/存资料/不感兴趣/恢复。
 */

export type ZhihuChatFn = (cfg: AiConfigInput, system: string, user: string, jsonMode: boolean) => Promise<string>

const MIN_VOTEUP = 3
const DEFAULT_COUNT = 3
const MAX_AI_CANDIDATES = 24
const AI_MAX_REASON = 90

const SYSTEM_PROMPT = [
  '你是 InfoAgent 的「知乎双板」编辑：先给用户看贴近兴趣的推荐，再给一个不一样的声音。',
  '',
  '任务：用户已经看到下面的「推荐位」；请从候选里挑出与这些推荐位形成对照、不同立场或不同角度，但仍可信、有信息量的内容。',
  '不是随机换一个无关话题，而是让用户在同一类议题上看到另一面。',
  '',
  '只输出一个 JSON 对象，格式为 {"picks":[{"index":0,"reason":"推荐理由"}]}，不要解释或 markdown 围栏。',
  '- index 是候选编号（从 0 开始的整数），不可重复；没有合适候选时输出 {"picks":[]}。',
  '- 最多挑选指定条数，宁缺毋滥。',
  '- reason 用中文，不超过 80 字，说明这条和推荐位是什么关系（反驳/补充/另一视角）。',
  '',
  '筛选标准：',
  '- 优先与推荐位议题相关、但立场或切入点明显不同的内容；',
  '- 排除软色情、猎奇、纯情绪/两性对立、广告、标题党、医疗或法律建议；',
  '- 不要求热度最高，但不能是明显的低质回答。'
].join('\n')

const RECOMMEND_SYSTEM_PROMPT = [
  '你是 InfoAgent 的「兴趣推荐」编辑：从推荐流里挑出用户最可能感兴趣、但仍有信息量的内容。',
  '',
  '任务：根据用户画像（记忆、关键词、关心标签、年级专业），选出与用户当前兴趣最贴近的文章。',
  '',
  '只输出一个 JSON 对象，格式为 {"picks":[{"index":0,"reason":"推荐理由"}]}，不要解释或 markdown 围栏。',
  '- index 是候选编号（从 0 开始的整数），不可重复；除非候选不足，否则必须选满指定条数。',
  '- 即使画像稀疏，也按相对接近程度排序，不要返回空数组。',
  '- reason 用中文，不超过 80 字，说明这条为什么贴近用户当前的兴趣。',
  '',
  '筛选标准：',
  '- 优先画像里明确出现的方向、专业相关或近期关心的话题；',
  '- 排除软色情、猎奇、纯情绪/两性对立、广告、标题党、医疗或法律建议；',
  '- 不要为了「贴近」而选低质或重复内容。'
].join('\n')

interface StateRow {
  id: number
  logged_in: number
  last_sync_at: string | null
  last_error: string
  last_count: number
  last_recommend_count: number
  last_counter_count: number
}

interface PushRow {
  id: number
  date_key: string
  item_key: string
  title: string
  excerpt: string
  url: string
  author: string
  content_type: string
  voteup: number | null
  reason: string
  distance: number | null
  status: string
  board: string
  info_id: number | null
  created_at: string
}

interface Candidate {
  item: ZhihuFeedItem
  /** 与兴趣画像的重合度 0..1；越高越贴近「推荐」。 */
  interest: number
  /** 与兴趣画像的距离 0..1；越高越适合「反推荐」。 */
  distance: number
  recommendScore: number
  counterScore: number
  matched: string[]
  /** 平台推荐流中的相对位置（越靠前越接近平台的个性化判断）。 */
  feedRank: number
}

interface ProfileDigest {
  memories: string[]
  keywords: Array<{ keyword: string; weight: number }>
  /** 用户明确不感兴趣的方向；命中后不选，避免把「反感」当成「远方」。 */
  negativeKeywords: Array<{ keyword: string; weight: number }>
  /** 「我的关心」里正向的八维标签，作为 AI 判断兴趣的补充。 */
  concerns: Array<{ label: string; weight: number }>
  grade: string
  major: string
}

function clampCount(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_COUNT
  return Math.max(1, Math.min(5, n))
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function parsePicks(text: string): Array<{ index: number; reason: string }> {
  const trimmed = text.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return []
    }
  }
  const record = parsed as Record<string, unknown>
  const raw = Array.isArray(record.picks) ? record.picks : []
  // 兼容旧格式 {"index":1,"reason":"..."}
  if (raw.length === 0 && typeof record.index === 'number') raw.push(record)
  const picks: Array<{ index: number; reason: string }> = []
  const seen = new Set<number>()
  for (const entry of raw) {
    const item = entry as Record<string, unknown>
    if (typeof item.index !== 'number' || !Number.isInteger(item.index) || seen.has(item.index)) continue
    seen.add(item.index)
    picks.push({
      index: item.index,
      reason: String(item.reason ?? '').trim().slice(0, AI_MAX_REASON)
    })
  }
  return picks
}

/** 软色情/纯猎奇：宁少勿滥，避免「破茧」变味。 */
const BLOCK_RE =
  /(做爱|性爱|约炮|一夜情|裸照|色情|嫖娼|包养|乳房|私处|射精|高潮|性欲|性行为|性技巧|生殖器)/

function looksLowQuality(item: ZhihuFeedItem): boolean {
  const text = `${item.title} ${item.excerpt}`
  if (!item.title.trim()) return true
  if (!/^https?:\/\//i.test(item.url)) return true
  if (item.contentType === 'zvideo' && item.excerpt.length < 20) return true
  if (BLOCK_RE.test(text)) return true
  // 广告/盐选/网文/种草/空壳：规则来自 Antipode 的 junk_filter，误杀率比单关键词低。
  if (classifyJunk({ url: item.url, title: item.title, text: item.excerpt }).drop) return true
  if (item.voteup !== null && item.voteup < MIN_VOTEUP) return true
  if (item.voteup === null && item.excerpt.length < 40) return true
  return false
}

function qualityScore(item: ZhihuFeedItem): number {
  const votes = item.voteup ?? 0
  const vote = Math.min(1, Math.log10(votes + 1) / 4)
  const detail = Math.min(1, item.excerpt.length / 220)
  return vote * 0.75 + detail * 0.25
}

function rowToPush(row: PushRow): ZhihuPush {
  const status: ZhihuPushStatus =
    row.status === 'read' || row.status === 'saved' || row.status === 'ignored' ? row.status : 'pending'
  const board = row.board === 'recommend' ? 'recommend' : 'counter'
  return {
    id: row.id,
    dateKey: row.date_key,
    itemKey: row.item_key,
    title: row.title,
    excerpt: row.excerpt,
    url: row.url,
    author: row.author,
    contentType: row.content_type,
    voteup: typeof row.voteup === 'number' ? row.voteup : null,
    reason: row.reason,
    distance: typeof row.distance === 'number' ? row.distance : null,
    status,
    board,
    infoId: row.info_id,
    createdAt: row.created_at
  }
}

function defaultReason(): string {
  return '与你的画像重合度低，来自平时较少接触的方向，适合换换视角。'
}

export class ZhihuService {
  private generating = false

  constructor(
    private db: DatabaseSync,
    private store: SettingsStore,
    private gateway: ZhihuGateway,
    private chatFn: ZhihuChatFn = (cfg, system, user) => chatCompletion(cfg, system, user, true),
    private now: () => Date = () => new Date()
  ) {}

  private stateRow(): StateRow {
    const row = this.db.prepare('SELECT * FROM zhihu_state WHERE id = 1').get() as StateRow | undefined
    if (row) return row
    this.db.prepare('INSERT OR IGNORE INTO zhihu_state (id) VALUES (1)').run()
    return this.db.prepare('SELECT * FROM zhihu_state WHERE id = 1').get() as unknown as StateRow
  }

  private saveState(patch: {
    loggedIn?: boolean
    lastSyncAt?: string | null
    lastError?: string
    lastCount?: number
    lastRecommendCount?: number
    lastCounterCount?: number
  }): void {
    const current = this.stateRow()
    const loggedIn = patch.loggedIn === undefined ? current.logged_in : patch.loggedIn ? 1 : 0
    const lastSyncAt = patch.lastSyncAt === undefined ? current.last_sync_at : patch.lastSyncAt
    const lastError = patch.lastError === undefined ? current.last_error : patch.lastError
    const lastCount = patch.lastCount === undefined ? current.last_count : patch.lastCount
    const lastRecommend = patch.lastRecommendCount === undefined ? current.last_recommend_count : patch.lastRecommendCount
    const lastCounter = patch.lastCounterCount === undefined ? current.last_counter_count : patch.lastCounterCount
    this.db
      .prepare(
        'UPDATE zhihu_state SET logged_in = ?, last_sync_at = ?, last_error = ?, last_count = ?,' +
          ' last_recommend_count = ?, last_counter_count = ? WHERE id = 1'
      )
      .run(loggedIn, lastSyncAt, lastError, lastCount, lastRecommend, lastCounter)
  }

  private rowsByDate(key: string): ZhihuPush[] {
    const rows = this.db
      .prepare('SELECT * FROM zhihu_push WHERE date_key = ? ORDER BY id')
      .all(key) as unknown as PushRow[]
    return rows.map(rowToPush)
  }

  private rowById(id: number): PushRow | undefined {
    return this.db.prepare('SELECT * FROM zhihu_push WHERE id = ?').get(id) as PushRow | undefined
  }

  private aiConfig(s: AppSettings): AiConfigInput | null {
    if (!s.aiProvider || !s.aiBaseURL || !s.aiModel || (!s.aiIsLocal && !s.aiApiKey)) return null
    if (!s.aiAuthorizedFor || s.aiAuthorizedFor !== s.aiProvider + '|' + s.aiBaseURL) return null
    return { provider: s.aiProvider, baseURL: s.aiBaseURL, model: s.aiModel, apiKey: s.aiApiKey }
  }

  private profileDigest(settings: AppSettings): ProfileDigest {
    const cognition = new CognitionService(this.db, this.now)
    const memories = cognition
      .memoryList({ status: 'active' })
      .filter((m) => ['background', 'goal', 'interest', 'habit', 'identity'].includes(m.section))
      .map((m) => m.content.trim())
      .filter(Boolean)
      .slice(0, 18)
    const profile = listKeywordProfile(this.db, this.now(), 80)
    const keywords = profile
      .filter((k) => k.weight > 0)
      .map((k) => ({ keyword: k.keyword, weight: k.weight }))
      .slice(0, 30)
    const negativeKeywords = profile
      .filter((k) => k.weight < 0)
      .map((k) => ({ keyword: k.keyword, weight: k.weight }))
      .slice(0, 20)
    const concernRows = this.db
      .prepare(
        "SELECT key, weight FROM preference_signal WHERE dimension = 'topic' AND weight > 0 ORDER BY weight DESC LIMIT 8"
      )
      .all() as unknown as Array<{ key: string; weight: number }>
    const concerns = concernRows.map((row) => ({
      label: PANEL_TOPICS.find((topic) => topic.id === row.key)?.name ?? row.key,
      weight: row.weight
    }))
    return {
      memories,
      keywords,
      negativeKeywords,
      concerns,
      grade: settings.userGrade.trim(),
      major: settings.userMajor.trim()
    }
  }

  private buildCandidates(items: ZhihuFeedItem[], profile: ProfileDigest): Candidate[] {
    const seen = new Set<string>()
    const candidates: Candidate[] = []
    const total = Math.max(1, items.length)
    for (const [index, item] of items.entries()) {
      if (looksLowQuality(item)) continue
      const titleKey = normalizeText(item.title)
      if (!titleKey || seen.has(titleKey)) continue
      seen.add(titleKey)
      const text = normalizeText(`${item.title} ${item.excerpt} ${item.author}`)
      let positive = 0
      const matched: string[] = []
      for (const keyword of profile.keywords) {
        if (!keyword.keyword) continue
        if (text.includes(normalizeText(keyword.keyword))) {
          positive += keyword.weight
          if (matched.length < 3) matched.push(keyword.keyword)
        }
      }
      // 负向关键词代表用户已经明确不感兴趣；这种内容不是「远方」，是「雷区」，直接跳过。
      let negative = 0
      for (const keyword of profile.negativeKeywords) {
        if (!keyword.keyword) continue
        if (text.includes(normalizeText(keyword.keyword))) negative += Math.abs(keyword.weight)
      }
      if (negative >= 0.4) continue
      const interest = Math.min(1, positive / 3)
      const distance = Math.max(0, Math.min(1, 1 - interest))
      const quality = qualityScore(item)
      const feedRank = Math.max(0, 1 - index / total)
      candidates.push({
        item,
        interest,
        distance,
        recommendScore: interest * 0.5 + quality * 0.2 + feedRank * 0.3 - negative * 0.2,
        counterScore: distance * 0.7 + quality * 0.3 - negative * 0.2,
        matched,
        feedRank
      })
    }
    return candidates
  }

  private buildPrompt(profile: ProfileDigest, candidates: Candidate[], count: number, seeds: string[]): string {
    const lines: string[] = [`用户画像摘要（本地数据，仅供判断距离）：`]
    if (profile.memories.length) {
      lines.push('关于用户：')
      for (const memory of profile.memories) lines.push('- ' + memory)
    } else {
      lines.push('- 暂无明确画像，请优先选话题跨度大、可信度高的内容。')
    }
    if (profile.grade || profile.major) {
      lines.push(`用户自述：${[profile.grade, profile.major].filter(Boolean).join(' / ')}`)
    }
    if (profile.keywords.length) {
      lines.push('近期关注关键词：' + profile.keywords.map((k) => k.keyword).join('、'))
    }
    if (profile.negativeKeywords.length) {
      lines.push('明确不感兴趣（不要选，也不要把这些方向当成「破茧」）：' + profile.negativeKeywords.map((k) => k.keyword).join('、'))
    }
    if (seeds.length) {
      lines.push('', '用户刚看到的推荐位（反推荐要和这些形成对照，而不是无关话题）：')
      seeds.slice(0, 6).forEach((seed, index) => lines.push(`${index + 1}. ${seed}`))
    }
    lines.push('', `候选文章（编号从 0 开始，最多选 ${count} 条）：`)
    candidates.slice(0, MAX_AI_CANDIDATES).forEach((candidate, index) => {
      const item = candidate.item
      lines.push(
        `${index}. [${item.contentType}] ${item.title} | 作者：${item.author || '未知'} | ${item.voteup ?? '?'} 赞`
      )
      if (item.excerpt) lines.push('   摘要：' + item.excerpt.slice(0, 180))
    })
    return lines.join('\n')
  }

  private buildRecommendPrompt(profile: ProfileDigest, candidates: Candidate[], count: number): string {
    const lines: string[] = ['用户画像摘要（本地数据，仅供判断兴趣）：']
    if (profile.memories.length) {
      lines.push('关于用户：')
      for (const memory of profile.memories) lines.push('- ' + memory)
    } else {
      lines.push('- 暂无明确画像，请优先选信息密度高、可信度高的内容。')
    }
    if (profile.grade || profile.major) {
      lines.push(`用户自述：${[profile.grade, profile.major].filter(Boolean).join(' / ')}`)
    }
    if (profile.concerns.length) {
      lines.push('关心标签（近期反馈的正向方向）：' + profile.concerns.map((c) => c.label).join('、'))
    }
    if (profile.keywords.length) {
      lines.push('近期关注关键词：' + profile.keywords.map((k) => k.keyword).join('、'))
    }
    if (profile.negativeKeywords.length) {
      lines.push('明确不感兴趣（不要选）：' + profile.negativeKeywords.map((k) => k.keyword).join('、'))
    }
    lines.push('', `候选文章（编号从 0 开始，最多选 ${count} 条）：`)
    candidates.slice(0, MAX_AI_CANDIDATES).forEach((candidate, index) => {
      const item = candidate.item
      lines.push(
        `${index}. [${item.contentType}] ${item.title} | 作者：${item.author || '未知'} | ${item.voteup ?? '?'} 赞`
      )
      if (item.excerpt) lines.push('   摘要：' + item.excerpt.slice(0, 180))
    })
    return lines.join('\n')
  }

  private async pickWithAi(
    cfg: AiConfigInput,
    systemPrompt: string,
    prompt: string,
    candidates: Candidate[],
    count: number
  ): Promise<Array<{ candidate: Candidate; reason: string }> | null> {
    const raw = await this.chatFn(cfg, systemPrompt, prompt, true)
    const picks = parsePicks(raw)
    const chosen: Array<{ candidate: Candidate; reason: string }> = []
    const used = new Set<number>()
    for (const pick of picks) {
      if (chosen.length >= count) break
      if (pick.index < 0 || pick.index >= Math.min(candidates.length, MAX_AI_CANDIDATES)) continue
      if (used.has(pick.index)) continue
      used.add(pick.index)
      chosen.push({ candidate: candidates[pick.index], reason: pick.reason || defaultReason() })
    }
    return chosen.length ? chosen : null
  }

  private recommendPicks(candidates: Candidate[], count: number): Array<{ candidate: Candidate; reason: string }> {
    return [...candidates]
      .sort((a, b) => b.recommendScore - a.recommendScore)
      .slice(0, count)
      .map((candidate) => {
        const hits = candidate.matched.slice(0, 3)
        const reason = hits.length
          ? `命中你的关注：${hits.join('、')}；和你最近的兴趣方向最接近。`
          : '来自你常看方向的延伸，信息密度较高。'
        return { candidate, reason }
      })
  }

  private counterPicks(candidates: Candidate[], count: number): Array<{ candidate: Candidate; reason: string }> {
    return [...candidates]
      .sort((a, b) => b.counterScore - a.counterScore)
      .slice(0, count)
      .map((candidate) => ({
        candidate,
        reason: '与推荐位形成对照：同一类议题的另一面，适合换个角度。'
      }))
  }

  private storePicks(
    key: string,
    board: ZhihuBoard,
    picks: Array<{ candidate: Candidate; reason: string }>
  ): void {
    this.db.exec('SAVEPOINT zhihu_store')
    try {
      // 刷新时只替换本板块未处理的条目；已存资料/已忽略的保留，避免误删用户已有动作。
      this.db
        .prepare("DELETE FROM zhihu_push WHERE date_key = ? AND board = ? AND status IN ('pending','read')")
        .run(key, board)
      const createdAt = this.now().toISOString()
      for (const pick of picks) {
        const item = pick.candidate.item
        const existing = this.db
          .prepare('SELECT id FROM zhihu_push WHERE date_key = ? AND item_key = ?')
          .get(key, item.itemKey) as { id: number } | undefined
        if (existing) continue
        this.db
          .prepare(
            'INSERT INTO zhihu_push' +
              ' (date_key, item_key, title, excerpt, url, author, content_type, voteup, reason, distance, board, created_at)' +
              ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            key,
            item.itemKey,
            item.title,
            item.excerpt,
            item.url,
            item.author,
            item.contentType,
            item.voteup,
            pick.reason,
            Math.round(pick.candidate.distance * 1000) / 1000,
            board,
            createdAt
          )
      }
      this.db.exec('RELEASE zhihu_store')
    } catch (error) {
      this.db.exec('ROLLBACK TO zhihu_store; RELEASE zhihu_store')
      throw error
    }
  }

  async status(): Promise<ZhihuStatus> {
    let loggedIn = false
    try {
      loggedIn = await this.gateway.hasLogin()
    } catch {
      loggedIn = false
    }
    const state = this.stateRow()
    if (state.logged_in !== (loggedIn ? 1 : 0) || (loggedIn && state.last_error)) {
      this.saveState({ loggedIn, lastError: loggedIn ? '' : state.last_error })
    }
    const settings = await this.store.get()
    const key = todayKey(this.now())
    const rows = this.db
      .prepare('SELECT board, COUNT(*) AS c FROM zhihu_push WHERE date_key = ? GROUP BY board')
      .all(key) as unknown as Array<{ board: string; c: number }>
    let todayRecommendCount = 0
    let todayCounterCount = 0
    for (const row of rows) {
      if (row.board === 'recommend') todayRecommendCount = Number(row.c)
      else todayCounterCount += Number(row.c)
    }
    const recommendCount = clampCount(settings.zhihuRecommendCount)
    const counterCount = clampCount(settings.zhihuCounterCount)
    const digest = this.profileDigest(settings)
    const tags = [
      digest.major,
      digest.grade,
      ...digest.concerns.map((concern) => concern.label)
    ]
      .filter((tag, index, all) => tag && all.indexOf(tag) === index)
      .slice(0, 8)
    return {
      loggedIn,
      lastSyncAt: state.last_sync_at,
      lastError: loggedIn ? '' : state.last_error,
      recommendCount,
      counterCount,
      todayRecommendCount,
      todayCounterCount,
      tags,
      count: counterCount,
      todayCount: todayRecommendCount + todayCounterCount
    }
  }

  async login(parent?: BrowserWindow | null): Promise<ZhihuOpResult> {
    try {
      const result = await this.gateway.login(parent)
      if (result.ok) this.saveState({ loggedIn: true, lastError: '' })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.saveState({ loggedIn: false, lastError: message })
      return { ok: false, message }
    }
  }

  async logout(): Promise<ZhihuOpResult> {
    try {
      await this.gateway.logout()
      this.saveState({ loggedIn: false, lastError: '' })
      return { ok: true, message: '已退出知乎账号，已生成的推荐与资料不受影响' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.saveState({ lastError: message })
      return { ok: false, message: '退出知乎账号失败：' + message }
    }
  }

  async today(): Promise<ZhihuTodayResult> {
    const status = await this.status()
    return { status, pushes: this.rowsByDate(todayKey(this.now())) }
  }

  /**
   * 抓取并生成今日「推荐 + 反推荐」两个板块。已有且非 force 直接返回；
   * force 只替换本板块未处理条目。网络/AI 失败都写 last_error，但不会删掉已有条目。
   */
  async sync(force = false): Promise<ZhihuOpResult> {
    const key = todayKey(this.now())
    const existing = this.rowsByDate(key)
    const hasRecommend = existing.some((push) => push.board === 'recommend')
    const hasCounter = existing.some((push) => push.board === 'counter')
    if (hasRecommend && hasCounter && !force) return { ok: true, message: '今天的推荐和反推荐已生成', pushes: existing }
    if (this.generating) return { ok: false, message: '知乎推荐正在生成中，请稍候', pushes: existing }
    this.generating = true
    try {
      if (!(await this.gateway.hasLogin())) {
        this.saveState({ loggedIn: false, lastError: '请先连接知乎账号' })
        return { ok: false, message: '请先连接知乎账号', pushes: existing }
      }
      const settings = await this.store.get()
      const recommendCount = clampCount(settings.zhihuRecommendCount)
      const counterCount = clampCount(settings.zhihuCounterCount)
      const profile = this.profileDigest(settings)
      const capture = await this.gateway.capture(60)
      const candidates = this.buildCandidates(capture.items, profile)
      if (candidates.length === 0) {
        this.saveState({ loggedIn: true, lastError: '推荐流里没有通过质量筛选的候选，请稍后再试' })
        return { ok: false, message: '推荐流里没有通过质量筛选的候选，请稍后再试', pushes: existing }
      }

      let recommendations = this.recommendPicks(candidates, recommendCount)
      let aiRecommended = false
      const ai = this.aiConfig(settings)
      if (ai) {
        try {
          const chosen = await this.pickWithAi(
            ai,
            RECOMMEND_SYSTEM_PROMPT,
            this.buildRecommendPrompt(profile, candidates, recommendCount),
            candidates,
            recommendCount
          )
          if (chosen?.length) {
            recommendations = chosen
            aiRecommended = true
          }
        } catch {
          /* AI 失败退回本地兴趣排序 */
        }
      }
      if (aiRecommended && recommendations.length < recommendCount) {
        const used = new Set(recommendations.map((pick) => pick.candidate.item.itemKey))
        for (const candidate of candidates) {
          if (recommendations.length >= recommendCount) break
          if (used.has(candidate.item.itemKey)) continue
          used.add(candidate.item.itemKey)
          recommendations.push({ candidate, reason: '来自你常看方向的延伸，信息密度较高。' })
        }
      }

      const recommendedKeys = new Set(recommendations.map((pick) => pick.candidate.item.itemKey))
      const counterCandidates = candidates.filter((candidate) => !recommendedKeys.has(candidate.item.itemKey))
      let counters = this.counterPicks(counterCandidates, counterCount)
      let aiPicked = false
      if (ai && counterCandidates.length) {
        try {
          const seeds = recommendations.map((pick) => pick.candidate.item.title)
          const chosen = await this.pickWithAi(
            ai,
            SYSTEM_PROMPT,
            this.buildPrompt(profile, counterCandidates, counterCount, seeds),
            counterCandidates,
            counterCount
          )
          if (chosen?.length) {
            counters = chosen
            aiPicked = true
          }
        } catch {
          /* AI 失败退回本地反选 */
        }
      }
      // AI 可能只挑 1~2 条；用本地反选补足，但绝不和推荐位重复。
      if (aiPicked && counters.length < counterCount) {
        const used = new Set(counters.map((pick) => pick.candidate.item.itemKey))
        for (const candidate of counterCandidates) {
          if (counters.length >= counterCount) break
          if (used.has(candidate.item.itemKey)) continue
          used.add(candidate.item.itemKey)
          counters.push({ candidate, reason: '与推荐位形成对照：同一类议题的另一面，适合换个角度。' })
        }
      }

      this.storePicks(key, 'recommend', recommendations)
      this.storePicks(key, 'counter', counters)
      const pushes = this.rowsByDate(key)
      const active = pushes.filter((push) => push.status === 'pending' || push.status === 'read')
      const recommendTotal = active.filter((push) => push.board === 'recommend').length
      const counterTotal = active.filter((push) => push.board === 'counter').length
      this.saveState({
        loggedIn: true,
        lastSyncAt: this.now().toISOString(),
        lastError: '',
        lastCount: pushes.length,
        lastRecommendCount: recommendTotal,
        lastCounterCount: counterTotal
      })
      const mode = `推荐：${aiRecommended ? 'AI 精选' : '本地兴趣排序'} · 反推荐：${aiPicked ? 'AI 反选' : '本地规则'}`
      return {
        ok: true,
        message: `已生成今日知乎推荐与反推荐（推荐 ${recommendTotal} 条 · 反推荐 ${counterTotal} 条 · ${mode}）`,
        pushes
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auth = error instanceof ZhihuAuthError || /登录|signin/i.test(message)
      this.saveState({ loggedIn: auth ? false : undefined, lastError: message })
      return { ok: false, message, pushes: existing }
    } finally {
      this.generating = false
    }
  }

  /** 条目管理：已读、存为资料、不感兴趣、恢复。 */
  act(id: number, action: ZhihuPushAction, folder?: string): ZhihuOpResult {
    if (!Number.isFinite(id) || id <= 0) return { ok: false, message: '无效的知乎条目' }
    if (!['read', 'save', 'ignore', 'restore'].includes(action)) return { ok: false, message: '无效的操作' }
    const row = this.rowById(id)
    if (!row) return { ok: false, message: '知乎条目不存在' }
    if (action === 'restore') {
      if (row.status !== 'ignored') return { ok: false, message: '只有已忽略的条目可以恢复' }
      this.db.prepare("UPDATE zhihu_push SET status='pending', acted_at=NULL WHERE id=?").run(id)
      return { ok: true, message: '已恢复到待读', pushes: this.rowsByDate(row.date_key) }
    }
    if (action === 'read') {
      if (row.status === 'pending') {
        this.db.prepare("UPDATE zhihu_push SET status='read', acted_at=datetime('now','localtime') WHERE id=?").run(id)
      }
      return { ok: true, message: '已标为已读', pushes: this.rowsByDate(row.date_key) }
    }
    if (action === 'ignore') {
      if (row.status === 'saved') return { ok: false, message: '这条已存为资料，不能忽略' }
      this.db.prepare("UPDATE zhihu_push SET status='ignored', acted_at=datetime('now','localtime') WHERE id=?").run(id)
      return { ok: true, message: '已忽略这条推送', pushes: this.rowsByDate(row.date_key) }
    }

    // save：幂等；先建 info（destination=keep），再挂到资料文件夹
    if (row.status === 'saved') return { ok: true, message: '这条已存为资料', pushes: this.rowsByDate(row.date_key) }
    this.db.exec('SAVEPOINT zhihu_save')
    try {
      const content = [
        row.excerpt,
        '',
        `作者：${row.author || '未知'}`,
        `原文：${row.url}`,
        `${row.board === 'recommend' ? '推荐理由' : '反推荐理由'}：${row.reason}`
      ]
        .join('\n')
        .trim()
      const infoId = createInfo(this.db, {
        source_type: 'zhihu',
        title: row.title,
        content,
        destination: 'keep',
        status: 'keep'
      })
      const saved = saveMaterial(this.db, infoId, folder)
      if (!saved.ok) throw new Error(saved.message)
      this.db
        .prepare("UPDATE zhihu_push SET status='saved', info_id=?, acted_at=datetime('now','localtime') WHERE id=?")
        .run(infoId, id)
      this.db.exec('RELEASE zhihu_save')
      return { ok: true, message: `已存为资料 · ${saved.folderLabel}`, pushes: this.rowsByDate(row.date_key) }
    } catch (error) {
      this.db.exec('ROLLBACK TO zhihu_save; RELEASE zhihu_save')
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
