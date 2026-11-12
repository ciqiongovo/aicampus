import type { DatabaseSync } from 'node:sqlite'
import { getInboxSource, getPreferenceSignal, insertFeedback, listPreferenceSignals, upsertPreferenceSignal } from '../../db/dao/panelDao'
import type { PreferenceSignalRow, RecommendationDetailRow } from '../../db/dao/panelDao'
import { inferTopic, isPanelTopic, topicName } from '../../../shared/topics'
import type { PanelLearningSignal } from '../../../shared/panel'

/** 反馈学习：采纳/忽略只修正“主题”和“来源”两类偏好，不记录动作，也不记录发件人。
 *  权重每 21 天减半，旧偏好不会永久压住新选择；重复强化才提高置信度。 */

export const SIGNAL_HALF_LIFE_DAYS = 21

export function decayWeight(weight: number, lastReinforcedAt: string, now: Date): number {
  const parsed = Date.parse(lastReinforcedAt.includes('T') ? lastReinforcedAt : lastReinforcedAt.replace(' ', 'T'))
  if (Number.isNaN(parsed)) return weight
  const days = Math.max(0, (now.getTime() - parsed) / 86_400_000)
  return weight * Math.pow(0.5, days / SIGNAL_HALF_LIFE_DAYS)
}

export function confidenceFor(evidenceCount: number): number {
  return Math.min(0.95, 1 - Math.exp(-Math.max(0, evidenceCount) / 4))
}

function sourceLabels(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT key, label FROM inbox_source').all() as unknown as Array<{
    key: string
    label: string
  }>
  return new Map(rows.map((row) => [row.key, row.label]))
}

function signalLabel(dimension: string, key: string, labels: Map<string, string>): string {
  return dimension === 'topic' ? topicName(key) : (labels.get(key) ?? key)
}

function bump(db: DatabaseSync, dimension: 'topic' | 'source', key: string, delta: number, now: Date): void {
  const trimmed = key.trim()
  if (!trimmed) return
  const existing = getPreferenceSignal(db, dimension, trimmed)
  const decayed = existing ? decayWeight(existing.weight, existing.last_reinforced_at, now) : 0
  const evidence = (existing?.evidence_count ?? 0) + 1
  upsertPreferenceSignal(db, {
    dimension,
    key: trimmed,
    weight: Math.max(-3, Math.min(3, decayed + delta)),
    confidence: confidenceFor(evidence),
    evidenceCount: evidence
  })
}

export interface FeedbackResult {
  outcome: 'accepted' | 'corrected'
  learned: PanelLearningSignal[]
}

/** 记录一次反馈并更新画像。accepted=照推荐做；corrected=改选其他动作。
 *  主题偏好来自“这条信息属于什么”，与用户最终点了哪个动作无关，因此动作修正不会污染主题。 */
export function applyFeedback(
  db: DatabaseSync,
  recommendation: RecommendationDetailRow,
  chosenAction: string,
  now = new Date()
): FeedbackResult {
  const accepted = chosenAction === recommendation.recommended_action
  const outcome: FeedbackResult['outcome'] = accepted ? 'accepted' : 'corrected'
  // 归档是中性的整理，不代表“不关心”，仍留反馈事件但不强化或削弱画像。
  const sentiment = chosenAction === 'archive' ? 0 : chosenAction === 'ignore' ? -1 : 1

  insertFeedback(db, {
    recommendation_id: recommendation.id,
    info_id: recommendation.info_id,
    source_key: recommendation.source_key,
    recommended_action: recommendation.recommended_action,
    chosen_action: chosenAction,
    outcome,
    reason: recommendation.reason
  })

  // 八类主题/来源偏好只属于邮箱来源；其他来源的取舍写进 source_preference，
  // 由 generalPreference.applyGeneralFeedback 处理，不回写这张表。
  if (recommendation.source_kind === 'email') {
    const topic = isPanelTopic(recommendation.topic) && recommendation.topic !== 'uncategorized'
      ? recommendation.topic
      : inferTopic(`${recommendation.title} ${recommendation.summary}`)
    if (sentiment !== 0 && topic !== 'uncategorized') bump(db, 'topic', topic, sentiment * 0.16, now)
    if (sentiment !== 0 && recommendation.source_key) bump(db, 'source', recommendation.source_key, sentiment * 0.08, now)
  }

  const learned = listLearningSignals(db, 8)
    .filter((row) => row.evidenceCount > 0 && Math.abs(row.weight) >= 0.05)
    .slice(0, 4)
  return { outcome, learned }
}

function toSignal(row: PreferenceSignalRow, labels: Map<string, string>): PanelLearningSignal {
  return {
    dimension: row.dimension as PanelLearningSignal['dimension'],
    key: row.key,
    label: signalLabel(row.dimension, row.key, labels),
    weight: Math.round(row.weight * 1000) / 1000,
    evidenceCount: row.evidence_count
  }
}

/** 给推荐提示词/UI 的画像摘要：只取绝对值最大的几条，正负分开表述 */
export function listLearningSignals(db: DatabaseSync, limit = 6): PanelLearningSignal[] {
  const labels = sourceLabels(db)
  return listPreferenceSignals(db, limit)
    .filter((row) => ['topic', 'source'].includes(row.dimension) && Math.abs(row.weight) >= 0.05)
    // 升级前非邮件来源可能留下过来源信号；它们不属于关心雷达，读的时候一并排除。
    .filter((row) => row.dimension !== 'source' || getInboxSource(db, row.key)?.kind === 'email')
    .map((row) => toSignal(row, labels))
}

export function profileSummary(db: DatabaseSync, limit = 6): string {
  const rows = listLearningSignals(db, limit)
  if (rows.length === 0) return '暂无历史取舍，按通用重要性判断。'
  return rows
    .map(
      (row) =>
        `${row.dimension === 'topic' ? '主题' : '来源'}「${row.label}」${row.weight >= 0 ? '偏好' : '回避'}（${row.weight >= 0 ? '+' : ''}${row.weight.toFixed(2)}）`
    )
    .join('；')
}
