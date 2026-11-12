import type { DatabaseSync } from 'node:sqlite'
import type { MailTagDefinition, MailTagDefinitionInput } from '../../../shared/mailLabels'

const MAX_TAGS = 100
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

export function validateTagIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length > MAX_TAGS || raw.some(id => !validId(id))) throw new Error('标签 ID 必须为正整数数组（最多100项）')
  return [...new Set(raw as number[])]
}

export function listMailTagDefinitions(db: DatabaseSync): MailTagDefinition[] {
  const rows = db.prepare('SELECT id, name, description FROM mail_tag_definitions ORDER BY id').all() as unknown as MailTagDefinition[]
  return rows.map(({ id, name, description }) => ({ id, name, description }))
}

export function createMailTagDefinition(db: DatabaseSync, input: MailTagDefinitionInput): MailTagDefinition {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string') throw new Error('标签名称必须为文本')
  const name = input.name.trim()
  if (!name || name.length > 40 || /[<>\r\n\u0000-\u001f\u007f]/.test(name)) throw new Error('标签名称须为1–40字且不能包含控制字符或尖括号')
  if (input.description !== undefined && typeof input.description !== 'string') throw new Error('标签描述必须为文本')
  const description = (input.description ?? '').trim()
  if (description.length > 500 || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) throw new Error('标签描述须不超过500字且不能包含非法字符')
  const nameKey = name.normalize('NFKC').toLowerCase()
  if (db.prepare('SELECT id FROM mail_tag_definitions WHERE name_key = ?').get(nameKey)) throw new Error('标签名称已存在（不区分大小写）')
  if ((db.prepare('SELECT COUNT(*) AS n FROM mail_tag_definitions').get() as { n: number }).n >= MAX_TAGS) throw new Error('最多创建100个标签')
  const result = db.prepare('INSERT INTO mail_tag_definitions (name, name_key, description) VALUES (?, ?, ?)').run(name, nameKey, description)
  return { id: Number(result.lastInsertRowid), name, description }
}

export function deleteMailTagDefinition(db: DatabaseSync, id: number): void {
  if (!validId(id)) throw new Error('标签 ID 必须为正整数')
  db.prepare('DELETE FROM mail_tag_definitions WHERE id = ?').run(id)
}

/** 只查询当前页，避免列表全量关联；返回值稳定按定义ID排序。 */
export function getMailTagsForEmails(db: DatabaseSync, emailIds: number[]): Map<number, MailTagDefinition[]> {
  const result = new Map<number, MailTagDefinition[]>()
  if (!emailIds.length) return result
  const rows = db.prepare('SELECT t.email_id, d.id, d.name, d.description FROM email_custom_tags t JOIN mail_tag_definitions d ON d.id = t.tag_id WHERE t.email_id IN (' + emailIds.map(() => '?').join(',') + ') ORDER BY d.id').all(...emailIds) as unknown as Array<MailTagDefinition & { email_id: number }>
  for (const row of rows) {
    const tags = result.get(row.email_id) ?? []
    tags.push({ id: row.id, name: row.name, description: row.description })
    result.set(row.email_id, tags)
  }
  return result
}

export function customTagsMatchIsCurrent(db: DatabaseSync, emailId: number, fingerprint: string): boolean {
  return !!db.prepare('SELECT email_id FROM email_custom_tag_matches WHERE email_id = ? AND fingerprint = ?').get(emailId, fingerprint)
}

/** null/非法/仅幻觉ID不视为无匹配；只有显式[]可以清空。失败不改旧关系/指纹。 */
export function saveCustomTagMatch(db: DatabaseSync, emailId: number, rawIds: number[] | null, definitions: MailTagDefinition[], fingerprint: string): boolean {
  if (rawIds === null || rawIds.some(id => !validId(id))) return false
  const allowed = new Set(definitions.map(tag => tag.id))
  const ids = [...new Set(rawIds.filter(id => allowed.has(id)))]
  if (rawIds.length && !ids.length) return false
  // 网络等待期间可能删除邮件/标签；写入时再次校验外键存在，绝不重建定义。
  db.exec('SAVEPOINT custom_tag_match')
  try {
    if (!db.prepare('SELECT id FROM emails WHERE id = ?').get(emailId)) {
      db.exec('RELEASE custom_tag_match')
      return false
    }
    db.prepare('DELETE FROM email_custom_tags WHERE email_id = ?').run(emailId)
    const insert = db.prepare('INSERT INTO email_custom_tags (email_id, tag_id) SELECT ?, id FROM mail_tag_definitions WHERE id = ?')
    for (const id of ids) insert.run(emailId, id)
    db.prepare('INSERT INTO email_custom_tag_matches (email_id, fingerprint) VALUES (?, ?) ON CONFLICT(email_id) DO UPDATE SET fingerprint = excluded.fingerprint').run(emailId, fingerprint)
    db.exec('RELEASE custom_tag_match')
    return true
  } catch (error) {
    db.exec('ROLLBACK TO custom_tag_match; RELEASE custom_tag_match')
    throw error
  }
}
