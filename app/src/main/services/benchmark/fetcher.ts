/**
 * 单篇公众号文章的渲染抓取（Electron 后端）。
 *
 * 为什么不用 fetch：公众号文章页是个 JS 外壳，直接请求拿到的是几 MB 脚本，
 * 正文由前端注入。必须真的渲染一次才能读到内容。
 *
 * 为什么默认用 Electron 的隐藏窗口：它自己就是 Chromium，开一个窗口成本最低，
 * 用户也不用额外装东西。缺点是应用没起来就用不了——那种场景走 render-edge.ts。
 *
 * 一个踩过的坑：UA 里带 "Electron" 时页面会走不同的分支，取到的 DOM 结构与
 * 正常浏览器不一致，正文选择器可能全部落空。所以这里固定伪装成普通 Chrome。
 */

import { BrowserWindow } from 'electron'
import { parsePublishTime } from '../../../shared/benchmark'
import { judgePage, PAGE_EXTRACT_SCRIPT, type FetchOutcome, type RawPage } from './page'
import { parseArticleHtml, renderHtml } from './render-edge'

export type { FetchOutcome, FetchStatus } from './page'

/** 与当前 Electron 内置 Chromium 大版本对齐的普通桌面 Chrome UA */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

/**
 * 渲染后端。
 *
 * - auto：先试 Electron 窗口，起不来（比如不在主进程、或窗口创建失败）就退到外部浏览器
 * - electron：只用隐藏窗口
 * - edge：只用外部浏览器，便于在命令行或测试里跑
 */
export type FetchBackend = 'auto' | 'electron' | 'edge'

export interface FetchOptions {
  /** 单篇超时。公众号页常见 2-4 秒渲染完，10 秒足够；慢网留 15 秒 */
  timeoutMs?: number
  backend?: FetchBackend
}

async function renderWithElectron(url: string, timeoutMs: number): Promise<RawPage | null> {
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 只取文字，不加载图片，省一半流量与时间
        images: false,
        backgroundThrottling: false
      }
    })
    win.webContents.setUserAgent(CHROME_UA)

    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      win!.webContents.once('did-finish-load', () => {
        // did-finish-load 只表示 HTML 到了，正文可能还在注入，留一点缓冲
        setTimeout(() => {
          clearTimeout(timer)
          resolve()
        }, 400)
      })
      win!.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer)
        reject(new Error(`${code} ${desc}`))
      })
    })

    // loadURL 遇到页面内部跳转会抛 ERR_ABORTED（-3），那不是失败，后续照样能取到 DOM
    await win.loadURL(url).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('ERR_ABORTED')) throw error
    })
    await loaded

    return (await win.webContents.executeJavaScript(PAGE_EXTRACT_SCRIPT, true)) as RawPage
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/**
 * 抓一篇。任何情况下都 resolve，不抛异常——抓取失败是常态（原文删除、网络抖动），
 * 调用方只需要看 status，不必写 try/catch。
 */
export async function fetchArticle(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const timeoutMs = options.timeoutMs ?? 15000
  const backend = options.backend ?? 'auto'
  const started = Date.now()
  const finish = (outcome: FetchOutcome): FetchOutcome => ({
    ...outcome,
    elapsedMs: Date.now() - started
  })

  let page: RawPage | null = null

  if (backend !== 'edge') {
    page = await renderWithElectron(url, timeoutMs)
    if (page && !page.plain && !page.body) page = null
  }

  if (!page && backend !== 'electron') {
    const html = await renderHtml(url, Math.max(timeoutMs, 40000))
    if (html) page = parseArticleHtml(html)
  }

  if (!page) {
    return finish({ status: 'unreachable', title: '', author: '', publishedAt: null, body: '', error: '页面未渲染出来' })
  }

  return finish(judgePage(page, parsePublishTime))
}
