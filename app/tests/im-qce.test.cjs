const test = require('node:test')
const assert = require('node:assert')
const { qceSentAt, qceElementParts, qceToRawMessage } = require('../.test-out/main/services/im/qce.js')

test('秒级时间戳转本地时间', () => {
  const value = qceSentAt(1791639603)
  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(value, qceSentAt('1791639603000'))
})

test('文本消息合并多个文本片段', () => {
  const parts = qceElementParts({
    elements: [
      { textElement: { content: '早上好' } },
      { textElement: { content: '今天的会在 10 点' } }
    ]
  })
  assert.equal(parts.kind, 'text')
  assert.equal(parts.text, '早上好 今天的会在 10 点')
})

test('图片、文件、语音、表情映射成对应类型', () => {
  assert.deepEqual(
    [qceElementParts({ elements: [{ picElement: {} }] }).kind, qceElementParts({ elements: [{ picElement: {} }] }).text],
    ['image', '[图片]']
  )
  assert.equal(qceElementParts({ elements: [{ fileElement: { fileName: 'a.pdf' } }] }).text, '[文件] a.pdf')
  assert.equal(qceElementParts({ elements: [{ pttElement: {} }] }).kind, 'voice')
  assert.equal(qceElementParts({ elements: [{ marketFaceElement: {} }] }).kind, 'sticker')
})

test('回复消息带引用文本', () => {
  const parts = qceElementParts({
    elements: [{ replyElement: { sourceText: '原始消息' } }, { textElement: { content: '同意' } }]
  })
  assert.equal(parts.text, '同意')
  assert.equal(parts.quoteText, '原始消息')
})

test('缺 msgId 的消息被跳过', () => {
  assert.equal(qceToRawMessage({ msgTime: 1791639603 }, 1), null)
})

test('消息映射出统一字段', () => {
  const raw = qceToRawMessage(
    {
      msgId: '7695033876367231557',
      msgTime: '1791639603',
      senderUid: 'u_abc',
      sendRemarkName: '张三',
      sendType: 0,
      elements: [{ textElement: { content: '链接 https://example.com' } }]
    },
    7
  )
  assert.equal(raw.platformMsgId, '7695033876367231557')
  assert.equal(raw.seq, 7)
  assert.equal(raw.senderName, '张三')
  assert.equal(raw.isSelf, false)
  assert.equal(raw.kind, 'text')
  assert.match(raw.sentAt, /^\d{4}-\d{2}-\d{2} /)
})

test('系统提示的发送人显示为系统', () => {
  const raw = qceToRawMessage(
    { msgId: 'x1', msgTime: 1791639603, sendNickName: '某群', elements: [{ grayTipElement: { subElementType: 4 } }] },
    1
  )
  assert.equal(raw.kind, 'system')
  assert.equal(raw.senderName, '系统')
})

test('合并转发、卡片、转账各自映射', () => {
  const forward = qceElementParts({ elements: [{ multiForwardMsgElement: { fileName: '群聊记录' } }] })
  assert.equal(forward.kind, 'merge')
  assert.match(forward.text, /群聊记录/)

  const xml = qceElementParts({ elements: [{ xmlElement: { content: '<msg/>' } }] })
  assert.equal(xml.kind, 'link')

  const wallet = qceElementParts({ elements: [{ walletElement: { amount: 1 } }] })
  assert.equal(wallet.kind, 'other')
})
