import { app, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { SyncManager } from '../services/mail/syncManager'
import type { AnalysisPipeline } from '../services/ai/pipeline'
import type { SettingsStore } from '../store/settings'
import { registerAccountsIpc } from './accounts'
import { registerAiIpc } from './ai'
import { registerAppIpc } from './app'
import { registerDailyIpc } from './daily'
import { registerWorkspaceIpc } from './workspace'
import { BackgroundProcessor } from '../services/jarvis/background'
import { registerMailIpc } from './mail'
import { registerMailTagsIpc } from './mailTags'
import { registerMaterialsIpc } from './materials'
import { registerPanelIpc } from './panel'
import { registerTodoIpc } from './todo'
import { registerSettingsIpc } from './settings'
import { ReminderScheduler } from '../services/reminders/scheduler'
import { DailyScheduler, DailyService } from '../services/daily/service'
import { CounterRecService } from '../services/counterRec/service'
import { registerCounterRecIpc } from './counterRec'
import { ZhihuService } from '../services/zhihu/service'
import { createZhihuGateway } from '../services/zhihu/feed'
import { registerZhihuIpc } from './zhihu'
import { registerImIpc } from './im'
import { QceRuntime, isLegacyQqPath } from '../services/im/qceRuntime'
import { IM_IPC } from '../../shared/im'
import { ImService } from '../services/im/service'
import { BenchmarkService } from '../services/benchmark/service'
import { xlsxToCsv } from '../services/benchmark/xlsx'
import { registerBenchIpc } from './benchmark'
import { chatCompletion } from '../services/ai/analyzer'

/** 按域注册全部 IPC 处理器（后续里程碑在此追加提醒等域） */
export function registerIpc(
  store: SettingsStore,
  db: DatabaseSync,
  syncManager: SyncManager,
  pipeline: AnalysisPipeline
): void {
  registerAppIpc()
  registerSettingsIpc(store)
  registerAccountsIpc(db)
  registerMailIpc(db, syncManager, pipeline)
  registerMailTagsIpc(db, pipeline)
  // 日程 / 待办：共用 items 表（邮件产生事项 → 待办勾选 → 日程排期）
  registerTodoIpc(db)
  registerAiIpc(pipeline, store)
  // 提醒调度器随主进程存活；事项与提醒由 Jarvis 和后台队列写入，调度器只负责到点弹出
  const scheduler = new ReminderScheduler(db, () => store.peek())
  scheduler.start()
  registerWorkspaceIpc(db, store)
  registerPanelIpc(db, store)
  registerMaterialsIpc(db)
  // 聊天记录源（微信/QQ）：DB 走 v20 迁移，采集在 services/im，AI 复用全局设置
  const imService = new ImService({
    db,
    log: (message) => console.log('[im]', message),
    complete: async (system, user, jsonMode) => {
      const s = await store.get()
      if (!s.aiBaseURL || !s.aiModel) throw new Error('未配置 AI 模型，已退回本地规则抽取')
      if (s.aiAuthorizedFor !== `${s.aiProvider}|${s.aiBaseURL}`) throw new Error('当前 AI 端点尚未授权')
      return chatCompletion(
        { provider: s.aiProvider, baseURL: s.aiBaseURL, model: s.aiModel, apiKey: s.aiApiKey },
        system,
        user,
        jsonMode
      )
    }
  })
  // 内置 QCE 运行集：登录（拉起 QQ 注入）/ 退出登录（结束进程树）都走这里
  const qceRuntime = new QceRuntime({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData')
  })
  registerImIpc(ipcMain, imService, qceRuntime)

  // 跨校对标库：DB 走 v30 迁移，抓取用隐藏 BrowserWindow（services/benchmark/fetcher）
  const benchmarkService = new BenchmarkService(db, store)
  registerBenchIpc(ipcMain, benchmarkService, {
    /**
     * 选一份文章列表读进来。
     *
     * 只读文本，不落盘、不解析格式——链接的识别交给服务层，
     * 这里换什么工具导出的表格都行，只要能读出文字。
     */
    pickTextFile: async () => {
      const picked = await dialog.showOpenDialog({
        title: '选择公众号文章列表（CSV / Excel / TXT，工具导出的表格直接选）',
        properties: ['openFile'],
        filters: [
          {
            name: '文章列表',
            extensions: ['csv', 'xlsx', 'txt', 'tsv', 'md', 'json', 'html', 'htm']
          },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      const file = picked.filePaths[0]
      const buf = readFileSync(file)
      // 几千条链接也就几 MB；上百 MB 的多半是选错了文件，别让界面卡死
      if (buf.length > 80 * 1024 * 1024) {
        throw new Error('文件超过 80 MB，多半不是文章列表。请只选工具导出的那份表格。')
      }
      // xlsx 是个 zip，按文本读只会得到乱码，必须先解出工作表再当 CSV 使
      if (/\.xlsx$/i.test(file)) {
        return { path: file, text: xlsxToCsv(buf) }
      }
      let text = buf.toString('utf8')
      // Excel 另存的中文 CSV 常是 GBK：按 UTF-8 解会出现替换字符，换成 GBK 再读一次
      if (text.includes('\uFFFD')) {
        try {
          text = new TextDecoder('gbk').decode(buf)
        } catch {
          // 环境不支持 GBK 就沿用 UTF-8 的结果，能读到多少算多少
        }
      }
      return { path: file, text }
    }
  })

  // QCE 运行集目录：打开资源管理器 / 手动指定 QQ.exe（两者都要 electron 的 shell 与 dialog）
  ipcMain.handle(IM_IPC.imQceReveal, () => {
    const dir = qceRuntime.qceDir()
    if (!dir) return false
    void shell.openPath(dir)
    return true
  })
  ipcMain.handle(IM_IPC.imQcePickQq, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择 QQ.exe（需要 QQNT 9.9.x）',
      properties: ['openFile'],
      filters: [{ name: 'QQ', extensions: ['exe'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const qqPath = picked.filePaths[0]
    if (!/[\\/]qq\.exe$/i.test(qqPath)) throw new Error('请选择 QQNT 的 QQ.exe')
    if (isLegacyQqPath(qqPath)) throw new Error('这是旧版 QQ（\\Bin\\QQ.exe），NapCat 需要 QQNT 9.9.x')
    qceRuntime.setQqPath(qqPath)
    return qqPath
  })

  // 聊天记录导出文件选择（QQ / 微信均可）：主进程持有 dialog，渲染层只拿路径
  ipcMain.handle(IM_IPC.imPickImportFiles, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择聊天记录导出文件（QQ / 微信）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '聊天记录导出文本', extensions: ['txt', 'log'] }]
    })
    return picked.canceled ? [] : picked.filePaths
  })
  const background=new BackgroundProcessor(db,store)
  let latestInfo=(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM info').get() as {id:number}).id
  const backgroundTimer=setInterval(()=>{
    const fresh=db.prepare('SELECT id FROM info WHERE id>? ORDER BY id').all(latestInfo) as {id:number}[]
    for(const row of fresh){background.enqueue(row.id);latestInfo=row.id}
    background.drain()
  },60_000)
  background.drain()
  // P4 日报：8:00 定时 + 启动补生成（错过 8:00 后下次启动补当天日报）
  const daily = new DailyService(db, store)
  // P5 反推荐：日报生成完成后联动生成当天反推荐（每日 ≤1 条）
  const counterRec = new CounterRecService(db, store, daily)
  // 知乎反推荐：日报联动之外，启动后也补一次（日报已生成时 afterGenerate 不会触发）
  const zhihu = new ZhihuService(db, store, createZhihuGateway())
  const dailyScheduler = new DailyScheduler(daily, () => new Date(), async () => {
    await counterRec.generate()
    await zhihu.sync()
  })
  dailyScheduler.start()
  registerDailyIpc(store, daily, counterRec)
  registerCounterRecIpc(counterRec)
  registerZhihuIpc(zhihu)
  void store.get().then(async () => {
    await dailyScheduler.bootstrap()
    await zhihu.sync()
  })
  // 主进程退出前停掉定时器，避免退出期间再触发扫描
  app.once('before-quit', () => {
    scheduler.stop()
    dailyScheduler.stop()
    clearInterval(backgroundTimer)
  })
}
