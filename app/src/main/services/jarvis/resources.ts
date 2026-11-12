import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { searchEmails } from '../../db/dao/emailsDao'
import { htmlToText } from '../mail/sanitize'
import type { AgentResourceDetail, ResourceKind, ResourceReference } from '../../../shared/workspace'
interface Domain { table: string; title: string; content: string[]; list: string[]; category?: string; status?: string }
/** Only business fields are exposed. No account, settings, token, secret or arbitrary SQL tool. */
export const RESOURCE_DOMAINS: Partial<Record<ResourceKind, Domain>> = {
  email: { table: 'emails', title: 'subject', content: ['subject','from_addr','to_addr','cc','date_utc','body_text','body_html','attachments_json'], list: ['id','subject','from_addr','date_utc','unread','starred'] },
  info: { table: 'info', title: 'title', content: ['title','content','source_type','source_email_id','category','destination','item_id'], list: ['id','title','source_type','category','destination','created_at'], category: 'category', status: 'destination' },
  item: { table: 'items', title: 'title', content: ['title','notes','category','status','deadline_at','event_start_at','source_email_id'], list: ['id','title','status','deadline_at','category','source_email_id'], category: 'category', status: 'status' },
  daily: { table: 'daily_report', title: 'title', content: ['title','intro','date_key','status','info_id','sources_json','generated_at'], list: ['id','title','date_key','status','info_id','generated_at'], status: 'status' },
  article: { table: 'daily_article', title: 'title', content: ['title','content','url','source_id','source_label','score','topic','category','status','item_id','published_at'], list: ['id','title','source_label','topic','category','status','item_id','url','published_at'], category:'category', status: 'status' },
  reminder: { table: 'reminders', title: 'channel', content: ['item_id','remind_at','channel','status','error'], list: ['id','item_id','remind_at','status'], status: 'status' }
}
function integer(v: unknown, fallback: number, max: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, max) : fallback
}
export function searchResources(db: DatabaseSync, input: Record<string, unknown>, excludeEmailAttachments=false): Record<string, unknown> {
  const kind = String(input.domain) as ResourceKind
  const domain = Object.hasOwn(RESOURCE_DOMAINS,kind) ? RESOURCE_DOMAINS[kind] : undefined
  if (!domain) throw new Error('未知业务资源类型')
  if(kind==='email'){
    if(excludeEmailAttachments&&input.hasAttachment)throw new Error('用户已关闭邮件附件信息，不按附件条件检索')
    const offset=integer(input.offset,0,10_000_000),limit=Math.max(1,integer(input.limit,30,100))
    const result=searchEmails(db,{keyword:typeof input.keyword==='string'?input.keyword.slice(0,300):undefined,category:typeof input.category==='string'?input.category:undefined,analysisStatus:['pending','analyzed','failed','skipped'].includes(String(input.status))?String(input.status) as 'pending'|'analyzed'|'failed'|'skipped':undefined,accountId:typeof input.accountId==='number'?integer(input.accountId,0,10_000_000):undefined,folder:typeof input.folder==='string'?input.folder:undefined,unreadOnly:input.unreadOnly===true,starredOnly:input.starredOnly===true,hasAttachment:input.hasAttachment===true,offset,limit})
    const items=result.rows.map(row=>{if(!excludeEmailAttachments)return row;const {attachments_json: _attachments, ...rest}=row;return rest})
    return{domain:kind,items,total:result.total,offset,nextOffset:offset+items.length<result.total?offset+items.length:null}
  }
  const conditions: string[] = [], params: SQLInputValue[] = []
  if (typeof input.keyword === 'string' && input.keyword.trim()) {
    const textColumns = domain.content.filter(c => !c.endsWith('_id'))
    conditions.push('(' + textColumns.map(c => 'CAST(' + c + ' AS TEXT) LIKE ?').join(' OR ') + ')')
    for (const _c of textColumns) params.push('%' + input.keyword.trim().slice(0, 300) + '%')
  }
  if (input.category && domain.category) { conditions.push(domain.category + '=?'); params.push(String(input.category)) }
  if (input.status && domain.status) { conditions.push(domain.status + '=?'); params.push(String(input.status)) }
  if (kind === 'article' && input.reportId !== undefined) { conditions.push('id IN (SELECT article_id FROM daily_report_article WHERE report_id=?)'); params.push(integer(input.reportId,0,10_000_000)) }
  if (kind === 'article' && input.topicId) { conditions.push('topic=?'); params.push(String(input.topicId)) }
  if (kind === 'article' && input.sourceId) { conditions.push('source_id=?'); params.push(String(input.sourceId)) }
  if (kind === 'item' && input.missingDeadline === true) conditions.push("(deadline_at IS NULL OR deadline_at='')")
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
  const total = (db.prepare('SELECT COUNT(*) AS n FROM ' + domain.table + where).get(...params) as {n:number}).n
  const offset = integer(input.offset, 0, 10_000_000), limit = Math.max(1, integer(input.limit, 30, 100))
  const items = db.prepare('SELECT ' + domain.list.join(',') + ' FROM ' + domain.table + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, limit, offset)
  return { domain: kind, items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null }
}
export function readResource(db: DatabaseSync, ref: ResourceReference, offset = 0, excludeEmailAttachments=false): AgentResourceDetail {
  const domain = ref && Object.hasOwn(RESOURCE_DOMAINS,ref.kind) ? RESOURCE_DOMAINS[ref.kind] : undefined
  if (!domain || !Number.isSafeInteger(ref.id) || ref.id < 1) throw new Error('无效资源引用')
  const row = db.prepare('SELECT ' + [...new Set([domain.title,...domain.content])].join(',') + ' FROM ' + domain.table + ' WHERE id=?').get(ref.id) as Record<string, unknown> | undefined
  if (!row) throw new Error('来源记录不存在')
  if (ref.kind === 'email') {
    if(!String(row.body_text??'').trim())row.body_text=htmlToText(String(row.body_html??''))
    delete row.body_html
    if(excludeEmailAttachments){delete row.attachments_json;row.attachmentScope='用户已关闭邮件附件信息，未向模型提供'}
    row.analysis=db.prepare('SELECT category,summary,action_required,deadline_at,deadline_kind,event_start_at,evidence_json,confidence,tier FROM email_analysis WHERE email_id=?').get(ref.id)??null
  }
  if (ref.kind === 'daily') {
    const original = db.prepare('SELECT content FROM info WHERE id=?').get(row.info_id as number) as {content:string}|undefined
    row.storedReportContent = original?.content ?? ''
    row.articles = db.prepare('SELECT article_id FROM daily_report_article WHERE report_id=? ORDER BY article_id').all(ref.id)
    row.evidenceScope = '这是完整已存日报；资讯ID可用article搜索/详情逐条读取。不等于外站新闻全文。'
  }
  if (ref.kind === 'article') row.evidenceScope = row.content ? '来源实际提供的已存内容，不保证外站全文' : '仅标题、热度及可得链接；没有取得新闻全文'
  const content = JSON.stringify(row, null, 2)
  const start = integer(offset, 0, content.length), chunk = content.slice(start, start + 16_000)
  return { reference: { kind: ref.kind, id: ref.id, title: String(row[domain.title]) }, content: chunk, offset: start, totalChars: content.length, hasMore: start + chunk.length < content.length }
}
