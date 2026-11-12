/**
 * 用真实模型跑「QCE 同步 → 切窗 → 抽取 → 日报」，验证实时采集链路。
 *
 * 前置：%TEMP%\im-mk.txt 里是 Chromium 主密钥的 hex（DPAPI 解出，见 DSHprogramfiles 说明）。
 * 运行：node scripts/im-qce-check.cjs
 * 环境：
 *   IM_QCE_DB       临时库路径（默认 %TEMP%\qce-check.db，每次重建）
 *   IM_QCE_LIMIT    每个会话最多拉多少条（默认 300）
 *   IM_QCE_SESSION  指定会话标题片段，缺省取消息最多的群
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createDecipheriv } = require('node:crypto')

function readSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const out = {}
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value)
    } catch {
      out[row.key] = row.value
    }
  }
  return out
}

function decryptV10(value, masterKey) {
  if (value.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('不是 v10 格式')
  const blob = value.subarray(3)
  const nonce = blob.subarray(0, 12)
  const tag = blob.subarray(blob.length - 16)
  const data = blob.subarray(12, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

async function main() {
  const masterFile = process.env.IM_MASTER_KEY_FILE || path.join(os.tmpdir(), 'im-mk.txt')
  const masterKey = Buffer.from(fs.readFileSync(masterFile, 'utf8').trim(), 'hex')
  if (masterKey.length !== 32) throw new Error('主密钥长度不对')

  const realDb = new DatabaseSync(path.join(process.env.APPDATA || '', 'InfoAgent', 'infoagent.db'))
  const settings = readSettings(realDb)
  realDb.close()
  const apiKey = decryptV10(
    Buffer.from(String(settings.aiApiKey).replace(/^enc:/, ''), 'base64'),
    masterKey
  )
  if (!apiKey || apiKey.length < 10) throw new Error('密钥解密失败')
  console.log('模型:', settings.aiProvider, settings.aiModel, '@', settings.aiBaseURL)

  const target = process.env.IM_QCE_DB || path.join(os.tmpdir(), 'qce-check.db')
  fs.rmSync(target, { force: true })
  fs.rmSync(target + '-wal', { force: true })
  fs.rmSync(target + '-shm', { force: true })
  const db = new DatabaseSync(target)
  require('../.test-out/main/db/migrations.js').migrate(db)

  const { chatCompletion } = require('../.test-out/main/services/ai/analyzer.js')
  const { ImService } = require('../.test-out/main/services/im/service.js')
  const service = new ImService({
    db,
    log: (message) => console.log('[im]', message),
    complete: (system, user, jsonMode) =>
      chatCompletion(
        { provider: settings.aiProvider, baseURL: settings.aiBaseURL, model: settings.aiModel, apiKey },
        system,
        user,
        jsonMode
      )
  })

  const started = Date.now()
  const synced = await service.syncQce({ limitPerSession: Number(process.env.IM_QCE_LIMIT || 300), enableNew: true })
  console.log('同步:', JSON.stringify(synced), Date.now() - started + 'ms')

  const sessions = service
    .listSessions()
    .filter((session) => session.messageCount > 0)
    .sort((a, b) => b.messageCount - a.messageCount)
  console.log(
    '有消息的会话:',
    sessions
      .slice(0, 6)
      .map((session) => `${session.title}(${session.messageCount})`)
      .join(', ')
  )

  const hint = process.env.IM_QCE_SESSION
  const target0 = hint
    ? sessions.find((session) => session.title.includes(hint))
    : sessions.find((session) => session.kind === 'group')
  if (!target0) throw new Error('没有可用会话')
  console.log('选中:', target0.id, target0.title, '消息', target0.messageCount)

  const t1 = Date.now()
  const result = await service.understand(target0.id, { provider: 'llm', force: true })
  console.log(`理解完成: ${result.windows} 窗口 / ${result.insights} 条结论 / ${Date.now() - t1}ms`)

  for (const item of service.listInsights({ sessionId: target0.id, limit: 40 })) {
    console.log(`- [${item.kind}] ${item.title}${item.dueAt ? ' @' + item.dueAt : ''} conf=${item.confidence}`)
  }

  const digest = service.digest()
  console.log('日报:\n' + digest.markdown.slice(0, 1500))
  db.close()
}

main().catch((error) => {
  console.error('失败:', error && error.message ? error.message : error)
  process.exit(1)
})
