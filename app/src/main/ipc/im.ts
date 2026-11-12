/**
 * IM 相关 IPC 注册。
 *
 * 只依赖一个最小的 ipcMain 接口，不 import electron：这样可以单独编译测试，
 * 接入 InfoAgent 时在 src/main/ipc/index.ts 里传真的 ipcMain 进来即可。
 */

import type { ImUnderstandRequest, ImSyncQceRequest, ImSyncRequest } from '../../shared/im'
import { IM_IPC } from '../../shared/im'
import type { ImService } from '../services/im/service'
import type { QceRuntime } from '../services/im/qceRuntime'

export interface ImIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

export function registerImIpc(ipcMain: ImIpcMainLike, service: ImService, runtime?: QceRuntime): void {
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

  ipcMain.handle(IM_IPC.imSyncQce, (_event, request?: ImSyncQceRequest) => service.syncQce(request ?? {}))
  ipcMain.handle(IM_IPC.imQceStatus, (_event, baseUrl?: unknown) =>
    service.qceStatus(typeof baseUrl === 'string' ? baseUrl : undefined)
  )

  // 内置 QCE 运行集：启动（拉起 QQ）+ 退出登录（结束进程树）；没注入 runtime 时降级为只读状态
  if (runtime) {
    ipcMain.handle(IM_IPC.imQceRuntime, () => runtime.status())
    ipcMain.handle(IM_IPC.imQceLaunch, () => runtime.launch())
    ipcMain.handle(IM_IPC.imQceLogout, () => runtime.logout())
    ipcMain.handle(IM_IPC.imQceLogTail, (_event, limit?: unknown) =>
      runtime.logTail(typeof limit === 'number' && limit > 0 && limit <= 200 ? limit : 20)
    )
  }

  ipcMain.handle(IM_IPC.imImportFile, (_event, files: unknown, options?: { title?: string; enable?: boolean }) => {
    if (!Array.isArray(files)) throw new Error('files 必须是文件路径数组')
    return service.importExportFiles(
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

  ipcMain.handle(IM_IPC.imQqSources, () => service.listQqSources())

  ipcMain.handle(IM_IPC.imQqSourcesSet, (_event, sessionIds: unknown) => {
    if (!Array.isArray(sessionIds)) throw new Error('sessionIds 必须是数字数组')
    return service.setQqSources(sessionIds.filter((id): id is number => typeof id === 'number'))
  })

  ipcMain.handle(IM_IPC.imQqDaily, (_event, dateKey?: unknown, options?: { extract?: boolean; range?: import('../../shared/im').QqPanelRange }) =>
    service.dailyQq(typeof dateKey === 'string' ? dateKey : undefined, options ?? {})
  )

  ipcMain.handle(IM_IPC.imInsightSource, (_event, id: unknown) => {
    if (typeof id !== 'number') throw new Error('id 必须是数字')
    return service.insightSource(id)
  })

  ipcMain.handle(IM_IPC.imInsightStatus, (_event, id: unknown, status: unknown) => {
    if (typeof id !== 'number') throw new Error('id 必须是数字')
    if (status !== 'new' && status !== 'accepted' && status !== 'dismissed') throw new Error('status 不合法')
    return service.setInsightStatus(id, status)
  })
}
