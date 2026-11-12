'use strict'
// AI 连接解析与故障分类单元测试：纯函数，不触网、不读用户真实密钥、不触 DB。
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
const assert = require('node:assert/strict')
const {
  normalizeEndpoint,
  truncate,
  findProvider,
  resolveEffectiveConnection,
  deriveConnectionPatch,
  classifyHttpStatus,
  describeHttpError,
  redactSecrets
} = require('../.test-out/main/services/ai/connection.js')
const { AiCallError } = require('../.test-out/main/services/ai/analyzer.js')

let passed = 0
let failed = 0

function run(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
  }
}

const PROVIDERS = [
  { id: 'deepseek', apiKeyRequired: true },
  { id: 'local', apiKeyRequired: false, isLocal: true },
  { id: 'custom', apiKeyRequired: true }
]

// ---- normalizeEndpoint ----
run('端点归一化：协议/host 小写、path 保留大小写、去尾部斜杠', () => {
  assert.equal(normalizeEndpoint('  HTTPS://API.DeepSeek.com/v1/  '), 'https://api.deepseek.com/v1')
  assert.equal(normalizeEndpoint('https://api.deepseek.com/API'), 'https://api.deepseek.com/API')
  assert.equal(normalizeEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1')
})

run('端点归一化：空/非法/非 http(s) 返回空串', () => {
  assert.equal(normalizeEndpoint(''), '')
  assert.equal(normalizeEndpoint('   '), '')
  assert.equal(normalizeEndpoint('not a url'), '')
  assert.equal(normalizeEndpoint('ftp://example.com/v1'), '')
})

// ---- truncate ----
run('truncate 超长截断加省略号', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 3), 'abc…')
})

// ---- findProvider ----
run('findProvider 命中与未命中', () => {
  assert.equal(findProvider('deepseek', PROVIDERS).apiKeyRequired, true)
  assert.equal(findProvider('local', PROVIDERS).isLocal, true)
  assert.equal(findProvider('nope', PROVIDERS), undefined)
})

// ---- resolveEffectiveConnection：新 Key 优先 ----
run('新 Key 优先于已存 Key（keySource=input）', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'NEWKEY' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'OLDKEY', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, true)
  assert.equal(r.connection.apiKey, 'NEWKEY')
  assert.equal(r.connection.keySource, 'input')
})

// ---- 同端点复用已存 Key ----
run('同 provider + 归一化端点留空时复用已存 Key（keySource=saved）', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'SK-abc', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, true)
  assert.equal(r.connection.apiKey, 'SK-abc')
  assert.equal(r.connection.keySource, 'saved')
})

// ---- 换 provider 不复用 ----
run('换 provider 不复用已存 Key', () => {
  const r = resolveEffectiveConnection(
    { provider: 'custom', baseURL: 'https://api.deepseek.com/v1', model: 'm', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'SK-abc', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'config_missing')
})

// ---- 换端点不复用 ----
run('换端点不复用已存 Key', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v2', model: 'deepseek-chat', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'SK-abc', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'config_missing')
})

// ---- host 大小写同源可复用，path 大小写变化不复用 ----
run('host 大小写同源可复用已存 Key', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://API.DeepSeek.com/v1', model: 'deepseek-chat', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'SK-abc', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, true)
  assert.equal(r.connection.keySource, 'saved')
})

run('path 大小写变化不复用已存 Key（/v1 与 /V1 视为不同端点）', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/V1', model: 'deepseek-chat', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'SK-abc', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'config_missing')
})

// ---- 授权指纹指向别处（端点被改后未重新授权）不复用 ----
run('已存端点授权指纹指向别处时不复用旧 Key', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v2', model: 'deepseek-chat', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v2', apiKey: 'SK-abc', authorizedFor: 'deepseek|https://api.deepseek.com/v1' },
    PROVIDERS
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'config_missing')
})

// ---- 无授权指纹（旧数据）时端点匹配仍可复用 ----
run('无授权指纹时端点匹配仍可复用（向后兼容旧数据）', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'SK-legacy' },
    PROVIDERS
  )
  assert.equal(r.ok, true)
  assert.equal(r.connection.apiKey, 'SK-legacy')
  assert.equal(r.connection.keySource, 'saved')
})

// ---- local 无需 Key ----
run('本地/自托管端点无需 Key（keySource=none）', () => {
  const r = resolveEffectiveConnection(
    { provider: 'local', baseURL: 'http://localhost:11434/v1', model: 'llama3', apiKey: '' },
    null,
    PROVIDERS
  )
  assert.equal(r.ok, true)
  assert.equal(r.connection.apiKey, '')
  assert.equal(r.connection.keySource, 'none')
  assert.equal(r.connection.apiKeyRequired, false)
})

// ---- 未知 provider 默认需要 Key ----
run('未知 provider 默认需要 Key（apiKeyRequired=true）', () => {
  const r = resolveEffectiveConnection(
    { provider: 'unknown', baseURL: 'https://x/v1', model: 'm', apiKey: '' },
    null,
    PROVIDERS
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'config_missing')
})

// ---- 配置缺失 ----
run('配置缺失：缺 provider / model 返回 config_missing', () => {
  const p = PROVIDERS
  assert.equal(resolveEffectiveConnection({ provider: '', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' }, null, p).code, 'config_missing')
  assert.equal(resolveEffectiveConnection({ provider: 'deepseek', baseURL: 'https://x/v1', model: '', apiKey: 'k' }, null, p).code, 'config_missing')
})

// ---- 端点非法 ----
run('空/非法/非 http(s) baseURL 返回 endpoint_error', () => {
  const p = PROVIDERS
  assert.equal(resolveEffectiveConnection({ provider: 'deepseek', baseURL: '', model: 'm', apiKey: 'k' }, null, p).code, 'endpoint_error')
  assert.equal(resolveEffectiveConnection({ provider: 'deepseek', baseURL: 'not a url', model: 'm', apiKey: 'k' }, null, p).code, 'endpoint_error')
  assert.equal(resolveEffectiveConnection({ provider: 'deepseek', baseURL: 'ftp://x/v1', model: 'm', apiKey: 'k' }, null, p).code, 'endpoint_error')
})

// ---- 需要 Key 但未提供且不可复用 ----
run('需要 Key 但未提供且不可复用时返回 config_missing', () => {
  const r = resolveEffectiveConnection(
    { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
    null,
    PROVIDERS
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'config_missing')
})

// ---- classifyHttpStatus ----
run('HTTP 状态分类：401/403→unauthorized、429→rate_limited、其余→endpoint_error', () => {
  assert.equal(classifyHttpStatus(401), 'unauthorized')
  assert.equal(classifyHttpStatus(403), 'unauthorized')
  assert.equal(classifyHttpStatus(429), 'rate_limited')
  assert.equal(classifyHttpStatus(404), 'endpoint_error')
  assert.equal(classifyHttpStatus(500), 'endpoint_error')
})

// ---- describeHttpError 脱敏 ----
run('describeHttpError 分类 + 不回显密钥', () => {
  const info = describeHttpError(
    401,
    JSON.stringify({ error: { message: 'Incorrect API key: SK-verysecret123' } }),
    'SK-verysecret123'
  )
  assert.equal(info.code, 'unauthorized')
  assert.equal(info.status, 401)
  assert.ok(info.message.includes('鉴权失败'))
  assert.ok(!info.message.includes('SK-verysecret123'))
})

run('describeHttpError 限流与端点错误文案', () => {
  const rl = describeHttpError(429, '', undefined)
  assert.equal(rl.code, 'rate_limited')
  assert.ok(rl.message.includes('限流'))
  const ep = describeHttpError(500, '', undefined)
  assert.equal(ep.code, 'endpoint_error')
  assert.ok(ep.message.includes('端点或模型错误'))
})

// ---- redactSecrets ----
run('redactSecrets 替换密钥片段（含短 Key）', () => {
  assert.equal(redactSecrets('key is SK-abcdefgh', ['SK-abcdefgh']), 'key is ***')
  assert.equal(redactSecrets('no secret here', ['']), 'no secret here')
  assert.equal(redactSecrets('ab', ['ab']), '***')
  assert.equal(redactSecrets('key is ab and ab', ['ab']), 'key is *** and ***')
})

// ---- AiCallError 向后兼容 ----
run('AiCallError 旧构造（仅 message）仍可用，code/status 缺省', () => {
  const e = new AiCallError('模型返回为空')
  assert.equal(e.name, 'AiCallError')
  assert.equal(e.message, '模型返回为空')
  assert.equal(e.code, undefined)
  assert.equal(e.status, undefined)
})

run('AiCallError 扩展构造携带 code/status', () => {
  const e = new AiCallError('鉴权失败', 'unauthorized', 401)
  assert.equal(e.code, 'unauthorized')
  assert.equal(e.status, 401)
})

// ---- deriveConnectionPatch（保存路径：换端点清 Key/授权）----
const CUR = {
  aiProvider: 'deepseek',
  aiBaseURL: 'https://api.deepseek.com/v1',
  aiApiKey: 'SK-old',
  aiAuthorizedFor: 'deepseek|https://api.deepseek.com/v1',
  aiAuthorizedAt: '2026-10-17T00:00:00.000Z'
}

run('deriveConnectionPatch：端点不变不产生覆盖', () => {
  assert.deepEqual(deriveConnectionPatch(CUR, { aiModel: 'deepseek-reasoner' }), {})
})

run('deriveConnectionPatch：换端点且留空 Key → 清空 Key 与授权', () => {
  const d = deriveConnectionPatch(CUR, { aiBaseURL: 'https://api.deepseek.com/v2' })
  assert.equal(d.aiApiKey, '')
  assert.equal(d.aiAuthorizedFor, '')
  assert.equal(d.aiAuthorizedAt, '')
})

run('deriveConnectionPatch：换端点且提供新 Key → 不清 Key，但未重新授权清授权', () => {
  const d = deriveConnectionPatch(CUR, { aiBaseURL: 'https://api.deepseek.com/v2', aiApiKey: 'SK-new' })
  assert.equal(d.aiApiKey, undefined)
  assert.equal(d.aiAuthorizedFor, '')
  assert.equal(d.aiAuthorizedAt, '')
})

run('deriveConnectionPatch：换端点且显式重新授权 → 不清 Key 不清授权', () => {
  const d = deriveConnectionPatch(CUR, {
    aiBaseURL: 'https://api.deepseek.com/v2',
    aiApiKey: 'SK-new',
    aiAuthorizedFor: 'deepseek|https://api.deepseek.com/v2',
    aiAuthorizedAt: '2026-10-17T01:00:00.000Z'
  })
  assert.deepEqual(d, {})
})

run('deriveConnectionPatch：仅 host 大小写变化不算换端点（不触发清空）', () => {
  assert.deepEqual(deriveConnectionPatch(CUR, { aiBaseURL: 'https://API.DeepSeek.com/v1' }), {})
})

run('deriveConnectionPatch：path 大小写变化算换端点（触发清空）', () => {
  const d = deriveConnectionPatch(CUR, { aiBaseURL: 'https://api.deepseek.com/V1' })
  assert.equal(d.aiApiKey, '')
  assert.equal(d.aiAuthorizedFor, '')
})

run('deriveConnectionPatch：换 provider 触发清空', () => {
  const d = deriveConnectionPatch(CUR, { aiProvider: 'qwen' })
  assert.equal(d.aiApiKey, '')
  assert.equal(d.aiAuthorizedFor, '')
})

console.log('AI 连接解析测试：通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed > 0) process.exit(1)
