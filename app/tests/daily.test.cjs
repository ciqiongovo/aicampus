'use strict'
// P4/P5 日报服务单元测试：三源形状解析/通用形状容错/纯函数时间/源列表生效/生成幂等+force/全失败/部分失败/并发锁/status/scheduler 补生成
// + 日报结构化：daily_report/daily_article/关联、去重保留用户状态、话题归类、看板、历史分页、搜索、单条处理(SAVEPOINT)、快照反推荐
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node tests/daily.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { openDatabase } = require('../.test-out/main/db/database.js')
const {
  DAILY_SOURCE_PRESETS,
  DailyService,
  DailyScheduler,
  isInGenerateWindow,
  nextDailyRunAt,
  parseHotlist,
  shouldBootstrapGenerate,
  todayKey
} = require('../.test-out/main/services/daily/service.js')
const { classifyDailyTitle } = require('../.test-out/shared/daily.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'daily-testdb')
const DB_FILE = join(TMP_DIR, 'daily-test.db')

let passed = 0
let failed = 0

async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
  }
}

function okJson(json) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(json)) })
}

function okRes(json) {
  return () => okJson(json)
}

const FAKE_FIXED_NOW = new Date(2026, 9, 17, 9, 30, 0) // 本地 2026-10-17 09:30

function makeService(db, sources, fetchFn, now) {
  const store = { peek: () => ({ dailySources: sources }) }
  return new DailyService(db, store, fetchFn, now || (() => FAKE_FIXED_NOW))
}

function countDaily(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM info WHERE source_type = 'daily'").get().c
}

function countDailyAt(db, dateKey) {
  return db.prepare("SELECT COUNT(*) AS c FROM info WHERE source_type = 'daily' AND title LIKE ?").get(dateKey + '%').c
}

function countReport(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM daily_report').get().c
}

function countArticle(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM daily_article').get().c
}

function countLink(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM daily_report_article').get().c
}

function firstDaily(db) {
  return db.prepare("SELECT * FROM info WHERE source_type = 'daily' ORDER BY id ASC LIMIT 1").get()
}

function lastDaily(db) {
  return db.prepare("SELECT * FROM info WHERE source_type = 'daily' ORDER BY id DESC LIMIT 1").get()
}

function firstReport(db) {
  return db.prepare('SELECT * FROM daily_report ORDER BY id ASC LIMIT 1').get()
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  const db = openDatabase(DB_FILE)

  // ---------- parseHotlist 形状解析 ----------
  await run('bilibili shape: data.trending.list -> show_name/keyword + heat_score', () => {
    const items = parseHotlist({ code: 0, data: { trending: { list: [{ keyword: 'k1', show_name: 'S1', heat_score: 100 }, { show_name: 'S2', heat_score: 50 }] } } })
    assert.equal(items.length, 2)
    assert.equal(items[0].title, 'S1')
    assert.equal(items[0].score, 100)
    assert.equal(items[1].title, 'S2')
  })

  await run('douyin shape: word_list -> word + hot_value', () => {
    const items = parseHotlist({ status_code: 0, word_list: [{ word: '热词1', hot_value: 900 }, { word: '热词2', hot_value: 800 }] })
    assert.equal(items.length, 2)
    assert.equal(items[0].title, '热词1')
    assert.equal(items[0].score, 900)
  })

  await run('baidu shape: data.cards -> content[0].content[] -> word', () => {
    const items = parseHotlist({ success: true, data: { cards: [{ component: 'tabTextList', content: [{ content: [{ word: '新闻A', url: 'https://a' }, { word: '新闻B' }] }] }] } })
    assert.equal(items.length, 2)
    assert.equal(items[0].title, '新闻A')
    assert.equal(items[0].score, null)
    assert.equal(items[0].url, 'https://a')
  })

  await run('custom shape: {items:[{title,score,url,content}]} 过滤脏数据 + 保留 content', () => {
    const items = parseHotlist({ items: [{ title: 'ok', score: 3, url: 'https://x', content: '正文内容' }, { title: '', score: 1 }, { title: 'no-score' }, { title: 'bad-url', url: 'ftp://x' }, { title: 'no-url' }] })
    assert.equal(items.length, 4)
    assert.equal(items[0].url, 'https://x')
    assert.equal(items[0].content, '正文内容')
    assert.equal(items[1].score, null)
    assert.equal(items[2].url, null)
  })

  await run('top-level array shape + garbage inputs -> []', () => {
    assert.equal(parseHotlist([{ title: 't1', score: 1 }]).length, 1)
    assert.deepEqual(parseHotlist(null), [])
    assert.deepEqual(parseHotlist(42), [])
    assert.deepEqual(parseHotlist({}), [])
    assert.deepEqual(parseHotlist({ data: {} }), [])
  })

  // ---------- 纯函数时间 ----------
  await run('todayKey 用本地日期而非 UTC', () => {
    assert.equal(todayKey(new Date(2026, 9, 17, 23, 59)), '2026-10-17')
    assert.equal(todayKey(new Date(2026, 0, 5, 0, 0)), '2026-01-05')
  })

  await run('nextDailyRunAt：8 点前后边界', () => {
    const before = nextDailyRunAt(new Date(2026, 9, 17, 7, 59))
    assert.equal(before.getHours(), 8)
    assert.equal(before.getDate(), 17)
    const at = nextDailyRunAt(new Date(2026, 9, 17, 8, 0, 1))
    assert.equal(at.getDate(), 18)
    assert.equal(at.getHours(), 8)
  })

  await run('shouldBootstrapGenerate：≥8 点且当天无报告才补', () => {
    assert.equal(shouldBootstrapGenerate(new Date(2026, 9, 17, 9, 0), false), true)
    assert.equal(shouldBootstrapGenerate(new Date(2026, 9, 17, 7, 59), false), false)
    assert.equal(shouldBootstrapGenerate(new Date(2026, 9, 17, 9, 0), true), false)
  })

  await run('isInGenerateWindow：仅 8:00-8:01', () => {
    assert.equal(isInGenerateWindow(new Date(2026, 9, 17, 8, 0, 30)), true)
    assert.equal(isInGenerateWindow(new Date(2026, 9, 17, 8, 1, 59)), true)
    assert.equal(isInGenerateWindow(new Date(2026, 9, 17, 8, 2, 0)), false)
    assert.equal(isInGenerateWindow(new Date(2026, 9, 17, 7, 59)), false)
  })

  await run('effectiveSources：设置非空整体覆盖，空回退内置', () => {
    const custom = [{ id: 'c1', label: '自定义', endpoint: 'https://e', enabled: true, builtin: false }]
    const svc = makeService(db, custom, okRes({ items: [{ title: 'x' }] }))
    assert.equal(svc.effectiveSources().length, 1)
    const svc2 = makeService(db, [], okRes({ items: [{ title: 'x' }] }))
    assert.equal(svc2.effectiveSources().length, DAILY_SOURCE_PRESETS.length)
  })

  // ---------- 生成流程（旧 info 行兼容） ----------
  await run('generate 成功：插入 info 一条 daily/keep/routed，内容含源名与条目', async () => {
    const sources = [{ id: 'b', label: 'B站热搜', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: 'A事件', heat_score: 123 }, { show_name: 'B事件', heat_score: 45 }] } } }))
    const r = await svc.generate(true)
    assert.equal(r.ok, true)
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0].count, 2)
    assert.equal(countDaily(db), 1)
    const row = firstDaily(db)
    assert.equal(row.source_type, 'daily')
    assert.equal(row.destination, 'keep')
    assert.equal(row.status, 'routed')
    assert.equal(row.category, '一般信息')
    assert.ok(row.title.includes('2026-10-17'))
    assert.ok(row.content.includes('## B站热搜'))
    assert.ok(row.content.includes('A事件（热度 123）'))
  })

  await run('generate 幂等：同一天第二次返回已有不新增；force 刷新内容', async () => {
    const sources = [{ id: 'b', label: 'B站热搜', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '旧事件', heat_score: 1 }] } } }))
    const r1 = await svc.generate(true)
    assert.equal(r1.ok, true)
    const id1 = r1.id
    const r2 = await svc.generate(false)
    assert.equal(r2.ok, true)
    assert.equal(r2.id, id1)
    assert.ok(r2.message.includes('已生成'))
    assert.equal(countDaily(db), 1)
    const svcForce = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '新事件', heat_score: 9 }] } } }))
    const r3 = await svcForce.generate(true)
    assert.equal(r3.ok, true)
    assert.equal(r3.id, id1)
    assert.equal(countDaily(db), 1)
    const row = firstDaily(db)
    assert.ok(row.content.includes('新事件'))
  })

  await run('generate 全部源失败：ok=false 不落库', async () => {
    const sources = [{ id: 'x', label: '坏源', endpoint: 'https://x', enabled: true, builtin: false }]
    const svc = makeService(db, sources, () => Promise.reject(new Error('network down')), () => new Date(2026, 9, 18, 10, 0))
    const before = countDaily(db)
    const r = await svc.generate(true)
    assert.equal(r.ok, false)
    assert.ok(r.message.includes('生成失败'))
    assert.ok(r.message.includes('network down'))
    assert.equal(countDaily(db), before)
  })

  await run('generate 部分源失败：其余继续，失败源写入失败说明', async () => {
    const sources = [
      { id: 'ok', label: '好源', endpoint: 'https://ok', enabled: true, builtin: false },
      { id: 'bad', label: '坏源', endpoint: 'https://bad', enabled: true, builtin: false }
    ]
    const fetchFn = (url) => {
      if (url.indexOf('bad') >= 0) return Promise.reject(new Error('boom'))
      return okJson({ word_list: [{ word: '好词', hot_value: 10 }] })
    }
    const svc = makeService(db, sources, fetchFn, () => new Date(2026, 9, 19, 10, 0))
    const r = await svc.generate(true)
    assert.equal(r.ok, true)
    assert.equal(r.sources.find((s) => s.label === '好源').count, 1)
    assert.equal(r.sources.find((s) => s.label === '坏源').error, 'boom')
    const row = lastDaily(db)
    assert.ok(row.content.includes('好词'))
    assert.ok(row.content.includes('（获取失败：boom）'))
  })

  await run('generate 并发锁：第二个调用直接返回“正在生成中”', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const fetchFn = () => gate.then(() => okJson({ word_list: [{ word: '慢词', hot_value: 1 }] }))
    const sources = [{ id: 's', label: '慢源', endpoint: 'https://s', enabled: true, builtin: false }]
    const svc = makeService(db, sources, fetchFn, () => new Date(2026, 9, 21, 10, 0))
    const p1 = svc.generate(true)
    const p2 = await svc.generate(true)
    assert.equal(p2.ok, false)
    assert.ok(p2.message.includes('正在生成中'))
    release()
    const r1 = await p1
    assert.equal(r1.ok, true)
  })

  await run('generate 无启用源：报错不生成', async () => {
    const sources = [{ id: 'off', label: '停用', endpoint: 'https://o', enabled: false, builtin: false }]
    const svc = makeService(db, sources, okRes({ items: [] }), () => new Date(2026, 9, 22, 10, 0))
    const r = await svc.generate(true)
    assert.equal(r.ok, false)
    assert.ok(r.message.includes('没有启用任何平台源'))
  })

  await run('listReports 新在前且限数；status 反映今日已生成与启用数', async () => {
    const svc = makeService(db, [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }, { id: 'd', label: '抖音', endpoint: 'https://d', enabled: false, builtin: true }], okRes({ items: [] }))
    const reps = svc.listReports(14)
    assert.ok(reps.length >= 1)
    assert.ok(reps[0].id >= reps[reps.length - 1].id)
    assert.equal(svc.listReports(1).length, 1)
    const st = svc.status()
    assert.equal(st.todayGenerated, true)
    assert.equal(st.enabledSourceCount, 1)
    assert.ok(st.lastReportAt)
    assert.ok(st.nextRunAt)
  })

  // ---------- scheduler ----------
  await run('scheduler.bootstrap：9:30 补生成一次，同一天不重复', async () => {
    const bootstrapNow = new Date(2026, 11, 25, 9, 30)
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '补生成', heat_score: 5 }] } } }), () => bootstrapNow)
    const scheduler = new DailyScheduler(svc, () => bootstrapNow)
    assert.equal(countDailyAt(db, '2026-12-25'), 0)
    await scheduler.bootstrap()
    assert.equal(countDailyAt(db, '2026-12-25'), 1)
    await scheduler.bootstrap()
    assert.equal(countDailyAt(db, '2026-12-25'), 1)
  })

  await run('scheduler.tick：未到 8 点不生成（不触网）', async () => {
    let t = new Date(2026, 11, 26, 7, 30).getTime()
    const clock = () => new Date(t)
    let calls = 0
    const fetchFn = () => { calls += 1; return okJson({ items: [{ title: '不该生成' }] }) }
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, fetchFn, clock)
    const scheduler = new DailyScheduler(svc, clock, undefined, 3, 60000)
    await scheduler.tick()
    assert.equal(calls, 0)
    assert.equal(countDailyAt(db, '2026-12-26'), 0)
  })

  await run('scheduler.tick：8 点后生成', async () => {
    let t = new Date(2026, 11, 27, 8, 0, 30).getTime()
    const clock = () => new Date(t)
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '窗口生成', heat_score: 7 }] } } }), clock)
    const scheduler = new DailyScheduler(svc, clock)
    await scheduler.tick()
    assert.equal(countDailyAt(db, '2026-12-27'), 1)
  })

  await run('scheduler：全部失败不触发 afterGenerate，之后可退避重试成功', async () => {
    let t = new Date(2026, 11, 28, 8, 0, 0).getTime()
    const clock = () => new Date(t)
    let fail = true
    const fetchFn = () => (fail ? Promise.reject(new Error('boom')) : okJson({ items: [{ title: '重试成功' }] }))
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, fetchFn, clock)
    let afterCalls = 0
    const scheduler = new DailyScheduler(svc, clock, async () => { afterCalls += 1 }, 3, 60000)
    await scheduler.tick()
    assert.equal(afterCalls, 0) // 全部失败不触发联动
    assert.equal(countDailyAt(db, '2026-12-28'), 0) // 未落库
    fail = false
    t += 61000
    await scheduler.tick()
    assert.equal(afterCalls, 1) // 成功后触发
    assert.equal(countDailyAt(db, '2026-12-28'), 1)
  })

  await run('scheduler：失败退避 60s 且当天最多重试 3 次', async () => {
    let t = new Date(2026, 11, 29, 8, 0, 0).getTime()
    const clock = () => new Date(t)
    let calls = 0
    const fetchFn = () => { calls += 1; return Promise.reject(new Error('boom')) }
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, fetchFn, clock)
    const scheduler = new DailyScheduler(svc, clock, undefined, 3, 60000)
    await scheduler.tick()
    assert.equal(calls, 1)
    await scheduler.tick() // 间隔不足 → 跳过
    assert.equal(calls, 1)
    t += 61000
    await scheduler.tick()
    assert.equal(calls, 2)
    t += 61000
    await scheduler.tick()
    assert.equal(calls, 3)
    t += 61000
    await scheduler.tick() // 达到上限 → 不再重试
    assert.equal(calls, 3)
  })

  await run('scheduler：inFlight 并发锁避免重复生成', async () => {
    let t = new Date(2026, 11, 30, 8, 0, 0).getTime()
    const clock = () => new Date(t)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let calls = 0
    const fetchFn = () => { calls += 1; return gate.then(() => okJson({ items: [{ title: '并发条目' }] })) }
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, fetchFn, clock)
    const scheduler = new DailyScheduler(svc, clock, undefined, 3, 60000)
    const p1 = scheduler.tick()
    await scheduler.tick() // inFlight → 立即返回
    release()
    await p1
    assert.equal(calls, 1)
  })

  await run('scheduler：stop/restart 幂等不抛错', () => {
    const clock = () => new Date(2026, 11, 31, 8, 0, 0)
    const svc = makeService(db, [], okRes({ items: [] }), clock)
    const scheduler = new DailyScheduler(svc, clock, undefined, 3, 60000)
    scheduler.start()
    scheduler.start() // 幂等
    scheduler.stop()
    scheduler.stop() // 幂等
    scheduler.start()
    scheduler.stop()
  })

  // ---------- 结构化：daily_report / daily_article / 关联 ----------
  await run('结构化生成：daily_report 有 date_key/info_id，daily_article 有 dedup_key/topic/url，关联表链接', async () => {
    const sources = [
      { id: 'b', label: 'B站热搜', endpoint: 'https://b', enabled: true, builtin: true },
      { id: 'baidu', label: '百度热搜', endpoint: 'https://baidu', enabled: true, builtin: true }
    ]
    const fetchFn = (url) => {
      if (url.indexOf('baidu') >= 0) return okJson({ data: { cards: [{ content: [{ content: [{ word: '人工智能新进展', url: 'https://news/ai' }] }] }] } })
      return okJson({ data: { trending: { list: [{ show_name: 'AI 大模型发布', heat_score: 100 }, { show_name: '某娱乐明星', heat_score: 90 }] } } })
    }
    const now = new Date(2026, 9, 24, 10, 0)
    const svc = makeService(db, sources, fetchFn, () => now)
    const r = await svc.generate(true)
    assert.equal(r.ok, true)
    assert.equal(countReport(db) >= 1, true)
    const rep = db.prepare("SELECT * FROM daily_report WHERE date_key = '2026-10-24'").get()
    assert.ok(rep)
    assert.equal(rep.status, 'complete')
    assert.ok(rep.info_id)
    const arts = db.prepare('SELECT a.* FROM daily_article a JOIN daily_report_article ra ON ra.article_id = a.id WHERE ra.report_id = ? ORDER BY a.id ASC').all(rep.id)
    assert.equal(arts.length, 3)
    const aiArt = arts.find((a) => a.title === 'AI 大模型发布')
    assert.ok(aiArt)
    assert.equal(aiArt.topic, 'ai')
    assert.ok(aiArt.dedup_key.startsWith('b::'))
    const baiduArt = arts.find((a) => a.title === '人工智能新进展')
    assert.equal(baiduArt.url, 'https://news/ai')
    const links = db.prepare('SELECT COUNT(*) AS c FROM daily_report_article WHERE report_id = ?').get(rep.id)
    assert.equal(links.c, 3)
  })

  await run('去重保留用户处理状态：force 刷新不重置 status/user_acted/item_id', async () => {
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '重复标题', heat_score: 50 }] } } }), () => new Date(2026, 9, 25, 10, 0))
    await svc.generate(true)
    const artBefore = db.prepare("SELECT * FROM daily_article WHERE title = '重复标题'").get()
    svc.setArticleStatus(artBefore.id, 'archive')
    // force 刷新同源同标题：应复用同一 article，且 status 仍 archive
    const svc2 = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '重复标题', heat_score: 99 }] } } }), () => new Date(2026, 9, 25, 11, 0))
    await svc2.generate(true)
    const artAfter = db.prepare("SELECT * FROM daily_article WHERE title = '重复标题'").get()
    assert.equal(artAfter.id, artBefore.id)
    assert.equal(artAfter.status, 'archive')
    assert.equal(artAfter.user_acted, 1)
    assert.equal(artAfter.score, 99)
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM daily_article WHERE title = '重复标题'").get().c, 1)
  })

  await run('focus topics get/set：默认空，非法/去重过滤', () => {
    const svc = makeService(db, [], okRes({ items: [] }), () => new Date(2026, 9, 26, 10, 0))
    assert.deepEqual(svc.getFocusTopics(), [])
    const r = svc.setFocusTopics(['ai', 'tech', 'ai', 'nonsense'])
    assert.equal(r.ok, true)
    assert.deepEqual(svc.getFocusTopics(), ['ai', 'tech'])
    assert.equal(svc.setFocusTopics('bad').ok, false)
    const clear = svc.setFocusTopics([])
    assert.equal(clear.ok, true)
    assert.deepEqual(svc.getFocusTopics(), [])
  })

  await run('getBoard：固定关注列 + 发现列 + 未归类列', async () => {
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const fetchFn = () => okJson({ items: [
      { title: 'AI 大模型突破' },
      { title: '某地天气预警' },
      { title: '没有关键词的标题XYZ' }
    ] })
    const svc = makeService(db, sources, fetchFn, () => new Date(2026, 9, 27, 10, 0))
    await svc.generate(true)
    svc.setFocusTopics(['ai'])
    const board = svc.getBoard('2026-10-27')
    assert.ok(board.report)
    assert.deepEqual(board.focusTopicIds, ['ai'])
    const focusCol = board.columns.find((c) => c.kind === 'focus')
    assert.ok(focusCol)
    assert.equal(focusCol.topicId, 'ai')
    assert.ok(focusCol.articles.some((a) => a.topic === 'ai'))
    const unfiledCol = board.columns.find((c) => c.kind === 'unfiled')
    assert.ok(unfiledCol)
    assert.ok(unfiledCol.articles.some((a) => a.title === '没有关键词的标题XYZ'))
  })

  await run('getReportDetailByInfo：按 info 汇总 id 反查日报明细', async () => {
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ data: { trending: { list: [{ show_name: '反查测试', heat_score: 5 }] } } }), () => new Date(2026, 9, 28, 10, 0))
    const r = await svc.generate(true)
    assert.equal(r.ok, true)
    const rep = db.prepare("SELECT * FROM daily_report WHERE date_key = '2026-10-28'").get()
    const detail = svc.getReportDetailByInfo(rep.info_id)
    assert.ok(detail)
    assert.equal(detail.report.id, rep.id)
    assert.ok(detail.articles.some((a) => a.title === '反查测试'))
    assert.equal(svc.getReportDetailByInfo(999999), null)
  })

  await run('getReportArticles 分页：total 正确，offset 跨页不重复', async () => {
    const items = []
    for (let i = 0; i < 5; i++) items.push({ title: '分页条目' + i, score: 5 - i })
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items }), () => new Date(2026, 9, 29, 10, 0))
    await svc.generate(true)
    const rep = db.prepare("SELECT * FROM daily_report WHERE date_key = '2026-10-29'").get()
    const p1 = svc.getReportArticles(rep.id, { limit: 2, offset: 0 })
    const p2 = svc.getReportArticles(rep.id, { limit: 2, offset: 2 })
    const p3 = svc.getReportArticles(rep.id, { limit: 2, offset: 4 })
    assert.equal(p1.total, 5)
    assert.equal(p1.items.length, 2)
    assert.equal(p2.items.length, 2)
    assert.equal(p3.items.length, 1)
    const ids = new Set([...p1.items, ...p2.items, ...p3.items].map((a) => a.id))
    assert.equal(ids.size, 5)
    assert.equal(svc.getReportArticles(9999), null)
  })

  await run('searchArticles：关键词/来源/话题/去向筛选', async () => {
    const sources = [
      { id: 'srcA', label: '来源A', endpoint: 'https://a', enabled: true, builtin: false },
      { id: 'srcB', label: '来源B', endpoint: 'https://b', enabled: true, builtin: false }
    ]
    const fetchFn = (url) => {
      if (url.indexOf('a') >= 0) return okJson({ items: [{ title: 'AI 芯片新突破', content: '芯片内容', url: 'https://a/1' }] })
      return okJson({ items: [{ title: 'NBA 总决赛开打', url: 'https://b/2' }] })
    }
    const svc = makeService(db, sources, fetchFn, () => new Date(2026, 9, 30, 10, 0))
    await svc.generate(true)
    const byKeyword = svc.searchArticles({ keyword: '芯片' })
    assert.equal(byKeyword.total, 1)
    assert.equal(byKeyword.items[0].title, 'AI 芯片新突破')
    const bySource = svc.searchArticles({ sourceId: 'srcB' })
    assert.equal(bySource.total, 1)
    assert.equal(bySource.items[0].sourceLabel, '来源B')
    const byTopic = svc.searchArticles({ topicId: 'ai' })
    assert.ok(byTopic.total >= 1)
    assert.ok(byTopic.items.every((a) => a.topic === 'ai'))
  })

  await run('getArticle + getArticleContent 分块：不全文截断，hasMore 正确', async () => {
    const longContent = 'X'.repeat(5000)
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items: [{ title: '长文标题', content: longContent }] }), () => new Date(2026, 10, 1, 10, 0))
    await svc.generate(true)
    const art = db.prepare("SELECT * FROM daily_article WHERE title = '长文标题'").get()
    const detail = svc.getArticle(art.id)
    assert.ok(detail)
    assert.equal(detail.content.length, 5000)
    const c1 = svc.getArticleContent(art.id, { offset: 0, limit: 4000 })
    assert.equal(c1.content.length, 4000)
    assert.equal(c1.total, 5000)
    assert.equal(c1.hasMore, true)
    const c2 = svc.getArticleContent(art.id, { offset: 4000, limit: 4000 })
    assert.equal(c2.content.length, 1000)
    assert.equal(c2.hasMore, false)
    assert.equal(svc.getArticleContent(99999), null)
  })

  // ---------- 单条处理 ----------
  await run('setArticleStatus：keep/archive/unverified 更新状态；item 建真实事项', async () => {
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items: [{ title: '需要行动的事件', url: 'https://x/1' }] }), () => new Date(2026, 10, 2, 10, 0))
    await svc.generate(true)
    const art = db.prepare("SELECT * FROM daily_article WHERE title = '需要行动的事件'").get()
    const rKeep = svc.setArticleStatus(art.id, 'keep')
    assert.equal(rKeep.ok, true)
    const rArch = svc.setArticleStatus(art.id, 'archive')
    assert.equal(rArch.ok, true)
    assert.equal(db.prepare('SELECT status FROM daily_article WHERE id = ?').get(art.id).status, 'archive')
    const rItem = svc.setArticleStatus(art.id, 'item')
    assert.equal(rItem.ok, true)
    assert.ok(rItem.itemId)
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(rItem.itemId)
    assert.ok(item)
    assert.equal(item.title, '需要行动的事件')
    assert.equal(item.category, '一般信息')
    assert.match(item.notes, /来源日报：B站/)
    const after = db.prepare('SELECT * FROM daily_article WHERE id = ?').get(art.id)
    assert.equal(after.status, 'item')
    assert.equal(after.item_id, rItem.itemId)
    assert.equal(after.user_acted, 1)
    // 重复转事项不新建
    const again = svc.setArticleStatus(art.id, 'item')
    assert.equal(again.ok, true)
    assert.equal(again.itemId, rItem.itemId)
    assert.equal(svc.setArticleStatus(99999, 'keep').ok, false)
    assert.equal(svc.setArticleStatus(art.id, 'bad').ok, false)
  })

  await run('setArticleStatus 在外部事务内用 SAVEPOINT 兼容嵌套', async () => {
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items: [{ title: '事务内转事项', url: 'https://x/2' }] }), () => new Date(2026, 10, 3, 10, 0))
    await svc.generate(true)
    const art = db.prepare("SELECT * FROM daily_article WHERE title = '事务内转事项'").get()
    db.exec('BEGIN')
    const r = svc.setArticleStatus(art.id, 'item')
    db.exec('COMMIT')
    assert.equal(r.ok, true)
    assert.ok(r.itemId)
  })

  await run('setArticleCategory：白名单校验，topic 与 category 独立', async () => {
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items: [{ title: 'AI 会议通知' }] }), () => new Date(2026, 10, 4, 10, 0))
    await svc.generate(true)
    const art = db.prepare("SELECT * FROM daily_article WHERE title = 'AI 会议通知'").get()
    assert.equal(art.topic, 'ai')
    const r = svc.setArticleCategory(art.id, '需行动')
    assert.equal(r.ok, true)
    const after = db.prepare('SELECT * FROM daily_article WHERE id = ?').get(art.id)
    assert.equal(after.category, '需行动')
    assert.equal(after.topic, 'ai') // topic 不被覆盖
    assert.equal(after.user_acted, 1)
    assert.equal(svc.setArticleCategory(art.id, '乱写分类').ok, false)
  })

  // ---------- 快照反推荐 ----------
  await run('snapshotCandidates：读当天已落库快照，扁平列表限条', async () => {
    const items = []
    for (let i = 0; i < 5; i++) items.push({ title: '快照' + i, score: 50 - i, url: 'https://s/' + i })
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items }), () => new Date(2026, 11, 20, 10, 0))
    await svc.generate(true)
    const cands = svc.snapshotCandidates(3)
    assert.equal(cands.length, 3)
    assert.equal(cands[0].title, '快照0')
    assert.equal(cands[0].sourceLabel, 'B站')
    assert.ok(cands[0].url)
    // 未生成过日期的快照为空
    const emptyDay = makeService(db, sources, okRes({ items }), () => new Date(2026, 11, 21, 10, 0))
    assert.equal(emptyDay.snapshotCandidates(10).length, 0)
    // readSnapshotCandidates 按来源限条（旧 fetcher 兼容）
    const perSource = svc.readSnapshotCandidates(2)
    assert.equal(perSource.length, 2)
  })

  await run('classifyDailyTitle：标题确定性归类（有依据），无命中 null', () => {
    const ai = classifyDailyTitle('AI 大模型发布')
    assert.equal(ai.topicId, 'ai')
    assert.ok(ai.matches.length > 0)
    const fin = classifyDailyTitle('央行降息 A股大涨')
    assert.equal(fin.topicId, 'finance')
    assert.equal(classifyDailyTitle('完全无关键词的冷门字符串XYZ'), null)
  })

  await run('listReports/status 生成后不 throw，新时间戳为 ISO，非 UTC 日期边界正确', async () => {
    // 本地 2026-12-15 00:30（UTC 仍是 12-14）：date_key 用本地日期，时间戳统一 ISO 不崩
    const lateNight = new Date(2026, 11, 15, 0, 30)
    assert.equal(todayKey(lateNight), '2026-12-15')
    const sources = [{ id: 'b', label: 'B站', endpoint: 'https://b', enabled: true, builtin: true }]
    const svc = makeService(db, sources, okRes({ items: [{ title: '午夜边界条目' }] }), () => lateNight)
    await svc.generate(true)
    const reps = svc.listReports(100)
    const mine = reps.find((r) => r.title.includes('2026-12-15'))
    assert.ok(mine)
    assert.ok(!Number.isNaN(Date.parse(mine.createdAt)))
    assert.match(mine.createdAt, /Z$/)
    const st = svc.status()
    assert.equal(st.todayGenerated, true)
    assert.ok(st.lastReportAt)
    assert.ok(!Number.isNaN(Date.parse(st.lastReportAt)))
    const rep = db.prepare("SELECT * FROM daily_report WHERE date_key = '2026-12-15'").get()
    assert.ok(rep.generated_at.includes('Z'))
    assert.ok(rep.created_at.includes('Z'))
    assert.ok(rep.updated_at.includes('Z'))
    const art = db.prepare("SELECT * FROM daily_article WHERE title = '午夜边界条目'").get()
    assert.ok(art.first_seen_at.includes('Z'))
    assert.ok(art.created_at.includes('Z'))
    assert.ok(art.updated_at.includes('Z'))
    const infoRow = db.prepare("SELECT created_at FROM info WHERE title LIKE '2026-12-15%'").get()
    assert.ok(infoRow.created_at.includes('Z'))
    const board = svc.getBoard('2026-12-15')
    assert.ok(board.report)
    assert.ok(!Number.isNaN(Date.parse(board.report.generatedAt)))
    assert.ok(!Number.isNaN(Date.parse(board.report.createdAt)))
  })

  db.close()
  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
