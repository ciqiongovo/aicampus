/**
 * QCE（NapCat + qq-chat-exporter）适配器。
 *
 * QCE 把已登录 QQ 的消息通过本地 HTTP 暴露成 JSON（Rust 服务，默认 40653），
 * 本适配器只做三件事：把群/最近会话映射成会话、把消息 JSON 映射成 RawMessage、
 * 按时间游标增量翻页。令牌从 QCE 自己的 security.json 读，不在 知枢 里另存。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatLocalDateTime, parseLooseDateTime } from '../../../shared/imTime'
import type { ImMessageKind, ImSessionKind } from '../../../shared/im'
import type { ImSourceAdapter, RawMessage, RawSession, SyncCursor } from './types'

export const QCE_DEFAULT_URL = 'http://127.0.0.1:40653'

export interface QceClientOptions {
  baseUrl?: string
  token: string
  timeoutMs?: number
}

export interface QceGroup {
  code: string
  name: string
  memberCount: number
}

export interface QceContact {
  chatType: number
  peerUid: string
  name: string
  lastMessageAt: string | null
}

export interface QcePage {
  messages: unknown[]
  totalCount: number
  page: number
  totalPages: number
  hasNext: boolean
}

/** QCE 的令牌文件默认路径（NapCat 侧生成）。 */
export function qceSecurityPath(): string {
  return join(homedir(), '.qq-chat-exporter', 'security.json')
}

/** 读取 QCE 访问令牌；文件不存在或格式不对时返回 null，不抛错。 */
export function readQceToken(path = qceSecurityPath()): string | null {
  try {
    if (!existsSync(path)) return null
    const data = JSON.parse(readFileSync(path, 'utf8')) as { accessToken?: unknown }
    return typeof data.accessToken === 'string' && data.accessToken.length > 0 ? data.accessToken : null
  } catch {
    return null
  }
}

export class QceClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(options: QceClientOptions) {
    this.baseUrl = (options.baseUrl ?? QCE_DEFAULT_URL).replace(/\/+$/, '')
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 60000
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {})
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`
      throw new Error(`QCE ${path} 失败：${message}`)
    }
    const payload = body as { success?: boolean; data?: unknown; error?: unknown } | null
    if (payload && payload.success === false) {
      throw new Error(`QCE ${path} 失败：${String(payload.error ?? '未知错误')}`)
    }
    return (payload && 'data' in payload ? payload.data : payload) as T
  }

  async health(): Promise<{ online: boolean; mode: string }> {
    const response = await fetch(this.baseUrl + '/health', { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { data?: { online?: boolean; mode?: string } } | null
    const data = body?.data ?? {}
    return { online: data.online === true, mode: String(data.mode ?? 'unknown') }
  }

  async groups(): Promise<QceGroup[]> {
    const data = await this.request<{ groups?: unknown[] }>('/api/groups')
    const rows = Array.isArray(data?.groups) ? data.groups : []
    return rows
      .map((row) => {
        const item = row as Record<string, unknown>
        return {
          code: String(item.groupCode ?? ''),
          name: String(item.groupName ?? item.groupCode ?? ''),
          memberCount: Number(item.memberCount ?? 0)
        }
      })
      .filter((group) => group.code.length > 0)
  }

  async recentContacts(): Promise<QceContact[]> {
    const data = await this.request<{ contacts?: unknown[] }>('/api/recent-contacts')
    const rows = Array.isArray(data?.contacts) ? data.contacts : []
    return rows
      .map((row) => {
        const item = row as Record<string, unknown>
        return {
          chatType: Number(item.chatType ?? 0),
          peerUid: String(item.peerUid ?? ''),
          name: String(item.name ?? item.peerName ?? item.remark ?? item.peerUid ?? ''),
          lastMessageAt: item.lastMsgTime ? String(item.lastMsgTime) : null
        }
      })
      .filter((contact) => contact.peerUid.length > 0)
  }

  async fetchPage(chatType: number, peerUid: string, page: number, limit: number): Promise<QcePage> {
    const data = await this.request<Record<string, unknown>>('/api/messages/fetch', {
      method: 'POST',
      body: JSON.stringify({ peer: { chatType, peerUid }, limit, page, batchSize: 5000 })
    })
    const messages = Array.isArray(data?.messages) ? (data.messages as unknown[]) : []
    return {
      messages,
      totalCount: Number(data?.totalCount ?? messages.length),
      page: Number(data?.currentPage ?? page),
      totalPages: Number(data?.totalPages ?? 1),
      hasNext: data?.hasNext === true
    }
  }

  /**
   * 翻页拉取某个会话最近的消息（QCE 返回新→旧）。
   * 传入 since 时，遇到不晚于 since 的消息就停止翻页——增量同步只拉新消息，避免每次扫全量。
   */
  async fetchRecent(chatType: number, peerUid: string, maxMessages = 2000, since: string | null = null): Promise<unknown[]> {
    const collected: unknown[] = []
    const seen = new Set<string>()
    let page = 1
    let totalPages = 1
    let reachedOld = false
    do {
      let result
      try {
        result = await this.fetchPage(chatType, peerUid, page, 200)
      } catch (error) {
        // 单页失败重试一次：大群首屏经常超过默认超时
        if (!(error instanceof Error) || !/timeout|aborted/i.test(error.message)) throw error
        result = await this.fetchPage(chatType, peerUid, page, 200)
      }
      totalPages = Math.max(result.totalPages, 1)
      for (const row of result.messages) {
        const id = String((row as Record<string, unknown>).msgId ?? '')
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        if (since) {
          const sentAt = qceSentAt((row as Record<string, unknown>).msgTime)
          if (sentAt <= since) {
            reachedOld = true
            break
          }
        }
        collected.push(row)
      }
      if (reachedOld || !result.hasNext || page >= totalPages) break
      page += 1
    } while (collected.length < maxMessages && page <= 200)
    return collected.slice(0, maxMessages)
  }
}

/** 把 QCE 的时间戳（秒或毫秒，字符串或数字）转成本地时间字符串。 */
export function qceSentAt(value: unknown): string {
  return formatLocalDateTime(parseLooseDateTime(value as string | number | null | undefined) ?? new Date())
}

interface QceElementParts {
  kind: ImMessageKind
  text: string
  quoteText: string | null
  mediaPath: string | null
}

/** 从 elements 数组里提炼类型与文本。 */
export function qceElementParts(message: Record<string, unknown>): QceElementParts {
  const elements = Array.isArray(message.elements) ? (message.elements as Record<string, unknown>[]) : []
  const textParts: string[] = []
  let mediaKind: ImMessageKind = 'text'
  let mediaText = ''
  let quoteText: string | null = null

  const bump = (kind: ImMessageKind, text: string): void => {
    if (mediaKind === 'text') {
      mediaKind = kind
      mediaText = text
    }
  }

  for (const element of elements) {
    const text = element.textElement as { content?: unknown } | null | undefined
    if (text && typeof text.content === 'string' && text.content.trim().length > 0) {
      textParts.push(text.content.trim())
      continue
    }
    const reply = element.replyElement as { sourceText?: unknown; originalMsg?: unknown } | null | undefined
    if (reply) {
      const source = typeof reply.sourceText === 'string' ? reply.sourceText : ''
      quoteText = source ? source.slice(0, 200) : quoteText
    }
    const pic = element.picElement as Record<string, unknown> | null | undefined
    if (pic) {
      bump('image', '[图片]')
      continue
    }
    const file = element.fileElement as { fileName?: unknown } | null | undefined
    if (file) {
      const name = typeof file.fileName === 'string' ? file.fileName : ''
      bump('file', name ? `[文件] ${name}` : '[文件]')
      continue
    }
    const ptt = element.pttElement as Record<string, unknown> | null | undefined
    if (ptt) {
      bump('voice', '[语音]')
      continue
    }
    const video = element.videoElement as Record<string, unknown> | null | undefined
    if (video) {
      bump('video', '[视频]')
      continue
    }
    const face = element.marketFaceElement ?? element.faceElement
    if (face) {
      bump('sticker', '[表情]')
      continue
    }
    const forward = element.multiForwardMsgElement as { fileName?: unknown } | null | undefined
    if (forward) {
      const name = typeof forward.fileName === 'string' ? forward.fileName : ''
      bump('merge', name ? `[聊天记录] ${name}` : '[聊天记录]')
      continue
    }
    const ark = (element.arkElement ?? element.lightAppElement ?? element.structMsgElement) as
      | Record<string, unknown>
      | null
      | undefined
    if (ark) {
      bump('link', '[卡片消息]')
      continue
    }
    const xml = (element.xmlElement ?? element.jsonElement) as { content?: unknown } | null | undefined
    if (xml) {
      bump('link', '[卡片消息]')
      continue
    }
    const wallet = element.walletElement as Record<string, unknown> | null | undefined
    if (wallet) {
      bump('other', '[转账/红包]')
      continue
    }
    const gray = element.grayTipElement as { tipText?: unknown } | null | undefined
    if (gray) {
      bump('system', typeof gray.tipText === 'string' ? gray.tipText : '[系统提示]')
    }
  }

  const joined = textParts.join(' ').trim()
  if (joined.length > 0) {
    return { kind: 'text', text: joined.slice(0, 4000), quoteText, mediaPath: null }
  }
  return { kind: mediaKind, text: mediaText || '[消息]', quoteText, mediaPath: null }
}

/** QCE 消息 → 统一 RawMessage；缺关键字段时返回 null（跳过而不是写坏数据）。 */
export function qceToRawMessage(row: unknown, seq: number): RawMessage | null {
  if (!row || typeof row !== 'object') return null
  const message = row as Record<string, unknown>
  const id = String(message.msgId ?? '')
  if (!id) return null
  const senderId = String(message.senderUid ?? message.senderUin ?? '')
  const senderName =
    String(
      message.sendRemarkName ||
        message.sendMemberName ||
        message.sendNickName ||
        senderId ||
        message.peerName ||
        ''
    ).trim() || senderId
  const parts = qceElementParts(message)
  const systemKind = parts.kind === 'system'
  return {
    platformMsgId: id,
    seq,
    sentAt: qceSentAt(message.msgTime),
    senderId,
    senderName: systemKind ? '系统' : senderName,
    isSelf: Number(message.sendType ?? 0) === 1,
    kind: parts.kind,
    text: parts.text,
    quoteText: parts.quoteText,
    mediaPath: parts.mediaPath,
    raw: undefined
  }
}

export class QceAdapter implements ImSourceAdapter {
  readonly platform = 'qq' as const
  readonly label = 'QCE 实时同步'
  private readonly client: QceClient
  private readonly maxMessages: number

  constructor(client: QceClient, options: { maxMessages?: number } = {}) {
    this.client = client
    this.maxMessages = options.maxMessages ?? 2000
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const state = await this.client.health()
      return {
        ok: state.online,
        detail: state.online ? `QCE 在线（${state.mode}）` : 'QCE 已启动但 QQ 未登录'
      }
    } catch (error) {
      return { ok: false, detail: `QCE 不可达：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async listSessions(): Promise<RawSession[]> {
    const [groups, contacts] = await Promise.all([this.client.groups(), this.client.recentContacts()])
    const sessions: RawSession[] = groups.map((group) => ({
      platformSessionId: `g:${group.code}`,
      title: group.name,
      kind: 'group' as ImSessionKind,
      memberCount: group.memberCount,
      lastMessageAt: null
    }))
    const seen = new Set(sessions.map((item) => item.platformSessionId))
    for (const contact of contacts) {
      if (contact.chatType !== 1) continue
      const platformSessionId = `p:${contact.peerUid}`
      if (seen.has(platformSessionId)) continue
      seen.add(platformSessionId)
      sessions.push({
        platformSessionId,
        title: contact.name,
        kind: 'private' as ImSessionKind,
        memberCount: 2,
        lastMessageAt: contact.lastMessageAt
      })
    }
    return sessions
  }

  async fetchMessages(session: RawSession, cursor: SyncCursor, limit: number): Promise<RawMessage[]> {
    const [prefix, peer] = session.platformSessionId.split(':')
    if (!peer) return []
    const chatType = prefix === 'g' ? 2 : 1
    const since = cursor.since ?? null
    const rows = await this.client.fetchRecent(chatType, peer, Math.max(limit, this.maxMessages), since)
    const mapped: RawMessage[] = []
    for (const row of rows) {
      const message = qceToRawMessage(row, 0)
      if (message) mapped.push(message)
    }
    mapped.sort((a, b) => a.sentAt.localeCompare(b.sentAt))
    const fresh = since ? mapped.filter((message) => message.sentAt > since) : mapped
    return fresh.map((message, index) => ({ ...message, seq: cursor.seq + index + 1 }))
  }
}
