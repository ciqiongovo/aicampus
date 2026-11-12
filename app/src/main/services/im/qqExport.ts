/**
 * QQ 消息管理器导出 txt 的解析与适配器。
 *
 * 这是 QQ 侧风险最低的入口：不碰加密数据库、不注入进程，用户手动导出即可。
 * 导出格式（NT 9.x）大致是：
 *
 *   消息记录（此记录未加密）
 *   消息对象: 群名(群号)
 *   ==================
 *   2026-10-14 9:02:11 张三(10001)
 *   消息正文
 *
 * 解析器刻意写得宽松：认不出时间戳的行一律当作上一条消息的续行。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ImMessageKind } from '../../../shared/im'
import { normalizeDateTime } from '../../../shared/imTime'
import type { ImSourceAdapter, RawMessage, RawSession, SyncCursor } from './types'

export interface ParsedQqMessage {
  sentAt: string
  senderName: string
  senderId: string
  kind: ImMessageKind
  text: string
}

export interface ParsedQqExport {
  title: string
  messages: ParsedQqMessage[]
}

const TIMESTAMP_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ \t]+(\d{1,2}):(\d{2}):(\d{2})[ \t]*(.*)$/
const SEPARATOR_RE = /^[=\-]{6,}$/
const META_RE = /^(消息记录|消息分组|消息对象|日期|导出时间)\s*[:：]?/

function splitSender(rest: string): { name: string; id: string } {
  const trimmed = rest.trim().replace(/[:：]\s*$/, '')
  const matched = /^(.*?)\s*[（(<]([^）)>]{1,64})[）)>]\s*$/.exec(trimmed)
  if (matched && matched[1].trim()) return { name: matched[1].trim(), id: matched[2].trim() }
  return { name: trimmed, id: '' }
}

/** QQ 导出里的占位符 → 语义类型 */
function classifyQqContent(raw: string): { kind: ImMessageKind; text: string } {
  const text = raw.trim()
  if (!text) return { kind: 'other', text: '' }
  if (/^\[(图片|image|img)\]$/i.test(text)) return { kind: 'image', text: '[图片]' }
  if (/^\[(动画表情|表情|sticker|emoji)\]$/i.test(text)) return { kind: 'sticker', text: '[表情]' }
  if (/^\[(语音|voice|audio)\]$/i.test(text)) return { kind: 'voice', text: '[语音]' }
  if (/^\[(视频|video)\]$/i.test(text)) return { kind: 'video', text: '[视频]' }
  if (/^\[(文件|file)\]/.test(text)) return { kind: 'file', text }
  if (/^\[(位置|location)\]/.test(text)) return { kind: 'location', text }
  if (/^\[(QQ红包|红包|转账|redpacket)\]/.test(text)) return { kind: 'redpacket', text }
  if (/^\[(聊天记录|合并转发)\]/.test(text)) return { kind: 'merge', text }
  if (/^https?:\/\/\S+$/.test(text)) return { kind: 'link', text }
  return { kind: 'text', text }
}

/** 解析单个导出文件；fallbackTitle 一般是文件名 */
export function parseQqExportText(content: string, fallbackTitle: string): ParsedQqExport {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let title = ''
  const messages: ParsedQqMessage[] = []

  let pendingSender: { name: string; id: string } | null = null
  let pendingTime = ''
  let buffer: string[] = []

  const flush = (): void => {
    if (pendingSender && pendingTime) {
      const body = buffer.join('\n').replace(/^\n+|\n+$/g, '').trim()
      const classified = classifyQqContent(body)
      messages.push({
        sentAt: pendingTime,
        senderName: pendingSender.name,
        senderId: pendingSender.id,
        kind: classified.kind,
        text: classified.text
      })
    }
    pendingSender = null
    pendingTime = ''
    buffer = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    const meta = /^消息对象\s*[:：]\s*(.+)$/.exec(trimmed)
    if (meta && !title) {
      const name = /\s*[（(][^）)]*[）)]\s*$/.test(meta[1]) ? meta[1].replace(/\s*[（(][^）)]*[）)]\s*$/, '') : meta[1]
      title = name.trim()
      continue
    }
    if (SEPARATOR_RE.test(trimmed) || META_RE.test(trimmed)) {
      // 元信息与分隔线不进入正文，但也不能切断上一条消息的续行判断
      continue
    }

    const ts = TIMESTAMP_RE.exec(trimmed)
    if (ts) {
      flush()
      const sentAt = normalizeDateTime(
        `${ts[1]}-${ts[2].padStart(2, '0')}-${ts[3].padStart(2, '0')} ${ts[4].padStart(2, '0')}:${ts[5]}:${ts[6]}`
      )
      pendingTime = sentAt
      pendingSender = splitSender(ts[7] ?? '')
      continue
    }

    if (pendingSender) {
      buffer.push(line)
    }
  }
  flush()

  return { title: title || fallbackTitle, messages }
}

/** 稳定 id：同一条消息重复导出时不会重复入库 */
function stableMessageId(sessionKey: string, message: ParsedQqMessage, occurrence: number): string {
  const digest = createHash('sha1')
    .update(`${sessionKey}\u0001${message.sentAt}\u0001${message.senderId || message.senderName}\u0001${message.text}\u0001${occurrence}`)
    .digest('hex')
  return `qq-${digest.slice(0, 20)}`
}

function sessionKeyOf(title: string): string {
  return `qq-${createHash('sha1').update(title).digest('hex').slice(0, 16)}`
}

interface QqSessionData {
  raw: RawSession
  messages: RawMessage[]
}

export interface QqExportAdapterOptions {
  /** 覆盖会话标题（默认取导出文件里的“消息对象”） */
  title?: string
  /** 每条消息是否保留原始文本（调试用，默认不保留以省空间） */
  keepRaw?: boolean
}

export class QqExportAdapter implements ImSourceAdapter {
  readonly platform = 'qq' as const
  readonly label = 'QQ 消息管理器导出 txt'

  private cache: QqSessionData[] | null = null

  constructor(
    private readonly files: string[],
    private readonly options: QqExportAdapterOptions = {}
  ) {}

  async health(): Promise<{ ok: boolean; detail: string }> {
    const existing = this.files.filter((file) => existsSync(file))
    if (existing.length === 0) return { ok: false, detail: '没有找到可读的导出文件' }
    return { ok: true, detail: `${existing.length} 个导出文件可读` }
  }

  private async load(): Promise<QqSessionData[]> {
    if (this.cache) return this.cache

    const byTitle = new Map<string, ParsedQqMessage[]>()
    for (const file of this.files) {
      if (!existsSync(file)) continue
      const content = await readFile(file, 'utf8')
      const parsed = parseQqExportText(content, this.options.title ?? path.parse(file).name)
      const title = this.options.title ?? parsed.title
      const merged = byTitle.get(title) ?? []
      merged.push(...parsed.messages)
      byTitle.set(title, merged)
    }

    const result: QqSessionData[] = []
    for (const [title, parsedMessages] of byTitle) {
      const sorted = [...parsedMessages].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0))
      const sessionKey = sessionKeyOf(title)
      const occurrence = new Map<string, number>()
      const messages: RawMessage[] = sorted.map((message, index) => {
        const fingerprint = `${message.sentAt}\u0001${message.senderId}\u0001${message.text}`
        const count = (occurrence.get(fingerprint) ?? 0) + 1
        occurrence.set(fingerprint, count)
        return {
          platformMsgId: stableMessageId(sessionKey, message, count),
          seq: index + 1,
          sentAt: message.sentAt,
          senderId: message.senderId,
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
          lastMessageAt: messages[messages.length - 1]?.sentAt ?? null
        },
        messages
      })
    }

    this.cache = result
    return result
  }

  async listSessions(): Promise<RawSession[]> {
    const data = await this.load()
    return data.map((item) => item.raw)
  }

  async fetchMessages(session: RawSession, cursor: SyncCursor, limit: number): Promise<RawMessage[]> {
    const data = await this.load()
    const found = data.find((item) => item.raw.platformSessionId === session.platformSessionId)
    if (!found) return []
    const fresh = cursor.since
      ? found.messages.filter((message) => message.sentAt > cursor.since!)
      : found.messages
    return fresh.slice(0, Math.max(limit, 1))
  }
}
