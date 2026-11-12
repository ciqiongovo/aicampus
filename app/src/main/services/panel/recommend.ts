import type { AiConfigInput } from '../../../shared/types'
import { PANEL_ACTIONS, PANEL_ACTION_KEYS, isPanelAction } from '../../../shared/panel'
import type { PanelActionKey, PanelLearningSignal } from '../../../shared/panel'
import { PANEL_TOPICS, inferTopic, isPanelTopic, topicName } from '../../../shared/topics'
import { chatCompletion } from '../ai/analyzer'
import type { PanelCandidateRow } from '../../db/dao/panelDao'
import { generalBoost } from './generalPreference'
import type { GeneralPreferenceIndex } from './generalPreference'

/** 推荐引擎：先做可解释的本地评分/动作，再让 AI 在候选范围内改写动作与理由。
 *  AI 失败/未配置时保留本地结果，页面永远可用；AI 不能新增候选，也不能发明动作。
 *  偏好只使用“主题/来源”两维，不读取动作习惯或发件人。 */

export interface CandidateRecommendation {
  infoId: number
  action: PanelActionKey
  reason: string
  confidence: number
  score: number
  priority: 'focus' | 'other'
}

interface SignalIndex {
  topic: Map<string, number>
  source: Map<string, number>
}

/** 关心雷达：八类主题的 0–10 权重，与邮件页的偏好是同一份数据。只作用于邮件来源。 */
export type ConcernWeights = Record<string, number>

/** 只有邮箱来源参与八类主题与关心雷达；其他来源用 generalPreference 的独立偏好。 */
function isMailCandidate(candidate: PanelCandidateRow): boolean {
  return candidate.source_kind === 'email'
}

function concernBoost(topic: string, concerns?: ConcernWeights): number {
  const value = concerns?.[topic]
  return typeof value === 'number' && Number.isFinite(value) ? (value - 5) * 3 : 0
}

function buildIndex(signals: PanelLearningSignal[]): SignalIndex {
  const index: SignalIndex = { topic: new Map(), source: new Map() }
  for (const signal of signals) {
    if (signal.dimension === 'topic' || signal.dimension === 'source') {
      index[signal.dimension].set(signal.key, signal.weight)
    }
  }
  return index
}

function candidateTopic(candidate: PanelCandidateRow): string {
  return inferTopic(`${candidate.title} ${candidate.analysis_summary ?? candidate.content ?? ''}`)
}

function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (t - now.getTime()) / 86_400_000
}

function fmtWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function scoreCandidate(
  candidate: PanelCandidateRow,
  signals: SignalIndex,
  now: Date,
  concerns?: ConcernWeights,
  general?: GeneralPreferenceIndex,
  keywordScore = 0
): number {
  let score = 10
  const created = Date.parse(
    (candidate.date_utc ?? candidate.created_at).includes('T')
      ? (candidate.date_utc ?? candidate.created_at)
      : (candidate.date_utc ?? candidate.created_at).replace(' ', 'T')
  )
  if (!Number.isNaN(created)) {
    const ageDays = Math.max(0, (now.getTime() - created) / 86_400_000)
    score += Math.max(0, 14 - ageDays) * 1.1
  }
  for (const iso of [candidate.deadline_at, candidate.event_start_at]) {
    const days = daysUntil(iso, now)
    if (days === null) continue
    // 过期不再加最高分，否则积压旧活动会永远挤掉新邮件。
    if (days < 0) score -= 8
    else if (days < 1) score += 32
    else if (days <= 3) score += 25
    else if (days <= 7) score += 14
    else if (days <= 14) score += 6
  }
  if (candidate.action_required) score += 16
  if (isMailCandidate(candidate)) {
    const topic = candidateTopic(candidate)
    score += (signals.topic.get(topic) ?? 0) * 14
    score += concernBoost(topic, concerns)
    score += (signals.source.get(candidate.source_type) ?? 0) * 8
    score += keywordScore
  } else {
    // 非邮件来源不读八类主题信号，也不读雷达；只用该来源自己的偏好。
    score += generalBoost(
      candidate.source_type,
      `${candidate.title} ${candidate.analysis_summary ?? candidate.content ?? ''}`,
      general
    )
  }
  if (candidate.tier === 'review') score += 4
  if (candidate.tier === 'archive') score -= 8
  if ((candidate.analysis_summary ?? candidate.content).length > 60) score += 3
  return Math.round(score * 10) / 10
}

/** 内容决定可选动作；不再用“用户过去点过什么动作”改选。 */
export function heuristicAction(candidate: PanelCandidateRow, score = 25, now = new Date()): PanelActionKey {
  const event = daysUntil(candidate.event_start_at, now)
  const deadline = daysUntil(candidate.deadline_at, now)
  if (event !== null && event >= 0) return 'schedule'
  if (deadline !== null && deadline >= 0) return 'todo'
  if (event !== null || deadline !== null) return 'archive'
  if (candidate.action_required?.trim()) return 'todo'
  // 同一套时效/主题/来源/雷达分数决定低价值信息的默认操作。
  if (score < 8) return 'ignore'
  if (score < 24 || candidate.tier === 'archive') return 'archive'
  return 'material'
}

export function heuristicReason(
  candidate: PanelCandidateRow,
  signals: SignalIndex,
  now: Date,
  concerns?: ConcernWeights,
  general?: GeneralPreferenceIndex
): string {
  const deadlineDays = daysUntil(candidate.deadline_at, now)
  const eventDays = daysUntil(candidate.event_start_at, now)
  if (deadlineDays !== null && deadlineDays < 0 && !(eventDays !== null && eventDays >= 0)) return '截止时间已过，建议归档保留原件'
  if (deadlineDays !== null && deadlineDays >= 0 && deadlineDays < 1) return '今天截止，适合直接排进日程或待办'
  if (deadlineDays !== null && deadlineDays >= 0 && deadlineDays <= 3) return `3 天内截止（${fmtWhen(candidate.deadline_at)}），不宜再压后`
  if (eventDays !== null && eventDays < 0) return `日程时间是 ${fmtWhen(candidate.event_start_at)}，已经过期`
  if (eventDays !== null && eventDays <= 3) return `日程在 ${fmtWhen(candidate.event_start_at)}，需要提前准备`
  if (candidate.action_required) return `明确需要你处理：${candidate.action_required.slice(0, 36)}`
  if (!isMailCandidate(candidate)) {
    const preference = general?.get(candidate.source_type)
    if (preference && preference.source > 0.25) return '你过去更常保留这个来源的内容'
    if (preference && preference.source < -0.25) return '这个来源你过去更常忽略，先确认是否值得看'
    return '来自其他信息源的新内容，信息较完整，可判断是否值得留存'
  }
  const topic = candidateTopic(candidate)
  const concern = concerns?.[topic]
  if (typeof concern === 'number' && concern >= 7) return `你的关心雷达把「${topicName(topic)}」设为高关心`
  if (typeof concern === 'number' && concern <= 3) return `你的关心雷达对「${topicName(topic)}」关注较低，先确认是否值得看`
  const topicWeight = signals.topic.get(topic) ?? 0
  if (topicWeight > 0.25) return `你过去更常保留「${topicName(topic)}」类信息`
  if (topicWeight < -0.25) return `这类「${topicName(topic)}」你过去更常忽略，先确认是否值得看`
  const label = isPanelTopic(topic) ? topicName(topic) : '其他'
  return `属于「${label}」，信息较完整，可判断是否值得留存`
}

export function heuristicRecommendation(
  candidate: PanelCandidateRow,
  signals: PanelLearningSignal[],
  now: Date,
  concerns?: ConcernWeights,
  general?: GeneralPreferenceIndex,
  keywordScore = 0
): CandidateRecommendation {
  const index = buildIndex(signals)
  const score = scoreCandidate(candidate, index, now, concerns, general, keywordScore)
  const action = heuristicAction(candidate, score, now)
  const priority = action === 'archive' || action === 'ignore'
    ? 'other'
    : action === 'todo' || action === 'schedule' || score >= 38 || candidate.tier === 'review' ? 'focus' : 'other'
  const confidence = Math.max(0.45, Math.min(0.95, 0.45 + score / 140))
  return {
    infoId: candidate.id,
    action,
    reason: heuristicReason(candidate, index, now, concerns, general),
    confidence: Math.round(confidence * 100) / 100,
    score,
    priority
  }
}

const SYSTEM_PROMPT = `你是 InfoAgent 的个性化信息推荐器。你要从候选信息里判断“现在值不值得用户处理”，并只推荐一个动作。
动作目录（只能选这些）：
${PANEL_ACTIONS.map((a) => `- ${a.key}：${a.label}。${a.hint}`).join('\n')}
主题目录（只能使用这些）：
${PANEL_TOPICS.map((t) => `- ${t.name}`).join('\n')}
判断原则：
1. 具体会议/活动时间 → schedule；有截止时间或需要用户动手但没有具体活动时间 → todo。
2. 有长期参考价值、以后可能回查 → material；已阅通知、过期活动或无需行动但应保留原件 → archive（中性整理）；明确低价值广告或无关内容 → ignore（负向偏好）。
3. 优先处理时间敏感、发件人可信、与用户历史偏好主题一致的信息；不要因为“看起来重要”就全部推荐待办。
4. 关心雷达是用户亲自设置的八类主题 0–10 权重，只用于邮件来源：高权重主题优先，低权重主题只有时效性很强时才推荐。非邮件来源没有主题分类，按内容本身与时效判断，不要套用邮件主题。
5. 先读 body 原文，再结合 summary、截止时间与发件人判断；body 只是节选，不要臆造缺失信息。
6. 每条判断 priority：focus（重点邮件）= 用户需要处理、未来有效且时间敏感、或和高关心主题高度相关；other（其他邮件）= 普通通知、低相关、广告、过期且无需行动。不要求用户清空其他邮件。不要全部标成重点。
7. localScore 已包含时效、邮件来源的主题偏好×14、来源偏好×8、雷达(权重−5)×3，以及仅针对本邮件实际出现过的画像关键词匹配分（单封封顶±12）；非邮件来源保留各自独立偏好。关键词的正负权重随时间衰减，重复正向反馈延长半衰期；不能凭画像关键词忽略明确的截止或行动要求。过期信息不能仅因有旧日期而标成重点。
8. reason 必须具体，引用标题/截止/发件人/主题，不超过 45 个汉字，同时简述为什么属于该组。
只输出 JSON：{"items":[{"id":候选id,"action":"动作key","priority":"focus或other","reason":"推荐理由","confidence":0.0到1.0}]}。不要输出 Markdown。`

function compactCandidate(candidate: PanelCandidateRow): Record<string, unknown> {
  return {
    id: candidate.id,
    source: candidate.source_type,
    title: candidate.title.slice(0, 90),
    summary: (candidate.analysis_summary ?? candidate.content ?? '').slice(0, 220),
    body: (candidate.content ?? '').slice(0, 600),
    // 主题只属于邮箱分类；其他来源不下发主题，避免模型按八类硬套。
    ...(isMailCandidate(candidate) ? { topic: topicName(candidateTopic(candidate)) } : {}),
    from: candidate.from_addr,
    deadline: candidate.deadline_at,
    event: candidate.event_start_at,
    actionRequired: candidate.action_required
  }
}

function parseAiItems(text: string): Map<number, { action: PanelActionKey; priority?: 'focus' | 'other'; reason: string; confidence: number }> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return new Map()
  }
  const items = (parsed as { items?: unknown }).items
  if (!Array.isArray(items)) return new Map()
  const result = new Map<number, { action: PanelActionKey; priority?: 'focus' | 'other'; reason: string; confidence: number }>()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = Number(row.id)
    if (!Number.isInteger(id) || !isPanelAction(row.action)) continue
    const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 80) : ''
    const confidence = Number(row.confidence)
    result.set(id, {
      action: row.action,
      priority: row.priority === 'focus' || row.priority === 'other' ? row.priority : undefined,
      reason,
      confidence: Number.isFinite(confidence) ? Math.max(0.3, Math.min(0.99, confidence)) : 0.7
    })
  }
  return result
}

export interface RecommendResult {
  items: CandidateRecommendation[]
  aiConfigured: boolean
  aiMessage: string
}

/** 一批只调一次模型；任何失败都退回本地推荐，不阻塞面板 */
export async function recommendCandidates(
  candidates: PanelCandidateRow[],
  learning: PanelLearningSignal[],
  profile: string,
  aiConfig: AiConfigInput | null,
  now = new Date(),
  concerns?: ConcernWeights,
  general?: GeneralPreferenceIndex,
  keywordScores?: Map<number, {score: number; matches: string[]}>
): Promise<RecommendResult> {
  const local = candidates.map((candidate) => heuristicRecommendation(candidate, learning, now, concerns, general, isMailCandidate(candidate) ? keywordScores?.get(candidate.source_email_id ?? -1)?.score ?? 0 : 0))
  if (!aiConfig || candidates.length === 0) {
    return {
      items: local,
      aiConfigured: false,
      aiMessage: aiConfig ? '' : '未配置可用的 AI 连接，本次用本地规则推荐'
    }
  }
  try {
    const user = JSON.stringify({
      profile,
      concerns: concerns
        ? Object.fromEntries(
            PANEL_TOPICS.filter((topic) => topic.id !== 'uncategorized').map((topic) => [
              topic.name,
              concerns[topic.id] ?? 5
            ])
          )
        : undefined,
      candidates: candidates.map((candidate, index) => ({
        ...compactCandidate(candidate),
        ...(isMailCandidate(candidate) ? { matchedKeywords: keywordScores?.get(candidate.source_email_id ?? -1)?.matches ?? [] } : {}),
        localScore: local[index].score, localPriority: local[index].priority
      }))
    })
    const text = await chatCompletion(aiConfig, SYSTEM_PROMPT, user, true)
    const aiItems = parseAiItems(text)
    if (!local.some((item) => aiItems.has(item.infoId))) throw new Error('模型未返回有效的推荐条目')
    const merged = local.map((item) => {
      const ai = aiItems.get(item.infoId)
      if (!ai) return item
      return {
        ...item,
        action: ai.action,
        priority: ai.priority ?? item.priority,
        reason: ai.reason || item.reason,
        confidence: ai.confidence,
        score: Math.round((item.score + (ai.action === item.action ? 4 : 0)) * 10) / 10
      }
    })
    return { items: merged, aiConfigured: true, aiMessage: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[panel] AI 推荐失败，回退本地规则：', message)
    return {
      items: local,
      aiConfigured: false,
      aiMessage: 'AI 暂时不可用，已回退本地规则：' + message.slice(0, 120)
    }
  }
}

export { PANEL_ACTION_KEYS }
