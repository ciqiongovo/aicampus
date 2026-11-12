import type { DatabaseSync } from 'node:sqlite'
import { getEmail } from '../../db'
import type { EmailRow, ItemRow } from '../../db'

export interface ScheduleIdentityInput {
  title: string
  sourceEmailId?: number | null
  eventStartAt?: string | null
  eventEndAt?: string | null
  allDay?: boolean
}

/** Only presentation differences are ignored; never truncate content or use an AI summary as identity. */
function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/gu, ' ').trim()
}

function instant(value: string | null | undefined): number | null {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeText(value)
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]))
  }
  return value
}

function originalContent(email: EmailRow): string | null {
  const subject = normalizeText(email.subject)
  // HTML-only originals remain complete, including links; stripping tags could hide different event URLs.
  const body = normalizeText(email.body_text.trim() ? email.body_text : email.body_html)
  let attachments: string
  try {
    attachments = JSON.stringify(stableValue(JSON.parse(email.attachments_json || '[]')))
  } catch {
    attachments = normalizeText(email.attachments_json)
  }
  if (!subject && !body && attachments === '[]') return null
  return JSON.stringify([subject, body, attachments])
}

/** These are actions, not event names. Different original emails must not collide on e.g. “报名”. */
function isGenericAction(title: string): boolean {
  return /^(?:(?:请|请尽快|尽快|及时|务必)\s*)?(?:报名|参会|参加|参加会议|参加活动|注册|确认|回复|查看|了解|关注|提交|处理|办理|缴费|申请)[。.!！]?$/.test(normalizeText(title))
}

/**
 * Read-only schedule lookup shared by email/manual/todo creation and panel promotion.
 * A source email (including a previously routed duplicate email) or its complete original
 * content may match without dates, so a default “tomorrow” advancing does not create another event.
 * Otherwise require a meaningful normalized title, equal start/end instants and all-day mode.
 * Unscheduled todos and cancelled events are never candidates; reminders are never touched.
 */
export function findDuplicateSchedule(db: DatabaseSync, input: ScheduleIdentityInput): ItemRow | undefined {
  const schedules = (db.prepare("SELECT * FROM items WHERE event_start_at IS NOT NULL AND status != '已取消' ORDER BY id ASC").all() as unknown as ItemRow[])
    .filter((row) => instant(row.event_start_at) !== null)
  if (schedules.length === 0) return undefined

  const sources = new Map<number, Set<number>>()
  for (const row of schedules) sources.set(row.id, new Set(row.source_email_id ? [row.source_email_id] : []))
  const links = db.prepare("SELECT item_id, source_email_id FROM info WHERE source_type = 'email' AND item_id IS NOT NULL AND source_email_id IS NOT NULL").all() as Array<{ item_id: number; source_email_id: number }>
  for (const link of links) sources.get(link.item_id)?.add(link.source_email_id)

  if (input.sourceEmailId) {
    const sameSource = schedules.find((row) => sources.get(row.id)!.has(input.sourceEmailId!))
    if (sameSource) return sameSource
    const email = getEmail(db, input.sourceEmailId)
    const content = email ? originalContent(email) : null
    if (content) {
      const originalCache = new Map<number, string | null>()
      for (const row of schedules) {
        for (const sourceId of sources.get(row.id)!) {
          if (!originalCache.has(sourceId)) {
            const original = getEmail(db, sourceId)
            originalCache.set(sourceId, original ? originalContent(original) : null)
          }
          if (originalCache.get(sourceId) === content) return row
        }
      }
    }
  }

  const title = normalizeText(input.title)
  const start = instant(input.eventStartAt)
  if (!title || start === null) return undefined
  // The content/source checks above are the only safe identity for generic email actions.
  if (input.sourceEmailId && isGenericAction(title)) return undefined
  const end = instant(input.eventEndAt)
  return schedules.find((row) =>
    !(sources.get(row.id)!.size > 0 && isGenericAction(row.title)) &&
    normalizeText(row.title) === title &&
    instant(row.event_start_at) === start &&
    instant(row.event_end_at) === end &&
    Boolean(row.all_day) === Boolean(input.allDay)
  )
}

/** Link the current email, including repairing a link to a cancelled event being recreated. */
export function linkEmailToSchedule(db: DatabaseSync, emailId: number, itemId: number): void {
  db.prepare(
    "UPDATE info SET destination = 'item', item_id = ?, status = 'routed', routed_at = datetime('now','localtime')" +
      " WHERE source_type = 'email' AND source_email_id = ? AND (destination != 'item' OR item_id IS NOT ?)"
  ).run(itemId, emailId, itemId)
}
