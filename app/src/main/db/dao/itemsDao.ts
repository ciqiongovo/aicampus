import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { ItemRow } from '../types'

export interface NewItem {
  title: string
  source_email_id?: number | null
  category?: string | null
  status?: string
  deadline_at?: string | null
  deadline_raw?: string | null
  deadline_kind?: string | null
  event_start_at?: string | null
  suggest_start_at?: string | null
  notes?: string
  /** v14：清单分组、完成时刻、优先级（0–3）、事件结束、全天 */
  list_id?: number | null
  completed_at?: string | null
  priority?: number
  event_end_at?: string | null
  all_day?: boolean | number
}

export function createItem(db: DatabaseSync, i: NewItem): number {
  const r = db.prepare(
    `INSERT INTO items (title, source_email_id, category, status, deadline_at, deadline_raw, deadline_kind, event_start_at, suggest_start_at, notes, list_id, completed_at, priority, event_end_at, all_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    i.title,
    i.source_email_id ?? null,
    i.category ?? null,
    i.status ?? '待核实',
    i.deadline_at ?? null,
    i.deadline_raw ?? null,
    i.deadline_kind ?? null,
    i.event_start_at ?? null,
    i.suggest_start_at ?? null,
    i.notes ?? '',
    i.list_id ?? null,
    i.completed_at ?? null,
    i.priority ?? 0,
    i.event_end_at ?? null,
    i.all_day ? 1 : 0
  )
  return Number(r.lastInsertRowid)
}

export function getItem(db: DatabaseSync, id: number): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined
}

export function listItems(db: DatabaseSync, status?: string): ItemRow[] {
  if (status === undefined) return db.prepare('SELECT * FROM items ORDER BY id DESC').all() as unknown as ItemRow[]
  return db.prepare('SELECT * FROM items WHERE status = ? ORDER BY id DESC').all(status) as unknown as ItemRow[]
}

/** 更新补丁按契约里的 camelCase 写，落库时经 PATCH_FIELDS 映射成列名 */
export interface ItemPatch {
  title?: string
  category?: string | null
  status?: string
  deadlineAt?: string | null
  deadlineRaw?: string | null
  deadlineKind?: string | null
  eventStartAt?: string | null
  suggestStartAt?: string | null
  notes?: string
  listId?: number | null
  completedAt?: string | null
  priority?: number
  eventEndAt?: string | null
  allDay?: boolean
}

const PATCH_FIELDS: Record<string, string> = {
  title: 'title',
  category: 'category',
  status: 'status',
  deadlineAt: 'deadline_at',
  deadlineRaw: 'deadline_raw',
  deadlineKind: 'deadline_kind',
  eventStartAt: 'event_start_at',
  suggestStartAt: 'suggest_start_at',
  notes: 'notes',
  listId: 'list_id',
  completedAt: 'completed_at',
  priority: 'priority',
  eventEndAt: 'event_end_at',
  allDay: 'all_day'
}

export function updateItem(db: DatabaseSync, id: number, patch: ItemPatch): boolean {
  const sets: string[] = []
  const values: SQLInputValue[] = []
  for (const [camel, col] of Object.entries(PATCH_FIELDS)) {
    if (camel in patch) {
      const raw = (patch as Record<string, unknown>)[camel]
      // allDay 在契约里是布尔，落库统一成 0/1；node:sqlite 不接受 boolean 绑定
      const value = camel === 'allDay' ? (raw ? 1 : 0) : (raw ?? null)
      sets.push(`${col} = ?`)
      values.push(value as SQLInputValue)
    }
  }
  if (sets.length === 0) return false
  sets.push(`updated_at = datetime('now')`)
  values.push(id)
  const r = db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return r.changes > 0
}

export function deleteItem(db: DatabaseSync, id: number): void {
  // reminders 经外键级联删除
  db.prepare('DELETE FROM items WHERE id = ?').run(id)
}
