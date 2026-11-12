import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Modal } from 'antd'
import dayjs from 'dayjs'
import type { ImDailyQqItem, ImDailyQqSummary, ImMessageInfo, QqPanelRange } from '@shared/im'
import './qqSource.css'

const KIND_LABEL: Record<string, string> = {
  decision: '决定',
  todo: '待办',
  fact: '事实',
  link: '链接',
  question: '待确认',
  topic: '主题'
}

const KIND_ORDER = ['decision', 'todo', 'fact', 'link', 'question', 'topic'] as const

/** 消息时间：优先按本地时区格式化，解析失败时原样显示。 */
function whenText(value: string | null): string {
  if (!value) return '时间未知'
  const date = dayjs(value)
  return date.isValid() ? date.format('MM-DD HH:mm') : value
}

/** 面板 QQ 来源：按选择的消息时间范围查看结论。 */
export function QqPanelBlock({
  dateKey,
  range,
  onFeedback
}: {
  dateKey: string
  range: QqPanelRange
  onFeedback?: () => void
}): ReactElement | null {
  const [data, setData] = useState<ImDailyQqSummary | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [kindFilter, setKindFilter] = useState<string>('all')

  const load = useCallback(
    async (extract: boolean): Promise<void> => {
      setBusy(extract ? 'extract' : 'load')
      try {
        setData(await window.api.imQqDaily(dateKey, { extract, range }))
        setError('')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy('')
      }
    },
    [dateKey, range]
  )

  useEffect(() => {
    void load(false)
    const onRefresh = (): void => void load(false)
    window.addEventListener('im:qq-refresh', onRefresh)
    return () => window.removeEventListener('im:qq-refresh', onRefresh)
  }, [load])

  const act = async (item: ImDailyQqItem, status: 'accepted' | 'dismissed' | 'new'): Promise<void> => {
    try {
      await window.api.imInsightStatus(item.id, status)
      setData((prev) => {
        if (!prev) return prev
        const previous = prev.items.find((it) => it.id === item.id)?.status
        const stats = { ...prev.stats }
        if (previous !== status) {
          if (previous === 'accepted') stats.accepted = Math.max(0, stats.accepted - 1)
          if (previous === 'dismissed') stats.dismissed = Math.max(0, stats.dismissed - 1)
          if (status === 'accepted') stats.accepted += 1
          if (status === 'dismissed') stats.dismissed += 1
        }
        return { ...prev, stats, items: prev.items.map((it) => (it.id === item.id ? { ...it, status } : it)) }
      })
      onFeedback?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const [origin, setOrigin] = useState<{ title: string; loading: boolean; items: ImMessageInfo[] } | null>(null)
  const openOrigin = async (item: ImDailyQqItem): Promise<void> => {
    setOrigin({ title: item.title, loading: true, items: [] })
    try {
      const items = await window.api.imInsightSource(item.id)
      setOrigin({ title: item.title, loading: false, items })
    } catch (err) {
      setOrigin(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of data?.items ?? []) counts[item.kind] = (counts[item.kind] ?? 0) + 1
    return counts
  }, [data])

  if (data === null) return null
  const selected = data.sources.filter((item) => item.selected)
  if (selected.length === 0) {
    return (
      <section className="qqsrc">
        <div className="qqsrc-empty">还没有选群。去「设置 → 聊天记录 → AI 信息来源（QQ）」勾选要用作信息来源的群。</div>
      </section>
    )
  }

  const visible = data.items.filter((item) => kindFilter === 'all' || item.kind === kindFilter)
  const actual = visible.filter((item) => item.group === 'actual')
  const suggested = visible.filter((item) => item.group === 'suggested')

  return (
    <section className="qqsrc">
      <div className="qqsrc-filter">
        <div className="qqsrc-filter-tabs" role="tablist" aria-label="QQ 结论标签">
          <button
            type="button"
            role="tab"
            aria-selected={kindFilter === 'all'}
            className={kindFilter === 'all' ? 'qqsrc-filter-tab is-active' : 'qqsrc-filter-tab'}
            onClick={() => setKindFilter('all')}
          >
            全部 <em>{data.items.length}</em>
          </button>
          {KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={kindFilter === kind}
              className={kindFilter === kind ? 'qqsrc-filter-tab is-active' : 'qqsrc-filter-tab'}
              onClick={() => setKindFilter(kind)}
            >
              {KIND_LABEL[kind]} <em>{kindCounts[kind] ?? 0}</em>
            </button>
          ))}
        </div>
        <Button
          className="qqsrc-extract"
          type="text"
          size="small"
          loading={busy === 'extract'}
          disabled={busy === 'load'}
          title="按所选时间重新提取群消息"
          onClick={() => void load(true)}
        >
          提取
        </Button>
      </div>
      {error !== '' ? <div className="qqsrc-error">{error}</div> : null}
      {data.items.length === 0 ? (
        <div className="qqsrc-empty">所选时间内没有抽取结果。点「提取」可以重新处理群消息。</div>
      ) : visible.length === 0 ? (
        <div className="qqsrc-empty">当前筛选下没有结论。</div>
      ) : (
        <div className="qqsrc-groups">
          {[
            { key: 'actual', label: '实际动作', items: actual },
            { key: 'suggested', label: '建议动作', items: suggested }
          ].map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.key} className="qqsrc-group">
                <div className="qqsrc-group-title">{group.label}</div>
                <div className="qqsrc-rows">
                  {group.items.map((item) => (
                    <div key={item.id} className={'qqsrc-row is-' + item.status}>
                      <div className="qqsrc-row-title" title={item.title}>
                        {item.title}
                      </div>
                      <div className="qqsrc-row-meta">
                        <span className="qqsrc-time">
                          {whenText(item.sentAt)}
                          {item.dueAt !== null ? ` · 截止 ${item.dueAt.slice(0, 10)}` : ''}
                        </span>
                        <span className="qqsrc-row-tail">
                          <span className="qqsrc-row-source" title={item.sessionTitle}>
                            {item.sessionTitle}
                          </span>
                          <span className="qqsrc-row-actions">
                          <button type="button" className="qqsrc-text-btn" onClick={() => void openOrigin(item)}>
                            原文
                          </button>
                          {item.status === 'accepted' ? (
                            <span className="qqsrc-feedback">已采纳</span>
                          ) : item.status === 'dismissed' ? (
                            <span className="qqsrc-feedback">已忽略</span>
                          ) : (
                            <>
                              <button type="button" className="qqsrc-text-btn" onClick={() => void act(item, 'accepted')}>
                                采纳
                              </button>
                              <button type="button" className="qqsrc-text-btn" onClick={() => void act(item, 'dismissed')}>
                                忽略
                              </button>
                            </>
                          )}
                          {item.status !== 'new' ? (
                            <button type="button" className="qqsrc-text-btn" onClick={() => void act(item, 'new')}>
                              撤销
                            </button>
                          ) : null}
                          </span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      )}

      <Modal
        open={origin !== null}
        title={origin ? `原文 · ${origin.title}` : '原文'}
        footer={null}
        width={640}
        onCancel={() => setOrigin(null)}
      >
        {origin?.loading ? (
          <div className="qqsrc-origin-loading">正在读取原文…</div>
        ) : origin && origin.items.length > 0 ? (
          <div className="qqsrc-origin-list">
            {origin.items.map((message) => (
              <div className="qqsrc-origin-msg" key={message.id}>
                <div className="qqsrc-origin-meta">
                  <span>{whenText(message.sentAt)}</span>
                  <span>{message.isSelf ? '我' : message.senderName || '未知'}</span>
                </div>
                <div className="qqsrc-origin-text">{message.text || `[${message.kind}]`}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="qqsrc-empty">这条结论没有可定位的原文消息（可能来自旧版本数据）。</div>
        )}
      </Modal>
    </section>
  )
}
