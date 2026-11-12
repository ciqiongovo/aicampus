/**
 * 聊天记录源的数据库结构（迁移 16）。
 *
 * 设计要点：
 * - 只建表、不建 FTS：FTS5 在部分打包的 SQLite 里不可用，由 ensureImFts() 运行时尝试，
 *   失败则降级为 LIKE 检索，不让整个数据库打开失败。
 * - im_message 以 (session_id, platform_msg_id) 唯一，重复同步天然幂等。
 * - im_window 记录“已理解过的消息窗口”，避免重复调模型。
 */

export interface ImMigration {
  version: number
  name: string
  up: string[]
}

export const imMigrations: ImMigration[] = [
  {
    version: 16,
    name: 'im-chat-source',
    up: [
      `CREATE TABLE IF NOT EXISTS im_account (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        account_key TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        adapter TEXT NOT NULL DEFAULT '',
        data_root TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        last_sync_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (platform, account_key)
      )`,

      `CREATE TABLE IF NOT EXISTS im_session (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES im_account(id) ON DELETE CASCADE,
        platform_session_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'peer',
        title TEXT NOT NULL DEFAULT '',
        member_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_msg_at TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        summary_seq INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (account_id, platform_session_id)
      )`,

      `CREATE TABLE IF NOT EXISTS im_message (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES im_session(id) ON DELETE CASCADE,
        platform_msg_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT NOT NULL,
        sender_id TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        is_self INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'text',
        text TEXT NOT NULL DEFAULT '',
        quote_text TEXT,
        media_path TEXT,
        raw TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (session_id, platform_msg_id)
      )`,

      `CREATE TABLE IF NOT EXISTS im_window (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES im_session(id) ON DELETE CASCADE,
        start_msg_id INTEGER NOT NULL,
        end_msg_id INTEGER NOT NULL,
        start_seq INTEGER NOT NULL DEFAULT 0,
        end_seq INTEGER NOT NULL DEFAULT 0,
        msg_count INTEGER NOT NULL DEFAULT 0,
        stat_date TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'pending',
        provider TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (session_id, start_seq, end_seq)
      )`,

      `CREATE TABLE IF NOT EXISTS im_insight (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES im_session(id) ON DELETE CASCADE,
        window_id INTEGER REFERENCES im_window(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        due_at TEXT,
        assignee TEXT,
        url TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (window_id, kind, title)
      )`,

      `CREATE TABLE IF NOT EXISTS im_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      `CREATE INDEX IF NOT EXISTS idx_im_message_session_seq ON im_message(session_id, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_im_message_session_time ON im_message(session_id, sent_at)`,
      `CREATE INDEX IF NOT EXISTS idx_im_message_kind ON im_message(kind)`,
      `CREATE INDEX IF NOT EXISTS idx_im_window_session ON im_window(session_id, start_seq)`,
      `CREATE INDEX IF NOT EXISTS idx_im_window_date ON im_window(stat_date)`,
      `CREATE INDEX IF NOT EXISTS idx_im_insight_kind ON im_insight(kind, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_im_insight_session ON im_insight(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_im_session_enabled ON im_session(enabled, last_msg_at)`
    ]
  }
]

export function latestImSchemaVersion(): number {
  const last = imMigrations[imMigrations.length - 1]
  return last ? last.version : 0
}
