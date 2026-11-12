import { htmlToText } from '../mail/sanitize'

/** 剥离引用行：以 > 开头的引文、"On ... wrote:" / "在 ... 写道:" 落款块、原始邮件分隔线 */
function stripQuotes(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('>')) continue
    if (/^(On .* wrote:|在 .* 写道:|-----Original Message-----|From: .*\[mailto:)/.test(t)) continue
    out.push(line)
  }
  return out.join('\n')
}

const MAX_CHARS = 8000

/** 构造给模型的正文：优先纯文本，退 HTML 转文本，剥离引用，截断控制 token 成本 */
export function prepareBody(bodyText: string, bodyHtml: string): string {
  let text = bodyText && bodyText.trim() ? bodyText : htmlToText(bodyHtml)
  text = stripQuotes(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return ''
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n……（正文过长已截断）' : text
}
