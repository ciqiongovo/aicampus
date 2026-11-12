import type { DatabaseSync } from 'node:sqlite'
import type { SettingsStore } from '../../store/settings'
import { CognitionService } from './cognition'
import { ruleDecisions } from './ruleEngine'
import { routeInfoEntry } from '../items/service'
export interface BackgroundJob { id:number; sourceKey:string; status:string; attempts:number; result:string; updatedAt:string }
/** Durable local queue; no service/daemon and no periodic memory-review prompts. */
export class BackgroundProcessor {
  readonly cognition:CognitionService
  constructor(private db:DatabaseSync,private store:SettingsStore,private clock:()=>Date=()=>new Date()){this.cognition=new CognitionService(db,clock)}
  enqueue(infoId:number):void {
    this.db.prepare("INSERT OR IGNORE INTO ai_background_jobs(source_key,status,updated_at)VALUES(?,'pending',?)").run('info:'+infoId,this.clock().toISOString())
  }
  list():BackgroundJob[]{return this.db.prepare('SELECT id,source_key AS sourceKey,status,attempts,result,updated_at AS updatedAt FROM ai_background_jobs ORDER BY id DESC LIMIT 200').all() as unknown as BackgroundJob[]}
  retry(id:number):void{this.db.prepare("UPDATE ai_background_jobs SET status='pending',attempts=0,updated_at=? WHERE id=? AND status!='completed'").run(this.clock().toISOString(),id)}
  drain():void {
    const policy=this.cognition.agentPolicyGet()
    if(!policy.backgroundEnabled)return
    const jobs=this.db.prepare("SELECT id,source_key,attempts,updated_at FROM ai_background_jobs WHERE status IN ('pending','retry') AND attempts<3 ORDER BY id LIMIT 50").all() as {id:number;source_key:string;attempts:number;updated_at:string}[]
    for(const job of jobs){
      if(job.attempts>0&&this.clock().getTime()-new Date(job.updated_at).getTime()<60_000*job.attempts)continue
      const infoId=Number(job.source_key.split(':')[1])
      try{
        const row=this.db.prepare('SELECT i.*,e.from_addr,e.body_text,an.deadline_at FROM info i LEFT JOIN emails e ON e.id=i.source_email_id LEFT JOIN email_analysis an ON an.email_id=i.source_email_id WHERE i.id=?').get(infoId)
        if(!row)throw new Error('来源信息已不存在')
        const scope=row.source_type==='email'?'mail':row.source_type==='daily'?'daily':'info'
        if(!policy.readDomains.includes('info')||(scope==='mail'&&!policy.readDomains.includes('email'))||(scope==='daily'&&!policy.readDomains.includes('daily')))throw new Error('权限已关闭，后台不读取或处理该来源')
        const decisions=ruleDecisions(this.cognition.agentRulesList(),scope,{category:row.category as string,from:row.from_addr as string,subject:row.title as string,title:row.title as string,body:(row.body_text||row.content) as string,deadline:row.deadline_at as string,has_deadline:!!row.deadline_at,source_type:row.source_type as string,destination:row.destination as string})
        const required=[decisions.category?'set_category':'',decisions.destination?'route_info':''].filter(Boolean)
        if(required.some(t=>policy.writeDeny.includes(t)||!policy.writeAuto.includes(t)||policy.writeConfirm.includes(t))){this.record(job.id,'waiting_confirmation','规则操作需要授权，请在AI设置核对权限，或交给AI工作台处理。');continue}
        this.db.exec('BEGIN')
        try{
          if(decisions.category)this.db.prepare('UPDATE info SET category=? WHERE id=?').run(decisions.category,infoId)
          if(decisions.destination){
            const s=this.store.peek(), result=routeInfoEntry(this.db,infoId,decisions.destination,null,s.reminderEnabled?s.reminderAdvanceMinutes:null)
            if(!result.ok)throw new Error(result.message)
          }
          this.record(job.id,'completed',JSON.stringify({infoId,matchedRules:decisions.matched,destination:decisions.destination,category:decisions.category,notifications:decisions.notifications}))
          this.db.exec('COMMIT')
        }catch(e){this.db.exec('ROLLBACK');throw e}
      }catch(e){const message=e instanceof Error?e.message:String(e);this.record(job.id,e instanceof Error&&e.name==='RuleConflict'?'conflict':job.attempts>=2?'failed':'retry',message)}
    }
  }
  private record(id:number,status:string,result:string):void{this.db.prepare('UPDATE ai_background_jobs SET status=?,attempts=attempts+1,result=?,updated_at=? WHERE id=?').run(status,result,this.clock().toISOString(),id)}
}
