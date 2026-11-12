'use strict'
// 事项写入服务单元测试：邮件确认事项 / 手工事项 / 提醒 / 状态 / 删除 / 信息流分流
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node tests/items.test.cjs
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
const items = require('../.test-out/main/services/items/service.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'items-testdb')
const DB_FILE = join(TMP_DIR, 'items-test.db')

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

let uidSeq = 0

function seedEmail(db, accId, over = {}) {
  uidSeq += 1
  return emailsDao.upsertEmail(db, {
    account_id: accId,
    folder: 'INBOX',
    uid: uidSeq,
    message_id: `<m${uidSeq}@test>`,
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
    summary: 'AI 摘要',
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

  const p1Id = seedEmail(db, accId, { subject: 'P1 主题', from_addr: 'p1@example.com' })
  seedAnalysis(db, p1Id, {
    action_required: '周五前提交周报',
    deadline_at: '2026-10-28T09:00:00.000Z',
    deadline_kind: '具体时间',
    deadline_raw: '下周三前'
  })
  const p2Id = seedEmail(db, accId, { subject: 'P2 主题', from_addr: 'p2@example.com' })
  seedAnalysis(db, p2Id, { action_required: '确认会议时间', deadline_at: null })
  const t1Id = seedEmail(db, accId, { subject: 'T1 主题', from_addr: 't1@example.com' })
  seedAnalysis(db, t1Id, { action_required: null })
  const t2Id = seedEmail(db, accId, { subject: 'T2 主题', from_addr: 't2@example.com' })
  seedAnalysis(db, t2Id, { action_required: null })

  // ---------- 确认事项 ----------
  console.log('== 确认事项 ==')
  let itemP1Id = 0
  let itemP2Id = 0

  await run('createItemFromEmail 默认标题取行动要求 + 状态待处理 + 分类/截止/备注回填', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: p1Id })
    assert.ok(r.ok, r.message)
    itemP1Id = r.id
    const item = itemsDao.getItem(db, itemP1Id)
    assert.equal(item.title, '周五前提交周报')
    assert.equal(item.status, '待处理')
    assert.equal(item.category, '需行动')
    assert.equal(item.deadline_at, '2026-10-28T09:00:00.000Z')
    assert.equal(item.deadline_kind, '具体时间')
    assert.equal(item.deadline_raw, '下周三前')
    assert.equal(item.notes, 'AI 摘要')
    assert.equal(item.source_email_id, p1Id)
  })

  await run('同一来源邮件幂等：重复确认被拒绝', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: p1Id })
    assert.equal(r.ok, false)
    assert.ok(r.message.includes('已确认为事项'), r.message)
  })

  await run('标题回退：无行动要求时取邮件主题', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: t1Id })
    assert.ok(r.ok, r.message)
    assert.equal(itemsDao.getItem(db, r.id).title, 'T1 主题')
  })

  await run('无效提醒时间被拒绝，且不落事项', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: t2Id, remindAt: 'not-a-date' })
    assert.equal(r.ok, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM items WHERE source_email_id = ?').get(t2Id).c, 0)
  })

  await run('来源邮件不存在被友好拒绝', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: 99999 })
    assert.equal(r.ok, false)
    assert.ok(r.message.includes('来源邮件不存在'), r.message)
  })

  // ---------- 提醒 ----------
  console.log('== 提醒 ==')

  await run('确认事项同事务建提醒（UTC ISO 存储、pending）', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: p2Id, remindAt: '2026-10-27T12:00:00.000Z' })
    assert.ok(r.ok, r.message)
    itemP2Id = r.id
    const rems = remindersDao.listByItem(db, itemP2Id)
    assert.equal(rems.length, 1)
    assert.equal(rems[0].remind_at, '2026-10-27T12:00:00.000Z')
    assert.equal(rems[0].status, 'pending')
  })

  await run('createItemReminder：无效事项/无效时间拒绝，有效则替换旧 pending', () => {
    assert.equal(items.createItemReminder(db, 99999, '2026-10-27T12:00:00.000Z').ok, false)
    assert.equal(items.createItemReminder(db, itemP2Id, 'bad-date').ok, false)
    assert.ok(items.createItemReminder(db, itemP2Id, '2026-10-29T12:00:00.000Z').ok)
    const rems = remindersDao.listByItem(db, itemP2Id)
    assert.equal(rems.length, 2, '保留历史提醒记录')
    assert.equal(rems.filter((r) => r.status === 'pending').length, 1, '未触发旧提醒被取消')
    assert.equal(rems.find((r) => r.status === 'pending').remind_at, '2026-10-29T12:00:00.000Z')
  })

  await run('deleteItemReminder 删除单条', () => {
    const newest = remindersDao.listByItem(db, itemP2Id).find((r) => r.status === 'pending')
    assert.ok(items.deleteItemReminder(db, newest.id).ok)
    assert.equal(remindersDao.listByItem(db, itemP2Id).filter((r) => r.status === 'pending').length, 0)
  })

  // ---------- 状态与删除 ----------
  console.log('== 状态与删除 ==')

  await run('setItemStatus：合法状态更新、非法状态拒绝且不落库、缺失事项拒绝', () => {
    assert.ok(items.setItemStatus(db, itemP1Id, '进行中').ok)
    assert.equal(itemsDao.getItem(db, itemP1Id).status, '进行中')
    const before = itemsDao.getItem(db, itemP1Id).status
    const bad = items.setItemStatus(db, itemP1Id, '随便写的状态')
    assert.equal(bad.ok, false)
    assert.ok(bad.message.includes('无效状态'), bad.message)
    assert.equal(itemsDao.getItem(db, itemP1Id).status, before, '非法状态不得改动库内状态')
    assert.equal(items.setItemStatus(db, 99999, '已完成').ok, false)
    assert.ok(items.setItemStatus(db, itemP1Id, '待核实').ok, 'DB 默认值待核实属于白名单')
  })

  await run('终态（已完成）自动取消未触发提醒', () => {
    const r = items.createItemReminder(db, itemP1Id, '2026-10-30T08:00:00.000Z')
    assert.ok(r.ok, r.message)
    assert.ok(items.setItemStatus(db, itemP1Id, '已完成').ok)
    const pending = remindersDao.listByItem(db, itemP1Id).filter((x) => x.status === 'pending')
    assert.equal(pending.length, 0)
  })

  await run('deleteItemById 级联删除提醒', () => {
    assert.ok(items.deleteItemById(db, itemP2Id).ok)
    assert.equal(itemsDao.getItem(db, itemP2Id), undefined)
    assert.equal(remindersDao.listByItem(db, itemP2Id).length, 0, '外键级联删除提醒')
  })

  await run('createManualItem：空标题拒绝，正常创建无来源事项', () => {
    assert.equal(items.createManualItem(db, { title: '  ' }).ok, false)
    const r = items.createManualItem(db, { title: '手工事项', notes: '备注', category: '可选机会' })
    assert.ok(r.ok, r.message)
    const item = itemsDao.getItem(db, r.id)
    assert.equal(item.source_email_id, null)
    assert.equal(item.category, '可选机会')
    assert.equal(item.notes, '备注')
  })

  // ---------- 信息流分流 ----------
  console.log('== 信息流分流 ==')

  const f1Id = seedEmail(db, accId, { subject: 'F1 缴费通知', from_addr: 'f1@example.com' })
  seedAnalysis(db, f1Id, { action_required: '周五前缴费', category: '需行动', deadline_at: '2026-10-30T09:00:00.000Z' })
  const f2Id = seedEmail(db, accId, { subject: 'F2 食堂菜单', from_addr: 'f2@example.com' })
  seedAnalysis(db, f2Id, { action_required: null, category: '一般信息' })
  const f1InfoId = infoDao.syncAnalysisToInfo(db, f1Id).id
  infoDao.syncAnalysisToInfo(db, f2Id)

  await run('routeInfoEntry：保留/归档/退回待核实/非法去向拒绝', () => {
    assert.ok(items.routeInfoEntry(db, f1InfoId, 'keep', null).ok)
    assert.equal(db.prepare('SELECT destination FROM info WHERE id = ?').get(f1InfoId).destination, 'keep')
    assert.ok(items.routeInfoEntry(db, f1InfoId, 'archive', null).ok)
    assert.equal(db.prepare('SELECT destination FROM info WHERE id = ?').get(f1InfoId).destination, 'archive')
    assert.ok(items.routeInfoEntry(db, f1InfoId, 'unverified', null).ok)
    const back = db.prepare('SELECT * FROM info WHERE id = ?').get(f1InfoId)
    assert.equal(back.destination, 'unverified')
    assert.equal(back.status, 'unverified')
    assert.equal(back.routed_at, null)
    assert.equal(items.routeInfoEntry(db, f1InfoId, 'hack', null).ok, false)
    assert.equal(items.routeInfoEntry(db, 99999, 'keep', null).ok, false)
  })

  await run('routeInfoEntry → item：创建事项并联动信息流', () => {
    const r = items.routeInfoEntry(db, f1InfoId, 'item', null)
    assert.ok(r.ok, r.message)
    assert.ok(r.id)
    assert.equal(itemsDao.getItem(db, r.id).source_email_id, f1Id)
    const row = db.prepare('SELECT * FROM info WHERE id = ?').get(f1InfoId)
    assert.equal(row.destination, 'item')
    assert.equal(row.item_id, r.id)
    assert.equal(row.status, 'routed')
  })

  await run('非邮件来源分流：用标题/正文建手工事项，无来源邮件', () => {
    const jarvisId = infoDao.createInfo(db, { source_type: 'jarvis', title: '对话转信息', content: '从对话来的内容', destination: 'unverified' })
    const r = items.routeInfoEntry(db, jarvisId, 'item', null)
    assert.ok(r.ok, r.message)
    const item = itemsDao.getItem(db, r.id)
    assert.equal(item.title, '对话转信息')
    assert.equal(item.notes, '从对话来的内容')
    assert.equal(item.source_email_id, null)
    assert.equal(item.deadline_at, null)
    assert.equal(db.prepare('SELECT item_id FROM info WHERE id = ?').get(jarvisId).item_id, r.id)
  })

  await run('非邮件分流幂等：重复分流复用同一事项', () => {
    const jarvisId = infoDao.createInfo(db, { source_type: 'jarvis', title: '幂等事项', content: '内容', destination: 'unverified' })
    const r1 = items.routeInfoEntry(db, jarvisId, 'item', null)
    const r2 = items.routeInfoEntry(db, jarvisId, 'item', null)
    assert.ok(r1.ok && r2.ok)
    assert.equal(r2.id, r1.id)
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM items WHERE title = '幂等事项'").get().c, 1)
  })

  await run('分流无效提醒时间：失败时保持原记录', () => {
    const jarvisId = infoDao.createInfo(db, { source_type: 'jarvis', title: '无效提醒事项', destination: 'unverified' })
    const r = items.routeInfoEntry(db, jarvisId, 'item', 'not-a-date')
    assert.equal(r.ok, false)
    const row = db.prepare('SELECT * FROM info WHERE id = ?').get(jarvisId)
    assert.equal(row.destination, 'unverified')
    assert.equal(row.item_id, null)
  })

  await run('确认事项联动信息流（markInfoAsItem）', () => {
    const r = items.createItemFromEmail(db, { sourceEmailId: f2Id })
    assert.ok(r.ok, r.message)
    const row = db.prepare('SELECT * FROM info WHERE source_email_id = ?').get(f2Id)
    assert.equal(row.destination, 'item')
    assert.equal(row.item_id, r.id)
  })

  // ---------- SAVEPOINT 嵌套 ----------
  console.log('== SAVEPOINT 嵌套事务 ==')

  await run('外部事务提交后分流生效', () => {
    const jId = infoDao.createInfo(db, { source_type: 'jarvis', title: '嵌套事项', destination: 'unverified' })
    db.exec('BEGIN')
    const r = items.routeInfoEntry(db, jId, 'item', null)
    assert.ok(r.ok, r.message)
    const itemId = r.id
    db.exec('COMMIT')
    assert.ok(itemsDao.getItem(db, itemId))
    assert.equal(db.prepare('SELECT destination FROM info WHERE id = ?').get(jId).destination, 'item')
  })

  await run('外部事务回滚可撤销分流建事项', () => {
    const jId = infoDao.createInfo(db, { source_type: 'jarvis', title: '回滚事项', destination: 'unverified' })
    db.exec('BEGIN')
    const r = items.routeInfoEntry(db, jId, 'item', null)
    assert.ok(r.ok, r.message)
    const itemId = r.id
    db.exec('ROLLBACK')
    assert.equal(itemsDao.getItem(db, itemId), undefined)
    assert.equal(db.prepare('SELECT destination FROM info WHERE id = ?').get(jId).destination, 'unverified')
  })

  db.close()
  console.log(`
共 ${passed + failed} 条，通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

main()
