import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db'
import { migrateAccountSecrets } from './db/dao/accountsDao'
import { registerIpc } from './ipc'
import { SyncManager } from './services/mail/syncManager'
import { AnalysisPipeline } from './services/ai/pipeline'
import { SettingsStore } from './store/settings'
import { createTray } from './tray'
import { createConfirmedExternalOpener } from './services/externalLinkSafety'
import { registerExternalOpener } from './services/externalOpen'
import { ZHIHU_PARTITION } from '../shared/zhihu'
import { APP_ID, APP_NAME, prepareUserData } from './brand'
import type { Tray } from 'electron'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// 必须早于任何 getPath('userData')：把目录钉到 ZhiShu，并把旧 InfoAgent 的库搬过来。
// 放在模块顶层而不是 whenReady 里，是因为启动日志本身就要往 userData 写，
// 晚一步就会在旧目录留下一份空日志，看起来像又新建了一个用户。
const userData = prepareUserData()

// 启动留痕：写入 <用户数据目录>\startup.log，双击无反应时可据此定位停在哪一步
const startedAt = Date.now()
let logTargets: string[] | null = null

/** 启动日志落盘位置：优先用户数据目录（与数据库同处），再兜底系统临时目录 */
function resolveLogTargets(): string[] {
  const targets: string[] = []
  try {
    targets.push(join(app.getPath('userData'), 'startup.log'))
  } catch {
    // userData 不可用（极早期）时跳过
  }
  try {
    targets.push(join(tmpdir(), 'zhishu-startup.log'))
  } catch {
    // tmpdir 不可用时跳过
  }
  return targets
}

function startupLog(message: string): void {
  const line = `${new Date().toISOString()} +${Date.now() - startedAt}ms [pid ${process.pid}] ${message}\n`
  logTargets ??= resolveLogTargets()
  console.log(line.trimEnd())
  for (const target of logTargets) {
    try {
      appendFileSync(target, line)
    } catch {
      // 单个目标写不进去不影响另一个
    }
  }
}

/** 窗口是否已经显示过：显示前的异常才值得弹框打断用户 */
let windowShown = false
let fatalDialogShown = false

/** 致命错误：先留痕，再弹系统错误框，避免「双击后什么都没发生」 */
function startupFail(title: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  startupLog(`FATAL ${title}: ${detail}`)
  if (fatalDialogShown) return
  fatalDialogShown = true
  try {
    dialog.showErrorBox(title, detail.slice(0, 2000))
  } catch {
    // 连对话框都弹不出来时只能依赖日志
  }
}

process.on('uncaughtException', (error) => {
  startupFail(`${APP_NAME} 运行出错`, error)
})

process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  startupLog(`UNHANDLED_REJECTION ${detail}`)
  // 窗口还没出来就失败 = 用户只会看到「双击没反应」，这时必须告诉他是怎么回事
  if (!windowShown) startupFail(`${APP_NAME} 启动失败`, reason)
})

startupLog(
  `启动 version=${app.getVersion()} packaged=${app.isPackaged} execPath=${process.execPath} ` +
    `appPath=${app.getAppPath()} resourcesPath=${process.resourcesPath}`
)

/** 外链确认对话框：显示完整 URL 与主机名，默认聚焦「取消」；关闭窗口同样视为取消 */
function confirmExternalOpen(url: string): Promise<boolean> {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const detail = parent ? url : `来自 ${new URL(url).hostname} 的链接：${url}`
  return dialog
    .showMessageBox(parent as BrowserWindow, {
      type: 'question',
      buttons: ['取消', '在浏览器中打开'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '打开外部链接',
      message: '要在系统浏览器中打开这个链接吗？',
      detail
    })
    .then(({ response }) => response === 1)
}

/** 全应用唯一外链通道：仅 http/https 且通过安全归一化才可打开；重复点击不会堆叠对话框 */
const openExternalLink = createConfirmedExternalOpener({
  confirm: async (url) => confirmExternalOpen(url),
  open: async (url) => {
    await shell.openExternal(url)
  }
})

// 供 IPC（如账号设置的授权帮助链接）复用同一确认式外链通道
registerExternalOpener(openExternalLink)

const gotLock = app.requestSingleInstanceLock()
startupLog(`requestSingleInstanceLock -> ${gotLock} userData=${(() => { try { return app.getPath('userData') } catch { return '<unavailable>' } })()}`)

if (!gotLock) {
  // 正常情况：已有实例在运行，second-instance 会把窗口唤出，这里只留痕
  startupLog('未取得单实例锁，结束本次启动')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  function showWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  function quitApp(): void {
    isQuitting = true
    app.quit()
  }

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 760,
      minHeight: 600,
      show: false,
      // 与面板底色一致，Windows 合成器在首帧前露出的窗口底色不再是一块纯白。
      backgroundColor: '#f7f6f3',
      autoHideMenuBar: true,
      title: APP_NAME,
      icon: app.isPackaged
        ? join(process.resourcesPath, 'resources/icon.ico')
        : join(app.getAppPath(), 'resources/icon.ico'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    mainWindow.on('ready-to-show', () => {
      startupLog('窗口 ready-to-show，显示主窗口')
      windowShown = true
      mainWindow?.show()
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      startupLog(`渲染进程加载失败 code=${code} desc=${desc} url=${url}`)
      mainWindow?.show()
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      startupLog(`渲染进程退出 reason=${details.reason} exitCode=${details.exitCode}`)
    })
    // 兜底：10 秒内没等到 ready-to-show 也把窗口显示出来，避免进程活着却一片空白
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        startupLog('警告：10 秒内未触发 ready-to-show，强制显示窗口')
        windowShown = true
        mainWindow.show()
      }
    }, 10000)
    mainWindow.on('close', (event) => {
      if (!isQuitting && tray) {
        event.preventDefault()
        mainWindow?.hide()
      }
    })
    // 外链一律先确认再交给系统浏览器；未通过安全归一化的地址（file:// 等）直接拒绝
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void openExternalLink(url)
      return { action: 'deny' }
    })
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      if (isDev && devUrl && url.startsWith(devUrl)) return // 放行开发服务器自身的刷新
      event.preventDefault()
      void openExternalLink(url)
    })

    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  app.whenReady().then(() => {
    startupLog('app ready')
    app.setAppUserModelId(APP_ID)
    const dbPath = userData.dbPath
    startupLog(
      `打开数据库 ${dbPath}${userData.migrated ? '（已从旧版 InfoAgent 目录搬入）' : ''}${userData.seeded ? '（首次启动，已载入随包示例数据）' : ''}`
    )
    const db = openDatabase(dbPath)
    startupLog('数据库就绪，迁移账号密文')
    try {
      migrateAccountSecrets(db)
    } catch (error) {
      // 密文解不开不应该阻断启动：留痕后继续，用户可重填账号密码
      startupLog(`migrateAccountSecrets 失败：${(error as Error).message}`)
    }
    const settingsStore = new SettingsStore(db)
    const syncManager = new SyncManager(db)
    const pipeline = new AnalysisPipeline(db, settingsStore)
    registerIpc(settingsStore, db, syncManager, pipeline)
    startupLog('IPC 注册完成')

    // P6 自启：启动时按保存的设置同步 Windows 登录项（仅打包版；开发模式不写注册表）
    void settingsStore
      .get()
      .then((s) => {
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: s.autoLaunch })
        }
      })
      .catch((error: unknown) => startupLog(`读取设置失败（不影响启动）：${(error as Error).message}`))

    // 生产环境收紧 CSP；开发环境放行 dev-server（HMR 需要 ws）
    if (!isDev) {
      app.on('web-contents-created', (_event, contents) => {
        // 知乎登录/抓取窗口是独立分区，需要加载知乎自己的脚本与接口；不能套知枢的 CSP。
        if (contents.session === session.fromPartition(ZHIHU_PARTITION)) return
        contents.session.webRequest.onHeadersReceived((details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              'Content-Security-Policy': [
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; " +
                "font-src 'self' data:; media-src 'self' data: https:; connect-src 'self'; frame-src 'self' about:; " +
                "object-src 'none'; form-action 'none'"
              ]
            }
          })
        })
      })
    }

    createWindow()
    startupLog('主窗口已创建')

    // 启动补扫：有凭据的账号串行增量同步（失败不阻塞启动）；同步落库后消费 pending 分析
    void syncManager
      .syncAll()
      .then(() => void pipeline.analyzePending())
      .catch((error: unknown) => startupLog(`启动补扫失败（不影响启动）：${(error as Error).message}`))

    try {
      tray = createTray({ showWindow, quit: quitApp })
      startupLog('托盘已创建')
    } catch (error) {
      console.warn('[tray] 托盘创建失败：', error)
      startupLog(`托盘创建失败：${(error as Error).message}`)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })

  // 托盘常驻：窗口全部关闭不退出；无托盘时恢复默认退出行为
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })
}
