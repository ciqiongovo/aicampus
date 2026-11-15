/**
 * 规则抽取：没有模型可用时的降级路径。
 *
 * 定位要说清楚：这不是「简化版 AI」，而是一条能独立交付的保底链路。
 * 模型没配、额度用完、接口临时不通，库里也不该是一片空白——至少要有
 * 类型、时间、地点这几个最容易被问到的字段，且抽不到就是空，绝不猜。
 *
 * 准确率预期：活动类型命中率较高（标题里通常有词），时间与地点次之，
 * 议程与可迁移性基本抽不出来。所以每条结果都带 confidence，
 * 低于阈值的在界面上标「待核对」，别让人当成定论。
 */

import type { BenchMigrationFit, BenchNoticeKind } from '../../../shared/benchmark'

export interface RuleExtracted {
  isActivity: boolean
  kind: string
  organizer: string
  startAt: string | null
  endAt: string | null
  weekNo: number | null
  location: string
  audience: string
  orgForm: string
  joinMethod: string
  coOrganizer: string
  duration: string
  scale: string
  promoChannels: string[]
  agenda: string[]
  highlights: string[]
  isSecondNotice: boolean
  noticeKind: BenchNoticeKind
  migrationFit: BenchMigrationFit
  migrationNote: string
  confidence: number
}

/** 活动类型词表。顺序有讲究：越具体的排前面，先命中先算 */
const KIND_RULES: { kind: string; words: string[] }[] = [
  { kind: '迎新晚会', words: ['迎新晚会', '迎新演出', '新生晚会', '迎新季晚会'] },
  { kind: '毕业季活动', words: ['毕业季', '毕业晚会', '毕业典礼', '毕业照', '毕业生晚会'] },
  { kind: '文艺演出', words: ['文艺汇演', '音乐会', '演唱会', '话剧', '舞台剧', '演出', '十大歌手', '歌手大赛'] },
  { kind: '体育赛事', words: ['运动会', '篮球赛', '足球赛', '排球赛', '羽毛球赛', '乒乓球赛', '马拉松', '夜跑', '趣味运动'] },
  { kind: '学术讲座', words: ['讲座', '报告会', '学术论坛', '名师讲坛', '讲堂', 'seminar'] },
  { kind: '沙龙分享', words: ['沙龙', '分享会', '经验分享', '座谈会', '茶话会'] },
  { kind: '竞赛', words: ['竞赛', '大赛', '挑战赛', '选拔赛', '创新创业', '数学建模', '程序设计'] },
  { kind: '招新', words: ['招新', '纳新', '招募新成员', '干事招募', '部门招新'] },
  { kind: '志愿服务', words: ['志愿', '义工', '公益', '支教', '献血'] },
  { kind: '展览', words: ['展览', '作品展', '摄影展', '书画展', '成果展'] },
  { kind: '社会实践', words: ['社会实践', '暑期实践', '调研', '三下乡'] },
  { kind: '社团活动', words: ['社团', '游园会', '社团文化节', '百团'] }
]

/** 一眼就知道不是活动的：招生、公示、任免这类，混进库里会污染统计 */
const NOT_ACTIVITY = [
  '招生简章', '录取名单', '拟录取', '公示', '任免', '任命', '表彰决定',
  '成绩查询', '四六级', '选课通知', '考试安排', '党课', '理论学习', '转发'
]

const SECOND_NOTICE = [
  { words: ['改期', '延期', '时间调整', '推迟'], kind: 'reschedule' as const },
  { words: ['地点变更', '场地变更', '更换地点', '改至'], kind: 'venue_change' as const },
  { words: ['取消', '暂停举办', '活动取消'], kind: 'cancel' as const }
]

/**
 * 宣传形式词表。
 *
 * 这一栏是「他们怎么把活动推出去的」，学生会自己最关心：
 * 同样是迎新晚会，有的只发一篇通知，有的预热三轮加抽奖加直播。
 * 所以词表按手段收，不按媒介收——「海报」「视频号」是手段，
 * 「公众号」不是：这条推文本身就在公众号上，写了等于没写。
 */
const PROMO_WORDS = [
  '预热', '预告', '海报', '短视频', '视频号', '图片直播', '直播',
  '抽奖', '集赞', '转发', '留言互动', 'H5', '线上问卷', '打卡',
  '二课', '第二课堂', '抢票', '花絮', '彩排', '图文'
]

const JOIN_RULES = ['报名', '抢票', '扫码', '预约', '进群', '无需报名', '直接到场', '线上参与']

const LOCATION_HINTS = ['体育馆', '报告厅', '礼堂', '大礼堂', '操场', '田径场', '篮球场', '图书馆', '教学楼',
  '活动中心', '学生中心', '多功能厅', '会议中心', '音乐厅', '剧场', '广场', '草坪', '湖畔', '食堂']

function pickKind(title: string, body: string): { kind: string; confidence: number } {
  const head = title + '\n' + body.slice(0, 400)
  for (const rule of KIND_RULES) {
    if (rule.words.some((w) => head.includes(w))) {
      // 标题里就命中的，比只在正文里蹭到的可信
      return { kind: rule.kind, confidence: rule.words.some((w) => title.includes(w)) ? 0.78 : 0.55 }
    }
  }
  return { kind: '', confidence: 0 }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * 判断那个「X 月 X 日」是哪一年。
 *
 * 原文只写月日，年份得自己补。用当前年份会错：2025 年 9 月发的推文说「9 月 27 日」，
 * 那是 2025 年的事，填成 2026 年就等于把一个一年前的活动当成刚办的。
 * 所以以推文发布年为基准，活动日期比发布日晚三个月以上就往前推一年——
 * 「回顾」类推文正是这种形态：现在发的，讲的是去年那场。
 */
function resolveYear(month: number, day: number, publishedAt?: string | null): number {
  const nowYear = new Date().getFullYear()
  if (!publishedAt) return nowYear
  const baseYear = Number(publishedAt.slice(0, 4))
  if (!Number.isFinite(baseYear)) return nowYear
  const pub = new Date(`${publishedAt.slice(0, 10)}T00:00:00`)
  const guess = new Date(`${baseYear}-${pad(month)}-${pad(day)}T00:00:00`)
  if (Number.isNaN(pub.getTime()) || Number.isNaN(guess.getTime())) return baseYear
  const diffDays = (guess.getTime() - pub.getTime()) / 86400000
  if (diffDays > 90) return baseYear - 1
  return baseYear
}

/**
 * 找出活动时间。
 *
 * 这里最容易犯的错是抓到「发布时间」——正文里常有一行「2026年9月26日 21:58 上海」，
 * 那是推文发出的时刻，不是活动举办的时刻。两者差一天，结论就全歪了。
 * 所以调用方会把文章的 publishedAt 传进来，命中同一个时刻的直接丢掉；
 * 另外「截止」「报名」附近的日期也先排除，那是报名时限不是活动时间。
 *
 * 全文都找不到明确日期时返回 null。宁可空着——空着用户知道要去原文看，
 * 填错了他会当成真的。
 */
function findStartDate(text: string, publishedAt?: string | null): string | null {
  const candidates: { at: string; index: number; hasTime: boolean; explicit: boolean }[] = []

  // 先找明确标注的：「活动时间：9月27日 18:30」「于9月27日晚举行」
  const labeled = /(?:活动时间|举办时间|时间|日期)\s*[:：]?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/
  const lm = labeled.exec(text)
  if (lm) {
    const month = Number(lm[1])
    const day = Number(lm[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let hour = lm[4] ? Number(lm[4]) : 0
      if (lm[3] === '下午' || lm[3] === '晚上') hour = hour < 12 ? hour + 12 : hour
      const date = `${resolveYear(month, day, publishedAt)}-${pad(month)}-${pad(day)}`
      return lm[4] ? `${date} ${pad(hour)}:${lm[5]}:00` : date
    }
  }

  const re = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const month = Number(m[1])
    const day = Number(m[2])
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    let hour = m[4] ? Number(m[4]) : 0
    if (m[3] === '下午' || m[3] === '晚上') hour = hour < 12 ? hour + 12 : hour
    const hasTime = !!m[4]
    candidates.push({
      at: `${resolveYear(month, day, publishedAt)}-${pad(month)}-${pad(day)}${hasTime ? ` ${pad(hour)}:${m[5]}:00` : ''}`,
      index: m.index,
      hasTime,
      explicit: false
    })
  }
  if (!candidates.length) return null

  const usable = candidates.filter((c) => {
    const around = text.slice(Math.max(0, c.index - 12), c.index + 20)
    if (around.includes('截止') || around.includes('报名')) return false
    // 与文章发布时间完全一致的，几乎一定是正文里那行「某年某月某日 时:分 地区」
    if (publishedAt && c.at.slice(0, 16) === publishedAt.slice(0, 16)) return false
    return true
  })

  const pool = usable.length ? usable : candidates.filter((c) => c.at.slice(0, 16) !== (publishedAt ?? '').slice(0, 16))
  if (!pool.length) return null
  const withTime = pool.find((c) => c.hasTime)
  return (withTime ?? pool[0]).at
}

function findLocation(text: string): string {
  const explicit = text.match(/(?:活动地点|地点|地址|场地|举办地)\s*[:：]\s*([^\n，。；;]{2,30})/)
  if (explicit) return explicit[1].replace(/\s+/g, '').trim()
  const hint = LOCATION_HINTS.find((h) => text.includes(h))
  if (!hint) return ''
  const idx = text.indexOf(hint)
  // 从场所名往前扫，遇到介词、标点、时间词就停。
  // 直接截前 N 个字会得到「晚会在正大体育馆」这种带语境的碎片，念出来不像地名。
  // 窗口给到 14 字：「同济大学四平路校区大礼堂」这类带校区名的全称就有 13 个字，
  // 卡在 8 字会把「四」截掉，变成「平路校区一·二九礼堂」。
  const STOP = '在于日号晚上午下行至到和与及、，。；：！？（）()「」“” \n\t'
  let start = idx
  while (start > 0 && idx - start < 14 && !STOP.includes(text[start - 1])) start -= 1
  let name = text.slice(start, idx + hint.length).replace(/\s+/g, '')
  // 前面挂着学校名的情况（「同济大学四平路校区大礼堂」）只留场所那一段：
  // 学校已经单独有字段了，塞进地点里会让同一个场所在表里出现两种写法。
  name = name
    .replace(/^[\u4e00-\u9fa5]{2,8}?(?:大学|学院)(?=[\u4e00-\u9fa5]{0,6}(?:校区|路|楼|馆|堂|场|厅|中心))/, '')
    .replace(/^(?:大学|学校|校区|本校)/, '')
  return name.length >= hint.length ? name : hint
}

function findOrganizer(text: string): string {
  const explicit = text.match(/(?:主办单位|主办方|主办|承办单位|承办)\s*[:：]\s*([^\n，。；;]{2,30})/)
  if (explicit) return explicit[1].trim()
  const m = text.match(/([\u4e00-\u9fa5]{2,12}(?:学生会|研究生会|团委|社团|协会))/)
  return m ? m[1] : ''
}

function findAudience(text: string): string {
  if (/全校|全体(?:学生|师生|同学)/.test(text)) return '全校'
  if (/新生|大一/.test(text)) return '新生'
  if (/毕业生|大四/.test(text)) return '毕业生'
  if (/本院|本系|学院全体/.test(text)) return '本院'
  return ''
}

function findJoin(text: string): string {
  return JOIN_RULES.find((w) => text.includes(w)) ?? ''
}

/**
 * 协办单位。
 *
 * 联办是很多活动办得起来的原因：「与 XX 学院联合举办」这句话里，
 * 藏着的其实是「我们单独办不动」。所以这一栏要单独记，不能塞进组织方式里。
 */
function findCoOrganizer(text: string): string {
  const explicit = text.match(
    /(?:协办单位|承办单位|支持单位|合作单位|联合主办|联合承办)\s*[:：]?\s*([^\n，。；、]{2,24})/
  )
  if (explicit) return explicit[1].replace(/\s+/g, '').trim()
  const joint = text.match(/与\s*([^\n，。；]{2,18}?)\s*(?:联合|共同)(?:举办|主办|承办)/)
  if (joint) return joint[1].replace(/\s+/g, '').trim()
  return ''
}

/**
 * 时长。
 *
 * 晚会类的时长几乎都写在时间区间里（19:00–21:30），写「为期三天」的活动也常见。
 * 只认这两种明确写法；「持续到深夜」这种形容不算时长。
 */
function findDuration(text: string): string {
  const clock = text.match(/(\d{1,2}[:：]\d{2})\s*[-—–~～至]\s*(\d{1,2}[:：]\d{2})/)
  if (clock) return `${clock[1].replace('：', ':')}–${clock[2].replace('：', ':')}`
  const days = text.match(/为期\s*([一二三四五六七八九十两\d]+\s*(?:天|日|周|个月))|持续\s*([一二三四五六七八九十两\d]+\s*(?:天|日|周))/)
  if (days) return `为期${(days[1] ?? days[2]).replace(/\s+/g, '')}`
  return ''
}

/**
 * 规模。
 *
 * 只抄原文给的数，不做换算：原文说「千余人」就写「千余人」，
 * 硬换算成 1000 人会假精确，而这一栏后面要用来估预算与场地。
 */
function findScale(text: string): string {
  const hit = text.match(
    /(?:预计|约|逾|超过|近)?\s*(\d{2,5}\s*(?:余|多)?\s*(?:人|支队伍|个班级|所高校|个学院))/
  )
  if (hit) return hit[0].replace(/\s+/g, '').trim()
  const vague = text.match(/(千余人|数百人|百余人|上万人|千人次)/)
  return vague ? vague[1] : ''
}

/**
 * 特色环节。
 *
 * 规则版只抓有明确措辞的：带「环节」「仪式」「互动」「打卡墙」这类名词的短语，
 * 以及「首次/首创/创新」引出的短句。抓不到就空着——
 * 特色这件事最难用规则判断，硬凑出来的「亮点」比空着更没用。
 */
function findHighlights(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const clean = raw.replace(/\s+/g, '').trim()
    if (clean.length < 4 || clean.length > 24) return
    if (seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }

  for (const m of text.matchAll(
    /([\u4e00-\u9fa5A-Za-z0-9·]{2,12}(?:打卡墙|打卡点|留言墙|签名墙|时光胶囊|盲盒|工作坊|开放麦|集市|市集|游园|闯关|互动区|共创))/g
  )) {
    push(m[1])
  }
  for (const m of text.matchAll(/(?:首次|首度|首创|创新推出|特别设置|独家)[^\n。！？，]{2,20}/g)) {
    push(m[0])
  }
  return out.slice(0, 6)
}

function findOrgForm(text: string): string {
  const parts: string[] = []
  if (/线上|直播|腾讯会议|Zoom/i.test(text)) parts.push('线上')
  if (/线下|现场|体育馆|报告厅/.test(text)) parts.push('线下')
  if (/联合|协办|合办|共同举办/.test(text)) parts.push('联办')
  if (/报名|抢票|预约/.test(text)) parts.push('报名制')
  return parts.join('、')
}

/**
 * 抽节目的名字当议程。
 *
 * 晚会类推文的节目单有个稳定特征：节目名都用书名号包着（《我爱你中国》《启航》）。
 * 所以只认《》，而且要求至少出现三次——一两处多半是在引某份文件或某首歌名，
 * 凑不成议程。抽不到就留空，绝不拿正文首行硬充。
 */
function findAgenda(text: string, kind: string): string[] {
  const stageKinds = ['迎新晚会', '毕业季活动', '文艺演出']
  if (!stageKinds.includes(kind)) return []
  const names = [...new Set([...text.matchAll(/《([^》\n]{2,18})》/g)].map((m) => m[1].trim()))]
  if (names.length >= 3) return names.slice(0, 8)
  const chapters = [
    ...new Set(
      [...text.matchAll(/第([一二三四五六七八九十]+)篇章[：:\s]*([^\n，。！？]{2,16})/g)].map(
        (m) => `第${m[1]}篇章 ${m[2].trim()}`
      )
    )
  ]
  return chapters.slice(0, 6)
}

/**
 * 规则版「能不能搬到本校」。
 *
 * 真正的迁移判断要结合本校条件，那是模型干的活。没有模型时不能留白——
 * 报名表里承诺了这一栏，空着等于没做。所以给一个只用结构化字段就能下的粗判：
 * 依赖特设场馆或跨单位协作的，标「协调后可行」；常规活动，标「现成条件可办」。
 * 每条都写明依据，读的人能自己推翻它。
 */
function judgeMigration(
  kind: string,
  orgForm: string,
  location: string
): { fit: BenchMigrationFit; note: string } {
  const routine = ['迎新晚会', '毕业季活动', '文艺演出', '体育赛事', '学术讲座', '沙龙分享', '志愿服务', '招新', '竞赛', '展览', '社团活动']
  if (!routine.includes(kind)) return { fit: '', note: '' }
  // 以校名、纪念日命名的场馆，别处没有，只能协调替代场地
  if (/校史|纪念馆|一·二九|包兆龙|李政道|逸夫|百廿|校庆/.test(location)) {
    return { fit: 'possible', note: '场地与本校特有资源绑定，需先落实替代场地' }
  }
  if (orgForm.includes('联办')) {
    return { fit: 'possible', note: '依赖跨院系或跨单位联合组织，需先找到对口单位' }
  }
  if (kind === '迎新晚会' || kind === '毕业季活动') {
    return { fit: 'easy', note: '常规学年活动，本校有对应组织基础，可直接对照流程' }
  }
  return { fit: 'easy', note: '常规学生活动，规模与形式接近，可参照执行' }
}

/**
 * 由日期换算举办周次。
 *
 * 这是估算，不是校历。各校开学日不同，同一日期在两所学校可能是第 2 周和第 4 周。
 * 所以只在界面标注为参考值，不写「确切第几周」；真要精确，得给每个学校配校历。
 * 秋季学期按 9 月 1 日所在周起算，春季按 2 月 20 日所在周起算。
 */
export function estimateWeekNo(dateText: string | null): number | null {
  if (!dateText) return null
  const d = new Date(dateText.slice(0, 10) + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  const year = d.getFullYear()
  const month = d.getMonth() + 1
  const termStart = month >= 8 || month <= 1
    ? new Date(month >= 8 ? `${year}-09-01T00:00:00` : `${year - 1}-09-01T00:00:00`)
    : new Date(`${year}-02-20T00:00:00`)
  const diffDays = Math.floor((d.getTime() - termStart.getTime()) / 86400000)
  if (diffDays < -14) return null
  return Math.max(1, Math.ceil((diffDays + 1) / 7))
}

export function extractByRules(input: {
  title: string
  body: string
  /** 文章发布时间，用来排除正文里那行「某年某月某日 时:分 地区」 */
  publishedAt?: string | null
}): RuleExtracted {
  const text = `${input.title}\n${input.body}`
  const head = text.slice(0, 2500)

  const empty: RuleExtracted = {
    isActivity: false,
    kind: '',
    organizer: '',
    startAt: null,
    endAt: null,
    weekNo: null,
    location: '',
    audience: '',
    orgForm: '',
    joinMethod: '',
    coOrganizer: '',
    duration: '',
    scale: '',
    promoChannels: [],
    agenda: [],
    highlights: [],
    isSecondNotice: false,
    noticeKind: '',
    migrationFit: '',
    migrationNote: '',
    confidence: 0
  }

  if (NOT_ACTIVITY.some((w) => input.title.includes(w))) return empty

  const { kind, confidence } = pickKind(input.title, input.body)
  // 标题里没类型词、正文也没有，就不要硬凑成活动
  if (!kind) return empty

  const startAt = findStartDate(head, input.publishedAt)
  const second = SECOND_NOTICE.find((r) => r.words.some((w) => input.title.includes(w)))
  const location = findLocation(head)
  const orgForm = findOrgForm(head)
  const migration = judgeMigration(kind, orgForm, location)

  return {
    isActivity: true,
    kind,
    organizer: findOrganizer(head),
    startAt,
    endAt: null,
    weekNo: estimateWeekNo(startAt),
    location,
    audience: findAudience(head),
    orgForm,
    joinMethod: findJoin(head),
    coOrganizer: findCoOrganizer(head),
    duration: findDuration(head),
    scale: findScale(head),
    promoChannels: PROMO_WORDS.filter((w) => head.includes(w)).slice(0, 6),
    agenda: findAgenda(head, kind),
    highlights: findHighlights(head),
    isSecondNotice: !!second,
    noticeKind: second ? second.kind : '',
    migrationFit: migration.fit,
    migrationNote: migration.note,
    // 规则抽取只覆盖部分字段，整体把握按命中情况给，不用一个固定的假数字
    confidence: Math.min(0.9, confidence + (startAt ? 0.08 : 0) + (location ? 0.05 : 0))
  }
}
