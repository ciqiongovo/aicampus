import http from 'node:http'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { encryptSecret, decryptSecret, hasSecret } from './secret'
import type { OauthBeginResult, OauthPollResult } from '../../../shared/types'

/**
 * Outlook / Gmail OAuth 2.0 授权码 + PKCE 流程（桌面原生应用方式）：
 * - 主进程起 127.0.0.1 随机端口 loopback 回调服务器，state 防 CSRF，10 分钟超时；
 * - 浏览器授权完成后令牌经 fetch 交换，refresh/access 令牌用 safeStorage 加密暂存内存，
 *   由账号 IPC 消费后写入 accounts 表（oauth_* 列）；
 * - token 端点等配置可注入（本地测试用 mock）。
 */

export interface OAuthProviderConfig {
  label: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  /** 授权 URL 附加参数（如 Google 需要 access_type=offline 才返回 refresh_token） */
  extraParams?: Record<string, string>
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  outlook: {
    label: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office365.com/IMAP.AccessAsUser.All',
      'offline_access',
      'openid',
      'email',
      'profile'
    ]
  },
  gmail: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://mail.google.com/', 'openid', 'email', 'profile'],
    extraParams: { access_type: 'offline', prompt: 'consent' }
  }
}

/** clientId 白名单校验：Azure AD / Google Cloud 客户端 ID 的合法字符集（防注入授权 URL） */
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{6,200}$/
export function validateOauthClientId(clientId: string): boolean {
  return CLIENT_ID_RE.test(clientId)
}

export function getOauthProviderConfig(provider: string): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDERS[provider]
}

const FLOW_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_FETCH_TIMEOUT_MS = 30 * 1000

interface PendingFlow {
  provider: string
  clientId: string
  state: string
  verifier: string
  redirectUri: string
  startedAt: number
  status: OauthPollResult['status']
  email?: string
  message?: string
  server: http.Server
  timer: NodeJS.Timeout
  refreshEnc?: string
  accessEnc?: string
  expiresAt?: number
}

const pendingFlows = new Map<string, PendingFlow>()

function makeVerifier(): string {
  return crypto.randomBytes(64).toString('base64url')
}

function makeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

/** 从 id_token 的 JWT payload 解出邮箱（仅用于预填表单，不验签——验签发生在授权服务器侧） */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return undefined
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const email = json.email ?? json.preferred_username
    return typeof email === 'string' && email.includes('@') ? email : undefined
  } catch {
    return undefined
  }
}

function renderPage(title: string, body: string): string {
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>' + title + '</title>' +
    '<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f7fa}' +
    '.card{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:420px}' +
    'h2{margin:0 0 8px}.ok{color:#16a34a}.err{color:#dc2626}p{color:#666;font-size:14px;line-height:1.6}</style>' +
    '</head><body><div class="card">' + body + '</div></body></html>'
  )
}

async function exchangeCode(cfg: OAuthProviderConfig, params: Record<string, string>): Promise<{ json: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS)
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const detail = json.error_description ?? json.error ?? ('HTTP ' + res.status)
      return { json, error: '令牌交换失败：' + String(detail) }
    }
    return { json }
  } catch (error) {
    return { json: {}, error: '令牌交换失败：' + ((error as Error).message ?? String(error)) }
  }
}

function closeFlow(flow: PendingFlow): void {
  clearTimeout(flow.timer)
  try {
    flow.server.close()
  } catch {
    /* 已关闭 */
  }
}

/**
 * 开始 OAuth 授权：返回浏览器授权地址与 state。
 * 调用方（IPC）负责用 shell.openExternal 打开 authUrl（用户主动点击，不弹确认）。
 */
export function beginOauth(
  provider: string,
  clientId: string,
  cfg: OAuthProviderConfig | undefined = getOauthProviderConfig(provider)
): Promise<OauthBeginResult> {
  return new Promise((resolve) => {
    if (!cfg) {
      resolve({ ok: false, message: '该邮箱服务商不支持 OAuth 登录' })
      return
    }
    if (!validateOauthClientId(clientId)) {
      resolve({ ok: false, message: 'OAuth 客户端 ID 格式不合法（仅允许 6-200 位字母数字与 . _ ~ -）' })
      return
    }

    const state = crypto.randomBytes(16).toString('hex')
    const verifier = makeVerifier()
    const challenge = makeChallenge(verifier)

    const flow: PendingFlow = {
      provider,
      clientId,
      state,
      verifier,
      redirectUri: '',
      startedAt: Date.now(),
      status: 'pending',
      server: undefined as unknown as http.Server,
      timer: undefined as unknown as NodeJS.Timeout
    }

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPage('404', '<h2>404</h2><p>无效的回调路径</p>'))
        return
      }
      const qs = url.searchParams
      const code = qs.get('code')
      const returnedState = qs.get('state')
      const errorParam = qs.get('error')

      if (returnedState !== flow.state) {
        flow.status = 'error'
        flow.message = 'state 校验失败（可能遭遇 CSRF 攻击）'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPage('授权失败', '<h2 class="err">授权失败</h2><p>' + flow.message + '</p>'))
        return
      }
      if (errorParam) {
        flow.status = 'error'
        flow.message = '用户拒绝了授权：' + (qs.get('error_description') ?? errorParam)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPage('授权未完成', '<h2 class="err">授权未完成</h2><p>' + flow.message + '</p>'))
        return
      }
      if (!code) {
        flow.status = 'error'
        flow.message = '回调缺少授权码'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPage('授权失败', '<h2 class="err">授权失败</h2><p>' + flow.message + '</p>'))
        return
      }

      void exchangeCode(cfg, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier
      }).then(({ json, error }) => {
        if (error) {
          flow.status = 'error'
          flow.message = error
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(renderPage('授权失败', '<h2 class="err">授权失败</h2><p>' + error + '</p>'))
          return
        }
        try {
          if (!json.refresh_token) {
            flow.status = 'error'
            flow.message = '授权服务器未返回 refresh_token，无法保存登录状态'
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(renderPage('授权失败', '<h2 class="err">授权失败</h2><p>' + flow.message + '</p>'))
            return
          }
          flow.refreshEnc = encryptSecret(String(json.refresh_token))
          flow.accessEnc = encryptSecret(String(json.access_token))
          const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600
          flow.expiresAt = Date.now() + expiresIn * 1000
          flow.email = emailFromIdToken(typeof json.id_token === 'string' ? json.id_token : undefined)
          flow.status = 'done'
          flow.message = undefined
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(
            renderPage(
              '授权成功',
              '<h2 class="ok">授权成功</h2>' +
                (flow.email ? '<p>已获取账号 ' + flow.email + '</p>' : '') +
                '<p>可以关闭此页面，返回 InfoAgent 完成账号设置。</p>'
            )
          )
        } catch (error) {
          flow.status = 'error'
          flow.message = '凭据加密失败：' + ((error as Error).message ?? String(error))
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(renderPage('授权失败', '<h2 class="err">授权失败</h2><p>' + flow.message + '</p>'))
        }
      })
    })

    server.on('error', (error) => {
      const cur = pendingFlows.get(state)
      if (cur && cur.status === 'pending') {
        cur.status = 'error'
        cur.message = '本地回调服务器启动失败：' + error.message
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      flow.redirectUri = 'http://127.0.0.1:' + port + '/oauth/callback'
      flow.server = server
      flow.timer = setTimeout(() => {
        const cur = pendingFlows.get(state)
        if (cur && cur.status === 'pending') {
          cur.status = 'expired'
          cur.message = '授权已超时（10 分钟），请重新发起'
        }
      }, FLOW_TIMEOUT_MS)
      pendingFlows.set(state, flow)

      const authUrl = new URL(cfg.authorizeUrl)
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('redirect_uri', flow.redirectUri)
      authUrl.searchParams.set('scope', cfg.scopes.join(' '))
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      for (const [k, v] of Object.entries(cfg.extraParams ?? {})) authUrl.searchParams.set(k, v)
      resolve({ ok: true, authUrl: authUrl.toString(), state })
    })
  })
}

/**
 * 查询授权状态（渲染进程轮询）。done 后 flow 保留在内存中，直到 takeOauthResult 或超时清理。
 */
export function getOauthStatus(state: string): OauthPollResult {
  const flow = pendingFlows.get(state)
  if (!flow) return { status: 'error', message: '授权会话不存在或已过期，请重新发起登录' }
  if (flow.status === 'done') {
    return { status: 'done', email: flow.email }
  }
  return { status: flow.status, email: flow.email, message: flow.message }
}

/** 取消进行中的授权（用户关闭弹窗） */
export function cancelOauth(state: string): void {
  const flow = pendingFlows.get(state)
  if (!flow) return
  if (flow.status === 'pending') {
    flow.status = 'cancelled'
    flow.message = '已取消授权'
  }
  closeFlow(flow)
  pendingFlows.delete(state)
}

/** 不消费地查看已完成的授权结果（连接测试用） */
export function peekOauthResult(state: string): {
  provider: string
  clientId: string
  email?: string
  refreshEnc: string
  accessEnc: string
  expiresAt: number
} | null {
  const flow = pendingFlows.get(state)
  if (!flow || flow.status !== 'done') return null
  return {
    provider: flow.provider,
    clientId: flow.clientId,
    email: flow.email,
    refreshEnc: flow.refreshEnc as string,
    accessEnc: flow.accessEnc as string,
    expiresAt: flow.expiresAt as number
  }
}

/** 消费已完成的授权结果（写库用）；返回后该 state 立即失效 */
export function takeOauthResult(state: string): {
  provider: string
  clientId: string
  email?: string
  refreshEnc: string
  accessEnc: string
  expiresAt: number
} | null {
  const flow = pendingFlows.get(state)
  if (!flow || flow.status !== 'done') return null
  pendingFlows.delete(state)
  closeFlow(flow)
  return {
    provider: flow.provider,
    clientId: flow.clientId,
    email: flow.email,
    refreshEnc: flow.refreshEnc as string,
    accessEnc: flow.accessEnc as string,
    expiresAt: flow.expiresAt as number
  }
}

/**
 * 用 refresh_token 换取新 access token（Microsoft 会轮换 refresh_token，须回写）。
 */
export async function refreshAccessToken(
  provider: string,
  clientId: string,
  refreshToken: string,
  cfg: OAuthProviderConfig | undefined = getOauthProviderConfig(provider)
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  if (!cfg) throw new Error('该邮箱服务商不支持 OAuth 登录')
  const { json, error } = await exchangeCode(cfg, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken
  })
  if (error || !json.access_token) {
    throw new Error(error ?? 'OAuth 刷新失败：授权可能已失效，请在账号设置中重新登录')
  }
  const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : refreshToken,
    expiresAt: Date.now() + expiresIn * 1000
  }
}

export interface OauthAccountRef {
  id: number
  oauth_provider: string | null
  oauth_client_id: string | null
  oauth_refresh_enc: string | null
  oauth_access_enc: string | null
  oauth_expires_at: number | null
}

/** 账号是否已绑定 OAuth 凭据 */
export function accountHasOauth(account: OauthAccountRef | null | undefined): boolean {
  return (
    !!account &&
    typeof account.oauth_provider === 'string' &&
    account.oauth_provider.length > 0 &&
    hasSecret(account.oauth_refresh_enc)
  )
}

/**
 * 取可用 access token：未过期直接用，过期则刷新并回写数据库。
 * 抛出 Error（中文文案）表示授权失效，需重新登录。
 */
export async function getFreshAccessToken(db: DatabaseSync, account: OauthAccountRef): Promise<string> {
  if (!accountHasOauth(account)) throw new Error('该账号未绑定 OAuth 授权，请编辑账号重新登录')
  const expiresAt = typeof account.oauth_expires_at === 'number' ? account.oauth_expires_at : 0
  if (account.oauth_access_enc && Date.now() < expiresAt - 60 * 1000) {
    return decryptSecret(account.oauth_access_enc)
  }
  const provider = account.oauth_provider as string
  const clientId = account.oauth_client_id ?? ''
  const refreshed = await refreshAccessToken(provider, clientId, decryptSecret(account.oauth_refresh_enc as string))
  db.prepare(
    "UPDATE accounts SET oauth_refresh_enc = ?, oauth_access_enc = ?, oauth_expires_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(encryptSecret(refreshed.refreshToken), encryptSecret(refreshed.accessToken), refreshed.expiresAt, account.id)
  return refreshed.accessToken
}
