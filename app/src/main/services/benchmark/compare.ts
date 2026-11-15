/**
 * 横向对比：把一堆活动条目压成「谁和谁差在哪」。
 *
 * 简报本身只是罗列——一条条往下读，读者得自己在脑子里做减法：
 * 复旦办了九场、我们办了十八场，那到底差在规模还是差在频次？
 * 这个文件负责把减法做掉，输出可以直接印在纸上的几组数。
 *
 * 三条自律：
 * 1. 只统计有样本的维度。一条活动写「200 人」、另一条没写，不能当成 0，
 *    也不能当成「平均 100 人」——分母只算写了的那些，并且把覆盖率一起报出来。
 * 2. 样本太少不下结论。一所学校只有 1 条活动时，它的「中位规模」毫无意义，
 *    但印在表里会被人当成事实用。所以每校至少 2 条才进对比表，1 条的单独列出来。
 * 3. 不写因果。可以说「A 校平均提前 6 天预热，本校 2 天」，不能说
 *    「因为提前预热所以参与人数多」——那是两件事，样本也不支持。
 */

import type {
  BenchBriefItem,
  BenchCompare,
  BenchCompareSchool,
  BenchCompareBucket
} from '../../../shared/benchmark'

/** 样本门槛：少于这个数不参与横向对比，只列名字 */
const MIN_SAMPLE = 2

/**
 * 活动类型归一。
 *
 * 抽取出来的 kind 是自由文本，同一件事各写成「迎新晚会」「迎新文艺晚会」
 * 「2025 级新生迎新晚会」。不归一就直接分组，会得到二十个各只有一条的类目，
 * 看上去像什么都没比出来。这里按关键词收进九个桶。
 *
 * 顺序有讲究：先匹配长的、具体的词。「社团招新嘉年华」既是市集也是招新，
 * 归到「招新与市集」比归到「展览市集」更贴切。
 */
const KIND_RULES: { label: string; re: RegExp }[] = [
  { label: '迎新与毕业', re: /迎新|新生|毕业|开学|入学/ },
  { label: '晚会与演出', re: /晚会|演出|音乐节|歌会|话剧|戏剧|文艺汇演|嘉年华.*演/ },
  { label: '比赛与竞赛', re: /比赛|竞赛|大赛|挑战赛|联赛|锦标赛|选拔赛/ },
  { label: '讲座与沙龙', re: /讲座|沙龙|论坛|分享会|报告会|座谈|读书会/ },
  // 招新排在市集前面：「社团招新嘉年华」两边都像，但它的目的是招人不是摆摊，
  // 归到市集的话，「这所学校在招新上用了什么办法」就查不出来了
  { label: '招新与招募', re: /招新|招募|纳新|招干|招员/ },
  { label: '市集与展览', re: /市集|集市|展览|展会|路演|摆摊|嘉年华/ },
  { label: '志愿与公益', re: /志愿|公益|支教|献血|义卖|服务队/ },
  { label: '培训与营队', re: /培训|训练营|夏令营|冬令营|工作坊|素拓|拓展/ },
  { label: '体育与健身', re: /运动会|体育|篮球|足球|羽毛球|乒乓|跑步|马拉松|健身/ },
  { label: '宣讲与招聘', re: /宣讲|招聘|双选|就业|实习/ },
  { label: '会议与选举', re: /大会|例会|述职|选举|换届|代表大会/ }
]

export function bucketKind(kind: string): string {
  const text = (kind || '').trim()
  if (!text) return '未标注类型'
  for (const rule of KIND_RULES) if (rule.re.test(text)) return rule.label
  return '其他'
}

/**
 * 从「预计 300 人参加」「观众约 200-300 人」里取出人数区间。
 *
 * 只认带量词的数字。光秃秃的「300」可能是经费、是票数、是第 300 期，
 * 认错比不认更糟——规模是这个对比里唯一能被当成硬指标的东西。
 */
export function parseScale(text: string): number | null {
  const s = (text || '').replace(/\s+/g, '')
  if (!s) return null

  // 先试区间：200-300人 / 200~300名 / 200—300人（全角破折号在中文里很常见）
  const range = s.match(/(\d{2,5})\s*[-~～—－到至]\s*(\d{2,5})\s*(?:余)?\s*(?:人|名|位|人次)/)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    if (a > 0 && b >= a && b < 100000) return Math.round((a + b) / 2)
  }

  // 再试「约 300 人」「300 余人」「300+ 人」
  const single = s.match(/(\d{2,5})\s*(?:余|多|\+)?\s*(?:人|名|位|人次)/)
  if (single) {
    const n = Number(single[1])
    if (n > 0 && n < 100000) return n
  }

  // 「千人」「百人」这种中文写法
  const cn = s.match(/([一二三四五六七八九])千(?:余)?(?:人|名)/)
  if (cn) return Number('一二三四五六七八九'.indexOf(cn[1]) + 1) * 1000
  if (/上百人/.test(s)) return 100
  if (/上千人/.test(s)) return 1000

  return null
}

/**
 * 预热天数：推文发布到活动开始隔了几天。
 *
 * 负数或超过 120 天的一律不算——前者多半是把发布时间和活动时间搞反了，
 * 后者多半是常年挂着的栏目页，混进平均值会把节奏拉到失真。
 */
export function leadDays(item: BenchBriefItem): number | null {
  if (!item.publishedAt || !item.startAt) return null
  const pub = Date.parse(item.publishedAt.replace(' ', 'T'))
  const start = Date.parse(item.startAt.replace(' ', 'T'))
  if (!Number.isFinite(pub) || !Number.isFinite(start)) return null
  const days = Math.round((start - pub) / 86400000)
  if (days < 0 || days > 120) return null
  return days
}

/** 合办判断：写了协办单位，或者组织方式里出现「联合/共同/协办/承办」 */
function isCoHosted(item: BenchBriefItem): boolean {
  if (item.coOrganizer && item.coOrganizer.trim()) return true
  return /联合|共同|协办|承办|联手|共建/.test(item.orgForm || '')
}

function median(nums: number[]): number | null {
  if (!nums.length) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * 宣传手段归一。
 *
 * promoChannels 里是「公众号预热」「朋友圈海报」「抽奖」这类自由文本，
 * 直接按原文计数会得到几十个近义项。收成十来个常见手段，才看得出差别。
 */
const PROMO_RULES: { label: string; re: RegExp }[] = [
  { label: '预热推文', re: /预热|预告|倒计时|抢先看|剧透/ },
  { label: '海报', re: /海报|展板|横幅|易拉宝/ },
  { label: '抽奖与福利', re: /抽奖|福利|礼品|奖品|红包|集赞/ },
  { label: '视频与直播', re: /视频|直播|短片|Vlog|vlog|快闪|宣传片/ },
  { label: '报名与抢票', re: /报名|抢票|预约|领票|扫码/ },
  { label: '群与社群', re: /群|社群|QQ|微信/ },
  { label: '线下地推', re: /摆摊|地推|路演|扫楼|摊位|现场宣传/ },
  { label: '合作转发', re: /转发|联动|互推|矩阵/ },
  { label: '回顾与复盘', re: /回顾|总结|复盘|花絮|返图/ }
]

export function bucketPromo(text: string): string | null {
  const s = (text || '').trim()
  if (!s) return null
  for (const rule of PROMO_RULES) if (rule.re.test(s)) return rule.label
  return null
}

function countInto(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function sortBuckets(map: Map<string, number>, total: number): BenchCompareBucket[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * 主入口：把简报条目算成对比数据。
 *
 * 传进来的 items 是当前筛选结果，所以「对比」永远和用户眼前看到的那批一致，
 * 不会出现表里写着九场、正文只列出五场这种事。
 */
export function buildCompare(items: BenchBriefItem[]): BenchCompare {
  const bySchool = new Map<string, BenchBriefItem[]>()
  for (const item of items) {
    const key = item.school || '未填学校'
    if (!bySchool.has(key)) bySchool.set(key, [])
    bySchool.get(key)!.push(item)
  }

  const schools: BenchCompareSchool[] = []
  const thin: string[] = []

  for (const [school, list] of bySchool) {
    const isHome = list.some((i) => i.isHome)
    if (list.length < MIN_SAMPLE) {
      // 一条数据算不出中位数，进了表只会被当成事实引用
      thin.push(school)
      schools.push({
        school,
        isHome,
        activities: list.length,
        scaleCoverage: 0,
        medianScale: null,
        medianLeadDays: null,
        promoPerItem: 0,
        coHostRate: 0,
        medianWeek: null,
        topKind: bucketKind(list[0]?.kind ?? ''),
        thin: true
      })
      continue
    }

    const scales = list.map((i) => parseScale(i.scale)).filter((n): n is number => n !== null)
    const leads = list.map(leadDays).filter((n): n is number => n !== null)
    const weeks = list.map((i) => i.weekNo).filter((n): n is number => typeof n === 'number' && n > 0)
    const promoCount = list.reduce((acc, i) => {
      const set = new Set(i.promoChannels.map(bucketPromo).filter(Boolean))
      return acc + set.size
    }, 0)
    const coHosted = list.filter(isCoHosted).length

    const kindCounter = new Map<string, number>()
    for (const i of list) countInto(kindCounter, bucketKind(i.kind))
    const topKind =
      [...kindCounter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '—'

    schools.push({
      school,
      isHome,
      activities: list.length,
      scaleCoverage: scales.length / list.length,
      medianScale: median(scales),
      medianLeadDays: median(leads),
      promoPerItem: Math.round((promoCount / list.length) * 10) / 10,
      coHostRate: coHosted / list.length,
      medianWeek: median(weeks),
      topKind,
      thin: false
    })
  }

  // 本校固定排第一，其余按活动数降序——读者先看基准，再看别人
  schools.sort((a, b) => {
    if (a.isHome !== b.isHome) return a.isHome ? -1 : 1
    if (a.thin !== b.thin) return a.thin ? 1 : -1
    return b.activities - a.activities || a.school.localeCompare(b.school)
  })

  const kindMap = new Map<string, number>()
  for (const item of items) countInto(kindMap, bucketKind(item.kind))

  const promoMap = new Map<string, number>()
  for (const item of items) {
    for (const raw of item.promoChannels) {
      const key = bucketPromo(raw)
      if (key) countInto(promoMap, key)
    }
  }

  const solid = schools.filter((s) => !s.thin)

  return {
    schools,
    kinds: sortBuckets(kindMap, items.length),
    promos: sortBuckets(promoMap, items.length),
    coverage: {
      scale: solid.filter((s) => s.medianScale !== null).length,
      lead: solid.filter((s) => s.medianLeadDays !== null).length,
      promo: solid.filter((s) => s.promoPerItem > 0).length,
      coHost: solid.filter((s) => s.coHostRate > 0).length,
      week: solid.filter((s) => s.medianWeek !== null).length
    },
    insights: makeInsights(schools, items.length)
  }
}

/**
 * 本校与外校（中位）的差值。
 *
 * 对标的落点其实是这一句话：「别人平均怎么做，我们怎么做，差在哪」。
 * 只把本校作为一行放进表里，读的人还得自己横着比一遍；
 * 所以凡是本校和外校都有数据的维度，都把差值算出来说清楚。
 *
 * 外校少于两所就返回 null——一所学校组成的「外校平均」不是平均，是那一所。
 */
function versus(
  schools: BenchCompareSchool[],
  pick: (s: BenchCompareSchool) => number | null
): { home: number; others: number; n: number } | null {
  const home = schools.find((s) => s.isHome && !s.thin)
  if (!home) return null
  const hv = pick(home)
  if (hv === null) return null
  const vals = schools
    .filter((s) => !s.isHome && !s.thin)
    .map(pick)
    .filter((v): v is number => v !== null)
  if (vals.length < 2) return null
  return { home: hv, others: median(vals) ?? 0, n: vals.length }
}

// 10 天写成「约 2 周」会把 11 说成 14。满两周才换算，否则照实说天数
const dayWord = (n: number): string => (n >= 14 ? `约 ${Math.round(n / 7)} 周` : `${n} 天`)

/**
 * 生成结论句。
 *
 * 每一条都必须能倒推回上面那张表里的某个数——写不出数字支撑的话，
 * 一律不写。宁可只有三句，也不要一段听上去很有道理的无来源判断。
 *
 * 顺序按「能不能照做」排：规模与节奏是能直接改的，周次是学期安排，合办是组织形式。
 */
function makeInsights(schools: BenchCompareSchool[], total: number): string[] {
  const out: string[] = []
  if (!total) return ['库里没有符合条件的活动，先补采几个公众号再来看对比。']

  const solid = schools.filter((s) => !s.thin)

  // 1. 规模
  const scale = versus(schools, (s) => s.medianScale)
  const withScale = solid.filter((s) => s.medianScale !== null && s.scaleCoverage >= 0.3)
  if (scale) {
    const diff = scale.home - scale.others
    const judge =
      Math.abs(diff) <= Math.max(20, scale.others * 0.15)
        ? '量级差不多'
        : diff > 0
          ? `我们大 ${diff} 人`
          : `我们小 ${-diff} 人`
    out.push(
      `规模：本校中位 ${scale.home} 人，外校中位 ${scale.others} 人（${scale.n} 所写了人数）——${judge}。`
    )
  } else if (withScale.length >= 2) {
    const top = [...withScale].sort((a, b) => (b.medianScale ?? 0) - (a.medianScale ?? 0))[0]
    const low = [...withScale].sort((a, b) => (a.medianScale ?? 0) - (b.medianScale ?? 0))[0]
    if (top.medianScale !== low.medianScale) {
      out.push(
        `规模：${top.school}的中位规模最高，约 ${top.medianScale} 人；${low.school}最小，约 ${low.medianScale} 人。` +
          `各校只有 ${Math.round(top.scaleCoverage * 100)}%、${Math.round(low.scaleCoverage * 100)}% 的活动写了人数，这是「写了的那些」的中位数。`
      )
    }
  } else {
    // 说清「没写」而不是「没抽到」：前者是这类推文的常态，后者会让人以为工具坏了
    const withNum = Math.round(solid.reduce((acc, s) => acc + s.activities * s.scaleCoverage, 0))
    out.push(
      `规模：${total} 场活动里只有 ${withNum} 场在原文写了参与人数，不到两所学校有数据，这项没法横向比。` +
        `校园活动报道普遍不写人数——不是抽取漏了，是原文没有。`
    )
  }

  // 2. 宣传节奏：预热多久发预告，是最近乎「照着改」的一项
  const lead = versus(schools, (s) => s.medianLeadDays)
  if (lead) {
    const diff = lead.home - lead.others
    const judge =
      Math.abs(diff) <= 1
        ? '节奏基本一致'
        : diff > 0
          ? `我们早了 ${dayWord(diff)}，预热期拉得比人家长`
          : `我们晚了 ${dayWord(-diff)}，出手比人家急`
    out.push(
      `节奏：本校中位提前 ${dayWord(lead.home)}发预告，外校 ${dayWord(lead.others)}（${lead.n} 所）——${judge}。`
    )
  } else {
    const withLead = solid.filter((s) => s.medianLeadDays !== null)
    if (withLead.length >= 2) {
      const sorted = [...withLead].sort((a, b) => (a.medianLeadDays ?? 0) - (b.medianLeadDays ?? 0))
      const early = sorted[sorted.length - 1]
      const late = sorted[0]
      if (early.medianLeadDays !== late.medianLeadDays) {
        out.push(
          `节奏：${early.school}提前得最早，中位 ${early.medianLeadDays} 天发预告；${late.school}最晚，${late.medianLeadDays} 天。本校这项没有可用数据。`
        )
      }
    }
  }

  // 3. 学期位置：同一个活动放在学期第几周，是安排问题，不是执行问题
  const week = versus(schools, (s) => s.medianWeek)
  if (week && Math.abs(week.home - week.others) >= 2) {
    out.push(
      `周次：本校活动多在第 ${week.home} 周办，外校中位第 ${week.others} 周（${week.n} 所）——` +
        `相差 ${Math.abs(week.home - week.others)} 周。这是学期节奏上的位置差别，不是把某个环节做得更细就能追上的。`
    )
  }

  // 4. 合办
  const coHost = solid.filter((s) => s.coHostRate >= 0.5)
  if (coHost.length) {
    const names = coHost
      .sort((a, b) => b.coHostRate - a.coHostRate)
      .slice(0, 3)
      .map((s) => `${s.school}（${Math.round(s.coHostRate * 100)}%）`)
      .join('、')
    out.push(`组织方式：${names} 的活动过半有协办/联办单位。单打独斗还是拉人一起，是能直接照搬的差别。`)
  }

  const thin = schools.filter((s) => s.thin).map((s) => s.school)
  if (thin.length) {
    // 点名前三所：只说「还有 5 所」的话，用户不知道该去补采谁
    const head = thin.slice(0, 3).join('、')
    const more = thin.length > 3 ? ` 等 ${thin.length} 所` : ''
    out.push(
      `${head}${more}只有 1 场活动，样本太少没有进对比表——一条数据算出来的「平均」会被当成事实引用，所以宁可空着。`
    )
  }

  return out
}
