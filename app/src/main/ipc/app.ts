import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { AppInfo } from '../../shared/types'
import { openExternalSafely } from '../services/externalOpen'

export function registerAppIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    userDataPath: app.getPath('userData'),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }))
  ipcMain.handle(IPC.appOpenExternal, (_event, url: string): Promise<boolean> => {
    if (typeof url !== 'string') return Promise.resolve(false)
    return openExternalSafely(url)
  })
}
