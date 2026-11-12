import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Segmented, Tooltip } from 'antd'
import { LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import type { TodoItemRow } from '@shared/todo'
import { TodoItemDialog, type TodoDialogDefaults } from '../todo/TodoItemDialog'
import { dayKey, useTodoSnapshot } from '../todo/store'
import './schedule.css'

const HOUR_H = 46
const DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

interface Block {
  item: TodoItemRow
  startMin: number
  endMin: number
  col: number
  cols: number
}

function minutesOf(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function eventAnchor(item: TodoItemRow): string | null {
  return item.eventStartAt ?? item.deadlineAt
}

/** 同一天里时间重叠的条目并排：先按开始时间聚簇，簇内贪心分配列号 */
function layoutDay(items: TodoItemRow[]): Block[] {
  const entries = items
    .map((item) => {
      const anchor = eventAnchor(item)
      if (!anchor) return null
      const startMin = minutesOf(anchor)
      const endRaw = item.eventEndAt ? minutesOf(item.eventEndAt) : startMin + 60
      const endMin = endRaw > startMin ? endRaw : Math.min(24 * 60, startMin + 30)
      return { item, startMin, endMin: Math.min(24 * 60, endMin) }
    })
    .filter((entry): entry is { item: TodoItemRow; startMin: number; endMin: number } => entry !== null)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

  const blocks: Block[] = []
  let cluster: typeof entries = []
  let clusterEnd = -1
  const flush = (): void => {
    if (cluster.length === 0) return
    const colEnds: number[] = []
    const placed = cluster.map((entry) => {
      let col = colEnds.findIndex((end) => end <= entry.startMin)
      if (col === -1) {
        colEnds.push(entry.endMin)
        col = colEnds.length - 1
      } else {
        colEnds[col] = entry.endMin
      }
      return { ...entry, col }
    })
    const cols = colEnds.length
    for (const entry of placed) blocks.push({ ...entry, cols })
    cluster = []
    clusterEnd = -1
  }
  for (const entry of entries) {
    if (cluster.length > 0 && entry.startMin >= clusterEnd) flush()
    cluster.push(entry)
    clusterEnd = Math.max(clusterEnd, entry.endMin)
  }
  flush()
  return blocks
}

function weekStartOf(date: Dayjs): Dayjs {
  const mondayOffset = (date.day() + 6) % 7
  return date.startOf('day').subtract(mondayOffset, 'day')
}

/** 日程页：周/日两视图的课程时间段表格，点击空白格子即可在该时刻新建，点击色块编辑 */
export function SchedulePage(): React.JSX.Element {
  const { snapshot } = useTodoSnapshot()
  const [anchor, setAnchor] = useState<Dayjs>(() => dayjs())
  const [mode, setMode] = useState<'week' | 'day'>('week')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TodoItemRow | null>(null)
  const [defaults, setDefaults] = useState<TodoDialogDefaults | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const weekStart = useMemo(() => weekStartOf(anchor), [anchor])
  const days = useMemo(
    () => (mode === 'week' ? Array.from({ length: 7 }, (_, i) => weekStart.add(i, 'day')) : [anchor.startOf('day')]),
    [mode, weekStart, anchor]
  )
  const windowStart = days[0]!
  const windowEnd = days[days.length - 1]!.add(1, 'day')
  const items = snapshot?.items ?? []
  const lists = snapshot?.lists ?? []
  const todayKey = dayKey(new Date())

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (item.status === '已取消') return false
        const anchorIso = eventAnchor(item)
        if (!anchorIso) return false
        const t = dayjs(anchorIso)
        return !t.isBefore(windowStart) && t.isBefore(windowEnd)
      }),
    [items, windowStart, windowEnd]
  )

  const byDay = useMemo(() => {
    const map = new Map<string, TodoItemRow[]>()
    for (const item of visible) {
      const key = dayKey(new Date(eventAnchor(item)!))
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return map
  }, [visible])

  const allDayDays = useMemo(() => new Set(days.filter((d) => (byDay.get(dayKey(d.toDate())) ?? []).some((i) => i.allDay)).map((d) => dayKey(d.toDate()))), [days, byDay])
  const hasAllDay = allDayDays.size > 0

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = 7 * HOUR_H
  }, [mode])

  const rangeLabel =
    mode === 'week'
      ? windowStart.month() === windowEnd.subtract(1, 'day').month()
        ? `${windowStart.format('YYYY年M月')}`
        : `${windowStart.format('YYYY年M月')} - ${windowEnd.subtract(1, 'day').format('M月')}`
      : anchor.format('YYYY年M月D日')

  const openCreate = (date: Dayjs, startMin: number): void => {
    const hour = Math.floor(startMin / 60)
    const minute = startMin % 60
    const start = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    const endMin = Math.min(24 * 60 - 1, startMin + 60)
    const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
    setEditing(null)
    setDefaults({ date: dayKey(date.toDate()), start, end })
    setEditorOpen(true)
  }

  const openEdit = (item: TodoItemRow): void => {
    setEditing(item)
    setDefaults(undefined)
    setEditorOpen(true)
  }

  const shift = (dir: -1 | 1): void => {
    setAnchor((prev) => prev.add(dir * (mode === 'week' ? 7 : 1), 'day'))
  }

  return (
    <div className="sch-shell">
      <header className="sch-head">
        <div className="sch-head-left">
          <h1 className="sch-title">日程</h1>
          <span className="sch-range">{rangeLabel}</span>
        </div>
        <div className="sch-head-right">
          <Segmented
            size="small"
            value={mode}
            onChange={(value) => setMode(value as 'week' | 'day')}
            options={[
              { value: 'week', label: '周' },
              { value: 'day', label: '日' }
            ]}
          />
          <div className="sch-nav">
            <Tooltip title={mode === 'week' ? '上一周' : '前一天'}>
              <Button size="small" type="text" icon={<LeftOutlined />} onClick={() => shift(-1)} />
            </Tooltip>
            <Button size="small" type="text" onClick={() => setAnchor(dayjs())}>
              今天
            </Button>
            <Tooltip title={mode === 'week' ? '下一周' : '后一天'}>
              <Button size="small" type="text" icon={<RightOutlined />} onClick={() => shift(1)} />
            </Tooltip>
          </div>
          <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate(anchor, 9 * 60)}>
            新建
          </Button>
        </div>
      </header>

      <div className="sch-cal">
        <div className="sch-cal-head">
          <div className="sch-gutter-head" />
          {days.map((day) => {
            const key = dayKey(day.toDate())
            const isToday = key === todayKey
            return (
              <button
                type="button"
                key={key}
                className={`sch-dayhead${isToday ? ' sch-dayhead-today' : ''}`}
                onClick={() => {
                  setAnchor(day)
                  setMode('day')
                }}
              >
                <span className="sch-dayhead-name">{DAY_LABEL[day.day()]}</span>
                <span className="sch-dayhead-date">{day.date()}</span>
              </button>
            )
          })}
        </div>

        {hasAllDay ? (
          <div className="sch-allday">
            <div className="sch-gutter-cell">全天</div>
            {days.map((day) => {
              const key = dayKey(day.toDate())
              const allDayItems = (byDay.get(key) ?? []).filter((i) => i.allDay)
              return (
                <div className="sch-allday-cell" key={key}>
                  {allDayItems.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className="sch-allday-chip"
                      style={{ background: `${item.listColor ?? '#5C5C5C'}1A`, borderLeftColor: item.listColor ?? '#5C5C5C' }}
                      onClick={() => openEdit(item)}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        ) : null}

        <div className="sch-cal-body" ref={scrollRef}>
          <div className="sch-gutter">
            {Array.from({ length: 24 }, (_, hour) => (
              <div className="sch-hour" key={hour} style={{ height: HOUR_H }}>
                <span>{String(hour).padStart(2, '0')}:00</span>
              </div>
            ))}
          </div>
          <div className="sch-grid">
            {days.map((day) => {
              const key = dayKey(day.toDate())
              const dayItems = byDay.get(key) ?? []
              const blocks = layoutDay(dayItems.filter((i) => !i.allDay))
              const isToday = key === todayKey
              const now = dayjs()
              return (
                <div
                  className={`sch-day${isToday ? ' sch-day-today' : ''}`}
                  key={key}
                  onClick={(event) => {
                    if (event.target !== event.currentTarget) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    const offset = event.clientY - rect.top
                    const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor(offset / HOUR_H * 60 / 30) * 30))
                    openCreate(day, minutes)
                  }}
                >
                  {isToday ? (
                    <div className="sch-now" style={{ top: ((now.hour() * 60 + now.minute()) / 60) * HOUR_H }} />
                  ) : null}
                  {blocks.map((block) => {
                    const color = block.item.listColor ?? '#5C5C5C'
                    const top = (block.startMin / 60) * HOUR_H + 1
                    const height = Math.max(19, ((block.endMin - block.startMin) / 60) * HOUR_H - 2)
                    return (
                      <button
                        type="button"
                        key={block.item.id}
                        className={`sch-event${block.item.completedAt ? ' sch-event-done' : ''}`}
                        style={{
                          top,
                          height,
                          left: `calc(${(block.col / block.cols) * 100}% + 1px)`,
                          width: `calc(${100 / block.cols}% - 3px)`,
                          background: `${color}14`,
                          borderLeftColor: color
                        }}
                        title={`${block.item.title} ${dayjs(eventAnchor(block.item)!).format('HH:mm')}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          openEdit(block.item)
                        }}
                      >
                        <span className="sch-event-title">{block.item.title}</span>
                        <span className="sch-event-time">
                          {dayjs(eventAnchor(block.item)!).format('HH:mm')}
                          {block.item.eventEndAt ? ` - ${dayjs(block.item.eventEndAt).format('HH:mm')}` : ''}
                        </span>
                        {block.item.listName ? <span className="sch-event-list">{block.item.listName}</span> : null}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <TodoItemDialog open={editorOpen} item={editing} lists={lists} defaults={defaults} onClose={() => setEditorOpen(false)} />
    </div>
  )
}
