import { useEffect, useMemo, useRef, useState } from 'react'
import { App as AntApp, Button, Empty, Input, InputNumber, Modal, Popconfirm, Slider, Spin } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import type { PanelKeywordProfile } from '@shared/panel'
import { layoutKeywordCloud } from './keywordCloudLayout'

export type KeywordView = 'cloud' | 'list'

type Tier = 'high' | 'medium' | 'low'

interface EditingKeyword {
  keyword: string
  weight: number
  isNew: boolean
}

function tierOf(weight: number, highest: number): Tier {
  const absolute = Math.abs(weight)
  if (highest <= 0 || absolute < highest / 3) return 'low'
  return absolute < (highest * 2) / 3 ? 'medium' : 'high'
}

function weightLabel(weight: number): string {
  return `${weight > 0 ? '+' : ''}${weight.toFixed(1)}`
}

/** 设置页的关键词画像：字号混排 / 紧凑列表两种视图，支持手动改权重与增删。 */
export function KeywordProfileEditor({
  items,
  loading,
  view,
  onChanged
}: {
  items: PanelKeywordProfile[]
  loading: boolean
  view: KeywordView
  onChanged: (next: PanelKeywordProfile[]) => void
}): JSX.Element {
  const { message } = AntApp.useApp()
  const [editing, setEditing] = useState<EditingKeyword | null>(null)
  const [draftKeyword, setDraftKeyword] = useState('')
  const [draftWeight, setDraftWeight] = useState(0.5)
  const [saving, setSaving] = useState(false)
  const cloudRef = useRef<HTMLDivElement>(null)
  const [cloudWidth, setCloudWidth] = useState(0)

  useEffect(() => {
    if (view !== 'cloud' || !cloudRef.current) return
    const observer = new ResizeObserver(([entry]) => setCloudWidth(Math.floor(entry.contentRect.width)))
    observer.observe(cloudRef.current)
    return () => observer.disconnect()
  }, [view, loading, items.length])

  const ranked = useMemo(() => [...items].sort((a, b) => b.weight - a.weight), [items])
  const highest = useMemo(
    () => ranked.reduce((max, item) => Math.max(max, Number.isFinite(item.weight) ? Math.abs(item.weight) : 0), 0),
    [ranked]
  )

  const cloudHeight = Math.max(250, Math.min(520, Math.round(cloudWidth * 0.58), 180 + ranked.length * 7))
  const cloudWords = useMemo(() => {
    if (cloudWidth < 1 || !ranked.length) return []
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return []
    const family = getComputedStyle(cloudRef.current ?? document.body).fontFamily
    return layoutKeywordCloud(ranked, cloudWidth, cloudHeight, (keyword, size) => {
      context.font = `500 ${size}px ${family}`
      return context.measureText(keyword).width
    })
  }, [ranked, cloudWidth, cloudHeight])

  const openAdd = (): void => {
    setEditing({ keyword: '', weight: 0.5, isNew: true })
    setDraftKeyword('')
    setDraftWeight(0.5)
  }

  const openEdit = (item: PanelKeywordProfile): void => {
    setEditing({ keyword: item.keyword, weight: item.weight, isNew: false })
    setDraftKeyword(item.keyword)
    setDraftWeight(item.weight)
  }

  const submit = async (): Promise<void> => {
    const keyword = draftKeyword.trim()
    if (!keyword) {
      message.warning('请先填写关键词')
      return
    }
    setSaving(true)
    try {
      const result = await window.api.panelKeywordSet(keyword, draftWeight)
      if (!result.ok) {
        message.error(result.message)
        return
      }
      onChanged(result.items)
      setEditing(null)
      message.success(draftWeight === 0 ? '权重为 0，已移出画像' : '关键词权重已更新')
    } catch (error) {
      message.error('保存关键词失败：' + String(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (keyword: string): Promise<void> => {
    try {
      const result = await window.api.panelKeywordDelete(keyword)
      if (!result.ok) {
        message.error(result.message)
        return
      }
      onChanged(result.items)
      message.success(`已删除「${keyword}」`)
    } catch (error) {
      message.error('删除关键词失败：' + String(error))
    }
  }

  return (
    <div className="kwpe">
      <div className="kwpe-bar">
        <Button size="small" icon={<PlusOutlined />} onClick={openAdd}>添加关键词</Button>
      </div>

      {loading ? (
        <div className="kwpe-loading"><Spin size="small" /><span>正在读取关键词画像…</span></div>
      ) : ranked.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有关键词，先添加一个，或处理邮件与 QQ 结论后再回来。" />
      ) : view === 'cloud' ? (
        <div ref={cloudRef} className="kwpe-cloud" style={{ height: cloudHeight }} aria-label="关键词词云，字号按权重大小排列；点击词可编辑">
          {cloudWidth > 0 && cloudWords.length === 0 && (
            <div className="kwpe-cloud-fallback">
              {ranked.map((item) => (
                <button key={item.keyword} type="button" className="kwpe-word" style={{ position: 'static', fontSize: Math.max(11, Math.min(30, 11 + 19 * Math.abs(item.weight) / highest)) }} title={`${item.keyword} · 权重 ${weightLabel(item.weight)}`} onClick={() => openEdit(item)}>{item.keyword}</button>
              ))}
            </div>
          )}
          {cloudWords.map((word) => (
            <button
              key={word.keyword}
              type="button"
              className="kwpe-word"
              style={{ left: word.x, top: word.y, fontSize: word.fontSize, transform: `translate(-50%, -50%) rotate(${word.rotate}deg)` }}
              title={`${word.keyword} · 权重 ${weightLabel(word.weight)} · 点击编辑`}
              aria-label={`${word.keyword}，权重 ${weightLabel(word.weight)}，点击编辑`}
              onClick={() => {
                const item = ranked.find((entry) => entry.keyword === word.keyword)
                if (item) openEdit(item)
              }}
            >
              {word.keyword}
            </button>
          ))}
        </div>
      ) : (
        <ul className="kwpe-list">
          {ranked.map((item) => {
            const tier = tierOf(item.weight, highest)
            const ratio = highest > 0 ? Math.min(1, Math.abs(item.weight) / highest) : 0
            return (
              <li className={`kwpe-row${item.weight < 0 ? ' is-negative' : ''}`} key={item.keyword}>
                <button type="button" className="kwpe-row-main" onClick={() => openEdit(item)} title="点击修改权重">
                  <span className={`kwpe-row-name kwpe-tone-${tier}`}>{item.keyword}</span>
                  <span className="kwpe-row-track" aria-hidden="true">
                    <i className={`kwpe-tone-${tier}`} style={{ width: `${Math.max(4, ratio * 100)}%` }} />
                  </span>
                  <span className={`kwpe-row-weight kwpe-tone-${tier}`}>{weightLabel(item.weight)}</span>
                </button>
                <span className="kwpe-row-actions">
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={`修改 ${item.keyword}`} onClick={() => openEdit(item)} />
                  <Popconfirm title={`删除「${item.keyword}」？`} description="该词的反馈与匹配会一并清除。" okText="删除" cancelText="取消" onConfirm={() => void remove(item.keyword)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除 ${item.keyword}`} />
                  </Popconfirm>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={editing !== null}
        title={editing?.isNew ? '添加关键词' : `修改「${editing?.keyword ?? ''}」`}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <div className="kwpe-form">
          <label className="kwpe-field">
            <span>关键词</span>
            <Input
              value={draftKeyword}
              maxLength={24}
              disabled={!editing?.isNew}
              placeholder="例如：竞赛、实习、报销"
              onChange={(event) => setDraftKeyword(event.target.value)}
            />
          </label>
          <div className="kwpe-field">
            <span>权重 <em>{weightLabel(draftWeight)}</em></span>
            <Slider min={-3} max={3} step={0.1} value={draftWeight} onChange={setDraftWeight} aria-label="关键词权重" />
            <InputNumber min={-3} max={3} step={0.1} precision={1} value={draftWeight} onChange={(value) => setDraftWeight(typeof value === 'number' ? value : 0)} style={{ width: 96 }} />
          </div>
          <p className="kwpe-form-hint">范围 -3 到 3；0 会把该词移出画像。权重会随时间缓慢衰减，手动修改会从今天重新起算。</p>
        </div>
      </Modal>
    </div>
  )
}
