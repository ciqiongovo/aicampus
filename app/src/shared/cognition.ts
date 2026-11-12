/**
 * 画像记忆 / 长期规则 / 权限策略 —— 前后端共享契约。
 *
 * 单一来源：本文件同时被
 *   - src/main/services/jarvis/cognition.ts（主进程 CognitionService 实现 CognitionServiceContract）；
 *   - src/preload/index.ts（渲染层白名单 API，消费 CognitionApi）；
 *   - 设置页 UI、Agent / pipeline（relevantMemories、learn、getRulesFor、matchRules）消费。
 *
 * 约定：
 * - 记忆每条必备 内容(content) / 来源(sourceRef,sourceKind) / 记录时间(recordedAt) / 最后确认时间(lastConfirmedAt)；
 * - 未确认推断 lastConfirmedAt = null（不伪造确认时间）；明确表达 sourceKind='explicit'（天然视为已确认）；
 * - 删除 = 停用（status='archived'），保留历史，不做物理遗忘；
 * - 权限策略只在「设置」IPC 暴露 agentPolicySet，绝不暴露给模型工具，Agent 不得自行扩大权限；
 * - 主进程服务方法同步；渲染层经 IPC 返回 Promise（CognitionApi）。
 */

/** IPC 通道常量（主进程 handle / 渲染层 invoke 共用） */
export const COGNITION_IPC = {
  memoryList: 'cognition:memory-list',
  memorySave: 'cognition:memory-save',
  memoryConfirm: 'cognition:memory-confirm',
  memoryArchive: 'cognition:memory-archive',
  memoryHistory: 'cognition:memory-history',
  agentPolicyGet: 'cognition:policy-get',
  agentPolicySet: 'cognition:policy-set',
  agentRulesList: 'cognition:rules-list',
  agentRuleSave: 'cognition:rule-save',
  agentRuleDelete: 'cognition:rule-delete'
} as const

// ---------------------------------------------------------------------------
// 记忆
// ---------------------------------------------------------------------------

/** 来源性质：explicit=用户明确表达（天然已确认）；inferred=行为推断（未确认前不得当作事实） */
export type MemorySourceKind = 'explicit' | 'inferred'

/** active=当前可用；candidate=待确认候选推断；archived=已停用（保留历史） */
export type MemoryStatus = 'active' | 'candidate' | 'archived'

/** 来源结构引用（定位到消息/行为/邮件/资讯等具体资源，不复制隐私原文） */
export interface MemorySourceRef {
  /** 'chat' | 'mail' | 'behavior' | 'daily' | 'manual' | 'legacy' | 其它自定义 */
  type: string
  /** 资源稳定标识（邮件 id / 资讯 id / 会话 id / 行为 id …） */
  id?: string | number
  /** 人类可读标签，如来源标题/发件人/平台名 */
  label?: string
  /** 证据摘录（尽量短，可选）；learn 时主代理应把最新用户原话放进这里 */
  excerpt?: string
}

/** 记忆的当前行（分区卡片单位；历史版本见 MemoryHistoryEntry） */
export interface MemoryItem {
  id: number
  /** 分区卡片：'background' | 'goal' | 'interest' | 'habit' | 'identity' | 自定义（默认 'general'） */
  section: string
  /** 稳定语义键（字段/主题）；同 key 冲突检测与显式修正；无则为 null（如 'grade' / 'major' / 'python_preference'） */
  fieldKey: string | null
  content: string
  sourceKind: MemorySourceKind
  sourceRef: MemorySourceRef
  status: MemoryStatus
  /** 记录时间（ISO 8601，带时区；旧数据可能为 UTC 无时区串，语义按 UTC 处理） */
  recordedAt: string
  /** 最后确认时间（ISO 8601）；未确认推断为 null */
  lastConfirmedAt: string | null
  /** 内容版本号：内容/来源/分区变化 +1；仅确认刷新时间不 +1 */
  revision: number
  /** 是否人工编辑（人工编辑优先于自动推断） */
  manualEdited: boolean
  /** 置信度辅助信号（0~1；不是授权，不替代用户确认） */
  confidence: number | null
  /** 便捷派生：是否待确认候选 */
  candidate: boolean
  /** 便捷派生：是否推断（弱信号） */
  inferred: boolean
}

export interface MemoryListQuery {
  /** 分区卡片过滤 */
  section?: string
  /** 关键词（匹配 content / section / 来源标签） */
  keyword?: string
  /** 是否包含已归档；默认 false */
  includeArchived?: boolean
  /** 状态过滤；默认返回 active + candidate */
  status?: MemoryStatus | 'all'
}

export interface MemorySaveInput {
  /** 有 id = 编辑既有记忆（人工编辑，确认并可能 +1 版本）；无 id = 新建明确记忆 */
  id?: number
  section?: string
  /** 稳定语义键；同 key 的既有记忆会被更新（形成版本/历史）而非另起新行 */
  fieldKey?: string
  content: string
  /** 缺省 'explicit'（人工录入视为明确表达） */
  sourceKind?: MemorySourceKind
  sourceRef?: MemorySourceRef
  confidence?: number | null
}

export interface MemorySaveResult {
  ok: boolean
  message: string
  id?: number
  item?: MemoryItem
}

export interface MemoryOpResult {
  ok: boolean
  message: string
  item?: MemoryItem
}

export interface MemoryHistoryEntry {
  id: number
  memoryId: number
  revision: number
  content: string
  sourceKind: MemorySourceKind
  sourceRef: MemorySourceRef
  section: string
  fieldKey: string | null
  status: MemoryStatus
  recordedAt: string
  lastConfirmedAt: string | null
  changedBy: string
  /** create=新建；update=内容/来源/分区变化；confirm=仅刷新确认时间；promote=候选转确认；archive=停用 */
  changeKind: 'create' | 'update' | 'confirm' | 'promote' | 'archive'
  changedAt: string
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

export type RuleEnforcement = 'mandatory' | 'preference'

/** 规则动作类型（程序可执行，不只是自然语言） */
export const RULE_ACTION_TYPES = ['route_info', 'require_deadline', 'set_category', 'notify'] as const
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number]

/** 规则条件谓词（AND 组合；程序可按业务字段确定性校验） */
export interface RuleCondition {
  /** 业务字段：'category' | 'from' | 'subject' | 'body' | 'title' | 'deadline' | 'has_deadline' | 其它 */
  field: string
  op: 'eq' | 'neq' | 'contains' | 'missing' | 'present'
  value?: string
}

/** 规则动作（带参数；route_info 支持邮件分流/分类，require_deadline 表示事项须展示可靠日期或「待补充」但不阻止创建） */
export interface RuleAction {
  type: RuleActionType
  params?: Record<string, string | number | boolean | null>
}

export interface AgentRuleInput {
  /** 有 id = 编辑既有规则（revision +1）；无 id = 新建 */
  id?: number
  /** 作用范围：'mail' | 'item' | 'info' | 'daily' | 'agent' | 'global' | 其它 */
  scope?: string
  name: string
  description?: string
  /** 缺省 'mandatory'（强制规则由程序校验） */
  enforcement?: RuleEnforcement
  conditions?: RuleCondition[]
  action: RuleAction
  /** 缺省 true */
  enabled?: boolean
  /** 修改来源（聊天规则由主代理绑定确认后填写，如 'chat:confirmed' / 'user'） */
  modifiedBy?: string
}

export interface AgentRule {
  id: number
  scope: string
  name: string
  description: string
  conditions: RuleCondition[]
  action: RuleAction
  enforcement: RuleEnforcement
  enabled: boolean
  revision: number
  modifiedBy: string
  createdAt: string
  updatedAt: string
}

export interface RuleOpResult {
  ok: boolean
  message: string
  id?: number
  rule?: AgentRule
}

// ---------------------------------------------------------------------------
// 权限策略
// ---------------------------------------------------------------------------

/** 数据读范围（业务域名白名单）。对应主代理 AGENT_TOOLS 的业务域：email/info/item/reminder/daily/article */
export const READ_DOMAIN_DEFAULT = ['email', 'info', 'item', 'reminder', 'daily', 'article'] as const

/**
 * 默认分级确认（与主代理 AGENT_TOOLS 对齐）：
 * - writeAuto：普通可撤销操作自动执行（不逐条打断）；
 * - writeConfirm：高风险（永久删除/规则变更/对外发送）确认后执行；
 * - writeDeny：明确禁止（默认空）。
 */
export interface AgentPolicy {
  readDomains: string[]
  /** 普通写入：自动执行（可撤销） */
  writeAuto: string[]
  /** 高风险写入：确认后执行 */
  writeConfirm: string[]
  /** 明确禁止（默认空） */
  writeDeny: string[]
  learningEnabled: boolean
  backgroundEnabled: boolean
  /** 相关旧话题新鲜期（天）；超过需先重确认；默认 30，可配置 */
  memoryFreshnessDays: number
  /** IANA 时区（用于日期语义与界面相对时间），默认 'Asia/Shanghai' */
  timeZone: string
}

export type AgentPolicyPatch = Partial<AgentPolicy>

export interface PolicyOpResult {
  ok: boolean
  message: string
  policy?: AgentPolicy
}

/** 默认分级确认策略（唯一单例行，id=1） */
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  readDomains: [...READ_DOMAIN_DEFAULT],
  writeAuto: ['create_item', 'update_item', 'route_info', 'route_article', 'save_info', 'mail_flags', 'create_reminder', 'learn_memory', 'set_category'],
  writeConfirm: ['delete_item', 'delete_reminder', 'propose_rule', 'reconfirm_memory'],
  writeDeny: [],
  learningEnabled: true,
  backgroundEnabled: true,
  memoryFreshnessDays: 30,
  timeZone: 'Asia/Shanghai'
}

// ---------------------------------------------------------------------------
// 画像检索 / 学习（主进程 Agent 与 pipeline 使用，不经渲染层 IPC）
// ---------------------------------------------------------------------------

/** 相关记忆结果：fresh=当前可用；stale=超过新鲜期待重确认；candidate=未确认候选推断 */
export interface RelevantMemoriesResult {
  fresh: MemoryItem[]
  stale: MemoryItem[]
  candidate: MemoryItem[]
}

/** LLM 认知变化落库输入 */
export interface LearnInput {
  content: string
  section?: string
  /** 稳定语义键：同 key 下明确优先/推断不覆盖/显式修正更新同 id；无 key 则保守按内容精确匹配 */
  fieldKey?: string
  /** 缺省 'inferred'（模型默认按推断处理；用户明确表达传 'explicit'） */
  sourceKind?: MemorySourceKind
  /** 仅对 inferred 生效：'ordinary'=普通偏好自动学习；'sensitive'/'important'=敏感/重要 → candidate */
  sensitivity?: 'ordinary' | 'sensitive' | 'important'
  sourceRef?: MemorySourceRef
  /**
   * 最新用户原话片段（主代理必须从最新用户消息中取）。
   * explicit 仅当 content 为该原话的字面片段时才成立，否则服务自动降级为 inferred。
   */
  sourceQuote?: string
  confidence?: number | null
}

export interface LearnResult {
  ok: boolean
  message: string
  id?: number
  item?: MemoryItem
  /** 因已存在明确表达 / 同类推断而跳过落库 */
  skipped?: boolean
}

// ---------------------------------------------------------------------------
// 契约：主进程同步服务 / 渲染层 Promise API
// ---------------------------------------------------------------------------

/** 主进程 CognitionService 同步契约（类实现此接口；额外提供 relevantMemories/learn/getRulesFor/matchRules） */
export interface CognitionServiceContract {
  memoryList(query?: MemoryListQuery): MemoryItem[]
  memorySave(input: MemorySaveInput): MemorySaveResult
  memoryConfirm(id: number): MemoryOpResult
  memoryArchive(id: number): MemoryOpResult
  memoryHistory(id: number): MemoryHistoryEntry[]
  agentPolicyGet(): AgentPolicy
  agentPolicySet(patch: AgentPolicyPatch): PolicyOpResult
  agentRulesList(): AgentRule[]
  agentRuleSave(input: AgentRuleInput): RuleOpResult
  agentRuleDelete(id: number): RuleOpResult
}

/** 渲染层 IPC 契约：每个方法经 IPC 后返回 Promise（对应 RendererApi 的方法形态） */
export type CognitionApi = {
  [K in keyof CognitionServiceContract]: (
    ...args: Parameters<CognitionServiceContract[K]>
  ) => Promise<ReturnType<CognitionServiceContract[K]>>
}
