import { ipcMain, shell } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { IPC } from '../../shared/types'
import type { AccountInfo, AccountInput, OauthBeginResult, OauthPollResult, TestConnectionResult } from '../../shared/types'
import { deleteAccount, getAccount, insertAccount, listAccounts, updateAccount } from '../db'
import type { AccountRow } from '../db/types'
import { testConnection } from '../services/mail/imap'
import {
  accountHasOauth,
  beginOauth,
  cancelOauth,
  getFreshAccessToken,
  getOauthStatus,
  peekOauthResult,
  takeOauthResult
} from '../services/mail/oauth'
import { getProvider } from '../services/mail/providers'
import { decryptSecret, encryptSecret, hasSecret } from '../services/mail/secret'

/** 数据库行 → 渲染进程可见结构（绝不携带凭据） */
function toAccountInfo(row: AccountRow): AccountInfo {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    address: row.address,
    host: row.host,
    port: row.port ?? 993,
    encryption: row.encryption,
    username: row.username,
    folder: row.folder,
    authMode: row.auth_mode,
    hasSecret: hasSecret(row.secret_enc),
    lastUidvalidity: row.last_uidvalidity,
    lastUid: row.last_uid,
    lastSyncAt: row.last_sync_at,
    syncError: row.sync_error,
    aiEnabled: row.ai_enabled === 1,
    aiProvider: row.ai_provider,
    aiBaseUrl: row.ai_base_url,
    aiModel: row.ai_model,
    oauthBound: accountHasOauth(row),
    oauthProvider: row.oauth_provider,
    oauthClientId: row.oauth_client_id
  }
}

/**
 * 预设服务商参数兜底：host/port/encryption/folder 以注册表为准。
 * 渲染进程只提交用户可填字段（非自定义服务商不展示服务器字段）时，这里补齐，避免误报「请填写服务器地址」。
 */
function withPresetDefaults(input: AccountInput): AccountInput {
  const preset = getProvider(input.provider)
  if (!preset || preset.custom) return input
  return {
    ...input,
    host: input.host?.trim() || preset.host,
    port: Number.isInteger(input.port) && input.port > 0 ? input.port : preset.port,
    encryption: input.encryption || preset.encryption,
    folder: input.folder?.trim() || preset.defaultFolder,
    authMode: input.authMode || preset.authMode
  }
}

function validateInput(input: AccountInput): string | null {
  if (!input.provider?.trim()) return '请选择邮箱服务商'
  if (!input.address?.trim()) return '请填写邮箱地址'
  if (!input.username?.trim()) return '请填写登录用户名'
  if (!input.host?.trim()) return '请填写服务器地址'
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return '端口号无效'
  return null
}

interface OauthFlowFields {
  provider: string
  clientId: string
  email?: string
  refreshEnc: string
  accessEnc: string
  expiresAt: number
}

/** 消费 pending OAuth 会话；失败抛错（渲染层提示） */
function takeOauthFlow(oauthState: string | undefined): OauthFlowFields | null {
  if (!oauthState) return null
  const flow = takeOauthResult(oauthState)
  if (!flow) throw new Error('OAuth 授权会话无效或已过期，请重新发起登录')
  return flow
}

/** 测试/保存时解析凭据：优先本次填写，否则用已保存的加密凭据 */
function resolveSecret(input: AccountInput, db: DatabaseSync, accountId?: number): { secret: string } | { error: string } {
  if (input.secret?.trim()) return { secret: input.secret.trim() }
  if (accountId !== undefined) {
    const existing = getAccount(db, accountId)
    if (existing && hasSecret(existing.secret_enc)) return { secret: decryptSecret(existing.secret_enc) }
    return { error: '该账号未保存凭据，请填写授权码后重试' }
  }
  return { error: '请填写授权码' }
}

export function registerAccountsIpc(db: DatabaseSync): void {
  ipcMain.handle(IPC.accountsList, (): AccountInfo[] => listAccounts(db).map(toAccountInfo))

  ipcMain.handle(IPC.accountsCreate, (_event, raw: AccountInput): AccountInfo => {
    const input = withPresetDefaults(raw)
    const oauthFlow = takeOauthFlow(raw.oauthState)
    if (oauthFlow) {
      // OAuth 流程：邮箱地址/用户名缺省取授权返回的账号邮箱
      if (!input.address?.trim() && oauthFlow.email) input.address = oauthFlow.email
      if (!input.username?.trim() && oauthFlow.email) input.username = oauthFlow.email
    }
    const err = validateInput(input)
    if (err) throw new Error(err)
    if (!oauthFlow && !input.secret?.trim()) throw new Error('请填写授权码/密码，或使用 OAuth 登录')
    const id = insertAccount(db, {
      provider: input.provider,
      label: input.label.trim() || input.address.trim(),
      address: input.address.trim(),
      host: input.host.trim(),
      port: input.port,
      encryption: input.encryption,
      username: input.username.trim() || input.address.trim(),
      secret_enc: oauthFlow ? '' : encryptSecret(input.secret!.trim()),
      folder: input.folder?.trim() || 'INBOX',
      auth_mode: oauthFlow ? 'oauth' : input.authMode ?? getProvider(input.provider)?.authMode ?? 'password',
      last_uidvalidity: null,
      last_uid: null,
      last_sync_at: null,
      sync_error: null,
      ai_enabled: input.aiEnabled === false ? 0 : 1,
      ai_provider: input.aiProvider?.trim() || null,
      ai_base_url: input.aiBaseUrl?.trim() || null,
      ai_model: input.aiModel?.trim() || null,
      oauth_provider: oauthFlow?.provider ?? null,
      oauth_client_id: oauthFlow?.clientId ?? null,
      oauth_refresh_enc: oauthFlow?.refreshEnc ?? null,
      oauth_access_enc: oauthFlow?.accessEnc ?? null,
      oauth_expires_at: oauthFlow?.expiresAt ?? null
    })
    return toAccountInfo(getAccount(db, id)!)
  })

  ipcMain.handle(IPC.accountsUpdate, (_event, id: number, raw: AccountInput): AccountInfo => {
    if (!getAccount(db, id)) throw new Error('账号不存在')
    const input = withPresetDefaults(raw)
    const oauthFlow = takeOauthFlow(raw.oauthState)
    if (oauthFlow) {
      if (!input.address?.trim() && oauthFlow.email) input.address = oauthFlow.email
      if (!input.username?.trim() && oauthFlow.email) input.username = oauthFlow.email
    }
    const err = validateInput(input)
    if (err) throw new Error(err)
    updateAccount(db, id, {
      provider: input.provider,
      label: input.label.trim() || input.address.trim(),
      address: input.address.trim(),
      host: input.host.trim(),
      port: input.port,
      encryption: input.encryption,
      username: input.username.trim() || input.address.trim(),
      folder: input.folder?.trim() || 'INBOX',
      authMode: input.authMode ?? getProvider(input.provider)?.authMode ?? 'password',
      aiEnabled: input.aiEnabled === false ? 0 : 1,
      aiProvider: input.aiProvider?.trim() || null,
      aiBaseUrl: input.aiBaseUrl?.trim() || null,
      aiModel: input.aiModel?.trim() || null
    })
    if (oauthFlow) {
      // 重新授权：整体覆盖 OAuth 凭据并清空密码凭据
      updateAccount(db, id, {
        secretEnc: '',
        authMode: 'oauth',
        oauthProvider: oauthFlow.provider,
        oauthClientId: oauthFlow.clientId,
        oauthRefreshEnc: oauthFlow.refreshEnc,
        oauthAccessEnc: oauthFlow.accessEnc,
        oauthExpiresAt: oauthFlow.expiresAt
      })
    } else if (input.secret?.trim()) {
      // 留空 = 不改凭据
      updateAccount(db, id, { secretEnc: encryptSecret(input.secret.trim()) })
    }
    return toAccountInfo(getAccount(db, id)!)
  })

  ipcMain.handle(IPC.accountsDelete, (_event, id: number): void => {
    if (!getAccount(db, id)) throw new Error('账号不存在')
    // emails / email_analysis 经外键级联删除
    deleteAccount(db, id)
  })

  // 凭据撤销：清除已保存的授权码与 OAuth 绑定，账号、历史邮件与分析结果均保留；重新同步前需重新填写/登录
  ipcMain.handle(IPC.accountsClearSecret, (_event, id: number): AccountInfo => {
    if (!getAccount(db, id)) throw new Error('账号不存在')
    updateAccount(db, id, {
      secretEnc: '',
      oauthProvider: null,
      oauthClientId: null,
      oauthRefreshEnc: null,
      oauthAccessEnc: null,
      oauthExpiresAt: null
    })
    return toAccountInfo(getAccount(db, id)!)
  })

  ipcMain.handle(IPC.accountsTest, async (_event, raw: AccountInput, accountId?: number): Promise<TestConnectionResult> => {
    const input = withPresetDefaults(raw)
    let oauthAccessToken: string | undefined
    if (raw.oauthState) {
      // 本次会话刚完成 OAuth：用 pending flow 的令牌测试（不消费）
      const flow = peekOauthResult(raw.oauthState)
      if (!flow) return { ok: false, message: 'OAuth 授权会话无效或已过期，请重新发起登录' }
      if (!input.address?.trim() && flow.email) input.address = flow.email
      if (!input.username?.trim() && flow.email) input.username = flow.email
      try {
        oauthAccessToken = decryptSecret(flow.accessEnc)
      } catch (error) {
        return { ok: false, message: 'OAuth 令牌解密失败：' + (error instanceof Error ? error.message : String(error)) }
      }
    } else if (accountId !== undefined) {
      // 已保存账号走 OAuth 绑定：自动取新鲜 access token
      const existing = getAccount(db, accountId)
      if (existing && accountHasOauth(existing)) {
        try {
          oauthAccessToken = await getFreshAccessToken(db, existing)
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }
    }
    const err = validateInput(input)
    if (err) return { ok: false, message: err }
    if (!oauthAccessToken) {
      const resolved = resolveSecret(input, db, accountId)
      if ('error' in resolved) return { ok: false, message: resolved.error }
      return testConnection({
        host: input.host.trim(),
        port: input.port,
        encryption: input.encryption,
        username: input.username.trim() || input.address.trim(),
        secret: resolved.secret
      })
    }
    return testConnection({
      host: input.host.trim(),
      port: input.port,
      encryption: input.encryption,
      username: input.username.trim() || input.address.trim(),
      secret: '',
      accessToken: oauthAccessToken
    })
  })

  // OAuth 登录：开始授权（主进程直接打开浏览器，用户主动点击、不弹确认）
  ipcMain.handle(IPC.accountsOauthBegin, async (_event, provider: string, clientId: string): Promise<OauthBeginResult> => {
    const result = await beginOauth(String(provider ?? ''), String(clientId ?? '').trim())
    if (result.ok && result.authUrl) {
      try {
        await shell.openExternal(result.authUrl)
      } catch {
        /* 浏览器打不开时渲染层展示 authUrl 供用户复制 */
      }
    }
    return result
  })

  ipcMain.handle(IPC.accountsOauthPoll, (_event, state: string): OauthPollResult => getOauthStatus(String(state ?? '')))

  ipcMain.handle(IPC.accountsOauthCancel, (_event, state: string): void => {
    cancelOauth(String(state ?? ''))
  })
}
