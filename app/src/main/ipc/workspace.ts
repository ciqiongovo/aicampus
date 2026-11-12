import { dialog, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { WORKSPACE_IPC } from '../../shared/workspace'
import type { AgentSendInput, ResourceReference } from '../../shared/workspace'
import type { SettingsStore } from '../store/settings'
import { WorkspaceService } from '../services/jarvis/workspace'
import { BackgroundProcessor } from '../services/jarvis/background'
import { COGNITION_IPC } from '../../shared/cognition'
const textExtensions = new Set(['.txt','.md','.csv','.json','.log','.yaml','.yml','.xml','.html','.css','.js','.ts','.py','.ini','.sql'])
export function registerWorkspaceIpc(db:DatabaseSync, store:SettingsStore):WorkspaceService {
  const service=new WorkspaceService(db,store)
  service.dao.recoverInterrupted()
  const background=new BackgroundProcessor(db,store)
  ipcMain.handle(WORKSPACE_IPC.agentBackgroundList,()=>background.list())
  ipcMain.handle(WORKSPACE_IPC.agentBackgroundRetry,(_e,id:number)=>{background.retry(Number(id));background.drain();return background.list()})
  ipcMain.handle(WORKSPACE_IPC.conversationsList,(_e,keyword?:string)=>service.dao.conversationsList(String(keyword??'')))
  ipcMain.handle(WORKSPACE_IPC.conversationCreate,(_e,title?:string)=>service.dao.conversationCreate(String(title??'新对话')))
  ipcMain.handle(WORKSPACE_IPC.conversationRename,(_e,id:string,title:string)=>service.dao.conversationRename(String(id),String(title)))
  ipcMain.handle(WORKSPACE_IPC.conversationDelete,(_e,id:string)=>service.dao.conversationDelete(String(id)))
  ipcMain.handle(WORKSPACE_IPC.conversationGet,(_e,id:string)=>service.dao.conversationGet(String(id)))
  ipcMain.handle(WORKSPACE_IPC.agentSend,(_e,input:AgentSendInput)=>service.send(input))
  ipcMain.handle(WORKSPACE_IPC.agentRunGet,(_e,id:string)=>service.dao.run(String(id)))
  ipcMain.handle(WORKSPACE_IPC.agentDecide,(_e,id:string,stepId:string,approved:boolean)=>service.decide(String(id),String(stepId),approved===true))
  ipcMain.handle(WORKSPACE_IPC.agentStop,(_e,id:string)=>service.stop(String(id)))
  ipcMain.handle(WORKSPACE_IPC.agentResourceGet,(_e,reference:ResourceReference,offset?:number)=>service.resource(reference,offset))
  ipcMain.handle(WORKSPACE_IPC.agentAttachmentChoose, async (_e,conversationId:string)=>{
    service.dao.conversation(conversationId)
    const result=await dialog.showOpenDialog({title:'附加文本文件（最多5个，每个512KB/6万字符；暂不支持PDF、Office、图片/OCR）',properties:['openFile','multiSelections'],filters:[{name:'可读取的文本文件',extensions:[...textExtensions].map(x=>x.slice(1))}]})
    if(result.canceled) return {ok:true,message:'已取消选择',attachments:[]}
    if(result.filePaths.length>5) return {ok:false,message:'每次最多选择5个文本文件',attachments:[]}
    const attachments=[]
    for(const path of result.filePaths) {
      const name=basename(path)
      let size=0
      try {
        const metadata=await stat(path);size=metadata.size
        if(!metadata.isFile()||size>512*1024) throw new Error('不是普通文件或超过512KB')
        if(!textExtensions.has(extname(path).toLowerCase())) throw new Error('暂不支持此格式，仅支持选择器中列出的UTF-8文本')
        const data=await readFile(path)
        const content=new TextDecoder('utf-8',{fatal:true}).decode(data)
        if(content.includes('\u0000')) throw new Error('文件含二进制数据，不能作为文本解析')
        if(content.length>60_000) throw new Error('提取文本超过6万字符，请拆分文件')
        attachments.push(service.dao.attachmentCreate(conversationId,name,size,'text/plain',content))
      } catch(e) { attachments.push(service.dao.attachmentCreate(conversationId,name,size,'application/octet-stream','',e instanceof Error?e.message:String(e))) }
    }
    return {ok:attachments.every(a=>a.status==='ready'),message:'仅解析主动附加的UTF-8文本；内容保存在本地会话数据库，未附加文件不被读取。失败附件不会发送给模型。',attachments}
  })
  // 认知通道按「通道名 = CognitionService 方法名」批量注册；缺方法时不能静默跳过，
  // 否则渲染层会拿到 "No handler registered for 'cognition:...'"，界面看似可用实则全废。
  // 注意：agentPolicySet 只在此显式注册，不作为 Agent 工具暴露（权限只能由用户在设置页改）。
  const cognition=service.cognition
  const missing:string[]=[]
  for(const [name,channel] of Object.entries(COGNITION_IPC)) {
    const method=(cognition as unknown as Record<string,unknown>)[name]
    if(typeof method!=='function'){missing.push(channel);continue}
    ipcMain.handle(channel,(_e,...args:unknown[])=>(method as (...a:unknown[])=>unknown).apply(cognition,args))
  }
  if(missing.length>0) console.error('[cognition] 以下通道缺少同名服务方法，未注册：',missing.join(', '))
  return service
}
