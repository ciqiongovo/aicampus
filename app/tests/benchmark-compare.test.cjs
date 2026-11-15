'use strict'
// 横向对比的算法测试：数字解析、类型归一、样本门槛、结论生成
// 先编译：npm run test:db 会一并编译（tsc -p tsconfig.test.json）
// 再运行：node tests/benchmark-compare.test.cjs
const assert = require('node:assert/strict')

const { parseScale, bucketKind, bucketPromo, bucketVenue, bucketJoin, leadDays, buildCompare } = require(
  '../.test-out/main/services/benchmark/compare.js'
)
const { composeBrief } = require('../.test-out/main/services/benchmark/brief.js')
const { buildReportHtml } = require('../.test-out/main/services/benchmark/report.js')

let passed = 0
let failed = 0

function run(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

/** 造一条简报条目，只填测试关心的字段 */
function item(patch) {
  return {
    id: patch.id ?? 0,
    school: patch.school ?? '',
    sourceName: patch.sourceName ?? '',
    title: patch.title ?? '活动',
    url: patch.url ?? 'https://mp.weixin.qq.com/s/x',
    publishedAt: patch.publishedAt ?? null,
    kind: patch.kind ?? '',
    weekNo: patch.weekNo ?? null,
    startAt: patch.startAt ?? null,
    location: patch.location ?? '',
    orgForm: patch.orgForm ?? '',
    audience: patch.audience ?? '',
    joinMethod: patch.joinMethod ?? '',
    coOrganizer: patch.coOrganizer ?? '',
    duration: patch.duration ?? '',
    scale: patch.scale ?? '',
    agenda: patch.agenda ?? [],
    highlights: patch.highlights ?? [],
    promoChannels: patch.promoChannels ?? [],
    migrationFit: patch.migrationFit ?? '',
    migrationNote: patch.migrationNote ?? '',
    isHome: patch.isHome ?? false,
    confidence: patch.confidence ?? 0.8
  }
}

console.log('\n== 规模解析 ==')

run('「预计 300 人参加」取 300', () => {
  assert.equal(parseScale('预计 300 人参加'), 300)
})

run('「观众约 200-300 人」取区间中点 250', () => {
  assert.equal(parseScale('观众约 200-300 人'), 250)
})

run('全角破折号同样认', () => {
  assert.equal(parseScale('200—300人'), 250)
})

run('「300 余人」取 300', () => {
  assert.equal(parseScale('现场 300 余人'), 300)
})

run('没有量词的数字不认（可能是经费、是期数）', () => {
  assert.equal(parseScale('第 300 期'), null)
  assert.equal(parseScale('预算 5000'), null)
})

run('空值与纯文字返回 null，不编一个数字', () => {
  assert.equal(parseScale(''), null)
  assert.equal(parseScale('规模较大'), null)
})

console.log('\n== 类型归一 ==')

run('同一件事的不同写法归到同一类', () => {
  assert.equal(bucketKind('迎新晚会'), bucketKind('2025 级新生迎新文艺晚会'))
})

run('长词优先：「社团招新嘉年华」归招新而不是嘉年华', () => {
  assert.equal(bucketKind('社团招新嘉年华'), '招新与招募')
})

run('认不出来的进「其他」，空值单列', () => {
  assert.equal(bucketKind('神秘事件'), '其他')
  assert.equal(bucketKind(''), '未标注类型')
})

run('宣传手段归一', () => {
  assert.equal(bucketPromo('朋友圈海报'), '海报')
  assert.equal(bucketPromo('倒计时预热推文'), '预热推文')
  assert.equal(bucketPromo(''), null)
})

console.log('\n== 预热天数 ==')

run('发布到活动隔 3 天', () => {
  assert.equal(leadDays(item({ publishedAt: '2025-09-20 10:00', startAt: '2025-09-23 19:00' })), 3)
})

run('活动早于发布视为脏数据，不参与统计', () => {
  assert.equal(leadDays(item({ publishedAt: '2025-09-25 10:00', startAt: '2025-09-23 19:00' })), null)
})

run('超过 120 天的常年栏目页不算预告', () => {
  assert.equal(leadDays(item({ publishedAt: '2025-01-01 10:00', startAt: '2025-09-01 19:00' })), null)
})

run('缺任一端返回 null', () => {
  assert.equal(leadDays(item({ publishedAt: '2025-09-20 10:00' })), null)
})

console.log('\n== 对比聚合 ==')

const items = [
  // 本校 3 场，人数与协办各写了 2 场
  item({
    id: 1,
    school: '上海科技大学',
    isHome: true,
    kind: '迎新晚会',
    scale: '预计 300 人',
    coOrganizer: '校团委',
    promoChannels: ['预热推文', '海报'],
    publishedAt: '2025-09-01 10:00',
    startAt: '2025-09-05 19:00'
  }),
  item({
    id: 2,
    school: '上海科技大学',
    isHome: true,
    kind: '社团招新',
    scale: '500 人',
    promoChannels: ['预热推文'],
    publishedAt: '2025-09-10 10:00',
    startAt: '2025-09-12 19:00'
  }),
  item({
    id: 3,
    school: '上海科技大学',
    isHome: true,
    kind: '讲座',
    publishedAt: '2025-09-15 10:00',
    startAt: '2025-09-20 19:00'
  }),
  // 复旦 2 场，人数都没写
  item({
    id: 4,
    school: '复旦大学',
    kind: '迎新晚会',
    coOrganizer: '学生会',
    promoChannels: ['预热推文', '抽奖'],
    publishedAt: '2025-09-01 10:00',
    startAt: '2025-09-12 19:00'
  }),
  item({
    id: 5,
    school: '复旦大学',
    kind: '迎新晚会',
    coOrganizer: '社团联',
    publishedAt: '2025-09-02 10:00',
    startAt: '2025-09-14 19:00'
  }),
  // 同济只有 1 场，应该进 thin，不进对比表
  item({ id: 6, school: '同济大学', kind: '比赛', scale: '80 人' })
]

const cmp = buildCompare(items)

run('本校排第一，样本不足的排最后', () => {
  assert.equal(cmp.schools[0].school, '上海科技大学')
  assert.equal(cmp.schools[0].isHome, true)
  assert.equal(cmp.schools[cmp.schools.length - 1].school, '同济大学')
  assert.equal(cmp.schools[cmp.schools.length - 1].thin, true)
})

run('中位数只按写了人数的条目算，覆盖率单独给', () => {
  const home = cmp.schools[0]
  assert.equal(home.activities, 3)
  // 300 与 500 的中位数是 400；只算写了的 2 场
  assert.equal(home.medianScale, 400)
  assert.ok(Math.abs(home.scaleCoverage - 2 / 3) < 1e-6)
})

run('一场都没写人数时中位数为 null，而不是 0', () => {
  const fudan = cmp.schools.find((s) => s.school === '复旦大学')
  assert.equal(fudan.medianScale, null)
  assert.equal(fudan.scaleCoverage, 0)
})

run('协办占比按条数算', () => {
  const fudan = cmp.schools.find((s) => s.school === '复旦大学')
  assert.equal(fudan.coHostRate, 1)
})

run('提前预告取中位数', () => {
  const fudan = cmp.schools.find((s) => s.school === '复旦大学')
  // 11 天与 12 天 → 中位 12（向下取偶）
  assert.equal(fudan.medianLeadDays, 12)
})

run('类型与宣传手段都出了分布', () => {
  const kindLabels = cmp.kinds.map((k) => k.label)
  assert.ok(kindLabels.includes('迎新与毕业'))
  assert.ok(cmp.promos.length > 0)
})

run('结论里必须带数字，且提到样本不足', () => {
  const text = cmp.insights.join('\n')
  assert.ok(cmp.insights.length >= 2)
  assert.ok(/同济大学/.test(text), '应该提到只有 1 场的那所学校')
})

console.log('\n== 本校 vs 外校 ==')

// 本校 3 场（都在第 12 周、提前 10 天），外校三所各 2 场（第 4–6 周、提前 0–4 天）
const homeItems = [1, 2, 3].map((n) =>
  item({
    school: '上海科技大学',
    isHome: true,
    kind: '迎新晚会',
    publishedAt: `2025-09-0${n} 10:00`,
    startAt: `2025-09-1${n} 19:00`,
    weekNo: 12
  })
)
const otherItems = [
  ['复旦大学', 4, 4],
  ['上海大学', 3, 5],
  ['同济大学', 2, 6]
].flatMap(([school, lead, week]) =>
  [0, 1].map(() =>
    item({
      school,
      kind: '迎新晚会',
      publishedAt: '2025-09-01 10:00',
      startAt: `2025-09-${String(1 + lead).padStart(2, '0')} 19:00`,
      weekNo: week
    })
  )
)
const withHome = buildCompare([...homeItems, ...otherItems])

run('有本校、外校也够两所时，结论直接给差值', () => {
  const leadLine = withHome.insights.find((s) => s.startsWith('节奏：'))
  assert.ok(leadLine, '应该有节奏那一句')
  assert.ok(/本校中位提前/.test(leadLine), leadLine)
  assert.ok(/外校/.test(leadLine), leadLine)
  assert.ok(/我们早了/.test(leadLine), `本校 10 天、外校 2–4 天，应判为更早：${leadLine}`)
})

run('学期位置差两週以上才说，且说成安排问题而不是执行问题', () => {
  const weekLine = withHome.insights.find((s) => s.startsWith('周次：'))
  assert.ok(weekLine, '第 12 周对外校第 5 周，应该出这一句')
  assert.ok(/第 12 周/.test(weekLine) && /第 5 周/.test(weekLine), weekLine)
})

run('外校不足两所时不给「外校平均」，退回描述性结论', () => {
  const onlyOne = buildCompare([
    ...homeItems,
    ...otherItems.filter((i) => i.school === '复旦大学')
  ])
  const leadLine = onlyOne.insights.find((s) => s.startsWith('节奏：'))
  // 一所学校组成的「外校平均」不是平均，这句话就不该出现
  assert.ok(!leadLine || !/外校中位/.test(leadLine), String(leadLine))
})

console.log('\n== 篇数与场次 ==')

// 上海大学 2025 级开学典礼发了三条：预告、举行、回顾。按篇数是 3，按场次是 1。
const dup = buildCompare([
  item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-19', title: '敬请期待！开学典礼预告来啦' }),
  item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-19', title: '开学典礼举行' }),
  item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-19', title: '开学典礼回顾' }),
  item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-19 18:30:00', title: '同一场，带具体时刻' }),
  item({ school: '上海大学', kind: '迎新晚会', startAt: '2024-09-20', title: '上一年的迎新晚会' })
])

run('同一场活动的多篇推文合并成一场', () => {
  const s = dup.schools.find((x) => x.school === '上海大学')
  assert.equal(s.activities, 5)
  assert.equal(s.sessions, 2, '2025 四条合并成一场，2024 一条，共两场')
})

run('没写日期的各算一场，不硬合并', () => {
  const c = buildCompare([
    item({ school: '复旦大学', kind: '体育赛事', startAt: null, title: '新生杯篮球赛' }),
    item({ school: '复旦大学', kind: '体育赛事', startAt: null, title: '「枫云决」羽毛球赛' })
  ])
  const s = c.schools.find((x) => x.school === '复旦大学')
  assert.equal(s.sessions, 2, '两场都没写日期，只能各算一场')
})

run('篇数与场次不一致时，结论里要说出来', () => {
  const line = dup.insights.find((x) => x.startsWith('篇数与场次'))
  assert.ok(line, '缺少篇数/场次说明')
  assert.ok(/上海大学 5 篇 \/ 2 场/.test(line), line)
})

run('篇数等于场次时不提这一句', () => {
  const c = buildCompare([
    item({ school: '同济大学', kind: '迎新晚会', startAt: '2025-09-01' }),
    item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-02' })
  ])
  assert.ok(!c.insights.some((x) => x.startsWith('篇数与场次')))
})

console.log('\n== 样本构成 ==')

run('某类占八成时，结论要说明这是采集方向不是各校偏好', () => {
  const many = []
  for (let i = 0; i < 8; i++) {
    many.push(item({ school: '复旦大学', kind: '迎新晚会', startAt: `2025-09-0${i + 1}` }))
  }
  many.push(item({ school: '复旦大学', kind: '体育赛事', startAt: '2025-10-01' }))
  many.push(item({ school: '同济大学', kind: '体育赛事', startAt: '2025-10-02' }))
  const c = buildCompare(many)
  const line = c.insights.find((x) => x.startsWith('样本构成'))
  assert.ok(line, '缺少样本构成说明')
  assert.ok(/80%/.test(line), line)
})

run('类型分散时不说样本构成', () => {
  const c = buildCompare([
    item({ school: '复旦大学', kind: '迎新晚会', startAt: '2025-09-01' }),
    item({ school: '复旦大学', kind: '体育赛事', startAt: '2025-09-02' }),
    item({ school: '同济大学', kind: '讲座与沙龙', startAt: '2025-09-03' })
  ])
  assert.ok(!c.insights.some((x) => x.startsWith('样本构成')))
})

run('写了人数的场次按全部条目数，不只看进对比表的学校', () => {
  // 上海政法学院只有 1 场，不进对比表；但它那一场写了人数，不能算成 0
  const c = buildCompare([
    item({ school: '复旦大学', kind: '迎新晚会', startAt: '2025-09-01' }),
    item({ school: '复旦大学', kind: '讲座', startAt: '2025-09-02' }),
    item({ school: '同济大学', kind: '迎新晚会', startAt: '2025-09-03' }),
    item({ school: '同济大学', kind: '讲座', startAt: '2025-09-04' }),
    item({ school: '上海政法学院', kind: '迎新晚会', startAt: '2025-09-05', scale: '500 人' })
  ])
  const line = c.insights.find((x) => x.startsWith('规模：'))
  assert.ok(line, '应该有一条规模结论')
  assert.match(line, /5 场活动里只有 1 场/, line)
})

console.log('\n== 同类活动（同一件事，各校怎么办） ==')

// 三所学校各一场迎新晚会；复旦那场发了预告和回顾两篇，只能算一场
const topicItems = [
  item({
    id: 101,
    school: '上海科技大学',
    isHome: true,
    kind: '2025 级迎新晚会',
    startAt: '2025-09-05 19:00',
    weekNo: 2,
    location: '报告厅',
    joinMethod: '线上抢票',
    publishedAt: '2025-08-28 10:00',
    coOrganizer: '校团委',
    highlights: ['无人机表演']
  }),
  item({
    id: 102,
    school: '复旦大学',
    kind: '迎新晚会',
    startAt: '2025-09-12 19:00',
    weekNo: 3,
    location: '东区体育馆',
    joinMethod: '扫码加入咨询群',
    publishedAt: '2025-09-01 10:00'
  }),
  // 同一场活动的回顾稿：日期相同、信息更少，不该单独占一行
  item({
    id: 103,
    school: '复旦大学',
    kind: '迎新晚会回顾',
    startAt: '2025-09-12 19:00',
    location: '东区体育馆',
    publishedAt: '2025-09-13 09:00'
  }),
  item({
    id: 104,
    school: '上海大学',
    kind: '迎新文艺晚会',
    startAt: '2025-09-12 18:30',
    weekNo: 3,
    location: '学生活动中心多功能厅',
    joinMethod: '到梦空间报名',
    publishedAt: '2025-09-09 10:00'
  }),
  // 同一所学校的两场球赛：只有一所，不构成对照
  item({ id: 105, school: '同济大学', kind: '篮球赛', startAt: '2025-10-01 15:00' }),
  item({ id: 106, school: '同济大学', kind: '足球赛', startAt: '2025-10-08 15:00' })
]

const topicCmp = buildCompare(topicItems)
const topic = topicCmp.topics.find((x) => x.kind === '迎新与毕业')

run('类型先归一，再按类型聚合', () => {
  assert.ok(topic, '「2025 级迎新晚会」应该归到迎新与毕业')
  assert.equal(topic.schools, 3)
})

run('同校同日多篇推文合成一场', () => {
  // 复旦发了预告和回顾两篇，日期都是 9-12
  assert.equal(topic.rows.length, 3)
  const fudan = topic.rows.filter((r) => r.school === '复旦大学')
  assert.equal(fudan.length, 1)
  // 留下的是信息更全的那条（有参与方式），不是后发的回顾
  assert.equal(fudan[0].joinMethod, '扫码加入咨询群')
})

run('本校排第一行', () => {
  assert.equal(topic.rows[0].school, '上海科技大学')
  assert.equal(topic.rows[0].isHome, true)
})

run('只有一所学校的类型不进对照', () => {
  assert.ok(!topicCmp.topics.some((t) => t.kind === '体育与健身'))
})

run('场地与参与方式都归一成类别', () => {
  const venues = topic.venues.map((v) => v.label)
  assert.ok(venues.includes('礼堂与剧场'), venues.join(','))
  assert.ok(venues.includes('体育场馆'))
  assert.ok(venues.includes('活动中心'))
  const joins = topic.joins.map((v) => v.label)
  assert.ok(joins.includes('抢票'), joins.join(','))
  assert.ok(joins.includes('报名'))
  assert.ok(joins.includes('扫码进群'), joins.join(','))
})

run('小结句写得出数字，且每句都能倒推', () => {
  assert.match(topic.note, /3 所学校共 3 场/)
  assert.match(topic.note, /第 3 周/)
  // 8 / 11 / 3 天的中位数是 8
  assert.match(topic.note, /提前 8 天/)
})

run('合办占比按行算', () => {
  // 只有上科大写了协办单位
  assert.ok(Math.abs(topic.coHostRate - 1 / 3) < 1e-6)
})

run('结论里出现同类活动那一条', () => {
  assert.ok(topicCmp.insights.some((x) => x.startsWith('同一件事：')), topicCmp.insights.join('\n'))
})

console.log('\n== 简报与报告 ==')

const brief = composeBrief(items, '示例', new Date('2025-10-01T10:00:00'))

run('简报正文里，结论排在逐条明细之前', () => {
  assert.ok(brief.markdown.indexOf('先说结论') > -1)
  assert.ok(brief.markdown.indexOf('先说结论') < brief.markdown.indexOf('本校基准'))
})

run('简报不再重复两张概览表', () => {
  assert.equal(brief.markdown.match(/各校一览/g).length, 1)
})

run('简报与报告里都有「同一件事，各校怎么办」', () => {
  assert.ok(brief.markdown.includes('同一件事，各校怎么办'), brief.markdown)
  const html = buildReportHtml(brief)
  assert.ok(html.includes('同一件事，各校怎么办'))
})

run('简报里的表格不会被竖线撕开', () => {
  const tricky = composeBrief(
    [
      item({ school: '复旦大学', kind: '迎新晚会', startAt: '2025-09-12', location: '礼堂|主厅', highlights: ['A|B'] }),
      item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-13' })
    ],
    '示例',
    new Date('2025-10-01T10:00:00')
  )
  const rows = tricky.markdown.split('\n').filter((l) => l.startsWith('|'))
  assert.ok(rows.length >= 3, '应该出了同类活动那张表')
  // 表里每行的竖线数必须一致：少一个就说明单元格里的竖线把表撕开了
  const counts = new Set(rows.map((line) => (line.match(/\|/g) || []).length))
  assert.equal(counts.size, 1, [...counts].join(','))
  assert.ok([...counts][0] >= 3, '至少要有学校和时间两列')
})

run('列随数据走：整列都没有数据的那一项不出现', () => {
  const noVenue = composeBrief(
    [
      item({ school: '复旦大学', kind: '迎新晚会', startAt: '2025-09-12' }),
      item({ school: '上海大学', kind: '迎新晚会', startAt: '2025-09-13' })
    ],
    '示例',
    new Date('2025-10-01T10:00:00')
  )
  assert.ok(noVenue.markdown.includes('同一件事，各校怎么办'))
  assert.ok(!noVenue.markdown.includes('| 场地 |'), '没人写场地时不该摆这一列')
  assert.ok(!noVenue.markdown.includes('| 特色 |'))
})

run('HTML 报告自包含：不引外部资源，转义用户内容', () => {
  const html = buildReportHtml({ ...brief, title: '<script>alert(1)</script>' })
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(!/src=|@import|<link/i.test(html), '不应该有外链资源')
  assert.ok(html.includes('&lt;script&gt;'), '标题里的尖括号必须转义')
})

run('HTML 里能看到结论、明细和原文链接', () => {
  const html = buildReportHtml(brief)
  assert.ok(html.includes('先说结论'))
  assert.ok(html.includes('上海科技大学'))
  assert.ok(html.includes('https://mp.weixin.qq.com/s/x'))
})

run('空库也能出一份能看的报告', () => {
  const empty = composeBrief([], '空', new Date('2025-10-01T10:00:00'))
  const html = buildReportHtml(empty)
  assert.ok(html.includes('库里没有符合条件的活动'))
  assert.ok(html.includes('<footer>'))
})

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
