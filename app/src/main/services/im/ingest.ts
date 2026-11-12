/**
 * 同步编排：适配器 → 会话表 → 增量拉消息 → 消息表 → 更新游标。
 *
 * 幂等靠两层保证：会话 (account_id, platform_session_id) 唯一；
 * 消息 (session_id, platform_msg_id) 唯一，重复导入只更新不新增。
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  bulkUpsertMessages,
  getSession,
  setAccountState,
  updateSessionCursor,
  upsertSession,
  type ImMessageInput
} from '../../db/dao/imDao'
import type { ImSourceAdapter, RawMessage } from './types'

export interface IngestOptions {
  /** 只同步用户启用的会话 */
  onlyEnabled?: boolean
  /** 首次发现的会话是否自动启用（默认 true） */
  enableNew?: boolean
  /** 每个会话单次最多拉多少条 */
  limit?: number
  log?: (message: string) => void
}

export interface IngestResult {
  sessions: number
  inserted: number
  updated: number
  errors: string[]
}

function toInput(message: RawMessage): ImMessageInput {
  return {
    platformMsgId: message.platformMsgId,
    seq: message.seq,
    sentAt: message.sentAt,
    senderId: message.senderId,
    senderName: message.senderName,
    isSelf: message.isSelf,
    kind: message.kind,
    text: message.text,
    quoteText: message.quoteText ?? null,
    mediaPath: message.mediaPath ?? null,
    raw: message.raw
  }
}

export async function ingestAccount(
  db: DatabaseSync,
  accountId: number,
  adapter: ImSourceAdapter,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const log = options.log ?? (() => {})
  const limit = Math.max(options.limit ?? 1000, 1)
  const result: IngestResult = { sessions: 0, inserted: 0, updated: 0, errors: [] }

  let rawSessions
  try {
    rawSessions = await adapter.listSessions()
  } catch (error) {
    const message = `拉取会话列表失败：${error instanceof Error ? error.message : String(error)}`
    setAccountState(db, accountId, 'error', message)
    throw new Error(message)
  }

  for (const raw of rawSessions) {
    const sessionId = upsertSession(db, accountId, {
      platformSessionId: raw.platformSessionId,
      title: raw.title,
      kind: raw.kind,
      memberCount: raw.memberCount ?? 0,
      lastMessageAt: raw.lastMessageAt ?? null,
      enable: options.enableNew !== false
    })

    const session = getSession(db, sessionId)
    if (!session) continue
    if (options.onlyEnabled && !session.enabled) continue

    try {
      // 新会话（lastSeq 为 0）不能带 since：会话元数据里的 lastMessageAt 只是
      // 一条线索，用它当游标会把历史消息整体跳过。
      const cursor = { seq: session.lastSeq, since: session.lastSeq > 0 ? session.lastMsgAt : null }
      const messages = await adapter.fetchMessages(raw, cursor, limit)
      if (messages.length === 0) continue

      const stat = bulkUpsertMessages(db, sessionId, messages.map(toInput))
      updateSessionCursor(db, sessionId, stat.lastSeq, stat.lastSentAt)
      result.sessions += 1
      result.inserted += stat.inserted
      result.updated += stat.updated
      log(
        `会话「${raw.title}」同步 ${messages.length} 条（新增 ${stat.inserted}，更新 ${stat.updated}）`
      )
    } catch (error) {
      const message = `会话「${raw.title}」同步失败：${error instanceof Error ? error.message : String(error)}`
      result.errors.push(message)
      log(message)
    }
  }

  setAccountState(db, accountId, result.errors.length > 0 ? 'error' : 'ok', result.errors[0] ?? null)
  return result
}
