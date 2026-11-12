'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { classifyTopics, MAIL_PARENT_LABELS } = require('../.test-out/shared/mailTags.js')

const valid = new Set(MAIL_PARENT_LABELS.map((item) => item.id))

test('八类主题分类覆盖常见校园邮件，且不会出现未分类', () => {
  const cases = [
    ['教务处关于2026-2027学年第一学期期末考试安排的通知', 'curriculum'],
    ['图书馆学术讲座：大模型前沿', 'academics'],
    ['2027届毕业生秋季校园招聘会及宣讲会', 'career'],
    ['关于启动2027年推荐免试研究生（保研）申请的通知', 'advancement'],
    ['第十九届挑战杯大学生课外学术科技作品竞赛', 'competition'],
    ['校学生会志愿者招募', 'activities'],
    ['国家奖学金评审及材料提交', 'student'],
    ['校园网系统维护与断网通知', 'operations'],
    ['Summer Internship Career Fair 2027', 'career'],
    ['Hackathon 2026 registration', ['competition', 'activities']]
  ]
  for (const [subject, expected] of cases) {
    const result = classifyTopics({ subject })
    assert.ok(result.parents.length >= 1, subject + ' 不应没有主题')
    assert.ok(result.parents.length <= 2, subject + ' 最多两个主题')
    assert.ok(
      result.parents.every((id) => valid.has(id)),
      subject + ' 主题必须来自八类'
    )
    const wanted = Array.isArray(expected) ? expected : [expected]
    for (const id of wanted) assert.ok(result.parents.includes(id), `${subject} 应包含 ${id}，实际 ${result.parents}`)
  }
})

test('正文和发件人可作为分类线索，避免列表只有主题时漏判', () => {
  const body = classifyTopics({
    subject: '通知',
    body: '请参加本周五在大学生活动中心举办的校园招聘宣讲会，带上简历。',
    from: 'noreply@school.edu.cn'
  })
  assert.ok(body.parents.includes('career'), body.parents)

  const sender = classifyTopics({ subject: '会议通知', body: '请于周四下午参会。', from: 'hr@example.com' })
  assert.ok(sender.parents.includes('career'), sender.parents)
  assert.ok(sender.subs.includes('招聘'), sender.subs)

  const generic = classifyTopics({ subject: '关于10月17日工作的通知', body: '请按时办理。', from: 'noreply@school.edu.cn' })
  assert.deepEqual(generic.parents, ['student'])
  assert.ok(generic.fallback)

  const dual = classifyTopics({ subject: '社团活动安全培训', body: '请参加校园安全培训。' })
  assert.deepEqual(dual.parents, ['activities'])
  assert.ok(!dual.subs.includes('校园安全'), '子标签只应来自最终主题')
})

test('中英混合的双主题邮件保留两个标签', () => {
  const result = classifyTopics({ subject: '黑客松竞赛与校园活动志愿者招募', body: 'Hackathon volunteer recruitment' })
  assert.ok(result.parents.includes('competition'))
  assert.ok(result.parents.includes('activities'))
  assert.ok(result.subs.length >= 2)
})
