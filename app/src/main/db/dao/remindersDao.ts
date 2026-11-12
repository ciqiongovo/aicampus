import type { DatabaseSync } from 'node:sqlite'
import type { ReminderRow } from '../types'

export function createReminder(db: DatabaseSync, r: { item_id: number; remind_at: string; channel?: string }): number {
  const res = db.prepare('INSERT INTO reminders (item_id, remind_at, channel, created_at) VALUES (?, ?, ?, ?)').run(r.item_id, r.remind_at, r.channel ?? 'app', new Date().toISOString())
  return Number(res.lastInsertRowid)
}

export function getReminder(db: DatabaseSync, id: number): ReminderRow | undefined {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined
}

export function listByItem(db: DatabaseSync, itemId: number): ReminderRow[] {
  return db.prepare('SELECT * FROM reminders WHERE item_id = ? ORDER BY remind_at').all(itemId) as unknown as ReminderRow[]
}

/** 重启补扫用：到期未触发（状态 pending）且事项未结束的提醒（A5：终态事项不发提醒） */
export function listPending(db: DatabaseSync, nowIso: string): ReminderRow[] {
  return db.prepare(
    'SELECT r.* FROM reminders r JOIN items i ON i.id = r.item_id' +
      " WHERE r.status = 'pending' AND r.remind_at <= ?" +
      " AND i.status NOT IN ('已完成', '已取消')" +
      ' ORDER BY r.remind_at'
  ).all(nowIso) as unknown as ReminderRow[]
}

export function markFired(db: DatabaseSync, id: number, error: string | null = null): void {
  if (error !== null) {
    db.prepare(`UPDATE reminders SET status = 'failed', fired_at = NULL, error = ? WHERE id = ?`).run(error, id)
  } else {
    db.prepare(`UPDATE reminders SET status = 'fired', fired_at = datetime('now'), error = NULL WHERE id = ?`).run(id)
  }
}

export function deleteReminder(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id)
}
