import type { DatabaseSync } from 'node:sqlite'
import {
  getSourcePreference,
  listSourcePreferences,
  pruneSourcePreferences,
  upsertSourcePreference
} from '../../db/dao/panelDao'
import type { RecommendationDetailRow } from '../../db/dao/panelDao'
import { confidenceFor, decayWeight } from './learning'

/** 非邮件来源的偏好记录：按来源各自一份，与“关心雷达”的八类主题权重完全分开。
 *  只用于面板内部的排序，不进入 overview、不在界面展示，也不参与邮件推荐。
 *  记录两件事：这个来源整体值不值得看（source），以及标题里哪些词更容易被保留（keyword）。 */

export const GENERAL_KEYWORD_LIMIT = 200
const MAX_KEYWORDS_PER_ITEM = 8
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g
const LATIN_WORD = /[a-z0-9][a-z0-9+#._-]*/gi
const STOPWORDS = new Set([
  '我们', '你们', '他们', '以及', '可以', '已经', '这个', '那个', '但是', '因为', '所以',
  '如果', '就是', '没有', '进行', '相关', '一个', '以上', 'the', 'and', 'for', 'with', 'from', 'this', 'that'
])

/** 中文没有分词器，用二元组近似关键词；拉丁词直接取。只取标题，避免正文噪声。 */
export function keywordsOf(text: string): string[] {
  const picked = new Set<string>()
  const result: string[] = []
  const push = (token: string): void => {
    if (!token || picked.has(token) || result.length >= MAX_KEYWORDS_PER_ITEM) return
    picked.add(token)
    result.push(token)
  }
  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0].toLowerCase()
    if (word.length >= 2 && !STOPWORDS.has(word)) push(word)
  }
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0].slice(0, 24)
    if (run.length <= 3) {
      if (!STOPWORDS.has(run)) push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length && result.length < MAX_KEYWORDS_PER_ITEM; i++) {
      const gram = run.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) push(gram)
    }
  }
  return result
}

export interface GeneralPreference {
  /** 来源整体权重（正的更常被保留，负的更常被忽略） */
  source: number
  keywords: Map<string, number>
}

export type GeneralPreferenceIndex = Map<string, GeneralPreference>

/** 一次性读出本批涉及的来源偏好；没记录过的来源给空快照（不影响评分）。 */
export function loadGeneralPreferences(db: DatabaseSync, sourceKeys: string[]): GeneralPreferenceIndex {
  const index: GeneralPreferenceIndex = new Map()
  for (const key of sourceKeys) {
    const preference: GeneralPreference = { source: 0, keywords: new Map() }
    for (const row of listSourcePreferences(db, key)) {
      if (row.dimension === 'source') preference.source = row.weight
      else if (row.dimension === 'keyword') preference.keywords.set(row.key, row.weight)
    }
    index.set(key, preference)
  }
  return index
}

/** 非邮件候选的偏好加分：来源权重 ×8，命中关键词权重合计 ×6（封顶，避免少数词独占排序）。 */
export function generalBoost(sourceKey: string, text: string, index?: GeneralPreferenceIndex): number {
  const preference = index?.get(sourceKey)
  if (!preference) return 0
  let boost = preference.source * 8
  if (preference.keywords.size === 0) return boost
  let keywordWeight = 0
  for (const keyword of keywordsOf(text)) keywordWeight += preference.keywords.get(keyword) ?? 0
  boost += Math.max(-18, Math.min(18, keywordWeight * 6))
  return boost
}

function bump(
  db: DatabaseSync,
  sourceKey: string,
  dimension: 'source' | 'keyword',
  key: string,
  delta: number,
  now: Date
): void {
  const trimmed = key.trim()
  if (!trimmed) return
  const existing = getSourcePreference(db, sourceKey, dimension, trimmed)
  const decayed = existing ? decayWeight(existing.weight, existing.last_reinforced_at, now) : 0
  const evidence = (existing?.evidence_count ?? 0) + 1
  upsertSourcePreference(db, {
    sourceKey,
    dimension,
    key: trimmed,
    weight: Math.max(-3, Math.min(3, decayed + delta)),
    confidence: confidenceFor(evidence),
    evidenceCount: evidence
  })
}

/** 记录一次非邮件反馈。sentiment: 保留=1、忽略=-1、归档=0（中性，不学）。 */
export function applyGeneralFeedback(
  db: DatabaseSync,
  recommendation: RecommendationDetailRow,
  sentiment: number,
  now = new Date()
): void {
  if (sentiment === 0) return
  const sourceKey = recommendation.source_key
  if (!sourceKey) return
  bump(db, sourceKey, 'source', sourceKey, sentiment * 0.08, now)
  for (const keyword of keywordsOf(`${recommendation.title} ${recommendation.summary ?? ''}`)) {
    bump(db, sourceKey, 'keyword', keyword, sentiment * 0.06, now)
  }
  pruneSourcePreferences(db, sourceKey, GENERAL_KEYWORD_LIMIT)
}
