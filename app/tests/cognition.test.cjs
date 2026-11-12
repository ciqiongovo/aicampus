'use strict'
// 认知服务（画像记忆/长期规则/权限策略）数据层测试
// 先编译：npx tsc -p .test-out/tsconfig.cognition.json
// 再运行：node tests/cognition.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { DatabaseSync } = require('node:sqlite')
const { openDatabase } = require('../.test-out/main/db/database.js')
const { cognitionMigrations } = require('../.test-out/main/db/cognitionSchema.js')
const { CognitionService, evaluateRuleConditions } = require('../.test-out/main/services/jarvis/cognition.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'cognition-testdb')
const MAIN_DB = join(TMP_DIR, 'main.db')
const LEGACY_DB = join(TMP_DIR, 'legacy.db')

const DAY = 86400000

let passed = 0
let failed = 0

async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
  }
}

function createLegacyTables(db) {
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec("CREATE TABLE profile_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'explicit', recorded_at TEXT NOT NULL DEFAULT (datetime('now')), last_confirmed_at TEXT, archived INTEGER NOT NULL DEFAULT 0)")
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })

  console.log('== 旧数据迁移 ==')
  await run('profile_memory / userGrade / userMajor 兼容迁移（field_key + 不伪造确认时间 + 不清 settings）', () => {
    const db = new DatabaseSync(LEGACY_DB)
    createLegacyTables(db)
    const nowStr = '2026-08-16 12:00:00'
    db.prepare('INSERT INTO profile_memory (content, source, kind, recorded_at, last_confirmed_at, archived) VALUES (?, ?, ?, ?, ?, ?)')
      .run('我喜欢 Python', 'jarvis', 'explicit', nowStr, nowStr, 0)
    db.prepare('INSERT INTO profile_memory (content, source, kind, recorded_at, last_confirmed_at, archived) VALUES (?, ?, ?, ?, ?, ?)')
      .run('用户可能习惯早起', 'behavior', 'inferred', nowStr, null, 0)
    db.prepare('INSERT INTO profile_memory (content, source, kind, recorded_at, last_confirmed_at, archived) VALUES (?, ?, ?, ?, ?, ?)')
      .run('一条旧归档记忆', 'jarvis', 'explicit', nowStr, null, 1)
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('userGrade', JSON.stringify('大一'))
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('userMajor', JSON.stringify('计算机科学'))

    for (const m of cognitionMigrations) for (const sql of m.up) db.exec(sql)

    const explicit = db.prepare("SELECT * FROM cognition_memory WHERE content = '我喜欢 Python'").get()
    assert.ok(explicit, '明确旧记忆应迁移')
    assert.equal(explicit.section, 'general')
    assert.equal(explicit.source_kind, 'explicit')
    assert.equal(explicit.status, 'active')
    assert.equal(explicit.recorded_at, nowStr)
    assert.equal(explicit.last_confirmed_at, nowStr)
    assert.equal(explicit.source_ref, 'jarvis')
    assert.equal(explicit.field_key, null, '旧 profile_memory 不猜语义键')

    const inferred = db.prepare("SELECT * FROM cognition_memory WHERE content = '用户可能习惯早起'").get()
    assert.equal(inferred.status, 'candidate')
    assert.equal(inferred.last_confirmed_at, null)

    const archived = db.prepare("SELECT * FROM cognition_memory WHERE content = '一条旧归档记忆'").get()
    assert.equal(archived.status, 'archived')

    const grade = db.prepare("SELECT * FROM cognition_memory WHERE section = 'background' AND content = '大一'").get()
    assert.ok(grade, 'userGrade 映射为 background 画像')
    assert.equal(grade.source_kind, 'explicit')
    assert.equal(grade.status, 'active')
    assert.equal(grade.last_confirmed_at, null, '旧确认时间未知，不冒充刚刚确认')
    assert.equal(grade.field_key, 'grade')
    assert.match(grade.source_ref, /userGrade/)
    const major = db.prepare("SELECT * FROM cognition_memory WHERE content = '计算机科学'").get()
    assert.ok(major)
    assert.equal(major.field_key, 'major')

    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'userGrade'").get().value, JSON.stringify('大一'))
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'userMajor'").get().value, JSON.stringify('计算机科学'))
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profile_memory'").get())
    db.close()
  })

  const db = openDatabase(MAIN_DB)
  let now = new Date('2026-10-01T00:00:00Z')
  const clock = () => now
  const svc = new CognitionService(db, clock)

  console.log('== 明确/推断 与 候选 ==')
  await run('明确表达：learn explicit 落库为 active 且已确认', () => {
    const r = svc.learn({ content: '我不喜欢 Java', section: 'interest', sourceKind: 'explicit', sourceQuote: '我不喜欢 Java' })
    assert.equal(r.ok, true)
    assert.equal(r.item.status, 'active')
    assert.equal(r.item.sourceKind, 'explicit')
    assert.ok(r.item.lastConfirmedAt)
  })
  await run('explicit 无原话佐证自动降级为 inferred', () => {
    const r = svc.learn({ content: '我喜欢早起', section: 'habit', sourceKind: 'explicit', sourceQuote: '今天天气不错' })
    assert.equal(r.item.sourceKind, 'inferred')
    assert.equal(r.item.status, 'active')
  })
  await run('推断不覆盖明确表达：同内容 inferred 被跳过', () => {
    const r = svc.learn({ content: '我不喜欢 Java', section: 'interest', sourceKind: 'inferred', sensitivity: 'ordinary' })
    assert.equal(r.skipped, true)
    assert.equal(r.item.sourceKind, 'explicit')
  })
  await run('敏感内容即使 sensitivity=ordinary 也强制 candidate', () => {
    const r = svc.learn({ content: '我的银行卡密码是 123456', section: 'general', sourceKind: 'inferred', sensitivity: 'ordinary' })
    assert.equal(r.item.status, 'candidate')
    assert.equal(r.item.lastConfirmedAt, null)
  })
  await run('敏感分区（background）即使 ordinary 也强制 candidate', () => {
    const r = svc.learn({ content: '用户现在住校', section: 'background', sourceKind: 'inferred', sensitivity: 'ordinary' })
    assert.equal(r.item.status, 'candidate')
  })
  await run('未确认候选不进入 fresh', () => {
    const rel = svc.relevantMemories('银行卡')
    assert.equal(rel.fresh.length, 0)
    assert.ok(rel.candidate.length >= 1)
    for (const c of rel.candidate) assert.equal(c.lastConfirmedAt, null)
  })

  console.log('== fieldKey 结构化冲突 ==')
  await run('同 fieldKey 推断不覆盖明确表达（不同措辞）', () => {
    const r1 = svc.learn({ content: '我不喜欢咖啡', section: 'interest', sourceKind: 'explicit', sourceQuote: '我不喜欢咖啡', fieldKey: 'drink_pref' })
    assert.equal(r1.ok, true)
    assert.equal(r1.item.sourceKind, 'explicit')
    const r2 = svc.learn({ content: '咖啡其实还行', section: 'interest', sourceKind: 'inferred', sensitivity: 'ordinary', fieldKey: 'drink_pref' })
    assert.equal(r2.skipped, true, '推断不覆盖明确')
    assert.equal(r2.id, r1.id)
    const rows = svc.memoryList({ section: 'interest' }).filter((m) => m.fieldKey === 'drink_pref')
    assert.equal(rows.length, 1, '同 key 不同措辞不产生第二条 active')
    assert.equal(rows[0].sourceKind, 'explicit')
    assert.equal(rows[0].content, '我不喜欢咖啡')
  })
  await run('同 fieldKey 显式修正更新原 id 形成版本历史', () => {
    const r1 = svc.learn({ content: '我不喜欢早睡', section: 'habit', sourceKind: 'explicit', sourceQuote: '我不喜欢早睡', fieldKey: 'sleep_habit' })
    const id1 = r1.id
    const rev1 = r1.item.revision
    const r2 = svc.learn({ content: '早睡现在还行', section: 'habit', sourceKind: 'explicit', sourceQuote: '早睡现在还行', fieldKey: 'sleep_habit' })
    assert.equal(r2.id, id1, '同 key 更新原 id')
    assert.equal(r2.item.revision, rev1 + 1)
    assert.equal(r2.item.content, '早睡现在还行')
    const hist = svc.memoryHistory(id1)
    assert.ok(hist.some((h) => h.content === '我不喜欢早睡'), '旧内容保留在历史')
  })

  console.log('== 版本 / 确认 / 归档 ==')
  let memId = 0
  await run('memorySave 编辑产生新版本并保留历史', () => {
    const r = svc.memorySave({ section: 'goal', content: '本学期目标通过六级', sourceRef: { type: 'manual' } })
    memId = r.id
    assert.equal(r.item.revision, 1)
    const r2 = svc.memorySave({ id: memId, content: '本学期目标通过六级且拿奖学金', section: 'goal' })
    assert.equal(r2.ok, true)
    assert.equal(r2.item.revision, 2)
    assert.equal(r2.item.manualEdited, true)
    const hist = svc.memoryHistory(memId)
    assert.ok(hist.some((h) => h.changeKind === 'create'))
    assert.ok(hist.some((h) => h.changeKind === 'update' && h.revision === 2))
    assert.ok(hist.some((h) => h.content === '本学期目标通过六级'))
  })
  await run('memoryConfirm 内容未变仅刷新确认时间，版本不变', () => {
    const before = svc.memoryList({ section: 'goal' })[0]
    const rev = before.revision
    const recorded = before.recordedAt
    now = new Date(now.getTime() + DAY)
    const r = svc.memoryConfirm(memId)
    assert.equal(r.ok, true)
    const after = svc.memoryList({ section: 'goal' })[0]
    assert.equal(after.revision, rev)
    assert.equal(after.content, before.content)
    assert.equal(after.recordedAt, recorded)
    assert.ok(new Date(after.lastConfirmedAt) > new Date(before.lastConfirmedAt))
  })
  await run('memoryConfirm 候选转确认（promote）', () => {
    const cand = svc.learn({ content: '我最近失眠', section: 'general', sourceKind: 'inferred', sensitivity: 'ordinary' })
    assert.equal(cand.item.status, 'candidate')
    const r = svc.memoryConfirm(cand.id)
    assert.equal(r.item.status, 'active')
    assert.ok(r.item.lastConfirmedAt)
  })
  await run('memoryArchive 停用保留历史，列表不再返回', () => {
    const r = svc.memoryArchive(memId)
    assert.equal(r.item.status, 'archived')
    assert.equal(svc.memoryList({ section: 'goal' }).length, 0)
    assert.equal(svc.memoryList({ section: 'goal', includeArchived: true }).length, 1)
    assert.ok(svc.memoryHistory(memId).some((h) => h.changeKind === 'archive'))
  })
  await run('已归档不可编辑', () => {
    const r = svc.memorySave({ id: memId, content: '再改' })
    assert.equal(r.ok, false)
  })

  console.log('== 相关检索（自然语言） ==')
  let relMemId = 0
  await run('自然句同义扩展命中、无关不匹配', () => {
    now = new Date('2026-10-01T00:00:00Z')
    relMemId = svc.memorySave({ section: 'interest', content: '我不喜欢Python' }).id
    assert.ok(svc.relevantMemories('Python现在怎么样').fresh.some((m) => m.id === relMemId), 'Python现在怎么样 应命中')
    assert.ok(svc.relevantMemories('聊聊编程').fresh.some((m) => m.id === relMemId), '聊聊编程 应命中（同义扩展）')
    assert.equal(svc.relevantMemories('篮球').fresh.some((m) => m.id === relMemId), false, '篮球 不应命中')
  })
  await run('中文长标题 2-3 gram 命中且无关区分', () => {
    now = new Date('2026-10-01T00:00:00Z')
    const mid = svc.memorySave({ section: 'interest', content: '我关注开源项目' }).id
    const q = '学校通知测试 冷门天体物理新发现 小众开源项目走红'
    assert.ok(svc.relevantMemories(q).fresh.some((m) => m.id === mid), '长标题应命中开源项目')
    assert.equal(svc.relevantMemories('篮球').fresh.some((m) => m.id === mid), false, '篮球仍不应命中')
  })

  console.log('== 新鲜期 阈值前/到/后 与 相关/无关 ==')
  await run('阈值前 fresh / 到 stale / 后 stale', () => {
    now = new Date('2026-10-01T00:00:00Z')
    const r = svc.memorySave({ section: 'interest', content: '我关注机器学习' })
    const id = r.id
    now = new Date('2026-10-30T00:00:00Z')
    assert.equal(svc.relevantMemories('机器学习').fresh.some((m) => m.id === id), true)
    now = new Date('2026-10-31T00:00:00Z')
    assert.equal(svc.relevantMemories('机器学习').stale.some((m) => m.id === id), true)
    now = new Date('2026-11-01T00:00:00Z')
    assert.equal(svc.relevantMemories('机器学习').stale.some((m) => m.id === id), true)
  })
  await run('相关话题才返回旧话题，无关不打扰', () => {
    now = new Date('2026-11-01T00:00:00Z')
    const unrelated = svc.relevantMemories('游泳健身')
    assert.equal(unrelated.stale.some((m) => m.content === '我关注机器学习'), false)
    const related = svc.relevantMemories('机器学习')
    assert.equal(related.stale.some((m) => m.content === '我关注机器学习'), true)
  })

  console.log('== 跨时区 ==')
  await run('UTC 存储 + 带偏移时钟：按绝对时间判断', () => {
    now = new Date('2026-09-01T00:00:00Z')
    db.prepare("INSERT INTO cognition_memory (section, content, source_kind, field_key, source_ref, status, recorded_at, last_confirmed_at, revision, manual_edited, created_at, updated_at) VALUES ('interest', '跨时区记忆', 'explicit', NULL, '', 'active', '2026-09-14T16:00:00Z', '2026-09-14T16:00:00Z', 1, 0, '2026-09-14T16:00:00Z', '2026-09-14T16:00:00Z')").run()
    now = new Date('2026-10-14T00:00:00+08:00')
    assert.equal(svc.relevantMemories('跨时区').fresh.some((m) => m.content === '跨时区记忆'), true)
    now = new Date('2026-10-15T00:00:00+08:00')
    assert.equal(svc.relevantMemories('跨时区').stale.some((m) => m.content === '跨时区记忆'), true)
  })

  console.log('== 权限策略 ==')
  await run('默认策略含 route_article/set_category 与 reconfirm_memory 分级', () => {
    const p = svc.agentPolicyGet()
    assert.ok(p.writeAuto.includes('route_article'))
    assert.ok(p.writeAuto.includes('set_category'))
    assert.ok(p.writeAuto.includes('learn_memory'))
    assert.ok(p.writeConfirm.includes('delete_reminder'))
    assert.ok(p.writeConfirm.includes('propose_rule'))
    assert.ok(p.writeConfirm.includes('reconfirm_memory'))
    assert.equal(p.memoryFreshnessDays, 30)
  })
  await run('写分级重叠被拒绝', () => {
    const r = svc.agentPolicySet({ writeAuto: ['create_item', 'delete_item'], writeConfirm: ['delete_item'] })
    assert.equal(r.ok, false)
    assert.match(r.message, /重叠/)
  })
  await run('非法新鲜期/时区被拒绝', () => {
    assert.equal(svc.agentPolicySet({ memoryFreshnessDays: 0 }).ok, false)
    assert.equal(svc.agentPolicySet({ memoryFreshnessDays: 1.5 }).ok, false)
    assert.equal(svc.agentPolicySet({ timeZone: 'Not/AZone' }).ok, false)
  })
  await run('合法策略保存并回读', () => {
    const r = svc.agentPolicySet({ memoryFreshnessDays: 15, timeZone: 'Asia/Shanghai', learningEnabled: false })
    assert.equal(r.ok, true)
    const p = svc.agentPolicyGet()
    assert.equal(p.memoryFreshnessDays, 15)
    assert.equal(p.learningEnabled, false)
    svc.agentPolicySet({ memoryFreshnessDays: 30, learningEnabled: true })
  })

  console.log('== 规则 ==')
  await run('规则 CRUD + 版本 + 停用', () => {
    const r = svc.agentRuleSave({
      scope: 'mail', name: '缴费邮件分流', enforcement: 'mandatory',
      conditions: [{ field: 'category', op: 'eq', value: '需行动' }],
      action: { type: 'route_info', params: { destination: 'unverified' } },
      modifiedBy: 'user'
    })
    assert.equal(r.ok, true)
    assert.equal(r.rule.revision, 1)
    const r2 = svc.agentRuleSave({ id: r.id, name: '缴费邮件分流(改)', action: { type: 'route_info', params: { destination: 'item' } } })
    assert.equal(r2.rule.revision, 2)
    assert.equal(r2.rule.action.params.destination, 'item')
    assert.equal(svc.agentRuleDelete(r.id).ok, true)
    assert.equal(svc.agentRuleDelete(r.id).rule.enabled, false)
    assert.equal(svc.getRulesFor('mail').length, 0)
  })
  await run('getRulesFor 返回 global + scope，强制优先', () => {
    svc.agentRuleSave({ scope: 'global', name: '全局待补充日期', enforcement: 'mandatory', action: { type: 'require_deadline' } })
    svc.agentRuleSave({ scope: 'mail', name: '邮件偏好', enforcement: 'preference', action: { type: 'notify' } })
    const rules = svc.getRulesFor('mail')
    assert.equal(rules.length, 2)
    assert.equal(rules[0].enforcement, 'mandatory')
  })
  await run('evaluateRuleConditions 确定性匹配', () => {
    assert.equal(evaluateRuleConditions([{ field: 'category', op: 'eq', value: '需行动' }], { category: '需行动' }), true)
    assert.equal(evaluateRuleConditions([{ field: 'category', op: 'eq', value: '需行动' }], { category: '一般信息' }), false)
    assert.equal(evaluateRuleConditions([{ field: 'deadline', op: 'missing' }], {}), true)
    assert.equal(evaluateRuleConditions([{ field: 'deadline', op: 'missing' }], { deadline: '2026-11-01' }), false)
    assert.equal(evaluateRuleConditions([{ field: 'subject', op: 'contains', value: '缴费' }], { subject: '请尽快缴费' }), true)
    assert.equal(evaluateRuleConditions([{ field: 'subject', op: 'contains', value: '缴费' }], { subject: '会议通知' }), false)
  })
  await run('matchRules 按事实过滤', () => {
    const matched = svc.matchRules('mail', { category: '需行动' })
    assert.ok(matched.some((r) => r.name === '全局待补充日期'))
    assert.ok(matched.some((r) => r.name === '邮件偏好'))
  })

  db.close()
  console.log('合计: ' + passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
