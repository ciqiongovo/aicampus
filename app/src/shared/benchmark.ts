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
  benchKinds: 'bench:kinds',
  benchBrief: 'bench:brief'
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
  /** 纯图推送：页面正常但正文全在图片里，已归档、不计入失败 */
  imageOnly: number
  deleted: number
  unreachable: number
  /**
   * 是否因为连续撞上微信人机验证而提前收工。
   * 这个不是「失败了几篇」，而是「再抓下去也没用」——界面要提示用户歇一会儿，
   * 而不是让他看着一串红色的失败标记反复点。
   */
  blocked: boolean
}

export interface BenchExtractResult {
  /**
   * 这次用的是模型还是规则。
   * 必须回传给界面：规则抽取只认类型、时间、地点，抽不到议程和可迁移性，
   * 用户得知道手上这批数据是怎么来的，才不会拿它当完整结论。
   */
  mode: 'llm' | 'rule'
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

// ---------- 简报 ----------

/**
 * 简报里的一条活动。
 *
 * 只放「念得出口」的字段：老师问的是「别的学校毕业季怎么做的」，
 * 他要的是学校、什么时候、在哪、怎么办的、能不能照做，不是数据库全字段。
 */
export interface BenchBriefItem {
  id: number
  school: string
  sourceName: string
  title: string
  url: string
  publishedAt: string | null
  kind: string
  /** 举办周次（估算，按秋季 9 月 1 日起算） */
  weekNo: number | null
  startAt: string | null
  location: string
  orgForm: string
  audience: string
  agenda: string[]
  /** 宣传形式：预热、抽奖、直播这类手段，原文里出现的 */
  promoChannels: string[]
  migrationFit: BenchMigrationFit
  migrationNote: string
  /** 抽取把握，低于 0.7 的会被标注「待核对」 */
  confidence: number
}

export interface BenchBrief {
  /** 一句话标题，如「近一年迎新晚会对标简报」 */
  title: string
  generatedAt: string
  /** 覆盖的学校数 / 活动数 */
  schoolCount: number
  activityCount: number
  /** 按学校分组的条数，用于概览那一段 */
  perSchool: { school: string; count: number }[]
  items: BenchBriefItem[]
  /** 已经排版好的 Markdown，直接可粘进文档或群聊 */
  markdown: string
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
  /** 按当前筛选条件生成简报；同条件重复调用结果一致，不做缓存 */
  benchBrief(filter: BenchArticleFilter): Promise<BenchBrief>
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
 * 上海高校名单与简称。
 *
 * 判学校不能只靠「去掉『学生会』三个字」：那只能对付「复旦大学学生会」这一种写法，
 * 遇上「团聚上大」「社彩同济」「上海交大安泰EMBA」就全落空，
 * 而真实的公众号名恰恰大量使用简称——学生自己做的号很少规规矩矩写全称。
 *
 * 顺序无关，匹配时取命中别名最长的那个，避免「上海大学」被「上海」类前缀抢走。
 */
const SHANGHAI_SCHOOLS: { school: string; aliases: string[] }[] = [
  { school: '复旦大学', aliases: ['复旦大学', '复旦'] },
  { school: '上海交通大学', aliases: ['上海交通大学', '上海交大', '交大'] },
  { school: '同济大学', aliases: ['同济大学', '同济'] },
  { school: '华东师范大学', aliases: ['华东师范大学', '华东师大', '华师大', '华师'] },
  { school: '华东理工大学', aliases: ['华东理工大学', '华东理工', '华理'] },
  { school: '上海大学', aliases: ['上海大学', '上大'] },
  { school: '东华大学', aliases: ['东华大学', '东华'] },
  { school: '上海外国语大学', aliases: ['上海外国语大学', '上海外国语', '上外'] },
  { school: '上海财经大学', aliases: ['上海财经大学', '上海财经', '上财'] },
  { school: '上海理工大学', aliases: ['上海理工大学', '上海理工', '上理'] },
  { school: '上海师范大学', aliases: ['上海师范大学', '上海师范', '上师大'] },
  { school: '上海海事大学', aliases: ['上海海事大学', '上海海事', '海事大学'] },
  { school: '上海中医药大学', aliases: ['上海中医药大学', '上海中医药', '中医大'] },
  { school: '上海对外经贸大学', aliases: ['上海对外经贸大学', '对外经贸', '上贸大'] },
  { school: '上海工程技术大学', aliases: ['上海工程技术大学', '工程技术大学'] },
  { school: '上海应用技术大学', aliases: ['上海应用技术大学', '应用技术大学', '上应大'] },
  { school: '上海电力大学', aliases: ['上海电力大学', '上海电力', '上电'] },
  { school: '上海立信会计金融学院', aliases: ['上海立信会计金融学院', '立信会计', '立信'] },
  { school: '上海政法学院', aliases: ['上海政法学院', '上政'] },
  { school: '上海体育大学', aliases: ['上海体育大学', '上海体育学院', '上体'] },
  { school: '上海科技大学', aliases: ['上海科技大学', '上科大'] },
  { school: '上海音乐学院', aliases: ['上海音乐学院', '上音'] },
  { school: '上海戏剧学院', aliases: ['上海戏剧学院', '上戏'] },
  { school: '上海第二工业大学', aliases: ['上海第二工业大学', '二工大'] },
  { school: '上海电机学院', aliases: ['上海电机学院', '电机学院'] },
  { school: '上海商学院', aliases: ['上海商学院'] },
  { school: '上海健康医学院', aliases: ['上海健康医学院', '健康医学院'] },
  { school: '上海海关学院', aliases: ['上海海关学院', '海关学院'] }
]

/** 中小学、择校平台混进来会污染统计——对标的是高校，不是 K12 */
const NOT_UNIVERSITY = /中学|小学|附中|高中|幼儿园|国际学校|择校|升学|留学|考研|专升本/

/**
 * 从公众号名猜学校。
 *
 * 猜错了用户能改，但不猜的话每一条都要手填学校，二十个号就是二十次重复劳动。
 * 分三步：先查上海高校简称表（准确），再退化为「去掉组织后缀」，最后不行就留空。
 * 刻意不猜外省市高校：这个库对标的是上海兄弟高校，猜成「南京师范大学」
 * 只会让筛选器里多出一堆用不上的选项。
 */
export function guessSchool(sourceName: string): string {
  const name = sourceName.replace(/\s+/g, '').trim()
  if (!name) return ''
  if (NOT_UNIVERSITY.test(name)) return ''

  let best: { school: string; len: number } | null = null
  for (const item of SHANGHAI_SCHOOLS) {
    for (const alias of item.aliases) {
      if (!name.includes(alias)) continue
      if (!best || alias.length > best.len) best = { school: item.school, len: alias.length }
    }
  }
  if (best) return best.school

  // 兜底：名字里明确带「大学/学院」的，取到该词为止，至少能分得开不同学校
  const generic = name.match(/^[\u4e00-\u9fa5]{2,12}?(?:大学|学院)/)
  if (generic) return generic[0]
  return ''
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
