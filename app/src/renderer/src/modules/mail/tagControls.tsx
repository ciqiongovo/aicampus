import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Checkbox, Empty, Form, Input, List, Modal, Popconfirm, Popover, Radio, Spin, Tag, Tooltip } from 'antd'
import { DownOutlined, PlusOutlined, SearchOutlined, SettingOutlined, SyncOutlined, TagsOutlined } from '@ant-design/icons'
import type { MailTagDefinition, MailTagDefinitionInput } from '@shared/mailLabels'
import './tagControls.css'

/** 标签目录与匹配状态只保留一份，供菜单、条件条及管理弹窗共用。 */
export function useMailTagCatalog(onTagsChanged: () => void) {
  const { message } = AntApp.useApp()
  const [definitions, setDefinitions] = useState<MailTagDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [matching, setMatching] = useState(false)
  const [matchWarning, setMatchWarning] = useState('')
  const matchingRef = useRef(false)
  const onTagsChangedRef = useRef(onTagsChanged)
  onTagsChangedRef.current = onTagsChanged

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(false)
    try { setDefinitions(await window.api.mailTagDefinitionsList()) }
    catch (error) { setLoadError(true); message.error('读取自定义标签失败：' + String(error)) }
    finally { setLoading(false) }
  }, [message])
  useEffect(() => { void load() }, [load])

  const match = async (): Promise<void> => {
    if (matchingRef.current) return
    matchingRef.current = true
    setMatching(true)
    setMatchWarning('')
    try {
      const result = await window.api.mailTagsMatch()
      if (result.ok) message.success({ key: 'mail-tag-match', content: result.message })
      else setMatchWarning(result.message)
    } catch (error) {
      const reason = 'AI 匹配失败，原有标签保留：' + String(error)
      setMatchWarning(reason)
    } finally {
      matchingRef.current = false
      setMatching(false)
      onTagsChangedRef.current()
    }
  }

  const create = async (input: MailTagDefinitionInput): Promise<void> => {
    const definition = await window.api.mailTagDefinitionsCreate(input)
    setDefinitions((current) => [...current, definition])
    message.success({ key: 'mail-tag-match', content: '标签已创建，正在为已有邮件匹配' })
    void match()
  }
  const remove = async (id: number): Promise<void> => {
    await window.api.mailTagDefinitionsDelete(id)
    setDefinitions((current) => current.filter((tag) => tag.id !== id))
    onTagsChanged()
    message.success('标签已删除，邮件不受影响')
  }
  return { definitions, loading, loadError, matching, matchWarning, load, match, create, remove }
}

type MailTagCatalog = ReturnType<typeof useMailTagCatalog>
export type TagMatchMode = 'any' | 'all'
interface MailTagControlsProps {
  catalog: MailTagCatalog
  selectedIds: number[]
  matchMode: TagMatchMode
  onSelectionChange: (ids: number[]) => void
  onMatchModeChange: (mode: TagMatchMode) => void
  manageOpen: boolean
  onManageOpenChange: (open: boolean) => void
}

/** 标签入口只有一个：筛选在菜单内，创建与管理使用各自的轻量弹窗。 */
export function MailTagControls({ catalog, selectedIds, matchMode, onSelectionChange, onMatchModeChange, manageOpen, onManageOpenChange }: MailTagControlsProps): JSX.Element {
  const { message } = AntApp.useApp()
  const { definitions, loading, loadError, matching, matchWarning } = catalog
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [form] = Form.useForm<MailTagDefinitionInput>()
  const visibleTags = definitions.filter((tag) => (tag.name + ' ' + tag.description).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))

  const openCreate = (): void => {
    setMenuOpen(false)
    form.resetFields()
    setCreateOpen(true)
  }
  const create = async (input: MailTagDefinitionInput): Promise<void> => {
    setSaving(true)
    try { await catalog.create(input); form.resetFields(); setCreateOpen(false) }
    catch (error) { message.error('创建标签失败：' + String(error)) }
    finally { setSaving(false) }
  }
  const remove = async (id: number): Promise<void> => {
    setDeletingId(id)
    try { await catalog.remove(id); onSelectionChange(selectedIds.filter((value) => value !== id)) }
    catch (error) { message.error('删除标签失败：' + String(error)) }
    finally { setDeletingId(null) }
  }

  const tagMenu = <div className="mail-tag-menu" role="group" aria-label="标签筛选菜单">
    <div className="mail-menu-heading"><span>筛选标签</span><span className="mail-menu-meta">可多选</span></div>
    <Input className="mail-tag-menu-search" aria-label="查找标签" prefix={<SearchOutlined />} placeholder="查找标签" allowClear value={search} onChange={(event) => setSearch(event.target.value)} />
    <Radio.Group className="mail-tag-match-mode" aria-label="标签匹配方式" value={matchMode} onChange={(event) => onMatchModeChange(event.target.value as TagMatchMode)}>
      <Radio.Button value="any">包含任一标签</Radio.Button><Radio.Button value="all">包含全部标签</Radio.Button>
    </Radio.Group>
    <div className="mail-tag-options">
      {loading ? <div className="mail-menu-empty"><Spin size="small" /></div> : loadError ? <div className="mail-menu-empty">读取失败 <Button size="small" type="link" onClick={() => void catalog.load()}>重新加载</Button></div> : visibleTags.length ? visibleTags.map((tag) => <Checkbox key={tag.id} className={'mail-tag-option' + (selectedIds.includes(tag.id) ? ' is-selected' : '')} checked={selectedIds.includes(tag.id)} onChange={(event) => onSelectionChange(event.target.checked ? [...selectedIds, tag.id] : selectedIds.filter((id) => id !== tag.id))}>
        <span className="mail-tag-option-copy"><span className="mail-tag-option-name">{tag.name}</span>{tag.description && <span className="mail-tag-option-description" title={tag.description}>{tag.description}</span>}</span>
      </Checkbox>) : <div className="mail-menu-empty">{definitions.length ? '没有找到这个标签' : '还没有标签，创建一个开始整理'}</div>}
    </div>
    <div className="mail-tag-menu-footer"><Button type="text" size="small" icon={<PlusOutlined />} onClick={openCreate} disabled={loading || matching || definitions.length >= 100}>新建标签</Button><Button type="text" size="small" icon={<SettingOutlined />} onClick={() => { setMenuOpen(false); onManageOpenChange(true) }}>管理标签</Button></div>
  </div>

  return <>
    <Popover content={tagMenu} trigger="click" placement="bottomRight" open={menuOpen} onOpenChange={setMenuOpen} overlayClassName="mail-toolbar-popover" arrow={false}>
      <Button className={'mail-tool-button' + (selectedIds.length ? ' is-active' : '')} icon={<TagsOutlined />} aria-label="按标签筛选" aria-expanded={menuOpen}>标签{selectedIds.length > 0 && <span className="mail-tool-count">{selectedIds.length}</span>}<DownOutlined className="mail-tool-chevron" /></Button>
    </Popover>
    <Modal title={<span className="mail-dialog-title"><PlusOutlined />新建邮件标签</span>} open={createOpen} onCancel={() => { if (!saving) setCreateOpen(false) }} footer={null} width={480} maskClosable={!saving} keyboard={!saving} closable={!saving} className="mail-tag-dialog">
      <p className="mail-dialog-intro">告诉 AI 你想关注什么，一封邮件可以匹配多个标签。</p>
      <Form form={form} layout="vertical" onFinish={(input) => void create(input)}>
        <Form.Item name="name" label="标签名称" rules={[{ required: true, whitespace: true, message: '请输入标签名称' }, { max: 40, message: '名称最多 40 个字符' }]}>
          <Input autoFocus placeholder="例如：项目合作" maxLength={40} showCount disabled={saving} />
        </Form.Item>
        <Form.Item name="description" label={<span>匹配说明 <span className="mail-field-optional">选填</span></span>} extra="描述得越具体，AI 越容易匹配到你想要的邮件。">
          <Input.TextArea placeholder="例如：项目沟通、合作邀请与技术讨论；不包含推广广告。" maxLength={500} showCount autoSize={{ minRows: 3, maxRows: 5 }} disabled={saving} />
        </Form.Item>
        <div className="mail-tag-permission-note"><SyncOutlined /><span>创建后按现有 AI 授权匹配邮件；未授权时仅保存标签，不发送邮件内容。</span></div>
        <div className="mail-tag-form-actions"><Button onClick={() => setCreateOpen(false)} disabled={saving}>取消</Button><Button type="primary" htmlType="submit" loading={saving} disabled={matching || definitions.length >= 100}>创建标签</Button></div>
      </Form>
    </Modal>
    <Modal title={<span className="mail-dialog-title"><TagsOutlined />管理邮件标签 <span className="mail-menu-meta">{definitions.length} / 100</span></span>} open={manageOpen} onCancel={() => onManageOpenChange(false)} width={540} className="mail-tag-dialog" footer={<div className="mail-tag-manage-actions"><Tooltip title="按现有授权补匹配已有邮件，未变化且成功匹配的邮件会跳过，不改动事项。"><Button icon={<SyncOutlined />} loading={matching} disabled={!definitions.length || saving || deletingId !== null} onClick={() => void catalog.match()}>匹配已有邮件</Button></Tooltip><Button type="primary" icon={<PlusOutlined />} disabled={loading || matching || definitions.length >= 100} onClick={() => { onManageOpenChange(false); openCreate() }}>新建标签</Button></div>}>
      <p className="mail-dialog-intro">新邮件会在正常 AI 分析时自动匹配。删除标签不会删除邮件。</p>
      {matchWarning && <div className="mail-tag-match-warning" role="status">{matchWarning}<br />原有标签已保留，检查 AI 配置与授权后可重试。</div>}
      <List className="mail-tag-catalog" loading={loading} dataSource={definitions} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有邮件标签" /> }} renderItem={(tag) => <List.Item actions={[
        <Popconfirm key="delete" title={'删除标签“' + tag.name + '”？'} description="邮件上的该标签也会移除，邮件不受影响。" okText="删除" cancelText="取消" onConfirm={() => remove(tag.id)} disabled={matching || saving || deletingId !== null}>
          <Button type="text" size="small" className="mail-tag-delete" loading={deletingId === tag.id} disabled={matching || saving || deletingId !== null}>删除</Button>
        </Popconfirm>
      ]}><div className="mail-tag-definition"><span className="mail-tag-definition-name">{tag.name}</span><span className="mail-tag-option-description">{tag.description || '按标签名称判断相关性'}</span></div></List.Item>} />
    </Modal>
  </>
}

/** 列表与详情共用同一标签展示，不额外逐邮件请求 IPC。 */
export function CustomMailTagBadges({ tags = [] }: { tags?: MailTagDefinition[] }): JSX.Element {
  return <span className="mail-custom-tag-badges" aria-label="自定义标签">{tags.map((tag) => <Tooltip key={tag.id} title={tag.description || tag.name}><Tag>{tag.name}</Tag></Tooltip>)}</span>
}
