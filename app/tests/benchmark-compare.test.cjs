'use strict'
// 横向对比的算法测试：数字解析、类型归一、样本门槛、结论生成
// 先编译：npm run test:db 会一并编译（tsc -p tsconfig.test.json）
// 再运行：node tests/benchmark-compare.test.cjs
const assert = require('node:assert/strict')

const { parseScale, bucketKind, bucketPromo, leadDays, buildCompare } = require(
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

console.log('\n== 简报与报告 ==')

const brief = composeBrief(items, '示例', new Date('2025-10-01T10:00:00'))

run('简报正文里，结论排在逐条明细之前', () => {
  assert.ok(brief.markdown.indexOf('先说结论') > -1)
  assert.ok(brief.markdown.indexOf('先说结论') < brief.markdown.indexOf('本校基准'))
})

run('简报不再重复两张概览表', () => {
  assert.equal(brief.markdown.match(/各校一览/g).length, 1)
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
