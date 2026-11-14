import { spawn } from 'node:child_process'
import fs from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

export function dumpDom(url, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--mute-audio',
      '--blink-settings=imagesEnabled=false',
      '--dump-dom',
      '--virtual-time-budget=8000',
      url
    ]
    const child = spawn(EDGE, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve(out || '')
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

const stripTags = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

function meta(html, prop) {
  const re = new RegExp(`<meta\\s+[^>]*property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')
  const m = html.match(re)
  if (m) return m[1].trim()
  const re2 = new RegExp(`<meta\\s+[^>]*content=["']([^"']*)["'][^>]*property=["']${prop}["']`, 'i')
  const m2 = html.match(re2)
  return m2 ? m2[1].trim() : ''
}

/**
 * 取 id 对应元素的内部文字。
 *
 * 这里不能只用 `<div id="x">` 去匹配：新版页面里 #js_name 是 <a>、#publish_time 是 <em>，
 * 写死标签名会全部落空。所以先抓到实际标签名，再按同名标签做开合配平找闭合位置——
 * 只做深度计数，不做完整 DOM 解析，够用且不必为一条链接吞下 4MB HTML 的解析开销。
 */
function elementText(html, id) {
  const open = new RegExp(`<([a-zA-Z][\\w-]*)[^>]*\\bid=["']${id}["'][^>]*>`, 'i')
  const m = open.exec(html)
  if (!m) return ''
  const tag = m[1].toLowerCase()
  const start = m.index + m[0].length
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  tagRe.lastIndex = start
  let depth = 1
  let end = html.length
  let t
  while ((t = tagRe.exec(html))) {
    depth += t[1] === '/' ? -1 : 1
    if (depth === 0) {
      end = t.index
      break
    }
  }
  const inner = html.slice(start, end)
  return stripTags(inner).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

export function parseArticleHtml(html) {
  // og:article:author 在新版页面里是空字符串，公众号名要回到页面上取 #js_name
  const author = meta(html, 'og:article:author') || elementText(html, 'js_name')
  const title = meta(html, 'og:title') || elementText(html, 'activity-name')
  const body = elementText(html, 'js_content') || elementText(html, 'js_image_content')
  const timeText = elementText(html, 'publish_time')
  const plain = stripTags(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 3000)
  return { title, author, timeText, body, plain, size: html.length }
}

const DELETED = ['该内容已被发布者删除', '此内容因违规无法查看', '该公众号已迁移']
const UNAVAILABLE = ['此内容暂时无法查看', '环境异常', '完成验证后即可继续访问']

export function judge(page) {
  if (DELETED.some((m) => page.plain.includes(m))) return { status: 'deleted', error: '原文已删除' }
  if (UNAVAILABLE.some((m) => page.plain.includes(m))) return { status: 'unreachable', error: '内容暂不可见' }
  const body = page.body.length >= 60 ? page.body : page.plain.length >= 120 ? page.plain.slice(0, 3000) : ''
  if (!body) return { status: 'unreachable', error: '正文为空' }
  return { status: 'ok', error: '', body }
}

export function parsePublishTime(text) {
  if (!text) return null
  const m = text.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/)
  if (!m) return null
  const [, y, mo, d] = m
  const tail = text.slice(text.indexOf(m[0]) + m[0].length)
  const t = tail.match(/(\d{1,2}):(\d{2})/)
  const pad = (n) => n.padStart(2, '0')
  const date = `${y}-${pad(mo)}-${pad(d)}`
  return t ? `${date} ${pad(t[1])}:${t[2]}:00` : date
}

if (process.argv[2] === 'probe') {
  const links = JSON.parse(fs.readFileSync('output/bench/links.json', 'utf8'))
  const n = Number(process.argv[3] ?? 8)
  const t0 = Date.now()
  let ok = 0
  for (const [i, item] of links.slice(0, n).entries()) {
    const s = Date.now()
    const html = await dumpDom(item.url)
    const page = parseArticleHtml(html)
    const res = judge(page)
    const good = res.status === 'ok'
    if (good) ok += 1
    console.log(
      `${String(i + 1).padStart(2)} ${good ? 'OK ' : res.status.slice(0, 5).toUpperCase().padEnd(5)} ` +
        `${((Date.now() - s) / 1000).toFixed(1)}s dom=${(page.size / 1024).toFixed(0)}KB ` +
        `标题=${JSON.stringify(page.title.slice(0, 26))} 号=${JSON.stringify(page.author.slice(0, 12))} ` +
        `时间=${page.timeText.slice(0, 16)} 正文=${page.body.length}`
    )
  }
  console.log(`\n成功 ${ok}/${n}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}
