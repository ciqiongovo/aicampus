import type { DatabaseSync } from 'node:sqlite'

export function getSetting(db: DatabaseSync, key: string): unknown | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

export function getSettingOr<T>(db: DatabaseSync, key: string, fallback: T): T {
  const v = getSetting(db, key)
  return v === undefined ? fallback : (v as T)
}

export function setSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

export function deleteSetting(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export function getAllSettings(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value)
    } catch {
      out[r.key] = r.value
    }
  }
  return out
}
