/**
 * 日报专项共享契约（新增部分）。
 * 说明：原有的 dailySourcesGet/Set/Generate/List/Status 通道与 DailyReportItem 等旧类型
 * 仍留在 shared/types.ts，本文件只放「新增」通道、方法与新类型，主代理负责把 createDailyApi
 * 展开进 window.api 并整合 shared/types.ts 中的 RendererApi。
 */
import type { DailyOpResult } from './types'

// ---------- 新增 IPC 通道（旧通道保持 shared/types.ts 的 IPC 不变） ----------

export const DAILY_IPC = {
  dailyFocusGet: 'daily:focus-get',
  dailyFocusSet: 'daily:focus-set',
  dailyReportsList: 'daily:reports-list',
  dailyBoard: 'daily:board',
  dailyReportGet: 'daily:report-get',
  dailyReportByInfo: 'daily:report-by-info',
  dailyReportArticles: 'daily:report-articles',
  dailySearch: 'daily:search',
  dailyArticleGet: 'daily:article-get',
  dailyArticleContent: 'daily:article-content',
  dailyArticleStatus: 'daily:article-status',
  dailyArticleCategory: 'daily:article-category'
} as const

// ---------- 话题目录（确定性标题归类，非语义/模型） ----------

export interface DailyTopicInfo {
  id: string
  label: string
}

/** 话题目录顺序即归类优先级：标题命中靠前话题的关键词即归入该话题 */
export const DAILY_TOPICS: readonly DailyTopicInfo[] = [
  { id: 'ai', label: 'AI' },
  { id: 'tech', label: '科技' },
  { id: 'finance', label: '财经' },
  { id: 'society', label: '社会' },
  { id: 'sports', label: '体育' },
  { id: 'ent', label: '娱乐' },
  { id: 'edu', label: '教育' },
  { id: 'health', label: '健康' },
  { id: 'game', label: '游戏' },
  { id: 'car', label: '汽车' },
  { id: 'world', label: '国际' }
] as const

export function dailyTopicLabel(id: string | null | undefined): string {
  if (!id) return '未归类'
  const t = DAILY_TOPICS.find((x) => x.id === id)
  return t ? t.label : id
}

/** 关键词规则：只做「标题包含」判断，是确定性归类，不代表语义理解或新闻全文。 */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  ai: ['AI', '人工智能', '大模型', '机器学习', '深度学习', '神经网络', 'ChatGPT', 'GPT', '智能体', '机器人', '生成式', 'AGI', 'LLM', '文心', '通义', '豆包', 'Kimi', 'Claude', 'Gemini', '自动驾驶'],
  tech: ['科技', '芯片', '半导体', '5G', '6G', '航天', '卫星', '火箭', '手机', '苹果', '华为', '小米', '系统', '软件', '互联网', '数码', '无人机', '量子', '操作系统', '电池', '屏幕', '发布', '新机', '处理器', '显卡'],
  finance: ['股市', '股票', '基金', '黄金', '油价', '房价', '央行', '人民币', '汇率', '经济', '财报', '上市', '融资', '美股', 'A股', '理财', '降息', '加息', 'GDP', '金融', '银行', '证券', '投资'],
  society: ['政策', '通报', '事件', '调查', '民生', '交通', '法律', '法院', '公安', '消防', '事故', '高考', '就业', '社保', '医保', '工资', '养老金', '通报', '回应', '处罚', '曝光', '官宣'],
  sports: ['比赛', '足球', '篮球', '世界杯', '奥运', '冠军', '联赛', '运动员', '国足', 'NBA', 'CBA', '乒乓球', '排球', '羽毛球', '网球', '游泳', '田径', '夺冠', '教练', '队'],
  ent: ['明星', '电影', '电视剧', '综艺', '演唱会', '演员', '歌手', '票房', '音乐', '艺人', '八卦', '导演', '主演', '上映', '新歌', '专辑', '颁奖', '红毯'],
  edu: ['教育', '学校', '大学', '学生', '老师', '考试', '考研', '招生', '毕业', '学位', '培训', '教材', '课程', '高考', '留学', '校园', '教师'],
  health: ['健康', '疾病', '医院', '疫苗', '疫情', '药物', '养生', '减肥', '医生', '医疗', '卫生', '癌症', '病毒', '症状', '治疗', '医保', '口罩'],
  game: ['游戏', '电竞', '手游', '端游', '英雄联盟', '王者荣耀', '原神', '主机', '玩家', '赛季', '皮肤', 'steam', 'Steam', '任天堂', '索尼', '微软游戏', '版号'],
  car: ['汽车', '新能源', '电动车', '特斯拉', '比亚迪', '车型', '车展', '智能驾驶', '续航', '充电', '4S店', '车企', '量产', '交付', 'SUV', '轿车'],
  world: ['美国', '日本', '韩国', '俄罗斯', '乌克兰', '欧洲', '中东', '联合国', '外交', '国际', '特朗普', '拜登', '普京', '北约', '欧盟', '制裁', '冲突', '战争', '峰会', '大选']
}

/** 标题确定性话题归类：返回首个命中话题与命中关键词（最多 5 个），无命中返回 null。 */
export function classifyDailyTitle(title: string): { topicId: string; matches: string[] } | null {
  const t = (title ?? '').trim()
  if (!t) return null
  const lower = t.toLowerCase()
  for (const topic of DAILY_TOPICS) {
    const kws = TOPIC_KEYWORDS[topic.id] ?? []
    const matches: string[] = []
    for (const k of kws) {
      if (lower.includes(k.toLowerCase())) matches.push(k)
    }
    if (matches.length > 0) return { topicId: topic.id, matches: matches.slice(0, 5) }
  }
  return null
}

// ---------- 实体与结果类型 ----------

/** 资讯条目四去向：复用 info 流语义（自动进入 keep=系统分流，非用户主动收藏） */
export type DailyArticleStatus = 'keep' | 'archive' | 'item' | 'unverified'

/** 独立资讯实体（稳定 ID：daily_article.id；handoff 引用 kind 'article' 用此 id，勿混用 info 汇总 id） */
export interface DailyArticle {
  id: number
  title: string
  /** 可获得的内容；热榜源通常为空，不伪造全文 */
  content: string
  url: string | null
  sourceId: string
  sourceLabel: string
  score: number | null
  /** 确定性话题归类结果（null = 未归类） */
  topic: string | null
  topicLabel: string | null
  /** 命中的标题关键词（推荐/归类依据，诚实说明证据范围） */
  topicMatches: string[]
  /** 行动分类（与 topic 独立：需行动/重要通知/可选机会/一般信息/不确定） */
  category: string | null
  status: DailyArticleStatus
  /** 是否用户手动处理过（区分自动 keep 与真实用户反馈） */
  userActed: boolean
  itemId: number | null
  itemTitle: string | null
  publishedAt: string | null
  createdAt: string
  /** 归属的日报日期（跨日重复去重后同一文章可属于多天） */
  reportDateKeys: string[]
}

export interface DailySourceReport {
  sourceId: string
  label: string
  count: number
  error: string | null
}

export type DailyReportStatus = 'complete' | 'partial' | 'failed'

/** 日报汇总（稳定 ID：daily_report.id；handoff 引用 kind 'daily' 用此 id） */
export interface DailyReportSummary {
  id: number
  dateKey: string
  title: string
  intro: string
  status: DailyReportStatus
  articleCount: number
  /** 关联的旧 info 汇总行 id（供信息流按 info 汇总 id 反查日报明细；旧数据无对应行为 null） */
  infoId: number | null
  generatedAt: string | null
  createdAt: string
  sources: DailySourceReport[]
}

export interface DailyBoardColumn {
  topicId: string | null
  topicLabel: string
  kind: 'focus' | 'discovery' | 'unfiled'
  articles: DailyArticle[]
}

export interface DailyBoard {
  dateKey: string
  report: DailyReportSummary | null
  focusTopicIds: string[]
  columns: DailyBoardColumn[]
}

export interface DailyReportDetail {
  report: DailyReportSummary
  articles: DailyArticle[]
}

export interface DailyReportsQuery {
  limit?: number
  offset?: number
}

export interface DailyReportsResult {
  total: number
  items: DailyReportSummary[]
}

export interface DailyArticlesQuery {
  limit?: number
  offset?: number
}

export interface DailyArticlesPage {
  reportId: number
  total: number
  items: DailyArticle[]
}

export interface DailySearchQuery {
  keyword?: string
  sourceId?: string
  topicId?: string
  status?: DailyArticleStatus | 'all'
  limit?: number
  offset?: number
}

export interface DailySearchResult {
  total: number
  items: DailyArticle[]
}

/** 资讯正文分块读取（Agent 读取，避免全文截断） */
export interface DailyArticleContentQuery {
  offset?: number
  limit?: number
}

export interface DailyArticleContentResult {
  id: number
  title: string
  content: string
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export interface DailyArticleOpResult {
  ok: boolean
  message: string
  /** 资讯条目 id */
  id?: number
  /** 转事项后的事项 id */
  itemId?: number
}

// ---------- 新增 API（仅新增方法；旧方法签名保持不变，仍在 shared/types.ts） ----------

export interface DailyApi {
  dailyFocusGet(): Promise<string[]>
  dailyFocusSet(topics: string[]): Promise<DailyOpResult>
  /** 历史日报分页（超过 14 天仍可遍历） */
  dailyReportsList(query?: DailyReportsQuery): Promise<DailyReportsResult>
  /** 某日看板：按固定关注/发现/未归类分列 */
  dailyBoard(dateKey?: string): Promise<DailyBoard>
  /** 某日日报详情（汇总 + 全部明细） */
  dailyReportGet(dateKey: string): Promise<DailyReportDetail | null>
  /** 按 info 汇总行 id 反查日报详情（信息流展开明细用） */
  dailyReportByInfo(infoId: number): Promise<DailyReportDetail | null>
  /** 某日报的资讯明细分页（Agent 分页读取，body 分块不截断） */
  dailyReportArticles(reportId: number, query?: DailyArticlesQuery): Promise<DailyArticlesPage | null>
  /** 资讯检索：关键词 / 来源 / 话题 */
  dailySearch(query: DailySearchQuery): Promise<DailySearchResult>
  /** 单条资讯详情 */
  dailyArticleGet(id: number): Promise<DailyArticle | null>
  /** 单条资讯正文分块 */
  dailyArticleContent(id: number, query?: DailyArticleContentQuery): Promise<DailyArticleContentResult | null>
  /** 单条 keep/archive/item/unverified 处理 */
  dailyArticleStatus(id: number, status: DailyArticleStatus): Promise<DailyArticleOpResult>
  /** 单条行动分类（需行动/重要通知/可选机会/一般信息/不确定），与话题 topic 独立 */
  dailyArticleCategory(id: number, category: string): Promise<DailyArticleOpResult>
}
