const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseQqExportText, QqExportAdapter } = require('../dist/main/services/im/qqExport.js')

const FIXTURE = path.join(__dirname, '..', 'demo', 'qq-export-sample.txt')

test('解析导出文件的消息对象与条数', () => {
  const content = fs.readFileSync(FIXTURE, 'utf8')
  const parsed = parseQqExportText(content, 'fallback')
  assert.equal(parsed.title, '产品讨论群')
  assert.equal(parsed.messages.length, 17)
  assert.equal(parsed.messages[0].senderName, '张三')
  assert.equal(parsed.messages[0].senderId, '10001')
  assert.equal(parsed.messages[0].sentAt, '2026-10-16 09:02:11')
  assert.match(parsed.messages[0].text, /聊天记录接入/)
})

test('按占位符识别消息类型', () => {
  const parsed = parseQqExportText(fs.readFileSync(FIXTURE, 'utf8'), 'fallback')
  const kinds = parsed.messages.map((message) => message.kind)
  assert.equal(kinds.filter((kind) => kind === 'image').length, 1)
  assert.equal(kinds.filter((kind) => kind === 'file').length, 1)
  assert.equal(kinds.filter((kind) => kind === 'text').length, 15)
})

test('续行合并进上一条消息', () => {
  const parsed = parseQqExportText(
    ['消息对象: 测试(1)', '==================', '2026-10-16 9:00:00 张三(1)', '第一行', '第二行', ''].join('\n'),
    'fallback'
  )
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].text, '第一行\n第二行')
})

test('适配器产出的会话与会话键稳定', async () => {
  const adapter = new QqExportAdapter([FIXTURE])
  const sessions = await adapter.listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].kind, 'group')
  assert.equal(sessions[0].title, '产品讨论群')
  assert.match(sessions[0].platformSessionId, /^qq-[0-9a-f]{16}$/)

  const again = await new QqExportAdapter([FIXTURE]).listSessions()
  assert.equal(again[0].platformSessionId, sessions[0].platformSessionId)
})

test('消息 id 稳定且 seq 递增', async () => {
  const adapter = new QqExportAdapter([FIXTURE])
  const [session] = await adapter.listSessions()
  const first = await adapter.fetchMessages(session, {}, 1000)
  const second = await new QqExportAdapter([FIXTURE]).fetchMessages(session, {}, 1000)
  assert.equal(first.length, 17)
  assert.deepEqual(
    first.map((message) => message.platformMsgId),
    second.map((message) => message.platformMsgId)
  )
  assert.deepEqual(
    first.map((message) => message.seq),
    Array.from({ length: 17 }, (_, index) => index + 1)
  )
})

test('按游标只返回新消息', async () => {
  const adapter = new QqExportAdapter([FIXTURE])
  const [session] = await adapter.listSessions()
  const fresh = await adapter.fetchMessages(session, { since: '2026-10-17 00:00:00' }, 1000)
  assert.equal(fresh.length, 4)
  assert.ok(fresh.every((message) => message.sentAt.startsWith('2026-10-17')))
})

test('title 选项可覆盖会话名', async () => {
  const adapter = new QqExportAdapter([FIXTURE], { title: '自定义会话' })
  const [session] = await adapter.listSessions()
  assert.equal(session.title, '自定义会话')
  assert.equal(session.kind, 'peer')
})

test('缺失文件时健康检查失败', async () => {
  const adapter = new QqExportAdapter([path.join(os.tmpdir(), 'not-exists-qq.txt')])
  const health = await adapter.health()
  assert.equal(health.ok, false)
})
