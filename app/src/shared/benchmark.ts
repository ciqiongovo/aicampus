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
  /** 选一个 CSV / TXT 文件，整份导入。工具导出的文章列表走这条 */
  benchImportFile: 'bench:import-file',
  benchFetch: 'bench:fetch',
  benchExtract: 'bench:extract',
  benchStats: 'bench:stats',
  benchSchools: 'bench:schools',
  benchKinds: 'bench:kinds',
  benchBrief: 'bench:brief',
  /** 同一批条目的 HTML 报告，样式内联，可直接打印或发给别人 */
  benchReport: 'bench:report',
  // ---- v1.0：选学校采集 ----
  benchSchoolList: 'bench:school-list',
  benchSchoolToggle: 'bench:school-toggle',
  benchSchoolHome: 'bench:school-home',
  benchSchoolCandidates: 'bench:school-candidates',
  benchDiscover: 'bench:discover',
  /** 搜狗深度采集：一个号翻到底，正文当场入库 */
  benchDeepCollect: 'bench:deep-collect',
  benchProspects: 'bench:prospects',
  benchSeedImport: 'bench:seed-import',
  benchHomeCompare: 'bench:home-compare',
  // ---- 数据体检 ----
  benchAudit: 'bench:audit',
  benchPurgeSources: 'bench:purge-sources',
  benchSourceSchool: 'bench:source-school',
  benchMarkNotActivity: 'bench:mark-not-activity',
  benchMarkNotActivityMany: 'bench:mark-not-activity-many'
} as const

/**
 * 进度推送通道。
 *
 * 不放进 BENCH_IPC：那张表里的每一项都会被 preload 生成成 invoke 方法，
 * 而进度是主进程主动推过来的，方向相反。混在一起会多出一个永远没人用的方法。
 */
export const BENCH_PROGRESS_CHANNEL = 'bench:progress'

export interface BenchProgressEvent {
  school: string
  current: number
  total: number
  account: string
  note: string
}

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

/**
 * 一所可选的对标学校。
 *
 * 这张清单决定「要去谁家找」，不是「已经采到了谁」。两者必须分开显示：
 * 勾了复旦不等于已经有复旦的数据，否则用户会以为点一下就有。
 */
export interface BenchSchoolInfo {
  id: number
  name: string
  shortName: string
  /** 本校。对标的意义在于替本校做决定，本校自己要有一行基准 */
  isHome: boolean
  /** 是否在采集范围内 */
  enabled: boolean
  /** 库里该校已有多少篇文章 */
  articleCount: number
  /** 库里该校已抽出多少场活动 */
  activityCount: number
  /** 已确认存在的公众号数 */
  sourceCount: number
  /** 这一轮打算去搜的账号名：查证过的在前，按套路猜的在后 */
  candidates: string[]
  /** 其中已经查证确实存在的号。这批不用再搜名字对不对，直接能用 */
  knownAccounts: string[]
}

/**
 * 待发现的公众号。
 *
 * untried：还没搜过
 * found：搜到过文章，可以当源用
 * empty：搜过但一条微信链接都没有（账号名猜错了，或这个号根本不存在）
 * blocked：撞上搜索验证码，等冷却
 */
export type BenchProspectStatus = 'untried' | 'found' | 'empty' | 'blocked'

export interface BenchProspectInfo {
  id: number
  school: string
  accountName: string
  category: BenchSourceCategory
  status: BenchProspectStatus
  hitCount: number
  lastTriedAt: string | null
  note: string
}

export interface BenchDiscoverResult {
  /** 这次实际发出的搜索请求数 */
  requests: number
  /** 新入队的文章数 */
  accepted: number
  /** 已存在跳过的 */
  duplicated: number
  /** 搜到链接的账号数 */
  accountsHit: number
  /**
   * 是否因为连续撞验证码而提前收工。
   * 这不是「什么都没找到」，是「现在再搜也是白费」，界面必须分开说。
   */
  blocked: boolean
  /** 人话版的收工原因，直接显示给用户 */
  message: string
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
  /** 是否本校。本校条目在列表里要标出来，它是基准行，不是要模仿的对象 */
  isHome: boolean
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
  /** 协办单位：学院、社团、赞助方。联办是很多活动办得起来的原因，不能只看主办 */
  coOrganizer: string
  /** 活动时长：一晚 / 两天 / 持续一周，决定了它占多少人力 */
  duration: string
  /** 规模：参与人数、观众规模，原文写了才有 */
  scale: string
  /** 宣传形式：直播、抽奖、海报、短视频… */
  promoChannels: string[]
  /** 议程与特色环节：各校「学生会全体大会」的差别主要在这些环节上 */
  agenda: string[]
  /**
   * 特色环节：这个活动里最不一样的那几处。
   * 与 agenda 分开是因为用途不同——议程回答「流程怎么走」，特色回答「凭什么值得学」。
   */
  highlights: string[]
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
  /** 表里认出来的公众号个数；纯链接粘贴时为 0 */
  accounts: number
}

export interface BenchImportFileResult extends BenchImportResult {
  /** 用户在选文件框里点了取消 */
  canceled: boolean
  /** 实际读的文件的绝对路径，取消时为空串 */
  file: string
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

/**
 * 一个「不属于任何已知学校」的公众号。
 *
 * 来源有两种：早期搜索没给账号名加引号时被拆词匹配带进来的别校号，
 * 以及名字里根本看不出学校的营销号 / 地方号。它们会污染「覆盖 N 所学校」
 * 这类统计，所以单独列出来让人自己判断要不要清。
 */
export interface BenchSuspiciousSource {
  id: number
  name: string
  school: string
  articleCount: number
  /**
   * 最新一篇的标题。
   *
   * 「青春SUES」「SIT星光化工」这种号，光看名字没人知道是谁，
   * 看一眼标题就能认出来（SUES 是上海工程技术大学）。这一列是给人做判断用的。
   */
  sample: string
}

/**
 * 一条被当前规则判定为「不像活动」的条目。
 *
 * 库里的活动是抽取当时判的，规则后来会变严（人物报道、候选人公示、月度汇总
 * 都是一开始漏掉的形态）。已经抽过的条目不会自动重判——那等于没打招呼就删人数据——
 * 所以列出来让人自己决定。
 */
export interface BenchSuspiciousActivity {
  articleId: number
  title: string
  school: string
  kind: string
  /** 为什么判它不像一场活动：人物报道 / 名单公示 / 会议通报 / 合集汇总 / 招生与建制 / 说明文 */
  reason: string
}

export interface BenchAuditResult {
  suspicious: BenchSuspiciousSource[]
  /** 这些源名下的文章总数，用于「有 N 篇会被算错学校」那句提示 */
  articleCount: number
  /** 已入库、但按现在的规则不算活动的那几条 */
  offTopic: BenchSuspiciousActivity[]
}

export interface BenchStats {
  sources: number
  articles: number
  activities: number
  deleted: number
  /** 队列里还没采正文的（status='new'） */
  pending: number
  /** 采到正文但还没抽字段的（status='fetched'） */
  unparsed: number
  /** 正文打不开的：原文删了、被限制访问，这些留着没用，要能看见才好清 */
  unreachable: number
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
  /** 参与方式：报名、抢票、扫码进群… 同类活动对照要看的就是这一项 */
  joinMethod: string
  coOrganizer: string
  duration: string
  scale: string
  agenda: string[]
  highlights: string[]
  /** 宣传形式：预热、抽奖、直播这类手段，原文里出现的 */
  promoChannels: string[]
  migrationFit: BenchMigrationFit
  migrationNote: string
  /** 是否本校，本校条目在简报里单列一节当基准 */
  isHome: boolean
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
  /**
   * 合并同一场活动后的场次数。
   *
   * 一场迎新晚会会发预告、招募、回顾三篇，篇数会比场次多。
   * 两者不同时，简报头部会写成「30 条记录（合并成 26 场）」，
   * 免得读者拿篇数去推「人家一年办了三十场」。
   */
  sessionCount: number
  /** 按学校分组的条数，用于概览那一段 */
  perSchool: { school: string; count: number }[]
  items: BenchBriefItem[]
  /** 横向对比：各校在同一维度上的数，不是条目的重新排列 */
  compare: BenchCompare
  /** 已经排版好的 Markdown，直接可粘进文档或群聊 */
  markdown: string
}

// ---------- 横向对比 ----------

/**
 * 一所学校在对比表里的一行。
 *
 * 每个比率都带分母：只统计「原文里写了」的条目。
 * 覆盖率单独给出来，是为了让人知道这个中位数是按几条算的——
 * 18 场活动里只有 2 场写了人数，那个中位数不该和写满 18 场的学校并排比。
 */
export interface BenchCompareSchool {
  school: string
  isHome: boolean
  activities: number
  /**
   * 按「类型 + 日期」合并后的场次。
   *
   * 同一场迎新晚会会发预告、招募、回顾三篇，按篇数算就是三场。
   * 日期为空的各算一场——复旦两场体育赛都没写日期，硬合并会把
   * 两场不同的比赛算成一场。所以篇数和场次并排给，不替读者做减法。
   */
  sessions: number
  /** 原文里有明确人数数字的占比 */
  scaleCoverage: number
  /** 人数中位数；没有可用数字时为 null */
  medianScale: number | null
  /** 发布到活动开始的天数中位数；算不出时为 null */
  medianLeadDays: number | null
  /** 每条活动平均提到几种宣传手段 */
  promoPerItem: number
  /** 有协办/联办单位的占比 */
  coHostRate: number
  /** 举办周次（按开学日估算）的中位数；没算出来时为 null */
  medianWeek: number | null
  /** 最常办的一类活动 */
  topKind: string
  /** 样本不足，只列名字不进对比（一条数据算不出中位数） */
  thin: boolean
}

/**
 * 每个维度上有几所学校真的有数据。
 *
 * 校园活动推文普遍不写参与人数——实测 51 场里只有 5 场写了。
 * 这种时候整列摆出来全是「—」，读者会以为是我们没抽出来，
 * 而实际原因是原文没写。所以按这里的数决定这一列显不显示：
 * 不足两所学校有数据，就不比，改为在结论里直说「这项普遍没写」。
 */
export interface BenchCompareCoverage {
  scale: number
  lead: number
  promo: number
  coHost: number
  week: number
}

/** 某个维度上的一个取值：出现次数与占比 */
export interface BenchCompareBucket {
  label: string
  count: number
  /** count / 总活动数，0–1 */
  share: number
}

/**
 * 同类活动里的一行：某校办的某一场。
 *
 * 不带 id 与 url —— 这一行是拿来并排看的，点回原文属于「活动明细」那件事。
 * 真要看原文，标题本身就在，明细里按标题搜得到。
 */
export interface BenchCompareTopicRow {
  school: string
  isHome: boolean
  title: string
  startAt: string | null
  weekNo: number | null
  /** 推文发布到开始隔了几天，算不出为 null */
  leadDays: number | null
  location: string
  audience: string
  joinMethod: string
  orgForm: string
  scale: string
  coOrganizer: string
  highlights: string[]
}

/**
 * 「同一件事，各校怎么办」。
 *
 * 各校一览回答的是「谁办得多、谁预热早」；真到自己要办一场迎新晚会时，
 * 想知道的是「别人这场在哪办、要不要抢票、请了谁合办」。这两种问题
 * 用同一张表回答不了：前者一行一所学校，后者一行一场活动。
 *
 * 只有跨校才有对比价值——一所学校的两场同类活动，看到的是它自己的重复，
 * 所以少于两所学校的类型不进来（数量仍由 kinds 那个分布交代）。
 */
export interface BenchCompareTopic {
  /** 归一后的类型，如「迎新与毕业」 */
  kind: string
  /** 涉及几所学校 */
  schools: number
  rows: BenchCompareTopicRow[]
  medianWeek: number | null
  medianLeadDays: number | null
  /** 场地类型分布：礼堂与剧场 / 体育场馆 / 户外 / 线上… */
  venues: BenchCompareBucket[]
  /** 参与方式分布：报名 / 抢票 / 扫码进群 / 自由参加… */
  joins: BenchCompareBucket[]
  /** 有协办/联办单位的场次占比 */
  coHostRate: number
  /** 一句话小结，每个分句都能倒推回上面的数 */
  note: string
}

export interface BenchCompare {
  schools: BenchCompareSchool[]
  /** 活动类型分布 */
  kinds: BenchCompareBucket[]
  /** 宣传手段分布 */
  promos: BenchCompareBucket[]
  /**
   * 跨校的同类活动对照，按涉及学校数排序。
   * 同一类型至少两所学校才进来——一所学校的重复不叫对照。
   */
  topics: BenchCompareTopic[]
  coverage: BenchCompareCoverage
  /** 能倒推回上表的结论句。写不出数字支撑的话不写 */
  insights: string[]
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
  benchImportLinks(text: string, school?: string): Promise<BenchImportResult>
  /**
   * 选一个 CSV / TXT / xlsx 文件整份导入。
   *
   * 给「工具导出完整历史列表」这条路用：一个号动辄几百上千条，
   * 复制粘贴不现实，选文件读就是了。
   */
  benchImportFile(school?: string): Promise<BenchImportFileResult>
  benchFetch(limit?: number): Promise<BenchFetchResult>
  benchExtract(limit?: number): Promise<BenchExtractResult>
  benchStats(): Promise<BenchStats>
  benchSchools(): Promise<string[]>
  benchKinds(): Promise<string[]>
  /** 按当前筛选条件生成简报；同条件重复调用结果一致，不做缓存 */
  benchBrief(filter: BenchArticleFilter): Promise<BenchBrief>
  /**
   * 同一批条目的 HTML 版报告。
   *
   * 返回的是完整 HTML 字符串，由界面交给保存对话框落盘。
   * 不在主进程直接写文件：写到哪里、叫什么名字是用户的事，
   * 主进程替他决定路径，他就得去翻文件夹找。
   */
  benchReport(filter: BenchArticleFilter): Promise<string>

  // ---- v1.0：按学校采集 ----

  /** 可选学校清单，带「已采到多少」的统计 */
  benchSchoolList(): Promise<BenchSchoolInfo[]>
  benchSchoolToggle(name: string, enabled: boolean): Promise<boolean>
  /** 把某所学校设为本校（同时取消原来的本校标记） */
  benchSchoolHome(name: string): Promise<boolean>
  /** 这所学校打算去找的账号名，来自命名套路 */
  benchSchoolCandidates(name: string): Promise<string[]>
  /**
   * 按学校去搜公众号文章并入库。
   *
   * accounts 为空时用命名套路生成的候选；传了就用传的。
   * 每搜一个账号之间会停顿，所以这个调用可能几十秒才返回，界面要给进度反馈。
   */
  benchDiscover(name: string, accounts?: string[]): Promise<BenchDiscoverResult>
  /**
   * 深度采集（搜狗通道）。
   *
   * 与 benchDiscover 的区别：这里一个号会翻到搜狗的底（约 100 篇），
   * 每篇当场打开取正文，采完就是能直接用的数据。慢是必然的——
   * 每篇要真的渲染一次页面，所以按号限量和按号限篇都留了口子。
   */
  benchDeepCollect(
    name: string,
    options?: { accounts?: string[]; limit?: number; perAccount?: number }
  ): Promise<BenchDiscoverResult & { fetched: number }>
  benchProspects(school?: string): Promise<BenchProspectInfo[]>
  /** 导入内置样本链接（随安装包带的一批已知可用链接），按学校过滤 */
  benchSeedImport(school?: string): Promise<BenchImportResult>
  /** 本校同类活动：给某个活动找本校的对照条目 */
  benchHomeCompare(articleId: number): Promise<BenchArticleDetail[]>
  /**
   * 列出不属于任何已知学校的源。
   *
   * 这个不是自动清理：名字里没有校名的号未必是垃圾（「青春SUES」就是上海工程技术大学），
   * 机器判不准，人一眼能看出来，所以只列出来、由人决定。
   */
  benchAudit(): Promise<BenchAuditResult>
  /** 把这些源连同它们名下文章一起删掉 */
  benchPurgeSources(ids: number[]): Promise<{ articles: number; sources: number }>
  /** 改某个公众号的学校归属（把「青春SUES」认回上海工程技术大学这种事） */
  benchSourceSchool(id: number, school: string): Promise<boolean>
  /**
   * 人工判定「这篇不是活动」。
   *
   * 规则抽取靠词表，遇到「院长一行访问某校」这种新闻稿也会当活动抽出来。
   * 与其让这种条目混进简报，不如给一个明确的否决按钮——删掉的是抽取结果，
   * 原文和链接都还在库里。
   */
  benchMarkNotActivity(articleId: number): Promise<boolean>
  /**
   * 批量否决（数据体检里「按现在的规则复查」用的那个勾选清理）。
   * 返回实际改动的条数——传进来的 id 里有已经被删的，不该算进结果。
   */
  benchMarkNotActivityMany(articleIds: number[]): Promise<number>
  /**
   * 订阅「按学校查找」的进度。返回取消订阅的函数。
   *
   * 一次查找要跑几十秒，中间没有任何反馈的话，用户会以为卡死并反复点击，
   * 那样反而把搜索配额烧得更快。
   */
  benchOnProgress(cb: (e: BenchProgressEvent) => void): () => void
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
 * 从公众号名猜学校。
 *
 * 判学校不能只靠「去掉『学生会』三个字」：那只能对付「复旦大学学生会」这一种写法，
 * 遇上「团聚上大」「社彩同济」「上海交大安泰EMBA」就全落空，
 * 而真实的公众号名恰恰大量使用简称——学生自己做的号很少规规矩矩写全称。
 *
 * 实现放在 shared/schools.ts：界面上生成候选账号名用的是同一张表，
 * 两处各写一份，迟早会有一处忘记更新。
 */
export { schoolOfAccount as guessSchool } from './schools'

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
