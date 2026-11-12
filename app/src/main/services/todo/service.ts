import type { DatabaseSync } from 'node:sqlite'
import { createItem, deleteItem, updateItem } from '../../db'
import type { ItemPatch } from '../../db'
import { findDuplicateSchedule, linkEmailToSchedule } from '../items/schedule-dedupe'
import {
  TODO_COLORS,
  TODO_DONE_STATUS,
  TODO_OPEN_STATUS,
  type TodoCounts,
  type TodoCreateInput,
  type TodoItemRow,
  type TodoListRow,
  type TodoOpResult,
  type TodoPatch,
  type TodoSnapshot
} from '../../../shared/todo'

/**
 * 日程 / 待办业务逻辑（纯 DB，不依赖 electron）：ipc/todo.ts 只做参数透传，测试可直接 require。
 * 唯一数据源仍是 items 表：邮件分析产生事项 → 待办勾选/排期 → 日程周视图消费同一批行。
 */

const ITEM_SELECT = `SELECT i.id, i.title, i.notes, i.status, i.priority, i.list_id, i.deadline_at, i.deadline_kind,
  i.event_start_at, i.event_end_at, i.all_day, i.completed_at, i.source_email_id, i.created_at,
  l.name AS list_name, l.color AS list_color
  FROM items i LEFT JOIN todo_lists l ON l.id = i.list_id`

interface ItemJoined {
  id: number
  title: string
  notes: string | null
  status: string
  priority: number | null
  list_id: number | null
  deadline_at: string | null
  deadline_kind: string | null
  event_start_at: string | null
  event_end_at: string | null
  all_day: number | null
  completed_at: string | null
  source_email_id: number | null
  created_at: string
  list_name: string | null
  list_color: string | null
}

function rowToItem(r: ItemJoined): TodoItemRow {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes ?? '',
    status: r.status,
    priority: r.priority ?? 0,
    listId: r.list_id ?? null,
    listName: r.list_name ?? null,
    listColor: r.list_color ?? null,
    deadlineAt: r.deadline_at ?? null,
    deadlineKind: r.deadline_kind ?? null,
    eventStartAt: r.event_start_at ?? null,
    eventEndAt: r.event_end_at ?? null,
    allDay: Number(r.all_day ?? 0) === 1,
    completedAt: r.completed_at ?? null,
    sourceEmailId: r.source_email_id ?? null,
    createdAt: r.created_at
  }
}

/** 统一成 UTC ISO：库里 deadline_at/event_start_at 都是 toISOString() 产物，字符串比较才等于时间比较 */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export function listTodoLists(db: DatabaseSync): TodoListRow[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.name, l.color, l.sort_order, l.created_at,
        (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND (i.completed_at IS NULL AND i.status NOT IN ('已完成','已取消'))) AS open_count
       FROM todo_lists l ORDER BY l.sort_order ASC, l.id ASC`
    )
    .all() as Array<{ id: number; name: string; color: string; sort_order: number; created_at: string; open_count: number }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color || TODO_COLORS[(r.id - 1) % TODO_COLORS.length]!,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    openCount: r.open_count ?? 0
  }))
}

export function listTodoItems(db: DatabaseSync): TodoItemRow[] {
  return (db.prepare(`${ITEM_SELECT} ORDER BY COALESCE(i.event_start_at, i.deadline_at) ASC, i.id ASC`).all() as unknown as ItemJoined[]).map(rowToItem)
}

export function getTodoItem(db: DatabaseSync, id: number): TodoItemRow | null {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as unknown as ItemJoined | undefined
  return row ? rowToItem(row) : null
}

function isDone(item: TodoItemRow): boolean {
  return item.completedAt !== null || item.status === TODO_DONE_STATUS
}

/** 默认视图计数：与服务端同一时刻计算，渲染层不再自己猜「今天」 */
export function computeCounts(items: TodoItemRow[], now: Date = new Date()): TodoCounts {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  const weekEnd = dayStart + 7 * 86400000
  let today = 0
  let next7 = 0
  let inbox = 0
  let completed = 0
  let open = 0
  let overdue = 0
  let undated = 0
  for (const item of items) {
    if (isDone(item)) {
      completed += 1
      continue
    }
    open += 1
    if (item.listId === null) inbox += 1
    if (!item.deadlineAt && !item.eventStartAt) undated += 1
    // 只用 deadlineAt 会让「只有上课时间」的课程漏出今天/最近 7 天，与列表视图的排序口径不一致
    const anchorIso = item.deadlineAt ?? item.eventStartAt
    const due = anchorIso ? new Date(anchorIso).getTime() : null
    if (due !== null && !Number.isNaN(due)) {
      if (due < dayStart) overdue += 1
      if (due < dayStart + 86400000) today += 1
      if (due < weekEnd) next7 += 1
    }
  }
  return { today, next7, inbox, completed, open, overdue, undated }
}

export function getTodoSnapshot(db: DatabaseSync, now: Date = new Date()): TodoSnapshot {
  const items = listTodoItems(db)
  return { lists: listTodoLists(db), items, counts: computeCounts(items, now), now: now.toISOString() }
}

function fail(error: string): TodoOpResult {
  return { ok: false, error }
}

function normalizeTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
}

export function createTodoItem(db: DatabaseSync, input: TodoCreateInput): TodoOpResult {
  const title = normalizeTitle(input.title)
  if (!title) return fail('标题不能为空')
  let listId = input.listId ?? null
  if (listId !== null) {
    const exists = db.prepare('SELECT id FROM todo_lists WHERE id = ?').get(listId)
    if (!exists) listId = null
  }
  const start = toIso(input.eventStartAt)
  const end = toIso(input.eventEndAt)
  const eventEnd = end && start && end > start ? end : null
  if (start) {
    const existing = findDuplicateSchedule(db, {
      title, sourceEmailId: input.sourceEmailId, eventStartAt: start, eventEndAt: eventEnd, allDay: input.allDay
    })
    if (existing) {
      if (input.sourceEmailId) linkEmailToSchedule(db, input.sourceEmailId, existing.id)
      return { ok: true, item: getTodoItem(db, existing.id) ?? undefined }
    }
  }
  const priority = Math.min(3, Math.max(0, Math.round(input.priority ?? 0)))
  const id = createItem(db, {
    title,
    notes: input.notes ?? '',
    status: TODO_OPEN_STATUS,
    list_id: listId,
    priority,
    deadline_at: toIso(input.deadlineAt),
    event_start_at: start,
    event_end_at: eventEnd,
    all_day: input.allDay ? 1 : 0,
    source_email_id: input.sourceEmailId ?? null
  })
  if (start && input.sourceEmailId) linkEmailToSchedule(db, input.sourceEmailId, id)
  return { ok: true, item: getTodoItem(db, id) ?? undefined }
}

const PATCH_KEYS: Array<keyof TodoPatch> = [
  'title',
  'notes',
  'listId',
  'priority',
  'deadlineAt',
  'eventStartAt',
  'eventEndAt',
  'allDay',
  'status'
]

export function updateTodoItem(db: DatabaseSync, id: number, patch: TodoPatch): TodoOpResult {
  const current = getTodoItem(db, id)
  if (!current) return fail('条目不存在')
  const next: ItemPatch = {}
  if ('title' in patch) {
    const title = normalizeTitle(patch.title)
    if (!title) return fail('标题不能为空')
    next.title = title
  }
  if ('notes' in patch) next.notes = patch.notes ?? ''
  if ('listId' in patch) {
    const listId = patch.listId ?? null
    next.listId = listId !== null && db.prepare('SELECT id FROM todo_lists WHERE id = ?').get(listId) ? listId : null
  }
  if ('priority' in patch) next.priority = Math.min(3, Math.max(0, Math.round(patch.priority ?? 0)))
  if ('deadlineAt' in patch) next.deadlineAt = toIso(patch.deadlineAt)
  if ('eventStartAt' in patch) next.eventStartAt = toIso(patch.eventStartAt)
  if ('eventEndAt' in patch) next.eventEndAt = toIso(patch.eventEndAt)
  if ('allDay' in patch) next.allDay = Boolean(patch.allDay)
  if ('status' in patch) {
    const status = patch.status ?? TODO_OPEN_STATUS
    next.status = status
    // 状态与完成时刻必须同步，否则「已完成」分组靠 completed_at 排序会错位
    if (status === TODO_DONE_STATUS) next.completedAt = current.completedAt ?? new Date().toISOString()
    else next.completedAt = null
  }
  const used = Object.keys(next).filter((k) => PATCH_KEYS.includes(k as keyof TodoPatch))
  if (used.length === 0) return { ok: true, item: current }
  updateItem(db, id, next)
  return { ok: true, item: getTodoItem(db, id) ?? undefined }
}

export function toggleTodoItem(db: DatabaseSync, id: number, completed: boolean): TodoOpResult {
  const current = getTodoItem(db, id)
  if (!current) return fail('条目不存在')
  updateItem(db, id, {
    status: completed ? TODO_DONE_STATUS : TODO_OPEN_STATUS,
    completedAt: completed ? new Date().toISOString() : null
  })
  return { ok: true, item: getTodoItem(db, id) ?? undefined }
}

export function deleteTodoItem(db: DatabaseSync, id: number): TodoOpResult {
  if (!getTodoItem(db, id)) return fail('条目不存在')
  deleteItem(db, id)
  return { ok: true }
}

export function createTodoList(db: DatabaseSync, name: string, color?: string): TodoOpResult {
  const clean = normalizeTitle(name)
  if (!clean) return fail('清单名称不能为空')
  const dup = db.prepare('SELECT id FROM todo_lists WHERE name = ?').get(clean)
  if (dup) return fail('同名清单已存在')
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM todo_lists').get() as { m: number }
  const palette = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : TODO_COLORS[maxRow.m % TODO_COLORS.length]!
  const r = db.prepare('INSERT INTO todo_lists (name, color, sort_order) VALUES (?, ?, ?)').run(clean, palette, maxRow.m + 1)
  const id = Number(r.lastInsertRowid)
  return { ok: true, list: listTodoLists(db).find((l) => l.id === id) }
}

export function updateTodoList(db: DatabaseSync, id: number, patch: { name?: string; color?: string }): TodoOpResult {
  const row = db.prepare('SELECT id, name, color FROM todo_lists WHERE id = ?').get(id) as { id: number; name: string; color: string } | undefined
  if (!row) return fail('清单不存在')
  const name = patch.name === undefined ? row.name : normalizeTitle(patch.name)
  if (!name) return fail('清单名称不能为空')
  if (name !== row.name && db.prepare('SELECT id FROM todo_lists WHERE name = ? AND id != ?').get(name, id)) return fail('同名清单已存在')
  const color = patch.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color : row.color
  db.prepare('UPDATE todo_lists SET name = ?, color = ? WHERE id = ?').run(name, color, id)
  return { ok: true, list: listTodoLists(db).find((l) => l.id === id) }
}

export function deleteTodoList(db: DatabaseSync, id: number): TodoOpResult {
  const row = db.prepare('SELECT id FROM todo_lists WHERE id = ?').get(id)
  if (!row) return fail('清单不存在')
  // 显式解绑，不依赖 PRAGMA foreign_keys 是否开启（外部连接的库也能安全删除）
  db.prepare('UPDATE items SET list_id = NULL WHERE list_id = ?').run(id)
  db.prepare('DELETE FROM todo_lists WHERE id = ?').run(id)
  return { ok: true }
}

export function batchTodoItems(db: DatabaseSync, ids: number[], action: 'delete' | 'complete' | 'move', listId?: number | null): TodoOpResult {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) return fail('请选择 1 至 500 条任务')
  if (!['delete', 'complete', 'move'].includes(action)) return fail('无效操作')
  if (action === 'move' && listId != null && (!Number.isSafeInteger(listId) || !db.prepare('SELECT id FROM todo_lists WHERE id=?').get(listId))) return fail('目标清单不存在')
  db.exec('SAVEPOINT todo_batch')
  try {
    for (const id of new Set(ids)) {
      const result = action === 'delete' ? deleteTodoItem(db, id) : action === 'complete' ? toggleTodoItem(db, id, true) : updateTodoItem(db, id, { listId: listId ?? null })
      if (!result.ok) throw new Error(result.error || '操作失败')
    }
    db.exec('RELEASE todo_batch')
    return {ok: true}
  } catch (e) { db.exec('ROLLBACK TO todo_batch; RELEASE todo_batch'); return fail(e instanceof Error ? e.message : String(e)) }
}
