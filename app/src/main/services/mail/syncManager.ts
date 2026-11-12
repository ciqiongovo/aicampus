import type { DatabaseSync } from 'node:sqlite'
import { getAccount, listAccounts } from '../../db'
import type { AccountRow } from '../../db/types'
import type { AccountSyncStatus, SyncResult } from '../../../shared/types'
import { syncAccount } from './imap'
import { decryptSecret, hasSecret } from './secret'
import { accountHasOauth, getFreshAccessToken } from './oauth'

/**
 * 每账号同步调度：同账号互斥、全局串行；状态从 accounts 表实时推导。
 * 应用启动后由 main/index.ts 调用 syncAll() 补扫。
 */
export class SyncManager {
  private busy = new Set<number>()

  constructor(private db: DatabaseSync) {}

  isSyncing(accountId: number): boolean {
    return this.busy.has(accountId)
  }

  statusOf(account: AccountRow): AccountSyncStatus {
    if (this.busy.has(account.id)) {
      return { accountId: account.id, state: 'syncing', lastSyncAt: account.last_sync_at, error: null }
    }
    if (account.sync_error) {
      return { accountId: account.id, state: 'error', lastSyncAt: account.last_sync_at, error: account.sync_error }
    }
    if (!account.last_sync_at) {
      return { accountId: account.id, state: 'never', lastSyncAt: null, error: null }
    }
    return { accountId: account.id, state: 'idle', lastSyncAt: account.last_sync_at, error: null }
  }

  allStatus(): AccountSyncStatus[] {
    return listAccounts(this.db).map((a) => this.statusOf(a))
  }

  async syncOne(accountId: number): Promise<SyncResult> {
    const account = getAccount(this.db, accountId)
    if (!account) return { ok: false, message: '账号不存在' }
    if (this.busy.has(accountId)) return { ok: false, message: '该账号正在同步中，请稍候' }
    const isOauth = accountHasOauth(account)
    if (!isOauth && !hasSecret(account.secret_enc)) {
      return { ok: false, message: '账号未保存凭据，请编辑账号补填授权码或重新登录' }
    }
    this.busy.add(accountId)
    try {
      if (isOauth) {
        const accessToken = await getFreshAccessToken(this.db, account)
        const outcome = await syncAccount(this.db, account, '', accessToken)
        return { ok: true, message: outcome.message }
      }
      const secret = decryptSecret(account.secret_enc)
      const outcome = await syncAccount(this.db, account, secret)
      return { ok: true, message: outcome.message }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    } finally {
      this.busy.delete(accountId)
    }
  }

  /** 全部账号串行补扫（单个失败不影响其余） */
  async syncAll(): Promise<void> {
    for (const account of listAccounts(this.db)) {
      if (!accountHasOauth(account) && !hasSecret(account.secret_enc)) continue
      try {
        await this.syncOne(account.id)
      } catch {
        /* syncOne 内部已处理 */
      }
    }
  }
}
