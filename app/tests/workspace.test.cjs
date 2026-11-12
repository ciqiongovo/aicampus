'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {openDatabase}=require('../.test-out/main/db/database.js')
const {WorkspaceService}=require('../.test-out/main/services/jarvis/workspace.js')
const {DEFAULT_SETTINGS}=require('../.test-out/shared/types.js')
const {searchResources,readResource}=require('../.test-out/main/services/jarvis/resources.js')
const {randomUUID}=require('node:crypto')
const settings={...DEFAULT_SETTINGS,aiProvider:'local',aiIsLocal:true,aiBaseURL:'http://127.0.0.1:11434/v1',aiModel:'mock',aiAuthorizedFor:'local|http://127.0.0.1:11434/v1'}
const store={get:async()=>settings,peek:()=>settings}
const tool=(name,args,id=randomUUID())=>({content:'',toolCalls:[{id,name,arguments:JSON.stringify(args)}]})
const end=content=>({content,toolCalls:[]})
async function settled(s,id){for(let i=0;i<300;i++){const r=s.dao.run(id);if(r.status!=='running')return r;await new Promise(resolve=>setImmediate(resolve))}throw new Error('test task did not settle')}
function setup(model){const db=openDatabase(':memory:');const svc=new WorkspaceService(db,store,model);const c=svc.dao.conversationCreate();return{db,svc,c}}
const send=(svc,c,content='测试',extra={})=>svc.send({conversationId:c.id,content,requestId:randomUUID(),...extra})
test('SQLite conversations rename/search/message/task recovery, current user message once',async()=>{
 let messages;const {db,svc,c}=setup(async(_cfg,m)=>{messages=m;return end('普通通用聊天，不限整理角色')})
 const run=await send(svc,c,'你好');assert.equal((await settled(svc,run.id)).status,'completed')
 assert.equal(messages.filter(m=>m.role==='user'&&m.content==='你好').length,1)
 svc.dao.conversationRename(c.id,'历史对话');assert.equal(svc.dao.conversationsList('历史')[0].id,c.id)
 const restored=new WorkspaceService(db,store,async()=>end('继续'));assert.equal(restored.dao.conversationGet(c.id).messages.length,2);assert.equal(restored.dao.conversationGet(c.id).runs.length,1)
 db.close()
})
test('Agent true loop searches beyond five, reads details, creates item, observes actual tool result',async()=>{
 let step=0;const {db,svc,c}=setup(async(_cfg,m)=>{
   step++;if(step===1)return tool('search',{domain:'info',limit:5,offset:5})
   if(step===2){const out=JSON.parse(m.at(-1).content);assert.equal(out.items.length,5);assert.equal(out.total,12);return tool('read',{kind:'info',id:1})}
   if(step===3){assert.ok(JSON.parse(m.at(-1).content).content.includes('目标正文'));return tool('create_item',{title:'实际创建任务'})}
   assert.equal(JSON.parse(m.at(-1).content).ok,true);return end('已创建；截止日期待补充')
 })
 for(let i=0;i<12;i++)db.prepare("INSERT INTO info(source_type,title,content)VALUES('user',?,?)").run('资讯'+i,'目标正文'+i)
 const r=await settled(svc,(await send(svc,c)).id);assert.equal(r.status,'completed');assert.equal(r.steps.length,3)
 assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,1);assert.equal(db.prepare('SELECT deadline_at FROM items').get().deadline_at,null)
 db.close()
})
test('high-impact deletion requires bound approval, survives restart, repeated approval is idempotent',async()=>{
 let n=0;const {db,svc,c}=setup(async()=>++n===1?tool('delete_item',{id:1}):end('已处理'))
 db.prepare("INSERT INTO items(title)VALUES('测试事项')").run()
 let r=await settled(svc,(await send(svc,c)).id);assert.equal(r.status,'waiting_confirmation');assert.ok(db.prepare('SELECT 1 FROM items WHERE id=1').get())
 await assert.rejects(()=>svc.decide(r.id,'wrong-step',true),/不属于/)
 const restarted=new WorkspaceService(db,store,async()=>end('删除完成'))
 r=await restarted.decide(r.id,r.steps[0].id,true);r=await settled(restarted,r.id);assert.equal(r.status,'completed');assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,0)
 await restarted.decide(r.id,r.steps[0].id,true);assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,0);db.close()
})
test('rejected approval never commits deletion',async()=>{
 let n=0;const{db,svc,c}=setup(async()=>++n===1?tool('delete_item',{id:1}):end('未删除'))
 db.prepare("INSERT INTO items(title)VALUES('保留')").run()
 let r=await settled(svc,(await send(svc,c)).id);await svc.decide(r.id,r.steps[0].id,false);r=await settled(svc,r.id)
 assert.equal(r.steps[0].status,'denied');assert.ok(db.prepare('SELECT 1 FROM items WHERE id=1').get());db.close()
})
test('concurrent sends share request id, different conversations never mix replies',async()=>{
 const{db,svc,c}=setup(async(_cfg,m)=>end('回复:'+m.at(-1).content));const other=svc.dao.conversationCreate()
 const requestId=randomUUID();const [a,b]=await Promise.all([send(svc,c,'甲',{requestId}),send(svc,c,'甲',{requestId})]);assert.equal(a.id,b.id)
 await settled(svc,a.id);await settled(svc,(await send(svc,other,'乙')).id)
 assert.match(svc.dao.conversationGet(c.id).messages.at(-1).content,/甲/);assert.match(svc.dao.conversationGet(other.id).messages.at(-1).content,/乙/);db.close()
})
test('paged details expose full stored text without credentials and reject SQL-like domains',()=>{
 const{db}=setup(async()=>end(''));db.prepare("INSERT INTO info(title,content)VALUES('长文',?)").run('甲'.repeat(22000))
 const first=readResource(db,{kind:'info',id:1,title:''});assert.equal(first.hasMore,true);const last=readResource(db,{kind:'info',id:1,title:''},16000);assert.equal(last.hasMore,false)
 assert.throws(()=>searchResources(db,{domain:'settings'}),/未知/);assert.throws(()=>searchResources(db,{domain:'accounts'}),/未知/);db.close()
})
test('stop aborts in-flight model and commits no later steps',async()=>{
 let release;const{db,svc,c}=setup(()=>new Promise(resolve=>{release=resolve}))
 const r=await send(svc,c);for(let i=0;i<30&&!release;i++)await new Promise(resolve=>setImmediate(resolve))
 svc.stop(r.id);release(tool('create_item',{title:'不得执行'}));await new Promise(resolve=>setImmediate(resolve));assert.equal(svc.dao.run(r.id).status,'cancelled');assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,0);db.close()
})
test('attachment content really reaches model; failed/cross-conversation attachments rejected',async()=>{
 let context='';const{db,svc,c}=setup(async(_cfg,m)=>{context=JSON.stringify(m);return end('已读')})
 const good=svc.dao.attachmentCreate(c.id,'实际.txt',20,'text/plain','真实附件内容')
 await settled(svc,(await send(svc,c,'阅读附件',{attachmentIds:[good.id]})).id);assert.match(context,/真实附件内容/)
 const other=svc.dao.conversationCreate();await assert.rejects(()=>send(svc,other,'阅读',{attachmentIds:[good.id]}),/不属于/)
 const bad=svc.dao.attachmentCreate(c.id,'失败.pdf',10,'application/pdf','','不支持')
 await assert.rejects(()=>send(svc,c,'阅读',{attachmentIds:[bad.id]}),/未就绪/);db.close()
})
test('thoughts are persisted per model round and final reply keeps clickable resource references',async()=>{
 const {db,svc,c}=setup(async()=>({content:'已整理好，见 [长文](infoagent://info/1)',toolCalls:[],reasoning:'先想想要不要检索'}))
 db.prepare("INSERT INTO info(title,content)VALUES('长文','内容')").run()
 const run=await settled(svc,(await send(svc,c,'整理')).id);assert.equal(run.status,'completed')
 assert.equal(run.thoughts.length,1);assert.match(run.thoughts[0].content,/先想想要不要检索/)
 const last=svc.dao.conversationGet(c.id).messages.at(-1);assert.equal(last.role,'assistant')
 assert.deepEqual(last.references.map(r=>r.kind+':'+r.id),['info:1']);assert.equal(last.references[0].title,'长文');db.close()
})


test('delete conversation removes only its full history and rejects active runs', async () => {
  const { db, svc, c } = setup(async () => end('done'))
  try {
    const other = svc.dao.conversationCreate('keep')
    const attachment = svc.dao.attachmentCreate(c.id, 'test.txt', 3, 'text/plain', 'abc')
    const run = await send(svc, c, 'delete me', { attachmentIds: [attachment.id] })
    assert.throws(() => svc.dao.conversationDelete(c.id), /未结束任务/)
    await settled(svc, run.id)
    svc.dao.conversationDelete(c.id)
    assert.throws(() => svc.dao.conversation(c.id), /不存在/)
    for (const table of ['ai_messages', 'ai_runs', 'ai_attachments', 'ai_steps', 'ai_thoughts']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
    }
    assert.equal(svc.dao.conversation(other.id).title, 'keep')
  } finally { db.close() }
})
