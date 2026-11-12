import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { ZhihuOpResult, ZhihuPushAction, ZhihuStatus, ZhihuTodayResult } from '../../shared/zhihu'
import type { ZhihuService } from '../services/zhihu/service'

/** 知乎反推荐 IPC：只做参数透传，业务校验在 ZhihuService（纯 DB，可单测）。 */
export function registerZhihuIpc(zhihu: ZhihuService): void {
  ipcMain.handle(IPC.zhihuStatus, (): Promise<ZhihuStatus> => zhihu.status())
  ipcMain.handle(IPC.zhihuLogin, (event): Promise<ZhihuOpResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    return zhihu.login(parent)
  })
  ipcMain.handle(IPC.zhihuLogout, (): Promise<ZhihuOpResult> => zhihu.logout())
  ipcMain.handle(
    IPC.zhihuSync,
    (_event, force?: boolean): Promise<ZhihuOpResult> => zhihu.sync(force === true)
  )
  ipcMain.handle(IPC.zhihuToday, (): Promise<ZhihuTodayResult> => zhihu.today())
  ipcMain.handle(
    IPC.zhihuAct,
    (_event, id: number, action: ZhihuPushAction, folder?: string): ZhihuOpResult =>
      zhihu.act(id, action, folder)
  )
}
