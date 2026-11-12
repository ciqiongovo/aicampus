import { readPanelQuery as readQuery } from '../../shared/panelQuery'
import { app, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { SettingsStore } from '../store/settings'
import { IPC } from '../../shared/types'
import { isPanelAction } from '../../shared/panel'
import type { PanelActionKey, PanelIngestInput } from '../../shared/panel'
import {
  adjustConcernFromAct,
  panelAct,
  panelContinue,
  panelIngest,
  panelOverview,
  panelSources
} from '../services/panel/service'
import { deleteKeywordProfile, listKeywordProfile, setKeywordProfileWeight } from '../services/panel/keywordProfile'

function readKeywordLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? Math.trunc(raw) : 18
  return Math.max(1, Math.min(200, value))
}

/** 面板 IPC：只暴露推荐读取、继续阅读、处置、来源与外部接入五个入口 */
export function registerPanelIpc(db: DatabaseSync, store: SettingsStore): void {
  ipcMain.handle(IPC.panelOverview, (_event, sourceKey?: string, generate = true, query?: unknown) =>
    panelOverview(db, store, sourceKey, app.getPath('userData'), generate !== false, readQuery(query))
  )
  ipcMain.handle(IPC.panelContinue, (_event, sourceKey?: string, query?: unknown) =>
    panelContinue(db, store, sourceKey, app.getPath('userData'), readQuery(query))
  )
  ipcMain.handle(IPC.panelAct, async (_event, recommendationId: number, action: PanelActionKey, folder?: string) => {
    if (!Number.isInteger(recommendationId) || !isPanelAction(action)) {
      return { ok: false, message: '无效的推荐或动作', action, recommendationId }
    }
    const result = panelAct(db, store, recommendationId, action, folder)
    if (result.ok) await adjustConcernFromAct(db, recommendationId, action, app.getPath('userData'))
    return result
  })
  ipcMain.handle(IPC.panelIngest, (_event, input: PanelIngestInput) => panelIngest(db, input))
  ipcMain.handle(IPC.panelSources, () => panelSources(db))
  ipcMain.handle(IPC.panelKeywordProfile, (_event, limit?: unknown) => listKeywordProfile(db, new Date(), readKeywordLimit(limit)))
  ipcMain.handle(IPC.panelKeywordSet, (_event, keyword: unknown, weight: unknown) => {
    if (typeof keyword !== 'string' || keyword.trim().length < 1 || keyword.trim().length > 24) {
      return { ok: false, message: '关键词需为 1–24 个字符', items: listKeywordProfile(db, new Date(), 200) }
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || Math.abs(weight) > 3) {
      return { ok: false, message: '权重需在 -3 到 3 之间', items: listKeywordProfile(db, new Date(), 200) }
    }
    try {
      return { ok: true, message: '已更新关键词权重', items: setKeywordProfileWeight(db, keyword, weight) }
    } catch (error) {
      return { ok: false, message: '更新关键词失败：' + String(error), items: listKeywordProfile(db, new Date(), 200) }
    }
  })
  ipcMain.handle(IPC.panelKeywordDelete, (_event, keyword: unknown) => {
    if (typeof keyword !== 'string' || keyword.trim().length < 1 || keyword.trim().length > 24) {
      return { ok: false, message: '关键词无效', items: listKeywordProfile(db, new Date(), 200) }
    }
    try {
      return { ok: true, message: '已删除关键词', items: deleteKeywordProfile(db, keyword) }
    } catch (error) {
      return { ok: false, message: '删除关键词失败：' + String(error), items: listKeywordProfile(db, new Date(), 200) }
    }
  })
}
