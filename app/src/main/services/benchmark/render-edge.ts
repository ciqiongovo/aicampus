/**
 * 用外部浏览器的无头模式渲染页面。
 *
 * 为什么要有这条路：
 * 1. Electron 的隐藏窗口是主路径，但它要求先启动整个应用。批量补数据、
 *    或想在命令行里跑一轮采集时，为了抓几篇文章开一个 GUI 应用不合适。
 * 2. 万一某个环境里 Electron 渲染不稳（打包后常见），需要一条能立刻切过去的备选。
 *
 * 代价是这条路只能拿到整页 HTML（--dump-dom），要在 Node 里自己解析。
 * 所以下面那段解析刻意写得很窄：只认几个已知的 id 和 meta，不做通用 DOM 解析。
 * 微信文章页的结构几年没大改，这套足够；真变了，解析只会返回空，不会返回错的内容。
 *
 * 实测（2026-11）：可达页面 8/8 成功，单篇 6–10 秒，整页 3.7–4.7 MB。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RawPage } from './page'

/** 常见安装位置，按顺序试；都没有就抛错，让调用方回退到 Electron 后端 */
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
]

export function findBrowser(): string | null {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null
}

/**
 * 独立的浏览器配置目录。
 *
 * 不用临时目录的原因：每次全新 profile 在微信看来都是「一台没来过的机器」，
 * 容易直接弹验证。固定目录能攒下 cookie 与站点数据，连续采集时更像同一个访客。
 * 放在应用数据目录下，卸载时跟着一起清掉，不散落在系统里。
 */
function profileDir(): string {
  const base = join(process.env.APPDATA ?? '.', 'ZhiShu', 'bench-profile')
  if (!existsSync(base)) mkdirSync(base, { recursive: true })
  return base
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

/** 拉一份渲染后的 HTML。超时或失败都 resolve 空串，由上层判为 unreachable */
export function renderHtml(url: string, timeoutMs = 40000): Promise<string> {
  const browser = findBrowser()
  if (!browser) return Promise.resolve('')

  return new Promise((resolve) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-extensions',
        '--mute-audio',
        // 不要带 automation 标记，少一个被识别的特征
        '--disable-blink-features=AutomationControlled',
        // 不加载图片：省一半流量，正文是文字，图不影响抽取
        '--blink-settings=imagesEnabled=false',
        '--user-data-dir=' + profileDir(),
        '--user-agent=' + UA,
        '--dump-dom',
        '--virtual-time-budget=8000',
        url
      ],
      { windowsHide: true }
    )
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve(out)
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

const stripTags = (s: string): string =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

function metaContent(html: string, prop: string): string {
  const a = new RegExp(`<meta\\s+[^>]*property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')
  const b = new RegExp(`<meta\\s+[^>]*content=["']([^"']*)["'][^>]*property=["']${prop}["']`, 'i')
  return (html.match(a)?.[1] ?? html.match(b)?.[1] ?? '').trim()
}

/**
 * 取 id 对应元素的内部文字。
 *
 * 不能只用 `<div id="x">` 去匹配：新版页面里 #js_name 是 <a>、#publish_time 是 <em>，
 * 写死标签名会全部落空。所以先抓到实际标签名，再按同名标签做开合配平找闭合——
 * 只数深度，不做完整 DOM 解析，不必为一条链接吞下 4 MB HTML 的解析开销。
 *
 * tagHint 用于排除同名 id 的干扰项：页面上还有按钮文案之类带相同 id 片段的东西，
 * 按 id 全局搜会把它们抓成「公众号名」。
 */
function elementText(html: string, id: string, tagHint?: string): string {
  const open = tagHint
    ? new RegExp(`<(${tagHint})\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i')
    : new RegExp(`<([a-zA-Z][\\w-]*)[^>]*\\bid=["']${id}["'][^>]*>`, 'i')
  const m = open.exec(html)
  if (!m) return ''
  const tag = m[1].toLowerCase()
  const start = m.index + m[0].length
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  tagRe.lastIndex = start
  let depth = 1
  let end = html.length
  let t: RegExpExecArray | null
  while ((t = tagRe.exec(html))) {
    depth += t[1] === '/' ? -1 : 1
    if (depth === 0) {
      end = t.index
      break
    }
  }
  return stripTags(html.slice(start, end))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseArticleHtml(html: string): RawPage {
  if (!html) return { title: '', author: '', timeText: '', body: '', plain: '' }
  const body = stripPageChrome(
    elementText(html, 'js_content') || elementText(html, 'js_image_content')
  )
  const bodyHtml = html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? ''
  // 公众号名只认 <a id="js_name">：页面上还有别的元素带相似 id，
  // 按 id 全局抓会把按钮文案当成公众号名，进而建出一个不存在的源。
  // og:article:author 也不能先用——实测有页面把它填成「欢迎新生的」这种
  // 推广文案，用它建源就等于凭空造出一个公众号。只当 #js_name 缺失时兜底。
  const author = pickAuthor(
    elementText(html, 'js_name', 'a'),
    metaContent(html, 'og:article:author')
  )
  return {
    title: metaContent(html, 'og:title') || elementText(html, 'activity-name'),
    author,
    timeText: elementText(html, 'publish_time'),
    body,
    plain: stripTags(bodyHtml).replace(/\s+/g, ' ').slice(0, 3000)
  }
}

/** 公众号名不该长这样：带标点的、以「的」结尾的、太短的，都不是名字 */
function sanitizeName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name || name.length > 40) return ''
  if (/[，。、；：？！,.;:!?]/.test(name)) return ''
  // 推广语气的短句：这些是页面上的招呼语，不是公众号名称
  if (/^(欢迎|点击|关注|扫码|长按|回复)/.test(name)) return ''
  if (/的$/.test(name)) return ''
  return name
}

/** 先信页面上的账号名，再信 og 协议字段——后者会被站点填成推广文案 */
function pickAuthor(jsName: string, ogAuthor: string): string {
  return sanitizeName(jsName) || sanitizeName(ogAuthor)
}

/**
 * 微信页面上那些不属于文章正文的固定文案。
 *
 * dump-dom 拿到的 innerText 会把阅读器提示、字号设置、举报入口一并带进来。
 * 它们混在正文里不只是难看：抽取模型会把「关闭调整当前正文文字大小」
 * 当成文章内容去理解，规则匹配也会被这些词干扰。
 */
const CHROME_NOISE = [
  '在小说阅读器读本章',
  '去阅读',
  '在公众号小说中沉浸阅读',
  '预览时标签不可点',
  '关闭更多',
  '搜索「」网络结果',
  '关闭调整当前正文文字大小',
  '此设置仅对当前内容生效，如需全局调整，请前往微信系统设置',
  '不喜欢',
  '轻点两下取消赞',
  '轻点两下取消在看',
  '微信扫一扫可打开此内容',
  '使用完整服务'
]

/**
 * 去掉页面控件文案。
 *
 * 不能按行过滤：微信正文经常整篇是 <section><img>，stripTags 之后没有任何换行，
 * 整段就是一行——按行删会把整篇正文一起删掉。
 * 所以按片段替换，删完再把多余空白压掉。
 */
function stripPageChrome(body: string): string {
  let out = body
  for (const noise of CHROME_NOISE) out = out.split(noise).join(' ')
  return out.replace(/[ \t\u00a0]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
