import { randomUUID } from 'node:crypto'
import { createInfo } from '../../db/dao/infoDao'
import type { DatabaseSync } from 'node:sqlite'
import type {
  MaterialFolder,
  MaterialItem,
  MaterialListQuery,
  MaterialListResult,
  MaterialTag
} from '../../../shared/materials'
import { matchTopics } from '../../../shared/mailTags'
import {
  PANEL_TOPICS,
  UNCATEGORIZED_TOPIC,
  isPanelTopic,
  topicName
} from '../../../shared/topics'
import {
  getKeepInfo,
  getMaterialTags,
  listKeepInfo,
  setMaterialFolder,
  upsertMaterialTags
} from '../../db/dao/materialsDao'
import type { MaterialInfoRow, MaterialTagRow } from '../../db/dao/materialsDao'

/** 资料栏服务：保存位置由用户选择；标签独立于邮件标签库，不与 mail-tags.json 混用。 */

function sourceLabels(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT key, label FROM inbox_source').all() as unknown as Array<{
    key: string
    label: string
  }>
  return new Map(rows.map((row) => [row.key, row.label]))
}

function textOf(row: MaterialInfoRow): string {
  return `${row.title ?? ''} ${row.content ?? ''}`.slice(0, 20_000)
}

function tagLabels(ids: string[]): MaterialTag[] {
  return ids.map((id) => ({ id, label: topicName(id) }))
}

interface EnsuredMaterial {
  folder: string
  parentIds: string[]
  subLabels: string[]
  tagRow: MaterialTagRow | undefined
}

/** 懒补齐资料标签，未指定文件夹时进入未分组；保留既有目录。 */
function ensureMaterial(db: DatabaseSync, row: MaterialInfoRow): EnsuredMaterial {
  const existing = getMaterialTags(db, row.id)
  const { parents, subs } = matchTopics(textOf(row))
  const folder = row.material_folder || UNCATEGORIZED_TOPIC
  const parentIds = [...new Set(parents)]
  const subLabels = [...new Set(subs)].slice(0, 6)
  if (!existing || existing.parent_labels !== JSON.stringify(parentIds) || existing.sub_labels !== JSON.stringify(subLabels)) {
    upsertMaterialTags(db, row.id, parentIds, subLabels)
  }
  if (!row.material_folder) setMaterialFolder(db, row.id, folder)
  return {
    folder,
    parentIds,
    subLabels,
    tagRow: existing && existing.parent_labels === JSON.stringify(parentIds) ? existing : undefined
  }
}

function toItem(row: MaterialInfoRow, ensured: EnsuredMaterial, labels: Map<string, string>, folders: Map<string, string>): MaterialItem {
  return {
    id: row.id,
    title: row.title || '(无标题)',
    excerpt: (row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 260),
    content: (row.content ?? '').slice(0, 4000),
    sourceKey: row.source_type,
    sourceLabel: labels.get(row.source_type) ?? row.source_type,
    folder: ensured.folder,
    folderLabel: folders.get(ensured.folder) ?? topicName(ensured.folder),
    parentTags: tagLabels(ensured.parentIds),
    subLabels: ensured.subLabels,
    createdAt: row.created_at,
    emailId: row.source_email_id
  }
}

export function listMaterials(db: DatabaseSync, query: MaterialListQuery = {}): MaterialListResult {
  const rows = listKeepInfo(db)
  const labels = sourceLabels(db)
  const directory = db.prepare('SELECT key, label FROM material_folders ORDER BY rowid').all() as unknown as Array<{key: string; label: string}>
  const folderLabels = new Map(directory.map(f => [f.key, isPanelTopic(f.key) && f.key !== UNCATEGORIZED_TOPIC && f.label === f.key ? topicName(f.key) : f.label]))
  const items = rows.map((row) => toItem(row, ensureMaterial(db, row), labels, folderLabels))

  const folders: MaterialFolder[] = directory.map(f => ({ key: f.key, label: folderLabels.get(f.key)!, count: items.filter(item => item.folder === f.key).length }))
  const tags = PANEL_TOPICS.filter((topic) => topic.id !== UNCATEGORIZED_TOPIC).map((topic) => ({
    id: topic.id,
    label: topic.name,
    count: items.filter((item) => item.parentTags.some((tag) => tag.id === topic.id)).length
  }))

  const keyword = typeof query.keyword === 'string' ? query.keyword.trim().toLowerCase().slice(0, 120) : ''
  const folder = typeof query.folder === 'string' && query.folder.length > 0 ? query.folder : undefined
  const tag = typeof query.tag === 'string' && isPanelTopic(query.tag) ? query.tag : undefined
  const filtered = items.filter((item) => {
    if (folder && item.folder !== folder) return false
    if (tag && !item.parentTags.some((entry) => entry.id === tag)) return false
    if (keyword) {
      const text = `${item.title} ${item.excerpt}`.toLowerCase()
      if (!text.includes(keyword)) return false
    }
    return true
  })
  const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit!, 1), 500) : 200
  return {
    total: filtered.length,
    items: filtered.slice(0, limit),
    folders,
    tags
  }
}

export interface SaveMaterialResult {
  ok: boolean
  folder: string
  folderLabel: string
  message: string
}

/** 保存位置由用户选择；不传时进入未分组。 */
export function saveMaterial(db: DatabaseSync, infoId: number, selectedFolder?: string | null): SaveMaterialResult {
  const folder = selectedFolder || UNCATEGORIZED_TOPIC
  const entry = requireFolder(db, folder)
  const row = getKeepInfo(db, infoId)
  if (!row) return { ok: false, folder, folderLabel: entry, message: '信息条目不存在，无法存为资料' }
  setMaterialFolder(db, infoId, folder)
  ensureMaterial(db, { ...row, material_folder: folder })
  return { ok: true, folder, folderLabel: entry, message: `已存为资料 · ${entry}` }
}

function requireFolder(db: DatabaseSync, key: string): string {
  const row = db.prepare('SELECT label FROM material_folders WHERE key=?').get(key) as {label: string} | undefined
  if (!row) throw new Error('文件夹不存在，请重新选择')
  return isPanelTopic(key) && key !== UNCATEGORIZED_TOPIC && row.label === key ? topicName(key) : row.label
}
function folderName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new Error('文件夹名称须为 1 至 60 个字符')
  return name.trim()
}
export function createMaterialFolder(db: DatabaseSync, name: string): string {
  const key = randomUUID()
  db.prepare('INSERT INTO material_folders VALUES (?,?)').run(key, folderName(name))
  return key
}
export function renameMaterialFolder(db: DatabaseSync, key: string, name: string): void {
  if (key === UNCATEGORIZED_TOPIC) throw new Error('未分组不可重命名')
  requireFolder(db, key)
  db.prepare('UPDATE material_folders SET label=? WHERE key=?').run(folderName(name), key)
}
export function deleteMaterialFolder(db: DatabaseSync, key: string): void {
  if (key === UNCATEGORIZED_TOPIC) throw new Error('未分组不可删除')
  requireFolder(db, key)
  db.exec('SAVEPOINT material_folder_delete')
  try {
    db.prepare('UPDATE info SET material_folder=? WHERE material_folder=?').run(UNCATEGORIZED_TOPIC, key)
    db.prepare('DELETE FROM material_folders WHERE key=?').run(key)
    db.exec('RELEASE material_folder_delete')
  } catch (e) { db.exec('ROLLBACK TO material_folder_delete; RELEASE material_folder_delete'); throw e }
}
export function batchMaterials(db: DatabaseSync, ids: number[], action: 'delete' | 'move', folder?: string): void {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('请选择 1 至 500 条资料')
  if (action !== 'delete' && action !== 'move') throw new Error('无效操作')
  if (action === 'move') requireFolder(db, folder!)
  db.exec('SAVEPOINT material_batch')
  try {
    for (const id of new Set(ids)) {
      if (!getKeepInfo(db, id)) throw new Error('部分资料已不存在，请刷新后重试')
      if (action === 'move') setMaterialFolder(db, id, folder!)
      else {
        db.prepare("UPDATE info SET destination='archive',material_folder=NULL WHERE id=?").run(id)
        db.prepare('DELETE FROM material_tags WHERE info_id=?').run(id)
      }
    }
    db.exec('RELEASE material_batch')
  } catch (e) { db.exec('ROLLBACK TO material_batch; RELEASE material_batch'); throw e }
}
export function createMaterial(db: DatabaseSync, title: string, content: string, folder: string = UNCATEGORIZED_TOPIC): void {
  requireFolder(db, folder)
  if (typeof title !== 'string' || !title.trim() || title.length > 300 || typeof content !== 'string' || content.length > 200000) throw new Error('请填写标题（最多300字），正文最多20万字')
  db.exec('SAVEPOINT material_create')
  try {
    const id = createInfo(db, {title: title.trim(), content, source_type: 'manual', destination: 'keep'})
    saveMaterial(db, id, folder)
    db.exec('RELEASE material_create')
  } catch (e) { db.exec('ROLLBACK TO material_create; RELEASE material_create'); throw e }
}
