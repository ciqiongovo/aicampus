import { app, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'

function trayIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources/tray.png')
  }
  return join(app.getAppPath(), 'resources/tray.png')
}

export function createTray(options: { showWindow: () => void; quit: () => void }): Tray {
  const tray = new Tray(nativeImage.createFromPath(trayIconPath()))
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => options.showWindow() },
    { type: 'separator' },
    { label: '退出 InfoAgent', click: () => options.quit() }
  ])
  tray.setToolTip('InfoAgent')
  tray.setContextMenu(menu)
  tray.on('double-click', () => options.showWindow())
  return tray
}
