const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const handlers = new Map()
let api
const temp = mkdtempSync(join(tmpdir(), 'infoagent-batch-'))
const originalLoad = Module._load
Module._load = function(name, ...args) {
  if (name === 'electron') return {
    app: { getPath: () => temp },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    ipcRenderer: { invoke: async (channel, ...values) => { assert.ok(handlers.has(channel), channel); return handlers.get(channel)({}, ...values) } },
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value } }
  }
  return originalLoad.call(this, name, ...args)
}
const { registerPanelIpc } = require('../.test-out/main/ipc/panel.js')
const { registerMaterialsIpc } = require('../.test-out/main/ipc/materials.js')
const { registerTodoIpc } = require('../.test-out/main/ipc/todo.js')
require('../.test-out/preload/index.js')
Module._load = originalLoad
const { openDatabase } = require('../.test-out/main/db/database.js')
const { createInfo } = require('../.test-out/main/db/dao/infoDao.js')
const { insertAccount } = require('../.test-out/main/db/dao/accountsDao.js')
const { upsertEmail } = require('../.test-out/main/db/dao/emailsDao.js')
const panel = require('../.test-out/main/services/panel/service.js')
const { migrate } = require('../.test-out/main/db/migrations.js')
const store = { peek: () => ({ aiBaseURL: '', aiModel: '' }) }
test.after(() => rmSync(temp, {recursive: true, force: true}))
function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close())
  handlers.clear(); registerPanelIpc(db, store); registerMaterialsIpc(db); registerTodoIpc(db)
  return db
}
test('preload to IPC to SQL: each date selection changes results and counts before pagination', async t => {
  const db = fixture(t)
  const account = insertAccount(db, {provider:'imap',label:'test',address:'test@test.local',host:'imap.test.local',port:993,encryption:'tls',username:'test',secret_enc:'',folder:'INBOX',auth_mode:'password',last_uidvalidity:null,last_uid:0,last_sync_at:null,sync_error:null})
  const ages = [0,1,2,3,6,7,13,14,29,30,45]
  let uid=0
  for (const age of ages) {
    uid++
    const date = new Date(); date.setHours(12,0,0,0); date.setDate(date.getDate()-age)
    const email = upsertEmail(db, {account_id:account,folder:'INBOX',uid,message_id:`<${uid}@test.local>`,subject:`sample ${uid}`,from_addr:'test@test.local',to_addr:'me@test.local',cc:'',date_utc:date.toISOString(),date_raw:null,unread:1,body_text:`distinct text ${uid}`,body_html:'',attachments_json:'[]',size:10})
    createInfo(db, {source_type:'email',source_email_id:email,title:`sample ${uid}`,content:`distinct text ${uid}`})
  }
  await api.panelOverview(undefined, true, {mailDateRange:30})
  await api.panelContinue(undefined, {mailDateRange:30})
  for (const range of [1,3,7,14,30,'older30']) {
    const result = await api.panelOverview('email', false, {limit:100,mailDateRange:range})
    const expected = ages.filter(age => range === 'older30' ? age >= 30 : age < range).length
    assert.equal(result.recommendations.length, expected, String(range))
    assert.equal(result.pendingTotal, expected)
    assert.equal(result.priorityCounts.focus+result.priorityCounts.other, expected)
  }
  await assert.rejects(api.panelOverview('email',false,{mailDateRange:'7'}), /日期范围/)
  const first = await api.panelOverview('email',false,{limit:1,mailDateRange:7})
  const second = await api.panelOverview('email',false,{limit:1,mailDateRange:7,beforeInfoId:first.nextBeforeInfoId})
  assert.notEqual(first.recommendations[0].id,second.recommendations[0].id)
  assert.equal(first.pendingTotal,5)
  assert.equal(second.pendingTotal,5)
})
test('user folders: create, save, rename, move, delete and atomic failure through public API', async t => {
  const db=fixture(t)
  assert.deepEqual((await api.materialsList()).folders.map(f=>f.label), ['未分组'])
  const folder=await api.materialsCreateFolder('我的项目')
  await api.materialsCreate('科研讲座', '人工智能', folder)
  await api.materialsCreate('自由保存', '这是正文')
  let list=await api.materialsList()
  const first=list.items.find(i=>i.title==='科研讲座'), second=list.items.find(i=>i.title==='自由保存')
  assert.equal(first.folder,folder)
  assert.equal(second.folder,'uncategorized')
  await api.materialsRenameFolder(folder,'自由文件夹')
  assert.equal((await api.materialsList({folder})).items[0].folderLabel,'自由文件夹')
  await assert.rejects(api.materialsBatch([second.id,999999], 'move',folder), /不存在/)
  assert.equal((await api.materialsList()).items.find(i=>i.id===second.id).folder,'uncategorized')
  await api.materialsBatch([first.id,second.id],'move',folder)
  assert.equal((await api.materialsList({folder})).total,2)
  await api.materialsDeleteFolder(folder)
  assert.equal((await api.materialsList({folder:'uncategorized'})).total,2)
  await assert.rejects(api.materialsDeleteFolder('uncategorized'), /不可删除/)
  await api.materialsBatch([first.id,second.id],'delete')
  assert.equal((await api.materialsList()).total,0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM info WHERE destination='archive'").get().n,2)
})
test('legacy assigned folders survive migration and reads; no folder inferred for unassigned materials', async t => {
  const db=fixture(t)
  createInfo(db,{title:'科研讲座',content:'人工智能',destination:'keep'})
  const id=createInfo(db,{title:'old',destination:'keep'})
  db.prepare("UPDATE info SET material_folder='academics' WHERE id=?").run(id)
  db.exec('DROP TABLE keyword_feedback; DROP TABLE keyword_profile; DROP TABLE email_keyword; DROP TABLE material_folders; DROP TABLE zhihu_push; DROP TABLE zhihu_state; DELETE FROM schema_migrations WHERE version>=23')
  migrate(db)
  const result=await api.materialsList()
  assert.equal(result.items.find(i=>i.id===id).folder,'academics')
  assert.equal(result.items.find(i=>i.id!==id).folder,'uncategorized')
  const folder=await api.materialsCreateFolder('自定义')
  await api.materialsBatch([id],'move',folder)
  assert.equal((await api.materialsList()).items.find(i=>i.id===id).folder,folder)
})
test('todo bulk move and complete; delete rolls back on missing ids and cascades reminders', async t => {
  const db=fixture(t)
  const a=(await api.todoCreateItem({title:'task a'})).item
  const b=(await api.todoCreateItem({title:'task b'})).item
  const keep=(await api.todoCreateItem({title:'keep'})).item
  const list=(await api.todoCreateList('项目')).list
  assert.equal((await api.todoBatch([a.id,b.id],'move',list.id)).ok,true)
  assert.ok((await api.todoSnapshot()).items.filter(i=>i.id!==keep.id).every(i=>i.listId===list.id))
  assert.equal((await api.todoBatch([a.id,b.id],'complete')).ok,true)
  assert.ok((await api.todoSnapshot()).items.filter(i=>i.id!==keep.id).every(i=>i.completedAt))
  assert.equal((await api.todoBatch([a.id,999999],'delete')).ok,false)
  assert.equal((await api.todoSnapshot()).items.length,3)
  db.prepare("INSERT INTO reminders(item_id,remind_at) VALUES (?,?)").run(a.id,new Date().toISOString())
  assert.equal((await api.todoBatch([a.id,b.id],'delete')).ok,true)
  assert.deepEqual((await api.todoSnapshot()).items.map(i=>i.id),[keep.id])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reminders').get().n,0)
})

test('panel save uses chosen user folder and invalid target rolls back routing', async t => {
  const db=fixture(t)
  const infoId=createInfo(db,{source_type:'manual',title:'科研讲座',content:'新的讲座资料'})
  const overview=await api.panelOverview('manual',true)
  const rec=overview.recommendations.find(r=>r.infoId===infoId)
  assert.ok(rec)
  const invalid=await api.panelAct(rec.id,'material','missing-folder')
  assert.equal(invalid.ok,false)
  assert.equal(db.prepare('SELECT destination FROM info WHERE id=?').get(infoId).destination,'unverified')
  const folder=await api.materialsCreateFolder('用户选择')
  assert.equal((await api.panelAct(rec.id,'material',folder)).ok,true)
  assert.equal((await api.materialsList({folder})).items[0].folder,folder)
})
