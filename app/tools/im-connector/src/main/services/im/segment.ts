/**
 * 切窗：把连续消息切成「能独立理解的一段」。
 *
 * 规则很简单但很有效：按时间间隔断（默认 30 分钟没人说话就翻篇），
 * 同时限制条数和字数，避免一次塞给模型太多 token 导致漏掉中段内容。
 */

import type { ImMessageKind } from '../../../shared/im'
import { parseLooseDateTime } from '../../../shared/imTime'

export interface SegmentableMessage {
  id: number
  seq: number
  sentAt: string
  kind: ImMessageKind
  text: string
  senderName: string
  isSelf: boolean
  deleted: boolean
}

export interface SegmentOptions {
  /** 两条消息间隔超过该分钟数就切窗 */
  gapMinutes?: number
  /** 单窗最多消息条数 */
  maxMessages?: number
  /** 单窗最多正文字数 */
  maxChars?: number
}

export interface MessageSegment {
  messages: SegmentableMessage[]
}

export const DEFAULT_SEGMENT_OPTIONS: Required<SegmentOptions> = {
  gapMinutes: 30,
  maxMessages: 80,
  maxChars: 4000
}

function textLength(message: SegmentableMessage): number {
  return message.text.length + (message.senderName.length ?? 0)
}

export function segmentMessages(messages: SegmentableMessage[], options: SegmentOptions = {}): MessageSegment[] {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options }
  const segments: MessageSegment[] = []
  let current: SegmentableMessage[] = []
  let currentChars = 0
  let previousTime = 0

  const flush = (): void => {
    if (current.length > 0) segments.push({ messages: current })
    current = []
    currentChars = 0
  }

  for (const message of messages) {
    if (message.deleted) continue

    const time = parseLooseDateTime(message.sentAt)?.getTime() ?? previousTime
    const gapMinutes = previousTime > 0 ? (time - previousTime) / 60000 : 0

    if (current.length > 0 && gapMinutes > opts.gapMinutes) flush()
    if (current.length > 0 && currentChars + textLength(message) > opts.maxChars) flush()
    if (current.length > 0 && current.length >= opts.maxMessages) flush()

    current.push(message)
    currentChars += textLength(message)
    previousTime = time
  }
  flush()

  return segments
}
