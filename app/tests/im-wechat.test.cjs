const test = require('node:test')
const assert = require('node:assert')
const { parseWechatExportText } = require('../.test-out/main/services/im/wechatExport.js')

const SAMPLE = [
  '与「产品小组」的聊天记录',
  '2026-10-16 09:02:11 张三',
  '早，今天把聊天记录接进 InfoAgent 的事定一下',
  '2026-10-16 09:03:02 李四',
  '我倾向先做导入，别一上来就解密数据库',
  '2026-10-16 09:05:40 张三: 同意，风险最低先跑通',
  '2026-10-16 10:12:00 王五',
  '[图片]',
  '2026-10-17 14:20:00 王五: 需要把令牌放到环境变量，不要提交到仓库'
].join('\n')

test('解析三种常见微信导出格式', () => {
  const parsed = parseWechatExportText(SAMPLE, 'fallback')
  assert.equal(parsed.title, '与「产品小组」的聊天记录')
  assert.equal(parsed.messages.length, 5)
  assert.equal(parsed.messages[0].sentAt, '2026-10-16 09:02:11')
  assert.equal(parsed.messages[0].senderName, '张三')
  assert.equal(parsed.messages[2].senderName, '张三')
  assert.equal(parsed.messages[2].text, '同意，风险最低先跑通')
  assert.equal(parsed.messages[3].kind, 'image')
  assert.equal(parsed.messages[4].kind, 'text')
})

test('发送人写在时间前面也能解析', () => {
  const parsed = parseWechatExportText('张三 2026-10-16 09:02:11\n你好\n李四 2026-10-16 09:03:00\n在', 'x')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].senderName, '张三')
  assert.equal(parsed.messages[1].text, '在')
})

test('方括号时间前缀也能解析', () => {
  const parsed = parseWechatExportText('[2026-10-16 09:02:11] 张三: 收到\n[2026-10-16 09:03:00] 李四: 好', 'x')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].text, '收到')
  assert.equal(parsed.messages[1].senderName, '李四')
})

test('没有时间戳的说明文字被忽略', () => {
  const parsed = parseWechatExportText('以下是新消息\n2026-10-16 09:02:11 张三\n正文', 'x')
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].text, '正文')
})

test('空文件回退到文件名当标题', () => {
  const parsed = parseWechatExportText('', '群聊A')
  assert.equal(parsed.title, '群聊A')
  assert.equal(parsed.messages.length, 0)
})
