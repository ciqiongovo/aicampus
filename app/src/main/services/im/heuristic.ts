/**
 * 规则抽取：不依赖任何模型，负责
 * 1) 离线/无 Key 时兜底，2) 给 LLM 结果做参照，3) 测试里当确定性基准。
 *
 * 它不追求高召回，只抓「决定、待办、链接、待确认」四类高价值信息，
 * 并且每条都带消息 id，保证可回溯。
 */

import type { ImExtraction, ImEvidenceItem, ImLinkItem, ImTodoItem } from '../../../shared/im'
import { addDays, dayOf, formatLocalDate, parseLooseDateTime } from '../../../shared/imTime'
import type { SegmentableMessage } from './segment'

const STOP_WORDS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '什么', '怎么', '然后', '因为', '所以', '但是',
  '如果', '不是', '就是', '还是', '可以', '没有', '已经', '一下', '现在', '今天', '明天', '后天',
  '这样', '那样', '时候', '东西', '知道', '觉得', '感觉', '问题', '事情', '一个', '可能', '应该',
  '大家', '这边', '那边', '他们', '自己', '时候', '一些', '有点', '真的', '直接', '稍微', '比较',
  '负责', '同意', '记得', '不要', '需要', '已经', '应该', '麻烦', '辛苦', '确认', '整理', '提交',
  '跟进', '安排', '准备', '统计', '汇总', '报名', '打印', '提醒', '对接', '消息', '记录', '内容'
])

const DECISION_RE = /(定了|决定|确定|敲定|就按|改成|改到|统一按|结论|最终版|那就按)/
const TODO_RE =
  /(记得|别忘了|麻烦|辛苦|负责|安排|提交|交给|准备|统计|汇总|整理|报名|打印|发我|发一下|发群里|跟进|确认一下|提醒|对接|写一下|补一下|需要|务必|请在)/
const QUESTION_RE = /[?？]\s*$/
const URGENT_RE = /(紧急|马上|立刻|尽快|今晚|今天必须|来不及)/
const URL_RE = /https?:\/\/[^\s，。；；、）)"'<>]+/g
const GREETING_RE = /^(早[啊呀]?|早安|早上好|上午好|下午好|晚上好|大家好|在吗|在不在|哈喽|hello|hi|收到|好的)[，,。.!！~\s]*/i

export interface HeuristicOptions {
  /** 计算“周四/明天”等相对时间的基准日，默认取最后一条消息的日期 */
  baseDay?: string
  maxItems?: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 从文本里识别日期表达式；识别不出返回 null */
export function resolveDueDate(text: string, baseDay: string): string | null {
  const base = parseLooseDateTime(`${baseDay} 00:00:00`)
  if (!base) return null

  const full = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/.exec(text)
  if (full) return `${full[1]}-${pad(Number(full[2]))}-${pad(Number(full[3]))}`

  const monthDay = /(\d{1,2})月(\d{1,2})[日号]/.exec(text)
  if (monthDay) return `${base.getFullYear()}-${pad(Number(monthDay[1]))}-${pad(Number(monthDay[2]))}`

  const shortDate = /(?<!\d)(\d{1,2})[-/](\d{1,2})(?!\d)/.exec(text)
  if (shortDate) return `${base.getFullYear()}-${pad(Number(shortDate[1]))}-${pad(Number(shortDate[2]))}`

  if (/今天|今晚|今早/.test(text)) return baseDay
  if (/明天|明早|明晚/.test(text)) return addDays(baseDay, 1)
  if (/后天/.test(text)) return addDays(baseDay, 2)

  const weekday = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(text)
  if (weekday) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
    const target = map[weekday[1]]
    const current = base.getDay() === 0 ? 7 : base.getDay()
    return addDays(baseDay, (target - current + 7) % 7)
  }

  return null
}

/** 中文关键词：取重复出现的 2~3 字片段 */
function topKeywords(messages: SegmentableMessage[]): string[] {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const cleaned = message.text
      .replace(URL_RE, ' ')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ')
      .trim()
    if (!cleaned) continue
    for (const chunk of cleaned.split(/\s+/)) {
      if (chunk.length < 2) continue
      if (!/[\u4e00-\u9fa5]/.test(chunk)) {
        if (chunk.length >= 2) counts.set(chunk, (counts.get(chunk) ?? 0) + 1)
        continue
      }
      for (let size = 3; size >= 2; size--) {
        for (let i = 0; i + size <= chunk.length; i++) {
          const piece = chunk.slice(i, i + size)
          if (!/^[\u4e00-\u9fa5]+$/.test(piece)) continue
          if (STOP_WORDS.has(piece)) continue
          counts.set(piece, (counts.get(piece) ?? 0) + 1)
        }
      }
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
    .map(([word]) => word)

  // n-gram 会同时产出「进日报」「日报」「进日」，只保留覆盖它们的那个长词
  const picked: string[] = []
  for (const word of ranked) {
    if (picked.some((item) => item.includes(word) || word.includes(item))) continue
    picked.push(word)
    if (picked.length >= 3) break
  }
  return picked
}

function clip(text: string, max = 80): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function extractAssignee(text: string): string | null {
  const at = /@([^\s，,。；;:：]{1,12})/.exec(text)
  if (at) return at[1]
  const polite = /(?:麻烦|请|辛苦)([^\s，,。；;:：]{2,4})(?:帮忙|帮|把|整理|发|确认|统计|准备)/.exec(text)
  return polite ? polite[1] : null
}

export function heuristicExtract(messages: SegmentableMessage[], options: HeuristicOptions = {}): ImExtraction {
  const usable = messages.filter((message) => !message.deleted && message.text.trim())
  const maxItems = options.maxItems ?? 5
  const baseDay = options.baseDay ?? dayOf(usable[usable.length - 1]?.sentAt) ?? formatLocalDate(new Date())

  const decisions: ImEvidenceItem[] = []
  const todos: ImTodoItem[] = []
  const facts: ImEvidenceItem[] = []
  const questions: ImEvidenceItem[] = []
  const links: ImLinkItem[] = []

  const seen = new Set<string>()
  const capturedIds = new Set<number>()

  for (const message of usable) {
    const text = message.text.trim()

    for (const match of text.matchAll(URL_RE)) {
      const url = match[0]
      if (links.some((item) => item.url === url)) continue
      links.push({ url, title: clip(text.replace(url, '').trim() || url, 40), evidence: [message.id] })
      capturedIds.add(message.id)
    }

    if (QUESTION_RE.test(text) || /(吗|呢)[。！!]?\s*$/.test(text)) {
      const key = `q:${text}`
      if (!seen.has(key) && questions.length < maxItems) {
        seen.add(key)
        questions.push({ text: clip(text), evidence: [message.id] })
        capturedIds.add(message.id)
      }
      continue
    }

    if (DECISION_RE.test(text)) {
      const key = `d:${text}`
      if (!seen.has(key) && decisions.length < maxItems) {
        seen.add(key)
        decisions.push({ text: clip(text), evidence: [message.id] })
        capturedIds.add(message.id)
      }
    }

    if (TODO_RE.test(text)) {
      const key = `t:${text}`
      if (!seen.has(key) && todos.length < maxItems) {
        seen.add(key)
        todos.push({
          text: clip(text),
          dueAt: resolveDueDate(text, baseDay),
          assignee: extractAssignee(text),
          evidence: [message.id]
        })
        capturedIds.add(message.id)
      }
    }

    // 带明确数字的陈述当事实（金额、人数、份数、时间点）
    if (/(\d+\s*(份|人|个|元|块|分钟|小时|点|页))/.test(text) && !DECISION_RE.test(text) && !TODO_RE.test(text)) {
      const key = `f:${text}`
      if (!seen.has(key) && facts.length < maxItems) {
        seen.add(key)
        facts.push({ text: clip(text), evidence: [message.id] })
        capturedIds.add(message.id)
      }
    }
  }

  const keywords = topKeywords(usable)
  // 关键词不够时，用最长的一条有信息量消息当主题；先剥掉寒暄
  const topicSource = usable
    .filter((message) => !capturedIds.has(message.id))
    .map((message) => message.text.replace(URL_RE, ' ').replace(GREETING_RE, '').trim())
    .filter((text) => text.length >= 6 && !text.startsWith('['))
    .sort((a, b) => b.length - a.length)[0]
  const topic = keywords.length > 0 ? keywords.join('、') : clip(topicSource ?? '聊天记录', 24)
  const summarySource = decisions[0]?.text ?? todos[0]?.text ?? usable.find((m) => m.text.length > 8)?.text ?? ''
  const urgency: ImExtraction['urgency'] = URGENT_RE.test(usable.map((m) => m.text).join('\n')) ? 'high' : 'normal'

  return {
    topic,
    summary: clip(summarySource, 120),
    decisions,
    todos,
    facts,
    links,
    questions,
    urgency,
    confidence: 0.42
  }
}
