/**
 * 理解层：切窗 → 结构化抽取（模型或规则）→ 写入 im_insight → 更新会话滚动摘要。
 *
 * 三条硬约束：
 * 1. 每条结论必须带消息 id（evidence），没有证据的结论一律丢弃；
 * 2. 模型失败必须降级到规则，不能让整批理解失败；
 * 3. 已经理解过的窗口不重复调模型（按 summarySeq 增量）。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ImExtraction, ImEvidenceItem, ImLinkItem, ImSessionInfo, ImTodoItem, ImUnderstandProvider } from '../../../shared/im'
import { dayOf } from '../../../shared/imTime'
import {
  deleteInsightsForWindow,
  getOrCreateWindow,
  getSession,
  insertInsight,
  listMessagesAfterSeq,
  markWindow,
  updateSessionSummary,
  type ImInsightInput
} from '../../db/dao/imDao'
import { heuristicExtract } from './heuristic'
import { segmentMessages, type MessageSegment, type SegmentableMessage } from './segment'

export type { CompleteFn } from './llm'

export interface UnderstandDeps {
  db: DatabaseSync
  complete?: (system: string, user: string, jsonMode: boolean) => Promise<string>
  log?: (message: string) => void
}

export interface UnderstandOptions {
  provider?: ImUnderstandProvider
  force?: boolean
  maxWindows?: number
}

export interface UnderstandOutcome {
  provider: ImUnderstandProvider
  windows: number
  insights: number
  lastSeq: number
  topics: string[]
}

const SYSTEM_PROMPT = [
  '你是一名严谨的中文聊天记录分析助手。输入是一段群聊或私聊记录，每条消息前有方括号编号，如 [123]。',
  '请抽取对用户有用的信息，只输出一个 JSON 对象，不要输出解释、不要用 markdown 代码块。',
  'JSON 字段：topic(字符串), summary(字符串), decisions[{text,evidence}], todos[{text,due_at,assignee,evidence}],',
  'facts[{text,evidence}], links[{url,title,evidence}], open_questions[{text,evidence}], urgency(low|normal|high), confidence(0~1)。',
  'evidence 只能使用输入中出现过的消息编号，最多 3 个；没有可靠证据就不要输出该条。',
  'due_at 只在原文明确给出日期时填写 YYYY-MM-DD，否则填 null；时间含糊时把原话写进 text。',
  '不要臆测、不要补充聊天里没有的信息；寒暄、表情、重复确认不要生成 todo。',
  'topic 用 4~12 个字概括这段聊天的主题。'
].join('\n')

const SUMMARY_PROMPT = [
  '你是会话摘要维护器。把“已有摘要”和“新增片段摘要”合并成一段不超过 200 字的中文摘要。',
  '保留未完成的事项、已确定的结论和关键时间点；去掉寒暄和重复内容；不要编造。',
  '只输出摘要正文，不要标题、不要解释。'
].join('\n')

function toSegmentable(row: {
  id: number
  seq: number
  sentAt: string
  kind: string
  text: string
  senderName: string
  isSelf: boolean
  deleted: boolean
}): SegmentableMessage {
  return {
    id: row.id,
    seq: row.seq,
    sentAt: row.sentAt,
    kind: row.kind as SegmentableMessage['kind'],
    text: row.text,
    senderName: row.senderName,
    isSelf: row.isSelf,
    deleted: row.deleted
  }
}

function shortTime(value: string): string {
  const match = /(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]} ${match[3]}:${match[4]}` : value
}

function oneLine(text: string, max = 600): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

export function buildWindowPrompt(session: ImSessionInfo, messages: SegmentableMessage[]): string {
  const kindLabel = session.kind === 'group' ? '群聊' : session.kind === 'official' ? '公众号' : '私聊'
  const header = [
    `会话：${session.title}（${kindLabel}）`,
    `消息数：${messages.length}`,
    `时间：${messages[0]?.sentAt ?? ''} ~ ${messages[messages.length - 1]?.sentAt ?? ''}`
  ].join('\n')

  const lines: string[] = []
  let budget = 12_000
  for (const message of messages) {
    const line = `[${message.id}] ${shortTime(message.sentAt)} ${message.isSelf ? '我' : message.senderName || '某人'}：${oneLine(
      message.text
    )}`
    if (budget - line.length < 0) break
    budget -= line.length
    lines.push(line)
  }

  return `${header}\n记录：\n${lines.join('\n')}`
}

interface CoerceContext {
  allowed: Set<number>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return ''
}

function evidenceOf(value: unknown, context: CoerceContext): number[] {
  const ids = asArray(value)
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((id) => Number.isInteger(id) && context.allowed.has(id))
  return [...new Set(ids)].slice(0, 3)
}

function coerceEvidenceItems(value: unknown, context: CoerceContext): ImEvidenceItem[] {
  const items: ImEvidenceItem[] = []
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    const text = pickString(record, ['text', 'title', 'content', 'summary'])
    if (!text) continue
    const evidence = evidenceOf(record.evidence ?? record.evidence_ids ?? record.ids, context)
    if (evidence.length === 0) continue
    items.push({ text: text.slice(0, 300), evidence })
  }
  return items.slice(0, 8)
}

function coerceTodos(value: unknown, context: CoerceContext): ImTodoItem[] {
  const items: ImTodoItem[] = []
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    const text = pickString(record, ['text', 'title', 'content'])
    if (!text) continue
    const evidence = evidenceOf(record.evidence ?? record.evidence_ids ?? record.ids, context)
    if (evidence.length === 0) continue
    items.push({
      text: text.slice(0, 300),
      dueAt: pickString(record, ['due_at', 'dueAt', 'deadline']) || null,
      assignee: pickString(record, ['assignee', 'owner', 'person']) || null,
      evidence
    })
  }
  return items.slice(0, 8)
}

function coerceLinks(value: unknown, context: CoerceContext): ImLinkItem[] {
  const items: ImLinkItem[] = []
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    const url = pickString(record, ['url', 'link'])
    if (!/^https?:\/\//i.test(url)) continue
    items.push({
      url,
      title: pickString(record, ['title', 'name']) || null,
      evidence: evidenceOf(record.evidence ?? record.ids, context)
    })
  }
  return items.slice(0, 8)
}

/** 把模型输出解析成受控的 ImExtraction；证据不在窗口内的条目直接丢弃 */
export function parseExtraction(rawText: string, allowedIds: number[]): ImExtraction {
  const cleaned = rawText
    .replace(/^\uFEFF/, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`模型输出不是 JSON：${cleaned.slice(0, 200)}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error(`模型输出 JSON 解析失败：${cleaned.slice(0, 200)}`)
  }

  const root = asRecord(parsed)
  const context: CoerceContext = { allowed: new Set(allowedIds) }
  const urgencyRaw = pickString(root, ['urgency'])
  const urgency: ImExtraction['urgency'] =
    urgencyRaw === 'low' || urgencyRaw === 'high' ? urgencyRaw : 'normal'
  const confidenceRaw = Number(root.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(Math.max(confidenceRaw, 0), 1) : 0.5
  const summary = pickString(root, ['summary', 'overview'])
  const topic = pickString(root, ['topic', 'title']) || summary.slice(0, 12) || '未命名话题'

  return {
    topic,
    summary,
    decisions: coerceEvidenceItems(root.decisions ?? root.conclusions, context),
    todos: coerceTodos(root.todos ?? root.actions ?? root.tasks, context),
    facts: coerceEvidenceItems(root.facts, context),
    links: coerceLinks(root.links, context),
    questions: coerceEvidenceItems(root.open_questions ?? root.questions, context),
    urgency,
    confidence
  }
}

/** 结构化结果落库，返回写入条数 */
export function persistExtraction(
  db: DatabaseSync,
  sessionId: number,
  windowId: number,
  extraction: ImExtraction,
  segmentIds: number[]
): number {
  let count = 0
  const baseConfidence = extraction.confidence

  const push = (input: ImInsightInput): void => {
    insertInsight(db, sessionId, windowId, input)
    count += 1
  }

  if (extraction.topic || extraction.summary) {
    push({
      kind: 'topic',
      title: extraction.topic,
      detail: extraction.summary,
      confidence: baseConfidence,
      evidence: segmentIds.slice(0, 3)
    })
  }
  for (const item of extraction.decisions) {
    push({ kind: 'decision', title: item.text, detail: '', confidence: baseConfidence, evidence: item.evidence })
  }
  for (const item of extraction.todos) {
    push({
      kind: 'todo',
      title: item.text,
      detail: '',
      dueAt: item.dueAt,
      assignee: item.assignee,
      confidence: baseConfidence,
      evidence: item.evidence
    })
  }
  for (const item of extraction.facts) {
    push({ kind: 'fact', title: item.text, detail: '', confidence: baseConfidence, evidence: item.evidence })
  }
  for (const item of extraction.links) {
    push({
      kind: 'link',
      title: item.title ?? item.url,
      detail: '',
      url: item.url,
      confidence: baseConfidence,
      evidence: item.evidence
    })
  }
  for (const item of extraction.questions) {
    push({ kind: 'question', title: item.text, detail: '', confidence: baseConfidence, evidence: item.evidence })
  }

  return count
}

async function extractWithLlm(
  complete: NonNullable<UnderstandDeps['complete']>,
  session: ImSessionInfo,
  segment: MessageSegment
): Promise<ImExtraction> {
  const raw = await complete(SYSTEM_PROMPT, buildWindowPrompt(session, segment.messages), true)
  return parseExtraction(
    raw,
    segment.messages.map((message) => message.id)
  )
}

async function mergeSummary(
  deps: UnderstandDeps,
  session: ImSessionInfo,
  windowSummaries: string[],
  provider: ImUnderstandProvider
): Promise<string> {
  if (windowSummaries.length === 0) return session.summary
  const fallback = [session.summary, ...windowSummaries.slice(-3)]
    .filter(Boolean)
    .join('；')
    .slice(0, 300)

  if (provider !== 'llm' || !deps.complete) return fallback

  try {
    const raw = await deps.complete(
      SUMMARY_PROMPT,
      `已有摘要：${session.summary || '（无）'}\n新增片段摘要：\n${windowSummaries.join('\n')}`,
      false
    )
    const trimmed = raw.trim().replace(/^["“]|["”]$/g, '')
    return trimmed ? trimmed.slice(0, 400) : fallback
  } catch (error) {
    deps.log?.(`摘要合并失败，保留拼接结果：${error instanceof Error ? error.message : String(error)}`)
    return fallback
  }
}

export async function understandSession(
  deps: UnderstandDeps,
  sessionId: number,
  options: UnderstandOptions = {}
): Promise<UnderstandOutcome> {
  const db = deps.db
  const log = deps.log ?? (() => {})
  const session = getSession(db, sessionId)
  if (!session) throw new Error(`会话不存在：${sessionId}`)

  const provider: ImUnderstandProvider = options.provider ?? (deps.complete ? 'llm' : 'heuristic')
  if (provider === 'llm' && !deps.complete) {
    throw new Error('未配置模型（IM_LLM_API_KEY），请改用 --provider heuristic')
  }

  const afterSeq = options.force ? 0 : session.summarySeq
  const rows = listMessagesAfterSeq(db, sessionId, afterSeq, 5000)
  const segments = segmentMessages(rows.map(toSegmentable))
  const selected = options.maxWindows && options.maxWindows > 0 ? segments.slice(0, options.maxWindows) : segments

  if (selected.length === 0) {
    return { provider, windows: 0, insights: 0, lastSeq: session.summarySeq, topics: [] }
  }

  let insightCount = 0
  const windowSummaries: string[] = []
  let lastSeq = session.summarySeq

  for (const segment of selected) {
    const first = segment.messages[0]
    const last = segment.messages[segment.messages.length - 1]
    if (!first || !last) continue

    const windowId = getOrCreateWindow(db, sessionId, {
      startMsgId: first.id,
      endMsgId: last.id,
      startSeq: first.seq,
      endSeq: last.seq,
      msgCount: segment.messages.length,
      statDate: dayOf(last.sentAt)
    })
    deleteInsightsForWindow(db, windowId)

    let extraction: ImExtraction
    let usedProvider: ImUnderstandProvider = provider
    if (provider === 'llm' && deps.complete) {
      try {
        extraction = await extractWithLlm(deps.complete, session, segment)
      } catch (error) {
        log(`窗口 ${windowId} 模型抽取失败，降级规则：${error instanceof Error ? error.message : String(error)}`)
        extraction = heuristicExtract(segment.messages, { baseDay: dayOf(last.sentAt) })
        usedProvider = 'heuristic'
      }
    } else {
      extraction = heuristicExtract(segment.messages, { baseDay: dayOf(last.sentAt) })
    }

    insightCount += persistExtraction(
      db,
      sessionId,
      windowId,
      extraction,
      segment.messages.map((message) => message.id)
    )
    markWindow(db, windowId, 'done', usedProvider)
    windowSummaries.push(`${extraction.topic}｜${extraction.summary}`.slice(0, 80))
    lastSeq = Math.max(lastSeq, last.seq)
  }

  const merged = await mergeSummary(deps, session, windowSummaries, provider)
  updateSessionSummary(db, sessionId, merged, lastSeq)

  return {
    provider,
    windows: selected.length,
    insights: insightCount,
    lastSeq,
    topics: windowSummaries
  }
}
