'use strict'

// Run directly: node --test tests/oauth.test.cjs
// No Electron process: oauth.ts is transpiled in-memory and run in a vm with
// a mock 'electron' (safeStorage) and a real local mock token server.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const http = require('node:http')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const COMPILER = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }

function compile(rel) {
  const filename = join(__dirname, rel)
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: COMPILER
  })
  const errors = (compiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  assert.deepEqual(errors, [], 'transpile errors in ' + rel)
  return compiled.outputText
}

const oauthSrc = compile('../src/main/services/mail/oauth.ts')
const secretSrc = compile('../src/main/services/mail/secret.ts')

const electronMock = {
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('mock:' + s, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^mock:/, '')
  }
}

function loadOauth() {
  // 先在同一 vm 体系里加载真实的 secret.ts（边界保持真实，只 mock electron）
  const secretModule = { exports: {} }
  const secretContext = vm.createContext({
    module: secretModule,
    exports: secretModule.exports,
    Error,
    Buffer,
    console,
    require(id) {
      if (id === 'electron') return electronMock
      throw new Error('Unexpected dependency: ' + id)
    }
  })
  new vm.Script(secretSrc, { filename: 'secret.ts' }).runInContext(secretContext)

  const module = { exports: {} }
  const context = vm.createContext({
    module,
    exports: module.exports,
    Error,
    Buffer,
    console,
    URL,
    URLSearchParams,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch,
    require(id) {
      if (id === './secret') return secretModule.exports
      if (id === 'node:http') return http
      if (id === 'node:crypto') return require('node:crypto')
      throw new Error('Unexpected dependency: ' + id)
    }
  })
  new vm.Script(oauthSrc, { filename: 'oauth.ts' }).runInContext(context)
  return module.exports
}

const oauth = loadOauth()

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function makeIdToken(email) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ email, iss: 'test' }) + '.sig'
}

/**
 * 本地 mock 令牌服务器。mode：
 * - 'ok'          授权码交换返回 refresh_token + id_token；刷新返回轮换的 refresh_token
 * - 'no-refresh'  授权码交换不返回 refresh_token
 * - 'no-rotation' 刷新只返回 access_token（refresh_token 不变）
 * - 'http-error'  返回 400 invalid_grant
 */
function startTokenServer(mode = 'ok') {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body })
      const params = new URLSearchParams(body)
      const grant = params.get('grant_type')
      res.setHeader('content-type', 'application/json')
      if (mode === 'http-error') {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }))
        return
      }
      if (grant === 'authorization_code') {
        if (mode === 'no-refresh') {
          res.end(
            JSON.stringify({ access_token: 'ACCESS1', expires_in: 3600, id_token: makeIdToken('norefresh@example.com') })
          )
        } else {
          res.end(
            JSON.stringify({
              access_token: 'ACCESS1',
              refresh_token: 'REFRESH1',
              expires_in: 3600,
              id_token: makeIdToken('alice@example.com')
            })
          )
        }
      } else if (grant === 'refresh_token') {
        if (mode === 'no-rotation') res.end(JSON.stringify({ access_token: 'ACCESS2', expires_in: 1800 }))
        else res.end(JSON.stringify({ access_token: 'ACCESS2', refresh_token: 'REFRESH2', expires_in: 1800 }))
      } else {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port + '/token',
        requests,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

function mockCfg(tokenUrl) {
  return {
    label: 'mock',
    authorizeUrl: 'http://127.0.0.1:1/authorize',
    tokenUrl,
    scopes: ['https://mail.example/read', 'offline_access'],
    extraParams: { access_type: 'offline' }
  }
}

/** 用 fetch 模拟浏览器完成回调（带指定参数） */
async function finishAuth(begin, extra = {}) {
  const authUrl = new URL(begin.authUrl)
  const callback = new URL(authUrl.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'TESTCODE')
  callback.searchParams.set('state', authUrl.searchParams.get('state'))
  for (const [k, v] of Object.entries(extra)) callback.searchParams.set(k, v)
  const res = await fetch(callback.toString())
  return { state: authUrl.searchParams.get('state'), body: await res.text(), status: res.status }
}

test('authUrl carries PKCE params, loopback redirect and provider extras', async () => {
  const begin = await oauth.beginOauth('outlook', 'app-client-id-001', mockCfg('http://127.0.0.1:1/token'))
  assert.equal(begin.ok, true)
  const url = new URL(begin.authUrl)
  assert.equal(url.searchParams.get('client_id'), 'app-client-id-001')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'https://mail.example/read offline_access')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge').length, 43)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('state'), begin.state)
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/)
  const redirect = url.searchParams.get('redirect_uri')
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
  oauth.cancelOauth(begin.state)
})

test('callback success: code exchanged, email derived, poll done, take consumes once', async () => {
  const token = await startTokenServer('ok')
  try {
    const begin = await oauth.beginOauth('outlook', 'app-client-id-001', mockCfg(token.url))
    const done = await finishAuth(begin)
    assert.equal(done.status, 200)
    assert.match(done.body, /授权成功/)
    assert.match(done.body, /alice@example\.com/)

    // 令牌交换请求携带授权码 + PKCE verifier
    assert.equal(token.requests.length, 1)
    const exchanged = new URLSearchParams(token.requests[0].body)
    assert.equal(exchanged.get('grant_type'), 'authorization_code')
    assert.equal(exchanged.get('code'), 'TESTCODE')
    assert.equal(exchanged.get('client_id'), 'app-client-id-001')
    assert.equal(exchanged.get('code_verifier').length, 86)

    const poll = oauth.getOauthStatus(done.state)
    assert.equal(poll.status, 'done')
    assert.equal(poll.email, 'alice@example.com')

    // peek 不消费，令牌为 safeStorage 加密格式且可解出真实值
    const peeked = oauth.peekOauthResult(done.state)
    assert.ok(peeked)
    assert.equal(peeked.provider, 'outlook')
    assert.match(peeked.refreshEnc, /^enc:/)
    const plain = Buffer.from(peeked.refreshEnc.slice(4), 'base64').toString('utf8').replace(/^mock:/, '')
    assert.equal(plain, 'REFRESH1')

    // take 消费一次后 state 立即失效
    const taken = oauth.takeOauthResult(done.state)
    assert.equal(taken.email, 'alice@example.com')
    assert.equal(oauth.peekOauthResult(done.state), null)
    assert.equal(oauth.getOauthStatus(done.state).status, 'error')
  } finally {
    await token.close()
  }
})

test('state mismatch is rejected as CSRF attempt', async () => {
  const begin = await oauth.beginOauth('outlook', 'app-client-id-001', mockCfg('http://127.0.0.1:1/token'))
  try {
    const done = await finishAuth(begin, { state: 'wrong-state' })
    assert.match(done.body, /授权失败/)
    const poll = oauth.getOauthStatus(done.state)
    assert.equal(poll.status, 'error')
    assert.match(poll.message, /state 校验失败/)
  } finally {
    oauth.cancelOauth(begin.state)
  }
})

test('user denial surfaces the provider error', async () => {
  const begin = await oauth.beginOauth('outlook', 'app-client-id-001', mockCfg('http://127.0.0.1:1/token'))
  try {
    const done = await finishAuth(begin, { error: 'access_denied', error_description: 'user said no' })
    assert.match(done.body, /授权未完成/)
    const poll = oauth.getOauthStatus(done.state)
    assert.equal(poll.status, 'error')
    assert.match(poll.message, /拒绝/)
  } finally {
    oauth.cancelOauth(begin.state)
  }
})

test('missing refresh_token fails the flow instead of storing a dead credential', async () => {
  const token = await startTokenServer('no-refresh')
  try {
    const begin = await oauth.beginOauth('outlook', 'app-client-id-001', mockCfg(token.url))
    try {
      const done = await finishAuth(begin)
      assert.match(done.body, /授权失败/)
      const poll = oauth.getOauthStatus(done.state)
      assert.equal(poll.status, 'error')
      assert.match(poll.message, /refresh_token/)
    } finally {
      oauth.cancelOauth(begin.state)
    }
  } finally {
    await token.close()
  }
})

test('refreshAccessToken returns rotated refresh_token and expiry window', async () => {
  const token = await startTokenServer('ok')
  try {
    const before = Date.now()
    const result = await oauth.refreshAccessToken('outlook', 'app-client-id-001', 'REFRESH1', mockCfg(token.url))
    assert.equal(result.accessToken, 'ACCESS2')
    assert.equal(result.refreshToken, 'REFRESH2') // Microsoft 轮换，必须回写
    assert.ok(Math.abs(result.expiresAt - (before + 1800 * 1000)) < 5000)
    const sent = new URLSearchParams(token.requests[0].body)
    assert.equal(sent.get('grant_type'), 'refresh_token')
    assert.equal(sent.get('refresh_token'), 'REFRESH1')
  } finally {
    await token.close()
  }
})

test('refresh without rotation keeps the original refresh_token', async () => {
  const token = await startTokenServer('no-rotation')
  try {
    const result = await oauth.refreshAccessToken('outlook', 'app-client-id-001', 'REFRESH1', mockCfg(token.url))
    assert.equal(result.accessToken, 'ACCESS2')
    assert.equal(result.refreshToken, 'REFRESH1')
  } finally {
    await token.close()
  }
})

test('refresh failure surfaces the server error description', async () => {
  const token = await startTokenServer('http-error')
  try {
    await assert.rejects(
      oauth.refreshAccessToken('outlook', 'app-client-id-001', 'REFRESH1', mockCfg(token.url)),
      /refresh token expired/
    )
  } finally {
    await token.close()
  }
})

test('cancelOauth ends a pending flow', async () => {
  const begin = await oauth.beginOauth('outlook', 'app-client-id-001', mockCfg('http://127.0.0.1:1/token'))
  oauth.cancelOauth(begin.state)
  const poll = oauth.getOauthStatus(begin.state)
  assert.equal(poll.status, 'error')
  assert.match(poll.message, /不存在或已过期/)
})

test('unknown state, unsupported provider and invalid client id are rejected', async () => {
  assert.equal(oauth.getOauthStatus('nope').status, 'error')
  assert.match(oauth.getOauthStatus('nope').message, /授权会话不存在或已过期，请重新发起登录/)

  const unsupported = await oauth.beginOauth('qq', 'valid-client-id')
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.message, /不支持 OAuth/)

  const badClient = await oauth.beginOauth('outlook', 'ab')
  assert.equal(badClient.ok, false)
  assert.match(badClient.message, /格式不合法/)

  assert.equal(oauth.validateOauthClientId('a'.repeat(5)), false)
  assert.equal(oauth.validateOauthClientId('a'.repeat(6)), true)
  assert.equal(oauth.validateOauthClientId('abc@def'), false)
  assert.equal(oauth.validateOauthClientId('abc.def~-123_x'), true)
  assert.equal(oauth.validateOauthClientId('a'.repeat(201)), false)
})

test('provider registry keeps real endpoints and required scopes', () => {
  const outlook = oauth.getOauthProviderConfig('outlook')
  assert.equal(outlook.authorizeUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  assert.equal(outlook.tokenUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token')
  assert.ok(outlook.scopes.includes('https://outlook.office365.com/IMAP.AccessAsUser.All'))
  assert.ok(outlook.scopes.includes('offline_access'))

  const gmail = oauth.getOauthProviderConfig('gmail')
  assert.equal(gmail.authorizeUrl, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.ok(gmail.scopes.includes('https://mail.google.com/'))
  assert.equal(gmail.extraParams.access_type, 'offline')
  assert.equal(gmail.extraParams.prompt, 'consent')
  assert.equal(oauth.getOauthProviderConfig('qq'), undefined)
})
