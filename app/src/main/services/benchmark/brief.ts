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

import type { BenchBrief, BenchBriefItem } from '../../../shared/benchmark'

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

/** 把一组活动排成 Markdown。返回的字符串要能直接粘进 Word 或群聊 */
export function buildBriefMarkdown(brief: Omit<BenchBrief, 'markdown'>): string {
  const lines: string[] = []
  lines.push(`# ${brief.title}`)
  lines.push('')
  lines.push(
    `> 生成于 ${brief.generatedAt} · 覆盖 ${brief.schoolCount} 所学校 · ${brief.activityCount} 场活动`
  )
  lines.push('')

  if (!brief.items.length) {
    lines.push('库里没有符合条件的活动。可以放宽时间范围，或先补采几个公众号。')
    return lines.join('\n')
  }

  lines.push('## 概览')
  lines.push('')
  lines.push('| 学校 | 活动数 |')
  lines.push('| --- | --- |')
  for (const s of brief.perSchool) lines.push(`| ${s.school || '未填学校'} | ${s.count} |`)
  lines.push('')

  // 分学校铺开：同一所学校的事放在一起，念的时候不用来回跳。
  // 顺序跟上面的概览表一模一样（活动多的在前，同数量按校名），
  // 否则表里第一行和正文第一节对不上，读的人要来回确认是不是漏了。
  const bySchool = new Map<string, BenchBriefItem[]>()
  for (const item of brief.items) {
    const key = item.school || '未填学校'
    if (!bySchool.has(key)) bySchool.set(key, [])
    bySchool.get(key)!.push(item)
  }
  const schoolOrder = brief.perSchool.map((s) => s.school || '未填学校')
  const ordered = [
    ...schoolOrder.filter((s) => bySchool.has(s)),
    ...[...bySchool.keys()].filter((s) => !schoolOrder.includes(s))
  ]

  for (const school of ordered) {
    const items = bySchool.get(school)!
    lines.push(`## ${school}（${items.length} 场）`)
    lines.push('')
    for (const [i, item] of items.entries()) {
      lines.push(`### ${i + 1}. ${item.title || '(无标题)'}`)
      const rows = [
        oneLine('时间', fmtTime(item)),
        item.startAt ? null : oneLine('推文发布于', item.publishedAt ? item.publishedAt.slice(0, 10) : ''),
        oneLine('类型', item.kind),
        oneLine('地点', item.location),
        oneLine('组织方式', item.orgForm),
        oneLine('面向', item.audience),
        item.promoChannels.length ? oneLine('宣传形式', item.promoChannels.join('、')) : null,
        oneLine('可迁移', FIT_TEXT[item.migrationFit] ?? '未评估'),
        oneLine('依据', item.migrationNote)
      ].filter(Boolean) as string[]
      lines.push(...rows)
      if (item.agenda.length) {
        lines.push(`- 议程：${item.agenda.join(' → ')}`)
      }
      // 把握不足的标出来：这份简报会被拿去做决定，得让人知道哪几条没把握
      if (item.confidence > 0 && item.confidence < 0.7) {
        lines.push(`- 待核对：字段抽取把握 ${Math.round(item.confidence * 100)}%，建议对照原文`)
      }
      lines.push(`- 原文：${item.url}`)
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(
    '字段说明：时间取自原文；周次为按开学日推算的近似值（各校校历不同），仅供参考。' +
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

  const base: Omit<BenchBrief, 'markdown'> = {
    title: `${filterLabel}对标简报`,
    generatedAt,
    schoolCount: perSchool.filter((s) => s.school !== '未填学校').length,
    activityCount: items.length,
    perSchool,
    items
  }
  return { ...base, markdown: buildBriefMarkdown(base) }
}
