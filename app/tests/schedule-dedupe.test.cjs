'use strict'
// Focused schedule creation regressions. Compile with tsconfig.test.json, then node --test this file.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openDatabase } = require('../.test-out/main/db/database.js')
const accounts = require('../.test-out/main/db/dao/accountsDao.js')
const emails = require('../.test-out/main/db/dao/emailsDao.js')
const analysis = require('../.test-out/main/db/dao/emailAnalysisDao.js')
const info = require('../.test-out/main/db/dao/infoDao.js')
const reminders = require('../.test-out/main/db/dao/remindersDao.js')
const items = require('../.test-out/main/services/items/service.js')
const todo = require('../.test-out/main/services/todo/service.js')
const { findDuplicateSchedule } = require('../.test-out/main/services/items/schedule-dedupe.js')

const START = '2026-10-20T01:00:00.000Z'
const END = '2026-10-20T02:00:00.000Z'
const TOMORROW = '2026-10-21T01:00:00.000Z'
const REMINDER = '2026-10-20T00:30:00.000Z'

function fixture(t) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const accountId = accounts.insertAccount(db, {
    provider: 'qq', label: 'Test', address: 'me@test.local', host: 'imap.test.local', port: 993,
    encryption: 'ssl', username: 'me@test.local', secret_enc: 'test', folder: 'INBOX',
    auth_mode: 'appPassword', last_uidvalidity: null, last_uid: null, last_sync_at: null, sync_error: null
  })
  let uid = 0
  function email(over = {}, analyzed = null) {
    uid += 1
    const id = emails.upsertEmail(db, {
      account_id: accountId, folder: 'INBOX', uid, message_id: `<${uid}@test.local>`,
      subject: `Event ${uid}`, from_addr: 'sender@test.local', to_addr: 'me@test.local', cc: '',
      date_utc: '2026-10-17T02:00:00.000Z', date_raw: null, unread: 0,
      body_text: `Complete original body ${uid}`, body_html: '', attachments_json: '[]', size: 0,
      ...over
    })
    info.createInfo(db, { source_type: 'email', source_email_id: id, title: over.subject || `Event ${uid}`, content: 'Shared AI summary' })
    if (analyzed) {
      analysis.upsertAnalysis(db, {
        email_id: id, status: 'analyzed', category: '需行动', summary: 'Shared AI summary',
        action_required: null, deadline_raw: null, deadline_at: null, deadline_kind: null,
        event_start_at: null, applicable_to: null, confidence: 0.9, tier: null,
        evidence_json: '[]', model: 'test', provider: 'test', error: null, analyzed_at: START,
        ...analyzed
      })
    }
    return id
  }
  return { db, email }
}

function item(db, id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id)
}
function allReminders(db) {
  return db.prepare('SELECT * FROM reminders ORDER BY id').all()
}
function count(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM items').get().count
}
function assertReused(result, id) {
  assert.equal(result.ok, true, result.message)
  assert.equal(result.id, id)
  assert.equal(result.reused, true)
  assert.match(result.message, /已存在|复用/)
}

test('manual schedule: normalized Unicode/whitespace + timezone-equivalent start/end reuses without touching row/reminders', (t) => {
  const { db } = fixture(t)
  const first = items.createManualItem(db, {
    title: ' Café　Ａ  周会 ', notes: 'original notes', eventStartAt: START, eventEndAt: END,
    deadlineAt: START, remindAt: REMINDER
  })
  assert.equal(first.ok, true, first.message)
  const historical = reminders.createReminder(db, { item_id: first.id, remind_at: '2026-10-19T00:00:00.000Z' })
  reminders.markFired(db, historical)
  const rowBefore = item(db, first.id)
  const remindersBefore = allReminders(db)
  const again = items.createManualItem(db, {
    title: '\tCafe\u0301 A\n周会\u200B ', notes: 'must not overwrite', eventStartAt: '2026-10-20T09:00:00+08:00',
    eventEndAt: '2026-10-20T10:00:00+08:00', deadlineAt: TOMORROW, remindAt: '2026-10-19T23:00:00Z'
  }, 5)
  assertReused(again, first.id)
  assert.equal(count(db), 1)
  assert.deepEqual(item(db, first.id), rowBefore)
  assert.deepEqual(allReminders(db), remindersBefore)
})

test('same title but different date, end time, or all-day mode stays distinct; ordinary manual todos are not deduped', (t) => {
  const { db } = fixture(t)
  const first = items.createManualItem(db, { title: 'Weekly event', eventStartAt: START, eventEndAt: END })
  const nextDate = items.createManualItem(db, { title: 'Weekly event', eventStartAt: TOMORROW, eventEndAt: '2026-10-21T02:00:00Z' })
  const nextEnd = items.createManualItem(db, { title: 'Weekly event', eventStartAt: START, eventEndAt: '2026-10-20T03:00:00Z' })
  const allDay = items.createManualItem(db, { title: 'Weekly event', eventStartAt: START, eventEndAt: END, allDay: true })
  const noEnd = items.createManualItem(db, { title: 'Weekly event', eventStartAt: START })
  const todoA = items.createManualItem(db, { title: 'Weekly event' })
  const todoB = items.createManualItem(db, { title: 'Weekly event' })
  assert.equal(new Set([first.id, nextDate.id, nextEnd.id, allDay.id, noEnd.id, todoA.id, todoB.id]).size, 7)
})

test('different email IDs with identical complete normalized originals reuse despite shifted fallback day and route both info entries', (t) => {
  const { db, email } = fixture(t)
  const firstEmail = email({ subject: 'Ｃafé　大会', body_text: '完整原文\n欢迎参加\t大会' }, { action_required: '报名', event_start_at: START })
  const secondEmail = email({ subject: 'Cafe\u0301 大会', body_text: '完整原文 欢迎参加 大会' }, { action_required: '参会', event_start_at: TOMORROW })
  const first = items.createItemFromEmail(db, { sourceEmailId: firstEmail, remindAt: REMINDER })
  const rowBefore = item(db, first.id)
  const remindersBefore = allReminders(db)
  const again = items.createItemFromEmail(db, { sourceEmailId: secondEmail, remindAt: '2026-10-19T10:00:00Z' }, 60)
  assertReused(again, first.id)
  assert.equal(count(db), 1)
  assert.deepEqual(item(db, first.id), rowBefore)
  assert.deepEqual(allReminders(db), remindersBefore)
  for (const id of [firstEmail, secondEmail]) {
    const routed = info.getInfoByEmail(db, id)
    assert.equal(routed.destination, 'item')
    assert.equal(routed.status, 'routed')
    assert.equal(routed.item_id, first.id)
  }
  // Panel can look up complete original content before it picks a new fallback day.
  assert.equal(findDuplicateSchedule(db, { title: 'another action', sourceEmailId: secondEmail }).id, first.id)
})

test('generic action_required titles never merge distinct original subjects, long body suffixes, or attachment metadata', (t) => {
  const { db, email } = fixture(t)
  const prefix = '共同内容'.repeat(500)
  const sourceIds = [
    email({ subject: '报名 A', body_text: prefix + '活动 A' }, { action_required: '报名', event_start_at: START }),
    email({ subject: '报名 B', body_text: prefix + '活动 A' }, { action_required: '报名', event_start_at: START }),
    email({ subject: '报名 A', body_text: prefix + '活动 B' }, { action_required: '报名', event_start_at: START }),
    email({ subject: '报名 A', body_text: prefix + '活动 A', attachments_json: '[{"filename":"A.pdf","contentType":"application/pdf","size":12}]' }, { action_required: '报名', event_start_at: START })
  ]
  const results = sourceIds.map((sourceEmailId) => items.createItemFromEmail(db, { sourceEmailId }))
  assert.ok(results.every((result) => result.ok && !result.reused))
  assert.equal(new Set(results.map((result) => result.id)).size, 4)
  assert.equal(count(db), 4)
})

test('HTML-only originals retain different event links instead of collapsing to generic visible text', (t) => {
  const { db, email } = fixture(t)
  const sourceA = email({ subject: 'HTML event', body_text: '', body_html: '<p>报名 <a href="https://example.test/a">点击这里</a></p>' })
  const sourceB = email({ subject: 'HTML event', body_text: '', body_html: '<p>报名 <a href="https://example.test/b">点击这里</a></p>' })
  const sourceCopy = email({ subject: 'HTML event', body_text: '', body_html: '<p>报名\n<a href="https://example.test/a">点击这里</a></p>' })
  const first = items.createItemFromEmail(db, { sourceEmailId: sourceA, title: '报名', eventStartAt: START })
  const different = items.createItemFromEmail(db, { sourceEmailId: sourceB, title: '报名', eventStartAt: START })
  assert.notEqual(different.id, first.id)
  assertReused(items.createItemFromEmail(db, { sourceEmailId: sourceCopy, title: '报名', eventStartAt: TOMORROW }), first.id)
})

test('same short email body with different generic subjects is not treated as shared event content', (t) => {
  const { db, email } = fixture(t)
  const first = email({ subject: '大会 A', body_text: '请参会' }, { action_required: '参会', event_start_at: START })
  const second = email({ subject: '大会 B', body_text: '请参会' }, { action_required: '参会', event_start_at: START })
  assert.notEqual(items.createItemFromEmail(db, { sourceEmailId: first }).id, items.createItemFromEmail(db, { sourceEmailId: second }).id)
})

test('meaningful email titles + equal instants reuse across distinct originals and manual/email paths', (t) => {
  const { db, email } = fixture(t)
  const firstEmail = email({ subject: '周会' })
  const secondEmail = email({ subject: '周会', body_text: '另一个邮件原文' })
  const first = items.createItemFromEmail(db, { sourceEmailId: firstEmail, eventStartAt: START, eventEndAt: END, remindAt: REMINDER })
  const before = allReminders(db)
  assertReused(items.createItemFromEmail(db, {
    sourceEmailId: secondEmail, eventStartAt: '2026-10-20T09:00:00+08:00', eventEndAt: '2026-10-20T10:00:00+08:00', remindAt: '2026-10-18T00:00:00Z'
  }), first.id)
  assertReused(items.createManualItem(db, { title: '周会', eventStartAt: START, eventEndAt: END, remindAt: '2026-10-17T10:00:00Z' }), first.id)
  assert.deepEqual(allReminders(db), before)
  assert.equal(info.getInfoByEmail(db, secondEmail).item_id, first.id)

  const manual = items.createManualItem(db, { title: 'Reverse direction', eventStartAt: START, eventEndAt: END })
  const emailAfterManual = email({ subject: 'Reverse direction' })
  assertReused(items.createItemFromEmail(db, { sourceEmailId: emailAfterManual, eventStartAt: START, eventEndAt: END }), manual.id)
  assert.equal(info.getInfoByEmail(db, emailAfterManual).item_id, manual.id)
})

test('same title from distinct emails on different dates remains separate', (t) => {
  const { db, email } = fixture(t)
  const sourceA = email({ subject: '每周读书会', body_text: '第一期' })
  const sourceB = email({ subject: '每周读书会', body_text: '第二期' })
  const first = items.createItemFromEmail(db, { sourceEmailId: sourceA, eventStartAt: START })
  const second = items.createItemFromEmail(db, { sourceEmailId: sourceB, eventStartAt: TOMORROW })
  assert.notEqual(first.id, second.id)
  assert.equal(second.reused, undefined)
})

test('same-source schedule reuse ignores changed fallback/title and does not reset pending or failed reminders', (t) => {
  const { db, email } = fixture(t)
  const source = email({ subject: '原始活动' })
  const first = items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: START, remindAt: REMINDER })
  const failedId = reminders.createReminder(db, { item_id: first.id, remind_at: '2026-10-18T00:00:00Z' })
  reminders.markFired(db, failedId, 'keep failure history')
  const before = allReminders(db)
  assertReused(items.createItemFromEmail(db, {
    sourceEmailId: source, title: 'changed extraction', eventOnly: true, eventStartAt: TOMORROW, remindAt: '2026-10-17T10:00:00Z'
  }), first.id)
  assert.equal(item(db, first.id).event_start_at, START)
  assert.deepEqual(allReminders(db), before)
})

test('previously routed duplicate email remains an identity even after its stored body changes', (t) => {
  const { db, email } = fixture(t)
  const sourceA = email({ subject: 'Shared', body_text: 'Full content' })
  const sourceB = email({ subject: 'Shared', body_text: 'Full content' })
  const first = items.createItemFromEmail(db, { sourceEmailId: sourceA, eventStartAt: START })
  assertReused(items.createItemFromEmail(db, { sourceEmailId: sourceB, eventStartAt: TOMORROW }), first.id)
  db.prepare('UPDATE emails SET subject = ?, body_text = ? WHERE id = ?').run('Edited title', 'Edited body', sourceB)
  assertReused(items.createItemFromEmail(db, { sourceEmailId: sourceB, eventOnly: true, eventStartAt: TOMORROW }), first.id)
  assert.equal(count(db), 1)
})

test('non-event same-email todo still returns old false behavior; event input may create and then reuse a schedule', (t) => {
  const { db, email } = fixture(t)
  const source = email()
  const todoItem = items.createItemFromEmail(db, { sourceEmailId: source })
  const rejected = items.createItemFromEmail(db, { sourceEmailId: source })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /已确认为事项/)
  const scheduled = items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: START, eventOnly: true })
  assert.equal(scheduled.ok, true)
  assert.notEqual(scheduled.id, todoItem.id)
  assertReused(items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: START }), scheduled.id)
  assert.equal(info.getInfoByEmail(db, source).item_id, scheduled.id)
})

test('cancelled email event can be recreated, repairs old routed info, and keeps cancelled reminders intact', (t) => {
  const { db, email } = fixture(t)
  const source = email()
  const first = items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: START, remindAt: REMINDER })
  assert.equal(items.setItemStatus(db, first.id, '已取消').ok, true)
  const oldReminders = allReminders(db)
  const next = items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: START, remindAt: REMINDER })
  assert.equal(next.ok, true)
  assert.equal(next.reused, undefined)
  assert.notEqual(next.id, first.id)
  assert.equal(info.getInfoByEmail(db, source).item_id, next.id)
  assert.deepEqual(allReminders(db).filter((row) => row.item_id === first.id), oldReminders)
  assert.equal(allReminders(db).filter((row) => row.item_id === next.id && row.status === 'pending').length, 1)
  assertReused(items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: TOMORROW }), next.id)
})

test('cancelled manual schedules can be recreated; completed schedules are still reusable', (t) => {
  const { db } = fixture(t)
  const input = { title: 'Manual state', eventStartAt: START, eventEndAt: END, remindAt: REMINDER }
  const first = items.createManualItem(db, input)
  items.setItemStatus(db, first.id, '已取消')
  const second = items.createManualItem(db, input)
  assert.notEqual(second.id, first.id)
  assert.equal(second.reused, undefined)
  items.setItemStatus(db, second.id, '已完成')
  const before = allReminders(db)
  assertReused(items.createManualItem(db, input), second.id)
  assert.deepEqual(allReminders(db), before)
})

test('todo direct schedule creation uses common dedupe and preserves existing list/priority/notes/reminders', (t) => {
  const { db } = fixture(t)
  const list = todo.createTodoList(db, '课程').list
  const first = todo.createTodoItem(db, { title: '课程 Ａ', eventStartAt: START, eventEndAt: END, listId: list.id, priority: 3, notes: 'original' })
  const reminderId = reminders.createReminder(db, { item_id: first.item.id, remind_at: REMINDER })
  const before = allReminders(db)
  const rowBefore = item(db, first.item.id)
  const second = todo.createTodoItem(db, { title: '课程 A', eventStartAt: '2026-10-20T09:00:00+08:00', eventEndAt: '2026-10-20T10:00:00+08:00', priority: 0, notes: 'must not replace' })
  assert.equal(second.ok, true)
  assert.equal(second.item.id, first.item.id)
  assert.deepEqual(item(db, first.item.id), rowBefore)
  assert.deepEqual(allReminders(db), before)
  assert.equal(reminders.getReminder(db, reminderId).status, 'pending')
  assertReused(items.createManualItem(db, { title: '课程 A', eventStartAt: START, eventEndAt: END, remindAt: REMINDER }), first.item.id)
  const changedDate = todo.createTodoItem(db, { title: '课程 A', eventStartAt: TOMORROW })
  assert.notEqual(changedDate.item.id, first.item.id)
})

test('manual/email schedule then todo creation cannot bypass dedupe or recreate reminders', (t) => {
  const { db, email } = fixture(t)
  const first = items.createManualItem(db, { title: 'Todo cross-path', eventStartAt: START, remindAt: REMINDER })
  const source = email({ subject: 'Todo cross-path' })
  const before = allReminders(db)
  const result = todo.createTodoItem(db, { title: 'Todo cross-path', eventStartAt: START, sourceEmailId: source })
  assert.equal(result.item.id, first.id)
  assert.equal(info.getInfoByEmail(db, source).item_id, first.id)
  assert.deepEqual(allReminders(db), before)

  const duplicateSource = email({ subject: 'Todo cross-path' })
  // Distinct content is still a match by meaningful title + instant.
  const next = items.createItemFromEmail(db, { sourceEmailId: duplicateSource, eventStartAt: START, remindAt: '2026-10-18T00:00:00Z' })
  assertReused(next, first.id)
  assert.deepEqual(allReminders(db), before)
})

test('todo email originals dedupe across fallback days, but generic distinct emails and cancelled events remain separate', (t) => {
  const { db, email } = fixture(t)
  const sourceA = email({ subject: 'Activity', body_text: 'Full original' })
  const sourceB = email({ subject: 'Activity', body_text: 'Full original' })
  const sourceC = email({ subject: 'Different activity', body_text: 'Other original' })
  const first = todo.createTodoItem(db, { title: '报名', sourceEmailId: sourceA, eventStartAt: START })
  const second = todo.createTodoItem(db, { title: '参会', sourceEmailId: sourceB, eventStartAt: TOMORROW })
  assert.equal(second.item.id, first.item.id)
  assert.equal(info.getInfoByEmail(db, sourceB).item_id, first.item.id)
  const third = todo.createTodoItem(db, { title: '报名', sourceEmailId: sourceC, eventStartAt: START })
  assert.notEqual(third.item.id, first.item.id)
  items.setItemStatus(db, first.item.id, '已取消')
  const recreated = todo.createTodoItem(db, { title: '报名', sourceEmailId: sourceB, eventStartAt: START })
  assert.notEqual(recreated.item.id, first.item.id)
  assert.equal(info.getInfoByEmail(db, sourceB).item_id, recreated.item.id)
})

test('information routing propagates schedule reuse and never rewrites the existing pending reminder', (t) => {
  const { db, email } = fixture(t)
  const sourceA = email({ subject: 'Routing event', body_text: 'Entire original' }, { event_start_at: START })
  const sourceB = email({ subject: 'Routing event', body_text: 'Entire original' }, { event_start_at: TOMORROW })
  const first = items.createItemFromEmail(db, { sourceEmailId: sourceA, remindAt: REMINDER })
  const before = allReminders(db)
  const result = items.routeInfoEntry(db, info.getInfoByEmail(db, sourceB).id, 'item', '2026-10-18T01:00:00Z')
  assertReused(result, first.id)
  assert.equal(info.getInfoByEmail(db, sourceB).item_id, first.id)
  assert.equal(count(db), 1)
  assert.deepEqual(allReminders(db), before)
})

test('read-only helper ignores unscheduled todos and cancelled events and does not route info or mutate reminders', (t) => {
  const { db, email } = fixture(t)
  const source = email({ subject: 'Read-only content' })
  const sourceCopy = email({ subject: 'Read-only content', body_text: 'Complete original body 1' })
  const unscheduled = items.createItemFromEmail(db, { sourceEmailId: source })
  assert.equal(findDuplicateSchedule(db, { title: 'Read-only content', sourceEmailId: source }), undefined)
  const schedule = items.createItemFromEmail(db, { sourceEmailId: source, eventStartAt: START, remindAt: REMINDER })
  assert.notEqual(schedule.id, unscheduled.id)
  const before = allReminders(db)
  assert.equal(findDuplicateSchedule(db, { title: 'ignored title', sourceEmailId: sourceCopy }).id, schedule.id)
  assert.equal(info.getInfoByEmail(db, sourceCopy).destination, 'unverified')
  assert.deepEqual(allReminders(db), before)
  items.setItemStatus(db, schedule.id, '已取消')
  assert.equal(findDuplicateSchedule(db, { title: 'Read-only content', sourceEmailId: sourceCopy, eventStartAt: START }), undefined)
})
