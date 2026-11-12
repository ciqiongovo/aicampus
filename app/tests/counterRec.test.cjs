'use strict'
// P5 反推荐服务单元测试：门禁/候选/模型挑选/幂等/force 刷新/act 有限执行
// 先编译：tsc -p tsconfig.test.json，再运行：node tests/counterRec.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { openDatabase } = require('../.test-out/main/db/database.js')
const { CounterRecService } = require('../.test-out/main/services/counterRec/service.js')
const { CognitionService } = require('../.test-out/main/services/jarvis/cognition.js')
const { todayKey } = require('../.test-out/main/services/daily/service.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'counterrec-testdb')
const DB_FILE = join(TMP_DIR, 'counterrec-test.db')

let passed = 0
let failed = 0

async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error && error.message ? error.message : error}`)
  }
}

function makeStore(over = {}) {
  const cfg = {
    aiProvider: 'deepseek',
    aiBaseURL: 'https://api.deepseek.com/v1',
    aiModel: 'deepseek-chat',
    aiApiKey: 'sk-test',
    aiAuthorizedFor: 'deepseek|https://api.deepseek.com/v1',
    userGrade: '大一',
    userMajor: '计算机科学',
    reminderEnabled: true,
    reminderAdvanceMinutes: 30,
    ...over
  }
  return {
    cfg,
    store: {
      get: async () => cfg,
      peek: () => cfg,
      set: async (patch) => Object.assign(cfg, patch)
    }
  }
}

/** 候选桩：默认给 3 条候选 */
function makeFetcher(items) {
  return { fetchEnabledItems: async () => items ?? defaultCandidates() }
}

function defaultCandidates() {
  return [
    { title: '学校通知测试', score: 999, url: null, sourceLabel: '百度热搜' },
    { title: '冷门天体物理新发现', score: 123, url: null, sourceLabel: 'B站热搜' },
    { title: '小众开源项目走红', score: 88, url: null, sourceLabel: '抖音热搜' }
  ]
}

/** 在 items 表中断言反推荐转成的事项 */
function getItemRow(db, itemId) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(itemId)
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  const db = openDatabase(DB_FILE)

  // ---------- 门禁 ----------
  console.log('== 门禁 ==')
  await run('未配置 AI 时 generate 失败且不触网', async () => {
    const { store } = makeStore({ aiProvider: '', aiBaseURL: '', aiModel: '' })
    const svc = new CounterRecService(db, store, {
      fetchEnabledItems: async () => { throw new Error('fetcher 不应被调用') }
    }, async () => { throw new Error('chatFn 不应被调用') }, () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.match(res.message, /尚未配置 AI/)
  })
  await run('未授权端点时 generate 失败且不触网', async () => {
    const { store } = makeStore({ aiAuthorizedFor: 'other|https://x' })
    const svc = new CounterRecService(db, store, {
      fetchEnabledItems: async () => { throw new Error('fetcher 不应被调用') }
    }, async () => { throw new Error('chatFn 不应被调用') }, () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.match(res.message, /尚未授权/)
  })

  // ---------- 候选与模型 ----------
  console.log('== 候选与模型 ==')
  await run('没有可用候选时失败', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher([]), async () => '{"index":0,"reason":"x"}', () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.match(res.message, /没有可用的热点条目/)
  })
  await run('模型返回非 JSON 时报错且不落库', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '抱歉，我不输出 JSON。', () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.match(res.message, /未返回合法 JSON/)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM counter_rec').get().c, 0)
  })
  await run('模型 index 越界时报错且不落库', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":99,"reason":"x"}', () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.match(res.message, /未选出有效候选/)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM counter_rec').get().c, 0)
  })
  await run('模型 index=-1（无合适候选）时报错', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":-1,"reason":"没有合适的"}', () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.match(res.message, /未选出有效候选/)
  })
  await run('chatFn 抛异常时转为失败结果', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => { throw new Error('boom') }, () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, false)
    assert.equal(res.message, 'boom')
  })

  // ---------- 生成成功与幂等 ----------
  console.log('== 生成与幂等 ==')
  await run('生成成功落库：挑中条目写入 counter_rec', async () => {
    const { store } = makeStore()
    const cognition = new CognitionService(db, () => new Date(2026, 9, 17, 12))
    cognition.memorySave({content:'我关注开源项目',section:'interest',fieldKey:'test.opensource',sourceRef:{type:'manual'}})
    new CognitionService(db, () => new Date(2026, 7, 1, 12)).memorySave({content:'我关注过期开源计划',section:'interest',fieldKey:'test.stale',sourceRef:{type:'manual'}})
    cognition.learn({content:'我对开源健康数据敏感',section:'identity',sourceKind:'inferred',sourceRef:{type:'behavior'}})
    let calls = 0
    const svc = new CounterRecService(db, store, makeFetcher(), async (cfg, system, user) => {
      calls += 1
      assert.match(system, /反推荐/)
      assert.match(user, /冷门天体物理新发现/)
      assert.match(user, /我关注开源项目/)
      assert.doesNotMatch(user, /我关注过期开源计划|我对开源健康数据敏感/)
      assert.doesNotMatch(user, /年级：大一|专业：计算机科学/)
      return '{"index":1,"reason":"与你关注的校园事务完全不同，拓展视野"}'
    }, () => new Date(2026, 9, 17, 12))
    const res = await svc.generate()
    assert.equal(res.ok, true, res.message)
    assert.equal(calls, 1)
    assert.ok(res.item)
    assert.equal(res.item.dateKey, '2026-10-17')
    assert.equal(res.item.title, '冷门天体物理新发现')
    assert.equal(res.item.sourceLabel, 'B站热搜')
    assert.equal(res.item.status, 'pending')
    assert.equal(res.item.itemId, null)
    assert.match(res.item.reason, /拓展视野/)
    const row = db.prepare("SELECT * FROM counter_rec WHERE date_key = '2026-10-17'").get()
    assert.ok(row)
  })
  await run('同日重复 generate 幂等：直接返回已有条目且不再调用模型', async () => {
    const { store } = makeStore()
    const cognition = new CognitionService(db, () => new Date(2026, 9, 17, 12))
    cognition.memorySave({content:'我关注开源项目',section:'interest',fieldKey:'test.opensource',sourceRef:{type:'manual'}})
    new CognitionService(db, () => new Date(2026, 7, 1, 12)).memorySave({content:'我关注过期开源计划',section:'interest',fieldKey:'test.stale',sourceRef:{type:'manual'}})
    cognition.learn({content:'我对开源健康数据敏感',section:'identity',sourceKind:'inferred',sourceRef:{type:'behavior'}})
    let calls = 0
    const svc = new CounterRecService(db, store, makeFetcher(), async () => {
      calls += 1
      return '{"index":0,"reason":"x"}'
    }, () => new Date(2026, 9, 26, 12))
    const first = await svc.generate()
    assert.equal(first.ok, true)
    const second = await svc.generate()
    assert.equal(second.ok, true)
    assert.equal(calls, 1)
    assert.equal(second.item.id, first.item.id)
    assert.equal(second.item.title, first.item.title)
  })
  await run('reason 缺省时使用默认文案', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":0}', () => new Date(2026, 9, 18, 12))
    const res = await svc.generate()
    assert.equal(res.ok, true)
    assert.ok(res.item)
    assert.equal(res.item.reason, '这条热点离你的关注圈最远，但值得知道。')
  })

  // ---------- act 有限执行 ----------
  console.log('== act 有限执行 ==')
  await run('act go 转成事项：status=done 且 item_id 指向新事项', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":1,"reason":"值得了解"}', () => new Date(2026, 9, 19, 12))
    const gen = await svc.generate()
    assert.equal(gen.ok, true)
    const res = svc.act(gen.item.id, 'go')
    assert.equal(res.ok, true)
    assert.equal(res.item.status, 'done')
    assert.ok(res.item.itemId)
    const item = getItemRow(db, res.item.itemId)
    assert.ok(item)
    assert.equal(item.title, '冷门天体物理新发现')
    assert.equal(item.category, '可选机会')
    assert.match(item.notes, /反推荐来源：B站热搜/)
    // 无截止时间 → 不建提醒
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reminders WHERE item_id = ?').get(res.item.itemId).c, 0)
  })
  await run('act ignore：status=ignored', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":2,"reason":"值得了解"}', () => new Date(2026, 9, 20, 12))
    const gen = await svc.generate()
    assert.equal(gen.ok, true)
    const res = svc.act(gen.item.id, 'ignore')
    assert.equal(res.ok, true)
    assert.equal(res.item.status, 'ignored')
    assert.equal(res.item.itemId, null)
  })
  await run('重复 act 拒绝：done 与 ignored 都不可再处理', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":0,"reason":"x"}', () => new Date(2026, 9, 21, 12))
    const gen = await svc.generate()
    assert.equal(svc.act(gen.item.id, 'go').ok, true)
    const again = svc.act(gen.item.id, 'go')
    assert.equal(again.ok, false)
    assert.match(again.message, /已转成事项/)
  })
  await run('act 不存在的条目：报错', async () => {
    const { store } = makeStore()
    const svc = new CounterRecService(db, store, makeFetcher(), async () => '{"index":0,"reason":"x"}', () => new Date(2026, 9, 22, 12))
    const res = svc.act(999, 'go')
    assert.equal(res.ok, false)
    assert.match(res.message, /不存在/)
  })

  await run('真实快照能力存在时不重新抓取外部来源', async () => {
    const { store } = makeStore()
    const fetcher = {snapshotCandidates: () => [{title:'已存快照',sourceLabel:'测试源',url:null,score:null}],fetchEnabledItems: async () => { throw new Error('不应重新抓取') }}
    const svc = new CounterRecService(db, store, fetcher, async () => '{"index":0,"reason":"基于已存数据"}', () => new Date(2026,9,27,12))
    const result=await svc.generate();assert.equal(result.ok,true);assert.equal(result.item.title,'已存快照')
  })

  // ---------- force 刷新与 today ----------
  console.log('== force 刷新与 today ==')
  await run('force 刷新重置状态：ignored 条目回到 pending 且内容更新', async () => {
    const { store } = makeStore()
    let seq = 0
    const svc = new CounterRecService(db, store, makeFetcher(), async () => {
      seq += 1
      return seq === 1 ? '{"index":0,"reason":"旧理由"}' : '{"index":2,"reason":"新理由"}'
    }, () => new Date(2026, 9, 23, 12))
    const gen = await svc.generate()
    assert.equal(svc.act(gen.item.id, 'ignore').ok, true)
    const res = await svc.generate(true)
    assert.equal(res.ok, true)
    assert.equal(res.item.id, gen.item.id)
    assert.equal(res.item.status, 'pending')
    assert.equal(res.item.itemId, null)
    assert.equal(res.item.title, '小众开源项目走红')
    assert.equal(res.item.reason, '新理由')
  })
  await run('today() 跨天返回 null（昨天条目不可见）', async () => {
    const { store } = makeStore()
    const yesterday = new CounterRecService(db, store, makeFetcher(), async () => '{"index":0,"reason":"x"}', () => new Date(2026, 9, 24, 12))
    await yesterday.generate()
    const today = new CounterRecService(db, store, makeFetcher(), async () => '{"index":0,"reason":"x"}', () => new Date(2026, 9, 25, 12))
    assert.equal(today.today(), null)
    // 当天日期键与 todayKey 一致
    assert.equal(todayKey(new Date(2026, 9, 25, 12)), '2026-10-25')
  })

  console.log(`
counterRec: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
