/** AI 结构化输出的规范化与宽松校验（不引入 zod，手写轻量校验器） */
import { ANALYSIS_CATEGORIES } from '../../../shared/types'
import type { AnalysisCategory } from '../../../shared/types'
import { MAIL_PARENT_LABELS } from '../../../shared/mailTags'

export { ANALYSIS_CATEGORIES }

/** 入库前的规范化分析结果（evidence_json 已序列化） */
export interface AnalysisResult {
  category: AnalysisCategory
  summary: string
  actionRequired: string | null
  deadlineRaw: string | null
  deadlineAt: string | null
  deadlineKind: string | null
  eventStartAt: string | null
  applicableTo: string | null
  confidence: number | null
  /** P2 半自动分级：'archive'=高置信低风险（自动归档为资料）；'review'=其余（进待核实）；null=模型未给出（走旧规则） */
  tier: 'archive' | 'review' | null
  evidenceJson: string
  parentLabels: string[]
  subLabels: string[]
  /** null 表示未提供/格式非法，不能当空匹配覆盖。 */
  customTagIds: number[] | null
  /** 每封邮件基于标题、正文和强调片段提出的可反馈关键词，不直接等于长期偏好。 */
  keywords: AnalysisKeyword[]
}

export interface AnalysisKeyword {
  keyword: string
  kind: 'topic' | 'entity' | 'action'
  evidence: string
  confidence: number
}

/** 拒绝链接、地址、日期及超长/空词；模型输出不可信，不让一次性标识进入长期画像。 */
export function normalizeKeywords(raw: unknown): AnalysisKeyword[] {
  if (!Array.isArray(raw)) return []
  const result: AnalysisKeyword[] = []
  const seen = new Set<string>()
  for (const value of raw.slice(0, 24)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const keyword = asString(row.keyword)?.replace(/\s+/g, ' ').slice(0, 24)
    const evidence = asString(row.evidence)?.slice(0, 100)
    const confidence = asNumber(row.confidence)
    if (!keyword || keyword.length < 2 || !evidence || !['topic', 'entity', 'action'].includes(String(row.kind))) continue
    if (/[@<>\\/]|https?:|\d{2,}|[\r\n\u0000-\u001f]/i.test(keyword)) continue
    if (seen.has(keyword.toLowerCase())) continue
    seen.add(keyword.toLowerCase())
    result.push({ keyword, kind: row.kind as AnalysisKeyword['kind'], evidence, confidence: confidence === null ? 0.5 : Math.max(0, Math.min(1, confidence)) })
    if (result.length >= 8) break
  }
  return result
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

const MAX_SUMMARY_LEN = 240
const MAX_TEXT_LEN = 240
const MAX_RAW_LEN = 200
const MAX_EVIDENCE_LEN = 300

/** 日期校验（A4）：可解析且在 1990–2100 年内才入库，其余回退 null，防止非法日期被当成截止时间 */
function asDateIso(v: unknown): string | null {
  const s = asString(v)
  if (!s) return null
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) return null
  const year = new Date(t).getUTCFullYear()
  if (year < 1990 || year > 2100) return null
  return new Date(t).toISOString()
}

/** 自定义标签需显式正整数数组；拒绝字符串ID/非法混合数组，保留已有结果。 */
export function normalizeCustomTagIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length > 100 || raw.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) return null
  return [...new Set(raw as number[])]
}

/** 宽松校验：字段类型不符时回退 null / 默认值，保证管线不因模型输出瑕疵中断 */
export function normalizeAnalysis(raw: unknown): AnalysisResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const category = asString(obj.category)
  const confidenceRaw = asNumber(obj.confidence)
  const confidence = confidenceRaw === null ? null : Math.min(1, Math.max(0, confidenceRaw))
  // 证据校验（A4）：仅字符串、去空、逐条限长、最多 3 条
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x !== '')
        .slice(0, 3)
        .map((x) => x.slice(0, MAX_EVIDENCE_LEN))
    : []
  return {
    category: category !== null && (ANALYSIS_CATEGORIES as readonly string[]).includes(category)
      ? (category as AnalysisCategory)
      : '不确定',
    summary: (asString(obj.summary) ?? '').slice(0, MAX_SUMMARY_LEN),
    actionRequired: asString(obj.action_required)?.slice(0, MAX_TEXT_LEN) ?? null,
    deadlineRaw: asString(obj.deadline_raw)?.slice(0, MAX_RAW_LEN) ?? null,
    deadlineAt: asDateIso(obj.deadline_at),
    deadlineKind: asString(obj.deadline_kind),
    eventStartAt: asDateIso(obj.event_start_at),
    applicableTo: asString(obj.applicable_to)?.slice(0, 120) ?? null,
    confidence,
    tier: (() => {
      const t = asString(obj.tier)
      return t === 'archive' || t === 'review' ? t : null
    })(),
    evidenceJson: JSON.stringify(evidence),
    customTagIds: normalizeCustomTagIds(obj.custom_tag_ids),
    keywords: normalizeKeywords(obj.keywords),
    parentLabels: Array.isArray(obj.parent_labels) ? [...new Set(obj.parent_labels.filter((x): x is string => typeof x === 'string' && MAIL_PARENT_LABELS.some(item => item.id === x)))].slice(0, 8) : [],
    subLabels: Array.isArray(obj.sub_labels) ? [...new Set(obj.sub_labels.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x.length > 0 && x.length <= 24 && !/[<>\r\n\u0000-\u001f]/.test(x)))].slice(0, 5) : []
  }
}
