import type { AgentRule, RuleCondition } from '../../../shared/cognition'
export type RuleContext = Record<string,string|number|boolean|null|undefined>
export class RuleConflict extends Error { constructor(message:string){super(message);this.name='RuleConflict'} }
const supportedFields=new Set(['category','from','subject','body','title','deadline','has_deadline','source_type','destination','status'])
export function ruleMatches(rule:AgentRule,context:RuleContext):boolean {
  return rule.enabled&&rule.conditions.every((condition:RuleCondition)=>{
    if(!supportedFields.has(condition.field)) throw new RuleConflict('规则「'+rule.name+'」使用不支持的字段：'+condition.field)
    const value=context[condition.field], expected=condition.value??''
    switch(condition.op){
      case 'eq': return String(value??'')===expected
      case 'neq': return String(value??'')!==expected
      case 'contains':return String(value??'').toLocaleLowerCase().includes(expected.toLocaleLowerCase())
      case 'missing':return value===null||value===undefined||value===''||(condition.field==='has_deadline'&&value===false)
      case 'present':return value!==null&&value!==undefined&&value!==''&&!(condition.field==='has_deadline'&&value===false)
      default:throw new RuleConflict('规则条件操作不支持')
    }
  })
}
/** Conflicting mandatory outcomes are rejected, never silently resolved by model ordering. */
export function ruleDecisions(rules:AgentRule[],scope:string|string[],context:RuleContext):{destination?:string;category?:string;notifications:string[];requireDeadline:boolean;matched:number[]} {
  const applicable=rules.filter(r=>['global',...(Array.isArray(scope)?scope:[scope])].includes(r.scope)&&ruleMatches(r,context))
  const destinations=new Set<string>(), categories=new Set<string>(), notifications:string[]=[], matched:number[]=[]
  let requireDeadline=false
  for(const r of applicable){
    matched.push(r.id)
    if(r.action.type==='notify')notifications.push(r.description||r.name)
    if(r.action.type==='require_deadline')requireDeadline=true
    if(r.enforcement!=='mandatory')continue
    if(r.action.type==='route_info'){
      const d=String(r.action.params?.destination??'')
      if(!['keep','archive','unverified','item'].includes(d))throw new RuleConflict('分流规则缺少有效destination：'+r.name)
      destinations.add(d)
    }
    if(r.action.type==='set_category'){
      const c=String(r.action.params?.category??'')
      if(!['需行动','重要通知','可选机会','一般信息','不确定'].includes(c))throw new RuleConflict('分类规则缺少有效category：'+r.name)
      categories.add(c)
    }
  }
  if(destinations.size>1||categories.size>1)throw new RuleConflict('强制规则发生冲突：'+applicable.filter(r=>r.enforcement==='mandatory').map(r=>r.name).join('、')+'。请在AI设置调整后重试。')
  return{destination:[...destinations][0],category:[...categories][0],notifications,requireDeadline,matched}
}
