import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { AccountRow } from '../types'
import { migrateSecret } from '../../services/mail/secret'

export type NewAccount = Omit<
  AccountRow,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'ai_enabled'
  | 'ai_provider'
  | 'ai_base_url'
  | 'ai_model'
  | 'oauth_provider'
  | 'oauth_client_id'
  | 'oauth_refresh_enc'
  | 'oauth_access_enc'
  | 'oauth_expires_at'
> &
  Partial<
    Pick<
      AccountRow,
      | 'ai_enabled'
      | 'ai_provider'
      | 'ai_base_url'
      | 'ai_model'
      | 'oauth_provider'
      | 'oauth_client_id'
      | 'oauth_refresh_enc'
      | 'oauth_access_enc'
      | 'oauth_expires_at'
    >
  >

const INSERT_COLS = [
  'provider', 'label', 'address', 'host', 'port', 'encryption', 'username',
  'secret_enc', 'folder', 'auth_mode', 'last_uidvalidity', 'last_uid', 'last_sync_at', 'sync_error',
  'ai_enabled', 'ai_provider', 'ai_base_url', 'ai_model',
  'oauth_provider', 'oauth_client_id', 'oauth_refresh_enc', 'oauth_access_enc', 'oauth_expires_at'
] as const

export function insertAccount(db: DatabaseSync, a: NewAccount): number {
  const r = db
    .prepare(`INSERT INTO accounts (${INSERT_COLS.join(', ')}) VALUES (${INSERT_COLS.map(() => '?').join(', ')})`)
    .run(
      a.provider, a.label, a.address, a.host, a.port, a.encryption, a.username, a.secret_enc, a.folder, a.auth_mode,
      a.last_uidvalidity, a.last_uid, a.last_sync_at, a.sync_error,
      a.ai_enabled ?? 1, a.ai_provider ?? null, a.ai_base_url ?? null, a.ai_model ?? null,
      a.oauth_provider ?? null, a.oauth_client_id ?? null, a.oauth_refresh_enc ?? null, a.oauth_access_enc ?? null,
      a.oauth_expires_at ?? null
    )
  return Number(r.lastInsertRowid)
}

export function getAccount(db: DatabaseSync, id: number): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
}

export function listAccounts(db: DatabaseSync): AccountRow[] {
  return db.prepare('SELECT * FROM accounts ORDER BY id').all() as unknown as AccountRow[]
}

const PATCH_FIELDS: Record<string, string> = {
  provider: 'provider',
  address: 'address',
  label: 'label',
  host: 'host',
  port: 'port',
  encryption: 'encryption',
  username: 'username',
  secretEnc: 'secret_enc',
  folder: 'folder',
  authMode: 'auth_mode',
  lastUidvalidity: 'last_uidvalidity',
  lastUid: 'last_uid',
  lastSyncAt: 'last_sync_at',
  syncError: 'sync_error',
  aiEnabled: 'ai_enabled',
  aiProvider: 'ai_provider',
  aiBaseUrl: 'ai_base_url',
  aiModel: 'ai_model',
  oauthProvider: 'oauth_provider',
  oauthClientId: 'oauth_client_id',
  oauthRefreshEnc: 'oauth_refresh_enc',
  oauthAccessEnc: 'oauth_access_enc',
  oauthExpiresAt: 'oauth_expires_at'
}

export function updateAccount(db: DatabaseSync, id: number, patch: Record<string, unknown>): boolean {
  const sets: string[] = []
  const values: SQLInputValue[] = []
  for (const [camel, col] of Object.entries(PATCH_FIELDS)) {
    if (camel in patch) {
      sets.push(`${col} = ?`)
      values.push((patch[camel] ?? null) as SQLInputValue)
    }
  }
  if (sets.length === 0) return false
  sets.push(`updated_at = datetime('now')`)
  values.push(id)
  const r = db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return r.changes > 0
}

export function deleteAccount(db: DatabaseSync, id: number): void {
  // emails / email_analysis 经外键级联删除
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

/** 历史 'plain:' 账号凭据迁移为 safeStorage 加密（启动时调用，返回迁移条数） */
export function migrateAccountSecrets(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT id, secret_enc FROM accounts WHERE secret_enc LIKE 'plain:%'")
    .all() as unknown as { id: number; secret_enc: string }[]
  let migrated = 0
  for (const row of rows) {
    const next = migrateSecret(row.secret_enc)
    if (next !== row.secret_enc) {
      db.prepare('UPDATE accounts SET secret_enc = ? WHERE id = ?').run(next, row.id)
      migrated++
    }
  }
  if (migrated > 0) console.log(`[secret] 已迁移 ${migrated} 条账号凭据为 safeStorage 加密`)
  return migrated
}
