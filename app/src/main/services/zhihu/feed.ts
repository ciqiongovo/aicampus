import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { ZHIHU_PARTITION } from '../../../shared/zhihu'

/**
 * 知乎推荐流抓取网关。
 *
 * 知乎没有公开的个性化推荐 API；推荐流请求带 x-zse-96 等签名，硬编码签名会随前端更新失效。
 * 这里复用 Electron 自己的 Chromium：用户在独立分区里登录一次，之后用 CDP 读取首页请求的
 * /api/v3/feed/topstory/recommend 响应，不在主进程重放签名。
 */

const RECOMMEND_PATH = '/api/v3/feed/topstory/recommend'
const LOGIN_URL = 'https://www.zhihu.com/signin?next=%2F'
const HOME_URL = 'https://www.zhihu.com/'
const MAX_CAPTURE_ITEMS = 60
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const PAGE_LOAD_TIMEOUT_MS = 45_000

export class ZhihuAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZhihuAuthError'
  }
}

export interface ZhihuFeedItem {
  itemKey: string
  title: string
  excerpt: string
  url: string
  author: string
  contentType: string
  voteup: number | null
}

export interface ZhihuCaptureResult {
  items: ZhihuFeedItem[]
  capturedAt: string
  pageUrl: string
}

export interface ZhihuGateway {
  hasLogin(): Promise<boolean>
  login(parent?: BrowserWindow | null): Promise<{ ok: boolean; message: string }>
  /** 清除独立分区里的知乎登录 Cookie；失败时抛错，由 service 转成提示。 */
  logout(): Promise<void>
  capture(maxItems?: number): Promise<ZhihuCaptureResult>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function stripHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function webUrl(target: Record<string, unknown>): string {
  const type = String(target.type ?? target.content_type ?? '')
  const id = target.id
  const question = target.question as Record<string, unknown> | undefined
  if (type === 'answer' && question && question.id !== undefined) {
    return `https://www.zhihu.com/question/${String(question.id)}/answer/${String(id)}`
  }
  if (type === 'article') return `https://zhuanlan.zhihu.com/p/${String(id)}`
  if (type === 'zvideo') return `https://www.zhihu.com/zvideo/${String(id)}`
  return String(target.url ?? '')
    .replace('api.zhihu.com', 'www.zhihu.com')
    .replace('api.zhihu.com', 'www.zhihu.com')
}

function parseFeed(text: string, items: Map<string, ZhihuFeedItem>): number {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return 0
  }
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data)) return 0
  let added = 0
  for (const row of data) {
    const record = row as Record<string, unknown>
    const target = (record.target ?? row) as Record<string, unknown>
    if (!target || target.id === undefined || target.id === null) continue
    const type = String(target.type ?? target.content_type ?? 'unknown')
    if (type === 'ad' || type === 'feed_ad') continue
    const title = stripHtml(target.title ?? (target.question as Record<string, unknown> | undefined)?.title)
    if (!title) continue
    const key = `${type}:${String(target.id)}`
    if (items.has(key)) continue
    const author = target.author as Record<string, unknown> | undefined
    items.set(key, {
      itemKey: key,
      title,
      excerpt: stripHtml(target.excerpt).slice(0, 400),
      url: webUrl(target),
      author: String(author?.name ?? ''),
      contentType: type,
      voteup: typeof target.voteup_count === 'number' ? target.voteup_count : null
    })
    added += 1
  }
  return added
}

/** 真实 Electron 网关；单测只依赖 ZhihuGateway 接口。 */
export class ElectronZhihuGateway implements ZhihuGateway {
  private ses(): Session {
    const ses = session.fromPartition(ZHIHU_PARTITION)
    const chrome = process.versions.chrome || '131.0.0.0'
    ses.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
    )
    ses.setSpellCheckerEnabled(false)
    return ses
  }

  async hasLogin(): Promise<boolean> {
    try {
      const cookies = await this.ses().cookies.get({ url: 'https://www.zhihu.com', name: 'z_c0' })
      return Array.isArray(cookies) && cookies.length > 0
    } catch {
      return false
    }
  }

  async logout(): Promise<void> {
    await this.ses().clearStorageData({ storages: ['cookies'] })
  }

  async login(parent?: BrowserWindow | null): Promise<{ ok: boolean; message: string }> {
    if (await this.hasLogin()) return { ok: true, message: '已连接知乎' }
    const win = new BrowserWindow({
      width: 1120,
      height: 820,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: '连接知乎 — 扫码或登录',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: ZHIHU_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.once('ready-to-show', () => win.show())
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://www.zhihu.com')) return { action: 'allow' }
      return { action: 'deny' }
    })
    try {
      await withTimeout(win.loadURL(LOGIN_URL), PAGE_LOAD_TIMEOUT_MS, '知乎登录页加载超时')
      win.show()
      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (win.isDestroyed()) return { ok: false, message: '登录窗口已关闭' }
        if (await this.hasLogin()) {
          await sleep(1200)
          return { ok: true, message: '已连接知乎' }
        }
        await sleep(1200)
      }
      return { ok: false, message: '登录超时，请重试' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  async capture(maxItems = MAX_CAPTURE_ITEMS): Promise<ZhihuCaptureResult> {
    if (!(await this.hasLogin())) throw new ZhihuAuthError('知乎登录已失效，请重新连接')
    const win = new BrowserWindow({
      width: 1280,
      height: 920,
      show: false,
      title: 'InfoAgent 知乎推荐流',
      webPreferences: {
        partition: ZHIHU_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.webContents.setAudioMuted(true)
    let attached = false
    const items = new Map<string, ZhihuFeedItem>()
    try {
      // 必须先加载一个空文档：隐藏窗口没有 renderer 时 debugger.attach/Network.enable 会挂起。
      await win.loadURL('about:blank')
      const dbg = win.webContents.debugger
      dbg.attach('1.3')
      attached = true
      await dbg.sendCommand('Network.enable')

      const pending = new Map<string, string>()
      dbg.on('message', (_event, method: string, params: Record<string, unknown>) => {
        if (method === 'Network.responseReceived') {
          const response = params.response as { url?: string } | undefined
          const url = String(response?.url ?? '')
          if (url.includes(RECOMMEND_PATH)) pending.set(String(params.requestId), url)
          return
        }
        if (method === 'Network.loadingFailed') {
          pending.delete(String(params.requestId))
          return
        }
        if (method !== 'Network.loadingFinished') return
        const requestId = String(params.requestId)
        if (!pending.has(requestId)) return
        pending.delete(requestId)
        void (async () => {
          try {
            let body = await dbg.sendCommand('Network.getResponseBody', { requestId })
            if (!body || typeof body.body !== 'string') {
              await sleep(200)
              body = await dbg.sendCommand('Network.getResponseBody', { requestId })
            }
            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
            parseFeed(text, items)
          } catch {
            /* 单个响应失败不影响其它页 */
          }
        })()
      })

      await withTimeout(win.loadURL(HOME_URL), PAGE_LOAD_TIMEOUT_MS, '知乎首页加载超时')
      if (win.webContents.getURL().includes('/signin')) throw new ZhihuAuthError('知乎登录已失效，请重新连接')
      await sleep(4200)
      for (let i = 0; i < 10 && items.size < maxItems; i += 1) {
        try {
          await win.webContents.executeJavaScript(
            'window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 1.2))); document.body.scrollHeight',
            true
          )
        } catch {
          /* 页面切换时滚动失败，下一轮重试 */
        }
        await sleep(2400)
      }
      await sleep(1500)
      if (items.size === 0) {
        throw new Error('没有捕获到知乎推荐流，可能需要在知乎页面完成一次验证后重试')
      }
      return {
        items: [...items.values()].slice(0, maxItems),
        capturedAt: new Date().toISOString(),
        pageUrl: win.webContents.getURL()
      }
    } catch (error) {
      if (error instanceof ZhihuAuthError) throw error
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      try {
        if (attached && win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      } catch {
        /* 窗口已销毁时忽略 */
      }
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

export function createZhihuGateway(): ZhihuGateway {
  return new ElectronZhihuGateway()
}
