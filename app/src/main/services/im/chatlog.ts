/**
 * chatlog 侧车客户端（微信 4.x 取数方案）。
 *
 * chatlog 是 Go 写的本地服务：读微信进程内存里的密钥、解密本地库，再通过
 * HTTP 暴露消息（默认 127.0.0.1:5030，可开 token）。这里只依赖 HTTP，
 * 不关心它内部怎么解密；接其它实现（PyWxDump、自研 sidecar）时换掉本类即可。
 *
 * 字段映射刻意写得宽容：不同版本的 chatlog 返回字段名略有差异，
 * 认不出时退化为「按时间 + 内容」可用的最小集合。
 */

import { existsSync } from 'node:fs'
import type { ImMessageKind } from '../../../shared/im'
import { normalizeDateTime } from '../../../shared/imTime'
import { normalizeWeChatMessage } from './normalize'
import type { ImSourceAdapter, RawMessage, RawSession, SyncCursor } from './types'

export interface ChatlogConfig {
  baseUrl: string
  token?: string
  timeoutMs?: number
}

type JsonObject = Record<string, unknown>

export interface ChatlogHealth {
  ok: boolean
  detail: string
  endpoint?: string
}

function pickString(row: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function pickNumber(row: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function pickBoolean(row: JsonObject, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1' || value === 'true') return true
    if (value === 0 || value === '0' || value === 'false') return false
  }
  return undefined
}

function extractItems(data: unknown): JsonObject[] {
  if (Array.isArray(data)) return data as JsonObject[]
  if (data && typeof data === 'object') {
    const obj = data as JsonObject
    for (const key of ['items', 'data', 'list', 'sessions', 'messages', 'rows']) {
      const value = obj[key]
      if (Array.isArray(value)) return value as JsonObject[]
    }
  }
  return []
}

export class ChatlogClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly timeoutMs: number

  constructor(config: ChatlogConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token
    this.timeoutMs = config.timeoutMs ?? 10_000
  }

  get endpoint(): string {
    return this.baseUrl
  }

  private async request(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${pathname}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      const response = await fetch(url, { headers, signal: controller.signal })
      const body = await response.text()
      if (!response.ok) {
        throw new Error(`chatlog ${pathname} 返回 HTTP ${response.status}: ${body.slice(0, 200)}`)
      }
      return JSON.parse(body) as unknown
    } finally {
      clearTimeout(timer)
    }
  }

  async health(): Promise<ChatlogHealth> {
    // 不同版本的健康检查路径不一致，挨个试
    const candidates = ['/api/v1/health', '/health', '/api/v1/session?limit=1']
    let lastError = ''
    for (const candidate of candidates) {
      try {
        await this.request(candidate)
        return { ok: true, detail: 'chatlog 服务可达', endpoint: this.baseUrl }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    return { ok: false, detail: lastError || 'chatlog 服务不可达', endpoint: this.baseUrl }
  }

  async listSessions(limit = 500): Promise<RawSession[]> {
    const data = await this.request('/api/v1/session', { limit })
    return extractItems(data)
      .map((row) => this.mapSession(row))
      .filter((session) => session.platformSessionId !== '')
  }

  private mapSession(row: JsonObject): RawSession {
    const id = pickString(row, ['talker', 'userName', 'username', 'id', 'strTalker', 'sessionId'])
    const name = pickString(row, ['name', 'nickname', 'remark', 'displayName', 'title']) || id
    const isGroup = pickBoolean(row, ['isGroup', 'is_group', 'isChatroom']) ?? /@chatroom$/.test(id)
    const kind = id.startsWith('gh_') ? 'official' : isGroup ? 'group' : 'peer'
    const timeValue = pickNumber(row, ['time', 'createTime', 'create_time', 'lastMsgTime']) ?? pickString(row, ['time'])
    return {
      platformSessionId: id,
      title: name,
      kind,
      memberCount: pickNumber(row, ['memberCount', 'member_count']) ?? 0,
      lastMessageAt: timeValue ? normalizeDateTime(timeValue) : null
    }
  }

  async fetchMessages(session: RawSession, cursor: SyncCursor, limit = 500): Promise<RawMessage[]> {
    const data = await this.request('/api/v1/chatlog', {
      talker: session.platformSessionId,
      time: cursor.since ?? undefined,
      limit
    })

    return extractItems(data).map((row, index) => this.mapMessage(row, session, index))
  }

  private mapMessage(row: JsonObject, session: RawSession, index: number): RawMessage {
    const type = pickNumber(row, ['type', 'localType', 'msgType', 'msg_type'])
    const content = pickString(row, ['content', 'msg', 'text', 'body'])
    const normalized = normalizeWeChatMessage({ type, content })

    const seq = pickNumber(row, ['seq', 'sortSeq', 'sort_seq', 'msgSvrId']) ?? index + 1
    const timeValue =
      pickNumber(row, ['time', 'createTime', 'createtime', 'create_time']) ?? pickString(row, ['time', 'createTime'])
    const senderId = pickString(row, ['sender', 'senderId', 'fromUser', 'from_user', 'talker'])
    const senderName = pickString(row, ['senderName', 'sender_name', 'nickname', 'fromName', 'displayName'])
    const isSelf = pickBoolean(row, ['isSelf', 'is_self']) ?? false
    const platformMsgId =
      pickString(row, ['id', 'msgId', 'serverId', 'localId', 'strId']) || `${session.platformSessionId}-${seq}`

    const kind: ImMessageKind = normalized.kind
    return {
      platformMsgId,
      seq,
      sentAt: normalizeDateTime(timeValue),
      senderId,
      senderName: senderName || (isSelf ? '我' : senderId),
      isSelf,
      kind,
      text: normalized.text,
      quoteText: normalized.quoteText,
      mediaPath: normalized.mediaPath,
      raw: undefined
    }
  }
}

/** 把 chatlog 包装成统一采集适配器 */
export class ChatlogAdapter implements ImSourceAdapter {
  readonly platform = 'wechat' as const
  readonly label = 'chatlog 本地服务（微信 4.x）'

  constructor(
    private readonly client: ChatlogClient,
    private readonly dataRoot: string | null = null
  ) {}

  async health(): Promise<{ ok: boolean; detail: string }> {
    const service = await this.client.health()
    if (!service.ok) {
      return {
        ok: false,
        detail: `${service.detail}（先启动 chatlog：chatlog server --addr 127.0.0.1:5030）`
      }
    }
    if (this.dataRoot && !existsSync(this.dataRoot)) {
      return { ok: false, detail: `chatlog 可达，但微信数据目录不存在：${this.dataRoot}` }
    }
    return { ok: true, detail: this.dataRoot ? `${service.detail}；数据目录 ${this.dataRoot}` : service.detail }
  }

  async listSessions(): Promise<RawSession[]> {
    return this.client.listSessions()
  }

  async fetchMessages(session: RawSession, cursor: SyncCursor, limit: number): Promise<RawMessage[]> {
    return this.client.fetchMessages(session, cursor, limit)
  }
}
