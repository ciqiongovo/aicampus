/**
 * 单篇公众号文章的渲染抓取。
 *
 * 为什么不用 fetch：公众号文章页是个 JS 外壳，直接请求拿到的是几 MB 脚本，
 * 正文由前端注入。必须真的渲染一次才能读到内容。
 *
 * 为什么不用外部浏览器：Electron 自己就是 Chromium，开一个隐藏窗口成本最低，
 * 也不用用户额外装东西。代价是这个窗口要能被清理干净——单篇抓完立刻销毁，
 * 不给内存里留一堆后台窗口。
 *
 * 一个踩过的坑：UA 里带 "Electron" 时页面会走不同的分支，取到的 DOM 结构与
 * 正常浏览器不一致，正文选择器可能全部落空。所以这里固定伪装成普通 Chrome。
 */

import { BrowserWindow } from 'electron'
import { parsePublishTime } from '../../../shared/benchmark'

/** 与当前 Electron 内置 Chromium 大版本对齐的普通桌面 Chrome UA */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

export type FetchStatus = 'ok' | 'deleted' | 'unreachable'

export interface FetchOutcome {
  status: FetchStatus
  title: string
  author: string
  publishedAt: string | null
  body: string
  error: string
}

/** 页面被判定为这些文案时，说明原文已不可读；分开记，因为处理方式不同 */
const DELETED_MARKERS = ['该内容已被发布者删除', '此内容因违规无法查看', '该公众号已迁移']
const UNAVAILABLE_MARKERS = ['此内容暂时无法查看', '环境异常', '完成验证后即可继续访问']

/** 在渲染完的页面里就地取字段，只回传文本，不回传整个 DOM（那有几 MB） */
const EXTRACT_SCRIPT = `(() => {
  const meta = (p) => {
    const el = document.querySelector('meta[property="' + p + '"]')
    return el ? (el.getAttribute('content') || '').trim() : ''
  }
  const text = (sel) => {
    const el = document.querySelector(sel)
    return el ? (el.innerText || el.textContent || '').trim() : ''
  }
  const content = document.querySelector('#js_content') || document.querySelector('#js_image_content')
  let body = ''
  if (content) {
    const clone = content.cloneNode(true)
    clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove())
    body = (clone.innerText || clone.textContent || '')
      .replace(/\\u00a0/g, ' ')
      .replace(/[ \\t]+/g, ' ')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim()
  }
  const plain = (document.body ? document.body.innerText : '').slice(0, 3000)
  return {
    title: meta('og:title') || text('#activity-name') || document.title || '',
    author: meta('og:article:author') || text('#js_name'),
    timeText: text('#publish_time'),
    body,
    plain,
    ready: document.readyState
  }
})()`

interface RawPage {
  title: string
  author: string
  timeText: string
  body: string
  plain: string
}

export interface FetchOptions {
  /** 单篇超时。公众号页常见 2-4 秒渲染完，10 秒足够；慢网留 15 秒 */
  timeoutMs?: number
}

/**
 * 抓一篇。任何情况下都 resolve，不抛异常——抓取失败是常态（原文删除、网络抖动），
 * 调用方只需要看 status，不必写 try/catch。
 */
export async function fetchArticle(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const timeoutMs = options.timeoutMs ?? 15000
  const empty = { title: '', author: '', publishedAt: null, body: '' }
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

    const page = (await win.webContents.executeJavaScript(EXTRACT_SCRIPT, true)) as RawPage
    const plain = page.plain || ''

    if (DELETED_MARKERS.some((m) => plain.includes(m))) {
      return { ...empty, status: 'deleted', error: '原文已删除' }
    }
    if (UNAVAILABLE_MARKERS.some((m) => plain.includes(m))) {
      return { ...empty, status: 'unreachable', error: '内容暂不可见' }
    }

    // 正文区拿不到时用整页文字兜底：学生会很爱发长图通知，文字全在图片里，
    // #js_content 几乎是空的。宁可拿一份粗糙的整页文字交给模型，也不要白白丢一篇。
    const body =
      page.body.length >= 60 ? page.body : plain.length >= 120 ? plain.slice(0, 3000) : ''
    if (!body) {
      return { ...empty, status: 'unreachable', error: '正文为空' }
    }

    return {
      status: 'ok',
      title: page.title,
      author: page.author,
      publishedAt: parsePublishTime(page.timeText),
      body,
      error: ''
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...empty, status: 'unreachable', error: message }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}
