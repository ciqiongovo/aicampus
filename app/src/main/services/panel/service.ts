import type { DatabaseSync } from 'node:sqlite'
import type { AiConfigInput } from '../../../shared/types'
import { FEEDBACK_BASE } from '../../../shared/panel'
import type {
  PanelActionKey,
  PanelActResult,
  PanelIngestInput,
  PanelIngestResult,
  PanelOverview,
  PanelOverviewQuery,
  PanelRecommendation,
  PanelSource
} from '../../../shared/panel'
import type { SettingsStore } from '../../store/settings'
import { radarSensitivityGain } from '../feedbackSensitivity'
import { createInfo, routeInfo } from '../../db/dao/infoDao'
import {
  countPanelCandidates,
  countPendingRecommendationsBySource,
  createRecommendationBatch,
  getInboxSource,
  getRecommendationDetail,
  insertRecommendation,
  latestRecommendationBatch,
  listInboxSources,
  listPanelCandidates,
  listPendingRecommendations,
  markRecommendation
} from '../../db/dao/panelDao'
import type { PanelCandidateRow, RecommendationDetailRow, RecommendationRow } from '../../db/dao/panelDao'
import { createItemFromEmail, createItemReminder, createManualItem } from '../items/service'
import { saveMaterial } from '../materials/service'
import { refreshPanelDuplicates } from './content'
import { getMailTagService } from '../mailTags'
import { inferTopic, isPanelTopic, topicName } from '../../../shared/topics'
import { applyFeedback, listLearningSignals, profileSummary } from './learning'
import { applyGeneralFeedback, loadGeneralPreferences } from './generalPreference'
import { recommendCandidates } from './recommend'
import { applyKeywordFeedback, keywordBoosts, listKeywordProfile } from './keywordProfile'
import type { ConcernWeights } from './recommend'

/** 面板服务：读一批候选 → AI/本地评分 → 用户处置 → 记录反馈与画像。
 *  所有写操作在一个 SAVEPOINT 内完成，失败不会出现“推荐已标记但事项没建”的半截状态。 */

const INITIAL_BATCH_SIZE = 20
const CONTINUE_BATCH_SIZE = 10
const INITIAL_WINDOW_DAYS = 14

/** 同一来源的并发读取共用一次执行，避免 StrictMode 双调用或连点刷新重复生成批次/调用模型 */
const overviewInFlight = new WeakMap<DatabaseSync, Map<string, Promise<PanelOverview>>>()
const continueInFlight = new WeakMap<DatabaseSync, Map<string, Promise<PanelOverview>>>()
// 全局来源共用一条生成队列；切来源/刷新/继续并发时不会同时调用模型或交错插入批次。
const generationQueue = new WeakMap<DatabaseSync, Promise<void>>()
async function serializeGeneration<T>(db: DatabaseSync, work: () => Promise<T>): Promise<T> {
  const before = generationQueue.get(db) ?? Promise.resolve()
  const task = before.catch(() => undefined).then(work)
  const settled = task.then(() => undefined, () => undefined)
  generationQueue.set(db, settled)
  try { return await task } finally {
    if (generationQueue.get(db) === settled) generationQueue.delete(db)
  }
}

function inFlightFor(db: DatabaseSync, registry: WeakMap<DatabaseSync, Map<string, Promise<PanelOverview>>>): Map<string, Promise<PanelOverview>> {
  let map = registry.get(db)
  if (!map) { map = new Map(); registry.set(db, map) }
  return map
}

function aiConfig(store: SettingsStore): { cfg: AiConfigInput | null; message: string } {
  const s = store.peek()
  if (!s.aiBaseURL || !s.aiModel) return { cfg: null, message: '未配置模型，本次用本地规则推荐' }
  if (s.aiApiKey === '' && !s.aiIsLocal) return { cfg: null, message: '未填写 API Key，本次用本地规则推荐' }
  if (s.aiAuthorizedFor !== s.aiProvider + '|' + s.aiBaseURL) {
    return { cfg: null, message: '该 AI 端点尚未获数据授权，本次用本地规则推荐；可在设置中确认授权' }
  }
  return {
    cfg: { provider: s.aiProvider, baseURL: s.aiBaseURL, model: s.aiModel, apiKey: s.aiApiKey },
    message: ''
  }
}

/** 读取“我的关心”雷达权重；未传路径（测试/无 Electron）时返回空，不影响推荐。 */
async function loadConcerns(userDataPath?: string): Promise<ConcernWeights | undefined> {
  if (!userDataPath) return undefined
  try {
    return (await getMailTagService(userDataPath).preferencesGet()).parentWeights
  } catch (error) {
    console.warn('[panel] 读取关心雷达失败，按默认权重推荐', error)
    return undefined
  }
}

function toDto(row: RecommendationRow, labels: Map<string, string>): PanelRecommendation {
  // 八类主题只属于邮箱来源；其他来源恒为空，前端不渲染主题标签。
  const sourceKind = row.source_kind ?? ''
  const isMail = sourceKind === 'email'
  // Persisted valid topics (including uncategorized) need no classifier work on reads.
  // Only legacy missing/invalid values use the compatibility fallback.
  const topic = !isMail ? '' : isPanelTopic(row.topic) ? row.topic : inferTopic(`${row.title} ${row.summary ?? ''}`)
  return {
    id: row.id,
    batchId: row.batch_id,
    infoId: row.info_id,
    sourceKey: row.source_key,
    sourceLabel: labels.get(row.source_key) ?? row.source_key,
    sourceKind,
    urgent: Boolean(row.urgent),
    emailId: row.source_email_id ?? null,
    title: row.title,
    excerpt: row.summary,
    reason: row.reason,
    recommendedAction: row.recommended_action as PanelActionKey,
    confidence: row.confidence,
    score: row.score,
    priority: row.urgent ? 'focus' : row.priority ?? (row.score >= 38 || (row.recommended_action === 'todo' || row.recommended_action === 'schedule') ? 'focus' : 'other'),
    receivedAt: row.received_at,
    topic,
    topicLabel: topic ? topicName(topic) : '',
    actionRequired: row.action_required,
    deadlineAt: row.deadline_at,
    eventStartAt: row.event_start_at,
    suggestedAt: row.suggested_at,
    createdAt: row.created_at
  }
}

/** Called inside the post-network savepoint, after refreshing dirty representatives. */
function currentCandidateIds(db: DatabaseSync, candidates: PanelCandidateRow[], legacyOnly = false): Set<number> {
  const current = db.prepare(
    'SELECT i.panel_content_key, i.title, i.source_type, i.source_email_id, i.destination, i.created_at,' +
    ' e.from_addr, e.subject, e.date_utc,' +
    " COALESCE(NULLIF(e.body_text, ''), NULLIF(e.body_html, ''), i.content) AS content," +
    ' s.kind AS source_kind, an.summary AS analysis_summary, an.action_required, an.deadline_at, an.event_start_at, an.tier, an.confidence AS analysis_confidence' +
    ' FROM info i LEFT JOIN inbox_source s ON s.key = i.source_type' +
    ' LEFT JOIN emails e ON e.id = i.source_email_id' +
    ' LEFT JOIN email_analysis an ON an.email_id = i.source_email_id' +
    ' WHERE i.id = ? AND i.panel_duplicate_of IS NULL AND (s.enabled = 1 OR s.id IS NULL)' +
    " AND i.destination NOT IN ('item','archive','keep') AND " +
    (legacyOnly ? "EXISTS (SELECT 1 FROM recommendation r WHERE r.info_id = i.id AND r.status = 'pending' AND r.priority IS NULL)"
      : 'NOT EXISTS (SELECT 1 FROM recommendation r WHERE r.info_id = i.id)')
  )
  return new Set(candidates.filter((candidate) => {
    const row = current.get(candidate.id)
    return row && Object.entries(row).every(([key, value]) => candidate[key as keyof PanelCandidateRow] === value)
  }).map((candidate) => candidate.id))
}

async function createBatch(
  db: DatabaseSync,
  store: SettingsStore,
  mode: 'initial' | 'continue',
  sourceKey?: string,
  userDataPath?: string,
  afterInfoId?: number
): Promise<{ batchId: number | null; aiConfigured: boolean; aiMessage: string }> {
  const limit = mode === 'initial' ? INITIAL_BATCH_SIZE : CONTINUE_BATCH_SIZE
  const windowDays = mode === 'initial' && afterInfoId === undefined ? INITIAL_WINDOW_DAYS : null
  const learning = listLearningSignals(db, 8)
  const now = new Date()
  // 先按到达顺序拿最新 N 条，权重决定重点分组/动作，而不是让旧高分信息遮住新邮件。
  let pool = listPanelCandidates(db, { limit, sourceKey, windowDays, afterInfoId })
  // 首批优先只读近期，近期没有新信息时再放开时间窗口，避免第一次打开就是空页
  if (pool.length === 0 && windowDays !== null) {
    pool = listPanelCandidates(db, { limit, sourceKey, windowDays: null, afterInfoId })
  }
  if (pool.length === 0) return { batchId: null, aiConfigured: false, aiMessage: '' }
  const candidates = pool
  // 雷达只参与邮件候选；非邮件来源用各自的 source_preference 快照。
  const concerns = candidates.some((row) => row.source_kind === 'email') ? await loadConcerns(userDataPath) : undefined
  const general = loadGeneralPreferences(db, [...new Set(candidates.map((row) => row.source_type))])

  const { cfg, message } = aiConfig(store)
  const keywordScores = keywordBoosts(db, candidates.filter(row => row.source_kind === 'email' && row.source_email_id !== null).map(row => row.source_email_id!), now)
  const keywordSummary = candidates.some(row => row.source_kind === 'email')
    ? listKeywordProfile(db, now, 10).map(row => `${row.keyword}:${row.weight > 0 ? '+' : ''}${row.weight}`).join('；')
    : ''
  const recommended = await recommendCandidates(candidates, learning, profileSummary(db) + (keywordSummary ? '；关键词偏好（仅匹配词用于邮件）：' + keywordSummary : ''), cfg, now, concerns, general, keywordScores)
  if (recommended.items.length === 0) return { batchId: null, aiConfigured: false, aiMessage: message }

  // 模型等待期间可能完成同步或用户在别处处置，再核实一次；不把数据库事务跨越网络请求。
  db.exec('SAVEPOINT sp_panel_batch')
  try {
    refreshPanelDuplicates(db)
    const byId = new Map(candidates.map((row) => [row.id, row]))
    // Content/source/analysis may have changed while the model was running. Do not
    // commit an answer for an obsolete snapshot, even if the info is still eligible.
    const current = currentCandidateIds(db, candidates)
    const valid = recommended.items.filter((item) => current.has(item.infoId))
    if (!valid.length) {
      db.exec('RELEASE sp_panel_batch')
      return { batchId: null, aiConfigured: recommended.aiConfigured, aiMessage: recommended.aiMessage || message }
    }
    const batchId = createRecommendationBatch(db, mode, windowDays, valid.length)
    db.prepare('UPDATE recommendation_batch SET ai_configured = ?, ai_message = ? WHERE id = ?')
      .run(recommended.aiConfigured ? 1 : 0, recommended.aiMessage || message, batchId)
    for (const item of valid) {
      const candidate = byId.get(item.infoId)!
      // 八类主题只给邮箱；其他来源留空，避免非邮件内容被硬套邮件分类。
      const topic = candidate.source_kind === 'email'
        ? inferTopic(`${candidate.title} ${candidate.analysis_summary ?? candidate.content ?? ''}`)
        : ''
      insertRecommendation(db, {
        batch_id: batchId,
        info_id: candidate.id,
        source_key: candidate.source_type,
        title: candidate.title || '(无标题)',
        summary: (candidate.analysis_summary ?? candidate.content ?? '').slice(0, 600),
        reason: item.reason,
        recommended_action: item.action,
        confidence: item.confidence,
        score: item.score,
        topic,
        priority: item.priority,
        action_required: candidate.action_required,
        deadline_at: candidate.deadline_at,
        event_start_at: candidate.event_start_at,
        suggested_at: candidate.event_start_at ?? candidate.deadline_at
      })
    }
    db.exec('RELEASE sp_panel_batch')
    return { batchId, aiConfigured: recommended.aiConfigured, aiMessage: recommended.aiMessage || message }
  } catch (error) {
    db.exec('ROLLBACK TO sp_panel_batch')
    db.exec('RELEASE sp_panel_batch')
    throw error
  }
}

/** v17 以前的待处理推荐只补判一次重点/其他及新动作，不动用户已处置结果。 */
async function refreshLegacyPending(db: DatabaseSync, store: SettingsStore, userDataPath?: string): Promise<void> {
  const candidates = listPanelCandidates(db, { limit: INITIAL_BATCH_SIZE, legacyOnly: true })
  if (candidates.length === 0) return
  const { cfg, message } = aiConfig(store)
  const concerns = candidates.some((row) => row.source_kind === 'email') ? await loadConcerns(userDataPath) : undefined
  const general = loadGeneralPreferences(db, [...new Set(candidates.map((row) => row.source_type))])
  const result = await recommendCandidates(candidates, listLearningSignals(db, 8), profileSummary(db), cfg, new Date(), concerns, general)
  db.exec('SAVEPOINT sp_panel_legacy')
  try {
    refreshPanelDuplicates(db)
    const current = currentCandidateIds(db, candidates, true)
    const valid = result.items.filter((item) => current.has(item.infoId))
    const update = db.prepare(
      'UPDATE recommendation SET priority = ?, recommended_action = ?, reason = ?, confidence = ?, score = ?' +
      " WHERE info_id = ? AND status = 'pending' AND priority IS NULL"
    )
    for (const item of valid) update.run(item.priority, item.action, item.reason, item.confidence, item.score, item.infoId)
    if (valid.length) db.prepare('UPDATE recommendation_batch SET ai_configured = ?, ai_message = ? WHERE id IN (' +
      'SELECT batch_id FROM recommendation WHERE info_id IN (' + valid.map(() => '?').join(',') + '))')
      .run(result.aiConfigured ? 1 : 0, result.aiMessage || message, ...valid.map((item) => item.infoId))
    db.exec('RELEASE sp_panel_legacy')
  } catch (error) {
    db.exec('ROLLBACK TO sp_panel_legacy')
    db.exec('RELEASE sp_panel_legacy')
    throw error
  }
}

type NormalizedOverviewQuery = PanelOverviewQuery & { limit: number }
function normalizeOverviewQuery(query?: PanelOverviewQuery): NormalizedOverviewQuery | undefined {
  if (!query) return undefined
  return {
    limit: Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 30,
    beforeInfoId: Number.isSafeInteger(query.beforeInfoId) && query.beforeInfoId! > 0 ? query.beforeInfoId : undefined,
    mailDateRange: [1, 3, 7, 14, 30, 'older30'].includes(query.mailDateRange!) ? query.mailDateRange : undefined,
    priority: query.priority === 'focus' || query.priority === 'other' ? query.priority : undefined
  }
}

async function loadPanelOverview(
  db: DatabaseSync,
  store: SettingsStore,
  sourceKey?: string,
  userDataPath?: string,
  generate = true,
  query?: NormalizedOverviewQuery
): Promise<PanelOverview> {
  // 只有当前视图就是邮箱来源时才需要雷达；其他来源（含跨来源的“重点”）不读取、不返回。
  const mailView = sourceKey ? getInboxSource(db, sourceKey)?.kind === 'email' : false
  const concerns = mailView ? await loadConcerns(userDataPath) : undefined
  const setting = aiConfig(store)
  // 只读快照不进入生成串行队列，也不会触碰模型：界面轮询和处置后的刷新必须立即返回。
  if (generate) {
    await serializeGeneration(db, async () => {
      refreshPanelDuplicates(db)
      await refreshLegacyPending(db, store, userDataPath)
      const latest = latestRecommendationBatch(db)
      // 到达序号比上次已推荐的最大 info.id 更大，就是新入流信息（即使邮件自带日期很旧）。
      const watermark = (db.prepare('SELECT MAX(info_id) AS id FROM recommendation').get() as { id: number | null }).id
      if (!latest || watermark !== null) {
        await createBatch(db, store, 'initial', undefined, userDataPath, latest ? watermark ?? undefined : undefined)
      }
    })
  }
  refreshPanelDuplicates(db)
  const batch = latestRecommendationBatch(db)
  const page = listPendingRecommendations(db, sourceKey, query)
  const hasNext = query !== undefined && page.length > query.limit
  const pending = hasNext ? page.slice(0, query!.limit) : page
  const pendingCounts = new Map<string, number>()
  const priorityCounts = { focus: 0, other: 0 }
  let focusTotal = 0
  for (const row of countPendingRecommendationsBySource(db, query)) {
    pendingCounts.set(row.source_key, (pendingCounts.get(row.source_key) ?? 0) + row.n)
    if (row.priority === 'focus') focusTotal += row.n
    if ((!sourceKey || row.source_key === sourceKey) && (row.priority === 'focus' || row.priority === 'other')) {
      priorityCounts[row.priority] += row.n
    }
  }
  const directory = listInboxSources(db)
  const sources: PanelSource[] = directory.filter((row) => row.enabled === 1).map((row) => ({
    key: row.key, label: row.label, kind: row.kind, enabled: true,
    pending: pendingCounts.get(row.key) ?? 0
  }))
  const labels = new Map(directory.map((row) => [row.key, row.label]))
  const params = sourceKey ? [sourceKey] : []
  const stats = db.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(r.status != \'pending\'), 0) AS processed FROM recommendation r' +
    ' JOIN info i ON i.id = r.info_id WHERE i.panel_duplicate_of IS NULL' +
    (sourceKey ? ' AND r.source_key = ?' : '')
  ).get(...params) as { total: number; processed: number }
  return {
    pendingTotal: query?.priority ? priorityCounts[query.priority] : priorityCounts.focus + priorityCounts.other,
    priorityCounts,
    focusTotal,
    nextBeforeInfoId: hasNext ? pending.at(-1)!.info_id : null,
    batchId: batch?.id ?? null,
    mode: batch ? (batch.mode as 'initial' | 'continue') : 'empty',
    batchTotal: stats.total,
    batchProcessed: stats.processed,
    remaining: countPanelCandidates(db, sourceKey),
    windowDays: batch?.window_days ?? INITIAL_WINDOW_DAYS,
    sources,
    recommendations: pending.map((row) => toDto(row, labels)),
    aiConfigured: batch ? Boolean(batch.ai_configured) : Boolean(setting.cfg),
    aiMessage: batch?.ai_message || setting.message,
    learning: mailView ? listLearningSignals(db, 6) : [],
    keywordProfile: listKeywordProfile(db),
    concerns: concerns ?? {}
  }
}

export function panelOverview(
  db: DatabaseSync,
  store: SettingsStore,
  sourceKey?: string,
  userDataPath?: string,
  generate = true,
  query?: PanelOverviewQuery
): Promise<PanelOverview> {
  // 生成与只读分开做在途去重：后台模型生成时，界面读取仍能立刻拿到当前快照。
  const normalized = normalizeOverviewQuery(query)
  const key = JSON.stringify([sourceKey, generate, normalized])
  const registry = inFlightFor(db, overviewInFlight)
  const running = registry.get(key)
  if (running) return running
  const task = loadPanelOverview(db, store, sourceKey, userDataPath, generate, normalized).finally(() => registry.delete(key))
  registry.set(key, task)
  return task
}

async function loadPanelContinue(
  db: DatabaseSync,
  store: SettingsStore,
  sourceKey?: string,
  userDataPath?: string,
  query?: NormalizedOverviewQuery
): Promise<PanelOverview> {
  // 不要求先清空“其他邮件”，继续阅读只追加，不隐藏任何旧批次。
  await serializeGeneration(db, () => {
    refreshPanelDuplicates(db)
    return createBatch(db, store, 'continue', sourceKey, userDataPath)
  })
  // 继续阅读已经完成本轮生成，随后只读快照即可，避免再生成一批。
  return loadPanelOverview(db, store, sourceKey, userDataPath, false, query)
}

export function panelContinue(
  db: DatabaseSync,
  store: SettingsStore,
  sourceKey?: string,
  userDataPath?: string,
  query?: PanelOverviewQuery
): Promise<PanelOverview> {
  const normalized = normalizeOverviewQuery(query)
  const key = JSON.stringify([sourceKey, normalized])
  const registry = inFlightFor(db, continueInFlight)
  const running = registry.get(key)
  if (running) return running
  const task = loadPanelContinue(db, store, sourceKey, userDataPath, normalized).finally(() => registry.delete(key))
  registry.set(key, task)
  return task
}

function defaultScheduleStart(now = new Date()): string {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
}

function scheduleRemindAt(startIso: string, advanceMinutes: number): string {
  return new Date(new Date(startIso).getTime() - advanceMinutes * 60_000).toISOString()
}

interface ActOutcome {
  ok: boolean
  message: string
  itemId?: number
}

function actIgnore(db: DatabaseSync, rec: RecommendationDetailRow): ActOutcome {
  if (!routeInfo(db, rec.info_id, 'archive')) return { ok: false, message: '信息条目不存在，无法归档' }
  return { ok: true, message: '已忽略并归档；同类信息的推荐权重会降低' }
}

function actMaterial(db: DatabaseSync, rec: RecommendationDetailRow, folder?: string): ActOutcome {
  if (!routeInfo(db, rec.info_id, 'keep')) return { ok: false, message: '信息条目不存在，无法存为资料' }
  const saved = saveMaterial(db, rec.info_id, folder)
  if (!saved.ok) return { ok: false, message: saved.message }
  return { ok: true, message: saved.message }
}

function actTodo(db: DatabaseSync, rec: RecommendationDetailRow, store: SettingsStore): ActOutcome {
  const s = store.peek()
  const advance = s.reminderEnabled ? s.reminderAdvanceMinutes : null
  const title = (rec.action_required ?? '').trim() || rec.title || '未命名事项'
  if (rec.source_email_id) {
    const existing = db.prepare('SELECT id FROM items WHERE source_email_id = ?').get(rec.source_email_id) as
      | { id: number }
      | undefined
    if (existing) {
      if (!routeInfo(db, rec.info_id, 'item', existing.id)) return { ok: false, message: '信息条目不存在，无法关联事项' }
      return { ok: true, message: `该邮件已确认为事项 #${existing.id}，已直接关联`, itemId: existing.id }
    }
  }
  let result
  if (rec.source_email_id) {
    result = createItemFromEmail(
      db,
      {
        title,
        sourceEmailId: rec.source_email_id,
        deadlineAt: rec.deadline_at ?? undefined
      },
      advance
    )
  } else {
    result = createManualItem(
      db,
      {
        title,
        notes: rec.summary,
        deadlineAt: rec.deadline_at,
        remindAt: null
      },
      advance
    )
  }
  if (!result.ok || !result.id) return { ok: false, message: result.message }
  if (!routeInfo(db, rec.info_id, 'item', result.id)) return { ok: false, message: '事项已创建，但信息条目分流失败' }
  return { ok: true, message: result.message, itemId: result.id }
}

function actSchedule(db: DatabaseSync, rec: RecommendationDetailRow, store: SettingsStore): ActOutcome {
  const s = store.peek()
  const start = rec.suggested_at ?? rec.event_start_at ?? rec.deadline_at ?? defaultScheduleStart()
  const end = new Date(new Date(start).getTime() + 60 * 60_000).toISOString()
  const title = (rec.action_required ?? '').trim() || rec.title || '未命名日程'
  const remindAt = s.reminderEnabled ? scheduleRemindAt(start, s.reminderAdvanceMinutes) : null
  let result
  if (rec.source_email_id) {
    result = createItemFromEmail(db, {
      title,
      sourceEmailId: rec.source_email_id,
      deadlineAt: undefined,
      deadlineKind: 'event',
      eventOnly: true,
      eventStartAt: start,
      eventEndAt: end,
      allDay: false
    })
  } else {
    result = createManualItem(db, {
      title,
      notes: rec.summary,
      deadlineAt: null,
      remindAt: null,
      eventStartAt: start,
      eventEndAt: end
    })
  }
  if (!result.ok || !result.id) return { ok: false, message: result.message }
  if (remindAt && !result.reused) createItemReminder(db, result.id, remindAt)
  if (!routeInfo(db, rec.info_id, 'item', result.id)) return { ok: false, message: '日程已创建，但信息条目分流失败' }
  return { ok: true, message: result.reused ? '相同日程已存在，已直接关联' : '已设为日程', itemId: result.id }
}

/** 用户处置一条推荐：动作成功后才标记推荐并写入反馈；重复点击返回失败而不是重复建事项 */
export function panelAct(
  db: DatabaseSync,
  store: SettingsStore,
  recommendationId: number,
  action: PanelActionKey,
  materialFolder?: string
): PanelActResult {
  db.exec('SAVEPOINT sp_panel_act')
  try {
    refreshPanelDuplicates(db)
    const rec = getRecommendationDetail(db, recommendationId)
    if (!rec) {
      db.exec('RELEASE sp_panel_act')
      return { ok: false, message: '推荐不存在', action, recommendationId }
    }
    const state = db.prepare('SELECT panel_duplicate_of FROM info WHERE id = ?').get(rec.info_id) as { panel_duplicate_of: number | null }
    if (state.panel_duplicate_of !== null || ['item', 'archive', 'keep'].includes(rec.destination)) {
      db.exec('RELEASE sp_panel_act')
      return { ok: false, message: '这封邮件或相同内容已经处理，不需要重复操作', action, recommendationId }
    }
    if (rec.status !== 'pending') {
      db.exec('RELEASE sp_panel_act')
      return { ok: false, message: '这条推荐已经处理过了', action, recommendationId }
    }
    let outcome: ActOutcome
    if (action === 'ignore') outcome = actIgnore(db, rec)
    else if (action === 'material') outcome = actMaterial(db, rec, materialFolder)
    else if (action === 'todo') outcome = actTodo(db, rec, store)
    else if (action === 'archive') outcome = routeInfo(db, rec.info_id, 'archive')
      ? { ok: true, message: '已归档，保留原邮件；关心偏好不变' }
      : { ok: false, message: '信息条目不存在，无法归档' }
    else if (action === 'schedule') outcome = actSchedule(db, rec, store)
    else outcome = { ok: false, message: '无效的处理动作' }
    if (!outcome.ok) {
      db.exec('ROLLBACK TO sp_panel_act')
      db.exec('RELEASE sp_panel_act')
      return { ok: false, message: outcome.message, action, recommendationId }
    }
    const accepted = action === rec.recommended_action
    markRecommendation(db, rec.id, accepted ? 'accepted' : 'corrected', action)
    applyFeedback(db, rec, action)
    if (rec.source_kind === 'email') applyKeywordFeedback(db, rec.source_email_id, rec.id, action)
    // 非邮件来源的取舍另记一套，不写进关心雷达的偏好表。
    if (rec.source_kind !== 'email') {
      applyGeneralFeedback(db, rec, action === 'archive' ? 0 : action === 'ignore' ? -1 : 1)
    }
    db.exec('RELEASE sp_panel_act')
    return {
      ok: true,
      message: outcome.message,
      action,
      recommendationId,
      ...(outcome.itemId ? { itemId: outcome.itemId } : {})
    }
  } catch (error) {
    db.exec('ROLLBACK TO sp_panel_act')
    db.exec('RELEASE sp_panel_act')
    return {
      ok: false,
      message: `处理失败：${error instanceof Error ? error.message : String(error)}`,
      action,
      recommendationId
    }
  }
}

/** 处置成功后同步“我的关心”雷达：忽略降权，其余动作升权。
 *  放在事务外，避免文件写入失败把已经完成的事项/资料回滚。 */
export async function adjustConcernFromAct(
  db: DatabaseSync,
  recommendationId: number,
  action: PanelActionKey,
  userDataPath?: string
): Promise<void> {
  if (!userDataPath || action === 'archive') return
  const rec = getRecommendationDetail(db, recommendationId)
  // 关心雷达只服务邮箱；微信、QQ、热搜等来源不改雷达权重。
  if (!rec || rec.source_kind !== 'email') return
  // 旧批次的 topic 可能仍是未分类；和展示层一样按标题+摘要取最新主题。
  const topic = isPanelTopic(rec.topic) ? rec.topic : inferTopic(`${rec.title} ${rec.summary ?? ''}`)
  if (topic === 'uncategorized') return
  const delta = (action === 'ignore' ? -1 : 1) * FEEDBACK_BASE.radarPanelAct * radarSensitivityGain(db)
  try {
    await getMailTagService(userDataPath).adjustPreference({ [topic]: delta })
  } catch (error) {
    console.warn('[panel] 同步关心雷达失败', error)
  }
}

export function panelSources(db: DatabaseSync): PanelSource[] {
  refreshPanelDuplicates(db)
  return listInboxSources(db)
    .filter((row) => row.enabled === 1)
    .map((row) => ({ key: row.key, label: row.label, kind: row.kind, enabled: true, pending: row.pending }))
}

/** 新来源接入的最简入口：外部适配器把抓到的内容写成 info，推荐链路自动纳入。
 *  适配器按 inbox_source.kind 扩展，代码不按 key 写死；邮件来源必须走同步链路，不能手工灌入。 */
export function panelIngest(db: DatabaseSync, input: PanelIngestInput): PanelIngestResult {
  if (!input || typeof input !== 'object') return { ok: false, message: '无效的输入' }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, message: '标题不能为空' }
  const key = typeof input.sourceKey === 'string' && input.sourceKey.trim() ? input.sourceKey.trim() : 'manual'
  const source = getInboxSource(db, key)
  if (!source) return { ok: false, message: `未知来源：${key}` }
  if (source.kind === 'email') return { ok: false, message: '邮件来源请通过邮箱同步写入，不能手工灌入' }
  const id = createInfo(db, {
    source_type: source.key,
    title,
    content: typeof input.content === 'string' ? input.content : '',
    category: null,
    destination: 'unverified'
  })
  return { ok: true, message: '已写入待读池', id }
}

export { INITIAL_BATCH_SIZE, CONTINUE_BATCH_SIZE, INITIAL_WINDOW_DAYS }
