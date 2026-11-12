/** 日程与待办的共享契约：清单/事项行、视图统计、快速添加解析（渲染层与主进程共用，纯函数可测） */

export interface TodoListRow {
  id: number
  name: string
  color: string
  sortOrder: number
  createdAt: string
  /** 未完成条数（服务端算好，左侧清单直接展示） */
  openCount: number
}

/** 待办 / 日程条目：items 表 + 清单名与颜色（v14 起同一张表同时承载待办与日程） */
export interface TodoItemRow {
  id: number
  title: string
  notes: string
  status: string
  /** 0 无 / 1 低 / 2 中 / 3 高 */
  priority: number
  listId: number | null
  listName: string | null
  listColor: string | null
  deadlineAt: string | null
  deadlineKind: string | null
  eventStartAt: string | null
  eventEndAt: string | null
  allDay: boolean
  completedAt: string | null
  sourceEmailId: number | null
  createdAt: string
}

export interface TodoCounts {
  /** 今天到期/进行，含已过期未完成 */
  today: number
  next7: number
  inbox: number
  completed: number
  open: number
  overdue: number
  /** 未指定时间也未指定清单的条目（TickTick 的收集箱语义） */
  undated: number
}

export interface TodoSnapshot {
  lists: TodoListRow[]
  items: TodoItemRow[]
  counts: TodoCounts
  /** 服务端当前时间（ISO），用于渲染层对齐「今天」 */
  now: string
}

export interface TodoCreateInput {
  title: string
  notes?: string
  listId?: number | null
  priority?: number
  deadlineAt?: string | null
  eventStartAt?: string | null
  eventEndAt?: string | null
  allDay?: boolean
  sourceEmailId?: number | null
}

export interface TodoPatch {
  title?: string
  notes?: string
  listId?: number | null
  priority?: number
  deadlineAt?: string | null
  eventStartAt?: string | null
  eventEndAt?: string | null
  allDay?: boolean
  status?: string
}

export interface TodoOpResult {
  ok: boolean
  error?: string
  item?: TodoItemRow
  list?: TodoListRow
}

export interface TodoApi {
  todoBatch(ids: number[], action: 'delete' | 'complete' | 'move', listId?: number | null): Promise<TodoOpResult>
  todoSnapshot(): Promise<TodoSnapshot>
  todoCreateItem(input: TodoCreateInput): Promise<TodoOpResult>
  todoUpdateItem(id: number, patch: TodoPatch): Promise<TodoOpResult>
  todoToggleItem(id: number, completed: boolean): Promise<TodoOpResult>
  todoDeleteItem(id: number): Promise<TodoOpResult>
  todoCreateList(name: string, color?: string): Promise<TodoOpResult>
  todoUpdateList(id: number, patch: { name?: string; color?: string }): Promise<TodoOpResult>
  todoDeleteList(id: number): Promise<TodoOpResult>
}

/** 清单配色：低饱和，和 C 索引风格的白底细线共存 */
export const TODO_COLORS = ['#B4372F', '#8A6A16', '#2F6B4F', '#2E5A88', '#6B4A88', '#5C5C5C'] as const

export const PRIORITY_LABELS: Record<number, string> = { 0: '无优先级', 1: '低', 2: '中', 3: '高' }

/** 事项状态：与面板保持一致（v14 之前就存在） */
export const TODO_DONE_STATUS = '已完成'
export const TODO_OPEN_STATUS = '待处理'

const DAY_MS = 86400000

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfLocalDay(a).getTime() - startOfLocalDay(b).getTime()) / DAY_MS)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地日期时间 → 带时区的 ISO 字符串（落库统一用这个格式，字符串比较即时间比较） */
export function localIso(d: Date): string {
  return new Date(d.getTime()).toISOString()
}

export interface DueLabel {
  text: string
  tone: 'overdue' | 'today' | 'soon' | 'future' | 'none'
}

/** 截止/事件时间的人话标签：今天 15:00 / 明天 / 周X / 10月9日 / 已过期 3 天；withTime=false 时只给出日期粒度（全天条目用） */
export function dueLabel(iso: string | null, now: Date = new Date(), withTime = true): DueLabel {
  if (!iso) return { text: '无日期', tone: 'none' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { text: iso, tone: 'none' }
  const diff = dayDiff(d, now)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const showClock = withTime && !(d.getHours() === 23 && d.getMinutes() === 59)
  const withClock = (text: string): string => (showClock ? `${text} ${clock}` : text)
  if (diff < 0) return { text: `已过期 ${-diff} 天`, tone: 'overdue' }
  if (diff === 0) return { text: withClock('今天'), tone: 'today' }
  if (diff === 1) return { text: withClock('明天'), tone: 'soon' }
  if (diff === 2) return { text: withClock('后天'), tone: 'soon' }
  if (diff < 7) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return { text: withClock(names[d.getDay()]!), tone: 'future' }
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return { text: withClock(date), tone: 'future' }
}

/** 时刻区间标签：8:15 - 9:55 / 全天 */
export function clockRange(startIso: string, endIso: string | null, allDay = false): string {
  if (allDay) return '全天'
  const s = new Date(startIso)
  if (Number.isNaN(s.getTime())) return ''
  const head = `${pad(s.getHours())}:${pad(s.getMinutes())}`
  if (!endIso) return head
  const e = new Date(endIso)
  if (Number.isNaN(e.getTime())) return head
  return `${head} - ${pad(e.getHours())}:${pad(e.getMinutes())}`
}

const REL_DAYS: Array<[string, number]> = [
  ['大后天', 3],
  ['大前天', -3],
  ['后天', 2],
  ['前天', -2],
  ['明天', 1],
  ['明日', 1],
  ['昨天', -1],
  ['今日', 0],
  ['今天', 0]
]

const WEEKDAY_MAP: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 }

export interface QuickAddResult {
  /** 去掉日期时间词后的标题（全是词时保留原文） */
  title: string
  deadlineAt: string | null
  hasDate: boolean
  hasTime: boolean
}

/**
 * 快速添加解析：「明天 15:00 交作业」「下周二 组会」「10月20日 报名截止」「20:30 跑步」。
 * 规则：先摘日期词（相对日/周X/月日），再摘时刻词；只给时刻按今天算，只给日期按当天 23:59 算。
 * 解析不出任何时间时返回 null，调用方按「无日期」落库。
 */
export function parseQuickAdd(text: string, now: Date = new Date()): QuickAddResult {
  const original = text.replace(/\u3000/g, ' ').trim()
  let rest = original
  let dayDelta: number | null = null
  let monthDay: { month: number; day: number } | null = null
  let hour: number | null = null
  let minute = 0
  let hasTime = false
  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re)
    if (!m) return null
    rest = (rest.slice(0, m.index ?? 0) + ' ' + rest.slice((m.index ?? 0) + m[0].length)).trim()
    return m
  }

  const rel = take(new RegExp(REL_DAYS.map(([w]) => w).join('|')))
  if (rel) {
    dayDelta = REL_DAYS.find(([w]) => w === rel[0])![1]
  }
  if (dayDelta === null) {
    const wk = take(/(下下|下|这|本)?(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/)
    if (wk) {
      const weekOffset = wk[1] === '下' ? 1 : wk[1] === '下下' ? 2 : 0
      const target = WEEKDAY_MAP[wk[2]!]!
      const today = startOfLocalDay(now)
      const todayIdx = today.getDay()
      const monday = new Date(today.getTime() - ((todayIdx + 6) % 7) * DAY_MS)
      let targetDate = new Date(monday.getTime() + (weekOffset * 7 + (target === 0 ? 6 : target - 1)) * DAY_MS)
      if (weekOffset === 0 && targetDate.getTime() < today.getTime()) targetDate = new Date(targetDate.getTime() + 7 * DAY_MS)
      dayDelta = Math.round((targetDate.getTime() - today.getTime()) / DAY_MS)
    }
  }
  if (dayDelta === null) {
    // 前面必须是行首或空白，避免把「项目1-2」这类标题误判成 1 月 2 日
    const abs = take(/(?<!\S)(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/)
    if (abs && (abs[1] || /[月日号]/.test(abs[0]) || /[-/]/.test(abs[0]))) {
      const month = Number(abs[2])
      const day = Number(abs[3])
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) monthDay = { month, day }
    }
  }
  const timeM = take(/(上午|下午|中午|晚上|早上|凌晨)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(半|(\d{1,2})\s*分?)?)/)
  if (timeM) {
    let h = Number(timeM[2])
    const meridiem = timeM[1] ?? ''
    if (timeM[3] !== undefined) minute = Math.min(59, Number(timeM[3]))
    else if (timeM[4] === '半') minute = 30
    else if (timeM[5] !== undefined) minute = Math.min(59, Number(timeM[5]))
    if ((meridiem === '下午' || meridiem === '晚上') && h < 12) h += 12
    if (meridiem === '中午' && h < 11) h += 12
    if (meridiem === '凌晨' && h === 12) h = 0
    if (h >= 0 && h <= 23) {
      hour = h
      hasTime = true
    }
  }

  const title = rest.replace(/\s{2,}/g, ' ').replace(/^[\s,，、;；:：-]+|[\s,，、;；:：-]+$/g, '').trim()
  const base = startOfLocalDay(now)
  const target = new Date(base.getTime())
  if (monthDay) {
    target.setMonth(monthDay.month - 1, monthDay.day)
    // 只写月日时补全年份：已过去超过半年的按明年算（12 月写下个月 1 日）
    if (target.getTime() < base.getTime() - 180 * DAY_MS) target.setFullYear(target.getFullYear() + 1)
  } else {
    target.setDate(target.getDate() + (dayDelta ?? 0))
  }
  const hasDate = dayDelta !== null || monthDay !== null
  if (!hasDate && !hasTime) return { title: original, deadlineAt: null, hasDate: false, hasTime: false }
  target.setHours(hour ?? 23, hour === null ? 59 : minute, 0, 0)
  return { title: title.length > 0 ? title : original, deadlineAt: localIso(target), hasDate, hasTime }
}
