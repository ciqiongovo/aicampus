/** 资料栏契约：用户自建文件夹，AI 标签独立于文件夹。 */

export interface MaterialTag {
  id: string
  label: string
}

export interface MaterialItem {
  id: number
  title: string
  excerpt: string
  content: string
  sourceKey: string
  sourceLabel: string
  folder: string
  folderLabel: string
  parentTags: MaterialTag[]
  subLabels: string[]
  createdAt: string
  emailId: number | null
}

export interface MaterialFolder {
  key: string
  label: string
  count: number
}

export interface MaterialListQuery {
  keyword?: string
  folder?: string
  tag?: string
  limit?: number
}

export interface MaterialListResult {
  total: number
  items: MaterialItem[]
  folders: MaterialFolder[]
  tags: Array<MaterialTag & { count: number }>
}

export interface MaterialApi {
  materialsCreateFolder(name: string): Promise<string>
  materialsRenameFolder(key: string, name: string): Promise<void>
  materialsDeleteFolder(key: string): Promise<void>
  materialsBatch(ids: number[], action: 'delete' | 'move', folder?: string): Promise<void>
  materialsCreate(title: string, content: string, folder?: string): Promise<void>
  materialsList(query?: MaterialListQuery): Promise<MaterialListResult>
}
