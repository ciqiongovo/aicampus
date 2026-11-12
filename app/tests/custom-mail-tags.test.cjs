'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { openDatabase } = require('../.test-out/main/db/database.js')
const { migrate } = require('../.test-out/main/db/migrations.js')
const { insertAccount, updateAccount, deleteAccount } = require('../.test-out/main/db/dao/accountsDao.js')
const { upsertEmail, searchEmails, getEmailListItem, setEmailStarred } = require('../.test-out/main/db/dao/emailsDao.js')
const { upsertAnalysis } = require('../.test-out/main/db/dao/emailAnalysisDao.js')
const tags = require('../.test-out/main/db/dao/mailTagsDao.js')
const { DEFAULT_SETTINGS, IPC } = require('../.test-out/shared/types.js')
const { CognitionService } = require('../.test-out/main/services/jarvis/cognition.js')
const { MailTagService } = require('../.test-out/main/services/mailTags.js')

let userData, bridge
const handlers = new Map()
const electron = {
  app: { getPath: () => userData },
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  ipcRenderer: { invoke: (channel, ...args) => Promise.resolve(handlers.get(channel)(null, ...args)) },
  contextBridge: { exposeInMainWorld: (_key, api) => { bridge = api } }
}
const originalLoad = Module._load
Module._load = function (id, ...args) { return id === 'electron' ? electron : originalLoad.call(this, id, ...args) }
let AnalysisPipeline, registerMailIpc, registerMailTagsIpc
try {
  ;({ AnalysisPipeline } = require('../.test-out/main/services/ai/pipeline.js'))
  ;({ registerMailIpc } = require('../.test-out/main/ipc/mail.js'))
  ;({ registerMailTagsIpc } = require('../.test-out/main/ipc/mailTags.js'))
  require('../.test-out/preload/index.js')
} finally { Module._load = originalLoad }

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'infoagent-custom-labels-'))
  userData = dir
  const path = join(dir, 'mail.db')
  const state = { db: openDatabase(path), dir, path }
  const settings = { ...DEFAULT_SETTINGS, aiProvider: 'mock', aiBaseURL: 'https://never-network.invalid/v1', aiModel: 'mock-model', aiApiKey: 'mock-key', aiAuthorizedFor: 'mock|https://never-network.invalid/v1' }
  state.settings = settings
  state.store = { get: async () => ({ ...settings }), peek: () => ({ ...settings }) }
  state.pipeline = new AnalysisPipeline(state.db, state.store)
  t.after(() => { state.db.close(); rmSync(dir, { recursive: true, force: true }) })
  return state
}
function account(db, extra = {}) {
  return insertAccount(db, { provider: 'qq', label: 'Test', address: 'me@example.com', host: 'imap.example.com', port: 993, encryption: 'ssl', username: 'me', secret_enc: '', folder: 'INBOX', auth_mode: 'appPassword', last_uidvalidity: null, last_uid: null, last_sync_at: null, sync_error: null, ...extra })
}
function email(db, accountId, uid = 1, extra = {}) {
  return upsertEmail(db, { account_id: accountId, folder: 'INBOX', uid, message_id: '<' + uid + '@example.com>', subject: 'needle project ' + uid, from_addr: 'teacher@example.com', to_addr: 'me@example.com', cc: '', date_utc: '2026-10-17T12:00:00Z', date_raw: null, unread: 1, body_text: 'This is a project invitation', body_html: '', attachments_json: '[]', size: 20, ...extra })
}
// 把已升级到最新版本的库还原成 v0.3 的 v12 形态，用来验证 v13/v14 是增量追加而非重建。
// 顺序有讲究：先删引用这些列的索引，再删列，最后删 todo_lists，否则 DROP COLUMN 会因为外键报错。
function downgradeToV12(db) {
  for (const trigger of ['info_panel_ai', 'info_panel_ad', 'info_panel_key_au', 'info_panel_route_au', 'info_panel_content_au', 'recommendation_panel_ai', 'recommendation_panel_ad', 'recommendation_panel_au']) db.exec('DROP TRIGGER IF EXISTS ' + trigger)
  db.exec('DROP TABLE IF EXISTS panel_dirty_content; DROP INDEX IF EXISTS idx_info_panel_missing_key; DROP INDEX IF EXISTS idx_info_source_email')
  db.exec('DROP TRIGGER IF EXISTS emails_panel_content_au; DROP INDEX IF EXISTS idx_info_panel_content_key; DROP INDEX IF EXISTS idx_info_panel_duplicate')
  db.exec('ALTER TABLE info DROP COLUMN panel_duplicate_of; ALTER TABLE info DROP COLUMN panel_content_key')
  db.exec('DROP TABLE IF EXISTS keyword_feedback; DROP TABLE IF EXISTS keyword_profile; DROP TABLE IF EXISTS email_keyword; DROP TABLE IF EXISTS material_folders; DROP TABLE IF EXISTS material_tags; DROP TABLE IF EXISTS feedback_event; DROP TABLE IF EXISTS preference_signal; DROP TABLE IF EXISTS recommendation; DROP TABLE IF EXISTS recommendation_batch; DROP TABLE IF EXISTS inbox_source')
  db.exec('DROP INDEX IF EXISTS idx_info_material_folder')
  db.exec('ALTER TABLE info DROP COLUMN material_folder')
  db.exec('DROP TABLE IF EXISTS email_custom_tag_matches; DROP TABLE IF EXISTS email_custom_tags; DROP TABLE IF EXISTS mail_tag_definitions')
  db.exec('DROP TABLE IF EXISTS zhihu_push; DROP TABLE IF EXISTS zhihu_state')
  db.exec('DROP INDEX IF EXISTS idx_items_event_start; DROP INDEX IF EXISTS idx_items_list; DROP INDEX IF EXISTS idx_items_completed')
  for (const col of ['list_id', 'completed_at', 'priority', 'event_end_at', 'all_day']) db.exec('ALTER TABLE items DROP COLUMN ' + col)
  db.exec('DROP TABLE IF EXISTS todo_lists')
  db.exec('DELETE FROM schema_migrations WHERE version >= 13')
}

function analysis(db, id) {
  upsertAnalysis(db, { email_id: id, status: 'analyzed', category: '重要通知', summary: '旧分析摘要', action_required: '旧行动', deadline_raw: null, deadline_at: null, deadline_kind: null, event_start_at: null, applicable_to: null, confidence: 0.9, tier: 'review', evidence_json: '[]', model: 'old', provider: 'old', error: null, analyzed_at: '2026-10-16T12:00:00Z' })
}
function assigned(db, id) { return (tags.getMailTagsForEmails(db, [id]).get(id) ?? []).map(tag => tag.id) }
function mockAi(t, fn) {
  const previous = global.fetch, calls = []
  global.fetch = async (url, options) => {
    const request = { url, ...JSON.parse(options.body) }
    calls.push(request)
    const result = await fn(request, calls.length)
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] }) }
  }
  t.after(() => { global.fetch = previous })
  return calls
}

test('v0.3 schema12 upgrades replay v13-v27 additively and leave emails, analysis, legacy file intact', t => {
  const f = fixture(t), id = email(f.db, account(f.db))
  analysis(f.db, id)
  const legacyPath = join(f.dir, 'mail-tags.json'), legacy = '{"legacy":"untouched"}'
  writeFileSync(legacyPath, legacy)
  downgradeToV12(f.db)
  assert.equal(f.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 12)
  f.db.close()
  f.db = openDatabase(f.path)
  assert.equal(f.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 29)
  assert.equal(f.db.prepare('SELECT summary FROM email_analysis WHERE email_id = ?').get(id).summary, '旧分析摘要')
  assert.equal(getEmailListItem(f.db, id).subject, 'needle project 1')
  assert.deepEqual(getEmailListItem(f.db, id).tags, [])
  assert.equal(readFileSync(legacyPath, 'utf8'), legacy)
  assert.equal(readdirSync(f.dir).filter(name => name.endsWith('.bak')).length, 1)
  assert.equal(migrate(f.db), 29)
})

test('definitions trim, reject case/NFKC duplicates, validate lengths and hostile IDs', t => {
  const { db } = fixture(t)
  const tag = tags.createMailTagDefinition(db, { name: '  Work  ', description: '  projects  ' })
  assert.deepEqual(tag, { id: tag.id, name: 'Work', description: 'projects' })
  assert.equal(tags.createMailTagDefinition(db, { name: 'Other' }).description, '')
  for (const name of ['work', 'WORK', 'Ｗｏｒｋ']) assert.throws(() => tags.createMailTagDefinition(db, { name }), /已存在/)
  for (const name of ['', '   ', 'x'.repeat(41), 'a\nword', '<script>', 12]) assert.throws(() => tags.createMailTagDefinition(db, { name }), /名称/)
  for (const description of ['x'.repeat(501), '<script>', 1, null]) assert.throws(() => tags.createMailTagDefinition(db, { name: 'Invalid', description }), /描述/)
  assert.equal(tags.createMailTagDefinition(db, { name: 'x'.repeat(40), description: 'x'.repeat(500) }).name.length, 40)
  for (const id of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => tags.deleteMailTagDefinition(db, id), /正整数/)
  for (const tagIds of [null, '1', [0], ['1'], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array(101).fill(1)]) {
    for (const tagMatch of [undefined, 'any', 'all']) assert.throws(() => searchEmails(db, { tagIds, tagMatch }), /标签 ID/)
  }
  while (tags.listMailTagDefinitions(db).length < 100) tags.createMailTagDefinition(db, { name: 'label' + tags.listMailTagDefinitions(db).length })
  assert.throws(() => tags.createMailTagDefinition(db, { name: 'TooMany' }), /100/)
})

test('SQL tag OR combines with account/folder/keyword/unread/star/attachment/category/status before count and pagination', t => {
  const { db } = fixture(t), a = account(db), other = account(db)
  const first = tags.createMailTagDefinition(db, { name: 'first' }), second = tags.createMailTagDefinition(db, { name: 'second' }), defs = [first, second]
  const ids = []
  for (let uid = 1; uid <= 6; uid++) {
    const id = email(db, a, uid, { attachments_json: '[{"filename":"test.pdf"}]' })
    ids.push(id); analysis(db, id); setEmailStarred(db, id, true)
    tags.saveCustomTagMatch(db, id, uid === 1 ? [first.id, second.id] : [uid % 2 ? first.id : second.id], defs, 'seed')
  }
  const excludedAccount = email(db, other), excludedFolder = email(db, a, 10, { folder: 'Archive' })
  for (const id of [excludedAccount, excludedFolder]) { tags.saveCustomTagMatch(db, id, [first.id], defs, 'seed'); analysis(db, id); setEmailStarred(db, id, true) }
  const query = { tagIds: [first.id, second.id, first.id], accountId: a, folder: 'INBOX', keyword: 'needle', unreadOnly: true, starredOnly: true, hasAttachment: true, category: '重要通知', analysisStatus: 'analyzed', limit: 2 }
  const page1 = searchEmails(db, query), page2 = searchEmails(db, { ...query, offset: 2 }), page3 = searchEmails(db, { ...query, offset: 4 })
  assert.equal(page1.total, 6); assert.equal(page2.total, 6); assert.equal(page3.total, 6)
  assert.deepEqual([...page1.rows, ...page2.rows, ...page3.rows].map(row => row.id), [...ids].reverse())
  assert.equal(searchEmails(db, { ...query, offset: 6 }).rows.length, 0)
  assert.deepEqual(getEmailListItem(db, ids[0]).tags.map(tag => tag.id), [first.id, second.id])
  assert.equal(searchEmails(db, { ...query, tagIds: [999999] }).total, 0)
  assert.equal(searchEmails(db, { ...query, tagIds: [] }).total, 6)
  assert.equal(searchEmails(db, { ...query, keyword: 'project 1' }).total, 1)
})

test('SQL tag any/all matches per email, deduplicates IDs and uses identical count/pagination filters', t => {
  const { db } = fixture(t), a = account(db)
  const defs = ['first', 'second', 'extra'].map(name => tags.createMailTagDefinition(db, { name }))
  const [first, second, extra] = defs
  const selections = [[first.id], [second.id], [first.id, second.id], [first.id, second.id, extra.id], [first.id, second.id], [], [extra.id]]
  const ids = selections.map((selection, index) => {
    const id = email(db, a, index + 1)
    tags.saveCustomTagMatch(db, id, selection, defs, 'seed')
    return id
  })
  const query = { tagIds: [first.id, second.id, first.id], limit: 2 }
  for (const tagMatch of [undefined, 'any', 'all']) {
    const expected = (tagMatch === 'all' ? ids.slice(2, 5) : ids.slice(0, 5)).reverse()
    const paged = []
    for (let offset = 0; offset <= 6; offset += 2) {
      const page = searchEmails(db, { ...query, tagMatch, offset })
      assert.equal(page.total, expected.length)
      assert.deepEqual(page.rows.map(row => row.id), expected.slice(offset, offset + 2))
      paged.push(...page.rows.map(row => row.id))
    }
    assert.deepEqual(paged, expected)
    assert.equal(searchEmails(db, { tagMatch, tagIds: [] }).total, ids.length)
    assert.equal(searchEmails(db, { tagMatch }).total, ids.length)
    assert.equal(searchEmails(db, { tagMatch, tagIds: [999999] }).total, 0)
    assert.equal(searchEmails(db, { tagMatch, tagIds: [first.id, 999999] }).total, tagMatch === 'all' ? 0 : 4)
    assert.deepEqual(searchEmails(db, { tagMatch, tagIds: Array(100).fill(first.id) }).rows.map(row => row.id), [ids[4], ids[3], ids[2], ids[0]])
  }
  assert.deepEqual(searchEmails(db, { tagIds: [first.id, extra.id], tagMatch: 'all' }).rows.map(row => row.id), [ids[3]])
})

test('SQL tag modes AND account/folder/FTS-or-LIKE with all independent unread/attachment/star combinations', t => {
  const { db } = fixture(t), a = account(db), other = account(db)
  const defs = ['first', 'second'].map(name => tags.createMailTagDefinition(db, { name }))
  const tagIds = defs.map(tag => tag.id), seeds = []
  let uid = 0
  for (let mask = 0; mask < 8; mask++) {
    for (const tagCount of [1, 2]) {
      const id = email(db, a, ++uid, { unread: mask & 1 ? 1 : 0, attachments_json: mask & 2 ? '[{"filename":"test.pdf"}]' : '[]' })
      setEmailStarred(db, id, Boolean(mask & 4)); analysis(db, id)
      tags.saveCustomTagMatch(db, id, tagIds.slice(0, tagCount), defs, 'seed')
      seeds.push({ id, mask, tagCount })
    }
  }
  const negatives = [
    { account_id: other },
    { folder: 'Archive' },
    { subject: 'unrelated', body_text: 'no match' },
    { category: '一般信息' },
    { pending: true }
  ]
  for (const { category, pending, ...extra } of negatives) {
    const id = email(db, a, ++uid, { attachments_json: '[{"filename":"test.pdf"}]', ...extra })
    setEmailStarred(db, id, true)
    if (!pending) analysis(db, id)
    if (category) db.prepare('UPDATE email_analysis SET category = ? WHERE email_id = ?').run(category, id)
    tags.saveCustomTagMatch(db, id, tagIds, defs, 'seed')
  }
  for (const tagMatch of [undefined, 'any', 'all']) {
    for (const keyword of ['needle', 'needle project']) {
      for (let mask = 0; mask < 8; mask++) {
        const query = { accountId: a, folder: 'INBOX', keyword, category: '重要通知', analysisStatus: 'analyzed', tagIds, tagMatch, unreadOnly: Boolean(mask & 1), hasAttachment: Boolean(mask & 2), starredOnly: Boolean(mask & 4), limit: 200 }
        const expected = seeds.filter(seed => (seed.mask & mask) === mask && (tagMatch !== 'all' || seed.tagCount === 2)).map(seed => seed.id).reverse()
        const result = searchEmails(db, query)
        assert.equal(result.total, expected.length, JSON.stringify(query))
        assert.deepEqual(result.rows.map(row => row.id), expected, JSON.stringify(query))
      }
    }
  }
})

test('delete cascades, restart persists definitions/relations/fingerprints, mail/account cascade cleans relations', t => {
  const f = fixture(t), a = account(f.db), id = email(f.db, a)
  const one = tags.createMailTagDefinition(f.db, { name: 'one' }), two = tags.createMailTagDefinition(f.db, { name: 'two' })
  tags.saveCustomTagMatch(f.db, id, [one.id, two.id], [one, two], 'matched')
  tags.deleteMailTagDefinition(f.db, one.id)
  f.db.close(); f.db = openDatabase(f.path)
  assert.deepEqual(tags.listMailTagDefinitions(f.db), [two])
  assert.deepEqual(assigned(f.db, id), [two.id])
  assert.equal(tags.customTagsMatchIsCurrent(f.db, id, 'matched'), true)
  const next = tags.createMailTagDefinition(f.db, { name: 'one' })
  assert.ok(next.id > two.id)
  deleteAccount(f.db, a)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM email_custom_tags').get().n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM email_custom_tag_matches').get().n, 0)
})

test('preload/IPC whitelist returns label definitions/list/detail and create never invokes AI', async t => {
  const f = fixture(t), id = email(f.db, account(f.db))
  let matches = 0
  handlers.clear()
  registerMailIpc(f.db, {}, f.pipeline)
  registerMailTagsIpc(f.db, { matchCustomTags: async () => { matches++; return { ok: true, message: 'matched' } } })
  const tag = await bridge.mailTagDefinitionsCreate({ name: 'IPC tag', description: 'IPC description' })
  assert.equal(matches, 0)
  assert.deepEqual(await bridge.mailTagDefinitionsList(), [tag])
  tags.saveCustomTagMatch(f.db, id, [tag.id], [tag], 'ipc')
  assert.deepEqual((await bridge.mailList({ tagIds: [tag.id] })).items[0].tags, [tag])
  assert.deepEqual((await bridge.mailGet(id)).tags, [tag])
  assert.equal((await bridge.mailTagsMatch()).ok, true); assert.equal(matches, 1)
  await bridge.mailTagDefinitionsDelete(tag.id)
  assert.equal((await bridge.mailList({ tagIds: [tag.id] })).total, 0)
  assert.deepEqual((await bridge.mailGet(id)).tags, [])
  assert.ok(handlers.has(IPC.mailTagsMatch))
})

test('preload/IPC forwards tagMatch and composes tag modes with independent booleans before pagination', async t => {
  const f = fixture(t), a = account(f.db)
  const defs = ['first', 'second'].map(name => tags.createMailTagDefinition(f.db, { name }))
  const tagIds = defs.map(tag => tag.id), ids = []
  for (let uid = 1; uid <= 5; uid++) {
    const id = email(f.db, a, uid, { unread: uid === 5 ? 0 : 1, attachments_json: '[{"filename":"test.pdf"}]' })
    ids.push(id); setEmailStarred(f.db, id, true); analysis(f.db, id)
    tags.saveCustomTagMatch(f.db, id, uid <= 2 ? [tagIds[uid - 1]] : tagIds, defs, 'seed')
  }
  handlers.clear()
  registerMailIpc(f.db, {}, f.pipeline)
  const query = { accountId: a, folder: 'INBOX', keyword: 'needle', unreadOnly: true, hasAttachment: true, starredOnly: true, category: '重要通知', analysisStatus: 'analyzed', tagIds: [...tagIds, tagIds[0]], limit: 1 }
  for (const tagMatch of [undefined, 'any', 'all']) {
    const expected = (tagMatch === 'all' ? ids.slice(2, 4) : ids.slice(0, 4)).reverse()
    for (let offset = 0; offset <= expected.length; offset++) {
      const page = await bridge.mailList({ ...query, tagMatch, offset })
      assert.equal(page.total, expected.length)
      assert.deepEqual(page.items.map(item => item.id), expected.slice(offset, offset + 1))
    }
  }
  assert.equal((await bridge.mailList({ ...query, tagMatch: 'all', tagIds: [] })).total, 4)
  assert.equal((await bridge.mailList({ ...query, tagMatch: 'all', tagIds: undefined })).total, 4)
  assert.equal((await bridge.mailList({ ...query, tagMatch: 'all', tagIds: [tagIds[0], 999999] })).total, 0)
  assert.throws(() => handlers.get(IPC.mailList)(null, { tagMatch: 'all', tagIds: [0] }), /标签 ID/)
})

test('AI empty definitions, unconfigured/unauthorized, read permission, disabled account and unauthorized override send no mail', async t => {
  const f = fixture(t), a = account(f.db), id = email(f.db, a)
  const calls = mockAi(t, () => { throw new Error('must not call model') })
  assert.equal((await f.pipeline.matchCustomTags()).ok, true)
  tags.createMailTagDefinition(f.db, { name: 'one' })
  f.settings.aiAuthorizedFor = ''
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  f.settings.aiAuthorizedFor = 'mock|' + f.settings.aiBaseURL
  f.settings.aiModel = ''
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  f.settings.aiModel = 'mock-model'
  const cognition = new CognitionService(f.db), policy = cognition.agentPolicyGet()
  cognition.agentPolicySet({ readDomains: policy.readDomains.filter(domain => domain !== 'email') })
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  cognition.agentPolicySet({ readDomains: policy.readDomains })
  updateAccount(f.db, a, { aiEnabled: 0 })
  assert.match((await f.pipeline.matchCustomTags()).message, /跳过.*1/)
  assert.equal((await f.pipeline.analyzeOne(id)).ok, false)
  updateAccount(f.db, a, { aiEnabled: 1, aiProvider: 'mock', aiBaseUrl: 'https://unauthorized.invalid/v1', aiModel: 'override' })
  await f.pipeline.matchCustomTags()
  assert.equal(calls.length, 0)
  assert.deepEqual(assigned(f.db, id), [])
})

test('AI multi-label whitelist, explicit no-match and fingerprint avoid unchanged reruns without touching legacy analysis/rating/items', async t => {
  const f = fixture(t), id = email(f.db, account(f.db))
  analysis(f.db, id)
  f.db.prepare("INSERT INTO items (title,source_email_id,status) VALUES (?,?,'待核实')").run('用户事项', id)
  const legacy = new MailTagService(join(f.dir, 'mail-tags.json'))
  await legacy.feedback(f.db, id, { interest: 9, parentLabels: ['competition'], subLabels: ['用户评分', '旧话题'] })
  const beforeFile = readFileSync(join(f.dir, 'mail-tags.json'), 'utf8')
  const beforeAnalysis = f.db.prepare('SELECT * FROM email_analysis').all(), beforeItems = f.db.prepare('SELECT * FROM items').all(), beforeInfo = f.db.prepare('SELECT * FROM info').all()
  const one = tags.createMailTagDefinition(f.db, { name: 'Project', description: 'Project invitations' }), two = tags.createMailTagDefinition(f.db, { name: 'Events', description: 'Meetups' })
  let output = { custom_tag_ids: [one.id, two.id, one.id, 999999] }
  const calls = mockAi(t, request => {
    const system = request.messages[0].content
    assert.ok(system.includes('Project invitations')); assert.ok(system.includes('Meetups'))
    assert.ok(!system.includes('parent_labels')); assert.ok(!system.includes('关心度'))
    return output
  })
  assert.equal((await f.pipeline.matchCustomTags()).ok, true)
  assert.deepEqual(assigned(f.db, id), [one.id, two.id])
  await f.pipeline.matchCustomTags(); assert.equal(calls.length, 1)
  // 内容变化使缓存失效；显式[]是成功无匹配，不是错误。
  f.db.prepare('UPDATE emails SET subject = subject || ? WHERE id = ?').run(' changed', id)
  output = { custom_tag_ids: [] }
  assert.equal((await f.pipeline.matchCustomTags()).ok, true)
  assert.deepEqual(assigned(f.db, id), [])
  await f.pipeline.matchCustomTags(); assert.equal(calls.length, 2)
  assert.deepEqual(f.db.prepare('SELECT * FROM email_analysis').all(), beforeAnalysis)
  assert.deepEqual(f.db.prepare('SELECT * FROM items').all(), beforeItems)
  assert.deepEqual(f.db.prepare('SELECT * FROM info').all(), beforeInfo)
  assert.equal(readFileSync(join(f.dir, 'mail-tags.json'), 'utf8'), beforeFile)
  f.db.close(); f.db = openDatabase(f.path)
  await new AnalysisPipeline(f.db, f.store).matchCustomTags(); assert.equal(calls.length, 2)
})

test('AI omitted/invalid/hallucinated results and request failure retain old tags and permit retry', async t => {
  const f = fixture(t), id = email(f.db, account(f.db)), tag = tags.createMailTagDefinition(f.db, { name: 'existing' })
  tags.saveCustomTagMatch(f.db, id, [tag.id], [tag], 'old-fingerprint')
  let output = {}, throws = false
  const calls = mockAi(t, () => { if (throws) throw new Error('simulated failure'); return output })
  for (const invalid of [{}, { custom_tag_ids: null }, { custom_tag_ids: '1' }, { custom_tag_ids: [String(tag.id)] }, { custom_tag_ids: [tag.id, -1] }, { custom_tag_ids: [999999] }, 'not json']) {
    output = invalid
    assert.equal((await f.pipeline.matchCustomTags()).ok, false)
    assert.deepEqual(assigned(f.db, id), [tag.id])
    assert.equal(tags.customTagsMatchIsCurrent(f.db, id, 'old-fingerprint'), true)
  }
  throws = true
  const count = calls.length
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  assert.equal(calls.length, count + 2)
  assert.deepEqual(assigned(f.db, id), [tag.id])
  throws = false; output = { custom_tag_ids: [] }
  assert.equal((await f.pipeline.matchCustomTags()).ok, true)
  assert.deepEqual(assigned(f.db, id), [])
})

test('new analysis injects definitions in same request and shares queue with rematch', async t => {
  const f = fixture(t), id = email(f.db, account(f.db)), tag = tags.createMailTagDefinition(f.db, { name: 'Live label', description: 'Dynamically supplied definition' })
  let unblock, started
  const wait = new Promise(resolve => { unblock = resolve }), begin = new Promise(resolve => { started = resolve })
  const calls = mockAi(t, async request => {
    assert.ok(request.messages[0].content.includes('Dynamically supplied definition'))
    assert.ok(request.messages[0].content.includes('parent_labels')) // 事项抽取旧字段仍兼容。
    started(); await wait
    return { category: '一般信息', summary: 'New summary', parent_labels: ['competition', 'activities'], sub_labels: ['活动邀请', '项目活动'], custom_tag_ids: [tag.id, 999999] }
  })
  const first = f.pipeline.analyzeOne(id)
  await begin
  const rematch = f.pipeline.matchCustomTags()
  assert.equal(calls.length, 1)
  unblock()
  assert.equal((await first).ok, true); assert.equal((await rematch).ok, true)
  assert.equal(calls.length, 1) // 重匹配排队，初次分析已写相同指纹后直接跳过。
  assert.deepEqual(assigned(f.db, id), [tag.id])
  assert.equal(f.db.prepare('SELECT summary FROM email_analysis WHERE email_id = ?').get(id).summary, 'New summary')
})

test('definition deletion during AI request cannot resurrect ID; new definitions invalidate cache', async t => {
  const f = fixture(t), id = email(f.db, account(f.db))
  const one = tags.createMailTagDefinition(f.db, { name: 'delete me' }), two = tags.createMailTagDefinition(f.db, { name: 'keep me' })
  const calls = mockAi(t, (_request, count) => {
    if (count === 1) tags.deleteMailTagDefinition(f.db, one.id)
    return { custom_tag_ids: [one.id, two.id] }
  })
  assert.equal((await f.pipeline.matchCustomTags()).ok, true)
  assert.deepEqual(assigned(f.db, id), [two.id])
  assert.deepEqual(tags.listMailTagDefinitions(f.db), [two])
  await f.pipeline.matchCustomTags(); assert.equal(calls.length, 2)
  await f.pipeline.matchCustomTags(); assert.equal(calls.length, 2)
  tags.createMailTagDefinition(f.db, { name: 'new criteria' })
  await f.pipeline.matchCustomTags(); assert.equal(calls.length, 3)
})

test('revoking permission before retry or after a single response prevents writes and further sends', async t => {
  const f = fixture(t), id = email(f.db, account(f.db)), tag = tags.createMailTagDefinition(f.db, { name: 'one' })
  tags.saveCustomTagMatch(f.db, id, [tag.id], [tag], 'before')
  let failRequest = true
  const calls = mockAi(t, () => {
    f.settings.aiAuthorizedFor = ''
    if (failRequest) throw new Error('request failed while permission revoked')
    return { custom_tag_ids: [] }
  })
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  assert.equal(calls.length, 1) // 不允许重试绕过已撤销的权限。
  assert.deepEqual(assigned(f.db, id), [tag.id])
  f.settings.aiAuthorizedFor = 'mock|' + f.settings.aiBaseURL; failRequest = false
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  assert.equal(calls.length, 2)
  assert.deepEqual(assigned(f.db, id), [tag.id])
})

test('relation write failure rolls back old labels and fingerprint atomically', t => {
  const { db } = fixture(t), id = email(db, account(db)), one = tags.createMailTagDefinition(db, { name: 'one' }), two = tags.createMailTagDefinition(db, { name: 'two' })
  tags.saveCustomTagMatch(db, id, [one.id], [one, two], 'old')
  db.exec("CREATE TRIGGER reject_custom_tag BEFORE INSERT ON email_custom_tags BEGIN SELECT RAISE(ABORT, 'forced tag write failure'); END")
  assert.throws(() => tags.saveCustomTagMatch(db, id, [two.id], [one, two], 'new'), /forced tag write failure/)
  assert.deepEqual(assigned(db, id), [one.id])
  assert.equal(tags.customTagsMatchIsCurrent(db, id, 'old'), true)
  assert.equal(tags.customTagsMatchIsCurrent(db, id, 'new'), false)
})

test('revoking authorization or account while matching preserves old tags and stops following sends', async t => {
  const f = fixture(t), a = account(f.db), id = email(f.db, a), id2 = email(f.db, a, 2), tag = tags.createMailTagDefinition(f.db, { name: 'one' })
  for (const emailId of [id, id2]) tags.saveCustomTagMatch(f.db, emailId, [tag.id], [tag], 'before')
  let revoke = 'authorization'
  const calls = mockAi(t, () => {
    if (revoke === 'authorization') f.settings.aiAuthorizedFor = ''
    else updateAccount(f.db, a, { aiEnabled: 0 })
    return { custom_tag_ids: [] }
  })
  assert.equal((await f.pipeline.matchCustomTags()).ok, false)
  assert.equal(calls.length, 1)
  assert.deepEqual(assigned(f.db, id), [tag.id]); assert.deepEqual(assigned(f.db, id2), [tag.id])
  f.settings.aiAuthorizedFor = 'mock|' + f.settings.aiBaseURL; revoke = 'account'
  await f.pipeline.matchCustomTags()
  assert.equal(calls.length, 2)
  assert.deepEqual(assigned(f.db, id), [tag.id]); assert.deepEqual(assigned(f.db, id2), [tag.id])
})
