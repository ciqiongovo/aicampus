import { useEffect, useMemo, useState } from 'react'
import { App as AntApp, Button, DatePicker, Drawer, Input, Popconfirm, Segmented, Select, Switch, TimePicker } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { TodoCreateInput, TodoItemRow, TodoListRow } from '@shared/todo'
import { PRIORITY_LABELS } from '@shared/todo'
import { emitTodoChange } from './store'

export interface TodoDialogDefaults {
  /** 默认日期（本地 YYYY-MM-DD），来自日程格子的点击位置 */
  date?: string
  /** 默认开始/结束时刻 HH:mm */
  start?: string
  end?: string
}

interface Props {
  open: boolean
  /** null = 新建 */
  item: TodoItemRow | null
  lists: TodoListRow[]
  defaults?: TodoDialogDefaults
  onClose: () => void
}

const NONE_LIST = 0

function parseClock(value: string | undefined, fallback: Dayjs): Dayjs {
  if (!value) return fallback
  const [h, m] = value.split(':')
  return dayjs().hour(Number(h)).minute(Number(m)).second(0)
}

/** 编辑抽屉：日程页与待办页共用，避免两套表单逻辑各写一遍时间换算 */
export function TodoItemDialog({ open, item, lists, defaults, onClose }: Props): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [listId, setListId] = useState<number>(NONE_LIST)
  const [priority, setPriority] = useState(0)
  const [date, setDate] = useState<Dayjs | null>(null)
  const [start, setStart] = useState<Dayjs>(dayjs().hour(9).minute(0).second(0))
  const [end, setEnd] = useState<Dayjs>(dayjs().hour(10).minute(0).second(0))
  const [allDay, setAllDay] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (item) {
      const anchor = item.eventStartAt ?? item.deadlineAt
      const startAt = anchor ? dayjs(anchor) : null
      const endAt = item.eventEndAt ? dayjs(item.eventEndAt) : null
      setTitle(item.title)
      setNotes(item.notes)
      setListId(item.listId ?? NONE_LIST)
      setPriority(item.priority)
      setDate(startAt ? startAt.startOf('day') : null)
      setStart(startAt ?? dayjs().hour(9).minute(0).second(0))
      setEnd(endAt ?? (startAt ?? dayjs().hour(9).minute(0).second(0)).add(1, 'hour'))
      setAllDay(item.allDay)
      return
    }
    const base = defaults?.date ? dayjs(defaults.date) : dayjs()
    setTitle('')
    setNotes('')
    setListId(NONE_LIST)
    setPriority(0)
    setDate(defaults?.date ? base.startOf('day') : null)
    setStart(parseClock(defaults?.start, dayjs().hour(9).minute(0).second(0)))
    setEnd(parseClock(defaults?.end, parseClock(defaults?.start, dayjs().hour(9).minute(0).second(0)).add(1, 'hour')))
    setAllDay(false)
  }, [open, item, defaults])

  const listOptions = useMemo(
    () => [{ value: NONE_LIST, label: '收集箱（未分组）' }, ...lists.map((l) => ({ value: l.id, label: l.name }))],
    [lists]
  )

  /** 日期 + 时刻合成绝对时间；未选日期则视为「无日期」 */
  const buildTimes = (): { startIso: string | null; endIso: string | null } => {
    if (!date) return { startIso: null, endIso: null }
    const startAt = allDay ? date.hour(0).minute(0).second(0) : date.hour(start.hour()).minute(start.minute()).second(0)
    if (allDay) return { startIso: startAt.toISOString(), endIso: null }
    let endAt = date.hour(end.hour()).minute(end.minute()).second(0)
    if (endAt.valueOf() <= startAt.valueOf()) endAt = startAt.add(1, 'hour')
    return { startIso: startAt.toISOString(), endIso: endAt.toISOString() }
  }

  const submit = async (): Promise<void> => {
    const cleanTitle = title.trim()
    if (!cleanTitle) {
      message.warning('先写个标题')
      return
    }
    const { startIso, endIso } = buildTimes()
    const payload: TodoCreateInput = {
      title: cleanTitle,
      notes,
      listId: listId === NONE_LIST ? null : listId,
      priority,
      deadlineAt: startIso,
      eventStartAt: startIso,
      eventEndAt: endIso,
      allDay
    }
    setSaving(true)
    try {
      const result = item ? await window.api.todoUpdateItem(item.id, payload) : await window.api.todoCreateItem(payload)
      if (!result.ok) {
        message.error(result.error ?? '保存失败')
        return
      }
      message.success(item ? '已保存' : '已添加')
      emitTodoChange()
      onClose()
    } catch (error) {
      message.error('保存失败：' + (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!item) return
    const result = await window.api.todoDeleteItem(item.id)
    if (!result.ok) {
      message.error(result.error ?? '删除失败')
      return
    }
    message.success('已删除')
    emitTodoChange()
    onClose()
  }

  return (
    <Drawer
      open={open}
      width={420}
      onClose={onClose}
      destroyOnClose
      title={item ? '编辑' : '新建'}
      className="todo-drawer"
      footer={
        <div className="todo-drawer-foot">
          {item ? (
            <Popconfirm title="删除这条任务？" okText="删除" cancelText="取消" onConfirm={() => void remove()}>
              <Button danger type="text">
                删除
              </Button>
            </Popconfirm>
          ) : (
            <span />
          )}
          <div className="todo-drawer-foot-right">
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void submit()}>
              保存
            </Button>
          </div>
        </div>
      }
    >
      <Input.TextArea
        className="todo-title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="要做什么？"
        autoSize={{ minRows: 1, maxRows: 3 }}
        variant="borderless"
      />
      <div className="todo-form-row">
        <span className="todo-form-label">清单</span>
        <Select
          size="small"
          className="todo-form-control"
          value={listId}
          onChange={setListId}
          options={listOptions}
          popupMatchSelectWidth={false}
        />
      </div>
      <div className="todo-form-row">
        <span className="todo-form-label">日期</span>
        <DatePicker
          size="small"
          className="todo-form-control"
          value={date}
          onChange={(value) => setDate(value)}
          placeholder="无日期"
          format="YYYY-MM-DD"
          allowClear
        />
      </div>
      <div className="todo-form-row">
        <span className="todo-form-label">时间</span>
        <div className="todo-form-control todo-form-inline">
          <TimePicker
            size="small"
            value={start}
            onChange={(value) => value && setStart(value)}
            format="HH:mm"
            minuteStep={5}
            allowClear={false}
            disabled={allDay || !date}
          />
          <span className="todo-form-dash">-</span>
          <TimePicker
            size="small"
            value={end}
            onChange={(value) => value && setEnd(value)}
            format="HH:mm"
            minuteStep={5}
            allowClear={false}
            disabled={allDay || !date}
          />
          <span className="todo-form-switch">
            全天
            <Switch size="small" checked={allDay} onChange={setAllDay} />
          </span>
        </div>
      </div>
      <div className="todo-form-row">
        <span className="todo-form-label">优先级</span>
        <Segmented
          size="small"
          className="todo-form-control"
          value={priority}
          onChange={(value) => setPriority(Number(value))}
          options={[0, 1, 2, 3].map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
        />
      </div>
      <div className="todo-form-row todo-form-row-top">
        <span className="todo-form-label">备注</span>
        <Input.TextArea
          className="todo-form-control"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="补充说明（可选）"
          autoSize={{ minRows: 3, maxRows: 8 }}
        />
      </div>
      {item?.sourceEmailId ? <div className="todo-form-source">来自邮件 #{item.sourceEmailId}</div> : null}
    </Drawer>
  )
}
