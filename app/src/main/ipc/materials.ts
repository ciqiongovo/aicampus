import { ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { IPC } from '../../shared/types'
import type { MaterialListQuery } from '../../shared/materials'
import { batchMaterials, createMaterial, createMaterialFolder, deleteMaterialFolder, renameMaterialFolder, listMaterials } from '../services/materials/service'

/** 资料栏 IPC：自建资料、文件夹管理和原子批量操作。 */
export function registerMaterialsIpc(db: DatabaseSync): void {
  ipcMain.handle(IPC.materialsCreateFolder, (_e, name: string) => createMaterialFolder(db, name))
  ipcMain.handle(IPC.materialsRenameFolder, (_e, key: string, name: string) => renameMaterialFolder(db, key, name))
  ipcMain.handle(IPC.materialsDeleteFolder, (_e, key: string) => deleteMaterialFolder(db, key))
  ipcMain.handle(IPC.materialsBatch, (_e, ids: number[], action: 'delete' | 'move', folder?: string) => batchMaterials(db, ids, action, folder))
  ipcMain.handle(IPC.materialsCreate, (_e, title: string, content: string, folder?: string) => createMaterial(db, title, content, folder))
  ipcMain.handle(IPC.materialsList, (_event, query?: MaterialListQuery) => listMaterials(db, query ?? {}))
}
