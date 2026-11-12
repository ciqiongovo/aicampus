/**
 * 消息正文清洗：微信的消息正文经常是 XML（appmsg / sysmsg / 引用 / 撤回），
 * 直接丢给模型会浪费 token 且容易跑偏，这里统一转成「类型 + 纯文本 + 引用」。
 */

import type { ImMessageKind } from '../../../shared/im'

export interface NormalizedContent {
  kind: ImMessageKind
  text: string
  quoteText: string | null
  mediaPath: string | null
  /** 撤回 / 系统提示，不参与理解 */
  deleted: boolean
}

const EMPTY: NormalizedContent = { kind: 'other', text: '', quoteText: null, mediaPath: null, deleted: false }

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' '
}

export function decodeXmlEntities(input: string): string {
  return input.replace(/&(lt|gt|amp|quot|apos|#39|nbsp);/g, (match) => ENTITIES[match] ?? match)
}

/** 去掉 CDATA 包裹 */
export function unwrapCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

/** 取 <tag>...</tag> 内部文本，自动处理 CDATA 与实体；取不到返回 null */
export function xmlValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = re.exec(xml)
  if (!match) return null
  const value = decodeXmlEntities(unwrapCdata(match[1])).trim()
  return value || null
}

/** 取 <tag ...>...</tag> 整块（用于 appmsg / refermsg） */
export function xmlBlock(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = re.exec(xml)
  return match ? match[1] : null
}

/** 粗暴剥标签，保留可读文本 */
export function stripXml(xml: string): string {
  return decodeXmlEntities(
    unwrapCdata(xml)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 微信原始消息类型 → 语义类型 */
export function kindFromWechatType(type: number | undefined): ImMessageKind {
  switch (type) {
    case 1:
      return 'text'
    case 3:
      return 'image'
    case 34:
      return 'voice'
    case 42:
      return 'other'
    case 43:
      return 'video'
    case 47:
      return 'sticker'
    case 48:
      return 'location'
    case 49:
      return 'other'
    case 50:
      return 'call'
    case 10000:
    case 10002:
      return 'system'
    default:
      return 'other'
  }
}

const APP_KIND: Record<string, ImMessageKind> = {
  '3': 'link',
  '4': 'link',
  '5': 'link',
  '6': 'file',
  '19': 'merge',
  '33': 'other',
  '36': 'other',
  '51': 'other',
  '57': 'quote',
  '2000': 'redpacket',
  '2001': 'redpacket'
}

export interface RawWechatMessage {
  type?: number
  content?: string
  mediaPath?: string | null
}

/**
 * 微信单条消息归一化。
 * 兼容：纯文本、appmsg（链接/文件/引用/小程序/转账）、sysmsg（撤回/拍一拍）。
 */
export function normalizeWeChatMessage(raw: RawWechatMessage): NormalizedContent {
  const content = (raw.content ?? '').trim()
  const type = raw.type
  const baseKind = kindFromWechatType(type)

  if (!content) {
    return { ...EMPTY, kind: baseKind, mediaPath: raw.mediaPath ?? null }
  }

  if (content.startsWith('<') && /<(msg|sysmsg|appmsg)/i.test(content)) {
    const sysmsgBlock = xmlBlock(content, 'sysmsg') ?? (content.startsWith('<sysmsg') ? content : null)
    if (sysmsgBlock !== null) {
      const revoke = xmlBlock(sysmsgBlock, 'revokemsg')
      if (revoke !== null) {
        const replace = xmlValue(revoke, 'replacemsg')
        return {
          kind: 'system',
          text: replace ?? '一条消息已被撤回',
          quoteText: null,
          mediaPath: null,
          deleted: true
        }
      }
      const pat = xmlBlock(sysmsgBlock, 'pat')
      if (pat !== null) {
        return { kind: 'system', text: '拍了拍', quoteText: null, mediaPath: null, deleted: true }
      }
      return { kind: 'system', text: stripXml(sysmsgBlock), quoteText: null, mediaPath: null, deleted: true }
    }

    const appmsg = xmlBlock(content, 'appmsg')
    if (appmsg !== null) {
      const title = xmlValue(appmsg, 'title') ?? ''
      const des = xmlValue(appmsg, 'des') ?? ''
      const url = xmlValue(appmsg, 'url') ?? ''
      const appType = xmlValue(appmsg, 'type') ?? ''
      const refer = xmlBlock(appmsg, 'refermsg')
      const quoteText = refer ? buildQuote(refer) : null
      const kind = quoteText ? 'quote' : APP_KIND[appType] ?? 'other'

      if (kind === 'quote') {
        return { kind, text: title || des || '回复了一条消息', quoteText, mediaPath: null, deleted: false }
      }
      if (kind === 'file') {
        return { kind, text: title || des || '文件', quoteText: null, mediaPath: null, deleted: false }
      }
      if (kind === 'link') {
        return {
          kind,
          text: [title, des].filter(Boolean).join(' — ') || url,
          quoteText: null,
          mediaPath: null,
          deleted: false
        }
      }
      if (kind === 'redpacket') {
        return { kind, text: title || des || '转账/红包', quoteText: null, mediaPath: null, deleted: false }
      }
      if (kind === 'merge') {
        return { kind, text: title || '聊天记录', quoteText: null, mediaPath: null, deleted: false }
      }
      return {
        kind,
        text: [title, des].filter(Boolean).join(' — ') || stripXml(appmsg),
        quoteText: null,
        mediaPath: null,
        deleted: false
      }
    }

    const stripped = stripXml(content)
    return { kind: baseKind === 'text' ? 'other' : baseKind, text: stripped, quoteText: null, mediaPath: null, deleted: false }
  }

  return {
    kind: baseKind,
    text: content,
    quoteText: null,
    mediaPath: raw.mediaPath ?? null,
    deleted: false
  }
}

function buildQuote(refer: string): string | null {
  const name = xmlValue(refer, 'displayname') ?? ''
  const body = xmlValue(refer, 'content') ?? ''
  const text = stripXml(body)
  if (!text) return null
  return name ? `${name}：${text}` : text
}

/** 判断一条消息是否值得进入理解窗口（纯系统提示/空白直接跳过） */
export function isMeaningful(text: string, kind: ImMessageKind): boolean {
  if (kind === 'system') return false
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^(撤回了一条消息|拍了拍.*)$/.test(trimmed)) return false
  return true
}
