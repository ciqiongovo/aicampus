import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { RendererApi, WorkspaceApi, CognitionApi } from '../shared/types'
import type { ImApi } from '../shared/im'
import type { BenchApi } from '../shared/benchmark'
import { WORKSPACE_IPC } from '../shared/workspace'
import { COGNITION_IPC } from '../shared/cognition'
import { createDailyApi } from './daily'
import { createImApi } from './im'
import { createBenchApi } from './benchmark'
const workspaceApi = Object.fromEntries(Object.entries(WORKSPACE_IPC).map(([name, channel]) => [name, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)])) as unknown as WorkspaceApi
const cognitionApi = Object.fromEntries(Object.entries(COGNITION_IPC).map(([name, channel]) => [name, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)])) as unknown as CognitionApi

/** 白名单 API：渲染进程只能通过这些方法触达主进程 */
const api: RendererApi & ImApi & BenchApi = {
  ...workspaceApi,
  ...cognitionApi,
  ...createDailyApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  ...createImApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  ...createBenchApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  appOpenExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url),
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  mailProvidersList: () => ipcRenderer.invoke(IPC.mailProvidersList),
  accountsList: () => ipcRenderer.invoke(IPC.accountsList),
  accountsCreate: (input) => ipcRenderer.invoke(IPC.accountsCreate, input),
  accountsUpdate: (id, input) => ipcRenderer.invoke(IPC.accountsUpdate, id, input),
  accountsDelete: (id) => ipcRenderer.invoke(IPC.accountsDelete, id),
  accountsClearSecret: (id) => ipcRenderer.invoke(IPC.accountsClearSecret, id),
  accountsTest: (input, accountId) => ipcRenderer.invoke(IPC.accountsTest, input, accountId),
  accountsOauthBegin: (provider, clientId) => ipcRenderer.invoke(IPC.accountsOauthBegin, provider, clientId),
  accountsOauthPoll: (state) => ipcRenderer.invoke(IPC.accountsOauthPoll, state),
  accountsOauthCancel: (state) => ipcRenderer.invoke(IPC.accountsOauthCancel, state),
  mailSync: (accountId) => ipcRenderer.invoke(IPC.mailSync, accountId),
  mailSyncAll: () => ipcRenderer.invoke(IPC.mailSyncAll),
  mailSyncStatus: () => ipcRenderer.invoke(IPC.mailSyncStatus),
  mailList: (query) => ipcRenderer.invoke(IPC.mailList, query),
  mailTagDefinitionsList: () => ipcRenderer.invoke(IPC.mailTagDefinitionsList),
  mailTagDefinitionsCreate: (input) => ipcRenderer.invoke(IPC.mailTagDefinitionsCreate, input),
  mailTagDefinitionsDelete: (id) => ipcRenderer.invoke(IPC.mailTagDefinitionsDelete, id),
  mailTagsMatch: () => ipcRenderer.invoke(IPC.mailTagsMatch),
  mailTagsList: (query) => ipcRenderer.invoke(IPC.mailTagsList, query),
  mailTagsGet: (emailId) => ipcRenderer.invoke(IPC.mailTagsGet, emailId),
  mailTagsFeedback: (emailId, patch) => ipcRenderer.invoke(IPC.mailTagsFeedback, emailId, patch),
  tagPreferencesGet: () => ipcRenderer.invoke(IPC.tagPreferencesGet),
  tagPreferencesSet: (weights) => ipcRenderer.invoke(IPC.tagPreferencesSet, weights),
  mailGet: (id) => ipcRenderer.invoke(IPC.mailGet, id),
  mailSetUnread: (id, unread) => ipcRenderer.invoke(IPC.mailSetUnread, id, unread),
  mailSetStarred: (id, starred) => ipcRenderer.invoke(IPC.mailSetStarred, id, starred),
  mailAttachmentDownload: (emailId, filename) => ipcRenderer.invoke(IPC.mailAttachmentDownload, emailId, filename),
  mailFolders: () => ipcRenderer.invoke(IPC.mailFolders),
  aiProvidersList: () => ipcRenderer.invoke(IPC.aiProvidersList),
  aiTest: (config) => ipcRenderer.invoke(IPC.aiTest, config),
  aiAnalyze: (emailId) => ipcRenderer.invoke(IPC.aiAnalyze, emailId),
  aiAnalyzeAll: () => ipcRenderer.invoke(IPC.aiAnalyzeAll),
  aiStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  dailySourcesGet: () => ipcRenderer.invoke(IPC.dailySourcesGet),
  dailySourcesSet: (sources) => ipcRenderer.invoke(IPC.dailySourcesSet, sources),
  dailyGenerate: () => ipcRenderer.invoke(IPC.dailyGenerate),
  dailyList: (limit) => ipcRenderer.invoke(IPC.dailyList, limit),
  dailyStatus: () => ipcRenderer.invoke(IPC.dailyStatus),
  counterToday: () => ipcRenderer.invoke(IPC.counterToday),
  counterAct: (id, action) => ipcRenderer.invoke(IPC.counterAct, id, action),
  zhihuStatus: () => ipcRenderer.invoke(IPC.zhihuStatus),
  zhihuLogin: () => ipcRenderer.invoke(IPC.zhihuLogin),
  zhihuLogout: () => ipcRenderer.invoke(IPC.zhihuLogout),
  zhihuSync: (force) => ipcRenderer.invoke(IPC.zhihuSync, force === true),
  zhihuToday: () => ipcRenderer.invoke(IPC.zhihuToday),
  zhihuAct: (id, action, folder) => ipcRenderer.invoke(IPC.zhihuAct, id, action, folder),
  todoSnapshot: () => ipcRenderer.invoke(IPC.todoSnapshot),
  todoCreateItem: (input) => ipcRenderer.invoke(IPC.todoCreateItem, input),
  todoUpdateItem: (id, patch) => ipcRenderer.invoke(IPC.todoUpdateItem, id, patch),
  todoToggleItem: (id, completed) => ipcRenderer.invoke(IPC.todoToggleItem, id, completed),
  todoDeleteItem: (id) => ipcRenderer.invoke(IPC.todoDeleteItem, id),
  todoCreateList: (name, color) => ipcRenderer.invoke(IPC.todoCreateList, name, color),
  todoUpdateList: (id, patch) => ipcRenderer.invoke(IPC.todoUpdateList, id, patch),
  todoDeleteList: (id) => ipcRenderer.invoke(IPC.todoDeleteList, id),
  panelOverview: (sourceKey, generate, query) => ipcRenderer.invoke(IPC.panelOverview, sourceKey, generate, query),
  panelContinue: (sourceKey, query) => ipcRenderer.invoke(IPC.panelContinue, sourceKey, query),
  panelAct: (recommendationId, action, folder) => ipcRenderer.invoke(IPC.panelAct, recommendationId, action, folder),
  panelIngest: (input) => ipcRenderer.invoke(IPC.panelIngest, input),
  panelSources: () => ipcRenderer.invoke(IPC.panelSources),
  panelKeywordProfile: (limit) => ipcRenderer.invoke(IPC.panelKeywordProfile, limit),
  panelKeywordSet: (keyword, weight) => ipcRenderer.invoke(IPC.panelKeywordSet, keyword, weight),
  panelKeywordDelete: (keyword) => ipcRenderer.invoke(IPC.panelKeywordDelete, keyword),
  materialsCreateFolder: (name) => ipcRenderer.invoke(IPC.materialsCreateFolder, name),
  materialsRenameFolder: (key, name) => ipcRenderer.invoke(IPC.materialsRenameFolder, key, name),
  materialsDeleteFolder: (key) => ipcRenderer.invoke(IPC.materialsDeleteFolder, key),
  materialsBatch: (ids, action, folder) => ipcRenderer.invoke(IPC.materialsBatch, ids, action, folder),
  materialsCreate: (title, content, folder) => ipcRenderer.invoke(IPC.materialsCreate, title, content, folder),
  todoBatch: (ids, action, listId) => ipcRenderer.invoke(IPC.todoBatch, ids, action, listId),
  materialsList: (query) => ipcRenderer.invoke(IPC.materialsList, query)
}

contextBridge.exposeInMainWorld('api', api)
