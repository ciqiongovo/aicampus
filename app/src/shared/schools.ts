/**
 * 高校清单与公众号命名套路（主进程与界面共用）。
 *
 * 为什么需要「命名套路」而不是一张写死的账号名单：
 * 学生组织的号很少规规矩矩叫「XX大学学生会」，大量用花名（团聚上大、社彩同济）。
 * 花名没法穷举，也没法凭猜生成——硬编一份名单等于把一半学校的号编错，
 * 而编错的账号搜出来是空的，用户会以为这所学校没东西。
 *
 * 所以这里只放两类东西：
 * 1. 学校清单（全称、简称、别名）——可以从校名稳定推出，是事实；
 * 2. 命名套路（全称+组织名、简称+组织名）——是可验证的猜测，一搜就知道对不对。
 *
 * 界面上必须让人看出第二步是猜测，所以候选账号是可以删改的，不是既成事实。
 */

export interface SchoolSeed {
  name: string
  shortName: string
  /** 用于从公众号名反查学校，长的优先匹配 */
  aliases: string[]
}

/** 本校。对标是为了替本校做决定，所以它必须在名单里且被标出来 */
export const HOME_SCHOOL = '上海科技大学'

/**
 * 上海高校清单。
 *
 * 收 985/211、市属本科与几所特色院校，不收独立学院与民办：
 * 榜单拉太长的结果是每所只采到一两篇，反而没法比。
 * 顺序按对标价值排，不按字母——学生最关心的往往是同层次学校在干什么。
 */
export const SHANGHAI_SCHOOLS: SchoolSeed[] = [
  { name: '复旦大学', shortName: '复旦', aliases: ['复旦大学', '复旦'] },
  { name: '上海交通大学', shortName: '交大', aliases: ['上海交通大学', '上海交大', '交大'] },
  { name: '同济大学', shortName: '同济', aliases: ['同济大学', '同济'] },
  {
    name: '华东师范大学',
    shortName: '华师大',
    aliases: ['华东师范大学', '华东师大', '华师大', '华师']
  },
  { name: '华东理工大学', shortName: '华理', aliases: ['华东理工大学', '华东理工', '华理'] },
  { name: '上海大学', shortName: '上大', aliases: ['上海大学', '上大'] },
  { name: '东华大学', shortName: '东华', aliases: ['东华大学', '东华'] },
  {
    name: '上海外国语大学',
    shortName: '上外',
    aliases: ['上海外国语大学', '上海外国语', '上外']
  },
  { name: '上海财经大学', shortName: '上财', aliases: ['上海财经大学', '上海财经', '上财'] },
  { name: '上海理工大学', shortName: '上理', aliases: ['上海理工大学', '上海理工', '上理'] },
  { name: '上海师范大学', shortName: '上师大', aliases: ['上海师范大学', '上海师范', '上师大'] },
  { name: '上海海事大学', shortName: '海事', aliases: ['上海海事大学', '上海海事', '海事大学'] },
  {
    name: '上海中医药大学',
    shortName: '中医大',
    aliases: ['上海中医药大学', '上海中医药', '中医大']
  },
  {
    name: '上海对外经贸大学',
    shortName: '上贸大',
    aliases: ['上海对外经贸大学', '对外经贸', '上贸大']
  },
  {
    name: '上海工程技术大学',
    shortName: '工程大',
    aliases: ['上海工程技术大学', '工程技术大学']
  },
  {
    name: '上海应用技术大学',
    shortName: '上应大',
    aliases: ['上海应用技术大学', '应用技术大学', '上应大']
  },
  { name: '上海电力大学', shortName: '上电', aliases: ['上海电力大学', '上海电力', '上电'] },
  {
    name: '上海立信会计金融学院',
    shortName: '立信',
    aliases: ['上海立信会计金融学院', '立信会计', '立信']
  },
  { name: '华东政法大学', shortName: '华政', aliases: ['华东政法大学', '华东政法', '华政'] },
  { name: '上海政法学院', shortName: '上政', aliases: ['上海政法学院', '上政'] },
  { name: '上海体育大学', shortName: '上体', aliases: ['上海体育大学', '上海体育学院', '上体'] },
  { name: HOME_SCHOOL, shortName: '上科大', aliases: ['上海科技大学', '上科大'] },
  { name: '上海音乐学院', shortName: '上音', aliases: ['上海音乐学院', '上音'] },
  { name: '上海戏剧学院', shortName: '上戏', aliases: ['上海戏剧学院', '上戏'] },
  { name: '上海第二工业大学', shortName: '二工大', aliases: ['上海第二工业大学', '二工大'] },
  { name: '上海电机学院', shortName: '电机', aliases: ['上海电机学院', '电机学院'] },
  { name: '上海商学院', shortName: '上商', aliases: ['上海商学院', '上商'] },
  { name: '上海健康医学院', shortName: '健康', aliases: ['上海健康医学院', '健康医学院'] },
  { name: '上海海关学院', shortName: '海关', aliases: ['上海海关学院', '海关学院'] }
]

/**
 * 已经查证存在的公众号。
 *
 * 这份名单不是猜的：它来自上科大官方发布的《公众号总集篇》，
 * 名字一个字都没改。留在这里的意义是——学生的号大量用「学工部团委」「书院的天空」
 * 这种完全不按校名起名的写法，靠套路推一百次也推不到，而配额只够搜四五次。
 *
 * 只收与学生活动相关的号。学院号、招生号、设备处那类不发学生活动，
 * 收了只会让搜索白跑。用户自己确认到的号也会写进同一条记录，不分内外。
 */
export const KNOWN_ACCOUNTS: Record<string, string[]> = {
  [HOME_SCHOOL]: [
    '上海科技大学学生会',
    '上科大学工部团委',
    '上海科技大学',
    '书院的天空',
    '上科大创艺'
  ]
}

export interface AccountPattern {
  org: string
  category: 'student_union' | 'youth_league' | 'college' | 'other'
  /** 搜索优先级，数字大的先搜。配额有限时这个顺序决定先查谁 */
  weight: number
}

/**
 * 账号命名套路。顺序即搜索优先级。
 *
 * 「学生会」排第一，因为报名表说的对标对象就是学生会与团委。
 * 研究生会单列而不并进学生会：学术沙龙和迎新晚会是两种东西，混着比看不出门道。
 */
export const ACCOUNT_PATTERNS: AccountPattern[] = [
  { org: '学生会', category: 'student_union', weight: 10 },
  { org: '研究生会', category: 'student_union', weight: 8 },
  { org: '团委', category: 'youth_league', weight: 7 },
  { org: '学生联合会', category: 'student_union', weight: 6 },
  { org: '青年', category: 'youth_league', weight: 5 },
  { org: '社团联合会', category: 'other', weight: 4 },
  { org: '志愿者', category: 'other', weight: 3 }
]

/**
 * 生成某所学校要去找的公众号名。
 *
 * 每种组织名给两种写法：全称+组织名（规范做法）、简称+组织名（学生自己做的号常用）。
 * 不生成「复旦大学学生」这类截断变体：搜出来全是别的东西，白烧配额。
 */
export function candidateAccounts(school: SchoolSeed): string[] {
  const names: string[] = []
  for (const pattern of ACCOUNT_PATTERNS) {
    names.push(`${school.name}${pattern.org}`)
    if (school.shortName && school.shortName !== school.name) {
      names.push(`${school.shortName}${pattern.org}`)
    }
  }
  return [...new Set(names)]
}

/**
 * 合并「查证过的」和「按套路猜的」。
 *
 * 查证的排前面且不去重掉：去重的键是名字，但两者可能重名，
 * 重名说明这条已经确认过，套路那边就不用再浪费一次搜索。
 */
export function mergeAccounts(known: string[], guessed: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of [...known, ...guessed]) {
    const clean = name.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/** 这个组织名对应的源分类 */
export function categoryOfOrg(accountName: string): AccountPattern['category'] {
  const hit = ACCOUNT_PATTERNS.find((p) => accountName.includes(p.org))
  return hit?.category ?? 'other'
}

/** 中小学、考研机构混进来会污染统计——对标的是高校，不是 K12 */
const NOT_UNIVERSITY = /中学|小学|附中|高中|幼儿园|国际学校|择校|升学|留学|考研|专升本/

/**
 * 从公众号名反查学校。
 *
 * 先查上海高校简称表（准确），再退化为「名字里带大学/学院的取到该词为止」，
 * 都不行就留空。刻意不猜外省市高校：这个库对标的是上海兄弟高校，
 * 猜成「南京师范大学」只会让筛选器里多出一堆用不上的选项。
 */
export function schoolOfAccount(accountName: string): string {
  const name = accountName.replace(/\s+/g, '').trim()
  if (!name) return ''
  if (NOT_UNIVERSITY.test(name)) return ''

  let best: { school: string; len: number } | null = null
  for (const item of SHANGHAI_SCHOOLS) {
    for (const alias of item.aliases) {
      if (!name.includes(alias)) continue
      if (!best || alias.length > best.len) best = { school: item.name, len: alias.length }
    }
  }
  if (best) return best.school

  const generic = name.match(/^[\u4e00-\u9fa5]{2,12}?(?:大学|学院)/)
  return generic ? generic[0] : ''
}

/** 按校名找清单项；找不到就用校名本身造一个，保证自定义学校也能用 */
export function findSchool(name: string): SchoolSeed {
  const hit = SHANGHAI_SCHOOLS.find((s) => s.name === name)
  if (hit) return hit
  return { name, shortName: '', aliases: [name] }
}
