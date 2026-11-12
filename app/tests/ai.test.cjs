'use strict'
// M6 AI 管线单元测试：纯函数（schema 宽松校验 + text 正文清洗），不触网、不触 DB
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
const assert = require('node:assert/strict')
const { normalizeAnalysis } = require('../.test-out/main/services/ai/schema.js')
const { prepareBody } = require('../.test-out/main/services/ai/text.js')
const { extractEmailEmphasis } = require('../.test-out/main/services/mail/sanitize.js')

let passed = 0
let failed = 0

function run(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
  }
}

// ---- normalizeAnalysis（schema.ts 宽松校验）----
run('合法输入：字段保留 + evidence 截断为 3 条', () => {
  const r = normalizeAnalysis({
    category: '需行动',
    summary: '  请在周五前提交材料  ',
    action_required: '提交材料',
    deadline_raw: '本周五',
    deadline_at: '2026-10-23T23:59:00+08:00',
    deadline_kind: 'deadline',
    event_start_at: null,
    applicable_to: '本人',
    confidence: 0.92,
    tier: 'review',
    evidence: ['e1', 'e2', 'e3', 'e4']
  })
  assert.equal(r.category, '需行动')
  assert.equal(r.summary, '请在周五前提交材料')
  assert.equal(r.deadlineKind, 'deadline')
  assert.equal(r.confidence, 0.92)
  assert.equal(r.tier, 'review')
  assert.deepEqual(JSON.parse(r.evidenceJson), ['e1', 'e2', 'e3'])
})

run('非法类别回退「不确定」；缺失字段回退 null/空串', () => {
  const r = normalizeAnalysis({ category: '乱写', summary: '', confidence: 'abc' })
  assert.equal(r.category, '不确定')
  assert.equal(r.summary, '')
  assert.equal(r.actionRequired, null)
  assert.equal(r.deadlineAt, null)
  assert.equal(r.confidence, null)
  assert.equal(r.evidenceJson, '[]')
})

run('confidence 越界钳制到 [0,1]', () => {
  assert.equal(normalizeAnalysis({ confidence: 7 }).confidence, 1)
  assert.equal(normalizeAnalysis({ confidence: -3 }).confidence, 0)
})

run('非对象 / 数组字段容错', () => {
  assert.equal(normalizeAnalysis(null).category, '不确定')
  const r = normalizeAnalysis({ evidence: 'not-an-array', deadline_at: 123 })
  assert.equal(r.evidenceJson, '[]')
  assert.equal(r.deadlineAt, null)
})

run('tier 半自动分级：archive/review 保留，非法或缺失回退 null', () => {
  assert.equal(normalizeAnalysis({ tier: 'archive' }).tier, 'archive')
  assert.equal(normalizeAnalysis({ tier: 'review' }).tier, 'review')
  assert.equal(normalizeAnalysis({ tier: 'hack' }).tier, null)
  assert.equal(normalizeAnalysis({ tier: 123 }).tier, null)
  assert.equal(normalizeAnalysis({}).tier, null)
})

run('AI 母标签只接受白名单，多选去重，子标签允许自定义但剔除危险文本', () => {
  const r = normalizeAnalysis({parent_labels:['competition','activities','competition','unexpected'],sub_labels:['自定义短词',' 第二短词 ','<script>','自定义短词']})
  assert.deepEqual(r.parentLabels,['competition','activities'])
  assert.deepEqual(r.subLabels,['自定义短词','第二短词'])
  assert.deepEqual(normalizeAnalysis({}).parentLabels,[])
})

run('关键词仅接受结构化短词，排除个人标识与缺少原文证据', () => {
  const r = normalizeAnalysis({keywords: [
    {keyword:'咖啡节',kind:'topic',evidence:'咖啡节报名',confidence:0.9},
    {keyword:'user@example.com',kind:'entity',evidence:'联系方式',confidence:0.9},
    {keyword:'活动报名',kind:'action',evidence:'',confidence:0.5}
  ]})
  assert.deepEqual(r.keywords.map(x=>x.keyword), ['咖啡节'])
})
run('视觉强调提取标题/粗体/色彩，忽略脚本和隐藏内容', () => {
  const marks = extractEmailEmphasis('<h2>咖啡节报名</h2><script>假指令</script><div style="color:red">报名反馈问卷</div><strong>心理健康课</strong>')
  assert.deepEqual(marks, ['咖啡节报名','报名反馈问卷','心理健康课'])
})

// ---- prepareBody（text.ts 正文清洗）----
run('剥离引用行与落款块', () => {
  const r = prepareBody('正文内容\n> 这是引文\nOn Tue, Oct 20 wrote:\n> 旧邮件\n结束', '')
  assert.ok(r.includes('正文内容'))
  assert.ok(!r.includes('这是引文'))
  assert.ok(!r.includes('wrote:'))
})

run('无纯文本时退回 HTML 转文本', () => {
  const r = prepareBody('', '<div>你好</div><br>世界')
  assert.ok(r.includes('你好'))
})

run('超长正文截断并加标记', () => {
  const r = prepareBody('a'.repeat(9000), '')
  assert.ok(r.length < 9000)
  assert.ok(r.includes('已截断'))
})

run('空输入安全返回空串', () => {
  assert.equal(prepareBody('', ''), '')
  assert.equal(prepareBody('   ', '  '), '')
})

console.log('M6 测试：通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed > 0) process.exit(1)
