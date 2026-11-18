/**
 * 跨校对标库的编排层。
 *
 * 只做三件事：把链接入队、把队里的抓下来、把抓到的抽成字段。
 * 具体的 SQL 在 dao，具体的抓取在 fetcher，具体的提示词在 extractor。
 *
 * 有个刻意的取舍：抓取和抽取都串行跑。并行能把 20 篇从 2 分钟压到 30 秒，
 * 但公众号页面对同一 IP 的并发很敏感，一旦触发验证，整批都拿不到正文。
 * 慢一点换稳定，对学生会在群里等一会儿这件事，是值得的。
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  BenchArticleDetail,
  BenchArticleFilter,
  BenchArticleInfo,
  BenchBrief,
  BenchDiscoverResult,
  BenchExtractResult,
  BenchFetchResult,
  BenchImportResult,
  BenchProspectInfo,
  BenchSchoolInfo,
  BenchAuditResult,
  BenchSuspiciousActivity,
  BenchSourceCategory,
  BenchSourceInfo,
  BenchStats
} from '../../../shared/benchmark'
import { articleUrlKey, guessSchool } from '../../../shared/benchmark'
import {
  HOME_SCHOOL,
  KNOWN_ACCOUNTS,
  SHANGHAI_SCHOOLS,
  candidateAccounts,
  findSchool,
  mergeAccounts
} from '../../../shared/schools'
import type { AiConfigInput } from '../../../shared/types'
import type { SettingsStore } from '../../store/settings'
import * as dao from '../../db/dao/benchmarkDao'
import { composeBrief } from './brief'
import { buildReportHtml } from './report'
import { extractByRules, offTopicReason } from './rule-extract'
import { parseLinkRows } from './link-import'
import { fetchArticle } from './fetcher'
import { VERIFY_BLOCKED } from './page'
import { extractActivity } from './extractor'
import { discoverSchool, DEFAULT_ACCOUNT_LIMIT } from './discover'
import type { DiscoverProgress } from './discover'
import { readSeeds } from './seeds'

/** 抓取一篇的最长等待：超过就当这次没拿到，下次重试 */
const FETCH_TIMEOUT_MS = 15000

/** 两篇之间的间隔。微信对同一出口 IP 的连续访问有阈值，抓得太密会整批被挡 */
const GAP_MIN_MS = 2500
const GAP_MAX_MS = 5500

/** 连续几次撞验证就停手，免得把整个队列刷成失败 */
const VERIFY_BREAKER = 3

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class BenchmarkService {
  private fetching = false
  private extracting = false

  constructor(
    private readonly db: DatabaseSync,
    private readonly settings: SettingsStore
  ) {
    // 内置名单只在缺项时补，不会覆盖用户改过的本校或开关
    dao.seedSchools(this.db, SHANGHAI_SCHOOLS, HOME_SCHOOL, KNOWN_ACCOUNTS)
  }

  // ---------------- 源 ----------------

  sources(): BenchSourceInfo[] {
    return dao.listSources(this.db)
  }

  addSource(input: { ghId?: string; name: string; school: string; category?: BenchSourceCategory }): number {
    if (!input.name.trim()) throw new Error('公众号名称不能为空')
    return dao.upsertSource(this.db, {
      ghId: input.ghId?.trim(),
      name: input.name.trim(),
      school: input.school.trim(),
      category: input.category ?? 'student_union'
    })
  }

  toggleSource(id: number, enabled: boolean): void {
    dao.setSourceEnabled(this.db, id, enabled)
  }

  removeSource(id: number): void {
    dao.removeSource(this.db, id)
  }

  schools(): string[] {
    return dao.listSchools(this.db)
  }

  kinds(): string[] {
    return dao.listKinds(this.db)
  }

  // ---------------- 文章 ----------------

  /**
   * 批量入队。接受整段文本：一行一个链接、从聊天记录里连文字一起粘，
   * 或者 wechatDownload 导出的 CSV 整份内容。
   *
   * CSV 里的标题和时间会先落库。正文还没抓的时候，列表至少能看出
   * 这个号有多少篇、都是什么时候发的，而不是一片空白。
   */
  importLinks(raw: string): BenchImportResult {
    const rows = parseLinkRows(raw)
    let accepted = 0
    let duplicated = 0
    let invalid = 0
    const seen = new Set<string>()
    for (const row of rows) {
      const key = articleUrlKey(row.url)
      if (!key) {
        invalid += 1
        continue
      }
      // 同一批里重复粘贴的，算重复而不是新入队
      if (seen.has(key)) {
        duplicated += 1
        continue
      }
      seen.add(key)
      const ok = dao.enqueueArticle(this.db, {
        urlKey: key,
        url: row.url,
        sourceId: null,
        title: row.title,
        publishedAt: row.publishedAt
      })
      if (ok) accepted += 1
      else duplicated += 1
    }
    return { accepted, duplicated, invalid }
  }

  articles(filter: BenchArticleFilter): BenchArticleInfo[] {
    return dao.listArticles(this.db, filter)
  }

  article(id: number): BenchArticleDetail | null {
    const row = dao.getArticle(this.db, id)
    if (!row) return null
    return { ...row, activity: dao.getActivity(this.db, id) }
  }

  stats(): BenchStats {
    return dao.stats(this.db)
  }

  /**
   * 生成简报。
   *
   * 筛选条件直接复用列表那套，所以「界面上看到什么，简报里就是什么」——
   * 老师问的时候不用重新组织口径，眼前这一屏就是答案。
   */
  brief(filter: BenchArticleFilter): BenchBrief {
    const items = dao.briefRows(this.db, filter)
    const label = this.describeFilter(filter)
    return composeBrief(items, label, new Date())
  }

  /**
   * HTML 版报告。
   *
   * 与 brief 走同一个筛选、同一份数据，只是换一种排法——不存在「简报和报告数字对不上」的可能，
   * 因为它们本来就是同一次计算的两个出口。
   */
  report(filter: BenchArticleFilter): string {
    return buildReportHtml(this.brief(filter))
  }

  private describeFilter(filter: BenchArticleFilter): string {
    const parts: string[] = []
    if (filter.from) parts.push('近一年')
    if (filter.school) parts.push(filter.school)
    if (filter.kind) parts.push(filter.kind)
    if (filter.keyword) parts.push(`“${filter.keyword}”`)
    return parts.length ? parts.join(' · ') : '全部活动'
  }

  // ---------------- 学校与发现 ----------------

  /**
   * 可选学校清单。
   *
   * candidates 给的是「打算怎么搜」，不是「已知有哪些号」——界面上必须分开说。
   */
  schoolList(): BenchSchoolInfo[] {
    return dao.listSchoolInfos(this.db, (name, known) =>
      mergeAccounts(known, candidateAccounts(findSchool(name)))
    )
  }

  toggleSchool(name: string, enabled: boolean): void {
    dao.setSchoolEnabled(this.db, name, enabled)
  }

  setHomeSchool(name: string): void {
    if (!name.trim()) throw new Error('学校名不能为空')
    dao.setHomeSchool(this.db, name)
  }

  candidates(name: string): string[] {
    return mergeAccounts(dao.knownAccountsOf(this.db, name), candidateAccounts(findSchool(name)))
  }

  /**
   * 按学校去搜文章。
   *
   * 这个方法会跑几十秒：每个账号之间要停三五秒，不然会立刻触发限流。
   * 所以它接受一个进度回调，界面据此显示「第几个、在搜谁」，
   * 而不是让人对着一个转圈的按钮猜是不是卡死了。
   */
  async discover(
    name: string,
    accounts?: string[],
    onProgress?: (p: DiscoverProgress) => void
  ): Promise<BenchDiscoverResult> {
    return discoverSchool(this.db, {
      school: name,
      accounts,
      limit: accounts?.length ?? DEFAULT_ACCOUNT_LIMIT,
      onProgress
    })
  }

  prospects(school?: string): BenchProspectInfo[] {
    return dao.listProspects(this.db, school)
  }

  /**
   * 数据体检：挑出归属不明的公众号。
   *
   * 不自动清理。机器只知道「这个号没被归到任何一所已知学校」，
   * 而「华东师大二附中」这类附属中学、以及「青春SUES」这种纯英文简称，
   * 都可能是正经号。列出来让人看，比替人做决定安全。
   */
  audit(): BenchAuditResult {
    const allowed = this.schoolList().map((s) => s.name)
    const suspicious = dao.auditSources(this.db, allowed)
    return {
      suspicious,
      articleCount: suspicious.reduce((n, s) => n + s.articleCount, 0),
      offTopic: this.auditActivities()
    }
  }

  /**
   * 按现在的词表复查已入库的活动。
   *
   * 只查不删：库里的判定是抽取当时做的，规则后来才变严。自动重判等于没打招呼
   * 就动用户的数据，而且规则也会误伤——「优秀毕业生分享会」和
   * 「优秀毕业生胡豆豆」只差几个字，机器分不清的地方要留给人看。
   */
  private auditActivities(): BenchSuspiciousActivity[] {
    return dao
      .listActivityTitles(this.db)
      .map((row) => ({ row, reason: offTopicReason(row.title) }))
      .filter((x): x is { row: (typeof x)['row']; reason: string } => !!x.reason)
      .map((x) => ({
        articleId: x.row.articleId,
        title: x.row.title,
        school: x.row.school,
        kind: x.row.kind,
        reason: x.reason
      }))
  }

  purgeSources(ids: number[]): { articles: number; sources: number } {
    return dao.purgeSources(this.db, ids)
  }

  markNotActivity(articleId: number): boolean {
    return dao.markNotActivity(this.db, articleId)
  }

  markNotActivityMany(articleIds: number[]): number {
    return dao.markNotActivityMany(this.db, articleIds)
  }

  setSourceSchool(id: number, school: string): boolean {
    const name = school.trim()
    // 只认清单里的学校名：随手敲个错别字，这篇文章就再也不会出现在任何学校的筛选里
    if (name && !this.schoolList().some((s) => s.name === name)) return false
    return dao.setSourceSchool(this.db, id, name)
  }

  /**
   * 导入随安装包带来的样本链接。
   *
   * 为什么要有这个：新装一份软件，库是空的。要想看到东西，先得自己去搜链接，
   * 而搜索有配额。带一批已知能用的链接，装上就能看见「兄弟高校到底在干什么」，
   * 这件事决定了别人会不会继续用下去。
   */
  seedImport(school?: string): BenchImportResult {
    const seeds = readSeeds().filter((s) => !school || s.school === school)
    let accepted = 0
    let duplicated = 0
    let invalid = 0
    for (const seed of seeds) {
      const key = articleUrlKey(seed.url)
      if (!key) {
        invalid += 1
        continue
      }
      const added = dao.enqueueArticle(this.db, {
        urlKey: key,
        url: seed.url,
        sourceId: null,
        hintSchool: seed.school
      })
      if (added) accepted += 1
      else duplicated += 1
    }
    return { accepted, duplicated, invalid }
  }

  /** 本校同类活动：给一个外校做法，配几条本校的做法，才能比 */
  homeCompare(articleId: number): BenchArticleDetail[] {
    return dao
      .homePeerArticleIds(this.db, articleId)
      .map((id) => this.article(id))
      .filter((x): x is BenchArticleDetail => !!x)
  }

  // ---------------- 抓取 ----------------

  /**
   * 采正文。
   *
   * onProgress 是给界面用的：一批 20 篇要跑一两分钟，没有进度条的话
   * 用户只能对着一个转圈的按钮猜是不是卡死了。
   */
  async runFetch(limit = 20, onProgress?: (p: DiscoverProgress) => void): Promise<BenchFetchResult> {
    if (this.fetching) throw new Error('采集正在进行中')
    this.fetching = true
    const result: BenchFetchResult = { fetched: 0, imageOnly: 0, deleted: 0, unreachable: 0, blocked: false }
    let blockedStreak = 0
    try {
      // 把挂了一阵的「打不开」放回队列再取。
      // 不做这一步的话，unreachable 就是终态——界面上写着「过一阵会自动重试」，
      // 实际上永远不会重试，那句提示是假的；「跑完队列」也永远清不掉它们。
      dao.resetUnreachable(this.db)
      const queue = dao.pendingArticles(this.db, Math.min(Math.max(limit, 1), 200))
      for (const [i, item] of queue.entries()) {
        if (i > 0) await sleep(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS))
        onProgress?.({
          current: i + 1,
          total: queue.length,
          // 这一批还没采到正文，标题未知。显示学校比显示链接尾段有用得多
          // ——「mp.weixin.qq.com/s?__biz=MzA5...」对谁都没有意义。
          account: item.hintSchool,
          note: ''
        })
        const outcome = await fetchArticle(item.url, { timeoutMs: FETCH_TIMEOUT_MS })
        if (outcome.status === 'ok') {
          const sourceId =
            dao.ensureSourceByName(this.db, outcome.author, item.hintSchool) ?? undefined
          dao.markFetched(this.db, item.id, {
            title: outcome.title,
            author: outcome.author,
            publishedAt: outcome.publishedAt,
            body: outcome.body,
            sourceId
          })
          // 抓到真名了，记下来。下次找这所学校就不用再赌名字对不对。
          // 但要先验证这个号确实属于这所学校：从「上海科技大学」的搜索里，
          // 一样能搜出「北京科技大学」的文章，把后者记成上科大的号就错了。
          if (outcome.author && item.hintSchool) {
            const belonging = guessSchool(outcome.author)
            if (!belonging || belonging === item.hintSchool) {
              dao.rememberAccount(this.db, item.hintSchool, outcome.author)
            }
          }
          if (outcome.imageOnly) {
            dao.markSkipped(this.db, item.id, outcome.error)
            result.imageOnly += 1
          } else {
            result.fetched += 1
          }
          blockedStreak = 0
        } else {
          dao.markFetchFailed(
            this.db,
            item.id,
            outcome.status === 'deleted' ? 'deleted' : 'unreachable',
            outcome.error
          )
          if (outcome.status === 'deleted') {
            result.deleted += 1
            blockedStreak = 0
          } else {
            result.unreachable += 1
            if (outcome.error === VERIFY_BLOCKED) {
              blockedStreak += 1
              if (blockedStreak >= VERIFY_BREAKER) {
                // 剩下的没动，保持 new 状态，等会儿还能接着抓
                result.blocked = true
                break
              }
            }
          }
        }
      }
      return result
    } finally {
      this.fetching = false
    }
  }

  // ---------------- 抽取 ----------------

  async runExtract(limit = 20, onProgress?: (p: DiscoverProgress) => void): Promise<BenchExtractResult> {
    if (this.extracting) throw new Error('抽取正在进行中')
    // 没配模型不代表不能抽：退回规则抽取，至少把类型、时间、地点填上。
    // 直接抛错会让人卡在「必须先配 key」这一步，而那和「能不能看到东西」是两件事。
    const cfg = await this.aiConfig().catch(() => null)
    this.extracting = true
    const result: BenchExtractResult = {
      mode: cfg ? 'llm' : 'rule',
      activities: 0,
      skipped: 0,
      failed: 0
    }
    try {
      const queue = dao.pendingExtract(this.db, Math.min(Math.max(limit, 1), 100))
      for (const [i, item] of queue.entries()) {
        onProgress?.({
          current: i + 1,
          total: queue.length,
          account: item.title || '（无标题）',
          note: ''
        })
        try {
          const extracted = cfg
            ? await extractActivity(cfg, { title: item.title, body: item.body }, cfg.ourContext)
            : extractByRules({
                title: item.title,
                body: item.body,
                publishedAt: item.publishedAt
              })
          if (!extracted.isActivity) {
            dao.markSkipped(this.db, item.id)
            result.skipped += 1
            continue
          }
          dao.upsertActivity(this.db, item.id, {
            kind: extracted.kind,
            organizer: extracted.organizer,
            startAt: extracted.startAt,
            endAt: extracted.endAt,
            weekNo: extracted.weekNo,
            location: extracted.location,
            audience: extracted.audience,
            orgForm: extracted.orgForm,
            joinMethod: extracted.joinMethod,
            coOrganizer: extracted.coOrganizer,
            duration: extracted.duration,
            scale: extracted.scale,
            promoChannels: extracted.promoChannels,
            agenda: extracted.agenda,
            highlights: extracted.highlights,
            isSecondNotice: extracted.isSecondNotice,
            noticeKind: extracted.noticeKind,
            migrationFit: extracted.migrationFit,
            migrationNote: extracted.migrationNote,
            confidence: extracted.confidence,
            model: cfg ? cfg.model : 'rule'
          })
          result.activities += 1
        } catch (error) {
          dao.markExtractFailed(
            this.db,
            item.id,
            error instanceof Error ? error.message : String(error)
          )
          result.failed += 1
        }
      }
      return result
    } finally {
      this.extracting = false
    }
  }

  /** 从设置里取模型配置；没配就直说缺什么，不要让用户对着一个泛泛的失败重试 */
  /** 抽出本校条件，随配置一起传下去 */
  private async aiConfig(): Promise<AiConfigInput & { ourContext: string }> {
    const s = await this.settings.get()
    if (!s.aiBaseURL || !s.aiModel) {
      throw new Error('还没有配置模型：请在「设置 → AI 服务」里填端点和模型，再回来抽取')
    }
    if (!s.aiApiKey && !s.aiIsLocal) {
      throw new Error('还没有配置模型密钥：请在「设置 → AI 服务」里填写')
    }
    return {
      provider: s.aiProvider,
      baseURL: s.aiBaseURL,
      model: s.aiModel,
      apiKey: s.aiApiKey,
      ourContext: s.benchOurContext
    }
  }
}
