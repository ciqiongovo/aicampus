/**
 * 采集适配器的统一契约。
 *
 * 每个来源（chatlog HTTP / QQ 导出文件 / 未来的直连解析）实现 ImSourceAdapter，
 * 上层 ingest 只认这三个方法，新增来源不用改同步逻辑。
 */

import type { ImMessageKind, ImPlatform, ImSessionKind } from '../../../shared/im'

export interface RawSession {
  platformSessionId: string
  title: string
  kind: ImSessionKind
  memberCount?: number
  lastMessageAt?: string | null
}

export interface RawMessage {
  platformMsgId: string
  seq: number
  sentAt: string
  senderId: string
  senderName: string
  isSelf: boolean
  kind: ImMessageKind
  text: string
  quoteText?: string | null
  mediaPath?: string | null
  raw?: unknown
}

export interface SyncCursor {
  /** 已同步到的最大序号（平台内单调递增时可用） */
  seq: number
  /** 已同步到的最新时间；适配器按时间增量拉取 */
  since: string | null
}

export interface ImSourceAdapter {
  readonly platform: ImPlatform
  readonly label: string
  /** 健康检查：目录是否存在、服务是否可达，不抛错 */
  health(): Promise<{ ok: boolean; detail: string }>
  listSessions(): Promise<RawSession[]>
  fetchMessages(session: RawSession, cursor: SyncCursor, limit: number): Promise<RawMessage[]>
}
