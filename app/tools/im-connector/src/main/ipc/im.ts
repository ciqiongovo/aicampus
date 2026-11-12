/**
 * IM 相关 IPC 注册。
 *
 * 只依赖一个最小的 ipcMain 接口，不 import electron：这样可以单独编译测试，
 * 接入 InfoAgent 时在 src/main/ipc/index.ts 里传真的 ipcMain 进来即可。
 */

import type { ImUnderstandRequest, ImSyncRequest } from '../../shared/im'
import { IM_IPC } from '../../shared/im'
import type { ImService } from '../services/im/service'

export interface ImIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

export function registerImIpc(ipcMain: ImIpcMainLike, service: ImService): void {
  ipcMain.handle(IM_IPC.imDoctor, () => service.doctor())

  ipcMain.handle(IM_IPC.imSessions, (_event, accountId?: unknown) =>
    service.listSessions(typeof accountId === 'number' ? accountId : undefined)
  )

  ipcMain.handle(IM_IPC.imSessionToggle, (_event, sessionId: unknown, enabled: unknown) => {
    if (typeof sessionId !== 'number') return false
    return service.setSessionEnabled(sessionId, enabled !== false)
  })

  ipcMain.handle(IM_IPC.imMessages, (_event, sessionId: unknown, beforeSeq?: unknown, limit?: unknown) => {
    if (typeof sessionId !== 'number') return []
    return service.listMessages(
      sessionId,
      typeof beforeSeq === 'number' ? beforeSeq : undefined,
      typeof limit === 'number' ? limit : undefined
    )
  })

  ipcMain.handle(IM_IPC.imSearch, (_event, query: unknown, sessionId?: unknown, limit?: unknown) => {
    if (typeof query !== 'string' || query.trim() === '') return []
    return service.search(
      query,
      typeof sessionId === 'number' ? sessionId : undefined,
      typeof limit === 'number' ? limit : undefined
    )
  })

  ipcMain.handle(IM_IPC.imSync, (_event, request?: ImSyncRequest) => service.syncWechat(request ?? {}))

  ipcMain.handle(IM_IPC.imImportFile, (_event, files: unknown, options?: { title?: string; enable?: boolean }) => {
    if (!Array.isArray(files)) throw new Error('files 必须是文件路径数组')
    return service.importQqFiles(
      files.filter((item): item is string => typeof item === 'string'),
      options ?? {}
    )
  })

  ipcMain.handle(IM_IPC.imWindows, (_event, sessionId?: unknown) =>
    service.listWindows(typeof sessionId === 'number' ? sessionId : undefined)
  )

  ipcMain.handle(IM_IPC.imUnderstand, (_event, sessionId: unknown, request?: ImUnderstandRequest) => {
    if (typeof sessionId !== 'number') throw new Error('sessionId 必须是数字')
    return service.understand(sessionId, request)
  })

  ipcMain.handle(IM_IPC.imInsights, (_event, options?: unknown) =>
    service.listInsights((options ?? {}) as Parameters<ImService['listInsights']>[0])
  )

  ipcMain.handle(IM_IPC.imDigest, (_event, day?: unknown) =>
    service.digest(typeof day === 'string' ? day : undefined)
  )
}
