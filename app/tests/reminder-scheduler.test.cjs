'use strict'

// Run directly: node --test tests/reminder-scheduler.test.cjs
// No Electron process, real notifications, database, timers or emitted JS files.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const filename = join(__dirname, '../src/main/services/reminders/scheduler.ts')
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  fileName: filename,
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
})
assert.deepEqual((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), [])

function harness(options = {}) {
  const db = Object.freeze({ name: 'mock database' })
  const due = options.due || [{ id: 1, item_id: 101 }]
  const notifications = []
  const writes = []
  const scans = []
  const errors = []
  const intervals = new Map()
  const timeouts = new Map()
  const cleared = []
  let nextTimer = 0
  class MockNotification extends EventEmitter {
    static isSupported() { return options.supported !== false }
    constructor(notificationOptions) {
      super()
      this.options = notificationOptions
      this.showCalls = 0
      notifications.push(this)
    }
    close() { this.closed = true }
    show() {
      this.showCalls += 1
      if (options.show) options.show(this, notifications.length)
    }
  }
  const dao = {
    listPending(actualDb, now) {
      assert.equal(actualDb, db)
      assert.equal(new Date(now).toISOString(), now)
      scans.push(now)
      if (options.listPending) return options.listPending()
      return due
    },
    getItem(actualDb, itemId) {
      assert.equal(actualDb, db)
      if (options.getItem) return options.getItem(itemId)
      return { title: `Item ${itemId}` }
    },
    // Observe the real DAO boundary, not an invented persistence implementation.
    // An error argument must NOT be interpreted as a successful/fired write.
    // Real SQLite DAO outcome tests below cover the persisted status contract.
    markFired(actualDb, id, error = null) {
      assert.equal(actualDb, db)
      if (options.markFired) options.markFired(id, error)
      writes.push({ id, error })
    }
  }
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports, Error,
    require(id) {
      if (id === 'electron') return { Notification: MockNotification }
      if (id === '../../db') return dao
      throw new Error(`Unexpected dependency: ${id}`)
    },
    console: { error: (...args) => errors.push(args) },
    setInterval(callback, delay) {
      const timer = { id: ++nextTimer }
      intervals.set(timer, { callback, delay })
      return timer
    },
    setTimeout(callback, delay) {
      const timer = { id: ++nextTimer }
      timeouts.set(timer, { callback, delay })
      return timer
    },
    clearTimeout(timer) { timeouts.delete(timer) },
    clearInterval(timer) {
      cleared.push(timer)
      intervals.delete(timer)
    }
  })
  new vm.Script(compiled.outputText, { filename }).runInContext(context)
  const scheduler = new module.exports.ReminderScheduler(db, () => ({
    reminderEnabled: options.reminderEnabled !== false
  }))
  return { scheduler, notifications, writes, scans, errors, intervals, timeouts, cleared }
}

test('disabled reminder switch skips scanning and delivery entirely', async () => {
  const h = harness({ reminderEnabled: false })
  await h.scheduler.tick()
  assert.equal(h.scans.length, 0)
  assert.equal(h.notifications.length, 0)
  assert.deepEqual(h.writes, [])
})

test('unsupported notifications record an error, never a successful null outcome', async () => {
  const h = harness({ supported: false })
  await h.scheduler.tick()
  assert.deepEqual(h.writes, [{ id: 1, error: '系统不支持桌面通知' }])
  assert.equal(h.writes.some(write => write.error === null), false)
  assert.equal(h.notifications.length, 0)
})

test('calling show alone is not success: only the show event records success', async () => {
  const h = harness()
  await h.scheduler.tick()
  assert.equal(h.notifications.length, 1)
  const notification = h.notifications[0]
  assert.equal(notification.showCalls, 1)
  assert.equal(notification.options.title, 'InfoAgent 提醒')
  assert.equal(notification.options.body, 'Item 101')
  assert.deepEqual(h.writes, [])
  notification.emit('show')
  assert.deepEqual(h.writes, [{ id: 1, error: null }])
})

test('failed event records the platform error without a success outcome', async () => {
  const h = harness()
  await h.scheduler.tick()
  h.notifications[0].emit('failed', {}, 'permission denied')
  assert.deepEqual(h.writes, [{ id: 1, error: '通知发送失败：permission denied' }])
})

test('show throwing Error records the error', async () => {
  const h = harness({ show() { throw new Error('show crashed') } })
  await h.scheduler.tick()
  assert.deepEqual(h.writes, [{ id: 1, error: 'show crashed' }])
})

test('show throwing a non-Error value records its string form', async () => {
  const h = harness({ show() { throw 'native rejection' } })
  await h.scheduler.tick()
  assert.deepEqual(h.writes, [{ id: 1, error: 'native rejection' }])
})

test('one reminder failing does not block the next reminder', async () => {
  const h = harness({
    due: [{ id: 1, item_id: 101 }, { id: 2, item_id: 102 }],
    show(notification, index) {
      if (index === 1) throw new Error('first notification failed')
      notification.emit('show')
    }
  })
  await h.scheduler.tick()
  assert.equal(h.notifications.length, 2)
  assert.deepEqual(h.writes, [
    { id: 1, error: 'first notification failed' }, { id: 2, error: null }
  ])
})

test('item lookup failure is isolated from subsequent reminders', async () => {
  const h = harness({
    due: [{ id: 1, item_id: 101 }, { id: 2, item_id: 102 }],
    getItem(id) {
      if (id === 101) throw new Error('lookup failed')
      return { title: 'Second item' }
    },
    show(notification) { notification.emit('show') }
  })
  await h.scheduler.tick()
  assert.deepEqual(h.writes, [{ id: 1, error: 'lookup failed' }, { id: 2, error: null }])
  assert.equal(h.notifications[0].options.body, 'Second item')
})

test('notification settles only once when show or failed events repeat', async () => {
  for (const first of ['show', 'failed']) {
    const h = harness()
    await h.scheduler.tick()
    const notification = h.notifications[0]
    notification.emit(first, {}, 'first error')
    notification.emit('show')
    notification.emit('failed', {}, 'late error')
    assert.deepEqual(h.writes, [{ id: 1, error: first === 'show' ? null : '通知发送失败：first error' }])
  }
})

test('missing item uses the reminder fallback body', async () => {
  const h = harness({ getItem() { return undefined } })
  await h.scheduler.tick()
  assert.equal(h.notifications[0].options.body, '你有一条到期待办提醒')
})

test('start scans immediately and once per minute; stop clears timer and can restart', () => {
  const h = harness({ due: [] })
  h.scheduler.start()
  assert.equal(h.scans.length, 1)
  assert.equal(h.intervals.size, 1)
  const [timer, interval] = [...h.intervals.entries()][0]
  assert.equal(interval.delay, 60_000)
  h.scheduler.start()
  assert.equal(h.scans.length, 1)
  assert.equal(h.intervals.size, 1)
  interval.callback()
  assert.equal(h.scans.length, 2)
  h.scheduler.stop()
  assert.deepEqual(h.cleared, [timer])
  assert.equal(h.intervals.size, 0)
  h.scheduler.stop()
  assert.equal(h.cleared.length, 1)
  h.scheduler.start()
  assert.equal(h.scans.length, 3)
  assert.equal(h.intervals.size, 1)
  h.scheduler.stop()
  assert.equal(h.cleared.length, 2)
  assert.equal(h.intervals.size, 0)
})

test('pending notifications are retained and deduplicated across scans', async () => {
  const h = harness()
  await h.scheduler.tick()
  await h.scheduler.tick()
  assert.equal(h.notifications.length, 1)
  assert.equal(h.timeouts.size, 1)
  assert.deepEqual(h.writes, [])
  h.notifications[0].emit('show')
  assert.equal(h.timeouts.size, 0)
})

test('delivery timeout records failure and removes event listeners', async () => {
  const h = harness()
  await h.scheduler.tick()
  const timeout = [...h.timeouts.values()][0]
  assert.equal(timeout.delay, 30_000)
  timeout.callback()
  assert.deepEqual(h.writes, [{ id: 1, error: '通知发送超时' }])
  assert.equal(h.timeouts.size, 0)
  assert.equal(h.notifications[0].listenerCount('show'), 0)
  assert.equal(h.notifications[0].listenerCount('failed'), 0)
  h.notifications[0].emit('show')
  assert.equal(h.writes.length, 1)
})

test('stop cancels pending callbacks and timeout without writing after shutdown', async () => {
  const h = harness()
  h.scheduler.start()
  const notification = h.notifications[0]
  const timeout = [...h.timeouts.values()][0]
  h.scheduler.stop()
  assert.equal(h.timeouts.size, 0)
  assert.equal(h.intervals.size, 0)
  assert.equal(notification.closed, true)
  assert.equal(notification.listenerCount('show'), 0)
  assert.equal(notification.listenerCount('failed'), 0)
  notification.emit('show')
  notification.emit('failed', {}, 'late error')
  timeout.callback() // Already queued callbacks must also be harmless.
  assert.deepEqual(h.writes, [])
  await h.scheduler.tick()
  assert.equal(h.notifications.length, 2)
  h.scheduler.stop()
})

test('asynchronous event database failure is caught and logged', async () => {
  const h = harness({ markFired() { throw new Error('database closed') } })
  await h.scheduler.tick()
  assert.doesNotThrow(() => h.notifications[0].emit('show'))
  assert.equal(h.errors.length, 1)
  assert.equal(h.errors[0][0], '[reminders] 提醒结果写入失败：')
  assert.equal(h.errors[0][1].message, 'database closed')
  assert.equal(h.timeouts.size, 0)
})

test('failure persistence throwing does not block the next reminder', async () => {
  const h = harness({
    supported: false,
    due: [{ id: 1, item_id: 101 }, { id: 2, item_id: 102 }],
    markFired(id) { if (id === 1) throw new Error('write failed') }
  })
  await h.scheduler.tick()
  assert.deepEqual(h.writes, [{ id: 2, error: '系统不支持桌面通知' }])
  assert.equal(h.errors.length, 1)
})

test('real SQLite DAO marks errors failed with no fired_at, and success fired', () => {
  const { DatabaseSync } = require('node:sqlite')
  const daoPath = join(__dirname, '../src/main/db/dao/remindersDao.ts')
  const js = ts.transpileModule(readFileSync(daoPath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new vm.Script(js, { filename: daoPath }).runInNewContext({ module, exports: module.exports })
  const { markFired, listPending } = module.exports
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT DEFAULT '待处理');
      INSERT INTO items (id, status) VALUES (101, '待处理'), (102, '已完成');
      CREATE TABLE reminders (
        id INTEGER PRIMARY KEY, item_id INTEGER, status TEXT DEFAULT 'pending',
        remind_at TEXT, fired_at TEXT, error TEXT
      );
      INSERT INTO reminders (id, item_id, remind_at) VALUES
        (1, 101, '2020-01-01T00:00:00.000Z'),
        (2, 102, '2020-01-01T00:00:00.000Z')`)
    // A5：终态事项（已完成）的到期提醒必须被 listPending 过滤
    const initialDue = listPending(db, '2030-01-01T00:00:00.000Z')
    assert.equal(initialDue.length, 1)
    assert.equal(initialDue[0].id, 1)
    for (const error of ['系统不支持桌面通知', '通知发送失败：permission denied', 'show crashed', '通知发送超时', '']) {
      markFired(db, 1, error)
      const row = db.prepare('SELECT * FROM reminders WHERE id = 1').get()
      assert.equal(row.status, 'failed')
      assert.equal(row.fired_at, null)
      assert.equal(row.error, error)
      assert.equal(listPending(db, '2030-01-01T00:00:00.000Z').length, 0)
    }
    markFired(db, 1)
    const row = db.prepare('SELECT * FROM reminders WHERE id = 1').get()
    assert.equal(row.status, 'fired')
    assert.ok(row.fired_at)
    assert.equal(row.error, null)
    markFired(db, 1, 'late failure')
    assert.equal(db.prepare('SELECT fired_at FROM reminders WHERE id = 1').get().fired_at, null)
  } finally {
    db.close()
  }
})

test('scan errors are logged and running guard resets for the next scan', async () => {
  let attempts = 0
  const h = harness({ listPending() {
    if (++attempts === 1) throw new Error('database unavailable')
    return []
  } })
  await h.scheduler.tick()
  assert.equal(h.errors.length, 1)
  assert.equal(h.errors[0][0], '[reminders] 到期提醒扫描失败：')
  assert.equal(h.errors[0][1].message, 'database unavailable')
  await h.scheduler.tick()
  assert.equal(attempts, 2)
})
