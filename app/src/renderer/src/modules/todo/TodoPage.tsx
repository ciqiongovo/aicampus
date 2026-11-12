import { useEffect, useMemo, useState } from 'react'
import { App as AntApp, Button, Checkbox, Select, Space, Dropdown, Empty, Input, Modal, Skeleton, Tooltip } from 'antd'
import {
  CalendarOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  InboxOutlined,
  MailOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
  DownOutlined,
  ClockCircleOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { dueLabel, parseQuickAdd, type TodoItemRow, type TodoListRow } from '@shared/todo'
import { TodoItemDialog, type TodoDialogDefaults } from './TodoItemDialog'
import { emitTodoChange, useTodoSnapshot } from './store'
import './todo.css'

type ViewKind = 'today' | 'next7' | 'inbox' | 'completed' | 'list'

interface ViewState {
  kind: ViewKind
  listId?: number
}

const SMART_VIEWS: Array<{ kind: ViewKind; label: string; icon: React.ReactNode }> = [
  { kind: 'today', label: '今天', icon: <CheckCircleOutlined /> },
  { kind: 'next7', label: '最近 7 天', icon: <CalendarOutlined /> },
  { kind: 'inbox', label: '收集箱', icon: <InboxOutlined /> }
]

function isDone(item: TodoItemRow): boolean {
  return item.completedAt !== null || item.status === '已完成'
}

function dueValue(item: TodoItemRow): number {
  const iso = item.eventStartAt ?? item.deadlineAt
  if (!iso) return Number.POSITIVE_INFINITY
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

function sortByDue(items: TodoItemRow[]): TodoItemRow[] {
  return [...items].sort((a, b) => dueValue(a) - dueValue(b) || b.priority - a.priority || a.id - b.id)
}

/** 待办清单页：左栏智能视图 + 自建清单，右栏任务列表（对齐截图的 TickTick 布局） */
export function TodoPage(): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const { snapshot } = useTodoSnapshot()
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const [targetList, setTargetList] = useState<number>(0)
  const [view, setView] = useState<ViewState>({ kind: 'today' })
  const [draft, setDraft] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TodoItemRow | null>(null)
  const [defaults, setDefaults] = useState<TodoDialogDefaults | undefined>(undefined)
  const [listDialog, setListDialog] = useState<{ mode: 'create' | 'rename'; id?: number; name: string } | null>(null)
  const [savingList, setSavingList] = useState(false)

  const lists = snapshot?.lists ?? []
  const allItems = snapshot?.items ?? []
  const now = useMemo(() => (snapshot ? new Date(snapshot.now) : new Date()), [snapshot])
  const counts = snapshot?.counts

  const activeList: TodoListRow | undefined = view.kind === 'list' ? lists.find((l) => l.id === view.listId) : undefined

  const visible = useMemo(() => {
    const dayStart = dayjs(now).startOf('day')
    const tomorrow = dayStart.add(1, 'day').valueOf()
    const weekEnd = dayStart.add(7, 'day').valueOf()
    const open = allItems.filter((item) => !isDone(item))
    switch (view.kind) {
      case 'today':
        return sortByDue(open.filter((item) => dueValue(item) < tomorrow))
      case 'next7':
        return sortByDue(open.filter((item) => dueValue(item) < weekEnd))
      case 'inbox':
        return sortByDue(open.filter((item) => item.listId === null))
      case 'completed':
        return [...allItems]
          .filter(isDone)
          .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime())
      case 'list':
        return sortByDue(open.filter((item) => item.listId === view.listId))
      default:
        return []
    }
  }, [allItems, now, view])

  const openItems = visible.filter((item) => !isDone(item))
  const doneItems = useMemo(() => (view.kind === 'completed' ? [] : allItems.filter(isDone)), [allItems, view.kind])

  const parsed = parseQuickAdd(draft, now)

  const title = view.kind === 'list' ? (activeList?.name ?? '清单') : (SMART_VIEWS.find((v) => v.kind === view.kind)?.label ?? '已完成')

  const toggle = async (item: TodoItemRow, next: boolean): Promise<void> => {
    const result = await window.api.todoToggleItem(item.id, next)
    if (!result.ok) {
      message.error(result.error ?? '操作失败')
      return
    }
    emitTodoChange()
  }

  const addTask = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    const quick = parseQuickAdd(text, now)
    const result = await window.api.todoCreateItem({
      title: quick.title,
      deadlineAt: quick.deadlineAt,
      eventStartAt: quick.deadlineAt,
      listId: view.kind === 'list' ? (view.listId ?? null) : null
    })
    if (!result.ok) {
      message.error(result.error ?? '添加失败')
      return
    }
    setDraft('')
    emitTodoChange()
  }

  const openCreate = (): void => {
    setEditing(null)
    setDefaults(undefined)
    setEditorOpen(true)
  }

  const openEdit = (item: TodoItemRow): void => {
    setEditing(item)
    setDefaults(undefined)
    setEditorOpen(true)
  }

  const saveList = async (): Promise<void> => {
    if (!listDialog) return
    setSavingList(true)
    try {
      const result =
        listDialog.mode === 'create'
          ? await window.api.todoCreateList(listDialog.name)
          : await window.api.todoUpdateList(listDialog.id!, { name: listDialog.name })
      if (!result.ok) {
        message.error(result.error ?? '保存失败')
        return
      }
      message.success(listDialog.mode === 'create' ? '清单已创建' : '清单已重命名')
      setListDialog(null)
      emitTodoChange()
    } finally {
      setSavingList(false)
    }
  }

  const removeList = async (id: number): Promise<void> => {
    const result = await window.api.todoDeleteList(id)
    if (!result.ok) {
      message.error(result.error ?? '删除失败')
      return
    }
    message.success('清单已删除，任务回到收集箱')
    setView({ kind: 'inbox' })
    emitTodoChange()
  }

  useEffect(() => { setSelected([]) }, [view, showDone])
  const selectable = (view.kind === 'completed' ? visible : [...openItems, ...(showDone ? doneItems : [])]).map(item => item.id)
  const chosen = selected.filter(id => selectable.includes(id))
  const selectItem = (id: number): void => setSelected(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id])
  const batch = async (action: 'delete' | 'complete' | 'move'): Promise<void> => {
    setBatchBusy(true)
    try {
      const result = await window.api.todoBatch(chosen, action, targetList || null)
      if (!result.ok) throw new Error(result.error || '批量操作失败')
      setSelected([]); emitTodoChange(); message.success('批量操作完成')
    } catch (e) { message.error(String(e)); throw e } finally { setBatchBusy(false) }
  }
  const renderRow = (item: TodoItemRow): React.JSX.Element => {
    const done = isDone(item)
    // 右侧已经有「全天」或起始时刻时，到期标签只给日期粒度，避免出现「08:15 今天 08:15」
    const hasClockChip = Boolean(item.eventStartAt && item.eventEndAt && !item.allDay)
    const due = dueLabel(item.eventStartAt ?? item.deadlineAt, now, !item.allDay && !hasClockChip)
    return (
      <div className={`todo-row${done ? ' todo-row-done' : ''}`} key={item.id} onClick={() => managing ? selectItem(item.id) : openEdit(item)}>
        {managing && <Checkbox aria-label={`选择 ${item.title}`} checked={chosen.includes(item.id)} onClick={e => e.stopPropagation()} onChange={() => selectItem(item.id)} />}
        <button
          type="button"
          className={`todo-check${done ? ' todo-check-on' : ''}`}
          aria-label={done ? '取消完成' : '标记完成'}
          onClick={(event) => {
            event.stopPropagation()
            void toggle(item, !done)
          }}
        >
          {done ? <CheckOutlined /> : null}
        </button>
        <div className="todo-row-main">
          <div className="todo-row-title">{item.title}</div>
          <div className="todo-row-meta">
            {item.listColor && item.listName ? (
              <span className="todo-row-list">
                <i style={{ background: item.listColor }} />
                {item.listName}
              </span>
            ) : null}
            {item.notes ? <span className="todo-row-note">{item.notes}</span> : null}
            {item.sourceEmailId ? (
              <span className="todo-row-mail">
                <MailOutlined /> 邮件
              </span>
            ) : null}
          </div>
        </div>
        <div className="todo-row-side">
          {item.allDay && item.eventStartAt ? <span className="todo-row-allday">全天</span> : null}
          {item.eventStartAt && item.eventEndAt && !item.allDay ? (
            <span className="todo-row-clock">
              <ClockCircleOutlined /> {dayjs(item.eventStartAt).format('HH:mm')}
            </span>
          ) : null}
          {due.tone !== 'none' ? <span className={`todo-due todo-due-${due.tone}`}>{due.text}</span> : null}        </div>
      </div>
    )
  }

  return (
    <div className="todo-shell">
      <aside className="todo-rail">
        <div className="todo-rail-group">
          {SMART_VIEWS.map((entry) => {
            const badge = entry.kind === 'today' ? counts?.today : entry.kind === 'next7' ? counts?.next7 : counts?.inbox
            return (
              <button
                type="button"
                key={entry.kind}
                className={`todo-rail-item${view.kind === entry.kind ? ' todo-rail-item-active' : ''}`}
                onClick={() => setView({ kind: entry.kind })}
              >
                <span className="todo-rail-icon">{entry.icon}</span>
                <span className="todo-rail-label">{entry.label}</span>
                {badge ? <span className="todo-rail-count">{badge}</span> : null}
              </button>
            )
          })}
        </div>
        <div className="todo-rail-head">
          <span>清单</span>
          <Tooltip title="新建清单">
            <button type="button" className="todo-rail-add" onClick={() => setListDialog({ mode: 'create', name: '' })}>
              <PlusOutlined />
            </button>
          </Tooltip>
        </div>
        <div className="todo-rail-group">
          {lists.map((list) => (
            <button
              type="button"
              key={list.id}
              className={`todo-rail-item${view.kind === 'list' && view.listId === list.id ? ' todo-rail-item-active' : ''}`}
              onClick={() => setView({ kind: 'list', listId: list.id })}
            >
              <i className="todo-rail-dot" style={{ background: list.color }} />
              <span className="todo-rail-label">{list.name}</span>
              {list.openCount ? <span className="todo-rail-count">{list.openCount}</span> : null}
            </button>
          ))}
          {lists.length === 0 ? <div className="todo-rail-empty">还没有清单</div> : null}
        </div>
        <div className="todo-rail-group todo-rail-foot">
          <button
            type="button"
            className={`todo-rail-item${view.kind === 'completed' ? ' todo-rail-item-active' : ''}`}
            onClick={() => setView({ kind: 'completed' })}
          >
            <span className="todo-rail-icon">
              <CheckOutlined />
            </span>
            <span className="todo-rail-label">已完成</span>
            {counts?.completed ? <span className="todo-rail-count">{counts.completed}</span> : null}
          </button>
        </div>
      </aside>

      <section className="todo-main">
        <header className="todo-main-head">
          <div className="todo-main-title">
            <h2>{title}</h2>
            <span className="todo-main-count">{view.kind === 'completed' ? visible.length : openItems.length}</span>
          </div>
          <div className="todo-main-actions">
            <Button size="small" type={managing ? 'primary' : 'default'} onClick={() => {setManaging(!managing); setSelected([])}}>{managing ? '退出管理' : '批量管理'}</Button>
            <Button size="small" type="text" icon={<PlusOutlined />} onClick={openCreate}>
              新建任务
            </Button>
            {activeList ? (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'rename', label: '重命名清单' },
                    { key: 'delete', label: '删除清单' }
                  ],
                  onClick: ({ key }) => {
                    if (key === 'rename') setListDialog({ mode: 'rename', id: activeList.id, name: activeList.name })
                    if (key === 'delete') void removeList(activeList.id)
                  }
                }}
              >
                <Button size="small" type="text" icon={<MoreOutlined />} />
              </Dropdown>
            ) : null}
          </div>
        </header>

        {managing && <Space wrap style={{padding: '12px 24px'}}>
          <Checkbox checked={selectable.length > 0 && chosen.length === selectable.length} indeterminate={chosen.length > 0 && chosen.length < selectable.length} onChange={e => setSelected(e.target.checked ? selectable : [])}>全选当前视图</Checkbox>
          <span>已选 {chosen.length} 项</span>
          <Button disabled={!chosen.length || batchBusy} onClick={() => void batch('complete')}>批量完成</Button>
          <Select aria-label="目标清单" style={{width: 140}} value={targetList} onChange={setTargetList} options={[{value: 0, label: '收集箱'}, ...lists.map(l => ({value: l.id, label: l.name}))]} />
          <Button disabled={!chosen.length || batchBusy} onClick={() => void batch('move')}>批量移动</Button>
          <Button danger disabled={!chosen.length || batchBusy} onClick={() => modal.confirm({title: `删除选中的 ${chosen.length} 项任务？`, content: '任务及其提醒将一并删除，此操作不可撤销。', okText: '删除', cancelText: '取消', okButtonProps: {danger: true}, onOk: () => batch('delete')})}>批量删除</Button>
        </Space>}
        <div className="todo-composer">
          <PlusOutlined className="todo-composer-icon" />
          <Input
            variant="borderless"
            value={draft}
            placeholder="添加任务，试试「明天 15:00 交作业」"
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={() => void addTask()}
          />
          {draft.trim() && parsed.deadlineAt ? (
            <span className="todo-composer-hint">{dueLabel(parsed.deadlineAt, now).text}</span>
          ) : null}
        </div>

        {!snapshot ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : visible.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={view.kind === 'completed' ? '还没有完成的任务' : '这里还没有任务'} />
        ) : (
          <div className="todo-list">
            {(view.kind === 'completed' ? visible : openItems).map(renderRow)}
          </div>
        )}

        {view.kind !== 'completed' && doneItems.length > 0 ? (
          <div className="todo-done-block">
            <button type="button" className="todo-done-head" onClick={() => setShowDone((prev) => !prev)}>
              {showDone ? <DownOutlined /> : <RightOutlined />}
              已完成 {doneItems.length}
            </button>
            {showDone ? <div className="todo-list">{doneItems.map(renderRow)}</div> : null}
          </div>
        ) : null}
      </section>

      <TodoItemDialog open={editorOpen} item={editing} lists={lists} defaults={defaults} onClose={() => setEditorOpen(false)} />

      <Modal
        open={listDialog !== null}
        title={listDialog?.mode === 'create' ? '新建清单' : '重命名清单'}
        onCancel={() => setListDialog(null)}
        onOk={() => void saveList()}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingList}
        destroyOnClose
      >
        <Input
          autoFocus
          value={listDialog?.name ?? ''}
          placeholder="清单名称，例如 课表"
          onChange={(event) => setListDialog((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
          onPressEnter={() => void saveList()}
        />
      </Modal>

    </div>
  )
}
