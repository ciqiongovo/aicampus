import type { DatabaseSync } from 'node:sqlite'
import { ANALYSIS_CATEGORIES } from '../../../shared/types'
/** Shared action-category update. Topic labels remain a separate dimension. */
export function classifyResource(db:DatabaseSync,kind:string,id:number,category:string):{ok:boolean;message:string;id:number} {
  if(!(ANALYSIS_CATEGORIES as readonly string[]).includes(category))throw new Error('无效行动分类')
  if(!Number.isSafeInteger(id)||id<1)throw new Error('无效资源ID')
  const tables:Record<string,string>={email:'email_analysis',info:'info',item:'items',article:'daily_article'}
  if(!Object.hasOwn(tables,kind))throw new Error('此资源不支持行动分类')
  const table=tables[kind],key=kind==='email'?'email_id':'id'
  if(!db.prepare('SELECT '+key+' FROM '+table+' WHERE '+key+'=?').get(id))throw new Error(kind==='email'?'邮件尚无分析记录，不能伪造已分析状态':'资源不存在')
  db.exec('SAVEPOINT classify_resource')
  try {
    db.prepare('UPDATE '+table+' SET category=? WHERE '+key+'=?').run(category,id)
    if(kind==='article')db.prepare('UPDATE daily_article SET user_acted=1 WHERE id=?').run(id)
    if(kind==='email')db.prepare("UPDATE info SET category=? WHERE source_type='email' AND source_email_id=?").run(category,id)
    if(kind==='info'){
      const linked=db.prepare('SELECT source_email_id FROM info WHERE id=?').get(id) as {source_email_id:number|null}
      if(linked.source_email_id)db.prepare('UPDATE email_analysis SET category=? WHERE email_id=?').run(category,linked.source_email_id)
    }
    db.exec('RELEASE classify_resource');return{ok:true,id,message:'已更新行动分类（不修改话题）'}
  }catch(e){db.exec('ROLLBACK TO classify_resource');db.exec('RELEASE classify_resource');throw e}
}
