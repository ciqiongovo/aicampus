/**
 * 简报生成。
 *
 * 这是整个对标库最终要交付的东西：不是一张表格，是一段能直接念给人听的话。
 * 「老师问别的学校毕业季怎么做的」，答案不该是「我筛一下」，而是「给你，
 * 五所学校、九场活动、各校怎么办的、哪些我们能照做，原文链接都在下面」。
 *
 * 刻意不做的事：
 * - 不做摘要改写。模型摘要会引入原文没有的说法，而对标结论最怕这个。
 *   这里只做「选择 + 排序 + 排版」，每个字都来自原文或抽取字段。
 * - 不隐藏缺字段。时间不知道就写「原文未写」，不空着也不猜。
 */

import type { BenchBrief, BenchBriefItem, BenchCompare } from '../../../shared/benchmark'
import { buildCompare } from './compare'

const FIT_TEXT: Record<string, string> = {
  easy: '现成条件可办',
  possible: '协调后可行',
  hard: '门槛较高',
  unsuitable: '不适合照搬',
  '': '未评估'
}

/**
 * 时间怎么写。
 *
 * 这里曾经把「发布时间」当作活动时间的兜底，那是错的：一篇 9 月 26 日发出、
 * 通知 9 月 27 日活动的推文，兜底之后会显示成 9 月 26 日，读者以为是活动日期。
 * 所以活动时间没有就写「原文未写」，发布时间另起一行，标清楚它是什么。
 *
 * 周次前面加「约」：它多半是按日期和开学日推出来的，不是原文写的。
 * 各校校历不同，同一个日期在复旦是第 4 周、在上科大可能第 3 周，
 * 标成确数会让人拿它当依据。
 */
function fmtTime(item: BenchBriefItem): string {
  if (!item.startAt) return '原文未写'
  const text = item.startAt.slice(0, 16)
  return item.weekNo ? `${text}（约第 ${item.weekNo} 周）` : text
}

function oneLine(label: string, value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  return v ? `- ${label}：${v}` : null
}

/**
 * 一条活动的正文块。
 *
 * 字段顺序是从「是什么」到「能不能照做」：
 * 时间地点是背景，组织方式与规模是成本，议程与特色是可抄的部分，
 * 可迁移性与依据是结论。念的时候照着往下读就是一段话。
 */
function itemBlock(item: BenchBriefItem, index: number): string[] {
  const lines: string[] = []
  lines.push(`### ${index}. ${item.title || '(无标题)'}`)
  const rows = [
    oneLine('时间', fmtTime(item)),
    item.startAt ? null : oneLine('推文发布于', item.publishedAt ? item.publishedAt.slice(0, 10) : ''),
    oneLine('类型', item.kind),
    oneLine('地点', item.location),
    oneLine('组织方式', item.orgForm),
    oneLine('协办', item.coOrganizer),
    oneLine('时长', item.duration),
    oneLine('规模', item.scale),
    oneLine('面向', item.audience),
    item.promoChannels.length ? oneLine('宣传形式', item.promoChannels.join('、')) : null,
    oneLine('可迁移', FIT_TEXT[item.migrationFit] ?? '未评估'),
    oneLine('依据', item.migrationNote)
  ].filter(Boolean) as string[]
  lines.push(...rows)
  if (item.agenda.length) lines.push(`- 议程：${item.agenda.join(' → ')}`)
  if (item.highlights.length) lines.push(`- 特色环节：${item.highlights.join('；')}`)
  // 把握不足的标出来：这份简报会被拿去做决定，得让人知道哪几条没把握
  if (item.confidence > 0 && item.confidence < 0.7) {
    lines.push(`- 待核对：字段抽取把握 ${Math.round(item.confidence * 100)}%，建议对照原文`)
  }
  lines.push(`- 原文：${item.url}`)
  lines.push('')
  return lines
}

/** 百分比，不写小数——简报里的数不该比它的来源更精确 */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function ratioText(n: number | null, unit: string): string {
  return n === null ? '—' : `${n} ${unit}`
}

/**
 * 横向对比那一节。
 *
 * 放在逐条明细之前：读者先要知道「谁在哪一项上不一样」，再看具体怎么办的。
 * 反过来放的话，读完几十条才看到结论，前面那些就白读了。
 */
function compareSection(c: BenchCompare): string[] {
  const lines: string[] = []
  lines.push('## 先说结论')
  lines.push('')
  for (const s of c.insights) {
    lines.push(`- ${s}`)
  }
  lines.push('')

  const solid = c.schools.filter((s) => !s.thin)
  if (solid.length) {
    // 列随数据走：某项不足两所学校有数据就整列不出现。
    // 摆一串「—」既占地方，又容易让人以为是我们没抽出来。
    const cols: { head: string; get: (s: (typeof solid)[number]) => string }[] = [
      { head: '活动数', get: (s) => (s.sessions < s.activities ? `${s.activities}/${s.sessions} 篇/场` : String(s.activities)) }
    ]
    if (c.coverage.scale >= 2) {
      cols.push(
        { head: '中位规模', get: (s) => ratioText(s.medianScale, '人') },
        { head: '人数覆盖', get: (s) => pct(s.scaleCoverage) }
      )
    }
    if (c.coverage.week >= 2) {
      cols.push({
        head: '中位周次',
        get: (s) => (s.medianWeek === null ? '—' : `第 ${s.medianWeek} 周`)
      })
    }
    if (c.coverage.lead >= 2) {
      cols.push({ head: '提前预告', get: (s) => ratioText(s.medianLeadDays, '天') })
    }
    if (c.coverage.promo >= 2) {
      cols.push({ head: '宣传手段', get: (s) => `${s.promoPerItem} 种` })
    }
    if (c.coverage.coHost >= 2) {
      cols.push({ head: '有协办', get: (s) => pct(s.coHostRate) })
    }
    cols.push({ head: '最常办', get: (s) => s.topKind })

    lines.push('### 各校一览')
    lines.push('')
    lines.push(`| 学校 | ${cols.map((x) => x.head).join(' | ')} |`)
    lines.push(`| --- | ${cols.map(() => '---').join(' | ')} |`)
    for (const s of solid) {
      const cells = cols.map((x) => x.get(s))
      lines.push(`| ${s.school}${s.isHome ? '（本校）' : ''} | ${cells.join(' | ')} |`)
    }
    lines.push('')
    lines.push(
      '> 中位数只按「原文写明」的条目算，覆盖率另列。某项不足两所学校有数据时整列不出——那不是漏抽，是原文普遍没写。'
    )
    lines.push('')
  }

  if (c.kinds.length) {
    lines.push('### 办的是些什么活动')
    lines.push('')
    lines.push(
      c.kinds
        .filter((k) => k.count > 0)
        .slice(0, 8)
        .map((k) => `${k.label} ${k.count} 场（${pct(k.share)}）`)
        .join(' · ')
    )
    lines.push('')
  }

  if (c.promos.length) {
    lines.push('### 宣传都用哪些手段')
    lines.push('')
    lines.push(
      c.promos
        .slice(0, 8)
        .map((p) => `${p.label} ${p.count} 次`)
        .join(' · ')
    )
    lines.push('')
  }

  lines.push(...topicSection(c))

  return lines
}

/** 表格单元格里的竖线与换行会把 Markdown 表撕开，先换成全角竖线与空格 */
function cell(v: string): string {
  return (v || '').replace(/\|/g, '／').replace(/\s*\n+\s*/g, ' ').trim()
}

/**
 * 同一件事各校怎么办。
 *
 * 只取前两类、每类最多八场：这一节是给人「照着改」的参考，
 * 不是全量清单——全量在后面的逐条明细里，一条不少。
 */
function topicSection(c: BenchCompare): string[] {
  const topics = c.topics.slice(0, 2).filter((t) => t.rows.length >= 2)
  if (!topics.length) return []

  const lines: string[] = []
  lines.push('### 同一件事，各校怎么办')
  lines.push('')

  for (const t of topics) {
    lines.push(`**${t.kind}**（${t.schools} 所学校 ${t.rows.length} 场）`)
    lines.push('')
    lines.push(t.note)
    lines.push('')

    // 列随数据走：这一类的活动都没写场地，就不摆场地一列。
    // 摆出来是一整列「—」，读的人会以为抽取坏了，而不是原文没写。
    // 门槛是「至少两行、且不低于四分之一」：20 场里只有 2 场写了参与方式，
    // 单开一列会让人以为这是个可比的维度。
    const enough = (pred: (r: (typeof t.rows)[number]) => boolean): boolean =>
      t.rows.filter(pred).length >= Math.max(2, Math.ceil(t.rows.length * 0.25))

    const hasVenue = enough((r) => Boolean(r.location))
    const hasJoin = enough((r) => Boolean(r.joinMethod))
    const hasHl = enough((r) => r.highlights.length > 0)

    const head = ['学校', '时间']
    if (hasVenue) head.push('场地')
    if (hasJoin) head.push('参与方式')
    if (hasHl) head.push('特色')

    lines.push(`| ${head.join(' | ')} |`)
    lines.push(`| ${head.map(() => '---').join(' | ')} |`)

    for (const r of t.rows.slice(0, 8)) {
      const when = r.startAt
        ? `${r.startAt.slice(0, 10)}${r.weekNo ? ` 第${r.weekNo}周` : ''}`
        : '—'
      const cells = [`${cell(r.school)}${r.isHome ? '（本校）' : ''}`, when]
      if (hasVenue) cells.push(cell(r.location) || '—')
      if (hasJoin) cells.push(cell(r.joinMethod) || '—')
      if (hasHl) cells.push(cell(r.highlights.slice(0, 2).join('；')) || '—')
      lines.push(`| ${cells.join(' | ')} |`)
    }
    if (t.rows.length > 8) {
      lines.push(`| 另有 ${t.rows.length - 8} 场 |${' |'.repeat(head.length - 1)}`)
    }
    lines.push('')
  }

  return lines
}

/** 把一组活动排成 Markdown。返回的字符串要能直接粘进 Word 或群聊 */
export function buildBriefMarkdown(brief: Omit<BenchBrief, 'markdown'>): string {
  const lines: string[] = []
  lines.push(`# ${brief.title}`)
  lines.push('')
  lines.push(
    `> 生成于 ${brief.generatedAt} · 覆盖 ${brief.schoolCount} 所学校 · ` +
      (brief.sessionCount < brief.activityCount
        ? `${brief.activityCount} 条记录（合并成 ${brief.sessionCount} 场）`
        : `${brief.activityCount} 场活动`)
  )
  lines.push('')

  if (!brief.items.length) {
    lines.push('库里没有符合条件的活动。可以放宽时间范围，或先补采几个公众号。')
    return lines.join('\n')
  }

  lines.push(...compareSection(brief.compare))

  if (brief.compare.insights.length) {
    lines.push('---')
    lines.push('')
  }

  // 本校单列一节，放在最前。
  // 对标的说服力来自「别人这么做，我们这么做」的并置，本校要是混在外校中间，
  // 读的人得先分辨哪条是自己学校，一条条比下来很容易把本校做法当成外校经验。
  const homeItems = brief.items.filter((i) => i.isHome)
  if (homeItems.length) {
    const homeName = homeItems[0].school || '本校'
    lines.push(`## 本校基准：${homeName}（${homeItems.length} 场）`)
    lines.push('')
    lines.push('> 这一节是本校自己的做法，用来和下面各校对比，不是要照搬的对象。')
    lines.push('')
    for (const [i, item] of homeItems.entries()) {
      lines.push(...itemBlock(item, i + 1))
    }
  }

  // 分学校铺开：同一所学校的事放在一起，念的时候不用来回跳。
  // 顺序直接取上面那张对比表（本校之外按活动数降序），
  // 否则表里第一行和正文第一节对不上，读的人要来回确认是不是漏了。
  const bySchool = new Map<string, BenchBriefItem[]>()
  for (const item of brief.items) {
    if (item.isHome) continue
    const key = item.school || '未填学校'
    if (!bySchool.has(key)) bySchool.set(key, [])
    bySchool.get(key)!.push(item)
  }
  const schoolOrder = brief.compare.schools.filter((s) => !s.isHome).map((s) => s.school)
  const ordered = [
    ...schoolOrder.filter((s) => bySchool.has(s)),
    ...[...bySchool.keys()].filter((s) => !schoolOrder.includes(s))
  ]

  for (const school of ordered) {
    const items = bySchool.get(school)!
    lines.push(`## ${school}（${items.length} 场）`)
    lines.push('')
    for (const [i, item] of items.entries()) {
      lines.push(...itemBlock(item, i + 1))
    }
  }

  if (!homeItems.length && brief.items.length) {
    lines.push('> 本校还没有入档的活动，所以这份简报只有外校情况，没有可对照的基准行。')
    lines.push('> 在「学校」里把本校勾上、采集一次，下次生成就会多出「本校基准」一节。')
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    '字段说明：时间、地点、协办、时长、规模均取自原文，原文没写就不列。' +
      '周次为按开学日推算的近似值（各校校历不同），仅供参考。' +
      '标「待核对」的条目抽取把握不足七成，做决定前请对照原文。'
  )
  return lines.join('\n')
}

/** 组装一份完整简报（含标题与分组统计） */
export function composeBrief(
  items: BenchBriefItem[],
  filterLabel: string,
  now: Date
): BenchBrief {
  const perSchoolMap = new Map<string, number>()
  for (const item of items) {
    const key = item.school || '未填学校'
    perSchoolMap.set(key, (perSchoolMap.get(key) ?? 0) + 1)
  }
  const perSchool = [...perSchoolMap.entries()]
    .map(([school, count]) => ({ school, count }))
    .sort((a, b) => b.count - a.count || a.school.localeCompare(b.school))

  const p = (n: number): string => String(n).padStart(2, '0')
  const generatedAt = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`

  // 对比永远基于同一批条目：表里写九场、正文只列五场这种事不能出现
  const compare = buildCompare(items)

  const base: Omit<BenchBrief, 'markdown'> = {
    title: `${filterLabel}对标简报`,
    generatedAt,
    schoolCount: perSchool.filter((s) => s.school !== '未填学校').length,
    activityCount: items.length,
    sessionCount: compare.schools.reduce((n, s) => n + s.sessions, 0),
    perSchool,
    items,
    // 对比永远基于同一批条目：表里写九场、正文只列五场这种事不能出现
    compare
  }
  return { ...base, markdown: buildBriefMarkdown(base) }
}
