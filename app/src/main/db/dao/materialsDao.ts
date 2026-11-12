import type { DatabaseSync } from 'node:sqlite'

/** 资料栏 DAO：只读 info.destination='keep'，资料标签存独立 material_tags 表。 */

export interface MaterialInfoRow {
  id: number
  title: string
  content: string
  source_type: string
  created_at: string
  item_id: number | null
  source_email_id: number | null
  material_folder: string | null
}

export interface MaterialTagRow {
  info_id: number
  parent_labels: string
  sub_labels: string
  source: string
  updated_at: string
}

export function listKeepInfo(db: DatabaseSync): MaterialInfoRow[] {
  return db
    .prepare(
      "SELECT id, title, content, source_type, created_at, item_id, source_email_id, material_folder" +
        " FROM info WHERE destination = 'keep' ORDER BY datetime(created_at) DESC, id DESC"
    )
    .all() as unknown as MaterialInfoRow[]
}

export function getKeepInfo(db: DatabaseSync, infoId: number): MaterialInfoRow | undefined {
  return db
    .prepare(
      "SELECT id, title, content, source_type, created_at, item_id, source_email_id, material_folder" +
        " FROM info WHERE id = ? AND destination = 'keep'"
    )
    .get(infoId) as MaterialInfoRow | undefined
}

export function setMaterialFolder(db: DatabaseSync, infoId: number, folder: string): void {
  db.prepare('UPDATE info SET material_folder = ? WHERE id = ?').run(folder, infoId)
}

export function getMaterialTags(db: DatabaseSync, infoId: number): MaterialTagRow | undefined {
  return db.prepare('SELECT * FROM material_tags WHERE info_id = ?').get(infoId) as MaterialTagRow | undefined
}

export function upsertMaterialTags(
  db: DatabaseSync,
  infoId: number,
  parentLabels: string[],
  subLabels: string[]
): void {
  db.prepare(
    'INSERT INTO material_tags (info_id, parent_labels, sub_labels, source, updated_at)' +
      " VALUES (?, ?, ?, 'auto', datetime('now','localtime'))" +
      ' ON CONFLICT(info_id) DO UPDATE SET' +
      ' parent_labels = excluded.parent_labels, sub_labels = excluded.sub_labels,' +
      " source = 'auto', updated_at = datetime('now','localtime')"
  ).run(infoId, JSON.stringify(parentLabels), JSON.stringify(subLabels))
}

