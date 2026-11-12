import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getByEmailId, getEmailListItem, listEmailRowsForTagging, searchEmails } from '../db'
import type { EmailListRow } from '../db/dao/emailsDao'
import { classifyTopics, MAIL_PARENT_LABELS } from '../../shared/mailTags'
import { FEEDBACK_BASE } from '../../shared/panel'
import type { MailTagFeedbackPatch, MailTagRecord, MailTagsQuery, MailTagsResult, MailUrgency, TagPreferences } from '../../shared/mailTags'
import type { MailListItem } from '../../shared/types'
import { radarSensitivityGain } from './feedbackSensitivity'

const IDS: string[] = MAIL_PARENT_LABELS.map(x => x.id)
/** 分类器版本：旧版本生成的 fallback/analysis 标签会在首次读取时批量重算。 */
const CURRENT_CLASSIFIER_VERSION = 4
interface StoredTag { emailId: number; accountId: number; folder: string; uid: number; messageId: string; parentLabels: string[]; subLabels: string[]; deadlineAt: string | null; source: 'fallback' | 'analysis' | 'feedback'; classifier: number; interestOffset: number; interestOverride?: number; urgencyOverride?: MailUrgency; updatedAt: string }
interface TagFile { version: 2; preferenceRevision?: number; preferences: TagPreferences; tags: Record<string, StoredTag> }
interface PreferenceFile { version: 1; revision: number; preferences: TagPreferences }
const defaultWeights = (): Record<string, number> => Object.fromEntries(IDS.map(id => [id, 5]))
const emptyFile = (): TagFile => ({ version: 2, preferences: { parentWeights: defaultWeights(), updatedAt: null }, tags: {} })
const clamp = (n: number): number => Math.max(0, Math.min(10, n))
const urgencyOf = (deadline: string | null, now: number): MailUrgency => {
  if (!deadline || !Number.isFinite(Date.parse(deadline))) return 'after_7d'
  const remaining = Date.parse(deadline) - now
  if (remaining <= 86_400_000) return 'within_1d'
  if (remaining <= 259_200_000) return 'within_3d'
  if (remaining <= 604_800_000) return 'within_7d'
  return 'after_7d'
}
const tierOf = (n: number): 1 | 2 | 3 | 4 => n >= 8 ? 1 : n >= 5 ? 2 : n > 2 ? 3 : 4
const cleanSubs = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('子标签必须是数组')
  if (value.length < 2 || value.length > 5) throw new Error('子标签须为 2–5 个')
  const labels = value.map(x => {
    if (typeof x !== 'string') throw new Error('子标签须为短文本')
    const s = x.trim()
    if (!s || s.length > 24 || /[<>\r\n\u0000-\u001f]/.test(s)) throw new Error('子标签不合法')
    return s
  })
  if (new Set(labels).size !== labels.length) throw new Error('子标签不能重复')
  return labels
}
const cleanParents = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > IDS.length || value.some(x => typeof x !== 'string' || !IDS.includes(x))) throw new Error('母标签不合法')
  return [...new Set(value as string[])]
}
const weightsOf = (raw: unknown): Record<string, number> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('偏好必须是八维权重对象')
  const obj = raw as Record<string, unknown>
  if (Object.keys(obj).length !== IDS.length || IDS.some(id => !Object.hasOwn(obj, id) || typeof obj[id] !== 'number' || !Number.isFinite(obj[id]) || (obj[id] as number) < 0 || (obj[id] as number) > 10)) throw new Error('八维偏好必须各为 0–10')
  return Object.fromEntries(IDS.map(id => [id, obj[id] as number]))
}
const fallbackTag = (row: EmailListRow): StoredTag => {
  const matched = classifyTopics({ subject: row.subject, body: row.body_text, from: row.from_addr })
  const subs = [...new Set(matched.subs)]
  // 子标签必须是可读的分类词，不能把标题截断塞进来；不足两个时用中性词补齐。
  for (const filler of ['校园通知', '待核实']) {
    if (subs.length >= 2) break
    if (!subs.includes(filler)) subs.push(filler)
  }
  return { emailId: row.id, accountId: row.account_id, folder: row.folder, uid: row.uid, messageId: row.message_id, parentLabels: matched.parents, subLabels: subs.slice(0, 5), deadlineAt: null, source: 'fallback', classifier: CURRENT_CLASSIFIER_VERSION, interestOffset: 0, updatedAt: new Date().toISOString() }
}
function listItem(row: EmailListRow): MailListItem {
  let attachments: unknown = []
  try { attachments = JSON.parse(row.attachments_json || '[]') } catch { /* 旧邮件附件数据错误 */ }
  return { id: row.id, accountId: row.account_id, accountLabel: row.account_label, folder: row.folder, subject: row.subject || '(无主题)', fromAddr: row.from_addr, toAddr: row.to_addr, dateUtc: row.date_utc, unread: row.unread === 1, starred: row.starred === 1, size: row.size, attachmentCount: Array.isArray(attachments) ? attachments.length : 0, category: row.category, analysisStatus: row.analysis_status as MailListItem['analysisStatus'], tags: row.tags ?? [] }
}

/** 历史事项/面板兼容：userData/mail-tags.json，仅分类ID/话题/评分；独立邮件标签不读写此服务。 */
export class MailTagService {
  private file: TagFile | null = null
  private loading: Promise<TagFile> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private backfilled = false
  constructor(private path: string) {}
  private async load(): Promise<TagFile> {
    if (this.file) return this.file
    if (!this.loading) this.loading = this.readFile().finally(() => { this.loading = null })
    return this.loading
  }
  private async readFile(): Promise<TagFile> {
    let data: TagFile
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object') throw new Error('标签文件格式错误')
      data = parsed as TagFile
      if (((data.version as number) !== 1 && (data.version as number) !== 2) || !data.preferences || !data.tags || typeof data.tags !== 'object') throw new Error('标签文件版本或结构错误')
      data.version = 2
      data.preferences.parentWeights = weightsOf(data.preferences.parentWeights)
      if (data.preferenceRevision !== undefined && (!Number.isSafeInteger(data.preferenceRevision) || data.preferenceRevision < 0)) throw new Error('偏好版本错误')
      // v1 标签没有 classifier 字段：视为旧分类器产物，下次读取时按新规则重算（用户反馈保留）。
      for (const tag of Object.values(data.tags)) if (!Number.isInteger(tag.classifier)) tag.classifier = 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      data = emptyFile()
    }
    // 单独的小文件只保存偏好。旧标签文件仍能直接读取；版本较新的一份胜出，
    // 因而标签反馈和纯偏好写入不需要跨两个文件提交，也不会被旧 sidecar 覆盖。
    try {
      const prefs = JSON.parse(await fs.readFile(this.path + '.preferences.json', 'utf8')) as PreferenceFile
      if (!prefs || prefs.version !== 1 || !Number.isSafeInteger(prefs.revision) || prefs.revision < 1 || !prefs.preferences) throw new Error('偏好文件格式错误')
      const parentWeights = weightsOf(prefs.preferences.parentWeights)
      if (prefs.revision > (data.preferenceRevision ?? 0)) {
        data.preferences = { parentWeights, updatedAt: prefs.preferences.updatedAt }
        data.preferenceRevision = prefs.revision
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.file = data
    return data
  }
  private async writeAtomic(path: string, serialized: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), '.mail-tags-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.tmp')
    try { await fs.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600 }); await fs.rename(tmp, path) }
    finally { await fs.unlink(tmp).catch(() => undefined) }
  }
  private transactPreferences<T>(fn: (prefs: TagPreferences) => T): Promise<T> {
    const work = this.queue.then(async () => {
      const current = await this.load()
      const preferences = structuredClone(current.preferences)
      const result = fn(preferences)
      const revision = (current.preferenceRevision ?? 0) + 1
      if (!Number.isSafeInteger(revision)) throw new Error('偏好版本溢出')
      const payload: PreferenceFile = { version: 1, revision, preferences }
      await this.writeAtomic(this.path + '.preferences.json', JSON.stringify(payload))
      this.file = { ...current, preferenceRevision: revision, preferences }
      return result
    })
    this.queue = work.then(() => undefined, () => undefined)
    return work
  }
  private transact<T>(fn: (data: TagFile) => Promise<T> | T): Promise<T> {
    const work = this.queue.then(async () => {
      const current = await this.load()
      const data: TagFile = structuredClone(current)
      const result = await fn(data)
      const changed = JSON.stringify(data.preferences) !== JSON.stringify(current.preferences)
      data.preferenceRevision = (current.preferenceRevision ?? 0) + (changed ? 1 : 0)
      if (!Number.isSafeInteger(data.preferenceRevision)) throw new Error('偏好版本溢出')
      await this.writeAtomic(this.path, JSON.stringify(data))
      this.file = data
      return result
    })
    this.queue = work.then(() => undefined, () => undefined)
    return work
  }
  async preferencesGet(): Promise<TagPreferences> { await this.queue; return structuredClone((await this.load()).preferences) }
  async preferencesSet(weights: Record<string, number>): Promise<TagPreferences> {
    const clean = weightsOf(weights)
    return this.transactPreferences(prefs => { prefs.parentWeights = clean; prefs.updatedAt = new Date().toISOString(); return structuredClone(prefs) })
  }
  private derived(db: DatabaseSync, row: EmailListRow): StoredTag {
    const fallback = fallbackTag(row)
    const analysis = getByEmailId(db, row.id)
    if (analysis?.status === 'analyzed') {
      const matched = classifyTopics({
        subject: `${row.subject || ''} ${analysis.summary || ''}`,
        body: row.body_text,
        from: row.from_addr
      })
      fallback.parentLabels = matched.parents
      fallback.subLabels = [...new Set([...matched.subs, ...fallback.subLabels])].slice(0, 5)
      fallback.deadlineAt = analysis.deadline_at
      fallback.source = 'analysis'
    }
    return fallback
  }
  private record(emailId: number, stored: StoredTag, prefs: TagPreferences, now = Date.now()): MailTagRecord {
    const weights = stored.parentLabels.map(id => prefs.parentWeights[id] ?? 5)
    const base = weights.length ? Math.max(...weights) : 5
    const interest = clamp(stored.interestOverride ?? base + stored.interestOffset)
    return { emailId, urgency: stored.urgencyOverride ?? urgencyOf(stored.deadlineAt, now), deadlineAt: stored.deadlineAt, parentLabels: [...stored.parentLabels], subLabels: [...stored.subLabels], interest, tier: tierOf(interest), source: stored.source, updatedAt: stored.updatedAt }
  }
  private needsRefresh(tag: StoredTag | undefined, row: EmailListRow): boolean {
    if (!tag) return true
    if (tag.source === 'feedback') {
      // 用户反馈只保护主题与关心度；旧分类器的子标签、空主题都要清洗。
      if (tag.parentLabels.length === 0) return true
      if (tag.classifier < CURRENT_CLASSIFIER_VERSION) return true
      return tag.subLabels.some(s => s.length > 20)
    }
    if (tag.classifier !== CURRENT_CLASSIFIER_VERSION) return true
    return tag.source === 'fallback' && row.analysis_status === 'analyzed'
  }

  private async materialize(db: DatabaseSync, rows: EmailListRow[]): Promise<TagFile> {
    await this.queue
    const current = await this.load()
    const outdated = rows.filter(row => this.needsRefresh(current.tags[row.id], row))
    if (!outdated.length) return current
    await this.transact(data => {
      for (const row of outdated) {
        const existing = data.tags[row.id]
        const next = this.derived(db, row)
        // 反馈里空主题的旧记录：只补主题，保留用户调过的紧急度/关心度与干净短标签。
        if (existing?.source === 'feedback') {
          next.source = 'feedback'
          if (existing.parentLabels.length > 0) next.parentLabels = existing.parentLabels
          next.urgencyOverride = existing.urgencyOverride
          next.interestOverride = existing.interestOverride
          next.interestOffset = existing.interestOffset
          next.updatedAt = existing.updatedAt
        }
        data.tags[row.id] = next
      }
    })
    return this.load()
  }

  /** 首次读取时把旧标签整体重算一次；之后只对新邮件做惰性分类。 */
  private async ensureBackfill(db: DatabaseSync): Promise<void> {
    if (this.backfilled) return
    this.backfilled = true
    const rows = listEmailRowsForTagging(db)
    await this.materialize(db, rows)
  }

  async list(db: DatabaseSync, query: MailTagsQuery = {}): Promise<MailTagsResult> {
    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit!, 1), 200) : 50
    const offset = Number.isInteger(query.offset) ? Math.max(query.offset!, 0) : 0
    const accountId = Number.isSafeInteger(query.accountId) && query.accountId! > 0 ? query.accountId : undefined
    await this.ensureBackfill(db)
    const result = searchEmails(db, { accountId, folder: typeof query.folder === 'string' ? query.folder.slice(0, 200) : undefined, keyword: typeof query.keyword === 'string' ? query.keyword.slice(0, 200) : undefined, limit, offset })
    const now = Date.now()
    const data = await this.materialize(db, result.rows)
    return { total: result.total, items: result.rows.map(row => ({ mail: listItem(row), tag: this.record(row.id, data.tags[row.id] ?? this.derived(db, row), data.preferences, now) })) }
  }
  async get(db: DatabaseSync, emailId: number): Promise<MailTagRecord | null> {
    if (!Number.isSafeInteger(emailId) || emailId < 1) return null
    const row = getEmailListItem(db, emailId)
    if (!row) return null
    const data = await this.materialize(db, [row])
    return this.record(emailId, data.tags[emailId], data.preferences)
  }
  async feedback(db: DatabaseSync, emailId: number, patch: MailTagFeedbackPatch): Promise<MailTagRecord> {
    if (!Number.isSafeInteger(emailId) || emailId < 1) throw new Error('邮件 ID 无效')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['urgency','parentLabels','subLabels','interest','tier','rating'].includes(key))) throw new Error('反馈内容无效')
    const row = getEmailListItem(db, emailId)
    if (!row) throw new Error('邮件不存在')
    return this.transact(data => {
      const original = data.tags[emailId] ?? this.derived(db, row)
      const tag = structuredClone(original)
      if (patch.parentLabels !== undefined) tag.parentLabels = cleanParents(patch.parentLabels)
      if (patch.subLabels !== undefined) tag.subLabels = cleanSubs(patch.subLabels)
      if (patch.urgency !== undefined) {
        if (!['within_1d','within_3d','within_7d','after_7d'].includes(patch.urgency)) throw new Error('紧急度无效')
        tag.urgencyOverride = patch.urgency
      }
      if (patch.interest !== undefined) {
        if (typeof patch.interest !== 'number' || !Number.isFinite(patch.interest) || patch.interest < 0 || patch.interest > 10) throw new Error('关心度须为 0–10')
        tag.interestOverride = patch.interest
      }
      if (patch.tier !== undefined) {
        if (![1,2,3,4].includes(patch.tier)) throw new Error('关心级别无效')
        if (patch.interest !== undefined && tierOf(patch.interest) !== patch.tier) throw new Error('关心度与关心级别冲突')
        if (patch.interest === undefined) tag.interestOverride = ({ 1: 8, 2: 5, 3: 3, 4: 2 } as const)[patch.tier]
      }
      if (patch.rating !== undefined) {
        const delta = { A: 1, B: 0.5, C: -0.5, D: -1 }[patch.rating]
        if (delta === undefined) throw new Error('反馈评级无效')
        if (tag.interestOverride !== undefined) tag.interestOverride = clamp(tag.interestOverride + delta * 2)
        else tag.interestOffset = (tag.interestOffset || 0) + delta * 2
        const weightDelta = delta * FEEDBACK_BASE.radarRating * radarSensitivityGain(db)
        for (const id of tag.parentLabels) data.preferences.parentWeights[id] = clamp(data.preferences.parentWeights[id] + weightDelta)
        data.preferences.updatedAt = new Date().toISOString()
      }
      tag.source = 'feedback'
      tag.updatedAt = new Date().toISOString()
      data.tags[emailId] = tag
      return this.record(emailId, tag, data.preferences)
    })
  }
  /** AI 成功后用已授权分析摘要及既有截止时间，不额外请求模型；不覆盖用户反馈。 */
  async refreshFromAnalysis(db: DatabaseSync, emailId: number): Promise<void> {
    const row = getEmailListItem(db, emailId)
    if (!row) return
    const tag = this.derived(db, row)
    await this.transact(data => { if (data.tags[emailId]?.source !== 'feedback') data.tags[emailId] = tag })
  }
  /** AI 已经通过原有授权门；仅把同一次分析的简短标签持久化，绝不重新调用模型。 */
  async analysis(db: DatabaseSync, emailId: number, parentLabels: string[], subLabels: string[], deadlineAt: string | null): Promise<void> {
    const row = getEmailListItem(db, emailId)
    if (!row) return
    const inferred = classifyTopics({ subject: row.subject, body: row.body_text, from: row.from_addr })
    const parents = [...new Set(parentLabels.filter(id => IDS.includes(id)))]
    const finalParents = parents.length ? parents : inferred.parents
    let subs: string[] = []
    try { subs = cleanSubs(subLabels) } catch { /* 模型标签不完整时用本地分类补齐，避免整封邮件没有标签 */ }
    if (subs.length < 2) {
      const names = finalParents.flatMap(id => {
        const name = MAIL_PARENT_LABELS.find(item => item.id === id)?.name
        return name ? [name] : []
      })
      subs = [...new Set([...subs, ...inferred.subs, ...names, '待核实'])].slice(0, 5)
    }
    await this.transact(data => {
      const previous = data.tags[emailId]
      if (previous?.source === 'feedback') return
      data.tags[emailId] = {
        ...(previous ?? { emailId, accountId: row.account_id, folder: row.folder, uid: row.uid, messageId: row.message_id }),
        parentLabels: finalParents,
        subLabels: subs,
        deadlineAt,
        source: 'analysis',
        classifier: CURRENT_CLASSIFIER_VERSION,
        interestOffset: 0,
        updatedAt: new Date().toISOString()
      }
    })
  }
  /** 面板反馈直接微调八维关心权重；只改权重，不改 updatedAt 之外的任何状态。 */
  async adjustPreference(deltas: Record<string, number>): Promise<void> {
    await this.transactPreferences(prefs => {
      for (const [id, delta] of Object.entries(deltas)) {
        if (!IDS.includes(id) || !Number.isFinite(delta)) continue
        prefs.parentWeights[id] = clamp(prefs.parentWeights[id] + delta)
      }
      prefs.updatedAt = new Date().toISOString()
    })
  }
}
const services = new Map<string, MailTagService>()
export function getMailTagService(userDataPath: string): MailTagService {
  const path = join(userDataPath, 'mail-tags.json')
  let service = services.get(path)
  if (!service) { service = new MailTagService(path); services.set(path, service) }
  return service
}
