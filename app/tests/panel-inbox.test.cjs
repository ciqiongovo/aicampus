const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openDatabase } = require('../.test-out/main/db/index.js')
const { insertAccount } = require('../.test-out/main/db/dao/accountsDao.js')
const { upsertEmail } = require('../.test-out/main/db/dao/emailsDao.js')
const { upsertAnalysis } = require('../.test-out/main/db/dao/emailAnalysisDao.js')
const { syncAnalysisToInfo, createInfo } = require('../.test-out/main/db/dao/infoDao.js')
const panel = require('../.test-out/main/services/panel/service.js')
const recommend = require('../.test-out/main/services/panel/recommend.js')
const { mailContentKey, refreshPanelDuplicates } = require('../.test-out/main/services/panel/content.js')
const { listPanelCandidates } = require('../.test-out/main/db/dao/panelDao.js')
const keywordProfile = require('../.test-out/main/services/panel/keywordProfile.js')
const { migrate, MIGRATIONS } = require('../.test-out/main/db/migrations.js')

function fixture(t, apiKey = '', dbPath = ':memory:') {
  const db = openDatabase(dbPath)
  t.after(() => db.close())
  const accountId = insertAccount(db, { provider:'imap', label:'测试', address:'panel@test.edu', host:'imap.test.edu', port:993, encryption:'tls', username:'panel@test.edu', secret_enc:'', folder:'INBOX', auth_mode:'password', last_uidvalidity:null, last_uid:0, last_sync_at:null, sync_error:null })
  const values = { aiBaseURL:'https://mock.test/v1', aiModel:'model', aiApiKey:apiKey, aiIsLocal:false, aiProvider:'openai', aiAuthorizedFor:'openai|https://mock.test/v1' }
  const store = { get:() => values, peek:() => values }
  let uid = 0
  function seed(input = {}) {
    uid += 1
    const subject = input.subject ?? `邮件 ${uid}`
    const body = input.body ?? `独立正文 ${uid}`
    const emailId = upsertEmail(db, { account_id:accountId, folder:'INBOX', uid, message_id:`<${uid}@test.edu>`, subject, from_addr:'老师 <teacher@test.edu>', to_addr:'panel@test.edu', cc:'', date_utc:input.date ?? new Date().toISOString(), date_raw:null, unread:1, body_text:body, body_html:input.html ?? '', attachments_json:input.attachments ?? '[]', size:100 })
    upsertAnalysis(db, { email_id:emailId, status:'analyzed', category:'一般信息', summary:input.summary ?? `摘要 ${uid}`, action_required:input.action ?? null, deadline_raw:null, deadline_at:input.deadline ?? null, deadline_kind:null, event_start_at:input.event ?? null, tier:input.tier ?? 'archive', applicable_to:null, confidence:0.9, evidence_json:'[]', model:'test', provider:'test', error:null, analyzed_at:new Date().toISOString() })
    const info = syncAnalysisToInfo(db, emailId)
    return { emailId, infoId:info.id }
  }
  return { db, store, seed }
}
function installAi(t, respond) {
  const original = global.fetch
  let calls = 0
  global.fetch = async (_url, init) => {
    calls += 1
    const request = JSON.parse(init.body)
    const input = JSON.parse(request.messages.find((message) => message.role === 'user').content)
    const items = await respond(input.candidates, calls)
    return new Response(JSON.stringify({ choices:[{ message:{ content:typeof items === 'string' ? items : JSON.stringify({ items }) } }] }), { status:200 })
  }
  t.after(() => { global.fetch = original })
  return () => calls
}

test('普通邮件分析后仍进入面板，已处置去向不会被重新分析覆盖', async t => {
  const { db, store, seed } = fixture(t)
  const mail = seed({ tier:'archive' })
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(mail.infoId).destination, 'unverified')
  const result = await panel.panelOverview(db, store)
  assert.equal(result.recommendations.length, 1)
  assert.equal(panel.panelAct(db, store, result.recommendations[0].id, 'archive').ok, true)
  syncAnalysisToInfo(db, mail.emailId)
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(mail.infoId).destination, 'archive')
})

test('新邮件自动追加并排在旧高权重推荐之前，邮件日期旧也不受阻', async t => {
  const { db, store, seed } = fixture(t)
  seed({ subject:'旧的高优先级报名', action:'请提交报名表' })
  const first = await panel.panelOverview(db, store)
  const fresh = seed({ subject:'新收到的普通通知', date:'2020-01-01T00:00:00Z' })
  const result = await panel.panelOverview(db, store)
  assert.equal(result.recommendations.length, 2)
  assert.equal(result.recommendations[0].infoId, fresh.infoId)
  assert.ok(result.recommendations.some(item => item.id === first.recommendations[0].id))
  assert.equal(result.recommendations[0].priority, 'other')
  assert.equal(result.recommendations[1].priority, 'focus')
})

test('只读快照不调用模型、不生成新推荐；下一次显式生成才接收新邮件', async t => {
  const { db, store, seed } = fixture(t, 'test-key')
  seed({ subject:'已经生成的第一封' })
  const calls = installAi(t, candidates => candidates.map(item => ({ id:item.id, action:'archive', priority:'other', reason:'模型判断', confidence:0.8 })))
  const first = await panel.panelOverview(db, store)
  assert.equal(first.recommendations.length, 1)
  assert.equal(calls(), 1)
  const fresh = seed({ subject:'后台新到的邮件' })
  const readonly = await panel.panelOverview(db, store, undefined, undefined, false)
  assert.equal(readonly.recommendations.length, 1)
  assert.ok(readonly.recommendations.every(item => item.infoId !== fresh.infoId))
  assert.equal(calls(), 1)
  const generated = await panel.panelOverview(db, store)
  assert.equal(generated.recommendations.length, 2)
  assert.equal(calls(), 2)
})

test('不清空其他邮件也可继续阅读；多批次推荐都保留且新到达序号优先', async t => {
  const { db, store, seed } = fixture(t)
  for (let n=0; n<25; n++) seed()
  const first = await panel.panelOverview(db, store)
  assert.equal(first.recommendations.length, 20)
  assert.equal(first.remaining, 5)
  assert.ok(first.recommendations.every(item => item.priority === 'other'))
  const second = await panel.panelContinue(db, store)
  assert.equal(second.recommendations.length, 25)
  assert.equal(second.remaining, 0)
  assert.ok(first.recommendations.every(old => second.recommendations.some(item => item.id === old.id)))
  const fresh = seed({ subject:'刚收到的新邮件' })
  const third = await panel.panelOverview(db, store)
  assert.equal(third.recommendations.length, 26)
  assert.equal(third.recommendations[0].infoId, fresh.infoId)
})

test('并发刷新、切换来源与继续阅读不会重复创建推荐', async t => {
  const { db, store, seed } = fixture(t)
  for (let n=0; n<28; n++) seed()
  await Promise.all([panel.panelOverview(db, store), panel.panelOverview(db, store, 'email'), panel.panelContinue(db, store)])
  const duplicates = db.prepare('SELECT info_id, COUNT(*) AS n FROM recommendation GROUP BY info_id HAVING COUNT(*) > 1').all()
  assert.equal(duplicates.length, 0)
  const final = await panel.panelContinue(db, store)
  assert.equal(final.recommendations.length, 28)
})

test('相同标题和完整正文仅展示一封，不改动或删除原邮件', async t => {
  const { db, store, seed } = fixture(t)
  const first = seed({ subject:'同一份通知', body:'报名截止周五，地点一号楼。', summary:'摘要甲' })
  const duplicate = seed({ subject:'同一份通知', body:'报名截止周五，地点一号楼。', summary:'AI生成的不同摘要乙' })
  const result = await panel.panelOverview(db, store)
  assert.equal(result.recommendations.length, 1)
  assert.equal(result.recommendations[0].infoId, duplicate.infoId)
  assert.equal(result.remaining, 0)
  assert.equal(db.prepare('SELECT panel_duplicate_of FROM info WHERE id=?').get(first.infoId).panel_duplicate_of, duplicate.infoId)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM emails').get().c, 2)
})

test('处置后的相同内容重复邮件不会再次出现；完全相同手动记录不误去重', async t => {
  const { db, store, seed } = fixture(t)
  seed({ subject:'一次性通知', body:'完整的相同通知' })
  const first = await panel.panelOverview(db, store)
  assert.equal(panel.panelAct(db, store, first.recommendations[0].id, 'archive').ok, true)
  seed({ subject:'一次性通知', body:'完整的相同通知' })
  assert.equal((await panel.panelOverview(db, store)).recommendations.length, 0)
  for (let n=0; n<2; n++) createInfo(db, { source_type:'manual', title:'手动条目', content:'相同文字', destination:'unverified' })
  assert.equal((await panel.panelOverview(db, store)).recommendations.length, 2)
})

test('长正文末尾不同、附件不同不合并；不能用相同AI摘要来去重', async t => {
  const { db, store, seed } = fixture(t)
  const prefix = '同样的开头。'.repeat(400)
  seed({ subject:'相同标题', body:prefix+'地点A', summary:'同样的AI摘要' })
  seed({ subject:'相同标题', body:prefix+'地点B', summary:'同样的AI摘要' })
  seed({ subject:'相同标题', body:prefix+'地点A', attachments:'[{"filename":"a.pdf","checksum":"changed"}]', summary:'同样的AI摘要' })
  assert.equal((await panel.panelOverview(db, store)).recommendations.length, 3)
})

test('正文仅HTML时也去重；全空邮件不能误合并', async t => {
  const { db, store, seed } = fixture(t)
  seed({ subject:'HTML通知', body:'', html:'<p>正文与地点A</p>' })
  seed({ subject:'HTML通知', body:'', html:'<p>正文与地点A</p>' })
  seed({ subject:'HTML通知', body:'', html:'<p>正文与地点B</p>' })
  seed({ subject:'', body:'' })
  seed({ subject:'', body:'' })
  assert.equal((await panel.panelOverview(db, store)).recommendations.length, 4)
})

test('正文更新会让缓存指纹失效，旧重复邮件内容改变后可以展示', async t => {
  const { db, store, seed } = fixture(t)
  const changed = seed({ subject:'更正通知', body:'原地点A' })
  seed({ subject:'更正通知', body:'原地点A' })
  assert.equal((await panel.panelOverview(db, store)).recommendations.length, 1)
  db.prepare('UPDATE emails SET body_text=? WHERE id=?').run('已更正为地点B', changed.emailId)
  assert.equal(db.prepare('SELECT panel_content_key FROM info WHERE id=?').get(changed.infoId).panel_content_key, null)
  assert.equal((await panel.panelContinue(db, store)).recommendations.length, 2)
})

test('Unicode、零宽字符及空白规范化；附件元数据不能丢失差异', () => {
  assert.equal(mailContentKey('ＡＢＣ', '地\u200b点  A\n见'), mailContentKey('ABC', '地点 A 见'))
  assert.equal(mailContentKey('t','b','[{"size":2,"filename":"a"}]'),mailContentKey('t','b','[{"filename":"a","size":2}]'))
  assert.notEqual(mailContentKey('t','b','[{"checksum":"a"}]'),mailContentKey('t','b','[{"checksum":"b"}]'))
})

test('归档是中性整理，不产生负向主题/来源学习，原件保留', async t => {
  const { db, store, seed } = fixture(t)
  const mail = seed({ subject:'招聘岗位说明', body:'岗位职责与联系方式' })
  const card = (await panel.panelOverview(db, store)).recommendations[0]
  assert.equal(panel.panelAct(db, store, card.id, 'archive').ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM preference_signal').get().c, 0)
  assert.equal(db.prepare('SELECT chosen_action FROM recommendation WHERE id=?').get(card.id).chosen_action, 'archive')
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(mail.infoId).destination, 'archive')
  assert.ok(db.prepare('SELECT id FROM emails WHERE id=?').get(mail.emailId))
})

test('同一分数体系：降低主题权重会使普通邮件默认归档，高关心资料进入重点', t => {
  const { db, seed } = fixture(t)
  seed({ subject:'学术讲座：科研论文培训资料', body:'研究方法资料，供后续回查', tier:null })
  db.prepare('UPDATE email_analysis SET tier=NULL').run()
  const candidate = listPanelCandidates(db, { limit:1 })[0]
  const now = new Date()
  const low = recommend.heuristicRecommendation(candidate, [], now, { academics:0 })
  const high = recommend.heuristicRecommendation(candidate, [], now, { academics:10 })
  assert.equal(high.score-low.score, 30)
  assert.equal(low.action, 'archive')
  assert.equal(low.priority, 'other')
  assert.equal(high.action, 'material')
  assert.equal(high.priority, 'focus')
})

test('已经过期的活动不会因旧截止时间获得最高权重或默认创建日程', t => {
  const { db, seed } = fixture(t)
  seed({ subject:'旧活动报名通知', action:'请报名', deadline:'2020-01-01T01:00:00Z', event:'2020-01-02T01:00:00Z' })
  const result = recommend.heuristicRecommendation(listPanelCandidates(db,{limit:1})[0], [], new Date())
  assert.equal(result.action,'archive')
  assert.equal(result.priority,'other')
})

test('AI输出决定重点/其他及归档动作，不是前端分数伪装分类；刷新不会重复请求', async t => {
  const { db, store, seed } = fixture(t, 'test-key')
  seed({ subject:'AI判断重点的普通通知' })
  seed({ subject:'AI判断其他的行动邮件', action:'请报名' })
  const calls = installAi(t, candidates => candidates.map(item => ({ id:item.id, action:'archive', priority:item.title.includes('重点')?'focus':'other', reason:'模型结合原文判断', confidence:0.88 })))
  const first = await panel.panelOverview(db,store)
  assert.equal(first.aiConfigured,true)
  assert.equal(first.recommendations.find(item => item.title.includes('重点')).priority,'focus')
  assert.equal(first.recommendations.find(item => item.title.includes('行动')).priority,'other')
  assert.ok(first.recommendations.every(item => item.recommendedAction==='archive'))
  await panel.panelOverview(db,store)
  assert.equal(calls(),1)
})

test('模型未返回有效条目时诚实标记规则回退，后续刷新仍保留错误提示', async t => {
  const { db, store, seed } = fixture(t,'test-key')
  seed()
  installAi(t, () => 'not valid JSON')
  const first = await panel.panelOverview(db,store)
  assert.equal(first.aiConfigured,false)
  assert.match(first.aiMessage,/失败|规则|回退/)
  const second = await panel.panelOverview(db,store)
  assert.equal(second.aiConfigured,false)
  assert.equal(second.aiMessage,first.aiMessage)
})

test('升级前priority为空的旧推荐只补判一次，已处理推荐不改动', async t => {
  const { db, store, seed } = fixture(t,'test-key')
  seed()
  installAi(t,candidates => candidates.map(item => ({ id:item.id,action:'archive',priority:'other',reason:'归档保留原件',confidence:0.8 })))
  const first = await panel.panelOverview(db,store)
  db.prepare('UPDATE recommendation SET priority=NULL').run()
  const upgraded = await panel.panelOverview(db,store)
  assert.equal(upgraded.recommendations[0].id,first.recommendations[0].id)
  assert.equal(upgraded.recommendations[0].priority,'other')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM recommendation').get().c,1)
})

test('等待AI期间用户已在别处归档的邮件不能重新被插入面板', async t => {
  const { db, store, seed } = fixture(t,'test-key')
  const mail = seed()
  installAi(t,candidates => {
    db.prepare("UPDATE info SET destination='archive' WHERE id=?").run(mail.infoId)
    return candidates.map(item => ({ id:item.id,action:'archive',priority:'other',reason:'已归档',confidence:0.8 }))
  })
  assert.equal((await panel.panelOverview(db,store)).recommendations.length,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM recommendation_batch').get().c,0)
})

test('a separate database connection invalidates dirty keys; its rolled-back writes do not invalidate', async t => {
  const { mkdtempSync, rmSync } = require('node:fs')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const { DatabaseSync } = require('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 'infoagent-panel-'))
  const cleanup = []
  const { db, store, seed } = fixture({ after:fn => cleanup.push(fn) }, '', join(dir, 'fixture.db'))
  t.after(() => {
    for (const close of cleanup) close()
    rmSync(dir, { recursive:true, force:true, maxRetries:5, retryDelay:100 })
  })
  const a = seed({ subject:'same', body:'body' }); const b = seed({ subject:'same', body:'body' })
  await panel.panelOverview(db, store)
  const external = new DatabaseSync(join(dir, 'fixture.db'))
  try {
    external.exec('BEGIN')
    external.prepare("UPDATE info SET destination='archive' WHERE id=?").run(a.infoId)
    external.exec('ROLLBACK')
    const before = changes(db)
    await panel.panelOverview(db, store, undefined, undefined, false)
    assert.equal(changes(db), before)
    external.prepare("UPDATE info SET destination='archive' WHERE id=?").run(a.infoId)
    assert.equal((await panel.panelOverview(db, store, undefined, undefined, false)).recommendations.length, 0)
    assert.equal(duplicateOf(db, b.infoId), a.infoId)
  } finally { external.close() }
})

test('valid persisted topics skip inference and empty continue has no duplicate unbounded candidate query', async t => {
  const { db, store, seed } = fixture(t)
  seed(); await panel.panelOverview(db, store)
  const topics = require('../.test-out/shared/topics.js')
  const dao = require('../.test-out/main/db/dao/panelDao.js')
  const infer = topics.inferTopic
  const candidates = dao.listPanelCandidates
  let topicCalls = 0
  let candidateCalls = 0
  topics.inferTopic = (...args) => { topicCalls++; return infer(...args) }
  dao.listPanelCandidates = (...args) => { candidateCalls++; return candidates(...args) }
  try {
    db.exec("UPDATE recommendation SET topic='uncategorized'")
    await panel.panelOverview(db, store, undefined, undefined, false)
    assert.equal(topicCalls, 0)
    await panel.panelContinue(db, store)
    assert.equal(candidateCalls, 1)
    db.exec('UPDATE recommendation SET topic=NULL')
    await panel.panelOverview(db, store, undefined, undefined, false)
    assert.equal(topicCalls, 1)
  } finally { topics.inferTopic = infer; dao.listPanelCandidates = candidates }
})

function duplicateOf(db, infoId) {
  return db.prepare('SELECT panel_duplicate_of AS id FROM info WHERE id=?').get(infoId).id
}
function changes(db) { return db.prepare('SELECT total_changes() AS n').get().n }

test('settled overview and source reads make zero writes, including default generation checks', async t => {
  const { db, store, seed } = fixture(t)
  seed({ subject:'same', body:'same' }); seed({ subject:'same', body:'same' }); seed()
  await panel.panelOverview(db, store)
  const before = changes(db)
  for (let n=0; n<3; n++) {
    await panel.panelOverview(db, store, undefined, undefined, false)
    await panel.panelOverview(db, store)
    panel.panelSources(db)
  }
  assert.equal(changes(db), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM panel_dirty_content').get().n, 0)
})

test('representative priority is handled > recommended > newest, and no-op dirty refresh updates no info', t => {
  const { db, seed } = fixture(t)
  const first = seed({ subject:'same', body:'same' })
  refreshPanelDuplicates(db)
  const batch = db.prepare("INSERT INTO recommendation_batch (mode, total) VALUES ('initial', 1)").run().lastInsertRowid
  db.prepare("INSERT INTO recommendation (batch_id,info_id,source_key,recommended_action,reason,confidence,score,status) VALUES (?,?,'email','archive','',1,1,'pending')").run(batch, first.infoId)
  const second = seed({ subject:'same', body:'same' })
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), null)
  assert.equal(duplicateOf(db, second.infoId), first.infoId)
  db.prepare("UPDATE info SET destination='archive' WHERE id=?").run(second.infoId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), second.infoId)
  assert.equal(duplicateOf(db, second.infoId), null)
  db.exec('CREATE TEMP TABLE info_writes(n); CREATE TEMP TRIGGER count_info_writes AFTER UPDATE ON info BEGIN INSERT INTO info_writes VALUES (1); END;')
  db.exec('INSERT INTO panel_dirty_content SELECT DISTINCT panel_content_key FROM info')
  refreshPanelDuplicates(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM info_writes').get().n, 0)
})

test('email and info mutations invalidate both old and new groups, email deletion/rebinding stay independent', t => {
  const { db, seed } = fixture(t)
  const first = seed({ subject:'same', body:'body' }); const second = seed({ subject:'same', body:'body' })
  refreshPanelDuplicates(db)
  db.prepare('UPDATE emails SET body_text=? WHERE id=?').run('changed', second.emailId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), null)
  assert.equal(duplicateOf(db, second.infoId), null)
  db.prepare('UPDATE emails SET body_text=? WHERE id=?').run('body', second.emailId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), second.infoId)
  db.prepare('UPDATE info SET source_email_id=NULL WHERE id=?').run(second.infoId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), null)
  db.prepare('UPDATE info SET source_email_id=? WHERE id=?').run(second.emailId, second.infoId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), second.infoId)
  db.prepare('DELETE FROM emails WHERE id=?').run(second.emailId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, first.infoId), null)
  assert.equal(duplicateOf(db, second.infoId), null)
  const rows = db.prepare('SELECT panel_content_key AS key FROM info ORDER BY id').all()
  assert.notEqual(rows[0].key, rows[1].key)
})

test('deleting an account with duplicate mail content does not hit the nested dirty-key unique constraint', t => {
  const { db, seed } = fixture(t)
  seed({ subject:'同一封通知', body:'同一份正文' })
  seed({ subject:'同一封通知', body:'同一份正文' })
  refreshPanelDuplicates(db)
  const accountId = db.prepare('SELECT id FROM accounts LIMIT 1').get().id
  assert.doesNotThrow(() => db.prepare('DELETE FROM accounts WHERE id=?').run(accountId))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM info').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM panel_dirty_content').get().n, 1)
})

test('recommendation insert/delete/rebind and representative delete invalidate affected keys', t => {
  const { db, seed } = fixture(t)
  const a = seed({ subject:'same', body:'body' }); const b = seed({ subject:'same', body:'body' })
  const c = seed({ subject:'other', body:'body' }); const d = seed({ subject:'other', body:'body' })
  refreshPanelDuplicates(db)
  const batch = db.prepare("INSERT INTO recommendation_batch (mode,total) VALUES ('initial',1)").run().lastInsertRowid
  const rec = db.prepare("INSERT INTO recommendation (batch_id,info_id,source_key,recommended_action,reason,confidence,score) VALUES (?,?,'email','archive','',1,1)").run(batch, a.infoId).lastInsertRowid
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, b.infoId), a.infoId)
  db.prepare('UPDATE recommendation SET info_id=? WHERE id=?').run(c.infoId, rec)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, a.infoId), b.infoId)
  assert.equal(duplicateOf(db, d.infoId), c.infoId)
  db.prepare('DELETE FROM recommendation WHERE id=?').run(rec)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, c.infoId), d.infoId)
  db.prepare('DELETE FROM info WHERE id=?').run(d.infoId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, c.infoId), null)
})

test('refresh inside rolled-back savepoint cannot leave stale dirty or fingerprint cache', t => {
  const { db, seed } = fixture(t)
  const a = seed({ subject:'same', body:'body' }); const b = seed({ subject:'same', body:'body' })
  refreshPanelDuplicates(db)
  db.exec('SAVEPOINT test_rollback')
  db.prepare('UPDATE emails SET body_text=? WHERE id=?').run('changed', b.emailId)
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, a.infoId), null)
  db.exec('ROLLBACK TO test_rollback; RELEASE test_rollback')
  assert.equal(duplicateOf(db, a.infoId), b.infoId)
  const before = changes(db)
  refreshPanelDuplicates(db)
  assert.equal(changes(db), before)
  db.exec('SAVEPOINT test_dirty')
  db.prepare("UPDATE info SET destination='archive' WHERE id=?").run(a.infoId)
  db.exec('SAVEPOINT inner_refresh')
  refreshPanelDuplicates(db)
  db.exec('ROLLBACK TO inner_refresh; RELEASE inner_refresh')
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, b.infoId), a.infoId)
  db.exec('ROLLBACK TO test_dirty; RELEASE test_dirty')
  refreshPanelDuplicates(db)
  assert.equal(duplicateOf(db, a.infoId), b.infoId)
})

test('pending keyset pages preserve full-source totals and priority counts; invalid direct options normalize safely', async t => {
  const { db, store, seed } = fixture(t)
  for (let n=0; n<12; n++) seed({ subject:`mail ${n}`, action:n%2 ? '请提交报名表' : null })
  createInfo(db, { source_type:'feed-alpha', title:'dynamic', content:'dynamic', destination:'unverified' })
  const generated = await panel.panelOverview(db, store)
  assert.equal(generated.sources.find(source => source.key === 'feed-alpha').pending, 1)
  const full = await panel.panelOverview(db, store, 'email', undefined, false)
  const focus = full.recommendations.filter(row => row.priority === 'focus').map(row => row.infoId)
  const first = await panel.panelOverview(db, store, 'email', undefined, false, { limit:2, priority:'focus' })
  const all = [...first.recommendations]
  let page = first
  while (page.nextBeforeInfoId !== null) {
    page = await panel.panelOverview(db, store, 'email', undefined, false, { limit:2, priority:'focus', beforeInfoId:page.nextBeforeInfoId })
    all.push(...page.recommendations)
  }
  assert.deepEqual(all.map(row => row.infoId), focus)
  assert.equal(new Set(all.map(row => row.infoId)).size, focus.length)
  assert.equal(first.pendingTotal, focus.length)
  assert.deepEqual(first.priorityCounts, { focus:focus.length, other:12-focus.length })
  assert.equal(first.sources.find(source => source.key === 'email').pending, 12)
  assert.equal(first.batchTotal, full.batchTotal)
  assert.equal(first.remaining, full.remaining)
  const invalid = await panel.panelOverview(db, store, 'email', undefined, false, { limit:-1, beforeInfoId:NaN, priority:'bad' })
  assert.equal(invalid.recommendations.length, 12)
})

test('AI in flight cannot commit stale changed content, disabled source or changed analysis', async t => {
  for (const mutation of ['content', 'source', 'analysis']) {
    const { db, store, seed } = fixture(t, 'test-key')
    const mail = seed()
    installAi(t, candidates => {
      if (mutation === 'content') db.prepare('UPDATE emails SET body_text=? WHERE id=?').run('changed body', mail.emailId)
      if (mutation === 'source') db.prepare("UPDATE inbox_source SET enabled=0 WHERE key='email'").run()
      if (mutation === 'analysis') db.prepare('UPDATE email_analysis SET summary=? WHERE email_id=?').run('changed summary', mail.emailId)
      return candidates.map(item => ({ id:item.id, action:'archive', priority:'other', reason:'old snapshot', confidence:0.8 }))
    })
    await panel.panelOverview(db, store)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recommendation').get().n, 0, mutation)
  }
})

test('非邮件来源不进入关心雷达：无主题、无八类权重，偏好另记 source_preference', async t => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { db, store, seed } = fixture(t)
  seed({ subject:'普通邮件通知', summary:'学校通知' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mailpref-'))
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }))
  const infoId = createInfo(db, { source_type:'manual', title:'AI 竞赛报名开始', content:'面向本科生的 AI 竞赛，周五截止' })

  const view = await panel.panelOverview(db, store, 'manual', dir)
  assert.equal(view.recommendations.length, 1)
  const item = view.recommendations[0]
  assert.equal(item.infoId, infoId)
  assert.equal(item.sourceKind, 'manual')
  assert.equal(item.topic, '')
  assert.equal(item.topicLabel, '')
  assert.deepEqual(view.concerns, {})
  assert.deepEqual(view.learning, [])

  // 邮件视图仍然带八类权重，雷达只在这里出现。
  const mailView = await panel.panelOverview(db, store, 'email', dir)
  assert.equal(Object.keys(mailView.concerns).length, 8)
  assert.equal(mailView.recommendations[0].topicLabel.length > 0, true)

  const { getMailTagService } = require('../.test-out/main/services/mailTags.js')
  const before = { ...(await getMailTagService(dir).preferencesGet()).parentWeights }
  await panel.adjustConcernFromAct(db, item.id, 'material', dir)
  assert.deepEqual({ ...(await getMailTagService(dir).preferencesGet()).parentWeights }, before)

  assert.equal(panel.panelAct(db, store, item.id, 'material').ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM preference_signal').get().n, 0)
  const stored = db.prepare("SELECT dimension, key, weight FROM source_preference WHERE source_key = 'manual'").all()
  assert.ok(stored.some(row => row.dimension === 'source' && row.weight > 0))
  assert.ok(stored.some(row => row.dimension === 'keyword' && row.weight > 0))

  // 邮件反馈只更新雷达链路，不写非邮件偏好。
  assert.equal(panel.panelAct(db, store, mailView.recommendations[0].id, 'material').ok, true)
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM preference_signal').get().n > 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_preference WHERE source_key = 'email'").get().n, 0)
})

test('跨来源的重点视图只返回重点条目，并包含其他来源的重点', async t => {
  const { db, store, seed } = fixture(t)
  const mail = seed({ subject:'普通邮件' })
  const infoId = createInfo(db, { source_type:'manual', title:'手工来源的重点条目', content:'需要先看的内容' })
  await panel.panelOverview(db, store)
  db.prepare("UPDATE recommendation SET priority='other' WHERE info_id = ?").run(mail.infoId)
  db.prepare("UPDATE recommendation SET priority='focus' WHERE info_id = ?").run(infoId)

  const focus = await panel.panelOverview(db, store, undefined, undefined, false, { limit:30, priority:'focus' })
  assert.deepEqual(focus.recommendations.map(item => item.infoId), [infoId])
  assert.equal(focus.priorityCounts.focus, 1)
  assert.equal(focus.focusTotal, 1)
  assert.equal(focus.pendingTotal, 1)
  // 切到任意单一来源时，“重点”角标仍是全局重点数。
  const emailOnly = await panel.panelOverview(db, store, 'email', undefined, false, { limit:30 })
  assert.equal(emailOnly.priorityCounts.focus, 0)
  assert.equal(emailOnly.focusTotal, 1)
  assert.equal(focus.recommendations[0].sourceKind, 'manual')
  assert.equal(focus.recommendations[0].topicLabel, '')

  const all = await panel.panelOverview(db, store, undefined, undefined, false, { limit:30 })
  assert.equal(all.recommendations.length, 2)
})


test('mail date ranges filter before paging and keep counts consistent', async t => {
  const { db, store, seed } = fixture(t)
  const ages = [0, 1, 2, 3, 6, 7, 13, 14, 29, 30, 45]
  const byId = new Map()
  for (const age of ages) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - age)
    const mail = seed({ date: d.toISOString() })
    byId.set(mail.infoId, age)
  }
  await panel.panelOverview(db, store)
  await panel.panelContinue(db, store)
  for (const range of [1, 3, 7, 14, 30, 'older30']) {
    const expected = ages.filter(age => range === 'older30' ? age >= 30 : age < range).length
    const query = { limit: 2, mailDateRange: range }
    let view = await panel.panelOverview(db, store, undefined, undefined, false, query)
    assert.equal(view.pendingTotal, expected)
    assert.equal(view.priorityCounts.focus + view.priorityCounts.other, expected)
    const seen = []
    for (;;) {
      seen.push(...view.recommendations.map(row => row.infoId))
      if (!view.nextBeforeInfoId) break
      view = await panel.panelOverview(db, store, undefined, undefined, false, { ...query, beforeInfoId: view.nextBeforeInfoId })
      assert.equal(view.pendingTotal, expected)
    }
    assert.equal(seen.length, expected)
    assert.equal(new Set(seen).size, expected)
    for (const id of seen) assert.ok(range === 'older30' ? byId.get(id) >= 30 : byId.get(id) < range)
  }
})


test('v25 clears mail decisions and learning while preserving saved material and pending mail', async t => {
  const { db, store, seed } = fixture(t)
  const handled = seed({subject:'saved material'})
  const waiting = seed({subject:'still pending'})
  const before = await panel.panelOverview(db, store, 'email')
  const chosen = before.recommendations.find(row => row.infoId === handled.infoId)
  assert.equal(panel.panelAct(db, store, chosen.id, 'material').ok, true)
  db.prepare('INSERT INTO keyword_profile(keyword, weight, evidence_count, repeat_count, last_feedback_at, last_seen_at) VALUES (?,?,?,?,?,?)').run('test', 2, 1, 0, new Date().toISOString(), new Date().toISOString())
  assert.ok(db.prepare('SELECT COUNT(*) n FROM feedback_event').get().n > 0)
  const v25 = MIGRATIONS.find(m => m.version === 25)
  assert.ok(v25)
  db.exec('BEGIN')
  for (const sql of v25.up) db.exec(sql)
  db.exec('COMMIT')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recommendation').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM feedback_event').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preference_signal').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM keyword_profile').get().n, 0)
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(handled.infoId).destination, 'keep')
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(waiting.infoId).destination, 'unverified')
  const newOverview = await panel.panelOverview(db, store, 'email')
  assert.ok(newOverview.recommendations.some(row => row.infoId === waiting.infoId))
  assert.ok(!newOverview.recommendations.some(row => row.infoId === handled.infoId))
  assert.equal(migrate(db), 29)
})

test('recent unread mail with deadline stays urgent and focus despite low AI priority', async t => {
  const { db, store, seed } = fixture(t)
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString()
  const mail = seed({subject:'deadline notice', deadline:due})
  await panel.panelOverview(db, store, 'email')
  db.prepare("UPDATE recommendation SET priority='other' WHERE info_id=?").run(mail.infoId)
  const focus = await panel.panelOverview(db, store, 'email', undefined, false, {limit:30, priority:'focus', mailDateRange:3})
  assert.equal(focus.recommendations.length, 1)
  assert.equal(focus.recommendations[0].urgent, true)
  assert.equal(focus.recommendations[0].priority, 'focus')
  assert.equal(focus.recommendations[0].emailId, mail.emailId)
  db.prepare('UPDATE emails SET unread=0 WHERE id=?').run(mail.emailId)
  const afterRead = await panel.panelOverview(db, store, 'email', undefined, false, {limit:30, priority:'focus', mailDateRange:3})
  assert.equal(afterRead.recommendations.length, 0)
  assert.equal(afterRead.priorityCounts.other, 1)
})

test('keyword profile manual edit, add and delete stay global', t => {
  const { db } = fixture(t)
  const now = new Date()
  db.prepare(
    'INSERT INTO keyword_profile(keyword, weight, evidence_count, repeat_count, email_count, qq_count, last_feedback_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run('手动词', 0.7, 2, 0, 2, 0, now.toISOString(), now.toISOString())

  let items = keywordProfile.setKeywordProfileWeight(db, ' 手动词 ', 1.4, now)
  assert.equal(items.find(item => item.keyword === '手动词').weight, 1.4)

  items = keywordProfile.setKeywordProfileWeight(db, '新词', -0.8, now)
  const added = items.find(item => item.keyword === '新词')
  assert.ok(added)
  assert.equal(added.weight, -0.8)
  assert.equal(added.evidenceCount, 0)

  items = keywordProfile.deleteKeywordProfile(db, '手动词')
  assert.equal(items.some(item => item.keyword === '手动词'), false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM keyword_profile WHERE keyword=?').get('手动词').n, 0)

  items = keywordProfile.setKeywordProfileWeight(db, '新词', 0, now)
  assert.equal(items.some(item => item.keyword === '新词'), false)
})
