'use strict'
// 知乎反推荐：垃圾过滤 + 服务编排（同步/条数/资料/条目管理）
// 先编译：tsc -p tsconfig.test.json，再运行：node tests/zhihu.test.cjs
const assert = require('node:assert/strict')
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { openDatabase } = require('../.test-out/main/db/database.js')
const { classifyJunk } = require('../.test-out/main/services/zhihu/junkFilter.js')
const { ZhihuService } = require('../.test-out/main/services/zhihu/service.js')
const { listMaterials } = require('../.test-out/main/services/materials/service.js')

const TMP_DIR = join(__dirname, '..', '.test-out', 'zhihu-testdb')
const DB_FILE = join(TMP_DIR, 'zhihu-test.db')

let passed = 0
let failed = 0

function run(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error && error.message ? error.message : error}`)
  }
}

async function runAsync(name, fn) {
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
    aiProvider: '',
    aiBaseURL: '',
    aiModel: '',
    aiApiKey: '',
    aiAuthorizedFor: '',
    userGrade: '大二',
    userMajor: '计算机科学',
    zhihuRecommendCount: 2,
    zhihuCounterCount: 2,
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

function item(over) {
  return {
    itemKey: 'answer:' + Math.random().toString(36).slice(2),
    title: '一篇正常的科技讨论',
    excerpt: '这里是一段足够长的摘要，用来通过质量过滤并让本地排序有内容可读。'.repeat(2),
    url: 'https://www.zhihu.com/question/1/answer/2',
    author: '某作者',
    contentType: 'answer',
    voteup: 100,
    ...over
  }
}

function makeGateway(items, auth = { loggedIn: true }) {
  return {
    login: async () => {
      auth.loggedIn = true
      return { ok: true, message: '已连接' }
    },
    hasLogin: async () => auth.loggedIn,
    logout: async () => {
      auth.loggedIn = false
    },
    capture: async () => ({ items, responses: 1 })
  }
}

function assertClean(push) {
  assert.equal(push.junk, undefined)
  assert.ok(!/盐选|广告|推广/.test(`${push.title} ${push.excerpt}`), '推送里不应有广告/盐选')
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  const db = openDatabase(DB_FILE)

  console.log('== 垃圾过滤 ==')
  run('站外广告域被拦下', () => {
    const verdict = classifyJunk({ url: 'https://link.zhihu.com/?target=x', title: '正常标题', text: '正常摘要' })
    assert.equal(verdict.drop, true)
    assert.equal(verdict.junk, 'ad')
  })

  run('广告标记被拦下', () => {
    assert.equal(classifyJunk({ title: '这款耳机广告', text: '品牌合作' }).drop, true)
  })

  run('盐选/付费墙被拦下', () => {
    assert.equal(classifyJunk({ title: '盐选故事：重生之后', text: '会员专享' }).drop, true)
  })

  run('章节号 + 网文套路词被拦下', () => {
    assert.equal(classifyJunk({ title: '第一章 重生之霸总追妻', text: '我重生回到那一天' }).drop, true)
  })

  run('两个导购词被拦下', () => {
    assert.equal(classifyJunk({ title: '双十一必买好物推荐', text: '限时优惠，闭眼入' }).drop, true)
  })

  run('正常科技讨论不误杀', () => {
    const verdict = classifyJunk({
      title: '为什么编译器优化会改变浮点结果',
      text: '讨论 IEEE 754、指令重排和优化等级，内容有具体代码与测试。'
    })
    assert.equal(verdict.drop, false)
  })

  console.log('== 服务 ==')
  const clean = [
    item({ title: '冷门方向：编译器后端如何做指令选择', itemKey: 'answer:clean-1' }),
    item({ title: '海洋古菌的代谢多样性', itemKey: 'answer:clean-2' }),
    item({ title: '用 Rust 写一个玩具数据库', itemKey: 'answer:clean-3' }),
    item({ title: '低赞但完整的一手实验记录', itemKey: 'answer:clean-4', voteup: 20 })
  ]
  const junk = [
    item({ title: '盐选故事：重生后我成了霸总', itemKey: 'answer:junk-1' }),
    item({ title: '这款耳机广告', itemKey: 'answer:junk-2', url: 'https://link.zhihu.com/?x=1' }),
    item({ title: '只有一句话', itemKey: 'answer:junk-3', excerpt: '短', voteup: 1 })
  ]
  const { store, cfg } = makeStore()
  const service = new ZhihuService(db, store, makeGateway([...clean, ...junk]), async () => {
    throw new Error('本测试不应调用 AI')
  })

  await runAsync('按设置条数生成推荐与反推荐，过滤广告/网文/低质', async () => {
    const result = await service.sync(true)
    assert.equal(result.ok, true, result.message)
    const recommend = result.pushes.filter((push) => push.board === 'recommend')
    const counter = result.pushes.filter((push) => push.board === 'counter')
    assert.equal(recommend.length, cfg.zhihuRecommendCount)
    assert.equal(counter.length, cfg.zhihuCounterCount)
    assert.equal(result.pushes.length, cfg.zhihuRecommendCount + cfg.zhihuCounterCount)
    const recommendedKeys = new Set(recommend.map((push) => push.itemKey))
    assert.equal(counter.some((push) => recommendedKeys.has(push.itemKey)), false, '两个板块不能重复同一条')
    for (const push of result.pushes) assertClean(push)
  })

  await runAsync('非 force 幂等，不重复写', async () => {
    const before = await service.today()
    const again = await service.sync(false)
    assert.equal(again.ok, true)
    assert.equal(again.pushes.length, before.pushes.length)
    assert.deepEqual(
      again.pushes.map((p) => p.id),
      before.pushes.map((p) => p.id)
    )
  })

  await runAsync('存为资料：建 info 并出现在资料库', async () => {
    const before = await service.today()
    const target = before.pushes[0]
    const result = service.act(target.id, 'save')
    assert.equal(result.ok, true, result.message)
    const after = await service.today()
    const saved = after.pushes.find((p) => p.id === target.id)
    assert.equal(saved.status, 'saved')
    assert.ok(saved.infoId)
    const materials = listMaterials(db)
    assert.ok(materials.items.some((entry) => entry.title === target.title), '资料库里应有该条')
    const info = db.prepare('SELECT * FROM info WHERE id = ?').get(saved.infoId)
    assert.equal(info.destination, 'keep')
    assert.equal(info.source_type, 'zhihu')
  })

  await runAsync('不感兴趣与恢复', async () => {
    const before = await service.today()
    const target = before.pushes.find((p) => p.status === 'pending')
    assert.ok(target, '应还有待读条目')
    const ignored = service.act(target.id, 'ignore')
    assert.equal(ignored.ok, true, ignored.message)
    assert.equal((await service.today()).pushes.find((p) => p.id === target.id).status, 'ignored')
    const restored = service.act(target.id, 'restore')
    assert.equal(restored.ok, true, restored.message)
    assert.equal((await service.today()).pushes.find((p) => p.id === target.id).status, 'pending')
  })

  await runAsync('已存资料后不可忽略', async () => {
    const before = await service.today()
    const saved = before.pushes.find((p) => p.status === 'saved')
    const result = service.act(saved.id, 'ignore')
    assert.equal(result.ok, false)
  })

  await runAsync('AI 配置下推荐与反推荐分别由 AI 精选', async () => {
    const aiStore = makeStore({
      aiProvider: 'test',
      aiBaseURL: 'http://test.local',
      aiModel: 'test-model',
      aiApiKey: 'test-key',
      aiAuthorizedFor: 'test|http://test.local'
    })
    const aiService = new ZhihuService(db, aiStore.store, makeGateway([...clean]), async (_cfg, system) =>
      JSON.stringify({
        picks: [
          {
            index: 1,
            reason: String(system).includes('兴趣推荐') ? '贴近你的专业方向' : '从反面补一个视角'
          }
        ]
      })
    )
    const result = await aiService.sync(true)
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /推荐：AI 精选/)
    assert.match(result.message, /反推荐：AI 反选/)
    assert.ok(
      result.pushes.some((push) => push.board === 'recommend' && push.reason === '贴近你的专业方向'),
      '推荐位应保留 AI 写的兴趣理由'
    )
    assert.ok(
      result.pushes.some((push) => push.board === 'counter' && push.reason === '从反面补一个视角'),
      '反推荐位应保留 AI 写的对照理由'
    )
  })

  await runAsync('状态包含两个板块的条数与今日数量', async () => {
    const status = await service.status()
    assert.equal(status.loggedIn, true)
    assert.equal(status.recommendCount, 2)
    assert.equal(status.counterCount, 2)
    assert.equal(status.todayRecommendCount, 2)
    assert.equal(status.todayCounterCount, 2)
    assert.equal(status.count, 2)
    assert.equal(status.todayCount, 4)
  })

  await runAsync('退出登录只清登录态，已生成推送保留', async () => {
    const before = await service.today()
    const result = await service.logout()
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /已退出知乎/)
    const status = await service.status()
    assert.equal(status.loggedIn, false)
    const after = await service.today()
    assert.equal(after.pushes.length, before.pushes.length)
    assert.deepEqual(
      after.pushes.map((push) => push.id),
      before.pushes.map((push) => push.id)
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
