import { DAILY_IPC } from '../shared/daily'
import type { DailyApi } from '../shared/daily'

/**
 * 日报新增 API 工厂：主代理把返回值展开进 window.api（与 RendererApi 合并）。
 * 旧方法（dailySourcesGet/Set/Generate/List/Status）仍在 preload/index.ts 的 RendererApi 中，不在此重复。
 */
export function createDailyApi(invoke: (channel: string, ...args: any[]) => Promise<any>): DailyApi {
  return {
    dailyFocusGet: () => invoke(DAILY_IPC.dailyFocusGet),
    dailyFocusSet: (topics) => invoke(DAILY_IPC.dailyFocusSet, topics),
    dailyReportsList: (query) => invoke(DAILY_IPC.dailyReportsList, query),
    dailyBoard: (dateKey) => invoke(DAILY_IPC.dailyBoard, dateKey),
    dailyReportGet: (dateKey) => invoke(DAILY_IPC.dailyReportGet, dateKey),
    dailyReportByInfo: (infoId) => invoke(DAILY_IPC.dailyReportByInfo, infoId),
    dailyReportArticles: (reportId, query) => invoke(DAILY_IPC.dailyReportArticles, reportId, query),
    dailySearch: (query) => invoke(DAILY_IPC.dailySearch, query),
    dailyArticleGet: (id) => invoke(DAILY_IPC.dailyArticleGet, id),
    dailyArticleContent: (id, query) => invoke(DAILY_IPC.dailyArticleContent, id, query),
    dailyArticleStatus: (id, status) => invoke(DAILY_IPC.dailyArticleStatus, id, status),
    dailyArticleCategory: (id, category) => invoke(DAILY_IPC.dailyArticleCategory, id, category)
  }
}
