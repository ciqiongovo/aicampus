import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, Button, Checkbox, Empty, Input, Modal, Select, Space, Spin, Tag, message } from 'antd'
import {
  FolderOpenOutlined,
  FolderOutlined,
  MailOutlined,
  SearchOutlined,
  TagsOutlined
} from '@ant-design/icons'
import type { ModuleManifest } from './types'
import type { MaterialItem, MaterialListResult } from '../../../shared/materials'
import { useLocation } from 'react-router-dom'
import './materials.css'

function whenText(iso: string): string {
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

function MaterialPage(): JSX.Element {
  const { modal } = AntApp.useApp()
  const { pathname } = useLocation()
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [moveFolder, setMoveFolder] = useState<string>()
  const [folderDialog, setFolderDialog] = useState<{key?: string; name: string} | null>(null)
  const [newMaterial, setNewMaterial] = useState<{title: string; content: string; folder: string} | null>(null)
  const [data, setData] = useState<MaterialListResult | null>(null)
  const [keyword, setKeyword] = useState('')
  const [folder, setFolder] = useState('')
  const [tag, setTag] = useState('')
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<MaterialItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.materialsList({
        keyword: keyword.trim() || undefined,
        folder: folder || undefined,
        tag: tag || undefined
      })
      setData(result)
    } catch (error) {
      message.error('读取资料失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setLoading(false)
    }
  }, [keyword, folder, tag])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 240)
    return () => window.clearTimeout(timer)
  }, [load, pathname])

  useEffect(() => { setSelected([]) }, [keyword, folder, tag, pathname])

  const selectItem = (id: number): void => setSelected(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id])
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await operation(); setSelected([]); setActive(null); await load(); message.success('操作完成') }
    catch (e) { message.error(e instanceof Error ? e.message : String(e)); throw e }
    finally { setBusy(false) }
  }
  const allCount = data?.folders.reduce((sum, item) => sum + item.count, 0) ?? 0
  const showEmpty = !loading && (data?.items.length ?? 0) === 0
  const filtered = Boolean(keyword.trim() || folder || tag)

  return (
    <div className="materials-page">
      <header className="materials-header">
        <div>
          <h1>资料</h1>
          <p>自行建立文件夹、选择保存位置，也可以新建资料。</p>
        </div>
        <Space wrap>
          <Button onClick={() => setNewMaterial({title: '', content: '', folder: folder || 'uncategorized'})}>新建资料</Button>
          <Button onClick={() => setFolderDialog({name: ''})}>新建文件夹</Button>
          <Button type={managing ? 'primary' : 'default'} onClick={() => { setManaging(!managing); setSelected([]) }}>{managing ? '退出管理' : '批量管理'}</Button>
        </Space>
        <Input
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          prefix={<SearchOutlined />}
          placeholder="搜索标题、正文"
          className="materials-search"
        />
      </header>

      <div className="materials-layout">
        <aside className="materials-side">
          <div className="materials-side-title">
            <FolderOutlined /> 文件夹
          </div>
          <button
            type="button"
            className={folder === '' ? 'materials-folder materials-folder-active' : 'materials-folder'}
            onClick={() => setFolder('')}
          >
            <span>全部资料</span>
            <b>{allCount}</b>
          </button>
          {(data?.folders ?? []).map((item) => (
            <button
              type="button"
              key={item.key}
              className={folder === item.key ? 'materials-folder materials-folder-active' : 'materials-folder'}
              onClick={() => setFolder(folder === item.key ? '' : item.key)}
            >
              <span>{folder === item.key ? <FolderOpenOutlined /> : <FolderOutlined />} {item.label}</span>
              <b>{item.count}</b>
            </button>
          ))}

          <div className="materials-side-title materials-side-title-tags">
            <TagsOutlined /> AI 标签
          </div>
          <div className="materials-tags">
            {(data?.tags ?? []).length === 0 && <span className="materials-muted">还没有标签</span>}
            {(data?.tags ?? []).map((item) => (
              <button
                type="button"
                key={item.id}
                className={tag === item.id ? 'materials-tag materials-tag-active' : 'materials-tag'}
                onClick={() => setTag(tag === item.id ? '' : item.id)}
              >
                {item.label}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="materials-main">
          <div className="materials-summary">
            <span>{folder ? (data?.folders.find((item) => item.key === folder)?.label ?? '资料') : '全部资料'}</span>
            <span className="materials-muted">{data?.total ?? 0} 条</span>
            {filtered && (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setKeyword('')
                  setFolder('')
                  setTag('')
                }}
              >
                清除筛选
              </Button>
            )}
          </div>

          {folder && folder !== 'uncategorized' && <Space style={{marginBottom: 12}}>
            <Button size="small" onClick={() => setFolderDialog({key: folder, name: data?.folders.find(f => f.key === folder)?.label || ''})}>重命名文件夹</Button>
            <Button size="small" danger onClick={() => modal.confirm({title: '删除文件夹？', content: '夹内资料将移回未分组。', okText: '删除', cancelText: '取消', onOk: () => perform(async () => { await window.api.materialsDeleteFolder(folder); setFolder('') })})}>删除文件夹</Button>
          </Space>}
          {managing && <Space wrap style={{marginBottom: 16}}>
            <Checkbox checked={Boolean(data?.items.length) && selected.length === data?.items.length} indeterminate={selected.length > 0 && selected.length < (data?.items.length || 0)} onChange={e => setSelected(e.target.checked ? (data?.items.map(i => i.id) || []) : [])}>全选当前结果</Checkbox>
            <span>已选 {selected.length} 条</span>
            <Select placeholder="移至文件夹" style={{width: 160}} value={moveFolder} onChange={setMoveFolder} options={data?.folders.map(f => ({value: f.key, label: f.label}))} />
            <Button loading={busy} disabled={!selected.length || !moveFolder} onClick={() => void perform(() => window.api.materialsBatch(selected, 'move', moveFolder))}>批量移动</Button>
            <Button danger disabled={!selected.length || busy} onClick={() => modal.confirm({title: `删除选中的 ${selected.length} 条资料？`, content: '从资料库移除，原邮件保留。', okText: '删除', cancelText: '取消', okButtonProps: {danger: true}, onOk: () => perform(() => window.api.materialsBatch(selected, 'delete'))})}>批量删除</Button>
          </Space>}
          {data && data.total > data.items.length && <p className="materials-muted">当前显示 {data.items.length} / {data.total} 条，可缩小搜索或文件夹范围后管理。</p>}
          {loading && !data ? (
            <div className="materials-loading">
              <Spin />
            </div>
          ) : showEmpty ? (
            <Empty description={filtered ? '没有匹配的资料' : '还没有资料'} />
          ) : (
            <div className="materials-list">
              {(data?.items ?? []).map((item) => (
                <article key={item.id} className="materials-card" onClick={() => managing ? selectItem(item.id) : setActive(item)}>
                  <div className="materials-card-head">
                    {managing && <Checkbox aria-label={`选择 ${item.title}`} checked={selected.includes(item.id)} onClick={e => e.stopPropagation()} onChange={() => selectItem(item.id)} />}
                    <Tag className="materials-folder-tag">{item.folderLabel}</Tag>
                    <span className="materials-muted">
                      <MailOutlined /> {item.sourceLabel} · {whenText(item.createdAt)}
                    </span>
                  </div>
                  <h3>{item.title}</h3>
                  {item.excerpt && <p>{item.excerpt}</p>}
                  {item.subLabels.length > 0 && (
                    <div className="materials-subtags">
                      {item.subLabels.slice(0, 5).map((label) => (
                        <Tag key={label}>{label}</Tag>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </main>
      </div>

      <Modal open={folderDialog !== null} title={folderDialog?.key ? '重命名文件夹' : '新建文件夹'} okText="保存" cancelText="取消" confirmLoading={busy} onCancel={() => setFolderDialog(null)} onOk={async () => {
        if (!folderDialog?.name.trim()) { message.warning('请输入文件夹名称'); return }
        await perform(async () => { if (folderDialog.key) await window.api.materialsRenameFolder(folderDialog.key, folderDialog.name); else await window.api.materialsCreateFolder(folderDialog.name); setFolderDialog(null) })
      }}>
        <Input maxLength={60} value={folderDialog?.name || ''} placeholder="文件夹名称" onChange={e => setFolderDialog(v => v ? {...v, name: e.target.value} : v)} />
      </Modal>
      <Modal open={newMaterial !== null} title="新建资料" okText="保存" cancelText="取消" confirmLoading={busy} onCancel={() => setNewMaterial(null)} onOk={async () => {
        if (!newMaterial?.title.trim()) { message.warning('请输入标题'); return }
        await perform(async () => { await window.api.materialsCreate(newMaterial.title, newMaterial.content, newMaterial.folder); setNewMaterial(null) })
      }}>
        <Space direction="vertical" style={{width: '100%'}}>
          <Input placeholder="标题" maxLength={300} value={newMaterial?.title || ''} onChange={e => setNewMaterial(v => v ? {...v, title: e.target.value} : v)} />
          <Select aria-label="保存到文件夹" style={{width: '100%'}} value={newMaterial?.folder} options={data?.folders.map(f => ({value: f.key, label: f.label}))} onChange={folder => setNewMaterial(v => v ? {...v, folder} : v)} />
          <Input.TextArea rows={8} placeholder="正文" value={newMaterial?.content || ''} onChange={e => setNewMaterial(v => v ? {...v, content: e.target.value} : v)} />
        </Space>
      </Modal>
      <Modal
        open={Boolean(active)}
        onCancel={() => setActive(null)}
        footer={null}
        width={720}
        title={active?.title}
      >
        {active && (
          <div className="materials-detail">
            <div className="materials-detail-meta">
              <Tag>{active.folderLabel}</Tag>
              <span className="materials-muted">
                {active.sourceLabel} · {whenText(active.createdAt)}
              </span>
              {active.parentTags.map((item) => (
                <Tag key={item.id} color="blue">
                  {item.label}
                </Tag>
              ))}
            </div>
            <div className="materials-detail-content">{active.content || active.excerpt || '（无正文）'}</div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export const materialsModule: ModuleManifest = {
  id: 'materials',
  title: '资料',
  icon: <FolderOpenOutlined />,
  route: '/collection',
  enabled: true,
  page: () => <MaterialPage />
}
