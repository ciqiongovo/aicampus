/**
 * im-cli：不依赖 Electron 的命令行入口，用来先跑通整条链路。
 *
 * 示例：
 *   node dist/cli.js doctor
 *   node dist/cli.js import-qq demo/qq-export-sample.txt --title 产品讨论群 --json
 *   node dist/cli.js sessions
 *   node dist/cli.js status 1
 *   node dist/cli.js understand 1 --provider heuristic
 *   node dist/cli.js digest
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ImSessionInfo } from './shared/im'
import { IM_IPC } from './shared/im'
import { applyImMigrations } from './main/db/dao/imDao'
import { createComplete, llmConfigFromEnv } from './main/services/im/llm'
import { ImService } from './main/services/im/service'

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

const BOOLEAN_FLAGS = new Set(['enable', 'disable', 'json', 'help', 'force', 'all'])

function parseArgv(tokens: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1)
      continue
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      flags[body] = next
      index += 1
      continue
    }
    flags[body] = true
  }
  return { positional, flags }
}

function extractDbArg(tokens: string[]): { dbArg?: string; rest: string[] } {
  const rest: string[] = []
  let dbArg: string | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--db') {
      dbArg = tokens[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--db=')) {
      dbArg = token.slice('--db='.length)
      continue
    }
    rest.push(token)
  }
  return { dbArg, rest }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flags[name]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function printTable(rows: string[][], header: string[]): void {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length))
  )
  const pad = (value: string, width: number) => value + ' '.repeat(Math.max(width - value.length, 0))
  console.log(header.map((cell, column) => pad(cell, widths[column])).join('  '))
  for (const row of rows) {
    console.log(row.map((cell, column) => pad(cell ?? '', widths[column])).join('  '))
  }
}

function openDatabase(dbArg?: string): DatabaseSync {
  const target = dbArg ?? process.env.IM_DB_PATH
  const database = new DatabaseSync(target ?? ':memory:')
  applyImMigrations(database)
  return database
}

function resolveSession(service: ImService, target: string | undefined): ImSessionInfo {
  if (!target) fail('缺少会话参数：可以是会话 ID，也可以是标题片段')
  if (/^\d+$/.test(target)) {
    const session = service.listSessions().find((item) => item.id === Number(target))
    if (!session) fail(`找不到会话 ID ${target}`)
    return session
  }
  const matches = service.findSessionByTitle(target).filter((item) => item.messageCount > 0)
  if (matches.length === 0) fail(`找不到标题包含「${target}」的会话`)
  if (matches.length > 1) {
    console.error(`标题「${target}」匹配到 ${matches.length} 个会话，请改用 ID：`)
    for (const item of matches) console.error(`  ${item.id}\t${item.title}`)
    process.exit(2)
  }
  return matches[0]
}

const KINDS = ['topic', 'decision', 'todo', 'fact', 'link', 'question'] as const

function printUsage(): void {
  console.log('im-cli <命令> [参数] [--db 路径] [--json]')
  console.log('')
  for (const command of commands) {
    console.log(`  ${command.usage}`)
    console.log(`      ${command.summary}`)
  }
}

interface Command {
  name: string
  usage: string
  summary: string
  run: (service: ImService, args: ParsedArgs) => Promise<void> | void
}

const commands: Command[] = [
  {
    name: 'doctor',
    usage: 'doctor',
    summary: '检查数据库、FTS5、微信/QQ 目录、chatlog 侧车与模型配置',
    run: async (service) => {
      const report = await service.doctor()
      printJson(report)
    }
  },
  {
    name: 'import-qq',
    usage: 'import-qq <导出文件...> [--title 会话名] [--disable]',
    summary: '导入 QQ 消息管理器导出的 txt（可一次传多个文件）',
    run: async (service, args) => {
      const files = args.positional
      if (files.length === 0) fail('用法：import-qq <导出文件.txt> [--title 会话名]')
      const outcome = await service.importQqFiles(files, {
        title: stringFlag(args.flags, 'title'),
        enable: args.flags.disable !== true
      })
      printJson({
        accountId: outcome.accountId,
        inserted: outcome.result.inserted,
        updated: outcome.result.updated,
        sessions: outcome.sessions.map((item) => ({
          id: item.id,
          title: item.title,
          messageCount: item.messageCount
        }))
      })
    }
  },
  {
    name: 'sync',
    usage: 'sync [--url http://127.0.0.1:5030] [--token xxx] [--all] [--limit 1000]',
    summary: '通过 chatlog 拉取微信新消息（默认只同步已启用的会话）',
    run: async (service, args) => {
      const result = await service.syncWechat({
        baseUrl: stringFlag(args.flags, 'url'),
        token: stringFlag(args.flags, 'token'),
        onlyEnabled: args.flags.all !== true,
        limit: numberFlag(args.flags, 'limit')
      })
      printJson(result)
      if (!result.ok) process.exitCode = 1
    }
  },
  {
    name: 'sessions',
    usage: 'sessions [--account 1]',
    summary: '列出已采集的会话，标记启用状态与消息条数',
    run: (service, args) => {
      const sessions = service.listSessions(numberFlag(args.flags, 'account'))
      if (sessions.length === 0) {
        console.log('还没有采集到任何会话。先用 import-qq 导入导出文件，或启动 chatlog 后 sync。')
        return
      }
      printTable(
        sessions.map((item) => [
          String(item.id),
          item.title || item.platformSessionId,
          item.kind,
          String(item.messageCount),
          item.lastMsgAt ?? '-',
          item.enabled ? 'on' : 'off'
        ]),
        ['ID', '会话', '类型', '条数', '最近消息', '启用']
      )
    }
  },
  {
    name: 'enable',
    usage: 'enable <会话ID|标题>',
    summary: '开启某个会话的同步与理解',
    run: (service, args) => {
      const session = resolveSession(service, args.positional[0])
      service.setSessionEnabled(session.id, true)
      console.log(`已启用会话 ${session.id}「${session.title}」`)
    }
  },
  {
    name: 'disable',
    usage: 'disable <会话ID|标题>',
    summary: '暂停某个会话（不删除已采集数据）',
    run: (service, args) => {
      const session = resolveSession(service, args.positional[0])
      service.setSessionEnabled(session.id, false)
      console.log(`已暂停会话 ${session.id}「${session.title}」`)
    }
  },
  {
    name: 'status',
    usage: 'status <会话ID|标题>',
    summary: '查看会话概况、滚动摘要和待确认的结论',
    run: (service, args) => {
      const session = resolveSession(service, args.positional[0])
      const insights = service.listInsights({ sessionId: session.id })
      printJson({
        session: {
          id: session.id,
          title: session.title,
          kind: session.kind,
          messageCount: session.messageCount,
          lastSeq: session.lastSeq,
          summarySeq: session.summarySeq,
          lastMsgAt: session.lastMsgAt
        },
        summary: session.summary,
        insights: insights.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          detail: item.detail,
          status: item.status
        }))
      })
    }
  },
  {
    name: 'understand',
    usage: 'understand <会话ID|标题> [--provider auto|llm|heuristic] [--force] [--limit 5]',
    summary: '对未理解的窗口做抽取；配置了模型就走模型，否则走规则抽取',
    run: async (service, args) => {
      const session = resolveSession(service, args.positional[0])
      const provider = stringFlag(args.flags, 'provider')
      if (provider && provider !== 'auto' && provider !== 'llm' && provider !== 'heuristic') {
        fail('--provider 只能是 auto、llm 或 heuristic')
      }
      const result = await service.understand(session.id, {
        provider: provider === 'auto' ? undefined : (provider as 'llm' | 'heuristic' | undefined),
        force: args.flags.force === true,
        maxWindows: numberFlag(args.flags, 'limit')
      })
      printJson(result)
      if (!result.ok) process.exitCode = 1
    }
  },
  {
    name: 'insights',
    usage: 'insights [--session 1] [--kind todo] [--day 2026-10-17] [--status new]',
    summary: '按条件查看已抽取的结论',
    run: (service, args) => {
      const kind = stringFlag(args.flags, 'kind')
      if (kind && !KINDS.includes(kind as (typeof KINDS)[number])) {
        fail(`--kind 只能是 ${KINDS.join('、')}`)
      }
      const status = stringFlag(args.flags, 'status')
      if (status && status !== 'new' && status !== 'accepted' && status !== 'dismissed') {
        fail('--status 只能是 new、accepted 或 dismissed')
      }
      const items = service.listInsights({
        sessionId: numberFlag(args.flags, 'session'),
        kind: kind as (typeof KINDS)[number] | undefined,
        day: stringFlag(args.flags, 'day'),
        status: status as 'new' | 'accepted' | 'dismissed' | undefined
      })
      if (items.length === 0) {
        console.log('没有匹配的结论。')
        return
      }
      printTable(
        items.map((item) => [
          String(item.id),
          item.kind,
          item.status,
          item.sessionTitle.slice(0, 18),
          item.title.slice(0, 40)
        ]),
        ['ID', '类型', '状态', '会话', '内容']
      )
    }
  },
  {
    name: 'digest',
    usage: 'digest [日期 YYYY-MM-DD] [--out 目录]',
    summary: '汇总某天的结论为 Markdown（默认今天，写到 demo/out）',
    run: (service, args) => {
      const result = service.digest(args.positional[0] ?? stringFlag(args.flags, 'day'))
      const outDir = process.env.IM_DIGEST_DIR ?? path.join(process.cwd(), 'demo', 'out')
      mkdirSync(outDir, { recursive: true })
      const file = path.join(outDir, `digest-${result.date}.md`)
      writeFileSync(file, `${result.markdown}\n`, 'utf8')
      console.log(result.markdown)
      console.log(`\n已写入 ${file}`)
    }
  },
  {
    name: 'search',
    usage: 'search <关键词> [--session 1] [--limit 20]',
    summary: '全文检索消息（FTS5 trigram，不可用时退化为 LIKE）',
    run: (service, args) => {
      const query = args.positional[0]
      if (!query) fail('用法：search <关键词>')
      const result = service.search(query, numberFlag(args.flags, 'session'), numberFlag(args.flags, 'limit'))
      if (result.items.length === 0) {
        console.log('没有命中。')
        return
      }
      console.log(`命中 ${result.total} 条（${result.mode === 'fts' ? 'FTS5 trigram' : 'LIKE 退化'}）`)
      const titles = new Map(service.listSessions().map((item) => [item.id, item.title]))
      for (const hit of result.items) {
        const title = titles.get(hit.sessionId) ?? `会话 ${hit.sessionId}`
        console.log(`[${hit.sentAt}] ${title} · ${hit.senderName || hit.senderId}`)
        console.log(`    ${hit.text.slice(0, 200)}`)
      }
    }
  },
  {
    name: 'llm-check',
    usage: 'llm-check',
    summary: '用当前环境变量测一次模型调用',
    run: async () => {
      const config = llmConfigFromEnv()
      if (!config) {
        fail('未配置模型：需要 IM_LLM_API_KEY（或 DEEPSEEK_API_KEY / OPENAI_API_KEY）与 IM_LLM_BASE_URL、IM_LLM_MODEL')
      }
      const complete = createComplete(config)
      const answer = await complete(
        '你是连通性测试助手，只输出 JSON。',
        '输出 {"ok":true}，不要多余文字。',
        true
      )
      printJson({ ok: true, model: config.model, baseUrl: config.baseUrl, answer: answer.slice(0, 500) })
    }
  },
  {
    name: 'demo',
    usage: 'demo [--file 导出文件] [--session 1]',
    summary: '一键跑通：导入示例导出文件 → 规则理解 → 生成当日摘要',
    run: async (service, args) => {
      const file = stringFlag(args.flags, 'file') ?? path.join(process.cwd(), 'demo', 'qq-export-sample.txt')
      const imported = await service.importQqFiles([file], { title: stringFlag(args.flags, 'title') })
      console.log(`导入完成：新增 ${imported.result.inserted} 条消息`)
      const session =
        imported.sessions.find((item) => item.messageCount > 0) ??
        resolveSession(service, stringFlag(args.flags, 'session'))
      console.log(`选中会话 ${session.id}「${session.title}」（${session.messageCount} 条）`)
      const understood = await service.understand(session.id, { provider: 'heuristic', force: true })
      console.log(`理解完成：${understood.windows} 个窗口，${understood.insights} 条结论`)

      const days = [
        ...new Set(
          service
            .listMessages(session.id, undefined, 500)
            .items.map((item) => item.sentAt.slice(0, 10))
        )
      ].sort()
      const outDir = process.env.IM_DIGEST_DIR ?? path.join(process.cwd(), 'demo', 'out')
      mkdirSync(outDir, { recursive: true })
      for (const day of days) {
        const digest = service.digest(day)
        writeFileSync(path.join(outDir, `digest-${digest.date}.md`), `${digest.markdown}\n`, 'utf8')
        console.log('')
        console.log(digest.markdown)
      }
      console.log(`\n已写入 ${outDir}`)
    }
  },
  {
    name: 'channels',
    usage: 'channels',
    summary: '打印本模块注册的 IPC 通道，接入时对照用',
    run: () => {
      printJson(IM_IPC)
    }
  }
]

async function main(): Promise<void> {
  const { dbArg, rest } = extractDbArg(process.argv.slice(2))
  const [name, ...tokens] = rest

  if (!name || name === 'help' || name === '--help') {
    printUsage()
    return
  }

  const command = commands.find((item) => item.name === name)
  if (!command) fail(`未知命令：${name}\n用 im-cli help 查看可用命令`)

  const args = parseArgv(tokens)
  if (args.flags.help === true) {
    console.log(`用法：im-cli ${command.usage}\n      ${command.summary}`)
    return
  }

  const db = openDatabase(dbArg)
  try {
    const config = llmConfigFromEnv()
    const service = new ImService({
      db,
      dbPath: dbArg ?? process.env.IM_DB_PATH ?? ':memory:',
      complete: config ? createComplete(config) : undefined,
      log: (message) => console.error(`[im] ${message}`)
    })
    await command.run(service, args)
  } finally {
    db.close()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exit(1)
  })
}

export { commands, main, parseArgv, resolveSession }
