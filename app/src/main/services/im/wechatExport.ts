/**
 * 微信聊天记录「手动导出文本」的解析与适配器。
 *
 * 为什么不直连数据库：微信 4.x 的库是加密的，取密钥要读微信进程内存，
 * 而做到这件事的工具（chatlog）已被微信官方函件要求下架。因此这里只做
 * 用户主动导出后的文本导入——不碰加密库、不注入进程，合规风险最低。
 *
 * 支持的文本形态（尽量宽松，认不出时间戳的行一律当作上一条的续行）：
 *
 *   2026-10-16 09:02:11 张三
 *   消息正文
 *
 *   张三 2026-10-16 09:02:11
 *   消息正文
 *
 *   [2026-10-16 09:02:11] 张三: 消息正文
 *   2026-10-16 09:02 张三: 消息正文
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ImMessageKind } from '../../../shared/im'
import { normalizeDateTime } from '../../../shared/imTime'
import type { ImSourceAdapter, RawMessage, RawSession, SyncCursor } from './types'

export interface ParsedWechatMessage {
  sentAt: string
  senderName: string
  kind: ImMessageKind
  text: string
}

export interface ParsedWechatExport {
  title: string
  messages: ParsedWechatMessage[]
}

const TIME = '(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)'
const TIME_FIRST = new RegExp(`^\\[?${TIME}\\]?[ \\t]*(.*)$`)
const SENDER_FIRST = new RegExp(`^(.*?)[ \\t]${TIME}[ \\t]*(.*)$`)
const INLINE = /^([^:：]{1,30})[:：][ \t]*(.*)$/
const TITLE_RE = /^(与.*的聊天记录|.*聊天记录|群聊[:：].*|.*的群聊)$/

/** 微信文本导出里的占位符 → 语义类型 */
function classifyWechatContent(raw: string): { kind: ImMessageKind; text: string } {
  const text = raw.trim()
  if (!text) return { kind: 'other', text: '' }
  if (/^\[(图片|Image|image)\]$/i.test(text)) return { kind: 'image', text: '[图片]' }
  if (/^\[(动画表情|表情|GIF|Sticker)\]$/i.test(text)) return { kind: 'sticker', text: '[表情]' }
  if (/^\[(语音|Voice|audio)\]$/i.test(text)) return { kind: 'voice', text: '[语音]' }
  if (/^\[(视频|Video|video)\]$/i.test(text)) return { kind: 'video', text: '[视频]' }
  if (/^\[(文件|File|file)\]/.test(text)) return { kind: 'file', text }
  if (/^\[(位置|Location|location)\]/.test(text)) return { kind: 'location', text }
  if (/^\[(转账|红包|微信红包|RedPacket)\]/.test(text)) return { kind: 'redpacket', text }
  if (/^\[(聊天记录|合并转发|链接|Link)\]/.test(text)) return { kind: 'merge', text }
  if (/^(https?:\/\/\S+)$/.test(text)) return { kind: 'link', text }
  return { kind: 'text', text }
}

function stripTrailingColon(value: string): string {
  return value.trim().replace(/[:：]\s*$/, '')
}

/** 解析单个导出文件；fallbackTitle 一般是文件名 */
export function parseWechatExportText(content: string, fallbackTitle: string): ParsedWechatExport {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let title = ''
  const messages: ParsedWechatMessage[] = []

  let pendingSender = ''
  let pendingTime = ''
  let buffer: string[] = []

  const flush = (): void => {
    if (pendingTime !== '' && pendingSender !== '') {
      const body = buffer.join('\n').replace(/^\n+|\n+$/g, '').trim()
      if (body !== '') {
        const classified = classifyWechatContent(body)
        messages.push({ sentAt: pendingTime, senderName: pendingSender, kind: classified.kind, text: classified.text })
      }
    }
    buffer = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      buffer.push('')
      continue
    }

    let matchedTime = ''
    let rest = ''
    const timeFirst = TIME_FIRST.exec(line)
    if (timeFirst) {
      matchedTime = normalizeDateTime(timeFirst[1])
      rest = timeFirst[2].trim()
    } else {
      const senderFirst = SENDER_FIRST.exec(line)
      if (senderFirst && senderFirst[1].trim() !== '') {
        matchedTime = normalizeDateTime(senderFirst[2])
        rest = `${senderFirst[1].trim()}${senderFirst[3] ? ' ' + senderFirst[3].trim() : ''}`
      }
    }

    if (matchedTime !== '') {
      const inline = INLINE.exec(rest)
      if (inline && inline[1].trim() !== '') {
        // 单行消息：时间 + 发送人: 内容
        flush()
        const classified = classifyWechatContent(inline[2])
        messages.push({
          sentAt: matchedTime,
          senderName: stripTrailingColon(inline[1]),
          kind: classified.kind,
          text: classified.text
        })
        pendingSender = ''
        pendingTime = ''
        continue
      }
      flush()
      pendingTime = matchedTime
      pendingSender = stripTrailingColon(rest) || '未知发送人'
      continue
    }

    // 标题行：只在还没有任何消息时认
    if (messages.length === 0 && pendingTime === '' && TITLE_RE.test(line.trim())) {
      title = line.trim()
      continue
    }

    if (pendingTime === '') continue // 消息开始前的说明文字
    buffer.push(line)
  }
  flush()

  return { title: title || fallbackTitle, messages }
}

function stableMessageId(seed: string, message: ParsedWechatMessage, occurrence: number): string {
  const hash = createHash('sha1')
  hash.update(seed)
  hash.update('\u0001')
  hash.update(message.sentAt)
  hash.update('\u0001')
  hash.update(message.senderName)
  hash.update('\u0001')
  hash.update(message.text.slice(0, 120))
  hash.update('\u0001')
  hash.update(String(occurrence))
  return `wx-${hash.digest('hex').slice(0, 20)}`
}

export function sessionKeyOf(title: string): string {
  return `wx-${createHash('sha1').update(title).digest('hex').slice(0, 16)}`
}

interface WechatSessionData {
  raw: RawSession
  messages: RawMessage[]
}

export interface WechatExportAdapterOptions {
  title?: string
  keepRaw?: boolean
}

export class WechatExportAdapter implements ImSourceAdapter {
  readonly platform = 'wechat' as const
  readonly label = '微信聊天记录文本'

  private cache: WechatSessionData[] | null = null

  constructor(
    private readonly files: string[],
    private readonly options: WechatExportAdapterOptions = {}
  ) {}

  async health(): Promise<{ ok: boolean; detail: string }> {
    const existing = this.files.filter((file) => existsSync(file))
    if (existing.length === 0) return { ok: false, detail: '没有找到可读的微信导出文件' }
    const parsed = parseWechatExportText(await readFile(existing[0], 'utf8'), path.parse(existing[0]).name)
    if (parsed.messages.length === 0) return { ok: false, detail: '文件里没有识别出消息行' }
    return { ok: true, detail: `${existing.length} 个文件，首文件 ${parsed.messages.length} 条` }
  }

  private async load(): Promise<WechatSessionData[]> {
    if (this.cache) return this.cache

    const byTitle = new Map<string, ParsedWechatMessage[]>()
    for (const file of this.files) {
      if (!existsSync(file)) continue
      const content = await readFile(file, 'utf8')
      const parsed = parseWechatExportText(content, this.options.title ?? path.parse(file).name)
      const title = this.options.title ?? (parsed.title || path.parse(file).name)
      const merged = byTitle.get(title) ?? []
      merged.push(...parsed.messages)
      byTitle.set(title, merged)
    }

    const result: WechatSessionData[] = []
    for (const [title, parsedMessages] of byTitle) {
      const sorted = [...parsedMessages].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0))
      const sessionKey = sessionKeyOf(title)
      const occurrence = new Map<string, number>()
      const messages: RawMessage[] = sorted.map((message, index) => {
        const fingerprint = `${message.sentAt}\u0001${message.senderName}\u0001${message.text}`
        const count = (occurrence.get(fingerprint) ?? 0) + 1
        occurrence.set(fingerprint, count)
        return {
          platformMsgId: stableMessageId(sessionKey, message, count),
          seq: index + 1,
          sentAt: message.sentAt,
          senderId: '',
          senderName: message.senderName,
          isSelf: false,
          kind: message.kind,
          text: message.text,
          quoteText: null,
          mediaPath: null,
          raw: this.options.keepRaw ? message : undefined
        }
      })

      result.push({
        raw: {
          platformSessionId: sessionKey,
          title,
          kind: title.includes('群') ? 'group' : 'peer',
          memberCount: 0,
          lastMessageAt: messages.length > 0 ? messages[messages.length - 1].sentAt : null
        },
        messages
      })
    }
    this.cache = result
    return result
  }

  async listSessions(): Promise<RawSession[]> {
    return (await this.load()).map((item) => item.raw)
  }

  async fetchMessages(session: RawSession, _cursor: SyncCursor, limit: number): Promise<RawMessage[]> {
    const found = (await this.load()).find((item) => item.raw.platformSessionId === session.platformSessionId)
    if (!found) return []
    return found.messages.slice(0, limit)
  }
}
