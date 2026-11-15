/**
 * 对标报告（HTML）。
 *
 * 为什么不是 Markdown：这份东西最终要交到老师桌上。Markdown 粘进 Word 会掉表格样式，
 * 粘进群聊在手机上是一团星号。生成一个自包含的 HTML——样式全写在文件里，
 * 不引任何外部资源——双击就能看，Ctrl+P 就能印，发给别人也不会缺图缺字体。
 *
 * 不做的事：不引 CDN、不写脚本、不用外链字体。别人电脑上能不能打开，
 * 不该取决于他有没有网、装没装某个字体。
 */

import type { BenchBrief, BenchBriefItem, BenchCompare, BenchCompareSchool } from '../../../shared/benchmark'

function esc(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function num(n: number | null, unit: string): string {
  return n === null ? '<span class="muted">—</span>' : `${n}<span class="unit">${unit}</span>`
}

function fmtTime(item: BenchBriefItem): string {
  if (!item.startAt) return ''
  const text = item.startAt.slice(0, 16)
  return item.weekNo ? `${text} · 约第 ${item.weekNo} 周` : text
}

/** 一条活动的卡片。字段为空就整行不出现——空格子和「原文未写」是两种噪音 */
function itemCard(item: BenchBriefItem, index: number): string {
  const rows: [string, string][] = []
  const time = fmtTime(item)
  if (time) rows.push(['时间', time])
  else if (item.publishedAt) rows.push(['发布', `${item.publishedAt.slice(0, 10)}（活动时间原文未写）`])
  if (item.location) rows.push(['地点', item.location])
  if (item.orgForm) rows.push(['组织', item.orgForm])
  if (item.coOrganizer) rows.push(['协办', item.coOrganizer])
  if (item.duration) rows.push(['时长', item.duration])
  if (item.scale) rows.push(['规模', item.scale])
  if (item.audience) rows.push(['面向', item.audience])

  const meta = rows
    .map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`)
    .join('')

  const agenda = item.agenda.length
    ? `<div class="line"><span class="k">议程</span><span class="v">${esc(item.agenda.join(' → '))}</span></div>`
    : ''
  const highlights = item.highlights.length
    ? `<div class="line"><span class="k">特色</span><span class="v">${esc(item.highlights.join('；'))}</span></div>`
    : ''
  const promo = item.promoChannels.length
    ? `<div class="line"><span class="k">宣传</span><span class="v">${esc(item.promoChannels.join('、'))}</span></div>`
    : ''
  const fit = item.migrationFit
    ? `<div class="line"><span class="k">可迁移</span><span class="v">${
        { easy: '现成条件可办', possible: '协调后可行', hard: '门槛较高', unsuitable: '不适合照搬' }[
          item.migrationFit
        ] ?? '未评估'
      }${item.migrationNote ? `　${esc(item.migrationNote)}` : ''}</span></div>`
    : ''
  const flag =
    item.confidence > 0 && item.confidence < 0.7
      ? `<span class="flag">待核对 ${Math.round(item.confidence * 100)}%</span>`
      : ''

  return `
  <article class="card">
    <h4><span class="idx">${index}</span>${esc(item.title || '(无标题)')}${flag}</h4>
    <div class="meta">${meta}</div>
    ${agenda}${highlights}${promo}${fit}
    <div class="src">原文 · <a href="${esc(item.url)}">${esc(item.url)}</a></div>
  </article>`
}

/** 横向条形：标题 + 条 + 数字。条长按最大值归一，不按百分比——百分比柱在一行里看不出来 */
function bars(title: string, data: { label: string; count: number; share: number }[]): string {
  const rows = data.filter((d) => d.count > 0).slice(0, 10)
  if (!rows.length) return ''
  const max = Math.max(...rows.map((r) => r.count))
  return `
  <section class="block">
    <h3>${esc(title)}</h3>
    <div class="bars">
      ${rows
        .map(
          (r) => `<div class="bar-row">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max((r.count / max) * 100, 2).toFixed(1)}%"></span></span>
        <span class="bar-val">${r.count}<span class="unit">条</span></span>
      </div>`
        )
        .join('')}
    </div>
  </section>`
}

/**
 * 各校一览。
 *
 * 列是按「有几所学校真有这项数据」动态加的：实测 51 场活动里只有 5 场写了参与人数，
 * 固定摆一列规模的话满格都是「—」，看的人会以为抽取出了故障。
 */
function schoolTable(compare: BenchCompare): string {
  const solid = compare.schools.filter((s) => !s.thin)
  if (!solid.length) return ''
  const cov = compare.coverage

  const head: string[] = ['<th>学校</th>', '<th class="n" title="篇数；斜杠后是按类型+日期合并后的场次（同一场活动的预告、招募、回顾各算一篇）">活动</th>']
  const cell = (s: BenchCompareSchool): string[] => [
    `<td class="name">${esc(s.school)}${s.isHome ? '<span class="tag">本校</span>' : ''}</td>`,
    `<td class="n">${s.sessions < s.activities ? `${s.activities}<span class="slash">/${s.sessions}</span>` : s.activities}</td>`
  ]

  const cols: { th: string; td: (s: BenchCompareSchool) => string }[] = []
  if (cov.scale >= 2) {
    cols.push(
      { th: '<th class="n">中位规模</th>', td: (s) => `<td class="n">${num(s.medianScale, '人')}</td>` },
      {
        th: '<th class="n" title="原文写明人数的活动占比">人数覆盖</th>',
        td: (s) => `<td class="n muted">${pct(s.scaleCoverage)}</td>`
      }
    )
  }
  if (cov.week >= 2) {
    cols.push({
      th: '<th class="n" title="按开学日估算，各校校历不同">中位周次</th>',
      td: (s) => `<td class="n">${s.medianWeek === null ? '<span class="muted">—</span>' : `第 ${s.medianWeek} 周`}</td>`
    })
  }
  if (cov.lead >= 2) {
    cols.push({
      th: '<th class="n" title="推文发布到活动开始的天数中位数">提前预告</th>',
      td: (s) => `<td class="n">${num(s.medianLeadDays, '天')}</td>`
    })
  }
  if (cov.promo >= 2) {
    cols.push({
      th: '<th class="n" title="每条活动平均提到的宣传手段数">宣传手段</th>',
      td: (s) => `<td class="n">${s.promoPerItem}</td>`
    })
  }
  if (cov.coHost >= 2) {
    cols.push({ th: '<th class="n">有协办</th>', td: (s) => `<td class="n">${pct(s.coHostRate)}</td>` })
  }
  cols.push({ th: '<th>最常办</th>', td: (s) => `<td class="kind">${esc(s.topKind)}</td>` })

  head.push(...cols.map((c) => c.th))
  const rows = solid
    .map(
      (s) =>
        `<tr class="${s.isHome ? 'home' : ''}">${[...cell(s), ...cols.map((c) => c.td(s))].join('')}</tr>`
    )
    .join('')

  return `
  <section class="block">
    <h3>各校一览</h3>
    <table class="grid">
      <thead><tr>${head.join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">中位数只按「原文写明」的条目算，旁边一列是覆盖率：18 场里只有 2 场写了人数时，这个中位数不能和写满 18 场的学校并排看待。没有出现的列，说明有这项数据的学校不足两所。活动数写成「6/3」的地方，是 6 篇推文合并成 3 场：同一场活动的预告、招募、回顾各算一条。</p>
  </section>`
}

/**
 * 同一件事，各校怎么办。
 *
 * 各校一览回答「谁办得多、谁预热早」，这一节回答「我要办这一场，别人怎么做的」。
 * 打印稿里最多放两类、每类十场：再多就成了一本人名录，反而没人看。
 */
function topicTables(compare: BenchCompare): string {
  const topics = compare.topics.slice(0, 2).filter((t) => t.rows.length >= 2)
  if (!topics.length) return ''

  return topics
    .map((t) => {
      // 列随数据走：这一类的活动都没写场地，就不摆场地一列，免得整列都是「—」
      const enough = (pred: (r: (typeof t.rows)[number]) => boolean): boolean =>
        t.rows.filter(pred).length >= Math.max(2, Math.ceil(t.rows.length * 0.25))

      const hasVenue = enough((r) => Boolean(r.location))
      const hasJoin = enough((r) => Boolean(r.joinMethod))
      const hasHl = enough((r) => r.highlights.length > 0)
      const span = 2 + (hasVenue ? 1 : 0) + (hasJoin ? 1 : 0) + (hasHl ? 1 : 0)

      const rows = t.rows
        .slice(0, 10)
        .map((r) => {
          const when = r.startAt
            ? `${esc(r.startAt.slice(0, 10))}${r.weekNo ? `<span class="unit">第${r.weekNo}周</span>` : ''}`
            : '<span class="muted">—</span>'
          const cells = [
            `<td class="name">${esc(r.school)}${r.isHome ? '<span class="tag">本校</span>' : ''}</td>`,
            `<td class="when">${when}</td>`
          ]
          if (hasVenue) cells.push(`<td>${r.location ? esc(r.location) : '<span class="muted">—</span>'}</td>`)
          if (hasJoin) cells.push(`<td>${r.joinMethod ? esc(r.joinMethod) : '<span class="muted">—</span>'}</td>`)
          if (hasHl) {
            const hl = r.highlights.slice(0, 2).join('；')
            cells.push(`<td class="hl">${hl ? esc(hl) : '<span class="muted">—</span>'}</td>`)
          }
          return `<tr class="${r.isHome ? 'home' : ''}">${cells.join('')}</tr>`
        })
        .join('')

      const more =
        t.rows.length > 10
          ? `<tr><td colspan="${span}" class="muted">另有 ${t.rows.length - 10} 场，见后文逐校明细</td></tr>`
          : ''

      const head = ['<th>学校</th>', '<th>时间</th>']
      if (hasVenue) head.push('<th>场地</th>')
      if (hasJoin) head.push('<th>参与方式</th>')
      if (hasHl) head.push('<th>特色</th>')

      return `
  <section class="block">
    <h3>${esc(t.kind)}<span class="sub">${t.schools} 所学校 ${t.rows.length} 场</span></h3>
    <p class="note">${esc(t.note)}</p>
    <table class="grid">
      <thead><tr>${head.join('')}</tr></thead>
      <tbody>${rows}${more}</tbody>
    </table>
  </section>`
    })
    .join('')
}

const STYLE = `:root{
  --ink:#1c1c1a; --ink-2:#4a4a46; --ink-3:#8a8a82;
  --line:#e2e0da; --wall:#f6f5f1; --paper:#fff; --accent:#9b3b2f;
}
*{box-sizing:border-box}
body{
  margin:0; padding:48px 32px 72px; background:var(--wall); color:var(--ink);
  font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Source Han Sans SC",sans-serif;
  font-size:14px; line-height:1.75; -webkit-font-smoothing:antialiased;
}
.wrap{max-width:860px; margin:0 auto; background:var(--paper); padding:52px 56px 64px;
  box-shadow:0 1px 3px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.05); border-radius:2px}
h1{font-size:27px; line-height:1.35; margin:0 0 10px; font-weight:700; letter-spacing:-.2px}
.sub{color:var(--ink-3); font-size:12.5px; letter-spacing:.3px; margin-bottom:34px;
  padding-bottom:22px; border-bottom:2px solid var(--ink)}
h2{font-size:16px; margin:38px 0 14px; font-weight:700; display:flex; align-items:center; gap:10px}
h2::before{content:""; width:3px; height:15px; background:var(--accent); border-radius:1px}
h3{font-size:13.5px; margin:26px 0 12px; font-weight:700; color:var(--ink-2); letter-spacing:.4px}
h4{font-size:14px; margin:0 0 10px; font-weight:600; line-height:1.5; display:flex; align-items:baseline; gap:8px}
.idx{color:var(--ink-3); font-size:12px; font-variant-numeric:tabular-nums; flex:none}
.flag{flex:none; font-size:11px; color:#8a5a12; background:#fdf4e3; border:1px solid #f0e0bf;
  border-radius:3px; padding:1px 6px; font-weight:400}

.findings{list-style:none; padding:0; margin:0; counter-reset:f}
.findings li{position:relative; padding:9px 0 9px 30px; border-bottom:1px dashed var(--line); color:var(--ink)}
.findings li:before{counter-increment:f; content:counter(f); position:absolute; left:0; top:10px;
  width:19px; height:19px; border-radius:50%; background:var(--ink); color:#fff; font-size:11px;
  text-align:center; line-height:19px; font-variant-numeric:tabular-nums}
.findings li:last-child{border-bottom:none}

table.grid{width:100%; border-collapse:collapse; font-size:13px; table-layout:fixed}
/* 第一列给学校名留足位置：fixed 布局下平均分配，八列时「上海科技大学」会被折成两行 */
table.grid th:first-child{width:24%}
table.grid th{ text-align:left; font-weight:600; color:var(--ink-3); font-size:11.5px; letter-spacing:.5px;
  padding:0 8px 8px; border-bottom:1.5px solid var(--ink); white-space:nowrap}
table.grid td{padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:middle}
table.grid th.n, table.grid td.n{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap}
table.grid td.name{font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
table.grid td.kind{color:var(--ink-2)}
/* 同类活动表：时间不折行，特色一栏字号小一档，免得把行撑成三行高 */
table.grid td.when{white-space:nowrap; color:var(--ink-2); font-variant-numeric:tabular-nums}
table.grid td.hl{color:var(--ink-2); font-size:12px}
h3 .sub{font-weight:400; font-size:11.5px; color:var(--ink-3); margin-left:8px; letter-spacing:0}
table.grid tr.home td{background:#faf8f4}
table.grid tr.home td.name{box-shadow:inset 3px 0 0 var(--accent)}
table.grid td .slash{color:var(--ink-3); font-weight:400}
.tag{font-size:10.5px; color:var(--accent); border:1px solid currentColor; border-radius:2px;
  padding:0 4px; margin-left:6px; font-weight:400; vertical-align:1px}
.unit{color:var(--ink-3); font-size:11px; margin-left:3px}
.muted{color:var(--ink-3)}

.bars{display:flex; flex-direction:column; gap:7px}
.bar-row{display:grid; grid-template-columns:104px 1fr 46px; align-items:center; gap:12px}
.bar-label{font-size:12.5px; color:var(--ink-2); text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.bar-track{height:14px; background:var(--wall); border-radius:2px; overflow:hidden}
.bar-fill{display:block; height:100%; background:var(--ink-2); border-radius:2px}
.bar-val{font-size:12px; color:var(--ink-2); font-variant-numeric:tabular-nums; text-align:right}

.school{margin-top:26px}
.school-head{display:flex; align-items:baseline; gap:10px; padding-bottom:7px; border-bottom:1px solid var(--ink);
  margin-bottom:14px}
.school-head .nm{font-size:15px; font-weight:700}
.school-head .ct{font-size:12px; color:var(--ink-3)}
.card{border-left:2px solid var(--line); padding:2px 0 2px 16px; margin-bottom:20px; page-break-inside:avoid}
.meta{display:flex; flex-wrap:wrap; gap:4px 22px; margin-bottom:6px}
.kv{display:flex; gap:6px; font-size:12.5px; min-width:180px}
.kv .k, .line .k{color:var(--ink-3); flex:none; width:34px}
.kv .v{color:var(--ink-2)}
.line{display:flex; gap:6px; font-size:12.5px; margin-top:3px}
.line .v{color:var(--ink-2); flex:1}
.src{font-size:11.5px; color:var(--ink-3); margin-top:7px; word-break:break-all}
.src a{color:var(--ink-3); text-decoration:none; border-bottom:1px solid var(--line)}
.note{font-size:11.5px; color:var(--ink-3); margin:10px 0 0; line-height:1.7}
footer{margin-top:46px; padding-top:18px; border-top:1px solid var(--line); font-size:11.5px;
  color:var(--ink-3); line-height:1.8}

@media print{
  body{background:#fff; padding:0; font-size:11.5pt}
  .wrap{box-shadow:none; padding:0; max-width:none; border-radius:0}
  h1{font-size:19pt}
  h2{page-break-after:avoid; font-size:12pt}
  h3{page-break-after:avoid}
  .card, .bar-row, tr{page-break-inside:avoid}
  .src a{color:var(--ink-2)}
  @page{size:A4; margin:16mm 15mm}
}
`

export function buildReportHtml(brief: BenchBrief): string {
  const home = brief.items.filter((i) => i.isHome)
  const others = brief.items.filter((i) => !i.isHome)

  const bySchool = new Map<string, BenchBriefItem[]>()
  for (const item of others) {
    const key = item.school || '未填学校'
    if (!bySchool.has(key)) bySchool.set(key, [])
    bySchool.get(key)!.push(item)
  }
  const order = brief.compare.schools.filter((s) => !s.isHome).map((s) => s.school)
  const schools = [
    ...order.filter((s) => bySchool.has(s)),
    ...[...bySchool.keys()].filter((s) => !order.includes(s))
  ]

  const homeBlock = home.length
    ? `<section>
        <h2>本校基准 · ${esc(home[0].school || '本校')}</h2>
        <p class="note">这一节是我们自己的做法，用来和下面各校比，不是要照搬的对象。</p>
        ${home.map((it, i) => itemCard(it, i + 1)).join('')}
      </section>`
    : `<section><h2>本校基准</h2><p class="note">本校还没有入档的活动，所以这份报告只有外校情况，没有可对照的基准。</p></section>`

  const otherBlocks = schools
    .map(
      (school) => `<section class="school">
      <div class="school-head"><span class="nm">${esc(school)}</span><span class="ct">${bySchool.get(school)!.length} 条</span></div>
      ${bySchool.get(school)!.map((it, i) => itemCard(it, i + 1)).join('')}
    </section>`
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brief.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(brief.title)}</h1>
  <div class="sub">生成于 ${esc(brief.generatedAt)}　·　覆盖 ${brief.schoolCount} 所学校　·　${brief.sessionCount < brief.activityCount ? `${brief.activityCount} 条记录（合并成 ${brief.sessionCount} 场）` : `${brief.activityCount} 场活动`}</div>

  <h2>先说结论</h2>
  <ol class="findings">
    ${brief.compare.insights.map((s) => `<li>${esc(s)}</li>`).join('')}
  </ol>

  <h2>横向对比</h2>
  ${schoolTable(brief.compare)}
  ${bars('办的是些什么活动', brief.compare.kinds)}
  ${bars('宣传都用哪些手段', brief.compare.promos)}

  ${brief.compare.topics.length ? '<h2>同一件事，各校怎么办</h2>' : ''}
  ${topicTables(brief.compare)}

  <h2>逐校明细</h2>
  ${homeBlock}
  ${otherBlocks}

  <footer>
    字段说明：时间、地点、协办、时长、规模均取自公众号原文，原文没写就不列。
    周次为按开学日推算的近似值，各校校历不同，仅供参考。
    标「待核对」的条目抽取把握不足七成，据此做决定前请对照原文。
    <br>本报告由「知枢」跨校对标库生成，所有条目均可点击原文链接回溯。
  </footer>
</div>
</body>
</html>`
}
