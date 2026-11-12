'use strict'
// JARVIS 工作区安全 review 单测（纯 node:test，mock 模型，无真实网络）。
// 覆盖：伪造工具/参数、deadline 不编造、高风险审批绑定与快照篡改/目标更新、
// 权限收缩后不可继续披露/写入、learn 来源引用约束、reconfirm_memory 刷新时刻/变更版本、
// 事务原子性、并发隔离、凭据不泄露、background 去重/暂停/权限/冲突/重试不重复建事项。
const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { openDatabase } = require('../.test-out/main/db/database.js')
const { WorkspaceService } = require('../.test-out/main/services/jarvis/workspace.js')
const { BackgroundProcessor } = require('../.test-out/main/services/jarvis/background.js')
const { CognitionService } = require('../.test-out/main/services/jarvis/cognition.js')
const { searchResources, readResource, RESOURCE_DOMAINS } = require('../.test-out/main/services/jarvis/resources.js')
const { DEFAULT_SETTINGS } = require('../.test-out/shared/types.js')

const makeSettings = () => ({ ...DEFAULT_SETTINGS, aiProvider: 'local', aiIsLocal: true, aiBaseURL: 'http://127.0.0.1:11434/v1', aiModel: 'mock', aiAuthorizedFor: 'local|http://127.0.0.1:11434/v1' })
const baseStore = () => { const s = makeSettings(); return { get: async () => s, peek: () => s } }

const tool = (name, args, id = randomUUID()) => ({ content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })
const end = (content = '完成') => ({ content, toolCalls: [] })
function seq(...replies) { let i = 0; return async () => replies[Math.min(i++, replies.length - 1)] }

async function settle(svc, id) {
  for (let i = 0; i < 500; i++) {
    const r = svc.dao.run(id)
    if (r.status !== 'running') return r
    await new Promise((res) => setImmediate(res))
  }
  throw new Error('run did not settle')
}

function setup(model, clock) {
  const db = openDatabase(':memory:')
  const svc = new WorkspaceService(db, baseStore(), model, clock)
  const c = svc.dao.conversationCreate()
  return { db, svc, c }
}
const send = (svc, c, content) => svc.send({ conversationId: c.id, content, requestId: randomUUID() })
const insEmail = (db, accId, uid, subject, body) => db.prepare("INSERT INTO emails (account_id, uid, subject, body_text) VALUES (?, ?, ?, ?)").run(accId, uid, subject, body)
function tickingClock(start = '2026-10-17T00:00:00.000Z', step = 1000) {
  let t = new Date(start).getTime()
  return () => { t += step; return new Date(t) }
}

test('普通写入自动执行 risk=normal；高风险默认确认 risk=high', async () => {
  {
    const { db, svc, c } = setup(seq(tool('create_item', { title: '自动事项' }), end()))
    const r = await settle(svc, (await send(svc, c, '建事项')).id)
    assert.equal(r.status, 'completed')
    assert.equal(r.steps[0].risk, 'normal')
    assert.equal(r.steps[0].status, 'completed')
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1)
    db.close()
  }
  {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO items(title) VALUES('待删除')").run()
    const svc = new WorkspaceService(db, baseStore(), seq(tool('delete_item', { id: 1 }), end()))
    const c = svc.dao.conversationCreate()
    const r = await settle(svc, (await send(svc, c, '删')).id)
    assert.equal(r.status, 'waiting_confirmation')
    assert.equal(r.steps[0].risk, 'high')
    assert.equal(r.steps[0].status, 'waiting_confirmation')
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1)
    db.close()
  }
})

test('伪造工具名被白名单拒绝，不产生副作用', async () => {
  const { db, svc, c } = setup(seq(tool('__evil__', { shell: 'rm -rf /' }), end()))
  const r = await settle(svc, (await send(svc, c, '执行')).id)
  assert.equal(r.status, 'completed')
  assert.equal(r.steps[0].status, 'failed')
  assert.match(r.steps[0].result, /白名单/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 0)
  db.close()
})

test('伪造非法 JSON 参数导致失败，不落库', async () => {
  const { db, svc, c } = setup(seq({ content: '', toolCalls: [{ id: 'c1', name: 'create_item', arguments: 'not-json' }] }, end()))
  const r = await settle(svc, (await send(svc, c, '建')).id)
  assert.equal(r.status, 'completed')
  assert.equal(r.steps[0].status, 'failed')
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 0)
  db.close()
})

test('deadline 无时区被拒（不编造），缺省为待补充 null，带时区才入库', async () => {
  {
    const { db, svc, c } = setup(seq(tool('create_item', { title: '猜日期', deadlineAt: '2026-12-31' }), end()))
    const r = await settle(svc, (await send(svc, c, '建')).id)
    assert.equal(r.steps[0].status, 'failed')
    assert.match(r.steps[0].result, /时区/)
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 0)
    db.close()
  }
  {
    const { db, svc, c } = setup(seq(tool('create_item', { title: '无截止' }), end()))
    await settle(svc, (await send(svc, c, '建')).id)
    assert.equal(db.prepare('SELECT deadline_at FROM items').get().deadline_at, null)
    db.close()
  }
  {
    const { db, svc, c } = setup(seq(tool('create_item', { title: '有截止', deadlineAt: '2026-12-31T23:59:00+08:00' }), end()))
    await settle(svc, (await send(svc, c, '建')).id)
    assert.ok(db.prepare('SELECT deadline_at FROM items').get().deadline_at)
    db.close()
  }
})

test('learn_memory 的 sourceQuote 必须是当前用户原话字面片段', async () => {
  {
    const { db, svc, c } = setup(seq(tool('learn_memory', { content: '喜欢游泳', section: 'interest', kind: 'explicit', sourceQuote: '我从邮件里看到你喜欢游泳' }), end()))
    const r = await settle(svc, (await send(svc, c, '我最近开始跑步了')).id)
    assert.equal(r.steps[0].status, 'failed')
    assert.match(r.steps[0].result, /当前用户原话/)
    assert.equal(svc.cognition.memoryList().length, 0)
    db.close()
  }
  {
    const { db, svc, c } = setup(seq(tool('learn_memory', { content: '我喜欢跑步', section: 'interest', kind: 'explicit', sourceQuote: '我喜欢跑步' }), end()))
    const r = await settle(svc, (await send(svc, c, '我喜欢跑步')).id)
    assert.equal(r.status, 'completed')
    assert.equal(svc.cognition.memoryList()[0].sourceKind, 'explicit')
    db.close()
  }
  {
    const { db, svc, c } = setup(seq(tool('learn_memory', { content: '我不喜欢香菜', section: 'interest', kind: 'explicit', sourceQuote: '我不喜欢' }), end()))
    const r = await settle(svc, (await send(svc, c, '我不喜欢香菜')).id)
    assert.equal(r.status, 'completed')
    assert.equal(svc.cognition.memoryList()[0].sourceKind, 'inferred')
    db.close()
  }
})

test('reconfirm_memory 内容未变只刷新确认时刻，revision 不变', async () => {
  const clock = tickingClock()
  const { db, svc, c } = setup(seq(tool('reconfirm_memory', { id: 1, content: '' }), end()), clock)
  const mem = svc.cognition.memorySave({ content: '我喜欢跑步', section: 'interest', sourceKind: 'explicit', sourceRef: { type: 'manual' } })
  const before = mem.item
  const r = await settle(svc, (await send(svc, c, '之前喜欢跑步吗')).id)
  assert.equal(r.status, 'waiting_confirmation')
  assert.equal(r.steps[0].tool, 'reconfirm_memory')
  await svc.decide(r.id, r.steps[0].id, true)
  const done = await settle(svc, r.id)
  assert.equal(done.status, 'completed')
  const after = svc.cognition.memoryList().find((m) => m.id === before.id)
  assert.equal(after.revision, before.revision)
  assert.equal(after.content, '我喜欢跑步')
  assert.notEqual(after.lastConfirmedAt, before.lastConfirmedAt)
  db.close()
})

test('reconfirm_memory 内容变更形成新版本 revision+1', async () => {
  const clock = tickingClock()
  const { db, svc, c } = setup(seq(tool('reconfirm_memory', { id: 1, content: '我现在改喜欢游泳了' }), end()), clock)
  const mem = svc.cognition.memorySave({ content: '我喜欢跑步', section: 'interest', sourceKind: 'explicit', sourceRef: { type: 'manual' } })
  const r = await settle(svc, (await send(svc, c, '重新确认')).id)
  assert.equal(r.status, 'waiting_confirmation')
  await svc.decide(r.id, r.steps[0].id, true)
  await settle(svc, r.id)
  const after = svc.cognition.memoryList().find((m) => m.id === mem.id)
  assert.equal(after.revision, mem.item.revision + 1)
  assert.equal(after.content, '我现在改喜欢游泳了')
  db.close()
})

test('reconfirm_memory 审批期间记忆已变更 → revision 校验拒绝', async () => {
  const clock = tickingClock()
  const { db, svc, c } = setup(seq(tool('reconfirm_memory', { id: 1, content: '' }), end()), clock)
  const mem = svc.cognition.memorySave({ content: '我喜欢跑步', section: 'interest', sourceKind: 'explicit', sourceRef: { type: 'manual' } })
  const r = await settle(svc, (await send(svc, c, '确认')).id)
  assert.equal(r.status, 'waiting_confirmation')
  svc.cognition.memorySave({ id: mem.id, content: '中途改成游泳', section: 'interest' })
  await svc.decide(r.id, r.steps[0].id, true)
  const done = await settle(svc, r.id)
  assert.equal(done.steps[0].status, 'failed')
  assert.match(done.steps[0].result, /已变化/)
  db.close()
})

test('delete_item 快照捕获目标；审批期间目标被改则提交时拒绝且不删除', async () => {
  const { db, svc, c } = setup(seq(tool('delete_item', { id: 1 }), end()))
  db.prepare("INSERT INTO items(title) VALUES('待删事项')").run()
  db.prepare("INSERT INTO reminders(item_id, remind_at) VALUES(1, '2026-12-01T00:00:00Z')").run()
  let r = await settle(svc, (await send(svc, c, '删除事项')).id)
  assert.equal(r.status, 'waiting_confirmation')
  const snap = r.steps[0].args.targetSnapshot
  assert.ok(snap, '缺少 targetSnapshot 快照')
  assert.equal(snap.item.id, 1)
  assert.equal(snap.reminders.length, 1)
  assert.match(snap.consequence, /永久删除/)
  db.prepare("UPDATE items SET title='被改过' WHERE id=1").run()
  await svc.decide(r.id, r.steps[0].id, true)
  r = await settle(svc, r.id)
  assert.equal(r.steps[0].status, 'failed')
  assert.match(r.steps[0].result, /已变化/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE id=1').get().n, 1)
  db.close()
})

test('propose_rule 快照绑定 previousRule；并发编辑被拒', async () => {
  const db = openDatabase(':memory:')
  const cog = new CognitionService(db)
  const created = cog.agentRuleSave({ name: '原规则', scope: 'global', action: { type: 'notify', params: {} } })
  const ruleId = created.id
  const model = seq(tool('propose_rule', { rule: { id: ruleId, name: '改名', action: { type: 'notify', params: {} } } }), end())
  const svc = new WorkspaceService(db, baseStore(), model)
  const c = svc.dao.conversationCreate()
  let r = await settle(svc, (await send(svc, c, '改规则')).id)
  assert.equal(r.status, 'waiting_confirmation')
  const snap = r.steps[0].args.targetSnapshot
  assert.ok(snap && snap.previousRule, '缺少 previousRule 快照')
  assert.equal(snap.previousRule.id, ruleId)
  assert.equal(snap.previousRule.revision, 1)
  svc.cognition.agentRuleSave({ id: ruleId, name: '并发改名', action: { type: 'notify', params: {} } })
  await svc.decide(r.id, r.steps[0].id, true)
  r = await settle(svc, r.id)
  assert.equal(r.steps[0].status, 'failed')
  assert.match(r.steps[0].result, /已变化/)
  db.close()
})

test('writeDeny 收缩后，已排队的高风险写入即便批准也不执行', async () => {
  const { db, svc, c } = setup(seq(tool('delete_item', { id: 1 }), end()))
  db.prepare("INSERT INTO items(title) VALUES('保留事项')").run()
  let r = await settle(svc, (await send(svc, c, '删')).id)
  assert.equal(r.status, 'waiting_confirmation')
  svc.cognition.agentPolicySet({ writeConfirm: ['delete_reminder', 'propose_rule', 'reconfirm_memory'], writeDeny: ['delete_item'] })
  await svc.decide(r.id, r.steps[0].id, true)
  r = await settle(svc, r.id)
  assert.equal(r.steps[0].status, 'failed')
  assert.match(r.steps[0].result, /禁止/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1)
  db.close()
})

test('读域收缩后 resource() 直接拒绝，且已保存的旧 read 在后续披露前被拦截', async () => {
  {
    const db = openDatabase(':memory:')
    const acc = db.prepare("INSERT INTO accounts (provider, address, username) VALUES ('t', 'a@x.com', 'a@x.com')").run()
    insEmail(db, acc.lastInsertRowid, 1, 's', 'b')
    const svc = new WorkspaceService(db, baseStore())
    assert.doesNotThrow(() => svc.resource({ kind: 'email', id: 1, title: '' }))
    svc.cognition.agentPolicySet({ readDomains: ['info', 'item', 'reminder', 'daily', 'article'] })
    assert.throws(() => svc.resource({ kind: 'email', id: 1, title: '' }), /用户已关闭此数据域的访问权限：email/)
    db.close()
  }
  {
    const db = openDatabase(':memory:')
    const acc = db.prepare("INSERT INTO accounts (provider, address, username) VALUES ('t', 'a@x.com', 'a@x.com')").run()
    insEmail(db, acc.lastInsertRowid, 1, '私密', '机密')
    let svc
    let getCalls = 0
    const store = {
      get: async () => {
        getCalls += 1
        if (getCalls >= 4 && svc) svc.cognition.agentPolicySet({ readDomains: ['info', 'item', 'reminder', 'daily', 'article'] })
        return makeSettings()
      },
      peek: () => makeSettings()
    }
    svc = new WorkspaceService(db, store, async () => tool('search', { domain: 'email' }))
    const c = svc.dao.conversationCreate()
    const r = await settle(svc, (await send(svc, c, '看邮件')).id)
    assert.equal(r.status, 'failed')
    assert.match(r.summary, /用户已关闭此数据域的访问权限：email/)
    db.close()
  }
})

test('审批绑定具体 step：跨任务复用被拒，且只执行记录的 args', async () => {
  const db = openDatabase(':memory:')
  db.prepare("INSERT INTO items(title) VALUES('目标1')").run()
  db.prepare("INSERT INTO items(title) VALUES('无辜2')").run()
  const model = async (_cfg, m) => {
    if (m.some((x) => x.role === 'tool')) return end('完成')
    const lastUser = [...m].reverse().find((x) => x.role === 'user')
    return tool('delete_item', { id: lastUser.content.includes('甲') ? 1 : 2 })
  }
  const svc = new WorkspaceService(db, baseStore(), model)
  const cA = svc.dao.conversationCreate()
  const cB = svc.dao.conversationCreate()
  const rA = await settle(svc, (await send(svc, cA, '删甲')).id)
  const rB = await settle(svc, (await send(svc, cB, '删乙')).id)
  assert.equal(rA.status, 'waiting_confirmation')
  assert.equal(rB.status, 'waiting_confirmation')
  assert.equal(rA.steps[0].args.id, 1)
  assert.equal(rA.steps[0].args.targetSnapshot.item.id, 1)
  assert.equal(rB.steps[0].args.id, 2)
  await assert.rejects(() => svc.decide(rA.id, rB.steps[0].id, true), /不属于此任务/)
  await svc.decide(rA.id, rA.steps[0].id, true)
  const done = await settle(svc, rA.id)
  assert.equal(done.status, 'completed')
  assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE id=1').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE id=2').get().n, 1)
  db.close()
})

test('资源检索不泄露 settings/accounts 凭据', () => {
  const db = openDatabase(':memory:')
  const acc = db.prepare("INSERT INTO accounts (provider, address, username, secret_enc) VALUES ('test', 'leak@x.com', 'leak@x.com', 'enc://SUPERSECRET-A')").run()
  db.prepare("INSERT INTO settings (key, value) VALUES ('aiApiKey', 'SUPERSECRET-B')").run()
  insEmail(db, acc.lastInsertRowid, 1, '普通邮件', '普通正文')
  for (const d of Object.values(RESOURCE_DOMAINS)) {
    assert.notEqual(d.table, 'accounts')
    assert.notEqual(d.table, 'settings')
  }
  assert.throws(() => searchResources(db, { domain: 'settings' }), /未知/)
  assert.throws(() => searchResources(db, { domain: 'accounts' }), /未知/)
  assert.throws(() => readResource(db, { kind: 'settings', id: 1, title: '' }), /无效资源引用/)
  const emailOut = JSON.stringify(readResource(db, { kind: 'email', id: 1, title: '' }))
  assert.doesNotMatch(emailOut, /SUPERSECRET/)
  db.close()
})

test('事务失败不保留半写入：update_item 后续失败回滚前序写', async () => {
  const { db, svc, c } = setup(seq(tool('update_item', { id: 1, title: '被篡改', status: '非法状态' }), end()))
  db.prepare("INSERT INTO items(title) VALUES('原始标题')").run()
  const r = await settle(svc, (await send(svc, c, '改')).id)
  assert.equal(r.status, 'completed')
  assert.equal(r.steps[0].status, 'failed')
  assert.equal(db.prepare('SELECT title FROM items WHERE id=1').get().title, '原始标题')
  db.close()
})

test('并发：不同会话隔离互不串写；同会话第二个并发任务被锁拒绝', async () => {
  {
    const db = openDatabase(':memory:')
    const model = async (_cfg, m) => {
      await new Promise((res) => setTimeout(res, 3))
      const lastUser = [...m].reverse().find((x) => x.role === 'user')
      const isA = lastUser.content.includes('甲')
      if (m.some((x) => x.role === 'tool')) return end(isA ? '甲完成' : '乙完成')
      return tool('create_item', { title: isA ? '甲事项' : '乙事项' })
    }
    const svc = new WorkspaceService(db, baseStore(), model)
    const cA = svc.dao.conversationCreate()
    const cB = svc.dao.conversationCreate()
    const [rA, rB] = await Promise.all([send(svc, cA, '创建甲'), send(svc, cB, '创建乙')])
    const [a, b] = await Promise.all([settle(svc, rA.id), settle(svc, rB.id)])
    assert.equal(a.status, 'completed')
    assert.equal(b.status, 'completed')
    assert.deepEqual(db.prepare('SELECT title FROM items ORDER BY title').all().map((r) => r.title), ['乙事项', '甲事项'])
    db.close()
  }
  {
    let release
    const db = openDatabase(':memory:')
    const svc = new WorkspaceService(db, baseStore(), () => new Promise((res) => { release = res }))
    const c = svc.dao.conversationCreate()
    const r1 = await send(svc, c, '第一个')
    for (let i = 0; i < 50 && !release; i++) await new Promise((res) => setImmediate(res))
    await assert.rejects(() => send(svc, c, '第二个'), /未结束任务/)
    release(end('完成'))
    const r = await settle(svc, r1.id)
    assert.equal(r.status, 'completed')
    db.close()
  }
})

test('set_category 对无分析记录的邮件拒绝（不伪造已分析）', async () => {
  const { db, svc, c } = setup(seq(tool('set_category', { kind: 'email', id: 1, category: '需行动' }), end()))
  const acc = db.prepare("INSERT INTO accounts (provider, address, username) VALUES ('t', 'a@x.com', 'a@x.com')").run()
  insEmail(db, acc.lastInsertRowid, 1, 's', 'b')
  const r = await settle(svc, (await send(svc, c, '分类')).id)
  assert.equal(r.steps[0].status, 'failed')
  assert.match(r.steps[0].result, /伪造/)
  db.close()
})

test('background：源去重 + 暂停 + 读权限收缩进入 retry', () => {
  const db = openDatabase(':memory:')
  const clock = tickingClock()
  const proc = new BackgroundProcessor(db, baseStore(), clock)
  const infoId = db.prepare("INSERT INTO info (source_type, title, content, destination) VALUES ('jarvis', '资讯', '正文', 'unverified')").run().lastInsertRowid
  proc.enqueue(infoId)
  proc.enqueue(infoId)
  assert.equal(proc.list().length, 1)
  proc.cognition.agentPolicySet({ backgroundEnabled: false })
  proc.drain()
  assert.equal(proc.list()[0].status, 'pending')
  assert.equal(proc.list()[0].attempts, 0)
  proc.cognition.agentPolicySet({ backgroundEnabled: true, readDomains: ['email', 'item', 'reminder', 'daily', 'article'] })
  proc.drain()
  assert.equal(proc.list()[0].status, 'retry')
  assert.match(proc.list()[0].result, /权限已关闭/)
  db.close()
})

test('background：强制规则冲突 → conflict 状态', () => {
  const db = openDatabase(':memory:')
  const clock = tickingClock()
  const proc = new BackgroundProcessor(db, baseStore(), clock)
  const infoId = db.prepare("INSERT INTO info (source_type, title, content, destination) VALUES ('jarvis', '资讯', '正文', 'unverified')").run().lastInsertRowid
  proc.cognition.agentRuleSave({ name: 'A', scope: 'global', action: { type: 'route_info', params: { destination: 'keep' } } })
  proc.cognition.agentRuleSave({ name: 'B', scope: 'global', action: { type: 'route_info', params: { destination: 'archive' } } })
  proc.enqueue(infoId)
  proc.drain()
  assert.equal(proc.list()[0].status, 'conflict')
  assert.match(proc.list()[0].result, /冲突/)
  db.close()
})

test('background：重复 drain 不重复建事项（幂等）', () => {
  const db = openDatabase(':memory:')
  const clock = tickingClock()
  const proc = new BackgroundProcessor(db, baseStore(), clock)
  const infoId = db.prepare("INSERT INTO info (source_type, title, content, destination) VALUES ('jarvis', '转事项', '正文', 'unverified')").run().lastInsertRowid
  proc.cognition.agentRuleSave({ name: '转事项', scope: 'global', action: { type: 'route_info', params: { destination: 'item' } } })
  proc.enqueue(infoId)
  proc.drain()
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1)
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(infoId).destination, 'item')
  assert.equal(proc.list()[0].status, 'completed')
  db.prepare("UPDATE ai_background_jobs SET status='pending', attempts=0, updated_at=?").run(new Date(0).toISOString())
  proc.drain()
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1)
  db.close()
})
