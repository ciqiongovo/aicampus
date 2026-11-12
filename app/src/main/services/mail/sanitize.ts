import { createRequire } from 'node:module'

/**
 * Parser-based conservative email allowlist, NOT DOMPurify or an HTML5 browser parser.
 * htmlparser2 is an existing runtime dependency of mailparser. Resolve from that
 * package rather than relying on npm hoisting (pnpm keeps it nested).
 * Keep the renderer sandbox: no allow-scripts / allow-same-origin. Remote images
 * intentionally load automatically; their tracking/privacy risk is not removed.
 */
interface HtmlNode {
  type: string
  name?: string
  data?: string
  attribs?: Record<string, string>
  children?: HtmlNode[]
}
const mailRequire = createRequire(createRequire(__filename).resolve('mailparser'))
const { parseDocument } = mailRequire('htmlparser2') as {
  parseDocument(html: string, options: { decodeEntities: boolean }): HtmlNode
}

const TAGS = new Set(('a abbr b bdi bdo blockquote br caption center code col colgroup dd del details div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var wbr').split(' '))
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr'])
const DROP_CONTENT = new Set(('script style iframe object embed applet form input button select option textarea template noscript noembed noframes xmp plaintext svg math head title base link meta audio video source track canvas').split(' '))
const CSS_PROPERTIES = new Set(('color background-color font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration text-indent text-transform white-space word-break overflow-wrap vertical-align direction width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-width border-style border-color border-collapse border-spacing border-radius display list-style-type table-layout').split(' '))

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function webUrl(value: string): string | null {
  const clean = value.trim()
  if (/[\u0000-\u0020\u007f-\u009f]/.test(clean) || !/^https?:\/\//i.test(clean)) return null
  try {
    const parsed = new URL(clean)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname && !parsed.username && !parsed.password ? parsed.href : null
  } catch { return null }
}

function imageUrl(value: string): string | null {
  const web = webUrl(value)
  if (web) return web
  // Only inert raster image MIME types, never SVG/HTML or arbitrary data payloads.
  return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\r\n]+$/i.test(value) ? value.replace(/[\r\n]/g, '') : null
}

function safeStyle(style: string): string {
  return style.split(';').flatMap((declaration) => {
    const colon = declaration.indexOf(':')
    if (colon < 0) return []
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    if (!CSS_PROPERTIES.has(property) || !value || value.length > 300) return []
    // No URL, escapes, comments, at-rules, custom properties or general functions.
    // The only functions accepted are numeric color literals.
    const literal = value.replace(/(?:rgb|rgba|hsl|hsla)\([0-9.,% +\-]+\)/gi, 'color')
    if (!/^[a-z0-9#.,% +\-]+$/i.test(literal)) return []
    return [property + ':' + value]
  }).join(';')
}

function renderNode(node: HtmlNode, depth: number): string {
  if (depth > 100) return ''
  if (node.type === 'text') return escapeHtml(node.data || '')
  const tag = (node.name || '').toLowerCase()
  if (DROP_CONTENT.has(tag)) return ''
  const children = () => (node.children || []).map(child => renderNode(child, depth + 1)).join('')
  if (!TAGS.has(tag)) return children()
  const attrs: string[] = []
  for (const [name, value] of Object.entries(node.attribs || {})) {
    let safe: string | null = null
    if (name === 'title' || (name === 'alt' && tag === 'img')) safe = value
    else if (name === 'dir' && /^(ltr|rtl|auto)$/i.test(value)) safe = value
    else if (name === 'lang' && /^[a-z0-9-]{1,35}$/i.test(value)) safe = value
    else if (name === 'style') safe = safeStyle(value) || null
    else if (name === 'href' && tag === 'a') safe = webUrl(value)
    else if (name === 'src' && tag === 'img') safe = imageUrl(value)
    else if (['width', 'height', 'cellpadding', 'cellspacing', 'border', 'colspan', 'rowspan', 'span', 'start', 'size'].includes(name) && /^\d{1,5}%?$/.test(value)) safe = value
    else if (['align', 'valign'].includes(name) && /^(left|right|center|justify|top|middle|bottom|baseline)$/i.test(value)) safe = value
    else if (['color', 'bgcolor'].includes(name) && /^(?:#[0-9a-f]{3,8}|[a-z]{1,25})$/i.test(value)) safe = value
    if (safe !== null) attrs.push(name + '="' + escapeHtml(safe) + '"')
  }
  if (tag === 'a') attrs.push('target="_blank"', 'rel="noopener noreferrer"')
  if (tag === 'img') attrs.push('referrerpolicy="no-referrer"')
  const start = '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>'
  return VOID.has(tag) ? start : start + children() + '</' + tag + '>'
}

export function sanitizeEmailHtml(html: string): string {
  if (!html) return ''
  try {
    return renderNode(parseDocument(html, { decodeEntities: true }), 0).trim()
  } catch {
    // Parsing must fail closed; never return the untrusted original.
    return ''
  }
}

/** 只提取 HTML 中可见的强调文本，作为 AI 判断线索；不执行 HTML 或将样式本身当作偏好。 */
export function extractEmailEmphasis(html: string): string[] {
  if (!html) return []
  try {
    const root = parseDocument(html.slice(0, 120_000), { decodeEntities: true })
    const snippets: string[] = []
    const seen = new Set<string>()
    const textOf = (node: HtmlNode, depth: number): string => {
      if (depth > 60 || DROP_CONTENT.has((node.name || '').toLowerCase()) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.attribs?.style || '')) return ''
      if (node.type === 'text') return node.data || ''
      return (node.children || []).map(child => textOf(child, depth + 1)).join(' ')
    }
    const walk = (node: HtmlNode, depth: number, inherited = false): void => {
      if (depth > 60 || snippets.length >= 12) return
      const tag = (node.name || '').toLowerCase()
      if (DROP_CONTENT.has(tag)) return
      const style = node.attribs?.style || ''
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return
      const emphasized = ['strong', 'b', 'mark', 'h1', 'h2', 'h3'].includes(tag) ||
        /(?:font-weight\s*:\s*(?:bold|[6-9]00)|background-color\s*:|color\s*:)/i.test(style) ||
        (tag === 'font' && !!node.attribs?.color)
      if (emphasized && !inherited) {
        const text = textOf(node, 0).replace(/\s+/g, ' ').trim()
        if (text.length >= 2 && text.length <= 100 && !seen.has(text)) { seen.add(text); snippets.push(text) }
      }
      for (const child of node.children || []) walk(child, depth + 1, inherited || emphasized)
    }
    walk(root, 0)
    return snippets
  } catch { return [] }
}

/** HTML 粗转纯文本：邮件只有 HTML 正文时补一份可读文本 */
export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
