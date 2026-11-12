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
import { fetchArticle } from './fetcher'
import { extractActivity } from './extractor'

/** 抓取一篇的最长等待：超过就当这次没拿到，下次重试 */
const FETCH_TIMEOUT_MS = 15000

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

  // ---------------- 抓取 ----------------

  async runFetch(limit = 20): Promise<BenchFetchResult> {
    if (this.fetching) throw new Error('采集正在进行中')
    this.fetching = true
    const result: BenchFetchResult = { fetched: 0, deleted: 0, unreachable: 0 }
    try {
      const queue = dao.pendingArticles(this.db, Math.min(Math.max(limit, 1), 200))
      for (const item of queue) {
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
          result.fetched += 1
        } else {
          dao.markFetchFailed(
            this.db,
            item.id,
            outcome.status === 'deleted' ? 'deleted' : 'unreachable',
            outcome.error
          )
          if (outcome.status === 'deleted') result.deleted += 1
          else result.unreachable += 1
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
    const cfg = await this.aiConfig()
    this.extracting = true
    const result: BenchExtractResult = { activities: 0, skipped: 0, failed: 0 }
    try {
      const queue = dao.pendingExtract(this.db, Math.min(Math.max(limit, 1), 100))
      for (const item of queue) {
        try {
          const extracted = await extractActivity(cfg, { title: item.title, body: item.body })
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
            model: cfg.model
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
  private async aiConfig(): Promise<AiConfigInput> {
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
      apiKey: s.aiApiKey
    }
  }
}
