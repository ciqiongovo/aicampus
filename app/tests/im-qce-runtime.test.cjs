const test = require('node:test')
const assert = require('node:assert')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  QceRuntime,
  derivePhase,
  isLegacyQqPath,
  resolveQceDir,
  resolveQqExecutable,
  tailLogLines,
  QCE_START_TIMEOUT_MS
} = require('../.test-out/main/services/im/qceRuntime.js')

test('状态机：在线优先，其次错误、等待扫码、超时', () => {
  const base = {
    platform: 'win32',
    runtimeReady: true,
    qqPath: 'C:\\QQ\\QQ.exe',
    online: false,
    reachable: false,
    tokenFound: false,
    launchedAt: null,
    now: 1000,
    failedCode: null
  }
  assert.equal(derivePhase({ ...base, platform: 'darwin' }), 'unsupported')
  assert.equal(derivePhase({ ...base, online: true, failedCode: 'E_LAUNCH_FAILED' }), 'online')
  assert.equal(derivePhase({ ...base, failedCode: 'E_QQ_NOT_FOUND' }), 'error')
  assert.equal(derivePhase({ ...base, reachable: true, tokenFound: true }), 'waiting_login')
  assert.equal(derivePhase({ ...base, runtimeReady: false }), 'missing_runtime')
  assert.equal(derivePhase({ ...base, launchedAt: 1000, now: 1000 + QCE_START_TIMEOUT_MS - 1 }), 'starting')
  assert.equal(derivePhase({ ...base, launchedAt: 1000, now: 1000 + QCE_START_TIMEOUT_MS }), 'error')
  assert.equal(derivePhase({ ...base, qqPath: null, tokenFound: true }), 'qq_not_found')
  assert.equal(derivePhase(base), 'stopped')
})

test('QQ 路径解析：保存值优先，旧版 QQ 拒绝', () => {
  const exists = (path) => path === 'D:\\QQNT\\QQ.exe' || path === 'C:\\old\\Bin\\QQ.exe'
  assert.deepEqual(
    resolveQqExecutable({ saved: 'D:\\QQNT\\QQ.exe', envPath: null, commonPaths: [], exists }),
    { qqPath: 'D:\\QQNT\\QQ.exe', code: null }
  )
  assert.deepEqual(
    resolveQqExecutable({ saved: null, envPath: 'C:\\old\\Bin\\QQ.exe', commonPaths: [], exists }),
    { qqPath: null, code: 'E_QQ_TOO_OLD' }
  )
  assert.deepEqual(resolveQqExecutable({ saved: null, envPath: null, commonPaths: [], exists }), {
    qqPath: null,
    code: null
  })
  assert.equal(isLegacyQqPath('C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe'), true)
  assert.equal(isLegacyQqPath('C:\\Program Files\\Tencent\\QQNT\\QQ.exe'), false)
})

test('运行集定位：打包后从 resources/resources/qce 读取', () => {
  const exists = (path) => path.endsWith('launcher-user.bat') || path.endsWith('qce-server.exe')
  assert.equal(
    resolveQceDir({ isPackaged: true, resourcesPath: 'C:\\App\\resources', appPath: 'C:\\App\\resources\\app.asar', exists }),
    join('C:\\App\\resources', 'resources', 'qce')
  )
})

test('日志尾部脱敏并截断', () => {
  const lines = tailLogLines(['a', 'accessToken: abc123', 'b', 'c'].join('\n'), 2)
  assert.deepEqual(lines, ['b', 'c'])
  assert.deepEqual(tailLogLines('accessToken=secret-token\nok', 5), ['accessToken=***', 'ok'])
})

test('运行集状态与启动/退出登录生命周期', async () => {
  const root = mkdtempSync(join(tmpdir(), 'infoagent-qce-'))
  try {
    const qceDir = join(root, 'resources', 'qce')
    mkdirSync(join(qceDir, 'plugins', 'napcat-plugin-qce'), { recursive: true })
    writeFileSync(join(qceDir, 'launcher-user.bat'), '@echo off\r\n')
    writeFileSync(join(qceDir, 'qce-server.exe'), '')
    writeFileSync(join(qceDir, 'plugins', 'napcat-plugin-qce', 'package.json'), '{"version":"6.3.2"}')
    const qqPath = join(root, 'QQ', 'QQ.exe')
    mkdirSync(join(root, 'QQ'), { recursive: true })
    writeFileSync(qqPath, '')
    mkdirSync(join(qceDir, 'config'), { recursive: true })
    writeFileSync(join(qceDir, 'config', 'qq_path.txt'), qqPath)

    let token = null
    let now = 1_000_000
    const runtime = new QceRuntime({
      appPath: root,
      resourcesPath: root,
      isPackaged: false,
      userDataPath: join(root, 'userData'),
      platform: 'win32',
      execFn: () => '',
      tokenReader: () => token,
      healthProbe: async () => ({ online: false, mode: 'offline', reachable: false }),
      now: () => now,
      sleep: async () => undefined,
      spawnFn: () => ({
        pid: 4321,
        once: () => undefined,
        kill: () => true,
        stdout: { on: () => undefined },
        stderr: { on: () => undefined }
      })
    })

    const initial = await runtime.status()
    assert.equal(initial.phase, 'stopped')
    assert.equal(initial.runtimeVersion, '6.3.2')
    assert.equal(initial.qqPath, qqPath)

    const launching = await runtime.launch()
    assert.equal(launching.phase, 'starting')

    token = 'live-token'
    const waiting = await runtime.status()
    assert.equal(waiting.phase, 'starting')

    now += QCE_START_TIMEOUT_MS
    const timedOut = await runtime.status()
    assert.equal(timedOut.phase, 'error')
    assert.equal(timedOut.code, 'E_TOKEN_TIMEOUT')

    const afterLogout = await runtime.logout()
    runtime.dispose()
    assert.equal(afterLogout.phase, 'stopped')
    assert.equal(afterLogout.launchedAt, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺少运行集时启动给出 E_RUNTIME_MISSING', async () => {
  const root = mkdtempSync(join(tmpdir(), 'infoagent-qce-empty-'))
  try {
    const runtime = new QceRuntime({
      appPath: root,
      resourcesPath: root,
      isPackaged: false,
      userDataPath: join(root, 'userData'),
      platform: 'win32',
      execFn: () => '',
      tokenReader: () => null,
      healthProbe: async () => ({ online: false, mode: 'offline' }),
      sleep: async () => undefined
    })
    const result = await runtime.launch()
    assert.equal(result.phase, 'error')
    assert.equal(result.code, 'E_RUNTIME_MISSING')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
