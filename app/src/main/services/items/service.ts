import type { DatabaseSync } from 'node:sqlite'
import {
  createItem,
  createReminder,
  deleteItem,
  deleteReminder,
  getByEmailId,
  getEmail,
  getItem,
  markInfoAsItem,
  routeInfo,
  updateItem
} from '../../db'
import type { InfoDestination } from '../../db'
import { findDuplicateSchedule, linkEmailToSchedule } from './schedule-dedupe'

/** 事项写入服务（纯 DB，不依赖 electron）：确认邮件事项、手工事项、状态、提醒与信息流分流。
 *  面板页已删除；这里保留 Jarvis 工具与说明·后台队列共用的真实数据入口，渲染层不再直接调用。 */

export interface ItemOpResult {
  ok: boolean
  message: string
  id?: number
  /** 复用已有日程；调用方不得因此重建或重置提醒。 */
  reused?: boolean
}

export interface CreateItemFromEmailInput {
  /** 缺省取 analysis.action_required，其次邮件主题 */
  title?: string
  sourceEmailId?: number
  deadlineAt?: string
  deadlineKind?: string
  /** 给定时同事务创建提醒（UTC ISO） */
  remindAt?: string
  /** 设为日程时使用；缺省沿用邮件分析里的日程时间 */
  eventStartAt?: string | null
  eventEndAt?: string | null
  allDay?: boolean
  /** 只建日程、不沿用邮件分析出的截止时间（面板“设为日程”用） */
  eventOnly?: boolean
}

export interface CreateManualItemInput {
  title: string
  notes?: string
  category?: string | null
  deadlineAt?: string | null
  remindAt?: string | null
  eventStartAt?: string | null
  eventEndAt?: string | null
  allDay?: boolean
}

/** 提醒时间统一存 UTC ISO：调度器 now 也用 toISOString()，字符串比较才成立；无效日期返回 null */
export function toUtcIso(value: string): string | null {
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

/** 截止时间提前 N 分钟得到提醒时间；截止时间无法解析时返回 null */
function advanceIso(deadline: string, minutes: number): string | null {
  const t = new Date(deadline).getTime()
  if (Number.isNaN(t)) return null
  return new Date(t - minutes * 60_000).toISOString()
}

/** 确认事项：默认标题取 action_required，其次邮件主题；remindAt 给定时同事务建提醒。
 *  待办保留同邮件重复确认的拒绝语义；日程按来源/原文/标题时间复用，复用时不改提醒。
 *  未显式选提醒时间时按设置的默认提前时间自动建提醒（通知开关关闭则传入 null 不建）。 */
export function createItemFromEmail(
  db: DatabaseSync,
  input: CreateItemFromEmailInput,
  defaultAdvanceMinutes: number | null = null
): ItemOpResult {
  const emailId = input.sourceEmailId
  if (!emailId) return { ok: false, message: '缺少来源邮件，无法确认事项' }
  const email = getEmail(db, emailId)
  if (!email) return { ok: false, message: '来源邮件不存在（可能已被删除）' }
  const analysis = getByEmailId(db, emailId)
  const eventStart = input.eventStartAt ? toUtcIso(input.eventStartAt) : (analysis?.event_start_at ? toUtcIso(analysis.event_start_at) : null)
  const eventEnd = input.eventEndAt ? toUtcIso(input.eventEndAt) : null
  const isSchedule = Boolean(input.eventOnly || eventStart)
  // 普通待办保留原先的同邮件拒绝语义；日程走内容/时间去重，取消后的日程允许重建。
  if (!isSchedule) {
    const existing = db.prepare('SELECT id FROM items WHERE source_email_id = ?').get(emailId) as { id: number } | undefined
    if (existing) return { ok: false, message: '该邮件已确认为事项 #' + existing.id + '，请勿重复确认' }
  }
  const title =
    (input.title ?? '').trim() ||
    (analysis?.action_required ?? '').trim() ||
    (email?.subject ?? '').trim() ||
    '未命名事项'
  if (isSchedule) {
    const existing = findDuplicateSchedule(db, {
      title, sourceEmailId: emailId, eventStartAt: eventStart, eventEndAt: eventEnd, allDay: input.allDay
    })
    if (existing) {
      linkEmailToSchedule(db, emailId, existing.id)
      return { ok: true, id: existing.id, reused: true, message: '已存在相同日程，已复用 #' + existing.id }
    }
  }
  const deadline = input.eventOnly ? null : (input.deadlineAt ?? analysis?.deadline_at ?? null)
  const remindAt = input.remindAt
    ? toUtcIso(input.remindAt)
    : deadline && defaultAdvanceMinutes !== null
      ? advanceIso(deadline, defaultAdvanceMinutes)
      : null
  if (input.remindAt && !remindAt) return { ok: false, message: '提醒时间无效，请重新选择' }
  db.exec('SAVEPOINT sp_create_item_from_email')
  try {
    const id = createItem(db, {
      title,
      source_email_id: emailId,
      category: analysis?.category ?? null,
      status: '待处理',
      deadline_at: deadline,
      deadline_raw: input.eventOnly ? null : (analysis?.deadline_raw ?? null),
      deadline_kind: input.deadlineKind ?? analysis?.deadline_kind ?? null,
      event_start_at: eventStart,
      event_end_at: eventEnd,
      all_day: input.allDay ?? false,
      notes: analysis?.summary ?? ''
    })
    if (remindAt) createReminder(db, { item_id: id, remind_at: remindAt })
    // 确认事项即把对应信息流条目标记为「已分流到事项」
    if (isSchedule) linkEmailToSchedule(db, emailId, id)
    else markInfoAsItem(db, emailId, id)
    db.exec('RELEASE sp_create_item_from_email')
    return { ok: true, message: '已确认为事项', id }
  } catch (error) {
    db.exec('ROLLBACK TO sp_create_item_from_email')
    db.exec('RELEASE sp_create_item_from_email')
    return { ok: false, message: `创建事项失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 手工事项（无来源邮件）。标题必填；remindAt 缺省时按默认提前时间从 deadlineAt 推算（开关关闭则 null）。 */
export function createManualItem(
  db: DatabaseSync,
  input: CreateManualItemInput,
  defaultAdvanceMinutes: number | null = null
): ItemOpResult {
  const title = (input.title ?? '').trim()
  if (!title) return { ok: false, message: '事项标题不能为空' }
  const eventStart = input.eventStartAt ? toUtcIso(input.eventStartAt) : null
  const eventEnd = input.eventEndAt ? toUtcIso(input.eventEndAt) : null
  if (eventStart) {
    const existing = findDuplicateSchedule(db, { title, eventStartAt: eventStart, eventEndAt: eventEnd, allDay: input.allDay })
    if (existing) return { ok: true, id: existing.id, reused: true, message: '已存在相同日程，已复用 #' + existing.id }
  }
  const deadline = input.deadlineAt ? toUtcIso(input.deadlineAt) : null
  const remindAt = input.remindAt
    ? toUtcIso(input.remindAt)
    : deadline && defaultAdvanceMinutes !== null
      ? advanceIso(deadline, defaultAdvanceMinutes)
      : null
  if (input.remindAt && !remindAt) return { ok: false, message: '提醒时间无效，请重新选择' }
  db.exec('SAVEPOINT sp_create_manual_item')
  try {
    const id = createItem(db, {
      title,
      source_email_id: null,
      category: input.category ?? null,
      status: '待处理',
      deadline_at: deadline,
      deadline_kind: deadline ? 'deadline' : null,
      event_start_at: eventStart,
      event_end_at: eventEnd,
      all_day: input.allDay ?? false,
      notes: input.notes ?? ''
    })
    if (remindAt) createReminder(db, { item_id: id, remind_at: remindAt })
    db.exec('RELEASE sp_create_manual_item')
    return { ok: true, message: '已创建事项', id }
  } catch (error) {
    db.exec('ROLLBACK TO sp_create_manual_item')
    db.exec('RELEASE sp_create_manual_item')
    return { ok: false, message: `创建事项失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function deleteItemById(db: DatabaseSync, id: number): ItemOpResult {
  deleteItem(db, id)
  return { ok: true, message: '已删除事项' }
}

/** 事项状态白名单：待处理/进行中/等待回复/已完成/已取消，外加 DB 默认值待核实 */
const ITEM_STATUS_VALUES = ['待处理', '进行中', '等待回复', '已完成', '已取消', '待核实'] as const

export function setItemStatus(db: DatabaseSync, id: number, status: string): ItemOpResult {
  if (!(ITEM_STATUS_VALUES as readonly string[]).includes(status)) {
    return { ok: false, message: `无效状态：${status}` }
  }
  const changed = updateItem(db, id, { status })
  if (!changed) return { ok: false, message: '事项不存在' }
  // 终态事项不再发提醒——未触发的提醒就地取消
  if (status === '已完成' || status === '已取消') {
    db.prepare("UPDATE reminders SET status = 'cancelled', error = '事项已结束，提醒自动取消' WHERE item_id = ? AND status = 'pending'").run(id)
  }
  return { ok: true, message: '状态已更新' }
}

export function createItemReminder(db: DatabaseSync, itemId: number, remindAt: string): ItemOpResult {
  if (!getItem(db, itemId)) return { ok: false, message: '事项不存在' }
  const utc = toUtcIso(remindAt)
  if (!utc) return { ok: false, message: '提醒时间无效，请重新选择' }
  // 改期语义：新提醒替代该事项所有未触发提醒，避免同一事项重复弹出
  db.prepare("UPDATE reminders SET status = 'cancelled', error = '已被更新的提醒替代' WHERE item_id = ? AND status = 'pending'").run(itemId)
  const id = createReminder(db, { item_id: itemId, remind_at: utc })
  return { ok: true, message: '已添加提醒', id }
}

export function deleteItemReminder(db: DatabaseSync, id: number): ItemOpResult {
  deleteReminder(db, id)
  return { ok: true, message: '已删除提醒' }
}

/**
 * 分流信息流条目。四去向：
 * - item：把条目转为事项（邮件走 createItemFromEmail，非邮件走 createManualItem，均幂等），条目联上事项；
 * - keep：保留为资料；- archive：归档（≠删除，可在「已分流」里回查）；- unverified：退回待核实。
 */
export function routeInfoEntry(
  db: DatabaseSync,
  id: number,
  destination: string,
  remindAt: string | null,
  defaultAdvanceMinutes: number | null = null
): ItemOpResult {
  const whitelist = ['item', 'keep', 'archive', 'unverified'] as const
  if (!(whitelist as readonly string[]).includes(destination)) {
    return { ok: false, message: `无效去向：${destination}` }
  }
  const info = db.prepare('SELECT * FROM info WHERE id = ?').get(id) as
    | {
        source_type: string
        source_email_id: number | null
        title: string
        content: string
        category: string | null
        destination: string
        item_id: number | null
      }
    | undefined
  if (!info) return { ok: false, message: '信息流条目不存在' }
  if (destination === 'item') {
    // 幂等：已转为事项的条目直接复用，避免重复建事项
    if (info.destination === 'item' && info.item_id) {
      return { ok: true, message: '已转为事项', id: info.item_id }
    }
    db.exec('SAVEPOINT sp_route_info_entry')
    try {
      let itemId: number | undefined
      let reused: boolean | undefined
      if (info.source_email_id) {
        // 邮件来源：走 createItemFromEmail（含来源邮件幂等与默认提醒逻辑）
        const created = createItemFromEmail(
          db,
          { sourceEmailId: info.source_email_id, remindAt: remindAt ?? undefined },
          defaultAdvanceMinutes
        )
        if (!created.ok) {
          db.exec('ROLLBACK TO sp_route_info_entry')
          db.exec('RELEASE sp_route_info_entry')
          return created
        }
        itemId = created.id
        reused = created.reused
      } else {
        // 非邮件来源：用内容直接建手工事项（不再依赖 source_email_id）
        const created = createManualItem(
          db,
          {
            title: info.title,
            notes: info.content,
            category: info.category,
            deadlineAt: null,
            remindAt: remindAt ?? undefined
          },
          defaultAdvanceMinutes
        )
        if (!created.ok) {
          db.exec('ROLLBACK TO sp_route_info_entry')
          db.exec('RELEASE sp_route_info_entry')
          return created
        }
        itemId = created.id
        reused = created.reused
      }
      if (itemId) routeInfo(db, id, 'item', itemId)
      db.exec('RELEASE sp_route_info_entry')
      return { ok: true, message: reused ? '已存在相同日程，已复用 #' + itemId : '已转为事项', id: itemId, ...(reused ? { reused: true } : {}) }
    } catch (error) {
      db.exec('ROLLBACK TO sp_route_info_entry')
      db.exec('RELEASE sp_route_info_entry')
      return { ok: false, message: '转为事项失败：' + (error instanceof Error ? error.message : String(error)) }
    }
  }
  if (!routeInfo(db, id, destination as InfoDestination)) {
    return { ok: false, message: '分流失败，请稍后再试' }
  }
  const label = destination === 'keep' ? '已保留为资料' : destination === 'archive' ? '已归档' : '已退回待核实'
  return { ok: true, message: label }
}
