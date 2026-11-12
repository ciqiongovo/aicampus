import type { PanelOverviewQuery } from './panel'
export function readPanelQuery(value: unknown): PanelOverviewQuery | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的面板查询')
  const query = value as PanelOverviewQuery
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new Error('无效的分页大小')
  if (query.beforeInfoId !== undefined && (!Number.isSafeInteger(query.beforeInfoId) || query.beforeInfoId < 1)) throw new Error('无效的分页游标')
  if (query.priority !== undefined && query.priority !== 'focus' && query.priority !== 'other') throw new Error('无效的推荐分组')
  if (query.mailDateRange !== undefined && ![1, 3, 7, 14, 30, 'older30'].includes(query.mailDateRange)) throw new Error('无效的邮件日期范围')
  return { limit: Math.min(query.limit ?? 30, 100), beforeInfoId: query.beforeInfoId, priority: query.priority, mailDateRange: query.mailDateRange }
}
