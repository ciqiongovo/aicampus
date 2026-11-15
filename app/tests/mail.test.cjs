'use strict'
// M5 邮件浏览单元测试：离线样例数据走通「列表 → 搜索 → 分页 → 详情 → 已读」与正文清洗
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node tests/mail.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { openDatabase } = require('../.test-out/main/db/database.js')
const accountsDao = require('../.test-out/main/db/dao/accountsDao.js')
const emailsDao = require('../.test-out/main/db/dao/emailsDao.js')
const analysisDao = require('../.test-out/main/db/dao/emailAnalysisDao.js')
const { sanitizeEmailHtml, htmlToText } = require('../.test-out/main/services/mail/sanitize.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'testdb')
const DB_FILE = join(TMP_DIR, 'm5-test.db')
const SAMPLE_COUNT = 25

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

async function main() {
  mkdirSync(TMP_DIR, { recursive: true })
  rmSync(DB_FILE, { force: true })
  const db = openDatabase(DB_FILE)

  const accId = accountsDao.insertAccount(db, {
    provider: 'shanghaitech', label: '上科大邮箱', address: 'demo.user@example.edu.cn',
    host: 'imap.shanghaitech.edu.cn', port: 993, encryption: 'ssl',
    username: 'demo.user@example.edu.cn', secret_enc: 'enc://sample', folder: 'INBOX',
    auth_mode: 'appPassword', last_uidvalidity: 1, last_uid: 2000 + SAMPLE_COUNT,
    last_sync_at: '2026-10-16 12:00:00', sync_error: null
  })

  console.log('== 离线样例数据（25 封）==')
  for (let i = 1; i <= SAMPLE_COUNT; i += 1) {
    const day = String(i).padStart(2, '0')
    emailsDao.upsertEmail(db, {
      account_id: accId,
      folder: 'INBOX',
      uid: 2000 + i,
      message_id: '<sample-' + i + '@example.com>',
      subject: i % 5 === 0 ? '会议邀请 ' + i : '样例邮件 ' + i,
      from_addr: i % 3 === 0 ? 'teacher@example.com' : 'sender' + i + '@example.com',
      to_addr: 'demo.user@example.edu.cn',
      cc: '',
      date_utc: '2026-09-' + day + ' 09:00:00',
      date_raw: 'Tue, ' + i + ' Sep 2026 09:00:00 +0800',
      unread: i % 2 === 0 ? 1 : 0,
      body_text: i === 7 ? '这封邮件的正文里藏着 独一无二的正文关键词。' : '正文 ' + i,
      body_html: '<p>正文 ' + i + '</p>',
      attachments_json:
        i % 4 === 0 ? JSON.stringify([{ filename: 'a.pdf', contentType: 'application/pdf', size: 1024 }]) : '[]',
      size: 200 + i
    })
  }
  const seventh = emailsDao.findByUid(db, accId, 'INBOX', 2007)
  analysisDao.upsertAnalysis(db, {
    email_id: seventh.id, status: 'analyzed', category: '需行动', summary: '需要缴费', action_required: '完成缴费',
    deadline_raw: '2026-10-20', deadline_at: '2026-10-20T00:00:00.000Z', deadline_kind: '截止时间',
    event_start_at: null, applicable_to: '本人', confidence: 0.9, tier: 'review', evidence_json: '[]',
    model: 'sample-model', provider: 'deepseek', error: null, analyzed_at: '2026-10-16 13:00:00'
  })

  console.log('== 列表与分页 ==')
  await run('默认按时间倒序，第一页 20 条、第二页 5 条且不重复', () => {
    const all = emailsDao.searchEmails(db, { accountId: accId, limit: 20, offset: 0 })
    assert.equal(all.total, SAMPLE_COUNT)
    assert.equal(all.rows.length, 20)
    const rest = emailsDao.searchEmails(db, { accountId: accId, limit: 20, offset: 20 })
    assert.equal(rest.rows.length, 5)
    const ids = new Set(all.rows.concat(rest.rows).map((r) => r.id))
    assert.equal(ids.size, SAMPLE_COUNT)
    assert.equal(all.rows[0].subject, '会议邀请 25')
    assert.equal(rest.rows[4].subject, '样例邮件 1')
  })
  await run('limit 上限收敛到 200、offset 负数归零', () => {
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, limit: 9999 }).rows.length, SAMPLE_COUNT)
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, offset: -5 }).rows.length, SAMPLE_COUNT)
  })

  console.log('== 搜索与过滤 ==')
  await run('关键词命中主题 / 发件人 / 正文纯文本', () => {
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, keyword: '会议邀请' }).total, 5)
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, keyword: 'teacher@shanghaitech' }).total, 8)
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, keyword: '独一无二的正文关键词' }).total, 1)
  })
  await run('LIKE 特殊字符被转义（% 不当作通配符）', () => {
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, keyword: '%' }).total, 0)
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, keyword: '_' }).total, 0)
  })
  await run('仅未读过滤 + 账号过滤', () => {
    const unread = emailsDao.searchEmails(db, { accountId: accId, unreadOnly: true, limit: 100 })
    assert.equal(unread.total, 12)
    assert.ok(unread.rows.every((r) => r.unread === 1))
    assert.equal(emailsDao.searchEmails(db, { accountId: 999 }).total, 0)
  })

  console.log('== 详情附加字段 ==')
  await run('getEmailListItem 带账号名与 AI 分析摘要', () => {
    const row = emailsDao.getEmailListItem(db, seventh.id)
    assert.equal(row.account_label, '上科大邮箱')
    assert.equal(row.category, '需行动')
    assert.equal(row.analysis_status, 'analyzed')
    const noAnalysis = emailsDao.getEmailListItem(db, emailsDao.findByUid(db, accId, 'INBOX', 2001).id)
    assert.equal(noAnalysis.category, null)
    assert.equal(noAnalysis.analysis_status, null)
  })

  console.log('== 本地已读标记 ==')
  await run('setEmailUnread 只改本地标记', () => {
    const id = emailsDao.findByUid(db, accId, 'INBOX', 2002).id
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, unreadOnly: true, limit: 100 }).total, 12)
    emailsDao.setEmailUnread(db, id, 0)
    assert.equal(emailsDao.getEmail(db, id).unread, 0)
    assert.equal(emailsDao.searchEmails(db, { accountId: accId, unreadOnly: true, limit: 100 }).total, 11)
  })
  await run('同步不会再把它变回未读（unread 取两者较小值）', () => {
    const id = emailsDao.findByUid(db, accId, 'INBOX', 2002).id
    emailsDao.upsertEmail(db, {
      account_id: accId, folder: 'INBOX', uid: 2002, message_id: '<sample-2@example.com>',
      subject: '样例邮件 2', from_addr: 'sender2@example.com', to_addr: 'demo.user@example.edu.cn',
      cc: '', date_utc: '2026-09-02 09:00:00', date_raw: '', unread: 1,
      body_text: '正文 2', body_html: '<p>正文 2</p>', attachments_json: '[]', size: 202
    })
    assert.equal(emailsDao.getEmail(db, id).unread, 0)
    // 服务器已读(0) 优先于本地未读(1)：MIN 收敛为已读
    emailsDao.setEmailUnread(db, id, 1)
    emailsDao.upsertEmail(db, {
      account_id: accId, folder: 'INBOX', uid: 2002, message_id: '<sample-2@example.com>',
      subject: '样例邮件 2', from_addr: 'sender2@example.com', to_addr: 'demo.user@example.edu.cn',
      cc: '', date_utc: '2026-09-02 09:00:00', date_raw: '', unread: 0,
      body_text: '正文 2', body_html: '<p>正文 2</p>', attachments_json: '[]', size: 202
    })
    assert.equal(emailsDao.getEmail(db, id).unread, 0)
  })

  console.log('== 正文清洗 ==')
  await run('去掉脚本 / 内嵌框架 / 内联事件 / 危险协议，保留正文与图片', () => {
    const dirty = [
      '<div onclick="steal()">正文</div>',
      '<script>alert(1)</script>',
      '<iframe src="https://evil.example"></iframe>',
      '<img src="https://tracker.example/pixel.gif" onerror="alert(2)">',
      '<img src="data:image/png;base64,AAAA">',
      '<a href="javascript:alert(3)">点我</a>',
      '<form action="https://evil.example"><input name="pw"></form>'
    ].join('')
    const clean = sanitizeEmailHtml(dirty)
    assert.ok(!clean.includes('<script'), '应去掉 script')
    assert.ok(!clean.includes('<iframe'), '应去掉 iframe')
    assert.ok(!clean.includes('onclick'), '应去掉 onclick')
    assert.ok(!clean.includes('onerror'), '应去掉 onerror')
    assert.ok(!clean.includes('javascript:'), '应去掉 javascript: 协议')
    assert.ok(!clean.includes('<form'), '应去掉表单')
    assert.ok(clean.includes('https://tracker.example/pixel.gif'), '保留图片地址（加载与否由界面决定）')
    assert.ok(clean.includes('data:image/png;base64,AAAA'), '保留 data:image 图片')
    assert.ok(clean.includes('正文'), '保留正文')
  })
  await run('htmlToText 生成可读纯文本', () => {
    const text = htmlToText('<style>p{color:red}</style><p>第一行</p><div>第二&nbsp;行</div><p>a &amp; b</p>')
    assert.ok(text.includes('第一行'))
    assert.ok(text.includes('第二 行'))
    assert.ok(text.includes('a & b'))
    assert.ok(!text.includes('color:red'))
    assert.ok(text.split('\n').length >= 3)
  })
  await run('空输入安全返回空串', () => {
    assert.equal(sanitizeEmailHtml(''), '')
    assert.equal(htmlToText(''), '')
  })

  db.close()
  console.log('')
  console.log('M5 测试：通过 ' + passed + ' 项，失败 ' + failed + ' 项')
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
