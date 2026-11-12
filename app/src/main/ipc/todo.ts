import { ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { IPC } from '../../shared/types'
import type { TodoCreateInput, TodoOpResult, TodoPatch, TodoSnapshot } from '../../shared/todo'
import {
  batchTodoItems,
  createTodoItem,
  createTodoList,
  deleteTodoItem,
  deleteTodoList,
  getTodoSnapshot,
  toggleTodoItem,
  updateTodoItem,
  updateTodoList
} from '../services/todo/service'

/** 日程 / 待办 IPC：逻辑全在 services/todo/service.ts（纯 DB 可测），这里只透传参数 */
export function registerTodoIpc(db: DatabaseSync): void {
  ipcMain.handle(IPC.todoBatch, (_e, ids: number[], action: 'delete' | 'complete' | 'move', listId?: number | null) => batchTodoItems(db, ids, action, listId))
  ipcMain.handle(IPC.todoSnapshot, (): TodoSnapshot => getTodoSnapshot(db))
  ipcMain.handle(IPC.todoCreateItem, (_event, input: TodoCreateInput): TodoOpResult => createTodoItem(db, input))
  ipcMain.handle(IPC.todoUpdateItem, (_event, id: number, patch: TodoPatch): TodoOpResult => updateTodoItem(db, id, patch))
  ipcMain.handle(IPC.todoToggleItem, (_event, id: number, completed: boolean): TodoOpResult => toggleTodoItem(db, id, completed))
  ipcMain.handle(IPC.todoDeleteItem, (_event, id: number): TodoOpResult => deleteTodoItem(db, id))
  ipcMain.handle(IPC.todoCreateList, (_event, name: string, color?: string): TodoOpResult => createTodoList(db, name, color))
  ipcMain.handle(IPC.todoUpdateList, (_event, id: number, patch: { name?: string; color?: string }): TodoOpResult => updateTodoList(db, id, patch))
  ipcMain.handle(IPC.todoDeleteList, (_event, id: number): TodoOpResult => deleteTodoList(db, id))
}
