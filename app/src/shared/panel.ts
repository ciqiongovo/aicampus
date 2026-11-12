/** 面板契约：AI 推荐阅读 + 反馈动作。
 *  动作目录是唯一来源：渲染层、推荐提示词、反馈学习都从这里取，避免三处各写一套。 */

export const PANEL_ACTIONS = [
  {
    key: 'ignore',
    label: '忽略',
    hint: '不再出现在推荐里，并归档；会降低同类信息权重'
  },
  {
    key: 'archive',
    label: '归档',
    hint: '已阅收起，保留原邮件；不改变同类信息偏好'
  },
  {
    key: 'material',
    label: '存为资料',
    hint: '保留备查，不创建事项；会提高同类信息权重'
  },
  {
    key: 'schedule',
    label: '设为日程',
    hint: '按建议时间创建带提醒的日程'
  },
  {
    key: 'todo',
    label: '放入待办',
    hint: '创建待办事项（有截止时间则一并带上）'
  }
] as const

export type PanelActionKey = (typeof PANEL_ACTIONS)[number]['key']

export const PANEL_ACTION_KEYS: readonly PanelActionKey[] = PANEL_ACTIONS.map((a) => a.key)

export function isPanelAction(value: unknown): value is PanelActionKey {
  return typeof value === 'string' && (PANEL_ACTION_KEYS as readonly string[]).includes(value)
}

export function panelActionLabel(key: PanelActionKey): string {
  return PANEL_ACTIONS.find((a) => a.key === key)?.label ?? key
}

/** 单条反馈在“标准”灵敏度下的基础幅度；界面预览与实际加权共用同一组常量。 */
export const FEEDBACK_BASE = {
  /** 面板处置一封邮件对关心雷达单个维度的增减 */
  radarPanelAct: 0.35,
  /** 邮件标签 A/B/C/D 评级对单个维度的增减（A/D 的绝对值） */
  radarRating: 1,
  /** 单封邮件对一个关键词的基础权重 */
  emailKeyword: 0.32,
  /** 14 天内另一封邮件也正向处置时的额外权重 */
  emailRepeat: 0.12,
  /** 单条 QQ 结论对一个关键词的基础权重 */
  qqKeyword: 0.16,
  /** QQ 结论短期重复正向出现时的额外权重 */
  qqRepeat: 0.06
} as const

/** 反馈灵敏度：决定单条邮件/消息的反馈对权重的影响幅度。 */
export type FeedbackSensitivityLevel = 'veryLow' | 'low' | 'standard' | 'high' | 'veryHigh'

export interface FeedbackSensitivityOption {
  level: FeedbackSensitivityLevel
  label: string
  multiplier: number
  hint: string
}

/** 只改变之后的新反馈，不追溯已有画像。 */
export const FEEDBACK_SENSITIVITY_OPTIONS: readonly FeedbackSensitivityOption[] = [
  { level: 'veryLow', label: '极低', multiplier: 0.25, hint: '变化很小，画像更稳定，适合不希望被单条消息带偏。' },
  { level: 'low', label: '较低', multiplier: 0.5, hint: '偏保守，通常要多次反馈才会明显改变。' },
  { level: 'standard', label: '标准', multiplier: 1, hint: '默认幅度，兼顾稳定与适应。' },
  { level: 'high', label: '较高', multiplier: 1.5, hint: '单条反馈更明显，画像适应更快。' },
  { level: 'veryHigh', label: '很高', multiplier: 2, hint: '每次反馈都强烈改变权重，适合快速校准。' }
]

export const DEFAULT_FEEDBACK_SENSITIVITY: FeedbackSensitivityLevel = 'standard'

export function isFeedbackSensitivityLevel(value: unknown): value is FeedbackSensitivityLevel {
  return FEEDBACK_SENSITIVITY_OPTIONS.some((option) => option.level === value)
}

export function feedbackSensitivityOption(level: unknown): FeedbackSensitivityOption {
  return (
    FEEDBACK_SENSITIVITY_OPTIONS.find((option) => option.level === level) ??
    FEEDBACK_SENSITIVITY_OPTIONS.find((option) => option.level === DEFAULT_FEEDBACK_SENSITIVITY)!
  )
}

export function feedbackSensitivityMultiplier(level: unknown): number {
  return feedbackSensitivityOption(level).multiplier
}

export interface PanelSource {
  key: string
  label: string
  /** 适配器类型：email / manual / daily … 代码按 kind 分发，不按 key 写死 */
  kind: string
  enabled: boolean
  /** 来源栏徽标：面板读取时表示本批待处理条数；panelSources 返回待读池条数 */
  pending: number
}

export interface PanelRecommendation {
  id: number
  batchId: number
  infoId: number
  sourceKey: string
  sourceLabel: string
  /** 来源适配器类型（email / manual / daily…）；只有 email 使用八类主题与关心雷达 */
  sourceKind: string
  /** 所选邮箱中近三天发来、未读且带截止时间的邮件，独立于画像进入重点。 */
  urgent: boolean
  emailId: number | null
  title: string
  excerpt: string
  reason: string
  recommendedAction: PanelActionKey
  confidence: number
  score: number
  /** AI 判断；模型不可用时按相同主题/来源/时效权重降级。 */
  priority: 'focus' | 'other'
  /** 邮件原始接收时间；非邮件为信息产生时间。 */
  receivedAt: string
  /** 八类主题之一，仅邮件来源；其他来源为空串，界面不展示主题标签。 */
  topic: string
  topicLabel: string
  actionRequired: string | null
  deadlineAt: string | null
  eventStartAt: string | null
  /** 设为日程时使用的时间（UTC ISO）；无明确时间时为 null，由主进程给默认时间 */
  suggestedAt: string | null
  createdAt: string
}

export interface PanelLearningSignal {
  dimension: 'topic' | 'source'
  key: string
  label: string
  weight: number
  evidenceCount: number
}

export interface PanelKeywordProfile {
  keyword: string
  weight: number
  evidenceCount: number
  repeatCount: number
  /** 邮件反馈次数；邮件单次反馈权重高于 QQ。 */
  emailCount: number
  /** QQ 结论反馈次数；与邮件写入同一份全局画像。 */
  qqCount: number
  halfLifeDays: number
  lastSeenAt: string
}

export interface PanelKeywordMutation {
  ok: boolean
  message: string
  items: PanelKeywordProfile[]
}

export interface PanelOverviewQuery {
  /** 传入查询时默认 30，主进程上限 100；未传查询兼容旧的完整读取。 */
  mailDateRange?: 1 | 3 | 7 | 14 | 30 | 'older30'
  limit?: number
  /** info_id 降序游标；切来源、分组时重置，不是数组下标。 */
  beforeInfoId?: number
  priority?: 'focus' | 'other'
}

export interface PanelOverview {
  /** 当前来源、分组的完整待处理数量，不受分页游标影响。 */
  pendingTotal?: number
  /** 当前来源全部待处理的分组数量，不受分页及 priority 影响。 */
  priorityCounts?: { focus: number; other: number }
  /** 所有来源合计的重点条数；“重点”tab 的角标始终用它，切换来源不跳数。 */
  focusTotal?: number
  nextBeforeInfoId?: number | null
  /** 当前展示的批次；没有可读条目时为 null */
  batchId: number | null
  mode: 'initial' | 'continue' | 'empty'
  batchTotal: number
  batchProcessed: number
  /** 全部尚未分流且未推荐过的条数（含本批） */
  remaining: number
  windowDays: number
  sources: PanelSource[]
  recommendations: PanelRecommendation[]
  aiConfigured: boolean
  /** AI 不可用时的降级说明；正常时为空 */
  aiMessage: string
  /** 邮件来源的偏好信号；其他来源恒为空数组（各自偏好只在内部分流使用） */
  learning: PanelLearningSignal[]
  /** 全局关键词画像：邮件与 QQ 的处置反馈共同积累；邮件单次反馈权重更高。 */
  keywordProfile?: PanelKeywordProfile[]
  /** 与“我的关心”雷达共用的八类主题权重（0–10）；仅邮件来源返回，其他来源为空对象 */
  concerns: Record<string, number>
}

export interface PanelActResult {
  ok: boolean
  message: string
  action: PanelActionKey
  recommendationId: number
  itemId?: number
  /** 存为资料时自动归入的文件夹名称 */
  folder?: string
}

export interface PanelIngestInput {
  sourceKey?: string
  title: string
  content?: string
}

export interface PanelIngestResult {
  ok: boolean
  message: string
  id?: number
}

/** 「存为资料」后的回查条目已迁到独立资料栏（MaterialApi）。 */
export interface PanelApi {
  /** generate=false 只读现有推荐，不触发模型调用，供轮询和操作后的局部刷新使用。 */
  panelOverview(sourceKey?: string, generate?: boolean, query?: PanelOverviewQuery): Promise<PanelOverview>
  panelContinue(sourceKey?: string, query?: PanelOverviewQuery): Promise<PanelOverview>
  panelAct(recommendationId: number, action: PanelActionKey, materialFolder?: string): Promise<PanelActResult>
  panelIngest(input: PanelIngestInput): Promise<PanelIngestResult>
  panelSources(): Promise<PanelSource[]>
  /** 全局关键词画像（邮件 + QQ 反馈）；QQ 面板没有 PanelOverview 时单独读取。 */
  panelKeywordProfile(limit?: number): Promise<PanelKeywordProfile[]>
  /** 手动设置一个关键词的权重；返回更新后的完整画像。 */
  panelKeywordSet(keyword: string, weight: number): Promise<PanelKeywordMutation>
  /** 手动删除关键词及其反馈；返回更新后的完整画像。 */
  panelKeywordDelete(keyword: string): Promise<PanelKeywordMutation>
}
