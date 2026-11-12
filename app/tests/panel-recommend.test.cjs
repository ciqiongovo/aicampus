'use strict'
// 面板推荐/反馈闭环测试：批次、候选、处置落库、反馈学习、继续阅读、来源接入
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node tests/panel-recommend.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { openDatabase } = require('../.test-out/main/db/database.js')
const accountsDao = require('../.test-out/main/db/dao/accountsDao.js')
const emailsDao = require('../.test-out/main/db/dao/emailsDao.js')
const analysisDao = require('../.test-out/main/db/dao/emailAnalysisDao.js')
const itemsDao = require('../.test-out/main/db/dao/itemsDao.js')
const remindersDao = require('../.test-out/main/db/dao/remindersDao.js')
const infoDao = require('../.test-out/main/db/dao/infoDao.js')
const panelDao = require('../.test-out/main/db/dao/panelDao.js')
const panel = require('../.test-out/main/services/panel/service.js')
const learning = require('../.test-out/main/services/panel/learning.js')
const keywords = require('../.test-out/main/services/panel/keywordProfile.js')
const materials = require('../.test-out/main/services/materials/service.js')
const mailTags = require('../.test-out/main/services/mailTags.js')
const settingsDao = require('../.test-out/main/db/dao/settingsDao.js')
const { DEFAULT_SETTINGS } = require('../.test-out/shared/types.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'panel-testdb')
const DB_FILE = join(TMP_DIR, 'panel-test.db')

let passed = 0
let failed = 0
async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error && error.message ? error.message : error}`)
  }
}

const settings = { ...DEFAULT_SETTINGS, aiBaseURL: '', aiModel: '', aiApiKey: '', aiAuthorizedFor: '' }
const store = { peek: () => settings }

let uidSeq = 0
function seedEmail(db, accId, over = {}) {
  uidSeq += 1
  return emailsDao.upsertEmail(db, {
    account_id: accId,
    folder: 'INBOX',
    uid: uidSeq,
    message_id: `<panel-${uidSeq}@test>`,
    subject: '测试主题',
    from_addr: 'sender@example.com',
    to_addr: 'me@example.com',
    cc: '',
    date_utc: '2026-10-20T02:00:00.000Z',
    date_raw: null,
    unread: 0,
    body_text: '这是正文内容。',
    body_html: '',
    attachments_json: '[]',
    size: 0,
    ...over
  })
}

function seedAnalysis(db, emailId, over = {}) {
  analysisDao.upsertAnalysis(db, {
    email_id: emailId,
    status: 'analyzed',
    category: '需行动',
    summary: 'AI 摘要：需要你确认',
    action_required: null,
    deadline_raw: null,
    deadline_at: null,
    deadline_kind: null,
    event_start_at: null,
    applicable_to: null,
    confidence: 0.9,
    tier: null,
    evidence_json: '[]',
    model: 'test-model',
    provider: 'test',
    error: null,
    analyzed_at: '2026-10-20T02:01:00.000Z',
    ...over
  })
}

function seedInfo(db, emailId, over = {}) {
  return infoDao.createInfo(db, {
    source_type: 'email',
    source_email_id: emailId,
    title: '待读邮件',
    content: '正文内容',
    category: '需行动',
    destination: 'unverified',
    ...over
  })
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  const db = openDatabase(DB_FILE)
  const accId = accountsDao.insertAccount(db, {
    provider: 'qq',
    label: 'QQ 邮箱',
    address: 'a@qq.com',
    host: 'imap.qq.com',
    port: 993,
    encryption: 'ssl',
    username: 'a@qq.com',
    secret_enc: 'enc://xxx',
    folder: 'INBOX',
    auth_mode: 'appPassword',
    last_uidvalidity: null,
    last_uid: null,
    last_sync_at: null,
    sync_error: null
  })

  const e1 = seedEmail(db, accId, { subject: '学术讲座：周五前提交材料', from_addr: 'teacher@school.edu.cn' })
  seedAnalysis(db, e1, { action_required: '周五前提交材料', deadline_at: '2026-10-23T09:00:00.000Z' })
  const i1 = seedInfo(db, e1, { title: '学术讲座：周五前提交材料', category: '需行动' })

  const e2 = seedEmail(db, accId, { subject: '讲座报名', from_addr: 'notice@school.edu.cn' })
  seedAnalysis(db, e2, { action_required: null, category: '可选机会' })
  const i2 = seedInfo(db, e2, { title: '讲座报名', category: '可选机会' })

  const e3 = seedEmail(db, accId, { subject: '会议邀请', from_addr: 'boss@company.com' })
  seedAnalysis(db, e3, {
    action_required: null,
    category: '重要通知',
    event_start_at: '2026-10-25T02:00:00.000Z'
  })
  const i3 = seedInfo(db, e3, { title: '会议邀请', category: '重要通知' })

  const e4 = seedEmail(db, accId, { subject: '学术讲座资料归档', from_addr: 'library@school.edu.cn' })
  seedAnalysis(db, e4, { action_required: null, category: '资料' })
  const i4 = seedInfo(db, e4, { title: '学术讲座资料归档', category: '资料' })
  const coffee = [{keyword: '咖啡节', kind: 'topic', evidence: '咖啡节报名', confidence: 0.9}]
  keywords.recordEmailKeywords(db, e1, coffee, '学术讲座：咖啡节报名材料')
  keywords.recordEmailKeywords(db, e2, coffee, '讲座报名：咖啡节报名')
  keywords.recordEmailKeywords(db, e3, coffee, '没有该关键词的其他邮件')

  console.log('== 首批推荐 ==')
  let first
  await run('无历史批次时自动生成首批，动作目录来自内容而非写死', async () => {
    first = await panel.panelOverview(db, store)
    assert.ok(first.batchId, '应有批次')
    assert.equal(first.mode, 'initial')
    assert.equal(first.recommendations.length, 4)
    assert.equal(first.remaining, 0, '已进入本批的条目不应再算待读池')
    assert.equal(first.aiConfigured, false)
    assert.ok(first.aiMessage.includes('未配置'), first.aiMessage)
    assert.ok(first.sources.some((s) => s.key === 'email'))
    assert.equal(first.sources.find((s) => s.key === 'email').pending, 4, '来源徽标统计本批待处理')
    const byInfo = new Map(first.recommendations.map((r) => [r.infoId, r]))
    assert.equal(byInfo.get(i1).recommendedAction, 'todo')
    assert.equal(byInfo.get(i3).recommendedAction, 'schedule')
    assert.equal(byInfo.get(i4).recommendedAction, 'material')
    assert.ok(first.recommendations.every((r) => r.reason.length > 6))
  })

  await run('重复打开不重复生成批次，候选进入待读池但不再重复推荐', async () => {
    const again = await panel.panelOverview(db, store)
    assert.equal(again.batchId, first.batchId)
    assert.equal(again.recommendations.length, 4)
    assert.equal(panelDao.countPanelCandidates(db), 0)
  })

  await run('来源标签只筛选当前批次，不会另开批次遮挡其他来源', async () => {
    const email = await panel.panelOverview(db, store, 'email')
    assert.equal(email.batchId, first.batchId)
    assert.equal(email.recommendations.length, 4)
    const again = await panel.panelContinue(db, store, 'email')
    assert.equal(again.batchId, first.batchId)
  })

  const todoRec = first.recommendations.find((r) => r.infoId === i1)
  const archiveRec = first.recommendations.find((r) => r.infoId === i2)
  const scheduleRec = first.recommendations.find((r) => r.infoId === i3)
  const materialRec = first.recommendations.find((r) => r.infoId === i4)

  console.log('== 采纳与改选 ==')
  await run('采纳“放入待办”建事项、回填截止、信息流转 item、记录 accepted 与主题正权重', async () => {
    const result = panel.panelAct(db, store, todoRec.id, 'todo')
    assert.ok(result.ok, result.message)
    assert.ok(result.itemId)
    const item = itemsDao.getItem(db, result.itemId)
    assert.equal(item.title, '周五前提交材料')
    assert.equal(item.deadline_at, '2026-10-23T09:00:00.000Z')
    assert.equal(item.source_email_id, e1)
    assert.equal(infoDao.getInfoByEmail(db, e1).destination, 'item')
    const rec = panelDao.getRecommendationDetail(db, todoRec.id)
    assert.equal(rec.status, 'accepted')
    assert.equal(rec.chosen_action, 'todo')
    const feedback = db.prepare('SELECT * FROM feedback_event WHERE recommendation_id = ?').get(todoRec.id)
    assert.equal(feedback.outcome, 'accepted')
    const topic = panelDao.getPreferenceSignal(db, 'topic', 'academics')
    assert.ok(topic.weight > 0, '学术主题应产生正权重')
    const source = panelDao.getPreferenceSignal(db, 'source', 'email')
    assert.ok(source.weight > 0, '来源也应产生正权重')
    assert.equal(panelDao.getPreferenceSignal(db, 'action', 'todo'), undefined, '不再记录动作偏好')
    assert.equal(panelDao.getPreferenceSignal(db, 'sender', 'school.edu.cn'), undefined, '不再记录发件人偏好')
    assert.ok(keywords.listKeywordProfile(db).find(row => row.keyword === '咖啡节').weight > 0, '邮件关键词正向反馈更新画像')
    keywords.applyKeywordFeedback(db, e1, todoRec.id, 'todo')
    assert.equal(keywords.listKeywordProfile(db).find(row => row.keyword === '咖啡节').evidenceCount, 1, '同一推荐不能重复计权')
    assert.equal(keywords.keywordBoosts(db, [e1, e3]).has(e3), false, '无原文证据的邮件不匹配')
  })

  await run('改选“放入待办”记为 corrected，只修正主题与来源，不写动作权重', async () => {
    const result = panel.panelAct(db, store, archiveRec.id, 'todo')
    assert.ok(result.ok, result.message)
    assert.ok(result.itemId)
    assert.equal(itemsDao.getItem(db, result.itemId).title, '讲座报名')
    assert.equal(infoDao.getInfoByEmail(db, e2).destination, 'item')
    const rec = panelDao.getRecommendationDetail(db, archiveRec.id)
    assert.equal(rec.status, 'corrected')
    assert.equal(rec.chosen_action, 'todo')
    assert.equal(panelDao.getPreferenceSignal(db, 'action', 'material'), undefined, '被改掉的推荐动作不再产生负权重')
    assert.equal(panelDao.getPreferenceSignal(db, 'action', 'todo'), undefined, '改选动作也不记录')
    const topic = panelDao.getPreferenceSignal(db, 'topic', 'academics')
    assert.ok(topic.weight > 0, '主题仍按内容归因')
    const profile = keywords.listKeywordProfile(db).find(row => row.keyword === '咖啡节')
    assert.equal(profile.evidenceCount, 2, '两封不同邮件的正向反馈各贡献一次')
    assert.equal(profile.repeatCount, 1, '短期反复正向出现延长半衰期')
    assert.equal(profile.halfLifeDays, 31.5)
    assert.equal(keywords.keywordBoosts(db, [e1, e2, e3]).has(e3), false, '关键词只影响实际匹配的邮件')
    const old = keywords.listKeywordProfile(db, new Date(Date.now() + 100 * 86_400_000)).find(row => row.keyword === '咖啡节')
    assert.ok(!old || old.weight < profile.weight, '久未反馈会自然衰减')
  })

  await run('采纳“存为资料”默认进入未分组，不创建事项', async () => {
    const result = panel.panelAct(db, store, materialRec.id, 'material')
    assert.ok(result.ok, result.message)
    assert.equal(result.itemId, undefined)
    assert.equal(infoDao.getInfoByEmail(db, e4).destination, 'keep')
    assert.equal(panelDao.getRecommendationDetail(db, materialRec.id).status, 'accepted')
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM items WHERE source_email_id = ?').get(e4).c, 0)
    const list = materials.listMaterials(db)
    const item = list.items.find((m) => m.title === '学术讲座资料归档')
    assert.ok(item, '存为资料后应能在资料栏回查')
    assert.equal(item.folder, 'uncategorized')
    assert.ok(item.parentTags.some((tag) => tag.id === 'academics'))
    assert.equal(list.folders.find((f) => f.key === 'uncategorized').count, 1)
  })

  await run('设为日程写入 event_start/event_end，并记录反馈', async () => {
    const result = panel.panelAct(db, store, scheduleRec.id, 'schedule')
    assert.ok(result.ok, result.message)
    const item = itemsDao.getItem(db, result.itemId)
    assert.equal(item.event_start_at, '2026-10-25T02:00:00.000Z')
    assert.ok(item.event_end_at)
    assert.equal(item.deadline_at, null)
    assert.equal(infoDao.getInfoByEmail(db, e3).destination, 'item')
    assert.equal(panelDao.getRecommendationDetail(db, scheduleRec.id).status, 'accepted')
  })

  await run('重复处置同一推荐被拒绝，不会二次建事项', async () => {
    const again = panel.panelAct(db, store, todoRec.id, 'todo')
    assert.equal(again.ok, false)
    assert.ok(again.message.includes('已经处理'), again.message)
    const count = db.prepare('SELECT COUNT(*) AS c FROM items WHERE source_email_id = ?').get(e1).c
    assert.equal(count, 1)
  })

  await run('推荐不存在时友好失败', () => {
    const r = panel.panelAct(db, store, 999999, 'ignore')
    assert.equal(r.ok, false)
    assert.ok(r.message.includes('不存在'), r.message)
  })

  console.log('== 继续阅读 ==')
  await run('新邮件到达后自动推荐，不用先点击继续阅读', async () => {
    const done = await panel.panelOverview(db, store)
    assert.equal(done.recommendations.length, 0)
    assert.equal(done.mode, 'initial')
    const e4 = seedEmail(db, accId, { subject: '新的通知', from_addr: 'new@example.com' })
    seedAnalysis(db, e4, { action_required: null, category: '资料' })
    seedInfo(db, e4, { title: '新的通知', category: '资料' })
    const paused = await panel.panelOverview(db, store)
    assert.equal(paused.recommendations.length, 1)
    assert.equal(paused.recommendations[0].title, '新的通知')
    assert.equal(paused.remaining, 0)
  })

  await run('新邮件已自动纳入时，继续阅读不产生空批次', async () => {
    const next = await panel.panelContinue(db, store)
    assert.equal(next.mode, 'initial')
    assert.equal(next.recommendations.length, 1)
    assert.ok(next.batchId > first.batchId)
  })

  await run('继续阅读没有新候选时保持旧推荐，不重复生成', async () => {
    const again = await panel.panelContinue(db, store)
    assert.equal(again.batchId, (await panel.panelOverview(db, store)).batchId)
    assert.equal(again.recommendations.length, 1)
  })

  console.log('== 来源与接入 ==')
  await run('手工来源可写入待读池，邮件来源禁止手工灌入', () => {
    const ok = panel.panelIngest(db, { sourceKey: 'manual', title: '随手记：论文选题', content: '从知网看到的选题' })
    assert.ok(ok.ok, ok.message)
    assert.ok(ok.id)
    const info = db.prepare('SELECT * FROM info WHERE id = ?').get(ok.id)
    assert.equal(info.source_type, 'manual')
    assert.equal(info.destination, 'unverified')
    const bad = panel.panelIngest(db, { sourceKey: 'email', title: '伪造邮件' })
    assert.equal(bad.ok, false)
    assert.ok(bad.message.includes('邮箱同步'), bad.message)
    const unknown = panel.panelIngest(db, { sourceKey: 'wechat', title: '微信' })
    assert.equal(unknown.ok, false)
    assert.ok(unknown.message.includes('未知来源'), unknown.message)
  })

  await run('来源列表带未分流计数，禁用来源不出现', () => {
    db.prepare("UPDATE inbox_source SET enabled = 0 WHERE key = 'daily'").run()
    const list = panel.panelSources(db)
    assert.ok(list.some((s) => s.key === 'email'))
    assert.ok(list.every((s) => s.key !== 'daily'))
    assert.equal(
      list.reduce((sum, s) => sum + s.pending, 0),
      panelDao.countPanelCandidates(db),
      '来源徽标之和应等于待读池口径'
    )
  })

  await run('并发打开只生成一个批次（StrictMode 双调用去重）', async () => {
    const raceFile = join(TMP_DIR, 'panel-race.db')
    for (const suffix of ['', '-wal', '-shm']) rmSync(raceFile + suffix, { force: true })
    const db2 = openDatabase(raceFile)
    try {
      const ing = panel.panelIngest(db2, { sourceKey: 'manual', title: '并发打开', content: '只应生成一批' })
      assert.ok(ing.ok, ing.message)
      const [a, b] = await Promise.all([panel.panelOverview(db2, store), panel.panelOverview(db2, store)])
      assert.ok(a.batchId, '应有批次')
      assert.equal(a.batchId, b.batchId)
      assert.equal((db2.prepare('SELECT COUNT(*) AS c FROM recommendation_batch').get()).c, 1)
    } finally {
      db2.close()
      for (const suffix of ['', '-wal', '-shm']) rmSync(raceFile + suffix, { force: true })
    }
  })

  console.log('== 学习与画像 ==')
  await run('记忆按 21 天半衰期衰减，重复强化提高置信度', () => {
    const half = learning.decayWeight(1, '2026-01-01T00:00:00.000Z', new Date('2026-01-22T00:00:00.000Z'))
    assert.ok(Math.abs(half - 0.5) < 0.01, String(half))
    assert.ok(learning.confidenceFor(4) > learning.confidenceFor(1))
    assert.ok(learning.confidenceFor(1000) <= 0.95)
  })

  await run('画像摘要包含正负偏好，反馈后学习信号可读', () => {
    const summary = learning.profileSummary(db)
    assert.ok(summary.includes('偏好') || summary.includes('回避'), summary)
    assert.ok(learning.listLearningSignals(db).length > 0)
  })

  console.log('== 反馈灵敏度 ==')
  await run('关键词灵敏度按等级缩放单条邮件反馈', () => {
    settingsDao.setSetting(db, 'keywordSensitivity', 'high')
    const highEmail = seedEmail(db, accId, { subject: '量子计算讲座', from_addr: 'quantum@example.com' })
    keywords.recordEmailKeywords(
      db,
      highEmail,
      [{ keyword: '量子计算', kind: 'topic', evidence: '量子计算讲座', confidence: 0.9 }],
      '量子计算讲座'
    )
    keywords.applyKeywordFeedback(db, highEmail, 0, 'todo')
    const high = keywords.listKeywordProfile(db).find((row) => row.keyword === '量子计算')
    assert.ok(high, '应写入关键词画像')
    assert.ok(Math.abs(high.weight - 0.48) < 1e-9, `较高灵敏度应放大到 0.48，实际 ${high.weight}`)

    settingsDao.setSetting(db, 'keywordSensitivity', 'veryLow')
    const lowEmail = seedEmail(db, accId, { subject: '边缘计算实验', from_addr: 'edge@example.com' })
    keywords.recordEmailKeywords(
      db,
      lowEmail,
      [{ keyword: '边缘计算', kind: 'topic', evidence: '边缘计算实验', confidence: 0.9 }],
      '边缘计算实验'
    )
    keywords.applyKeywordFeedback(db, lowEmail, 0, 'todo')
    const low = keywords.listKeywordProfile(db).find((row) => row.keyword === '边缘计算')
    assert.ok(low, '应写入关键词画像')
    assert.ok(Math.abs(low.weight - 0.08) < 1e-9, `极低灵敏度应缩小到 0.08，实际 ${low.weight}`)
  })

  await run('雷达灵敏度缩放面板处置对八维权重的调整', async () => {
    settingsDao.setSetting(db, 'radarSensitivity', 'veryHigh')
    const email = seedEmail(db, accId, { subject: '学术讲座：新的报告', from_addr: 'teacher@school.edu.cn' })
    seedAnalysis(db, email, { action_required: null, category: '重要通知' })
    const infoId = seedInfo(db, email, { title: '学术讲座：新的报告', category: '重要通知' })
    const overview = await panel.panelOverview(db, store)
    const rec = overview.recommendations.find((row) => row.infoId === infoId)
    assert.ok(rec, '新邮件应进入推荐')
    const service = mailTags.getMailTagService(TMP_DIR)
    const before = (await service.preferencesGet()).parentWeights.academics
    const result = panel.panelAct(db, store, rec.id, 'todo')
    assert.ok(result.ok, result.message)
    await panel.adjustConcernFromAct(db, rec.id, 'todo', TMP_DIR)
    const after = (await mailTags.getMailTagService(TMP_DIR).preferencesGet()).parentWeights.academics
    assert.ok(Math.abs(after - before - 0.7) < 1e-9, `很高灵敏度应 +0.70，实际 +${(after - before).toFixed(2)}`)
  })

  db.close()
  console.log(`\n共 ${passed + failed} 条，通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
