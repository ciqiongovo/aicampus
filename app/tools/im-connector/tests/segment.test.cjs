const test = require('node:test')
const assert = require('node:assert/strict')
const { segmentMessages, DEFAULT_SEGMENT_OPTIONS } = require('../dist/main/services/im/segment.js')

function message(seq, sentAt, text, extra = {}) {
  return {
    id: seq,
    seq,
    sentAt,
    kind: 'text',
    text,
    senderName: '张三',
    isSelf: false,
    deleted: false,
    ...extra
  }
}

test('默认参数符合预期', () => {
  assert.equal(DEFAULT_SEGMENT_OPTIONS.gapMinutes, 30)
  assert.equal(DEFAULT_SEGMENT_OPTIONS.maxMessages, 80)
})

test('连续短间隔消息合并成一个窗口', () => {
  const segments = segmentMessages([
    message(1, '2026-10-16 09:00:00', '在吗'),
    message(2, '2026-10-16 09:05:00', '在'),
    message(3, '2026-10-16 09:10:00', '聊一下接入')
  ])
  assert.equal(segments.length, 1)
  assert.equal(segments[0].messages.length, 3)
})

test('超过间隔阈值切窗', () => {
  const segments = segmentMessages([
    message(1, '2026-10-16 09:00:00', '第一段'),
    message(2, '2026-10-16 09:05:00', '第一段继续'),
    message(3, '2026-10-16 11:20:00', '第二段'),
    message(4, '2026-10-16 11:21:00', '第二段继续')
  ])
  assert.equal(segments.length, 2)
  assert.deepEqual(
    segments.map((segment) => segment.messages.map((item) => item.seq)),
    [
      [1, 2],
      [3, 4]
    ]
  )
})

test('超过条数上限切窗', () => {
  const messages = [1, 2, 3, 4, 5].map((seq) => message(seq, `2026-10-16 09:0${seq}:00`, `第 ${seq} 条`))
  const segments = segmentMessages(messages, { maxMessages: 2 })
  assert.deepEqual(
    segments.map((segment) => segment.messages.length),
    [2, 2, 1]
  )
})

test('超过字数上限切窗', () => {
  const long = '很长的内容'.repeat(20)
  const segments = segmentMessages([message(1, '2026-10-16 09:00:00', long), message(2, '2026-10-16 09:01:00', long)], {
    maxChars: 50
  })
  assert.equal(segments.length, 2)
})

test('已删除消息被跳过', () => {
  const segments = segmentMessages([
    message(1, '2026-10-16 09:00:00', '保留'),
    message(2, '2026-10-16 09:01:00', '撤回', { deleted: true }),
    message(3, '2026-10-16 09:02:00', '保留')
  ])
  assert.equal(segments.length, 1)
  assert.deepEqual(
    segments[0].messages.map((item) => item.seq),
    [1, 3]
  )
})

test('空输入返回空数组', () => {
  assert.deepEqual(segmentMessages([]), [])
})
