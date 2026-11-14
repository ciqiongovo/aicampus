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
  BenchExtractResult,
  BenchFetchResult,
  BenchImportResult,
  BenchSourceCategory,
  BenchSourceInfo,
  BenchStats
} from '../../../shared/benchmark'
import { articleUrlKey } from '../../../shared/benchmark'
import type { AiConfigInput } from '../../../shared/types'
import type { SettingsStore } from '../../store/settings'
import * as dao from '../../db/dao/benchmarkDao'
import { composeBrief } from './brief'
import { extractByRules } from './rule-extract'
import { fetchArticle } from './fetcher'
import { VERIFY_BLOCKED } from './page'
import { extractActivity } from './extractor'

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
  ) {}

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
   * 批量入队。接受整段文本：一行一个链接，或直接从聊天记录里粘一段带链接的话都行，
   * 用正则扫出所有 mp.weixin.qq.com 链接，其余字符忽略。
   */
  importLinks(raw: string): BenchImportResult {
    const urls = raw.match(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s"'<>\]]*/g) ?? []
    let accepted = 0
    let duplicated = 0
    let invalid = 0
    const seen = new Set<string>()
    for (const url of urls) {
      const clean = url.split('#')[0]
      const key = articleUrlKey(clean)
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
      if (dao.enqueueArticle(this.db, { urlKey: key, url: clean, sourceId: null })) accepted += 1
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

  private describeFilter(filter: BenchArticleFilter): string {
    const parts: string[] = []
    if (filter.from) parts.push('近一年')
    if (filter.school) parts.push(filter.school)
    if (filter.kind) parts.push(filter.kind)
    if (filter.keyword) parts.push(`“${filter.keyword}”`)
    return parts.length ? parts.join(' · ') : '全部活动'
  }

  // ---------------- 抓取 ----------------

  async runFetch(limit = 20): Promise<BenchFetchResult> {
    if (this.fetching) throw new Error('采集正在进行中')
    this.fetching = true
    const result: BenchFetchResult = { fetched: 0, imageOnly: 0, deleted: 0, unreachable: 0, blocked: false }
    let blockedStreak = 0
    try {
      const queue = dao.pendingArticles(this.db, Math.min(Math.max(limit, 1), 200))
      for (const [i, item] of queue.entries()) {
        if (i > 0) await sleep(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS))
        const outcome = await fetchArticle(item.url, { timeoutMs: FETCH_TIMEOUT_MS })
        if (outcome.status === 'ok') {
          const sourceId = dao.ensureSourceByName(this.db, outcome.author) ?? undefined
          dao.markFetched(this.db, item.id, {
            title: outcome.title,
            author: outcome.author,
            publishedAt: outcome.publishedAt,
            body: outcome.body,
            sourceId
          })
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

  async runExtract(limit = 20): Promise<BenchExtractResult> {
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
      for (const item of queue) {
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
            promoChannels: extracted.promoChannels,
            agenda: extracted.agenda,
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
