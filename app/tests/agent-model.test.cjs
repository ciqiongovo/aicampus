'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {agentCompletion}=require('../.test-out/main/services/jarvis/agentModel.js')
const cfg={provider:'mock',baseURL:'https://model.test/v1/',model:'mock-model',apiKey:'private-test-key'}
test('native tools protocol is independent from email JSON mode',async()=>{
 const saved=global.fetch;let request,url
 global.fetch=async(u,r)=>{url=u;request=r;return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'search',arguments:'{"domain":"info"}'}}]}}]}),{status:200})}
 try{
 const messages=[{role:'user',content:'检索'}],tools=[{type:'function',function:{name:'search',description:'search',parameters:{type:'object'}}}]
 const result=await agentCompletion(cfg,messages,tools)
 assert.equal(url,'https://model.test/v1/chat/completions');assert.equal(request.headers.Authorization,'Bearer private-test-key')
 const body=JSON.parse(request.body);assert.deepEqual(body.messages,messages);assert.deepEqual(body.tools,tools);assert.equal(body.response_format,undefined);assert.equal(result.toolCalls[0].name,'search')
 }finally{global.fetch=saved}
})
test('provider authentication errors do not echo response bodies or secrets',async()=>{
 const saved=global.fetch;global.fetch=async()=>new Response('private-test-key and unrelated-private-diagnostics',{status:401})
 try{await assert.rejects(()=>agentCompletion(cfg,[],[]),e=>e.message.includes('401')&&!e.message.includes('private-test-key')&&!e.message.includes('unrelated-private-diagnostics'))}finally{global.fetch=saved}
})
test('incompatible native tool response reports failure, never fake execution',async()=>{
 const saved=global.fetch;global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'x',type:'function',function:{name:'search'}}]}}]}),{status:200})
 try{await assert.rejects(()=>agentCompletion(cfg,[],[]),/协议无效/)}finally{global.fetch=saved}
})
test('local endpoint does not require or transmit an empty Authorization header',async()=>{
 const saved=global.fetch;let headers;global.fetch=async(_u,r)=>{headers=r.headers;return new Response(JSON.stringify({choices:[{message:{content:'你好'}}]}),{status:200})}
 try{const res=await agentCompletion({...cfg,apiKey:''},[],[]);assert.equal(headers.Authorization,undefined);assert.equal(res.content,'你好')}finally{global.fetch=saved}
})
