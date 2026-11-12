const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { ChatlogClient, ChatlogAdapter } = require('../dist/main/services/im/chatlog.js')

function startStub(options = {}) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    const send = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (options.failAll) return send(500, { error: 'boom' })
    if (request.url.startsWith('/api/v1/session')) {
      return send(200, {
        items: [
          { talker: '123@chatroom', name: '测试群', isGroup: true, time: 1760000000, memberCount: 8 },
          { talker: 'wxid_friend', name: '张三', time: 1759990000 }
        ]
      })
    }
    if (request.url.startsWith('/api/v1/chatlog')) {
      return send(200, {
        items: [
          { id: 'msg-1', seq: 1, time: 1760000100, type: 1, content: '第一条消息', sender: 'wxid_a', senderName: '张三' },
          { id: 'msg-2', seq: 2, time: 1760000200, type: 3, content: '', sender: 'wxid_b', senderName: '李四' },
          { id: 'msg-3', seq: 3, time: 1760000300, type: 49, content: '<msg><appmsg><title>方案</title><type>5</type></appmsg></msg>', sender: 'wxid_a', senderName: '张三' }
        ]
      })
    }
    return send(404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

test('健康检查走通并带上 Authorization', async () => {
  const stub = await startStub()
  try {
    const client = new ChatlogClient({ baseUrl: stub.baseUrl, token: 'secret-token' })
    const health = await client.health()
    assert.equal(health.ok, true)
    assert.ok(stub.requests.length >= 1)
    assert.equal(stub.requests[0].authorization, 'Bearer secret-token')
  } finally {
    await stub.close()
  }
})

test('会话列表映射出类型与标题', async () => {
  const stub = await startStub()
  try {
    const client = new ChatlogClient({ baseUrl: stub.baseUrl })
    const sessions = await client.listSessions()
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].title, '测试群')
    assert.equal(sessions[0].kind, 'group')
    assert.equal(sessions[1].kind, 'peer')
    assert.match(sessions[0].lastMessageAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  } finally {
    await stub.close()
  }
})

test('消息归一化：文本、图片、链接', async () => {
  const stub = await startStub()
  try {
    const client = new ChatlogClient({ baseUrl: stub.baseUrl })
    const [session] = await client.listSessions()
    const messages = await client.fetchMessages(session, {}, 100)
    assert.equal(messages.length, 3)
    assert.equal(messages[0].text, '第一条消息')
    assert.equal(messages[0].kind, 'text')
    assert.equal(messages[1].kind, 'image')
    assert.equal(messages[2].kind, 'link')
    assert.equal(messages[2].text, '方案')
    assert.equal(messages[0].platformMsgId, 'msg-1')
  } finally {
    await stub.close()
  }
})

test('适配器通过 client 拉取会话与消息', async () => {
  const stub = await startStub()
  try {
    const adapter = new ChatlogAdapter(new ChatlogClient({ baseUrl: stub.baseUrl }), 'D:/WeChat Files')
    const health = await adapter.health()
    assert.equal(health.ok, true)
    const [session] = await adapter.listSessions()
    const messages = await adapter.fetchMessages(session, {}, 100)
    assert.equal(messages.length, 3)
    assert.equal(messages[0].seq, 1)
  } finally {
    await stub.close()
  }
})

test('服务返回 500 时健康检查失败', async () => {
  const stub = await startStub({ failAll: true })
  try {
    const client = new ChatlogClient({ baseUrl: stub.baseUrl, timeoutMs: 3000 })
    const health = await client.health()
    assert.equal(health.ok, false)
    assert.match(health.detail, /500/)
  } finally {
    await stub.close()
  }
})

test('端口无人监听时健康检查失败', async () => {
  const client = new ChatlogClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 })
  const health = await client.health()
  assert.equal(health.ok, false)
  assert.ok(health.detail.length > 0)
})
