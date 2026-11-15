/**
 * 对标库命令行。
 *
 * 存在的理由：图形界面能做的事，命令行也得能做一遍。批量补历史数据、
 * 在服务器上跑定时采集、或者只是想确认「抓回来的东西到底长什么样」，
 * 开一个 Electron 应用都太笨重。
 *
 * 与界面共用同一套 DAO、同一套判定、同一套抽取提示词，所以两边看到的
 * 数据不会分叉。唯一的差别是渲染后端：这里固定走外部浏览器无头模式。
 *
 * 用法：
 *   node tools/bench/dist/cli.mjs stats
 *   node tools/bench/dist/cli.mjs import links.txt
 *   node tools/bench/dist/cli.mjs fetch --limit 20
 *   node tools/bench/dist/cli.mjs extract --limit 20 [--llm]
 *   node tools/bench/dist/cli.mjs list --limit 20
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../app/src/main/db/database'
import * as dao from '../../app/src/main/db/dao/benchmarkDao'
import { articleUrlKey, guessSchool, parsePublishTime } from '../../app/src/shared/benchmark'
import { judgePage, VERIFY_BLOCKED } from '../../app/src/main/services/benchmark/page'
import { parseArticleHtml, renderHtml } from '../../app/src/main/services/benchmark/render-edge'
import { extractByRules } from '../../app/src/main/services/benchmark/rule-extract'
import { extractActivity } from '../../app/src/main/services/benchmark/extractor'
import { composeBrief } from '../../app/src/main/services/benchmark/brief'
import { discoverSchool } from '../../app/src/main/services/benchmark/discover'
import { HOME_SCHOOL, KNOWN_ACCOUNTS, SHANGHAI_SCHOOLS } from '../../app/src/shared/schools'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 两篇之间的间隔。微信对同一出口 IP 的连续访问有阈值，抓得太密会整批被挡 */
const GAP_MIN_MS = 2500
const GAP_MAX_MS = 5500

/** 连续几次撞验证就停手：再抓下去每一篇都会变成 unreachable，白白污染队列 */
const VERIFY_BREAKER = 3

/**
 * 默认库位置与 Electron 保持一致。
 *
 * 1.0 起应用改名为「知枢」，库搬到 %APPDATA%/ZhiShu/zhishu.db；
 * 老库还留在 InfoAgent 目录里，所以先找新位置，找不到再退回旧的，
 * 免得升级之后命令行工具突然说「没有数据库」。
 */
function defaultDbPath(): string {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
  const fresh = join(appData, 'ZhiShu', 'zhishu.db')
  if (existsSync(fresh)) return fresh
  return join(appData, 'InfoAgent', 'infoagent.db')
}

interface Args {
  cmd: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { cmd: positional[0] ?? 'help', positional: positional.slice(1), flags }
}

const num = (v: string | boolean | undefined, fallback: number): number =>
  typeof v === 'string' && !Number.isNaN(Number(v)) ? Number(v) : fallback

function openDb(args: Args) {
  const dbPath = typeof args.flags.db === 'string' ? args.flags.db : defaultDbPath()
  if (!existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`)
    console.error('先启动一次应用（会建库），或用 --db 指定路径。')
    process.exit(1)
  }
  const db = openDatabase(dbPath)
  // 与界面一样：老库缺学校清单时补上，命令行才看得到「上科大是本校、它有哪些号」
  dao.seedSchools(db, SHANGHAI_SCHOOLS, HOME_SCHOOL, KNOWN_ACCOUNTS)
  console.log(`库：${dbPath}`)
  return db
}

async function cmdStats(args: Args): Promise<void> {
  const db = openDb(args)
  const s = dao.stats(db)
  console.log(`源 ${s.sources}  文章 ${s.articles}  活动 ${s.activities}  原文已删 ${s.deleted}`)
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM bench_article GROUP BY status ORDER BY n DESC')
    .all() as { status: string; n: number }[]
  console.log('状态分布：' + byStatus.map((r) => `${r.status}=${r.n}`).join('  '))
  const bySchool = db
    .prepare(
      `SELECT COALESCE(NULLIF(s.school,''),'(未填学校)') AS school, COUNT(*) AS n
         FROM bench_article a LEFT JOIN bench_source s ON s.id = a.source_id
        GROUP BY school ORDER BY n DESC LIMIT 12`
    )
    .all() as { school: string; n: number }[]
  if (bySchool.length) console.log('按学校：' + bySchool.map((r) => `${r.school}=${r.n}`).join('  '))
  db.close()
}

async function cmdImport(args: Args): Promise<void> {
  const db = openDb(args)
  const source = args.positional[0]
  if (!source) {
    console.error('用法：import <文件路径|->  （- 表示从标准输入读）')
    process.exit(1)
  }
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
  const urls = text.match(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s"'<>\]]*/g) ?? []
  let accepted = 0
  let duplicated = 0
  let invalid = 0
  const seen = new Set<string>()
  for (const url of urls) {
    const clean = url.replace(/&amp;/g, '&').split('#')[0]
    const key = articleUrlKey(clean)
    if (!key) {
      invalid += 1
      continue
    }
    if (seen.has(key)) {
      duplicated += 1
      continue
    }
    seen.add(key)
    if (dao.enqueueArticle(db, { urlKey: key, url: clean, sourceId: null })) accepted += 1
    else duplicated += 1
  }
  console.log(`新增 ${accepted}，重复 ${duplicated}，无法识别 ${invalid}`)
  db.close()
}

async function cmdFetch(args: Args): Promise<void> {
  const db = openDb(args)
  const limit = num(args.flags.limit, 20)
  const queue = dao.pendingArticles(db, limit)
  if (!queue.length) {
    console.log('队列空：没有 status=new 的文章')
    db.close()
    return
  }
  let ok = 0
  let deleted = 0
  let unreachable = 0
  let imageOnly = 0
  let blocked = 0
  const started = Date.now()
  for (const [i, item] of queue.entries()) {
    // 第一轮不用等，后面每篇之间留一点间隔
    if (i > 0) await sleep(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS))
    const t0 = Date.now()
    const html = await renderHtml(item.url, 45000)
    const page = html ? parseArticleHtml(html) : null
    const outcome = page
      ? judgePage(page, parsePublishTime)
      : { status: 'unreachable' as const, title: '', author: '', publishedAt: null, body: '', error: '未渲染出来' }

    if (outcome.status === 'ok') {
      const sourceId = dao.ensureSourceByName(db, outcome.author) ?? undefined
      dao.markFetched(db, item.id, {
        title: outcome.title,
        author: outcome.author,
        publishedAt: outcome.publishedAt,
        body: outcome.body,
        sourceId
      })
      if (outcome.imageOnly) {
        // 纯图推送：归档，不占抽取队列，也不算失败
        dao.markSkipped(db, item.id, outcome.error)
        imageOnly += 1
      } else {
        ok += 1
      }
      blocked = 0
    } else {
      dao.markFetchFailed(db, item.id, outcome.status === 'deleted' ? 'deleted' : 'unreachable', outcome.error)
      if (outcome.status === 'deleted') {
        deleted += 1
        blocked = 0
      } else {
        unreachable += 1
      }
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    const label = outcome.status === 'ok' ? outcome.title.slice(0, 30) || '(无标题)' : outcome.error
    console.log(`[${i + 1}/${queue.length}] ${outcome.status.padEnd(11)} ${dt}s  ${label}`)

    if (outcome.error === VERIFY_BLOCKED) {
      blocked += 1
      if (blocked >= VERIFY_BREAKER) {
        console.log(
          `\n连续 ${blocked} 篇撞上微信人机验证，先停下。\n` +
            `被挡的文章停在 unreachable，下次还能重试；剩余 ${queue.length - i - 1} 篇没有动。\n` +
            `建议过 20–30 分钟再跑，或换一个网络出口。`
        )
        break
      }
    }
  }
  console.log(
    `\n采集完成：正文可抽 ${ok}，纯图 ${imageOnly}，原文已删 ${deleted}，暂不可见 ${unreachable}，` +
      `用时 ${((Date.now() - started) / 1000).toFixed(0)}s`
  )
  db.close()
}

/**
 * 抽取。
 *
 * --llm 时走模型（需要 BENCH_API_KEY / BENCH_BASE_URL / BENCH_MODEL），
 * 否则用规则。规则版抽不到议程和可迁移性，这是已知的，不是 bug。
 */
async function cmdExtract(args: Args): Promise<void> {
  const db = openDb(args)
  const limit = num(args.flags.limit, 20)
  const useLlm = args.flags.llm === true
  const apiKey = typeof args.flags.key === 'string' ? args.flags.key : process.env.BENCH_API_KEY ?? ''
  const baseURL = typeof args.flags.base === 'string' ? args.flags.base : process.env.BENCH_BASE_URL ?? 'https://api.deepseek.com/v1'
  const model = typeof args.flags.model === 'string' ? args.flags.model : process.env.BENCH_MODEL ?? 'deepseek-chat'

  if (useLlm && !apiKey) {
    console.error('--llm 需要 key：用 --key 传入，或设环境变量 BENCH_API_KEY')
    process.exit(1)
  }

  const queue = dao.pendingExtract(db, limit)
  if (!queue.length) {
    console.log('没有待抽取的文章（需要 status=fetched）')
    db.close()
    return
  }
  console.log(useLlm ? `模型：${model} @ ${baseURL}` : '抽取方式：规则（未启用模型）')

  let activities = 0
  let skipped = 0
  let failed = 0
  for (const [i, item] of queue.entries()) {
    try {
      const extracted = useLlm
        ? await extractActivity({ provider: 'openai', baseURL, model, apiKey }, { title: item.title, body: item.body })
        : extractByRules({ title: item.title, body: item.body, publishedAt: item.publishedAt })

      if (!extracted.isActivity) {
        dao.markSkipped(db, item.id)
        skipped += 1
        continue
      }
      dao.upsertActivity(db, item.id, {
        kind: extracted.kind,
        organizer: extracted.organizer,
        startAt: extracted.startAt,
        endAt: extracted.endAt,
        weekNo: extracted.weekNo,
        location: extracted.location,
        audience: extracted.audience,
        orgForm: extracted.orgForm,
        joinMethod: extracted.joinMethod,
        coOrganizer: extracted.coOrganizer,
        duration: extracted.duration,
        scale: extracted.scale,
        promoChannels: extracted.promoChannels,
        agenda: extracted.agenda,
        highlights: extracted.highlights,
        isSecondNotice: extracted.isSecondNotice,
        noticeKind: extracted.noticeKind,
        migrationFit: extracted.migrationFit,
        migrationNote: extracted.migrationNote,
        confidence: extracted.confidence,
        model: useLlm ? model : 'rule'
      })
      activities += 1
      console.log(
        `[${i + 1}/${queue.length}] ${extracted.kind}  ` +
          `${extracted.startAt ?? '时间未知'}  ${extracted.location || '地点未知'}  ` +
          `${Math.round(extracted.confidence * 100)}%`
      )
    } catch (error) {
      failed += 1
      const msg = error instanceof Error ? error.message : String(error)
      dao.markExtractFailed(db, item.id, msg)
      console.log(`[${i + 1}/${queue.length}] 失败 ${msg.slice(0, 80)}`)
    }
  }
  console.log(`\n抽取完成：活动 ${activities}，非活动 ${skipped}，失败 ${failed}`)
  db.close()
}

async function cmdRetry(args: Args): Promise<void> {
  const db = openDb(args)
  const holdMin = num(args.flags.hold, 0)
  const n = dao.resetUnreachable(db, holdMin * 60 * 1000)
  console.log(`已把 ${n} 篇「暂不可见」放回队列（status=new），可以重新 fetch`)
  db.close()
}

async function cmdBrief(args: Args): Promise<void> {
  const db = openDb(args)
  const filter = {
    school: typeof args.flags.school === 'string' ? args.flags.school : undefined,
    kind: typeof args.flags.kind === 'string' ? args.flags.kind : undefined,
    keyword: typeof args.flags.keyword === 'string' ? args.flags.keyword : undefined,
    from: typeof args.flags.from === 'string' ? args.flags.from : undefined,
    limit: num(args.flags.limit, 200)
  }
  const rows = dao.briefRows(db, filter)
  const label = [filter.school, filter.kind, filter.keyword].filter(Boolean).join(' · ') || '全部活动'
  const brief = composeBrief(rows, label, new Date())
  const out = typeof args.flags.out === 'string' ? args.flags.out : ''
  if (out) {
    writeFileSync(out, brief.markdown, 'utf8')
    console.log(`简报已写入 ${out}（${brief.schoolCount} 所学校 / ${brief.activityCount} 场活动）`)
  } else {
    console.log(brief.markdown)
  }
  db.close()
}

async function cmdList(args: Args): Promise<void> {
  const db = openDb(args)
  const rows = dao.listArticles(db, {
    school: typeof args.flags.school === 'string' ? args.flags.school : undefined,
    kind: typeof args.flags.kind === 'string' ? args.flags.kind : undefined,
    limit: num(args.flags.limit, 20)
  })
  for (const r of rows) {
    console.log(
      `${String(r.id).padStart(4)} ${(r.school || '—').padEnd(10)} ${(r.kind || '—').padEnd(8)} ` +
        `${r.weekNo ? `约${r.weekNo}周` : '—'} ${(r.title || r.url).slice(0, 40)}`
    )
  }
  console.log(`共 ${rows.length} 条`)
  db.close()
}

async function cmdSources(args: Args): Promise<void> {
  const db = openDb(args)
  if (args.positional[0] === 'add') {
    const name = args.flags.name
    const school = args.flags.school
    if (typeof name !== 'string' || typeof school !== 'string') {
      console.error('用法：sources add --name "复旦大学学生会" --school 复旦大学')
      process.exit(1)
    }
    const id = dao.upsertSource(db, { name, school, category: 'student_union' })
    console.log(`已加入：${school} / ${name}（id=${id}）`)
    db.close()
    return
  }
  const rows = dao.listSources(db)
  if (args.positional[0] === 'reguess') {
    // 识别规则改过之后，旧数据的学校还停在老结果上，得能重算一遍。
    // 只补空值和纠错，不覆盖用户手工改过的——手工填的永远更可信。
    let changed = 0
    for (const s of rows) {
      // 先看名字里有没有校名，再看它是不是某校已确认的号：
      // 「书院的天空」这种花名只能靠后一条认出来
      const guessed = guessSchool(s.name) || dao.schoolOfKnownAccount(db, s.name)
      if (!guessed || guessed === s.school) continue
      if (s.school && s.school !== guessed) {
        console.log(`保留手填：${s.name} → ${s.school}（规则猜 ${guessed}）`)
        continue
      }
      db.prepare('UPDATE bench_source SET school = ? WHERE id = ?').run(guessed, s.id)
      console.log(`${s.name} → ${guessed}`)
      changed += 1
    }
    console.log(`更新 ${changed} 个源`)
    db.close()
    return
  }
  for (const s of rows) {
    console.log(`${String(s.id).padStart(3)} ${s.school || '(未填学校)'.padEnd(12)} ${s.name.padEnd(24)} 文章 ${s.articleCount}`)
  }
  console.log(`共 ${rows.length} 个源`)
  db.close()
}

/**
 * 按学校去找公众号文章。
 *
 * 与界面上的「找文章」是同一条链路，只是没有进度条，直接把每一步打出来。
 * 用法：discover 复旦大学 [--accounts "复旦大学学生会,团聚上大"] [--limit 5]
 */
async function runDiscover(args: Args): Promise<void> {
  const school = args.positional[0]
  if (!school) {
    console.error('用法：discover <学校名> [--accounts "A,B"] [--limit 5]')
    process.exit(1)
  }
  const db = openDb(args)
  const custom = typeof args.flags.accounts === 'string'
    ? args.flags.accounts.split(',').map((x) => x.trim()).filter(Boolean)
    : undefined
  const limit = typeof args.flags.limit === 'string' ? Number(args.flags.limit) : undefined
  const result = await discoverSchool(db, {
    school,
    accounts: custom,
    limit,
    onProgress: (p) => {
      console.log(`  [${p.current}/${p.total}] ${p.account} … ${p.note}`)
    }
  })
  console.log(
    `
请求 ${result.requests} 次，命中 ${result.accountsHit} 个账号，` +
      `新入队 ${result.accepted} 篇（重复 ${result.duplicated}）`
  )
  if (result.blocked) console.log('⚠ 搜索要求验证码，已停下，过 20–30 分钟再试')
  db.close()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.cmd) {
    case 'stats':
      return cmdStats(args)
    case 'import':
      return cmdImport(args)
    case 'fetch':
      return cmdFetch(args)
    case 'retry':
      return cmdRetry(args)
    case 'extract':
      return cmdExtract(args)
    case 'brief':
      return cmdBrief(args)
    case 'list':
      return cmdList(args)
    case 'discover':
      await runDiscover(args)
      break
    case 'sources':
      return cmdSources(args)
    default:
      console.log(
        [
          '对标库命令行',
          '',
          '  stats                     库概况',
          '  import <文件|->           导入链接',
          '  fetch [--limit N]         采集正文（自动限速，撞验证即停）',
          '  retry [--hold 分钟]       把「暂不可见」放回队列重试',
          '  extract [--limit N] [--llm] 抽取字段',
          '  brief [--school X] [--kind Y] [--out 文件]  生成 Markdown 简报',
          '  list [--school X] [--kind Y] [--limit N]',
          '  sources [add --name X --school Y]',
          '',
          '公共参数：--db <路径>（默认 %APPDATA%/InfoAgent/infoagent.db）'
        ].join('\n')
      )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
