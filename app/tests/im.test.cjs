'use strict'
// 聊天记录源（v20）：迁移建表 + QQ 导出导入 + 规则理解 + 摘要 + 检索
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node tests/im.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { openDatabase } = require('../.test-out/main/db/database.js')
const { ImService } = require('../.test-out/main/services/im/service.js')

const EXPORT = [
  '消息记录（此记录未加密）',
  '消息对象: 产品讨论群(88776655)',
  '==================',
  '2026-10-16 9:02:11 张三(10001)',
  '早，今天把聊天记录接入的方案定一下。',
  '2026-10-16 9:03:02 李四(10002)',
  '我倾向先做 QQ 导出导入，风险最低。',
  '2026-10-16 9:03:40 张三(10001)',
  '同意，微信那边等 chatlog 稳定了再上。',
  '2026-10-16 9:05:10 李四(10002)',
  '需要在 2026-10-23 前给出第一版 demo。',
  '2026-10-16 9:06:00 张三(10001)',
  '方案文档 https://example.com/im-design 记得看一下。',
  '2026-10-17 10:15:00 李四(10002)',
  '昨天的 demo 跑通了，今天补测试。'
].join('\n')

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'infoagent-im-'))
  const file = join(dir, 'qq-export.txt')
  writeFileSync(file, EXPORT, 'utf8')
  return { dir, file }
}

test('v20 迁移建出 IM 表，且 IM 域可独立工作', () => {
  const db = openDatabase(':memory:')
  try {
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v
    assert.equal(version, 29)
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'im_%'")
        .all()
        .map((row) => row.name)
    )
    for (const name of ['im_account', 'im_session', 'im_message', 'im_window', 'im_insight', 'im_meta']) {
      assert.ok(tables.has(name), '缺少表 ' + name)
    }
  } finally {
    db.close()
  }
})

test('导入 QQ 导出的 txt：建账号、建会话、写消息', async () => {
  const { dir, file } = makeTemp()
  const db = openDatabase(':memory:')
  try {
    const service = new ImService({ db })
    const outcome = await service.importQqFiles([file], { enable: true })
    assert.equal(outcome.errors.length, 0)
    assert.equal(outcome.sessions, 1)
    assert.equal(outcome.inserted, 6)

    const sessions = service.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].title, '产品讨论群')
    assert.equal(sessions[0].platform, 'qq')
    assert.equal(sessions[0].messageCount, 6)

    const page = service.listMessages(sessions[0].id)
    assert.equal(page.total, 6)
    assert.equal(page.items.length, 6)
    assert.equal(page.items[0].senderName, '张三')

    // 重复导入不产生重复消息
    const again = await service.importQqFiles([file], { enable: true })
    assert.equal(again.inserted, 0)
    assert.equal(again.updated, 0)
    assert.equal(service.listMessages(sessions[0].id).total, 6)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('规则理解产出结论，摘要按日期聚合', async () => {
  const { dir, file } = makeTemp()
  const db = openDatabase(':memory:')
  try {
    const service = new ImService({ db })
    await service.importQqFiles([file], { enable: true })
    const session = service.listSessions()[0]

    const result = await service.understand(session.id, {})
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'heuristic')
    assert.ok(result.windows >= 1)
    assert.ok(result.insights >= 3)

    const insights = service.listInsights({ sessionId: session.id })
    const kinds = new Set(insights.map((item) => item.kind))
    assert.ok(kinds.has('decision'), '应识别出决定')
    assert.ok(kinds.has('todo'), '应识别出待办')
    assert.ok(kinds.has('link'), '应识别出链接')
    const todo = insights.find((item) => item.kind === 'todo')
    assert.equal(todo.dueAt, '2026-10-23')
    assert.ok(todo.evidence.length > 0, '结论要能回溯到消息')

    const digest = service.digest('2026-10-16')
    assert.equal(digest.date, '2026-10-16')
    assert.match(digest.markdown, /产品讨论群/)
    assert.match(digest.markdown, /待办|决定/)
    assert.ok(digest.counts.decision >= 1)

    // 再次理解不会重复累加（按窗口幂等）
    const again = await service.understand(session.id, {})
    assert.equal(again.windows, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('检索：FTS trigram 与短词 LIKE 回退', async () => {
  const { dir, file } = makeTemp()
  const db = openDatabase(':memory:')
  try {
    const service = new ImService({ db })
    await service.importQqFiles([file], { enable: true })

    const hit = service.search('chatlog')
    assert.ok(hit.total >= 1)
    assert.equal(hit.mode, 'fts')

    const short = service.search('QQ')
    assert.equal(short.mode, 'like')
    assert.ok(short.total >= 1)

    assert.equal(service.search('   ').total, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断报告包含数据库、FTS 与目录检查项', async () => {
  const db = openDatabase(':memory:')
  try {
    const service = new ImService({ db })
    const report = await service.doctor()
    const names = report.checks.map((item) => item.name)
    assert.ok(names.includes('数据库'))
    assert.ok(names.includes('FTS5 中文检索'))
    assert.ok(names.includes('微信数据目录'))
    assert.ok(names.includes('QQ 数据目录'))
    assert.equal(typeof report.ok, 'boolean')
    assert.ok(Array.isArray(report.hints))
  } finally {
    db.close()
  }
})

test('AI 信息来源：按消息数排序、只接受 QQ 会话、选择可持久化', async () => {
  const { dir, file } = makeTemp()
  const db = openDatabase(':memory:')
  try {
    const service = new ImService({ db })
    await service.importQqFiles([file])
    const sources = service.listQqSources()
    assert.ok(sources.length >= 1)
    assert.equal(sources[0].selected, false)

    const saved = service.setQqSources([sources[0].sessionId, -1, 99999])
    assert.deepEqual(saved, [sources[0].sessionId])

    const after = service.listQqSources()
    assert.equal(after.find((item) => item.sessionId === sources[0].sessionId).selected, true)
    assert.deepEqual(service.getSelectedSourceIds(), [sources[0].sessionId])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('日报 QQ 栏：实际动作/建议动作分组，反馈状态影响统计', async () => {
  const { dir, file } = makeTemp()
  const db = openDatabase(':memory:')
  try {
    const service = new ImService({ db })
    await service.importQqFiles([file])
    const session = service.listSessions().find((item) => item.platform === 'qq')
    service.setQqSources([session.id])
    await service.understand(session.id, { provider: 'heuristic' })

    const summary = await service.dailyQq('2026-10-16', { extract: false, range: 1 })
    assert.equal(summary.dateKey, '2026-10-16')
    assert.equal(summary.sources.filter((item) => item.selected).length, 1)
    assert.ok(summary.items.length > 0)
    assert.ok(summary.items.every((item) => item.sessionId === session.id))
    assert.ok(summary.items.some((item) => item.group === 'actual'))
    assert.ok(summary.items.some((item) => item.group === 'suggested'))
    assert.equal(summary.stats.actual + summary.stats.suggested, summary.items.length)

    const target = summary.items[0]
    service.setInsightStatus(target.id, 'accepted')
    const after = await service.dailyQq('2026-10-16', { extract: false, range: 1 })
    assert.equal(after.stats.accepted, 1)
    assert.equal(after.items.find((item) => item.id === target.id).status, 'accepted')

    const acceptedKeyword = db
      .prepare('SELECT keyword, weight, email_count, qq_count FROM keyword_profile WHERE qq_count > 0 ORDER BY weight DESC LIMIT 1')
      .get()
    assert.ok(acceptedKeyword, 'QQ 采纳应写入全局关键词画像')
    assert.equal(acceptedKeyword.email_count, 0)
    assert.ok(acceptedKeyword.weight > 0)
    service.setInsightStatus(target.id, 'new')
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM keyword_feedback WHERE source = 'qq' AND source_id = ?").get(target.id).n,
      0,
      '撤销反馈应删除该条 QQ 结论的关键词反馈'
    )
    const oneDay = await service.dailyQq('2026-10-17', { extract: false, range: 1 })
    const sevenDays = await service.dailyQq('2026-10-17', { extract: false, range: 7 })
    const old = await service.dailyQq('2026-11-18', { extract: false, range: 'older30' })
    assert.ok(sevenDays.items.length > oneDay.items.length)
    assert.ok(old.items.length >= summary.items.length)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
