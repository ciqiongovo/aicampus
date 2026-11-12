import type { ResourceKind } from '@shared/workspace'

export interface ResourceTarget {
  route: string
  label: string
}

export const RESOURCE_LABEL: Record<ResourceKind, string> = {
  email: '邮件',
  info: '信息',
  daily: '日报',
  article: '资讯',
  item: '事项',
  reminder: '提醒'
}

const RESOURCE_KINDS: ResourceKind[] = ['email', 'info', 'daily', 'article', 'item', 'reminder']

export const RESOURCE_TARGETS: Partial<Record<ResourceKind, ResourceTarget>> = {
  email: { route: '/mail', label: '在邮件中打开' },
  daily: { route: '/daily', label: '在日报中打开' },
  article: { route: '/daily', label: '在日报中打开' },
  item: { route: '/todo', label: '在待办中打开' },
  reminder: { route: '/todo', label: '在待办中打开' }
}

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as string[]).includes(value)
}
