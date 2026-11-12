import type { MailListItem } from './types'

/** 八类主题：邮件标签、资料分类、面板推荐共用同一套词表。 */
export const MAIL_PARENT_LABELS = [
  { id: 'curriculum', name: '课程与教务', subLabels: ['课程安排', '选课', '考试', '成绩'] },
  { id: 'academics', name: '学术与学习培训', subLabels: ['学术讲座', '学习培训', '论文', '学术会议'] },
  { id: 'career', name: '就业与实习', subLabels: ['招聘', '实习', '面试', '职业规划'] },
  { id: 'advancement', name: '升学与交流', subLabels: ['考研', '保研', '留学', '交换交流'] },
  { id: 'competition', name: '竞赛与科创', subLabels: ['竞赛', '科研项目', '创新创业', '作品申报'] },
  { id: 'activities', name: '校园活动与组织', subLabels: ['校园活动', '社团', '志愿服务', '学生组织'] },
  { id: 'student', name: '学生事务与个人服务', subLabels: ['奖助学金', '缴费', '住宿', '证明办理'] },
  { id: 'operations', name: '校园运行与安全', subLabels: ['系统维护', '校园安全', '设施服务', '账号安全'] }
] as const

export type MailTopicId = (typeof MAIL_PARENT_LABELS)[number]['id']

interface TopicTerm {
  re: string
  label: string
  weight: number
}

interface TopicRule {
  terms: TopicTerm[]
  sender: RegExp
}

/**
 * 关键词按“主题词 + 场景词”分层，避免只靠一个宽泛词把邮件塞进某一类。
 * 英文词同样覆盖，防止外文邮件全部落到兜底主题。
 */
const TOPIC_RULES: Record<MailTopicId, TopicRule> = {
  curriculum: {
    terms: [
      { re: '选课|退课|补选|重修', label: '选课', weight: 4 },
      { re: '课表|课程安排|课程表|教学安排', label: '课程安排', weight: 4 },
      { re: '培养方案|教学计划', label: '培养方案', weight: 3 },
      { re: '考试安排|期末考试|期中考试|考试时间|缓考|补考|重考|\\bexam\\b|midterm|final exam', label: '考试', weight: 4 },
      { re: '成绩单|绩点|\\bgpa\\b|考试成绩|成绩查询', label: '成绩', weight: 3 },
      { re: '学分|毕业审核|学位审核|学籍|注册|体育课程|必修课|选修课', label: '学籍教务', weight: 2 },
      { re: '作业|assignment|homework|quiz|随堂测验|小测|课程论文|课程项目|project submission|due date', label: '作业考试', weight: 3 },
      { re: '口试|口语考试|导论课|课程调研|\\bcredits?\\b|course code|course registration', label: '课程考核', weight: 3 },
      { re: 'piazza|canvas|gradescope|blackboard|moodle|elrc|course code|课程代码', label: '课程平台', weight: 3 },
      { re: '课堂|授课|上课|session|discussion', label: '课堂', weight: 2 },
      { re: '教务|教务处|\\bjwc\\b', label: '教务', weight: 3 },
      { re: 'course registration|syllabus|transcript|exam schedule|academic calendar|graduation audit', label: 'Course', weight: 3 }
    ],
    sender: /(^|[.@_-])(jwc|registrar|dean|academic|jiaowu)/i
  },
  academics: {
    terms: [
      { re: '学术讲座|学术报告|讲座|seminar|colloquium|lecture', label: '学术讲座', weight: 4 },
      { re: '研讨会|学术论坛|论坛|symposium|forum|workshop', label: '研讨会', weight: 3 },
      { re: '学术会议|conference|论文|征稿|投稿|thesis|paper', label: '论文会议', weight: 3 },
      { re: '产业报告|技术报告|行业报告|专题报告|报告会|技术交流会|分享会', label: '行业报告', weight: 3 },
      { re: '科研训练|实验室|research talk|课题组', label: '科研', weight: 2 },
      { re: '学习培训|培训|公开课|training', label: '培训', weight: 2 }
    ],
    sender: /(^|[.@_-])(lib|library|research|seminar|academic)/i
  },
  career: {
    terms: [
      { re: '招聘|校招|社招|春招|秋招|recruit|hiring|\\bjob\\b', label: '招聘', weight: 4 },
      { re: '实习|internship', label: '实习', weight: 4 },
      { re: '面试|interview', label: '面试', weight: 4 },
      { re: '宣讲会|双选会|career fair|job fair|校园大使', label: '宣讲会', weight: 4 },
      { re: '简历|\\bresume\\b|\\bcv\\b|求职|就业|职业规划|career|offer|内推|岗位|职位|vacancy|employer', label: '就业', weight: 3 }
    ],
    sender: /(^|[.@_-])(hr|jobs?|career|recruit|talent|zhaopin)/i
  },
  advancement: {
    terms: [
      { re: '考研|保研|推免|推荐免试|研究生申请|硕士申请|博士申请|graduate school|postgraduate|\\bphd\\b|\\bmaster\\b', label: '升学', weight: 4 },
      { re: '夏令营|预推免|申请季', label: '夏令营', weight: 3 },
      { re: '留学|出国|交换|访学|study abroad|exchange program', label: '留学交流', weight: 3 },
      { re: '推荐信|雅思|托福|\\bgre\\b|toefl|ielts', label: '申请准备', weight: 2 }
    ],
    sender: /(^|[.@_-])(admission|graduate|yjs|international|exchange)/i
  },
  competition: {
    terms: [
      { re: '竞赛|大赛|比赛|challenge cup|contest|competition', label: '竞赛', weight: 4 },
      { re: '挑战杯|互联网\\+|数学建模|电子设计|\\bacm\\b|蓝桥杯', label: '竞赛名称', weight: 4 },
      { re: '创新创业|科创|startup|innovation', label: '科创', weight: 3 },
      { re: '科研项目|项目申报|作品申报|hackathon|黑客松', label: '项目申报', weight: 3 }
    ],
    sender: /(^|[.@_-])(contest|competition|innovation|kechuang)/i
  },
  activities: {
    terms: [
      { re: '社团|学生会|学生组织|\\bclub\\b|society|student union', label: '社团组织', weight: 4 },
      { re: '志愿服务|志愿|义工|volunteer', label: '志愿服务', weight: 4 },
      { re: '校园活动|文化活动|晚会|运动会|校运会|迎新|招新|orientation|festival', label: '校园活动', weight: 3 },
      { re: '运动会|校运会|体育赛事|辩论赛|跳绳|定向越野|匹克球|羽毛球|篮球|足球|排球|长跑|体能|健身|剑术', label: '体育活动', weight: 2 },
      { re: '演出|歌剧|音乐会|电影|展览|文化节|咖啡|直播|游园|体验活动|剧团|喜剧|快闪|开演', label: '活动演出', weight: 2 },
      { re: '活动报名|报名通知|报名开启|报名参加|报名截止|报名', label: '活动报名', weight: 1 },
      { re: '社会实践|社团活动', label: '实践', weight: 3 }
    ],
    sender: /(^|[.@_-])(youth|union|club|volunteer|shetuan)/i
  },
  student: {
    terms: [
      { re: '奖学金|助学金|助学贷款|困难认定|勤工助学|scholarship|financial aid|\\bgrant\\b', label: '奖助', weight: 4 },
      { re: '缴费|学费|住宿费|账单|billing|invoice|tuition|\\bfee\\b', label: '缴费', weight: 3 },
      { re: '宿舍|住宿|调宿|退宿|dorm|housing', label: '住宿', weight: 3 },
      { re: '在读证明|证明|户籍|档案|体检|保险|医保|一卡通|校园卡|certificate|insurance|student card', label: '事务办理', weight: 3 },
      { re: '开学典礼|入学教育|新生教育', label: '入学事务', weight: 2 },
      { re: '补助|贷款|\\bloan\\b', label: '补助', weight: 2 }
    ],
    sender: /(^|[.@_-])(xsc|student|scholarship|finaid|dorm)/i
  },
  operations: {
    terms: [
      { re: '系统维护|维护通知|停机维护|maintenance|outage', label: '系统维护', weight: 4 },
      { re: '校园网|网络|断网|network|wifi', label: '网络', weight: 3 },
      { re: '停水|停电|维修|报修|repair|facility', label: '设施服务', weight: 3 },
      { re: '施工|工程建设|抗压测试|实名认证', label: '施工与检测', weight: 3 },
      { re: '供能|能源|空调|energy|supply|校门|网约车|落客|ride-hailing|gate', label: '校园运行', weight: 3 },
      { re: '停车|非机动车|车辆|餐厅|食堂|快递|班车|校车|shuttle|parking|dining|cafeteria|回收|recycl', label: '后勤服务', weight: 3 },
      { re: '登录|验证码|二次验证|新设备|设备登录|身份验证|verification|login|sign-in|sign in|confirmation code', label: '账号验证', weight: 4 },
      { re: '门禁|消防|安全|防诈骗|诈骗|security|fire|fraud', label: '校园安全', weight: 3 },
      { re: '账号|密码|邮箱升级|it服务|信息服务|account|password', label: '账号安全', weight: 2 }
    ],
    sender: /(^|[.@_-])(noc|its|security|network|support)/i
  }
}

export interface TopicClassification {
  /** 按得分排序的主题 id；至少一个，不会返回未分类。 */
  parents: MailTopicId[]
  /** 命中的短标签，去重后最多 5 个。 */
  subs: string[]
  scores: Record<MailTopicId, number>
  /** 是否只靠发件人/兜底规则判断，正文没有命中主题词。 */
  fallback: boolean
}

export interface TopicInput {
  subject?: string
  body?: string
  from?: string
}

function hitCount(text: string, re: string): number {
  const matches = text.match(new RegExp(re, 'gi'))
  return matches ? matches.length : 0
}

function addTerms(
  text: string,
  factor: number,
  rule: TopicRule,
  id: MailTopicId,
  scores: Record<MailTopicId, number>,
  subs: Set<string>
): void {
  for (const term of rule.terms) {
    const n = hitCount(text, term.re)
    if (!n) continue
    scores[id] += Math.min(n, 3) * term.weight * factor
    subs.add(term.label)
  }
}

/**
 * 邮件/资料主题分类器。
 * - 标题权重最高，正文只取前 1200 字，发件人作为兜底线索；
 * - 取最高分主题，并在第二主题接近时保留双标签（如黑客松=竞赛+校园活动）；
 * - 没有命中时按发件人、常见校园事务词兜底，保证不会出现“未分类”。
 */
export function classifyTopics(input: TopicInput): TopicClassification {
  const subject = (input.subject ?? '').toLowerCase()
  const body = (input.body ?? '').slice(0, 1200).toLowerCase()
  const from = (input.from ?? '').toLowerCase()
  const scores = Object.fromEntries(MAIL_PARENT_LABELS.map((item) => [item.id, 0])) as Record<MailTopicId, number>
  const subSets = Object.fromEntries(MAIL_PARENT_LABELS.map((item) => [item.id, new Set<string>()])) as Record<
    MailTopicId,
    Set<string>
  >

  for (const item of MAIL_PARENT_LABELS) {
    const rule = TOPIC_RULES[item.id]
    addTerms(subject, 2.5, rule, item.id, scores, subSets[item.id])
    addTerms(body, 1, rule, item.id, scores, subSets[item.id])
  }

  const ranked = MAIL_PARENT_LABELS.map((item) => ({ id: item.id, score: scores[item.id] })).sort(
    (a, b) => b.score - a.score
  )
  const top = ranked[0]?.score ?? 0
  const parents: MailTopicId[] = []
  if (top >= 4) {
    parents.push(ranked[0].id)
    const second = ranked[1]
    if (second && second.score >= 6 && second.score >= top * 0.78) parents.push(second.id)
  }

  // 黑客松天然横跨竞赛与校园活动，避免被单一类别吞掉。
  if (/黑客松|hackathon/i.test(`${subject} ${body}`)) {
    for (const id of ['competition', 'activities'] as const) if (!parents.includes(id)) parents.push(id)
    subSets.competition.add('黑客松')
    subSets.activities.add('黑客松')
  }

  // 正文没有命中时先看发件人，再看校园事务兜底；分类结果永远落在八类里。
  if (parents.length === 0) {
    for (const item of MAIL_PARENT_LABELS) {
      if (TOPIC_RULES[item.id].sender.test(from)) {
        if (!parents.includes(item.id)) parents.push(item.id)
      }
    }
  }
  if (parents.length === 0) {
    parents.push('student')
    subSets.student.add('校园通知')
  }

  // 只展示最终主题自己的分类词，避免正文里偶然出现的其他主题词污染标签。
  const subs = [...new Set(parents.flatMap((id) => [...subSets[id]]))]
  if (subs.length === 0) {
    const first = MAIL_PARENT_LABELS.find((item) => item.id === parents[0])
    subs.push(first?.subLabels[0] ?? '校园通知')
  }

  return {
    parents: parents.slice(0, 2),
    subs: subs.slice(0, 5),
    scores,
    fallback: top < 4
  }
}

/** 话题匹配兼容入口：资料分类与旧调用方只需要 parents/subs。 */
export function matchTopics(text: string): { parents: string[]; subs: string[] } {
  const result = classifyTopics({ subject: text })
  return { parents: result.parents, subs: result.subs }
}

export type MailUrgency = 'within_1d' | 'within_3d' | 'within_7d' | 'after_7d'
export type MailTagSource = 'fallback' | 'analysis' | 'feedback'
export type MailTagTier = 1 | 2 | 3 | 4
export interface MailTagRecord {
  emailId: number
  urgency: MailUrgency
  deadlineAt: string | null
  parentLabels: string[]
  subLabels: string[]
  interest: number
  tier: MailTagTier
  source: MailTagSource
  updatedAt: string
}
export interface TagPreferences {
  parentWeights: Record<string, number>
  updatedAt: string | null
}
export interface MailTagsQuery {
  accountId?: number
  folder?: string
  keyword?: string
  limit?: number
  offset?: number
}
export interface MailTagsResult {
  total: number
  items: Array<{ mail: MailListItem; tag: MailTagRecord }>
}
export interface MailTagFeedbackPatch {
  urgency?: MailUrgency
  parentLabels?: string[]
  subLabels?: string[]
  interest?: number
  tier?: MailTagTier
  rating?: 'A' | 'B' | 'C' | 'D'
}
