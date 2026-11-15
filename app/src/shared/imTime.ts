/**
 * 时间工具：聊天记录里时间格式很杂，统一在这里兜住。
 * 独立原型阶段放在 shared 下；接入 知枢 时可并入 src/shared/utils.ts。
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** YYYY-MM-DD */
export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** YYYY-MM-DD HH:mm:ss */
export function formatLocalDateTime(d: Date): string {
  return `${formatLocalDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function nowLocal(): string {
  return formatLocalDateTime(new Date())
}

/** 该字符串是否已经是本地日期时间格式 */
export function isLocalDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
}

/**
 * 尽量宽松地解析时间：兼容
 * - 2026-10-17 09:12:00 / 2026-10-17T09:12:00 / 2026-10-17T09:12:00Z
 * - 2026/10/17 09:12
 * - 10 位或 13 位时间戳（秒 / 毫秒）
 * 解析不出来返回 null，绝不抛错。
 */
export function parseLooseDateTime(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return new Date(value < 1e12 ? value * 1000 : value)
  }
  const text = value.trim()
  if (!text) return null
  if (/^\d{10,13}$/.test(text)) return parseLooseDateTime(Number(text))
  const normalized = text.replace(/\//g, '-').replace(' ', 'T')
  const withSeconds = /T\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized
  const ts = Date.parse(withSeconds)
  if (Number.isNaN(ts)) return null
  return new Date(ts)
}

/** 统一成 YYYY-MM-DD HH:mm:ss；无法解析时原样返回 */
export function normalizeDateTime(value: string | number | null | undefined): string {
  const d = parseLooseDateTime(value)
  if (!d) return typeof value === 'string' ? value.trim() : ''
  return formatLocalDateTime(d)
}

/** YYYY-MM-DD */
export function dayOf(value: string | number | null | undefined): string {
  const d = parseLooseDateTime(value)
  return d ? formatLocalDate(d) : ''
}

/** 在 day 基础上加减天数，返回 YYYY-MM-DD */
export function addDays(day: string, delta: number): string {
  const d = parseLooseDateTime(`${day} 00:00:00`)
  if (!d) return day
  d.setDate(d.getDate() + delta)
  return formatLocalDate(d)
}

/** 秒级时间戳 */
export function epochSeconds(value: string | number | null | undefined): number {
  const d = parseLooseDateTime(value)
  return d ? Math.floor(d.getTime() / 1000) : 0
}
