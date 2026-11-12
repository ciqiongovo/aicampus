import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { CounterRecItem, CounterRecOpResult } from '../../shared/types'
import type { CounterRecService } from '../services/counterRec/service'

/** P5 反推荐 IPC：全部逻辑在 services/counterRec/service.ts（纯 DB+AI 调用，可测），这里只做参数校验 */
export function registerCounterRecIpc(counterRec: CounterRecService): void {
  ipcMain.handle(IPC.counterToday, (): CounterRecItem | null => counterRec.today())

  ipcMain.handle(IPC.counterAct, (_event, id: unknown, action: unknown): CounterRecOpResult => {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return { ok: false, message: '无效的反推荐条目' }
    if (action !== 'go' && action !== 'ignore') return { ok: false, message: '无效的操作' }
    return counterRec.act(id, action)
  })
}
