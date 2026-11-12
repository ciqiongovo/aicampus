import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { DAILY_IPC } from '../../shared/daily'
import type { DailyOpResult, DailyReportItem, DailySourceConfig, DailyStatus } from '../../shared/types'
import type {
  DailyArticle,
  DailyArticleContentQuery,
  DailyArticleContentResult,
  DailyArticleOpResult,
  DailyArticleStatus,
  DailyArticlesPage,
  DailyArticlesQuery,
  DailyBoard,
  DailyReportDetail,
  DailyReportsQuery,
  DailyReportsResult,
  DailySearchQuery,
  DailySearchResult
} from '../../shared/daily'
import type { SettingsStore } from '../store/settings'
import { DailyService } from '../services/daily/service'
import type { CounterRecService } from '../services/counterRec/service'

function sanitizeSources(input: unknown): DailySourceConfig[] | null {
  if (!Array.isArray(input) || input.length > 20) return null
  const out: DailySourceConfig[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') return null
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id.trim() === '' || typeof o.label !== 'string' || typeof o.endpoint !== 'string') return null
    const endpoint = o.endpoint.trim()
    if (!/^https?:\/\//.test(endpoint) || endpoint.length > 500) return null
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return null
    if (o.builtin !== undefined && typeof o.builtin !== 'boolean') return null
    out.push({
      id: o.id.trim().slice(0, 50),
      label: o.label.trim().slice(0, 50),
      endpoint,
      enabled: o.enabled !== false,
      builtin: o.builtin === true
    })
  }
  if (out.length === 0) return null
  return out
}

function isStatus(v: unknown): v is DailyArticleStatus {
  return v === 'keep' || v === 'archive' || v === 'item' || v === 'unverified'
}

/** P4/P5 日报 IPC：旧通道（sources/get/generate/list/status）保持原样，新通道走 shared/daily.ts 的 DAILY_IPC */
export function registerDailyIpc(store: SettingsStore, daily: DailyService, counterRec: CounterRecService): void {
  ipcMain.handle(IPC.dailySourcesGet, (): DailySourceConfig[] => daily.effectiveSources())

  ipcMain.handle(IPC.dailySourcesSet, async (_event, sources: DailySourceConfig[]): Promise<DailyOpResult> => {
    // 空数组 = 恢复内置默认源（清除自定义配置，effectiveSources 回退到内置预设）；非空数组允许零启用
    if (Array.isArray(sources) && sources.length === 0) {
      await store.set({ dailySources: [] })
      return { ok: true, message: '已恢复内置默认源' }
    }
    const clean = sanitizeSources(sources)
    if (!clean) return { ok: false, message: '源配置无效：需要非空数组，每项含 id/label/endpoint（http(s)）' }
    await store.set({ dailySources: clean })
    const enabled = clean.filter((s) => s.enabled).length
    return { ok: true, message: enabled > 0 ? `已保存 ${enabled} 个启用源` : '已保存源配置（当前未启用任何源）' }
  })

  ipcMain.handle(IPC.dailyGenerate, async (): Promise<DailyOpResult> => {
    const result = await daily.generate(true)
    // P5：日报立即生成成功后联动生成当天反推荐（fire-and-forget，失败不影响日报返回）
    if (result.ok) void counterRec.generate().catch(() => {})
    return result
  })
  ipcMain.handle(IPC.dailyList, (_event, limit: number): DailyReportItem[] => {
    const n = Number.isFinite(limit) && limit > 0 && limit <= 100 ? Math.floor(limit) : 14
    return daily.listReports(n)
  })
  ipcMain.handle(IPC.dailyStatus, (): DailyStatus => daily.status())

  // ---------- 新增结构化日报通道 ----------
  ipcMain.handle(DAILY_IPC.dailyFocusGet, (): string[] => daily.getFocusTopics())
  ipcMain.handle(DAILY_IPC.dailyFocusSet, (_event, topics: unknown): DailyOpResult => daily.setFocusTopics(topics))
  ipcMain.handle(DAILY_IPC.dailyReportsList, (_event, query?: DailyReportsQuery): DailyReportsResult => daily.listReportsPaged(query ?? {}))
  ipcMain.handle(DAILY_IPC.dailyBoard, (_event, dateKey?: string): DailyBoard => daily.getBoard(dateKey))
  ipcMain.handle(DAILY_IPC.dailyReportGet, (_event, dateKey: string): DailyReportDetail | null => {
    return typeof dateKey === 'string' ? daily.getReportDetail(dateKey) : null
  })
  ipcMain.handle(DAILY_IPC.dailyReportByInfo, (_event, infoId: number): DailyReportDetail | null => {
    return Number.isInteger(infoId) ? daily.getReportDetailByInfo(infoId) : null
  })
  ipcMain.handle(DAILY_IPC.dailyReportArticles, (_event, reportId: number, query?: DailyArticlesQuery): DailyArticlesPage | null => {
    return Number.isInteger(reportId) ? daily.getReportArticles(reportId, query ?? {}) : null
  })
  ipcMain.handle(DAILY_IPC.dailySearch, (_event, query?: DailySearchQuery): DailySearchResult => daily.searchArticles(query ?? {}))
  ipcMain.handle(DAILY_IPC.dailyArticleGet, (_event, id: number): DailyArticle | null => {
    return Number.isInteger(id) ? daily.getArticle(id) : null
  })
  ipcMain.handle(DAILY_IPC.dailyArticleContent, (_event, id: number, query?: DailyArticleContentQuery): DailyArticleContentResult | null => {
    return Number.isInteger(id) ? daily.getArticleContent(id, query ?? {}) : null
  })
  ipcMain.handle(DAILY_IPC.dailyArticleStatus, (_event, id: number, status: unknown): DailyArticleOpResult => {
    if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '无效的资讯条目' }
    if (!isStatus(status)) return { ok: false, message: '无效的状态' }
    return daily.setArticleStatus(id, status)
  })
  ipcMain.handle(DAILY_IPC.dailyArticleCategory, (_event, id: number, category: unknown): DailyArticleOpResult => {
    if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '无效的资讯条目' }
    if (typeof category !== 'string') return { ok: false, message: '无效的分类' }
    return daily.setArticleCategory(id, category)
  })
}
