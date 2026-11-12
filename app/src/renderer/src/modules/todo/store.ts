import { useCallback, useEffect, useState } from 'react'
import type { TodoSnapshot } from '@shared/todo'

/** 日程 / 待办共享的刷新总线：任一页面改动条目后，另一页面重新拉一次快照，避免两个模块各存一份陈旧数据 */
type Listener = () => void
const listeners = new Set<Listener>()

export function onTodoChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitTodoChange(): void {
  for (const listener of [...listeners]) listener()
}

/** 统一取数：快照 + 变更后自动重载（初次挂载、跨模块刷新都走这里） */
export function useTodoSnapshot(): { snapshot: TodoSnapshot | null; reload: () => void } {
  const [snapshot, setSnapshot] = useState<TodoSnapshot | null>(null)
  const reload = useCallback(() => {
    void window.api
      .todoSnapshot()
      .then((next) => setSnapshot(next))
      .catch(() => setSnapshot(null))
  }, [])
  useEffect(() => {
    reload()
    return onTodoChange(reload)
  }, [reload])
  return { snapshot, reload }
}

/** 本地日期键 YYYY-MM-DD（按本地时区取，不能用 toISOString 切出来的 UTC 日期） */
export function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
