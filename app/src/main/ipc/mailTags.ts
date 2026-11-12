import { app, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { IPC } from '../../shared/types'
import type { MailTagDefinitionInput } from '../../shared/mailLabels'
import type { MailTagFeedbackPatch, MailTagsQuery } from '../../shared/mailTags'
import { createMailTagDefinition, deleteMailTagDefinition, listMailTagDefinitions } from '../db'
import type { AnalysisPipeline } from '../services/ai/pipeline'
import { getMailTagService } from '../services/mailTags'

/** 固定 IPC 白名单；服务层验证每个变更、只读白名单列表不传任意文件路径。 */
export function registerMailTagsIpc(db: DatabaseSync, pipeline: AnalysisPipeline): void {
  ipcMain.handle(IPC.mailTagDefinitionsList, () => listMailTagDefinitions(db))
  ipcMain.handle(IPC.mailTagDefinitionsCreate, (_event, input: MailTagDefinitionInput) => createMailTagDefinition(db, input))
  ipcMain.handle(IPC.mailTagDefinitionsDelete, (_event, id: number) => deleteMailTagDefinition(db, id))
  ipcMain.handle(IPC.mailTagsMatch, () => pipeline.matchCustomTags())
  const service = getMailTagService(app.getPath('userData'))
  ipcMain.handle(IPC.mailTagsList, (_event, query?: MailTagsQuery) => service.list(db, query))
  ipcMain.handle(IPC.mailTagsGet, (_event, emailId: number) => service.get(db, emailId))
  ipcMain.handle(IPC.mailTagsFeedback, (_event, emailId: number, patch: MailTagFeedbackPatch) => service.feedback(db, emailId, patch))
  ipcMain.handle(IPC.tagPreferencesGet, () => service.preferencesGet())
  ipcMain.handle(IPC.tagPreferencesSet, (_event, weights: Record<string, number>) => service.preferencesSet(weights))
}
