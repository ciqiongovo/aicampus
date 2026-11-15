'use strict'
// M2 数据层单元测试：迁移幂等 + 各 DAO CRUD + 外键级联
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node tests/db.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { openDatabase } = require('../.test-out/main/db/database.js')
const settingsDao = require('../.test-out/main/db/dao/settingsDao.js')
const accountsDao = require('../.test-out/main/db/dao/accountsDao.js')
const emailsDao = require('../.test-out/main/db/dao/emailsDao.js')
const analysisDao = require('../.test-out/main/db/dao/emailAnalysisDao.js')
const itemsDao = require('../.test-out/main/db/dao/itemsDao.js')
const remindersDao = require('../.test-out/main/db/dao/remindersDao.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'testdb')
const DB_FILE = join(TMP_DIR, 'm2-test.db')

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

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })

  console.log('== 迁移与建表 ==')
  await run('首次打开：增量迁移到底并保留核心表', () => {
    const db = openDatabase(DB_FILE)
    const v = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()
    // 不写死具体版本号：每加一条迁移就要改测试的话，没人会去改，
    // 改成「至少到了 v29（对标库建表那一版）」+ 下面两条约束就够看住了。
    assert.ok(v.version >= 29, `迁移只走到 v${v.version}`)
    for (const t of ['accounts', 'emails', 'email_analysis', 'items', 'reminders', 'settings', 'info', 'profile_memory', 'counter_rec', 'ai_thoughts', 'schema_migrations', 'inbox_source', 'recommendation', 'recommendation_batch', 'feedback_event', 'preference_signal', 'source_preference', 'material_tags', 'material_folders', 'zhihu_push', 'zhihu_state']) {
      assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t), `缺表 ${t}`)
    }
    const dailyLabel = db.prepare("SELECT label FROM inbox_source WHERE key = 'daily'").get()
    assert.equal(dailyLabel.label, '日报')
    const accountCols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name)
    for (const col of ['oauth_provider', 'oauth_client_id', 'oauth_refresh_enc', 'oauth_access_enc', 'oauth_expires_at']) {
      assert.ok(accountCols.includes(col), `accounts 缺列 ${col}`)
    }
    const infoCols = db.prepare('PRAGMA table_info(info)').all().map((c) => c.name)
    for (const col of ['source_type', 'source_email_id', 'title', 'content', 'category', 'destination', 'item_id', 'status', 'created_at', 'routed_at', 'material_folder']) {
      assert.ok(infoCols.includes(col), `info 缺列 ${col}`)
    }
    const memCols = db.prepare('PRAGMA table_info(profile_memory)').all().map((c) => c.name)
    for (const col of ['content', 'source', 'kind', 'recorded_at', 'last_confirmed_at', 'archived']) {
      assert.ok(memCols.includes(col), `profile_memory 缺列 ${col}`)
    }
    const anCols = db.prepare('PRAGMA table_info(email_analysis)').all().map((c) => c.name)
    assert.ok(anCols.includes('tier'), 'email_analysis 缺列 tier')
    db.close()
  })
  await run('重复打开：迁移幂等（同一版本不重复执行）', () => {
    const db = openDatabase(DB_FILE)
    const rows = db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
    // 幂等的判据是「同一版本只有一行」，不是「总行数等于某个数」——
    // 后者每加一条迁移就失效，前者才真的在测幂等
    assert.equal(new Set(rows).size, rows.length, '有版本被重复执行')
    assert.ok(rows.length > 0)
    db.close()
  })

  const db = openDatabase(DB_FILE)

  console.log('== settings DAO ==')
  await run('setSetting/getSetting JSON 往返 + getSettingOr 兜底', () => {
    settingsDao.setSetting(db, 'ai.defaultProvider', { id: 'deepseek', temperature: 0.7 })
    assert.deepEqual(settingsDao.getSetting(db, 'ai.defaultProvider'), { id: 'deepseek', temperature: 0.7 })
    assert.equal(settingsDao.getSettingOr(db, 'not.exist', 'fallback'), 'fallback')
  })
  await run('setSetting 覆盖更新 + deleteSetting', () => {
    settingsDao.setSetting(db, 'ai.defaultProvider', 'deepseek')
    assert.equal(settingsDao.getSetting(db, 'ai.defaultProvider'), 'deepseek')
    settingsDao.deleteSetting(db, 'ai.defaultProvider')
    assert.equal(settingsDao.getSetting(db, 'ai.defaultProvider'), undefined)
    assert.deepEqual(settingsDao.getAllSettings(db), {})
  })

  console.log('== accounts DAO ==')
  const account = {
    provider: 'qq', label: 'QQ 邮箱', address: 'a@qq.com', host: 'imap.qq.com', port: 993,
    encryption: 'ssl', username: 'a@qq.com', secret_enc: 'enc://xxx', folder: 'INBOX',
    auth_mode: 'appPassword', last_uidvalidity: null, last_uid: null, last_sync_at: null, sync_error: null
  }
  let accId = 0
  await run('insertAccount / getAccount / listAccounts', () => {
    accId = accountsDao.insertAccount(db, account)
    assert.ok(accId > 0)
    assert.equal(accountsDao.getAccount(db, accId).provider, 'qq')
    assert.equal(accountsDao.listAccounts(db).length, 1)
  })
  await run('updateAccount 白名单 patch（含置 null；非白名单字段不生效）', () => {
    assert.ok(accountsDao.updateAccount(db, accId, { label: '工作 QQ', syncError: 'timeout' }))
    assert.equal(accountsDao.getAccount(db, accId).label, '工作 QQ')
    assert.equal(accountsDao.getAccount(db, accId).sync_error, 'timeout')
    assert.ok(accountsDao.updateAccount(db, accId, { syncError: null }))
    assert.equal(accountsDao.getAccount(db, accId).sync_error, null)
    // provider 自 M3 起属于 PATCH_FIELDS（设置页允许改服务商），因此可更新
    assert.ok(accountsDao.updateAccount(db, accId, { provider: 'gmail' }))
    assert.equal(accountsDao.getAccount(db, accId).provider, 'gmail')
    assert.ok(accountsDao.updateAccount(db, accId, { provider: 'qq' }))
    assert.equal(accountsDao.getAccount(db, accId).provider, 'qq')
    // 真正不在白名单的字段：整体忽略，且返回 false 表示「没有任何列被更新」
    assert.equal(accountsDao.updateAccount(db, accId, { createdAt: '2026-01-01 00:00:00' }), false)
    assert.equal(accountsDao.getAccount(db, accId).provider, 'qq')
  })
  await run('AI 绑定字段：insert 默认开启、update 白名单可改、三项覆盖写入', () => {
    const acc2 = accountsDao.insertAccount(db, { ...account, address: 'b@qq.com', username: 'b@qq.com' })
    assert.equal(accountsDao.getAccount(db, acc2).ai_enabled, 1)
    assert.equal(accountsDao.getAccount(db, acc2).ai_provider, null)
    assert.ok(
      accountsDao.updateAccount(db, acc2, {
        aiEnabled: 0,
        aiProvider: 'deepseek',
        aiBaseUrl: 'https://api.deepseek.com/v1',
        aiModel: 'deepseek-chat'
      })
    )
    const row = accountsDao.getAccount(db, acc2)
    assert.equal(row.ai_enabled, 0)
    assert.equal(row.ai_provider, 'deepseek')
    assert.equal(row.ai_base_url, 'https://api.deepseek.com/v1')
    assert.equal(row.ai_model, 'deepseek-chat')
    accountsDao.deleteAccount(db, acc2)
  })

  console.log('== emails DAO ==')
  const emailBase = {
    account_id: accId, folder: 'INBOX', uid: 1001, message_id: '<m1@x>', subject: '缴费通知',
    from_addr: 'no-reply@bank.com', to_addr: 'a@qq.com', cc: '', date_utc: '2026-10-15 08:00:00',
    date_raw: 'Thu, 15 Oct 2026 16:00:00 +0800', unread: 1, body_text: '请缴费', body_html: '<p>请缴费</p>',
    attachments_json: '[]', size: 120
  }
  await run('upsertEmail 插入 + findByUid', () => {
    const id = emailsDao.upsertEmail(db, emailBase)
    assert.ok(id > 0)
    assert.equal(emailsDao.countEmails(db), 1)
    assert.equal(emailsDao.findByUid(db, accId, 'INBOX', 1001).subject, '缴费通知')
  })
  await run('upsertEmail 同 (account_id,folder,uid) 覆盖，不产生重复行', () => {
    emailsDao.upsertEmail(db, { ...emailBase, subject: '缴费通知（改）', unread: 0 })
    assert.equal(emailsDao.countEmails(db), 1)
    const row = emailsDao.findByUid(db, accId, 'INBOX', 1001)
    assert.equal(row.subject, '缴费通知（改）')
    assert.equal(row.unread, 0)
  })
  await run('listEmails 过滤与分页', () => {
    emailsDao.upsertEmail(db, { ...emailBase, uid: 1002, subject: '会议邀请' })
    emailsDao.upsertEmail(db, { ...emailBase, uid: 1003, subject: '归档邮件', folder: 'Archive' })
    assert.equal(emailsDao.listEmails(db, { accountId: accId, folder: 'INBOX', limit: 10 }).length, 2)
    assert.equal(emailsDao.listEmails(db, { accountId: accId, folder: 'INBOX', limit: 1 }).length, 1)
    assert.equal(emailsDao.listEmails(db, { accountId: accId, folder: 'Archive' }).length, 1)
    assert.equal(emailsDao.countEmails(db, accId), 3)
  })

  console.log('== email_analysis DAO ==')
  const emptyAnalysis = {
    status: 'pending', category: null, summary: null, action_required: null, deadline_raw: null,
    deadline_at: null, deadline_kind: null, event_start_at: null, applicable_to: null, confidence: null,
    tier: null, evidence_json: '[]', model: null, provider: null, error: null, analyzed_at: null
  }
  await run('upsertAnalysis 插入/覆盖（email_id 唯一）', () => {
    const emailId = emailsDao.findByUid(db, accId, 'INBOX', 1001).id
    analysisDao.upsertAnalysis(db, {
      ...emptyAnalysis, email_id: emailId, status: 'analyzed', category: '需行动', summary: '缴纳学费',
      action_required: '9 月 1 日前缴费', deadline_raw: '9月1日', deadline_at: '2026-09-01T00:00:00+08:00',
      deadline_kind: '截止时间', confidence: 0.92, evidence_json: '[{"t":"9月1日"}]',
      model: 'deepseek-chat', provider: 'deepseek', analyzed_at: '2026-10-15 09:00:00'
    })
    assert.equal(analysisDao.getByEmailId(db, emailId).category, '需行动')
    analysisDao.upsertAnalysis(db, { ...emptyAnalysis, email_id: emailId, status: 'failed', error: 'timeout' })
    assert.equal(analysisDao.getByEmailId(db, emailId).status, 'failed')
    assert.equal(analysisDao.listByStatus(db, 'failed').length, 1)
  })
  await run('listPendingWithAccount 只取 AI 开启账号的待分析行', () => {
    const accOn = accountsDao.insertAccount(db, { ...account, address: 'on@qq.com', username: 'on@qq.com' })
    const accOff = accountsDao.insertAccount(db, { ...account, address: 'off@qq.com', username: 'off@qq.com' })
    accountsDao.updateAccount(db, accOff, { aiEnabled: 0 })
    const eOn = emailsDao.upsertEmail(db, { ...emailBase, account_id: accOn, uid: 901 })
    const eOff = emailsDao.upsertEmail(db, { ...emailBase, account_id: accOff, uid: 902 })
    analysisDao.upsertAnalysis(db, { ...emptyAnalysis, email_id: eOn, status: 'pending' })
    analysisDao.upsertAnalysis(db, { ...emptyAnalysis, email_id: eOff, status: 'pending' })
    const rows = analysisDao.listPendingWithAccount(db, 20)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].account_id, accOn)
    assert.equal(rows[0].email_id, eOn)
    accountsDao.deleteAccount(db, accOn)
    accountsDao.deleteAccount(db, accOff)
  })

  console.log('== items DAO ==')
  let itemId = 0
  await run('items CRUD', () => {
    const emailId = emailsDao.findByUid(db, accId, 'INBOX', 1001).id
    itemId = itemsDao.createItem(db, {
      title: '交学费', source_email_id: emailId, category: '需行动',
      deadline_at: '2026-09-01T00:00:00+08:00'
    })
    assert.equal(itemsDao.getItem(db, itemId).title, '交学费')
    assert.equal(itemsDao.getItem(db, itemId).status, '待核实')
    assert.ok(itemsDao.updateItem(db, itemId, { status: '进行中', notes: '已缴一半' }))
    assert.equal(itemsDao.getItem(db, itemId).status, '进行中')
    assert.equal(itemsDao.listItems(db, '进行中').length, 1)
    assert.equal(itemsDao.listItems(db).length, 1)
  })

  console.log('== reminders DAO ==')
  await run('reminders 创建/到期补扫/标记触发/删除', () => {
    const r1 = remindersDao.createReminder(db, { item_id: itemId, remind_at: '2026-10-10T09:00:00+08:00', channel: 'desktop' })
    const r2 = remindersDao.createReminder(db, { item_id: itemId, remind_at: '2030-01-01T09:00:00+08:00' })
    assert.equal(remindersDao.listByItem(db, itemId).length, 2)
    const pending = remindersDao.listPending(db, '2026-10-16T00:00:00+08:00')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, r1)
    remindersDao.markFired(db, r1)
    assert.equal(remindersDao.listPending(db, '2026-10-16T00:00:00+08:00').length, 0)
    assert.equal(remindersDao.getReminder(db, r1).status, 'fired')
    remindersDao.deleteReminder(db, r2)
    assert.equal(remindersDao.getReminder(db, r2), undefined)
  })

  console.log('== 外键级联 ==')
  await run('删 item → 其 reminders 级联删除', () => {
    itemsDao.deleteItem(db, itemId)
    assert.equal(remindersDao.listByItem(db, itemId).length, 0)
  })
  await run('删 email → 其 analysis 级联删除', () => {
    const acc2 = accountsDao.insertAccount(db, { ...account, address: 'b@163.com', provider: '163', username: 'b@163.com' })
    const e1 = emailsDao.upsertEmail(db, { ...emailBase, account_id: acc2, uid: 1 })
    const e2 = emailsDao.upsertEmail(db, { ...emailBase, account_id: acc2, uid: 2 })
    analysisDao.upsertAnalysis(db, { ...emptyAnalysis, email_id: e1 })
    analysisDao.upsertAnalysis(db, { ...emptyAnalysis, email_id: e2 })
    db.prepare('DELETE FROM emails WHERE id = ?').run(e2)
    assert.equal(analysisDao.getByEmailId(db, e2), undefined)
    assert.ok(analysisDao.getByEmailId(db, e1), '无关联行不应被删')
    accountsDao.deleteAccount(db, acc2)
    assert.equal(emailsDao.findByUid(db, acc2, 'INBOX', 1), undefined)
  })
  await run('删 account → 其 emails 级联删除', () => {
    assert.equal(emailsDao.countEmails(db, accId), 3)
    accountsDao.deleteAccount(db, accId)
    assert.equal(accountsDao.getAccount(db, accId), undefined)
    assert.equal(emailsDao.countEmails(db, accId), 0)
  })

  db.close()
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
