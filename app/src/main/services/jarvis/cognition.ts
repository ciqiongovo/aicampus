import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_AGENT_POLICY,
  RULE_ACTION_TYPES,
  type AgentPolicy,
  type AgentPolicyPatch,
  type AgentRule,
  type AgentRuleInput,
  type CognitionServiceContract,
  type LearnInput,
  type LearnResult,
  type MemoryHistoryEntry,
  type MemoryItem,
  type MemoryListQuery,
  type MemoryOpResult,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemorySourceRef,
  type PolicyOpResult,
  type RelevantMemoriesResult,
  type RuleCondition,
  type RuleOpResult
} from '../../../shared/cognition'

/**
 * 认知服务：画像记忆 / 长期规则 / 权限策略（纯数据库，无 electron 依赖，可直接单测）。
 * 实现 shared/cognition.ts 的 CognitionServiceContract，另提供 Agent/pipeline 用的
 * relevantMemories / learn / getRulesFor / matchRules / evaluateRuleConditions。
 *
 * - 可注入时钟 clock()，用于新鲜期/时间判断，测试无需真实等待。
 * - 所有方法同步；多写语句用 SAVEPOINT 包裹，避免与调用方外层事务嵌套 BEGIN。
 * - 删除=停用（status='archived'）保留历史；不物理遗忘。
 * - field_key 稳定语义键：同 key 下明确优先、推断不覆盖、显式修正更新同 id 形成版本历史。
 */

const DAY_MS = 86_400_000
const MAX_CONTENT = 4000
const MAX_LABEL = 120

/** 重要/敏感分区：inferred 一律强制 candidate，模型不得自降 */
const SENSITIVE_SECTIONS = ['identity', 'background', 'goal']

/** 健康/财务/身份隐私等敏感关键词（保守清单，命中即强制 candidate） */
const SENSITIVE_KEYWORDS = [
  '健康', '疾病', '病史', '过敏', '病历', '就医', '住院', '手术', '服药', '诊断', '症状', '癌症', '抑郁', '焦虑', '失眠', '心理', '残疾', '怀孕',
  '财务', '收入', '工资', '存款', '债务', '欠款', '借贷', '贷款', '还款', '资产', '银行卡', '账户余额', '理财', '薪酬', '欠债',
  '身份证', '身份证号', '密码', '账号', '住址', '家庭住址', '手机号', '电话号码', '性取向', '宗教', '信仰', '政治立场',
  'health', 'disease', 'salary', 'income', 'finance', 'password', 'address', 'religion', 'politics', 'sexual'
]

/** 检索相关性：去停用词 + 关键词重合 + 可解释的同义扩展（编程类），无向量库 */
const RELEVANCE_STOP_CHARS = new Set('聊现在怎么样一下关于帮请想是要有会能可以这个那个什么还有以及与或的了吗呢吧啊我你他她它们就都又很更最才刚正在已经还没不'.split(''))
const RELEVANCE_STOP_WORDS = new Set(['how', 'what', 'now', 'about', 'please', 'tell', 'me', 'the', 'a', 'an', 'is', 'are', 'do', 'does', 'you', 'can', 'could', 'would', 'should', 'to', 'of', 'in', 'for', 'and', 'or', 'i', 'my'])
const RELEVANCE_STOP_NGRAMS = new Set(['喜欢', '用户', '关注', '觉得', '认为', '感觉', '需要', '想要', '可能', '应该', '比较', '非常', '特别', '时候', '不太', '没有', '已经', '知道', '告诉', '介绍', '帮忙', '解决'])
const RELEVANCE_SYNONYMS: Record<string, string[]> = {
  '编程': ['python', 'java', 'c++', '代码', '程序', '开发', 'coding', 'programming'],
  'python': ['编程', '代码', '程序', 'coding', 'programming'],
  'java': ['编程', '代码', '程序', 'coding', 'programming'],
  '代码': ['编程', '程序', 'python', 'coding', 'programming'],
  '程序': ['编程', '代码', 'python'],
  '开发': ['编程', '代码', '程序', 'coding'],
  'coding': ['编程', '代码', 'programming', 'python'],
  'programming': ['编程', '代码', 'coding', 'python'],
  '机器学习': ['ai', '人工智能', 'ml', '深度学习', '模型', '训练'],
  '人工智能': ['ai', '机器学习', '深度学习', '模型'],
  '深度学习': ['机器学习', 'ai', '人工智能', '模型'],
  'ai': ['人工智能', '机器学习', '深度学习', '模型'],
  '大模型': ['模型', 'ai', '人工智能'],
  '模型': ['大模型', 'ai', '人工智能', '机器学习']
}

// ---------------------------------------------------------------------------
// 内部行类型与工具函数
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: number
  section: string
  content: string
  source_kind: string
  field_key: string | null
  source_ref: string
  status: string
  recorded_at: string
  last_confirmed_at: string | null
  revision: number
  manual_edited: number
  confidence: number | null
  created_at: string
  updated_at: string
}

interface HistoryRow {
  id: number
  memory_id: number
  revision: number
  content: string
  source_kind: string
  field_key: string | null
  source_ref: string
  section: string
  status: string
  recorded_at: string
  last_confirmed_at: string | null
  changed_by: string
  change_kind: string
  changed_at: string
}

interface RuleRow {
  id: number
  scope: string
  name: string
  description: string
  condition_json: string
  action_json: string
  enforcement: string
  enabled: number
  revision: number
  modified_by: string
  created_at: string
  updated_at: string
}

interface PolicyRow {
  id: number
  read_domains_json: string
  write_auto_json: string
  write_confirm_json: string
  write_deny_json: string
  learning_enabled: number
  background_enabled: number
  memory_freshness_days: number
  time_zone: string
  updated_at: string
}

let spCounter = 0

function charCode(ch: string): number {
  return ch.charCodeAt(0)
}

function isAsciiAlnumCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

function isCjkCode(c: number): boolean {
  return c >= 0x4e00 && c <= 0x9fff
}

function asTrimmedString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  return s.slice(0, max)
}

function normalizeConfidence(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(1, Math.max(0, v))
}

function parseSourceRef(raw: string): MemorySourceRef {
  if (!raw) return { type: 'legacy', label: '' }
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      const out: MemorySourceRef = { type: typeof o.type === 'string' && o.type ? o.type : 'unknown' }
      if (o.id !== undefined) out.id = o.id as string | number
      if (typeof o.label === 'string' && o.label) out.label = o.label
      if (typeof o.excerpt === 'string' && o.excerpt) out.excerpt = o.excerpt
      return out
    }
  } catch {
    /* 落到旧纯文本标签 */
  }
  return { type: 'legacy', label: raw }
}

function serializeSourceRef(ref: MemorySourceRef | undefined): string {
  if (!ref || typeof ref !== 'object') return ''
  const out: MemorySourceRef = { type: typeof ref.type === 'string' && ref.type ? ref.type.slice(0, 40) : 'unknown' }
  if (ref.id !== undefined) out.id = ref.id
  if (typeof ref.label === 'string' && ref.label) out.label = ref.label.slice(0, MAX_LABEL)
  if (typeof ref.excerpt === 'string' && ref.excerpt) out.excerpt = ref.excerpt.slice(0, 500)
  return JSON.stringify(out)
}

/** 解析带日期语义的时间；旧无时区串按 UTC（datetime('now') 语义）处理 */
function parseDateMs(v: string | null): number | null {
  if (!v) return null
  const s = v.trim()
  if (!s) return null
  if (s.includes('T') || s.endsWith('Z') || s.endsWith('z')) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  const tail = s.slice(-6)
  if ((tail.startsWith('+') || tail.startsWith('-')) && tail.charAt(3) === ':') {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  const t = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}

function normalizeStringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return null
    const s = x.trim()
    if (s) out.push(s)
  }
  return [...new Set(out)]
}

function hasOverlap(a: string[], b: string[]): boolean {
  const set = new Set(b)
  return a.some((x) => set.has(x))
}

function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 去空白后小写，用于字面片段匹配（不用正则，避免转义） */
function normalizeForMatch(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    const c = charCode(ch)
    if (c === 32 || c === 9 || c === 10 || c === 13) continue
    out += ch
  }
  return out
}

/** content 是否为 quote 的字面片段（去空白后 substring） */
function isVerbatim(content: string, quote: string): boolean {
  if (!quote) return false
  const nc = normalizeForMatch(content)
  const nq = normalizeForMatch(quote)
  return nc.length > 0 && nq.includes(nc)
}

/** 程序识别重要/敏感内容：分区命中或关键词命中（保守，模型不得自降为普通偏好） */
function isSensitiveContent(content: string, section: string): boolean {
  if (SENSITIVE_SECTIONS.includes(section)) return true
  const c = content.toLowerCase()
  return SENSITIVE_KEYWORDS.some((k) => c.includes(k))
}

/** 抽取检索关键词：英文词 + 同义词典命中 + 中文去停用字后的片段 */
function relevanceTerms(text: string): string[] {
  const lower = text.toLowerCase()
  const terms = new Set<string>()
  let cur = ''
  for (const ch of lower) {
    if (isAsciiAlnumCode(charCode(ch))) {
      cur += ch
      continue
    }
    if (cur) {
      if (cur.length >= 2 && !RELEVANCE_STOP_WORDS.has(cur)) terms.add(cur)
      cur = ''
    }
  }
  if (cur && cur.length >= 2 && !RELEVANCE_STOP_WORDS.has(cur)) terms.add(cur)

  for (const key of Object.keys(RELEVANCE_SYNONYMS)) {
    if (lower.includes(key)) terms.add(key)
  }

  let run = ''
  const flush = (): void => {
    if (!run) return
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const gram = run.slice(i, i + n)
        if (RELEVANCE_STOP_NGRAMS.has(gram)) continue
        let hasStop = false
        for (const ch of gram) {
          if (RELEVANCE_STOP_CHARS.has(ch)) {
            hasStop = true
            break
          }
        }
        if (!hasStop) terms.add(gram)
      }
    }
    run = ''
  }
  for (const ch of lower) {
    if (isCjkCode(charCode(ch))) {
      run += ch
      continue
    }
    flush()
  }
  flush()
  return [...terms]
}

function expandRelevanceTerms(terms: string[]): string[] {
  const out = new Set(terms)
  for (const t of terms) {
    const syns = RELEVANCE_SYNONYMS[t]
    if (syns) for (const s of syns) out.add(s)
  }
  return [...out]
}

/** 确定性规则条件匹配（AND 组合），供 pipeline 程序化执行 */
export function evaluateRuleConditions(conditions: RuleCondition[], facts: Record<string, string | null | undefined>): boolean {
  for (const c of conditions) {
    const actual = facts[c.field]
    const has = actual !== undefined && actual !== null && actual !== ''
    const a = actual ?? ''
    if (c.op === 'eq') {
      if (!has || a !== c.value) return false
    } else if (c.op === 'neq') {
      if (has && a === c.value) return false
    } else if (c.op === 'contains') {
      if (!has || !a.includes(c.value ?? '')) return false
    } else if (c.op === 'missing') {
      if (has) return false
    } else if (c.op === 'present') {
      if (!has) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class CognitionService implements CognitionServiceContract {
  constructor(
    private db: DatabaseSync,
    private clock: () => Date = () => new Date()
  ) {}

  /** SAVEPOINT 事务：避免与调用方外层事务嵌套 BEGIN */
  private tx<T>(fn: () => T): T {
    const name = 'cog' + ++spCounter
    this.db.exec('SAVEPOINT ' + name)
    try {
      const result = fn()
      this.db.exec('RELEASE ' + name)
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO ' + name)
      this.db.exec('RELEASE ' + name)
      throw error
    }
  }

  private nowIso(): string {
    return this.clock().toISOString()
  }

  private getMemory(id: number): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM cognition_memory WHERE id = ?').get(id) as MemoryRow | undefined
  }

  private mapMemory(row: MemoryRow): MemoryItem {
    return {
      id: row.id,
      section: row.section,
      fieldKey: row.field_key,
      content: row.content,
      sourceKind: row.source_kind === 'inferred' ? 'inferred' : 'explicit',
      sourceRef: parseSourceRef(row.source_ref),
      status: row.status === 'candidate' || row.status === 'archived' ? row.status : 'active',
      recordedAt: row.recorded_at,
      lastConfirmedAt: row.last_confirmed_at,
      revision: row.revision,
      manualEdited: row.manual_edited === 1,
      confidence: row.confidence,
      candidate: row.status === 'candidate',
      inferred: row.source_kind === 'inferred'
    }
  }

  private appendHistory(memory: MemoryRow, changeKind: MemoryHistoryEntry['changeKind'], changedBy: string, changedAt: string): void {
    this.db
      .prepare(
        'INSERT INTO cognition_memory_history' +
          ' (memory_id, revision, content, source_kind, field_key, source_ref, section, status, recorded_at, last_confirmed_at, changed_by, change_kind, changed_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        memory.id,
        memory.revision,
        memory.content,
        memory.source_kind,
        memory.field_key,
        memory.source_ref,
        memory.section,
        memory.status,
        memory.recorded_at,
        memory.last_confirmed_at,
        changedBy,
        changeKind,
        changedAt
      )
  }

  // -------------------------------------------------------------------------
  // 记忆 API
  // -------------------------------------------------------------------------

  memoryList(query?: MemoryListQuery): MemoryItem[] {
    const q = query ?? {}
    const clause: string[] = []
    const params: (string | number)[] = []
    if (q.section) {
      clause.push('section = ?')
      params.push(q.section)
    }
    const keyword = typeof q.keyword === 'string' ? q.keyword.trim() : ''
    if (keyword) {
      clause.push("(content LIKE '%' || ? || '%' OR section LIKE '%' || ? || '%')")
      params.push(keyword, keyword)
    }
    if (q.status && q.status !== 'all') {
      clause.push('status = ?')
      params.push(q.status)
    } else if (!q.includeArchived) {
      clause.push("status != 'archived'")
    }
    const where = clause.length ? ' WHERE ' + clause.join(' AND ') : ''
    const rows = this.db
      .prepare('SELECT * FROM cognition_memory' + where + ' ORDER BY manual_edited DESC, id DESC')
      .all(...params) as unknown as MemoryRow[]
    return rows.map((r) => this.mapMemory(r))
  }

  memorySave(input: MemorySaveInput): MemorySaveResult {
    const content = asTrimmedString(input.content, MAX_CONTENT)
    if (!content) return { ok: false, message: '记忆内容不能为空' }
    const now = this.nowIso()
    const sourceKind = input.sourceKind === 'inferred' ? 'inferred' : 'explicit'
    const sourceRef = serializeSourceRef(input.sourceRef)
    const id = typeof input.id === 'number' && Number.isFinite(input.id) ? Math.floor(input.id) : undefined

    if (id !== undefined) {
      const existing = this.getMemory(id)
      if (!existing) return { ok: false, message: '记忆不存在' }
      if (existing.status === 'archived') return { ok: false, message: '已归档记忆不可编辑（如需恢复请新建）' }

      const section = input.section === undefined ? existing.section : (asTrimmedString(input.section, 100) ?? 'general')
      const fieldKey = input.fieldKey === undefined ? existing.field_key : (asTrimmedString(input.fieldKey, 100) ?? null)
      const confidence = input.confidence === undefined ? existing.confidence : normalizeConfidence(input.confidence)
      const changed =
        existing.content !== content ||
        existing.section !== section ||
        existing.source_kind !== sourceKind ||
        existing.field_key !== fieldKey ||
        existing.source_ref !== sourceRef ||
        existing.confidence !== confidence

      const wasCandidate = existing.status === 'candidate'
      return this.tx(() => {
        if (changed) {
          const revision = existing.revision + 1
          this.db
            .prepare(
              "UPDATE cognition_memory SET content = ?, section = ?, source_kind = ?, field_key = ?, source_ref = ?, confidence = ?, status = 'active', last_confirmed_at = ?, revision = ?, manual_edited = 1, updated_at = ? WHERE id = ?"
            )
            .run(content, section, sourceKind, fieldKey, sourceRef, confidence, now, revision, now, id)
          const updated = this.getMemory(id) as MemoryRow
          this.appendHistory(updated, 'update', 'manual', now)
          return { ok: true, message: '记忆已更新（新版本）', id, item: this.mapMemory(updated) }
        }
        this.db
          .prepare("UPDATE cognition_memory SET last_confirmed_at = ?, status = 'active', manual_edited = 1, updated_at = ? WHERE id = ?")
          .run(now, now, id)
        const updated = this.getMemory(id) as MemoryRow
        this.appendHistory(updated, wasCandidate ? 'promote' : 'confirm', 'manual', now)
        return { ok: true, message: wasCandidate ? '候选已确认' : '已刷新确认时间', id, item: this.mapMemory(updated) }
      })
    }

    const section = asTrimmedString(input.section, 100) ?? 'general'
    const fieldKey = asTrimmedString(input.fieldKey, 100) ?? null
    const confidence = normalizeConfidence(input.confidence)
    const newId = this.tx(() => {
      const r = this.db
        .prepare(
          'INSERT INTO cognition_memory' +
            ' (section, content, source_kind, field_key, source_ref, status, recorded_at, last_confirmed_at, revision, manual_edited, confidence, created_at, updated_at)' +
            " VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1, 1, ?, ?, ?)"
        )
        .run(section, content, sourceKind, fieldKey, sourceRef, now, now, confidence, now, now)
      const memoryId = Number(r.lastInsertRowid)
      const row = this.getMemory(memoryId) as MemoryRow
      this.appendHistory(row, 'create', 'manual', now)
      return memoryId
    })
    const row = this.getMemory(newId) as MemoryRow
    return { ok: true, message: '已保存记忆', id: newId, item: this.mapMemory(row) }
  }

  memoryConfirm(id: number): MemoryOpResult {
    const existing = this.getMemory(Number(id))
    if (!existing) return { ok: false, message: '记忆不存在' }
    if (existing.status === 'archived') return { ok: false, message: '已归档记忆不可确认' }
    const now = this.nowIso()
    const wasCandidate = existing.status === 'candidate'
    return this.tx(() => {
      this.db
        .prepare("UPDATE cognition_memory SET last_confirmed_at = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(now, now, existing.id)
      const updated = this.getMemory(existing.id) as MemoryRow
      this.appendHistory(updated, wasCandidate ? 'promote' : 'confirm', 'user', now)
      return { ok: true, message: wasCandidate ? '候选已确认' : '已刷新确认时间', item: this.mapMemory(updated) }
    })
  }

  memoryArchive(id: number): MemoryOpResult {
    const existing = this.getMemory(Number(id))
    if (!existing) return { ok: false, message: '记忆不存在' }
    if (existing.status === 'archived') {
      return { ok: true, message: '已归档（幂等）', item: this.mapMemory(existing) }
    }
    const now = this.nowIso()
    return this.tx(() => {
      this.db
        .prepare("UPDATE cognition_memory SET status = 'archived', updated_at = ? WHERE id = ?")
        .run(now, existing.id)
      const updated = this.getMemory(existing.id) as MemoryRow
      this.appendHistory(updated, 'archive', 'user', now)
      return { ok: true, message: '已停用（保留历史）', item: this.mapMemory(updated) }
    })
  }

  memoryHistory(id: number): MemoryHistoryEntry[] {
    const existing = this.getMemory(Number(id))
    if (!existing) return []
    const rows = this.db
      .prepare('SELECT * FROM cognition_memory_history WHERE memory_id = ? ORDER BY id DESC')
      .all(existing.id) as unknown as HistoryRow[]
    return rows.map((r) => ({
      id: r.id,
      memoryId: r.memory_id,
      revision: r.revision,
      content: r.content,
      sourceKind: r.source_kind === 'inferred' ? 'inferred' : 'explicit',
      fieldKey: r.field_key,
      sourceRef: parseSourceRef(r.source_ref),
      section: r.section,
      status: r.status === 'candidate' || r.status === 'archived' ? r.status : 'active',
      recordedAt: r.recorded_at,
      lastConfirmedAt: r.last_confirmed_at,
      changedBy: r.changed_by,
      changeKind: r.change_kind as MemoryHistoryEntry['changeKind'],
      changedAt: r.changed_at
    }))
  }

  // -------------------------------------------------------------------------
  // 权限策略 API
  // -------------------------------------------------------------------------

  private readPolicyRow(): PolicyRow | undefined {
    return this.db.prepare('SELECT * FROM cognition_policy WHERE id = 1').get() as PolicyRow | undefined
  }

  private policyFromRow(row: PolicyRow | undefined): AgentPolicy {
    if (!row) {
      return {
        readDomains: [...DEFAULT_AGENT_POLICY.readDomains],
        writeAuto: [...DEFAULT_AGENT_POLICY.writeAuto],
        writeConfirm: [...DEFAULT_AGENT_POLICY.writeConfirm],
        writeDeny: [...DEFAULT_AGENT_POLICY.writeDeny],
        learningEnabled: DEFAULT_AGENT_POLICY.learningEnabled,
        backgroundEnabled: DEFAULT_AGENT_POLICY.backgroundEnabled,
        memoryFreshnessDays: DEFAULT_AGENT_POLICY.memoryFreshnessDays,
        timeZone: DEFAULT_AGENT_POLICY.timeZone
      }
    }
    return {
      readDomains: normalizeStringList(safeParseArray(row.read_domains_json)) ?? [],
      writeAuto: normalizeStringList(safeParseArray(row.write_auto_json)) ?? [],
      writeConfirm: normalizeStringList(safeParseArray(row.write_confirm_json)) ?? [],
      writeDeny: normalizeStringList(safeParseArray(row.write_deny_json)) ?? [],
      learningEnabled: row.learning_enabled === 1,
      backgroundEnabled: row.background_enabled === 1,
      memoryFreshnessDays: row.memory_freshness_days,
      timeZone: row.time_zone
    }
  }

  agentPolicyGet(): AgentPolicy {
    return this.policyFromRow(this.readPolicyRow())
  }

  agentPolicySet(patch: AgentPolicyPatch): PolicyOpResult {
    const current = this.agentPolicyGet()
    const next: AgentPolicy = {
      readDomains: patch.readDomains === undefined ? current.readDomains : (normalizeStringList(patch.readDomains) ?? current.readDomains),
      writeAuto: patch.writeAuto === undefined ? current.writeAuto : (normalizeStringList(patch.writeAuto) ?? current.writeAuto),
      writeConfirm: patch.writeConfirm === undefined ? current.writeConfirm : (normalizeStringList(patch.writeConfirm) ?? current.writeConfirm),
      writeDeny: patch.writeDeny === undefined ? current.writeDeny : (normalizeStringList(patch.writeDeny) ?? current.writeDeny),
      learningEnabled: patch.learningEnabled === undefined ? current.learningEnabled : patch.learningEnabled === true,
      backgroundEnabled: patch.backgroundEnabled === undefined ? current.backgroundEnabled : patch.backgroundEnabled === true,
      memoryFreshnessDays:
        patch.memoryFreshnessDays === undefined ? current.memoryFreshnessDays : patch.memoryFreshnessDays,
      timeZone: patch.timeZone === undefined ? current.timeZone : String(patch.timeZone ?? '').trim()
    }

    if (hasOverlap(next.writeAuto, next.writeConfirm) || hasOverlap(next.writeAuto, next.writeDeny) || hasOverlap(next.writeConfirm, next.writeDeny)) {
      return { ok: false, message: '写权限分级（自动/确认/禁止）存在重叠，请调整' }
    }
    if (!Number.isInteger(next.memoryFreshnessDays) || next.memoryFreshnessDays < 1 || next.memoryFreshnessDays > 36500) {
      return { ok: false, message: 'memoryFreshnessDays 须为 1~36500 的整数' }
    }
    if (!isValidTimeZone(next.timeZone)) {
      return { ok: false, message: '无效时区：' + next.timeZone }
    }

    this.db
      .prepare(
        'INSERT INTO cognition_policy' +
          ' (id, read_domains_json, write_auto_json, write_confirm_json, write_deny_json, learning_enabled, background_enabled, memory_freshness_days, time_zone, updated_at)' +
          ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT(id) DO UPDATE SET read_domains_json = excluded.read_domains_json,' +
          '   write_auto_json = excluded.write_auto_json, write_confirm_json = excluded.write_confirm_json,' +
          '   write_deny_json = excluded.write_deny_json, learning_enabled = excluded.learning_enabled,' +
          '   background_enabled = excluded.background_enabled, memory_freshness_days = excluded.memory_freshness_days,' +
          '   time_zone = excluded.time_zone, updated_at = excluded.updated_at'
      )
      .run(
        JSON.stringify(next.readDomains),
        JSON.stringify(next.writeAuto),
        JSON.stringify(next.writeConfirm),
        JSON.stringify(next.writeDeny),
        next.learningEnabled ? 1 : 0,
        next.backgroundEnabled ? 1 : 0,
        next.memoryFreshnessDays,
        next.timeZone,
        this.nowIso()
      )
    return { ok: true, message: '策略已保存', policy: this.agentPolicyGet() }
  }

  // -------------------------------------------------------------------------
  // 规则 API
  // -------------------------------------------------------------------------

  private mapRule(row: RuleRow): AgentRule {
    return {
      id: row.id,
      scope: row.scope,
      name: row.name,
      description: row.description,
      conditions: safeParseArray(row.condition_json) as RuleCondition[],
      action: (safeParse(row.action_json) ?? { type: 'notify', params: {} }) as AgentRule['action'],
      enforcement: row.enforcement === 'preference' ? 'preference' : 'mandatory',
      enabled: row.enabled === 1,
      revision: row.revision,
      modifiedBy: row.modified_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  agentRulesList(): AgentRule[] {
    const rows = this.db.prepare('SELECT * FROM cognition_rule ORDER BY scope ASC, id ASC').all() as unknown as RuleRow[]
    return rows.map((r) => this.mapRule(r))
  }

  agentRuleSave(input: AgentRuleInput): RuleOpResult {
    const name = asTrimmedString(input.name, 120)
    if (!name) return { ok: false, message: '规则名称不能为空' }
    const scope = asTrimmedString(input.scope, 60) ?? 'global'
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 500) : ''
    const enforcement = input.enforcement === 'preference' ? 'preference' : 'mandatory'
    const enabled = input.enabled === undefined ? true : input.enabled === true
    const modifiedBy = typeof input.modifiedBy === 'string' ? input.modifiedBy.trim().slice(0, 80) : ''
    const conditions = this.normalizeConditions(input.conditions)
    if (conditions === null) return { ok: false, message: '规则条件格式非法（须为 {field, op, value?} 数组）' }
    const action = this.normalizeAction(input.action)
    if (action === null) return { ok: false, message: '规则动作格式非法或类型不支持' }
    const now = this.nowIso()
    const actionJson = JSON.stringify(action)
    const conditionJson = JSON.stringify(conditions)

    const id = typeof input.id === 'number' && Number.isFinite(input.id) ? Math.floor(input.id) : undefined
    if (id !== undefined) {
      const existing = this.db.prepare('SELECT id FROM cognition_rule WHERE id = ?').get(id) as { id: number } | undefined
      if (!existing) return { ok: false, message: '规则不存在' }
      const cur = this.db.prepare('SELECT revision FROM cognition_rule WHERE id = ?').get(id) as { revision: number }
      const revision = cur.revision + 1
      this.db
        .prepare(
          'UPDATE cognition_rule SET scope = ?, name = ?, description = ?, condition_json = ?, action_json = ?, enforcement = ?, enabled = ?, revision = ?, modified_by = ?, updated_at = ? WHERE id = ?'
        )
        .run(scope, name, description, conditionJson, actionJson, enforcement, enabled ? 1 : 0, revision, modifiedBy, now, id)
      return { ok: true, message: '规则已更新', id, rule: this.mapRule(this.db.prepare('SELECT * FROM cognition_rule WHERE id = ?').get(id) as unknown as RuleRow) }
    }

    const r = this.db
      .prepare(
        'INSERT INTO cognition_rule (scope, name, description, condition_json, action_json, enforcement, enabled, revision, modified_by, created_at, updated_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
      )
      .run(scope, name, description, conditionJson, actionJson, enforcement, enabled ? 1 : 0, modifiedBy, now, now)
    const newId = Number(r.lastInsertRowid)
    return { ok: true, message: '规则已创建', id: newId, rule: this.mapRule(this.db.prepare('SELECT * FROM cognition_rule WHERE id = ?').get(newId) as unknown as RuleRow) }
  }

  /** 删除=停用（enabled=0），保留规则与版本便于审计恢复；不物理删除 */
  agentRuleDelete(id: number): RuleOpResult {
    const existing = this.db.prepare('SELECT id FROM cognition_rule WHERE id = ?').get(Number(id)) as { id: number } | undefined
    if (!existing) return { ok: false, message: '规则不存在' }
    this.db.prepare('UPDATE cognition_rule SET enabled = 0, updated_at = ? WHERE id = ?').run(this.nowIso(), Number(id))
    return { ok: true, message: '规则已停用', id: Number(id), rule: this.mapRule(this.db.prepare('SELECT * FROM cognition_rule WHERE id = ?').get(Number(id)) as unknown as RuleRow) }
  }

  private normalizeConditions(raw: unknown): RuleCondition[] | null {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) return null
    const out: RuleCondition[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const o = item as Record<string, unknown>
      const field = asTrimmedString(o.field, 80)
      if (!field) return null
      const op = o.op
      if (op !== 'eq' && op !== 'neq' && op !== 'contains' && op !== 'missing' && op !== 'present') return null
      const cond: RuleCondition = { field, op }
      if (o.value !== undefined && typeof o.value !== 'string') return null
      if (typeof o.value === 'string') cond.value = o.value.slice(0, 500)
      out.push(cond)
    }
    return out
  }

  private normalizeAction(raw: unknown): AgentRule['action'] | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const type = o.type
    if (typeof type !== 'string' || !(RULE_ACTION_TYPES as readonly string[]).includes(type)) return null
    const action: AgentRule['action'] = { type: type as AgentRule['action']['type'] }
    if (o.params !== undefined) {
      if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) return null
      const params: Record<string, string | number | boolean | null> = {}
      for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v
      }
      action.params = params
    }
    return action
  }

  // -------------------------------------------------------------------------
  // Agent / pipeline 专用
  // -------------------------------------------------------------------------

  /** 供后续会话与推荐按需读取：fresh 当前可用 + stale 待重确认 + candidate 候选（不把过期偏好当当前立场） */
  relevantMemories(query: string): RelevantMemoriesResult {
    const policy = this.agentPolicyGet()
    const freshnessDays = policy.memoryFreshnessDays
    const nowMs = this.clock().getTime()
    const rows = this.db
      .prepare("SELECT * FROM cognition_memory WHERE status != 'archived' ORDER BY manual_edited DESC, id DESC")
      .all() as unknown as MemoryRow[]

    const result: RelevantMemoriesResult = { fresh: [], stale: [], candidate: [] }
    for (const row of rows) {
      if (!this.isRelevant(row, query)) continue
      const item = this.mapMemory(row)
      if (item.status === 'candidate') {
        result.candidate.push(item)
        continue
      }
      const anchorMs = parseDateMs(row.last_confirmed_at) ?? parseDateMs(row.recorded_at)
      const fresh = anchorMs !== null && nowMs - anchorMs < freshnessDays * DAY_MS
      if (fresh) result.fresh.push(item)
      else result.stale.push(item)
    }
    return result
  }

  /** 相关性：去停用词后关键词重合 + 同义扩展（无向量库）；无意义 query 视为全量匹配 */
  private isRelevant(row: MemoryRow, query: string): boolean {
    const qTerms = relevanceTerms(query ?? '')
    if (qTerms.length === 0) return true
    const expanded = expandRelevanceTerms(qTerms)
    const label = parseSourceRef(row.source_ref).label ?? ''
    const hay = (row.content + ' ' + row.section + ' ' + label).toLowerCase()
    return expanded.some((t) => hay.includes(t))
  }

  /**
   * LLM 认知变化落库。
   * - explicit 仅当 content 确为用户原话（sourceQuote）字面片段，否则自动降级 inferred；
   * - 程序识别 identity/background/goal 分区及健康/财务/身份关键词，命中即强制 candidate（模型不得自降）；
   * - 普通偏好（inferred + ordinary，未命中敏感）自动学习（active，弱信号，lastConfirmedAt 为空）；
   * - fieldKey 同 key 冲突检测：明确优先、推断不覆盖、显式修正更新同 id（版本历史）。
   */
  learn(input: LearnInput): LearnResult {
    const content = asTrimmedString(input.content, MAX_CONTENT)
    if (!content) return { ok: false, message: '学习内容不能为空' }
    const section = asTrimmedString(input.section, 100) ?? 'general'
    const quote = typeof input.sourceQuote === 'string' ? input.sourceQuote.trim() : ''
    const fieldKey = asTrimmedString(input.fieldKey, 100) ?? null

    let sourceKind: 'explicit' | 'inferred' = input.sourceKind === 'explicit' ? 'explicit' : 'inferred'
    if (sourceKind === 'explicit' && !isVerbatim(content, quote)) {
      sourceKind = 'inferred'
    }

    const ref = input.sourceRef ?? { type: 'chat' }
    const sourceRef = serializeSourceRef(quote ? { ...ref, excerpt: quote } : ref)
    const confidence = normalizeConfidence(input.confidence)
    const now = this.nowIso()

    const forcedSensitive = sourceKind === 'inferred' && isSensitiveContent(content, section)
    const isSensitive =
      sourceKind === 'inferred' &&
      (input.sensitivity === 'sensitive' || input.sensitivity === 'important' || forcedSensitive)

    const existing = fieldKey
      ? (this.db
          .prepare("SELECT * FROM cognition_memory WHERE field_key = ? AND status != 'archived' ORDER BY manual_edited DESC, id DESC LIMIT 1")
          .get(fieldKey) as MemoryRow | undefined)
      : (this.db
          .prepare("SELECT * FROM cognition_memory WHERE content = ? AND section = ? AND status != 'archived' ORDER BY manual_edited DESC, id DESC LIMIT 1")
          .get(content, section) as MemoryRow | undefined)

    if (sourceKind === 'explicit') {
      if (existing && existing.source_kind === 'explicit') {
        if (existing.content === content && existing.section === section) {
          return this.tx(() => {
            this.db.prepare('UPDATE cognition_memory SET last_confirmed_at = ?, updated_at = ? WHERE id = ?').run(now, now, existing.id)
            const updated = this.getMemory(existing.id) as MemoryRow
            this.appendHistory(updated, 'confirm', 'agent', now)
            return { ok: true, message: '明确表达已存在，刷新确认时间', id: existing.id, item: this.mapMemory(updated) }
          })
        }
        // 显式修正：同 key 不同内容 → 更新原 id，形成新版本
        return this.tx(() => {
          const revision = existing.revision + 1
          this.db
            .prepare(
              "UPDATE cognition_memory SET content = ?, section = ?, field_key = ?, source_ref = ?, confidence = ?, status = 'active', last_confirmed_at = ?, revision = ?, updated_at = ? WHERE id = ?"
            )
            .run(content, section, fieldKey ?? existing.field_key, sourceRef || existing.source_ref, confidence, now, revision, now, existing.id)
          const updated = this.getMemory(existing.id) as MemoryRow
          this.appendHistory(updated, 'update', 'agent', now)
          return { ok: true, message: '明确表达已更新（新版本）', id: existing.id, item: this.mapMemory(updated) }
        })
      }
      if (existing) {
        // 同 key 旧推断 → 升级为明确
        return this.tx(() => {
          const revision = existing.revision + 1
          this.db
            .prepare(
              "UPDATE cognition_memory SET content = ?, section = ?, source_kind = 'explicit', field_key = ?, source_ref = ?, confidence = ?, status = 'active', last_confirmed_at = ?, revision = ?, updated_at = ? WHERE id = ?"
            )
            .run(content, section, fieldKey ?? existing.field_key, sourceRef || existing.source_ref, confidence, now, revision, now, existing.id)
          const updated = this.getMemory(existing.id) as MemoryRow
          this.appendHistory(updated, 'update', 'agent', now)
          return { ok: true, message: '明确表达覆盖旧推断', id: existing.id, item: this.mapMemory(updated) }
        })
      }
      const newId = this.tx(() => {
        const r = this.db
          .prepare(
            'INSERT INTO cognition_memory (section, content, source_kind, field_key, source_ref, status, recorded_at, last_confirmed_at, revision, manual_edited, confidence, created_at, updated_at)' +
              " VALUES (?, ?, 'explicit', ?, ?, 'active', ?, ?, 1, 0, ?, ?, ?)"
          )
          .run(section, content, fieldKey, sourceRef, now, now, confidence, now, now)
        const memoryId = Number(r.lastInsertRowid)
        this.appendHistory(this.getMemory(memoryId) as MemoryRow, 'create', 'agent', now)
        return memoryId
      })
      return { ok: true, message: '已学习明确表达', id: newId, item: this.mapMemory(this.getMemory(newId) as MemoryRow) }
    }

    // inferred：绝不覆盖明确表达
    if (existing && existing.source_kind === 'explicit') {
      return { ok: true, skipped: true, message: '存在明确表达，忽略行为推断', id: existing.id, item: this.mapMemory(existing) }
    }
    if (existing) {
      return { ok: true, skipped: true, message: '已有同类推断，跳过', id: existing.id, item: this.mapMemory(existing) }
    }
    const newId = this.tx(() => {
      const r = this.db
        .prepare(
          'INSERT INTO cognition_memory (section, content, source_kind, field_key, source_ref, status, recorded_at, last_confirmed_at, revision, manual_edited, confidence, created_at, updated_at)' +
            " VALUES (?, ?, 'inferred', ?, ?, ?, ?, NULL, 1, 0, ?, ?, ?)"
        )
        .run(section, content, fieldKey, sourceRef, isSensitive ? 'candidate' : 'active', now, confidence, now, now)
      const memoryId = Number(r.lastInsertRowid)
      this.appendHistory(this.getMemory(memoryId) as MemoryRow, 'create', 'agent', now)
      return memoryId
    })
    const message = isSensitive
      ? forcedSensitive
        ? '重要/敏感内容已存为候选，待确认'
        : '敏感/重要推断已存为候选，待确认'
      : '普通偏好已自动学习'
    return { ok: true, message, id: newId, item: this.mapMemory(this.getMemory(newId) as MemoryRow) }
  }

  /** 取某作用范围的生效规则（含 global），强制规则优先 */
  getRulesFor(scope: string): AgentRule[] {
    const s = asTrimmedString(scope, 60) ?? 'global'
    const rows = this.db
      .prepare(
        "SELECT * FROM cognition_rule WHERE enabled = 1 AND (scope = ? OR scope = 'global')" +
          " ORDER BY CASE enforcement WHEN 'mandatory' THEN 0 ELSE 1 END, id ASC"
      )
      .all(s) as unknown as RuleRow[]
    return rows.map((r) => this.mapRule(r))
  }

  /** 取某作用范围且条件匹配的生效规则，供 pipeline 确定性执行 */
  matchRules(scope: string, facts: Record<string, string | null | undefined>): AgentRule[] {
    return this.getRulesFor(scope).filter((r) => evaluateRuleConditions(r.conditions, facts))
  }
}

// ---------------------------------------------------------------------------
// 小工具（JSON 安全解析）
// ---------------------------------------------------------------------------

function safeParse(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function safeParseArray(v: string): unknown[] {
  const parsed = safeParse(v)
  return Array.isArray(parsed) ? parsed : []
}
