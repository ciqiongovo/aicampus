import { useState } from 'react'
import { Button, Checkbox, Dropdown, Input, Popover, Tag, Tooltip } from 'antd'
import { DownOutlined, FilterOutlined, MailOutlined, PaperClipOutlined, ReloadOutlined, SearchOutlined, StarOutlined, SyncOutlined, TagsOutlined } from '@ant-design/icons'
import { MailTagControls, useMailTagCatalog } from './tagControls'
import type { TagMatchMode } from './tagControls'

export interface MailFilters {
  unreadOnly: boolean
  hasAttachment: boolean
  starredOnly: boolean
}
interface MailSearchToolbarProps {
  scopeTitle: string
  total: number | undefined
  keyword: string
  keywordInput: string
  onKeywordInputChange: (value: string) => void
  onSearch: (value: string) => void
  filters: MailFilters
  onFiltersChange: (filters: MailFilters) => void
  tagIds: number[]
  tagMatch: TagMatchMode
  onTagIdsChange: (ids: number[]) => void
  onTagMatchChange: (mode: TagMatchMode) => void
  onClear: () => void
  onTagsChanged: () => void
  fetching: boolean
  reloading: boolean
  onFetch: () => void
  onReload: () => void
}
const FILTER_OPTIONS = [
  { key: 'unreadOnly', label: '仅未读', icon: <MailOutlined /> },
  { key: 'hasAttachment', label: '有附件', icon: <PaperClipOutlined /> },
  { key: 'starredOnly', label: '已加星标', icon: <StarOutlined /> }
] as const

/** 搜索是主入口；各类条件独立叠加，标签目录、管理及匹配状态共用同一控制器。 */
export function MailSearchToolbar(props: MailSearchToolbarProps): JSX.Element {
  const { scopeTitle, total, keyword, keywordInput, onKeywordInputChange, onSearch, filters, onFiltersChange, tagIds, tagMatch, onTagIdsChange, onTagMatchChange, onClear, fetching, reloading, onFetch, onReload } = props
  const catalog = useMailTagCatalog(props.onTagsChanged)
  const [filterOpen, setFilterOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const activeFilters = FILTER_OPTIONS.filter((option) => filters[option.key])
  const hasConditions = !!keyword || tagIds.length > 0 || activeFilters.length > 0
  const filterMenu = <div className="mail-filter-menu" role="group" aria-label="邮件条件筛选">
    <div className="mail-menu-heading"><span>邮件条件</span><span className="mail-menu-meta">同时满足</span></div>
    {FILTER_OPTIONS.map((option) => <Checkbox className="mail-filter-option" key={option.key} checked={filters[option.key]} onChange={(event) => onFiltersChange({ ...filters, [option.key]: event.target.checked })}><span>{option.icon}{option.label}</span></Checkbox>)}
    <div className="mail-filter-menu-footer">可多选，与搜索和标签一起生效</div>
  </div>

  return <div className="mail-list-toolbar">
    <div className="mail-scope"><div className="mail-scope-copy"><span className="mail-scope-title">{scopeTitle}</span><span className="mail-scope-total">{total === undefined ? '载入中…' : total + ' 封邮件'}</span></div>
      {catalog.matching ? <span className="mail-match-status" role="status"><SyncOutlined spin />正在匹配标签</span> : catalog.matchWarning ? <Tooltip title={catalog.matchWarning}><Button type="text" className="mail-match-status" onClick={() => setManageOpen(true)}>匹配未完成 · 查看</Button></Tooltip> : null}
    </div>
    <div className="mail-search-row" role="search" aria-label="邮件搜索与筛选">
      <Input className="mail-search" aria-label="搜索邮件" placeholder="搜索主题、联系人或正文" prefix={<SearchOutlined />} suffix={<kbd className="mail-search-hint">Enter</kbd>} value={keywordInput} allowClear onChange={(event) => { onKeywordInputChange(event.target.value); if (!event.target.value) onSearch('') }} onPressEnter={() => onSearch(keywordInput)} />
      <MailTagControls catalog={catalog} selectedIds={tagIds} matchMode={tagMatch} onSelectionChange={onTagIdsChange} onMatchModeChange={onTagMatchChange} manageOpen={manageOpen} onManageOpenChange={setManageOpen} />
      <Popover content={filterMenu} trigger="click" placement="bottomRight" open={filterOpen} onOpenChange={setFilterOpen} overlayClassName="mail-toolbar-popover" arrow={false}>
        <Button className={'mail-tool-button' + (activeFilters.length ? ' is-active' : '')} icon={<FilterOutlined />} aria-label="筛选邮件条件" aria-expanded={filterOpen}>筛选{activeFilters.length > 0 && <span className="mail-tool-count">{activeFilters.length}</span>}<DownOutlined className="mail-tool-chevron" /></Button>
      </Popover>
      <div className="mail-sync-group" role="group" aria-label="邮件同步">
        <Tooltip title="连接邮箱收取新邮件，不改动服务器上的邮件"><Button type="primary" className="mail-fetch-button" icon={<SyncOutlined />} loading={fetching} onClick={onFetch}>收取邮件</Button></Tooltip>
        <Dropdown trigger={['click']} menu={{ items: [{ key: 'refresh', icon: <ReloadOutlined spin={reloading} />, label: reloading ? '正在刷新…' : '刷新本地列表', disabled: reloading }], onClick: ({ key }) => { if (key === 'refresh') onReload() } }} placement="bottomRight">
          <Button type="primary" className="mail-sync-more" icon={<DownOutlined />} aria-label="更多邮件操作" />
        </Dropdown>
      </div>
    </div>
    {hasConditions && <div className="mail-active-filters" aria-label="已选筛选条件">
      <span className="mail-active-filters-label">已筛选</span>
      {keyword && <Tag closable onClose={() => { onKeywordInputChange(''); onSearch('') }} icon={<SearchOutlined />} title={keyword}><span className="mail-filter-chip-text">{keyword}</span></Tag>}
      {tagIds.length > 1 && <span className="mail-active-match-mode">{tagMatch === 'all' ? '全部标签' : '任一标签'}</span>}
      {tagIds.map((id) => <Tag key={id} icon={<TagsOutlined />} closable onClose={() => onTagIdsChange(tagIds.filter((value) => value !== id))} title={catalog.definitions.find((tag) => tag.id === id)?.name}><span className="mail-filter-chip-text">{catalog.definitions.find((tag) => tag.id === id)?.name ?? '标签 ' + id}</span></Tag>)}
      {activeFilters.map((option) => <Tag key={option.key} closable icon={option.icon} onClose={() => onFiltersChange({ ...filters, [option.key]: false })}>{option.label}</Tag>)}
      <Button type="text" className="mail-clear-filters" onClick={onClear}>清空筛选</Button>
    </div>}
  </div>
}
