const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { applyImMigrations } = require('../dist/main/db/dao/imDao.js')
const { ImService } = require('../dist/main/services/im/service.js')

const FIXTURE = path.join(__dirname, '..', 'demo', 'qq-export-sample.txt')

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-connector-e2e-'))
  const dbPath = path.join(dir, 'im.db')
  const db = new DatabaseSync(dbPath)
  applyImMigrations(db)
  const logs = []
  const service = new ImService({ db, dbPath, log: (message) => logs.push(message) })
  const cleanup = () => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { service, db, dbPath, logs, cleanup }
}

test('导入 → 理解 → 汇总 全链路', async () => {
  const { service, cleanup } = makeService()
  try {
    const outcome = await service.importQqFiles([FIXTURE])
    assert.equal(outcome.result.inserted, 17)
    assert.equal(outcome.sessions.length, 1)
    assert.equal(outcome.sessions[0].messageCount, 17)

    const sessions = service.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].title, '产品讨论群')
    assert.equal(sessions[0].enabled, true)
    const sessionId = sessions[0].id

    const understood = await service.understand(sessionId, { provider: 'heuristic', force: true })
    assert.equal(understood.ok, true)
    assert.equal(understood.provider, 'heuristic')
    assert.ok(understood.windows >= 1)
    assert.ok(understood.insights >= 1)

    const insights = service.listInsights({ sessionId })
    assert.ok(insights.length >= 1)
    assert.ok(insights.every((item) => item.sessionTitle === '产品讨论群'))
    assert.ok(insights.every((item) => item.status === 'new'))

    const windows = service.listWindows(sessionId)
    assert.ok(windows.length >= 1)
    assert.ok(windows.every((item) => item.state === 'done'))

    const totalInsights = ['2026-10-16', '2026-10-17'].reduce((sum, day) => {
      const counts = service.digest(day).counts
      return sum + Object.values(counts).reduce((inner, value) => inner + value, 0)
    }, 0)
    assert.ok(totalInsights >= insights.length)

    const digest = service.digest('2026-10-16')
    assert.equal(digest.date, '2026-10-16')
    assert.match(digest.markdown, /聊天摘要/)
    assert.match(digest.markdown, /产品讨论群/)

    const today = service.digest()
    assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(today.markdown.length > 0)
  } finally {
    cleanup()
  }
})

test('重复导入幂等', async () => {
  const { service, cleanup } = makeService()
  try {
    const first = await service.importQqFiles([FIXTURE])
    const second = await service.importQqFiles([FIXTURE])
    assert.equal(first.result.inserted, 17)
    assert.equal(second.result.inserted, 0)
    assert.equal(second.sessions[0].messageCount, 17)
  } finally {
    cleanup()
  }
})

test('消息分页、检索与开关', async () => {
  const { service, cleanup } = makeService()
  try {
    const outcome = await service.importQqFiles([FIXTURE])
    const sessionId = outcome.sessions[0].id

    const page = service.listMessages(sessionId, undefined, 5)
    assert.equal(page.total, 17)
    assert.equal(page.items.length, 5)
    // 默认取最新一页，但按时间正序返回
    assert.deepEqual(page.items.map((item) => item.seq), [13, 14, 15, 16, 17])

    const older = service.listMessages(sessionId, 13, 5)
    assert.ok(older.items.every((item) => item.seq < 13))

    const result = service.search('demo')
    assert.equal(result.mode, 'fts')
    assert.ok(result.items.length >= 1)
    assert.ok(result.items.every((item) => item.sessionId === sessionId))

    assert.equal(service.setSessionEnabled(sessionId, false), true)
    assert.equal(service.listSessions()[0].enabled, false)
    assert.equal(service.setSessionEnabled(sessionId, true), true)

    const byTitle = service.findSessionByTitle('产品讨论')
    assert.equal(byTitle.length, 1)
  } finally {
    cleanup()
  }
})

test('doctor 输出检查项', async () => {
  const { service, cleanup } = makeService()
  try {
    const report = await service.doctor({ chatlogUrl: 'http://127.0.0.1:1' })
    assert.equal(typeof report.ok, 'boolean')
    assert.ok(report.checks.length >= 4)
    const names = report.checks.map((check) => check.name)
    assert.ok(names.includes('数据库'))
    assert.ok(names.includes('FTS5 中文检索'))
    assert.equal(report.fts, true)
  } finally {
    cleanup()
  }
})

test('未启用的会话在增量同步时被跳过', async () => {
  const { service, cleanup } = makeService()
  try {
    const outcome = await service.importQqFiles([FIXTURE], { enable: false })
    assert.equal(outcome.sessions[0].enabled, false)
    assert.equal(service.listSessions().length, 1)
  } finally {
    cleanup()
  }
})

test('导出 JSON 可序列化（供 IPC 传输）', async () => {
  const { service, cleanup } = makeService()
  try {
    await service.importQqFiles([FIXTURE])
    const payload = {
      sessions: service.listSessions(),
      messages: service.listMessages(1, undefined, 3),
      insights: service.listInsights({})
    }
    const text = JSON.stringify(payload)
    assert.doesNotThrow(() => JSON.parse(text))
    assert.ok(text.length > 100)
  } finally {
    cleanup()
  }
})
