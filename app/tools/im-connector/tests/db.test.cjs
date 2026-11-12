const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const dao = require('../dist/main/db/dao/imDao.js')
const schema = require('../dist/main/db/imSchema.js')

function makeDb() {
  const db = new DatabaseSync(':memory:')
  dao.applyImMigrations(db)
  return db
}

function seed(db, options = {}) {
  const accountId = dao.upsertAccount(db, {
    platform: 'qq',
    accountKey: 'qq-export',
    displayName: 'QQ 导出',
    adapter: 'qq-export',
    dataRoot: 'D:/demo'
  })
  const sessionId = dao.upsertSession(db, accountId, {
    platformSessionId: 'qq-abc',
    title: '产品讨论群',
    kind: 'group',
    memberCount: 8,
    lastMessageAt: '2026-10-16 09:04:00',
    enable: options.enable ?? true
  })
  return { accountId, sessionId }
}

function messages() {
  return [
    { platformMsgId: 'm1', seq: 1, sentAt: '2026-10-16 09:02:11', senderName: '张三', kind: 'text', text: '今天把聊天记录接入的方案定一下' },
    { platformMsgId: 'm2', seq: 2, sentAt: '2026-10-16 09:03:02', senderName: '李四', kind: 'text', text: '先做 QQ 导出导入，风险最低' },
    { platformMsgId: 'm3', seq: 3, sentAt: '2026-10-16 09:04:00', senderName: '王五', kind: 'image', text: '[图片]' }
  ]
}

test('迁移可重复执行且版本号稳定', () => {
  const db = makeDb()
  const first = dao.applyImMigrations(db)
  const second = dao.applyImMigrations(db)
  assert.ok(first >= 16)
  assert.equal(second, first)
  assert.equal(schema.latestImSchemaVersion(), first)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'im_%' ORDER BY name")
    .all()
    .map((row) => row.name)
  assert.deepEqual(tables, ['im_account', 'im_insight', 'im_message', 'im_meta', 'im_session', 'im_window'])
  db.close()
})

test('账号 upsert 幂等且保留原有字段', () => {
  const db = makeDb()
  const first = dao.upsertAccount(db, {
    platform: 'qq',
    accountKey: 'qq-export',
    displayName: 'QQ 导出',
    adapter: 'qq-export',
    dataRoot: 'D:/demo'
  })
  const second = dao.upsertAccount(db, { platform: 'qq', accountKey: 'qq-export', displayName: 'QQ 导出（改名）' })
  assert.equal(first, second)
  const accounts = dao.listAccounts(db)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].displayName, 'QQ 导出（改名）')
  assert.equal(accounts[0].platform, 'qq')
  assert.equal(accounts[0].state, 'idle')
  db.close()
})

test('会话 upsert：enable 只在新建时生效', () => {
  const db = makeDb()
  const { accountId, sessionId } = seed(db, { enable: false })
  const again = dao.upsertSession(db, accountId, {
    platformSessionId: 'qq-abc',
    title: '产品讨论群（改名）',
    kind: 'group',
    enable: true
  })
  assert.equal(again, sessionId)

  const session = dao.getSession(db, sessionId)
  assert.equal(session.title, '产品讨论群（改名）')
  assert.equal(session.enabled, false)
  assert.equal(session.kind, 'group')
  assert.equal(session.memberCount, 8)

  dao.setSessionEnabled(db, sessionId, true)
  assert.equal(dao.getSession(db, sessionId).enabled, true)
  assert.equal(dao.findSessionsByTitle(db, '产品').length, 1)
  db.close()
})

test('批量写入消息、幂等与游标统计', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  const stat = dao.bulkUpsertMessages(db, sessionId, messages())
  assert.equal(stat.inserted, 3)
  assert.equal(stat.lastSeq, 3)
  assert.equal(stat.lastSentAt, '2026-10-16 09:04:00')

  const again = dao.bulkUpsertMessages(db, sessionId, messages())
  assert.equal(again.inserted, 0)
  assert.equal(dao.countMessages(db, sessionId), 3)

  const changed = dao.bulkUpsertMessages(db, sessionId, [
    { platformMsgId: 'm1', seq: 1, sentAt: '2026-10-16 09:02:11', kind: 'text', text: '改过的内容' }
  ])
  assert.equal(changed.inserted, 0)
  assert.equal(dao.listMessages(db, sessionId, { limit: 10 }).items[0].text, '改过的内容')
  db.close()
})

test('分页读取消息', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  dao.bulkUpsertMessages(db, sessionId, messages())

  // 默认返回最新一页，但按时间正序给前端
  const page = dao.listMessages(db, sessionId, { limit: 2 })
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 2)
  assert.equal(page.items[0].platformMsgId, 'm2')
  assert.equal(page.items[1].platformMsgId, 'm3')

  const older = dao.listMessages(db, sessionId, { beforeSeq: 2, limit: 10 })
  assert.equal(older.items.length, 1)
  assert.equal(older.items[0].platformMsgId, 'm1')

  const after = dao.listMessagesAfterSeq(db, sessionId, 1, 10)
  assert.deepEqual(
    after.map((item) => item.seq),
    [2, 3]
  )

  const byIds = dao.getMessagesByIds(db, [1, 3])
  assert.equal(byIds.length, 2)
  db.close()
})

test('中文子串走 FTS5 trigram，短查询退化为 LIKE', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  assert.equal(dao.ensureImFts(db), true)
  assert.equal(dao.hasImFts(db), true)
  dao.bulkUpsertMessages(db, sessionId, messages())

  const result = dao.searchMessages(db, '聊天记录')
  assert.equal(result.mode, 'fts')
  assert.equal(result.total, 1)
  assert.match(result.items[0].text, /聊天记录/)

  const scoped = dao.searchMessages(db, '导出', { sessionId, limit: 5 })
  assert.ok(scoped.total >= 1)

  const short = dao.searchMessages(db, '聊天')
  assert.equal(short.mode, 'like')
  assert.ok(short.total >= 1)

  assert.deepEqual(dao.searchMessages(db, '   '), { items: [], total: 0, mode: 'like' })
  db.close()
})

test('FTS 索引可回填历史消息', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  dao.bulkUpsertMessages(db, sessionId, [
    { platformMsgId: 'a1', seq: 1, sentAt: '2026-10-16 09:00:00', kind: 'text', text: '回填索引验证明细' }
  ])
  assert.equal(dao.hasImFts(db), false)
  assert.equal(dao.ensureImFts(db), true)
  assert.equal(dao.searchMessages(db, '回填索引').total, 1)
  db.close()
})

test('删除消息会同步移出检索结果', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  dao.ensureImFts(db)
  dao.bulkUpsertMessages(db, sessionId, messages())
  assert.equal(dao.searchMessages(db, '聊天记录').total, 1)

  dao.bulkUpsertMessages(db, sessionId, [
    { platformMsgId: 'm1', seq: 1, sentAt: '2026-10-16 09:02:11', kind: 'system', text: '', deleted: true }
  ])
  assert.equal(dao.searchMessages(db, '聊天记录').total, 0)
  db.close()
})

test('结论写入、过滤与状态流转', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  dao.bulkUpsertMessages(db, sessionId, messages())

  const windowInput = { startMsgId: 1, endMsgId: 3, startSeq: 1, endSeq: 3, msgCount: 3, statDate: '2026-10-16' }
  const windowId = dao.getOrCreateWindow(db, sessionId, windowInput)
  assert.ok(windowId > 0)
  assert.equal(dao.getOrCreateWindow(db, sessionId, windowInput), windowId)

  const todoId = dao.insertInsight(db, sessionId, windowId, {
    kind: 'todo',
    title: '本周五前给出第一版 demo',
    detail: '李四跟进',
    dueAt: '2026-10-17',
    assignee: '李四',
    evidence: [1, 2]
  })
  dao.insertInsight(db, sessionId, windowId, { kind: 'decision', title: '先做 QQ 导出导入' })
  assert.ok(todoId > 0)
  assert.equal(dao.countInsights(db, windowId), 2)
  assert.equal(dao.listInsights(db, { kind: 'todo' }).length, 1)
  assert.equal(dao.listInsights(db, { day: '2026-10-16' }).length, 2)
  assert.equal(dao.listInsightsByDay(db, '2026-10-16').length, 2)

  const todo = dao.listInsights(db, { kind: 'todo' })[0]
  assert.equal(todo.sessionTitle, '产品讨论群')
  assert.equal(todo.assignee, '李四')
  assert.deepEqual(todo.evidence, [1, 2])

  dao.updateInsightStatus(db, todo.id, 'accepted')
  assert.equal(dao.listInsights(db, { status: 'accepted' }).length, 1)
  assert.equal(dao.listInsights(db, { status: 'new' }).length, 1)

  dao.deleteInsightsForWindow(db, windowId)
  assert.equal(dao.countInsights(db, windowId), 0)
  db.close()
})

test('窗口列表按会话过滤', () => {
  const db = makeDb()
  const { sessionId } = seed(db)
  dao.getOrCreateWindow(db, sessionId, { startMsgId: 1, endMsgId: 3, startSeq: 1, endSeq: 3, msgCount: 3, statDate: '2026-10-16' })
  dao.getOrCreateWindow(db, sessionId, { startMsgId: 4, endMsgId: 6, startSeq: 4, endSeq: 6, msgCount: 3, statDate: '2026-10-17' })
  assert.equal(dao.listWindows(db, sessionId).length, 2)
  assert.ok(dao.listWindows(db).length >= 2)
  db.close()
})

test('元信息读写', () => {
  const db = makeDb()
  assert.equal(dao.getMeta(db, 'fts'), null)
  dao.setMeta(db, 'fts', '1')
  assert.equal(dao.getMeta(db, 'fts'), '1')
  dao.setMeta(db, 'fts', '0')
  assert.equal(dao.getMeta(db, 'fts'), '0')
  db.close()
})
