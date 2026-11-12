const test = require('node:test')
const assert = require('node:assert/strict')
const n = require('../dist/main/services/im/normalize.js')

test('decodeXmlEntities 还原常见实体', () => {
  assert.equal(n.decodeXmlEntities('a&amp;b&lt;c&gt;d&quot;e'), 'a&b<c>d"e')
})

test('stripXml 保留可读文本', () => {
  const text = n.stripXml('<p>你好<br/>世界</p>')
  assert.match(text, /你好/)
  assert.match(text, /世界/)
  assert.doesNotMatch(text, /<p>/)
})

test('xmlValue 支持 CDATA 与实体', () => {
  const xml = '<appmsg><title><![CDATA[方案 &amp; 文档]]></title></appmsg>'
  assert.equal(n.xmlValue(xml, 'title'), '方案 & 文档')
  assert.equal(n.xmlValue(xml, 'url'), null)
})

test('kindFromWechatType 覆盖基础类型', () => {
  assert.equal(n.kindFromWechatType(1), 'text')
  assert.equal(n.kindFromWechatType(3), 'image')
  assert.equal(n.kindFromWechatType(34), 'voice')
})

test('纯文本消息归一化', () => {
  const result = n.normalizeWeChatMessage({ type: 1, content: '  你好  ' })
  assert.deepEqual(result, { kind: 'text', text: '你好', quoteText: null, mediaPath: null, deleted: false })
})

test('空内容保留类型但文本为空', () => {
  const result = n.normalizeWeChatMessage({ type: 3, content: '', mediaPath: 'D:/img/a.jpg' })
  assert.equal(result.kind, 'image')
  assert.equal(result.text, '')
  assert.equal(result.mediaPath, 'D:/img/a.jpg')
})

test('图片 XML 归为 image 且正文剥离', () => {
  const xml = '<msg><img src="a.jpg" length="2048"/></msg>'
  const result = n.normalizeWeChatMessage({ type: 3, content: xml })
  assert.equal(result.kind, 'image')
  assert.equal(result.deleted, false)
})

test('appmsg 链接提取标题与描述', () => {
  const xml =
    '<msg><appmsg><title>接入方案</title><des>技术路线说明</des>' +
    '<url>https://example.com/a</url><type>5</type></appmsg></msg>'
  const result = n.normalizeWeChatMessage({ type: 49, content: xml })
  assert.equal(result.kind, 'link')
  assert.match(result.text, /接入方案/)
  assert.match(result.text, /技术路线说明/)
})

test('appmsg 文件消息保留文件名', () => {
  const xml = '<msg><appmsg><title>会议纪要.docx</title><type>6</type></appmsg></msg>'
  const result = n.normalizeWeChatMessage({ type: 49, content: xml })
  assert.equal(result.kind, 'file')
  assert.equal(result.text, '会议纪要.docx')
})

test('引用消息带出被引用原文', () => {
  const xml =
    '<msg><appmsg><title>收到</title><type>57</type><refermsg>' +
    '<displayname>李四</displayname><content><![CDATA[第一版什么时候能给？]]></content>' +
    '</refermsg></appmsg></msg>'
  const result = n.normalizeWeChatMessage({ type: 49, content: xml })
  assert.equal(result.kind, 'quote')
  assert.equal(result.quoteText, '李四：第一版什么时候能给？')
})

test('撤回消息标记为已删除', () => {
  const xml =
    '<sysmsg type="revokemsg"><revokemsg><session>123</session>' +
    '<replacemsg><![CDATA["张三" 撤回了一条消息]]></replacemsg></revokemsg></sysmsg>'
  const result = n.normalizeWeChatMessage({ type: 10002, content: xml })
  assert.equal(result.kind, 'system')
  assert.equal(result.deleted, true)
  assert.match(result.text, /撤回了一条消息/)
})

test('拍一拍归为系统消息', () => {
  const xml = '<sysmsg type="pat"><pat><template><![CDATA[{{A}}拍了拍{{B}}]]></template></pat></sysmsg>'
  const result = n.normalizeWeChatMessage({ type: 10000, content: xml })
  assert.equal(result.kind, 'system')
  assert.equal(result.deleted, true)
})

test('isMeaningful 过滤空文本与撤回提示', () => {
  assert.equal(n.isMeaningful('', 'text'), false)
  assert.equal(n.isMeaningful('   ', 'text'), false)
  assert.equal(n.isMeaningful('撤回了一条消息', 'system'), false)
  assert.equal(n.isMeaningful('正常内容', 'text'), true)
})
