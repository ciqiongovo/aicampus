import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { AgentRun, AgentStep, AgentThought, ChatAttachment, Conversation, ConversationDetail, ResourceReference, WorkspaceMessage } from '../../../shared/workspace'
import type { ModelMessage } from '../../services/jarvis/agentModel'
const parse = <T>(v: unknown, fallback: T): T => { try { return JSON.parse(String(v)) as T } catch { return fallback } }
export class WorkspaceDao {
  constructor(readonly db: DatabaseSync, readonly clock: () => Date = () => new Date()) {}
  now(): string { return this.clock().toISOString() }
  conversationCreate(title = '新对话'): Conversation {
    const id = randomUUID(), now = this.now()
    this.db.prepare('INSERT INTO ai_conversations VALUES (?, ?, ?, ?)').run(id, title.trim().slice(0, 120) || '新对话', now, now)
    return this.conversation(id)
  }
  conversation(id: string): Conversation {
    const row = this.db.prepare('SELECT id,title,created_at AS createdAt,updated_at AS updatedAt FROM ai_conversations WHERE id=?').get(id) as unknown as Conversation | undefined
    if (!row) throw new Error('会话不存在')
    return row
  }
  conversationsList(keyword = ''): Conversation[] {
    return this.db.prepare("SELECT id,title,created_at AS createdAt,updated_at AS updatedAt FROM ai_conversations c WHERE title LIKE ? OR EXISTS(SELECT 1 FROM ai_messages m WHERE m.conversation_id=c.id AND m.content LIKE ?) ORDER BY updated_at DESC, id").all('%' + keyword.slice(0, 200) + '%', '%' + keyword.slice(0, 200) + '%') as unknown as Conversation[]
  }
  conversationRename(id: string, title: string): Conversation {
    if (!title?.trim()) throw new Error('会话名称不能为空')
    this.conversation(id)
    this.db.prepare('UPDATE ai_conversations SET title=?,updated_at=? WHERE id=?').run(title.trim().slice(0, 120), this.now(), id)
    return this.conversation(id)
  }
  conversationDelete(id: string): void {
    this.conversation(id)
    if (this.db.prepare("SELECT 1 FROM ai_runs WHERE conversation_id=? AND status IN ('running','waiting_confirmation')").get(id)) {
      throw new Error('此会话有未结束任务，请先停止任务再删除')
    }
    this.db.exec('SAVEPOINT delete_conversation')
    try {
      this.db.prepare('DELETE FROM ai_messages WHERE conversation_id=?').run(id)
      for (const table of ['ai_thoughts', 'ai_steps']) {
        this.db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM ai_runs WHERE conversation_id=?)`).run(id)
      }
      this.db.prepare('DELETE FROM ai_runs WHERE conversation_id=?').run(id)
      this.db.prepare('DELETE FROM ai_attachments WHERE conversation_id=?').run(id)
      this.db.prepare('DELETE FROM ai_conversations WHERE id=?').run(id)
      this.db.exec('RELEASE delete_conversation')
    } catch (error) {
      this.db.exec('ROLLBACK TO delete_conversation; RELEASE delete_conversation')
      throw error
    }
  }
  attachment(id: string): ChatAttachment {
    const a = this.db.prepare('SELECT id,conversation_id AS conversationId,name,size,media_type AS mediaType,status,error,length(extracted_text) AS extractedChars,created_at AS createdAt FROM ai_attachments WHERE id=?').get(id) as unknown as ChatAttachment | undefined
    if (!a) throw new Error('附件不存在')
    return a
  }
  attachmentCreate(conversationId: string, name: string, size: number, mediaType: string, text: string, error?: string): ChatAttachment {
    this.conversation(conversationId)
    const id = randomUUID()
    this.db.prepare('INSERT INTO ai_attachments VALUES (?,?,?,?,?,?,?,?,?)').run(id, conversationId, name, size, mediaType, error ? 'failed' : 'ready', error ?? null, text, this.now())
    return this.attachment(id)
  }
  attachmentText(id: string, conversationId: string): string {
    const row = this.db.prepare("SELECT extracted_text FROM ai_attachments WHERE id=? AND conversation_id=? AND status='ready'").get(id, conversationId) as { extracted_text: string } | undefined
    if (!row) throw new Error('附件未就绪或不属于此会话')
    return row.extracted_text
  }
  message(conversationId: string, role: 'user' | 'assistant', content: string, runId: string, references: ResourceReference[] = [], attachmentIds: string[] = []): void {
    this.db.prepare('INSERT INTO ai_messages VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), conversationId, role, content, JSON.stringify(references), JSON.stringify(attachmentIds), runId, this.now())
  }
  conversationGet(id: string): ConversationDetail {
    const conversation = this.conversation(id)
    const messages = this.db.prepare('SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY rowid').all(id).map(row => ({
      id: row.id, conversationId: id, role: row.role, content: row.content, runId: row.run_id, createdAt: row.created_at,
      references: parse<ResourceReference[]>(row.references_json, []),
      attachments: parse<string[]>(row.attachment_ids, []).map(a => this.attachment(a))
    })) as WorkspaceMessage[]
    const runs = (this.db.prepare('SELECT id FROM ai_runs WHERE conversation_id=? ORDER BY rowid').all(id) as {id:string}[]).map(r => this.run(r.id))
    return { conversation, messages, runs }
  }
  run(id: string): AgentRun {
    const r = this.db.prepare('SELECT id,conversation_id AS conversationId,status,summary,created_at AS createdAt,updated_at AS updatedAt FROM ai_runs WHERE id=?').get(id) as unknown as AgentRun | undefined
    if (!r) throw new Error('任务不存在')
    r.steps = this.db.prepare('SELECT id,run_id AS runId,tool,args_json,status,result,risk,created_at AS createdAt FROM ai_steps WHERE run_id=? ORDER BY rowid').all(id).map(s => {
      const { args_json, ...other } = s
      return { ...other, args: parse<Record<string, unknown>>(args_json, {}) }
    }) as unknown as AgentStep[]
    r.thoughts = this.thoughts(id)
    return r
  }
  thoughts(runId: string): AgentThought[] {
    return this.db.prepare('SELECT id,seq,content,created_at AS createdAt FROM ai_thoughts WHERE run_id=? ORDER BY seq').all(runId) as unknown as AgentThought[]
  }
  thoughtCount(runId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM ai_thoughts WHERE run_id=?').get(runId) as { n: number }).n
  }
  /** 流式思考：同一 seq 反复覆盖，只保留最终一行记录，避免每帧写库。 */
  thoughtUpsert(runId: string, seq: number, content: string): void {
    const text = content.slice(0, 12_000)
    const existing = this.db.prepare('SELECT id FROM ai_thoughts WHERE run_id=? AND seq=?').get(runId, seq) as { id: string } | undefined
    if (existing) { this.db.prepare('UPDATE ai_thoughts SET content=? WHERE id=?').run(text, existing.id); return }
    this.db.prepare('INSERT INTO ai_thoughts VALUES (?,?,?,?,?)').run(randomUUID(), runId, seq, text, this.now())
  }
  state(id: string): ModelMessage[] {
    const row = this.db.prepare('SELECT model_state FROM ai_runs WHERE id=?').get(id) as {model_state:string} | undefined
    if (!row) throw new Error('任务不存在')
    return parse<ModelMessage[]>(row.model_state, [])
  }
  saveState(id: string, state: ModelMessage[]): void { this.db.prepare('UPDATE ai_runs SET model_state=?,updated_at=? WHERE id=?').run(JSON.stringify(state), this.now(), id) }
  setStatus(id: string, status: AgentRun['status'], summary: string): void { this.db.prepare('UPDATE ai_runs SET status=?,summary=?,updated_at=? WHERE id=?').run(status, summary, this.now(), id) }
  recoverInterrupted(): void {
    const rows = this.db.prepare("SELECT id,conversation_id FROM ai_runs WHERE status='running'").all() as { id: string; conversation_id: string }[]
    for (const r of rows) {
      const text = '应用上次退出时任务被中断，未自动重放。已提交操作保留，请检查执行记录后发起新任务。'
      this.setStatus(r.id, 'failed', text)
      this.message(r.conversation_id, 'assistant', text, r.id)
    }
  }
}
