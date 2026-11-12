/**
 * 用应用里已配置的真实模型跑「导入 → 抽取 → 日报」，验证模型链路。
 *
 * 前置：先用 PowerShell 通过 DPAPI 解开 Chromium 主密钥并写入 %TEMP%\im-mk.txt
 * （见 DSHprogramfiles 里的说明；密钥只在内存中使用，不打印、不写库）。
 *
 * 运行：node scripts/im-ai-check.cjs [导出文件]
 * 环境：IM_CHECK_DB 指定库副本；IM_MASTER_KEY_FILE 指定主密钥文件。
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

/** Chromium/Electron 在 Windows 上的 v10 格式：AES-256-GCM，主密钥由 DPAPI 保护。 */
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

  const dbPath = process.env.IM_CHECK_DB || path.join(process.env.APPDATA || '', 'InfoAgent', 'infoagent.db')
  console.log('数据库:', dbPath)
  const db = new DatabaseSync(dbPath)
  const settings = readSettings(db)
  const raw = Buffer.from(String(settings.aiApiKey).replace(/^enc:/, ''), 'base64')
  const apiKey = decryptV10(raw, masterKey)
  if (!apiKey || apiKey.length < 10) throw new Error('密钥解密失败')
  console.log('模型:', settings.aiProvider, settings.aiModel, '@', settings.aiBaseURL, '（密钥已解密，长度', apiKey.length, '）')

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

  const file =
    process.argv[2] || path.join(__dirname, '..', 'tools', 'im-connector', 'demo', 'qq-export-sample.txt')
  const imported = await service.importQqFiles([file], { title: '产品讨论群(88776655)', enable: true })
  console.log('导入:', JSON.stringify(imported))

  const sessions = service.listSessions()
  const session = sessions[0]
  if (!session) throw new Error('没有会话')
  console.log('会话:', session.id, session.title, '消息数', session.messageCount)

  const started = Date.now()
  const result = await service.understand(session.id, { provider: 'llm', force: true })
  console.log(`理解完成: ${result.windows} 窗口 / ${result.insights} 条结论 / ${Date.now() - started}ms`)

  for (const item of service.listInsights({ sessionId: session.id, limit: 100 })) {
    console.log(`- [${item.kind}] ${item.title}${item.dueAt ? ' @' + item.dueAt : ''} conf=${item.confidence}`)
  }
}

main().catch((error) => {
  console.error('失败:', error && error.message ? error.message : error)
  process.exit(1)
})
