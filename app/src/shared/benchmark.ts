/**
 * 跨校对标库：共享契约（类型 + IPC 通道）。
 *
 * 与 shared/im.ts 的做法一致：新通道单独成文件，不动 types.ts 里已有的 IPC 常量。
 *
 * 这一层的边界：只描述「一篇推文被采集、被判定、被抽成什么」，不掺任何抓取细节。
 * 抓取方式将来可能从 Electron 窗口换成别的东西，那时这里一个字都不用改。
 */

// ---------- IPC 通道 ----------

export const BENCH_IPC = {
  benchSources: 'bench:sources',
  benchSourceAdd: 'bench:source-add',
  benchSourceToggle: 'bench:source-toggle',
  benchSourceRemove: 'bench:source-remove',
  benchArticles: 'bench:articles',
  benchArticle: 'bench:article',
  benchImportLinks: 'bench:import-links',
  benchFetch: 'bench:fetch',
  benchExtract: 'bench:extract',
  benchStats: 'bench:stats',
  benchSchools: 'bench:schools',
  benchKinds: 'bench:kinds'
} as const

// ---------- 枚举 ----------

/** 账号类型：学院号与团委号的行文习惯差别很大，筛选时要能分开 */
export type BenchSourceCategory = 'student_union' | 'youth_league' | 'college' | 'other'

/**
 * 文章状态机。
 *
 * - new：刚入队，还没抓
 * - fetched：正文已拿到，等待判定 / 抽取
 * - deleted：原文已被发布者删除（这是常态，不是故障，不能算进失败率）
 * - unreachable：内容暂不可见、或网络失败
 * - parsed：已判定并抽取完毕（含判定为「非活动」而跳过的）
 */
export type BenchArticleStatus = 'new' | 'fetched' | 'deleted' | 'unreachable' | 'parsed'

/** 二次通知的类型；改期和取消的处理优先级完全不同，必须分开 */
export type BenchNoticeKind = '' | 'reschedule' | 'venue_change' | 'cancel' | 'other'

// ---------- 实体 ----------

export interface BenchSourceInfo {
  id: number
  /** 公众号原始 id（gh_ 开头）。为空表示只知道名字、还没对上号 */
  ghId: string
  name: string
  school: string
  category: BenchSourceCategory
  enabled: boolean
  articleCount: number
  lastArticleAt: string | null
}

export interface BenchArticleInfo {
  id: number
  sourceId: number | null
  school: string
  sourceName: string
  title: string
  url: string
  publishedAt: string | null
  status: BenchArticleStatus
  /** null = 还没判定 */
  isActivity: boolean | null
  /** 活动类型（迎新晚会、讲座、比赛…），未抽取时为空 */
  kind: string
  /** 举办周次，未抽取或无法换算时为 null */
  weekNo: number | null
  /** 是否二次通知（改期/场地变更/取消） */
  isSecondNotice: boolean
  noticeKind: BenchNoticeKind
  /** 可迁移性，未评为空串 */
  migrationFit: BenchMigrationFit
  fetchedAt: string | null
  error: string
}

export interface BenchActivityInfo {
  articleId: number
  /** 活动类型：迎新晚会、毕业季活动、讲座、竞赛… */
  kind: string
  organizer: string
  startAt: string | null
  endAt: string | null
  /**
   * 举办周次：原文若写了「第 X 周」直接取；没写则由 service 用学期开学日换算。
   * 报名表里承诺的是「举办周次」，不是一个具体日期——各校校历不同，
   * 同一件事在 A 校是第 2 周、在 B 校是第 4 周，周次才是可比的口径。
   */
  weekNo: number | null
  location: string
  /** 面向对象：全校 / 本院 / 新生 / 毕业生… */
  audience: string
  /** 组织方式：线上还是线下、独办还是联办、报名制还是自由参加 */
  orgForm: string
  /** 参与方式：报名、抢票、扫码进群… */
  joinMethod: string
  /** 宣传形式：直播、抽奖、海报、短视频… */
  promoChannels: string[]
  /** 议程与特色环节：各校「学生会全体大会」的差别主要在这些环节上 */
  agenda: string[]
  isSecondNotice: boolean
  noticeKind: BenchNoticeKind
  /** 可迁移性：结合本校条件，这件事搬过来做不做得到 */
  migrationFit: BenchMigrationFit
  /** 为什么能／不能搬，一句话，附原文依据 */
  migrationNote: string
  /** 模型自评置信度，低于阈值一律标记待人工核对 */
  confidence: number
  model: string
  extractedAt: string | null
}

/** 可迁移性判断。空串 = 还没评；其余四档由模型结合本校条件给出 */
export type BenchMigrationFit = '' | 'easy' | 'possible' | 'hard' | 'unsuitable'

export interface BenchArticleDetail extends BenchArticleInfo {
  /** 正文纯文本，仅用于本地阅读与重抽，不对外 */
  body: string
  activity: BenchActivityInfo | null
}

// ---------- 请求 ----------

export interface BenchArticleFilter {
  school?: string
  kind?: string
  /** YYYY-MM-DD，含边界 */
  from?: string
  to?: string
  /** 只看二次通知 */
  secondNoticeOnly?: boolean
  /** 关键词语义筛选交给上层，这里只做标题 LIKE */
  keyword?: string
  limit?: number
  offset?: number
}

export interface BenchImportResult {
  /** 入队成功的条数 */
  accepted: number
  /** 同一 __biz+mid+idx 已在库里的条数 */
  duplicated: number
  /** 连 __biz 都解析不出来的条数 */
  invalid: number
}

export interface BenchFetchResult {
  fetched: number
  deleted: number
  unreachable: number
}

export interface BenchExtractResult {
  /** 判定为活动并抽出字段 */
  activities: number
  /** 判定为非活动，归档 */
  skipped: number
  /** 模型调用失败，留在 fetched 状态等重试 */
  failed: number
}

export interface BenchStats {
  sources: number
  articles: number
  activities: number
  deleted: number
  /** 最近一次采集完成时间 */
  lastFetchAt: string | null
}

// ---------- 渲染层可见的 API ----------

/** 方法名与 BENCH_IPC 的键一一对应，preload 按表生成，避免手写漏项 */
export interface BenchApi {
  benchSources(): Promise<BenchSourceInfo[]>
  benchSourceAdd(input: {
    ghId?: string
    name: string
    school: string
    category?: BenchSourceCategory
  }): Promise<number>
  benchSourceToggle(id: number, enabled: boolean): Promise<boolean>
  benchSourceRemove(id: number): Promise<boolean>
  benchArticles(filter: BenchArticleFilter): Promise<BenchArticleInfo[]>
  benchArticle(id: number): Promise<BenchArticleDetail | null>
  benchImportLinks(text: string): Promise<BenchImportResult>
  benchFetch(limit?: number): Promise<BenchFetchResult>
  benchExtract(limit?: number): Promise<BenchExtractResult>
  benchStats(): Promise<BenchStats>
  benchSchools(): Promise<string[]>
  benchKinds(): Promise<string[]>
}

// ---------- 工具 ----------

/**
 * 把公众号链接归一化成去重键。
 *
 * 同一篇文章会被不同渠道转发成不同 URL：中间可能夹 scene/chksm/xtrack，
 * 顺序也会变；但 __biz + mid + idx 三者一定相同。所以只用这三个做键，
 * 不拿整条 URL 当唯一约束，否则同一篇会被采好几次。
 *
 * 分享短链（mp.weixin.qq.com/s/AbCdEf）里没有 biz/mid，退化为按路径做键。
 * 这种链无法识别「两条短链是不是同一篇」，但至少不会在导入时被当成无效丢掉。
 */
export function articleUrlKey(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (!/(^|\.)mp\.weixin\.qq\.com$/.test(parsed.hostname)) return null
    const biz = parsed.searchParams.get('__biz')
    const mid = parsed.searchParams.get('mid') ?? parsed.searchParams.get('appmsgid')
    const idx = parsed.searchParams.get('idx') ?? '1'
    if (biz && mid) return `${biz}:${mid}:${idx}`
    const short = parsed.pathname.replace(/\/+$/, '')
    return short && short !== '/s' ? `short:${short}` : null
  } catch {
    return null
  }
}

/**
 * 从 "2026年10月28日 08:16" / "2026-10-28 08:16" / "2026/10/28" 中抽日期时间。
 *
 * 抽不到返回 null —— 宁可空着，也不要编一个像样的时间出来。页面结构一变，
 * 这里只会返回空，不会返回错误的时间，下游按空值处理即可。
 */
export function parsePublishTime(text: string): string | null {
  if (!text) return null
  const m = text.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/)
  if (!m) return null
  const [, y, mo, d] = m
  const tail = text.slice(text.indexOf(m[0]) + m[0].length)
  const t = tail.match(/(\d{1,2}):(\d{2})/)
  const pad = (n: string): string => n.padStart(2, '0')
  const date = `${y}-${pad(mo)}-${pad(d)}`
  return t ? `${date} ${pad(t[1])}:${t[2]}:00` : date
}
