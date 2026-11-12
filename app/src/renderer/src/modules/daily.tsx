import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, WheelEvent as ReactWheelEvent } from 'react'
import { App as AntApp, Button, DatePicker, Drawer, Dropdown, Input, Pagination, Popconfirm, Select, Switch } from 'antd'
import type { MenuProps } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { CalendarOutlined, DeleteOutlined } from '@ant-design/icons'
import type { DailySourceConfig, DailyStatus, RendererApi } from '@shared/types'
import {
  DAILY_TOPICS,
  type DailyApi,
  type DailyArticle,
  type DailyArticleStatus,
  type DailyBoard,
  type DailyReportsResult,
  type DailySearchResult
} from '@shared/daily'
import { handoffToAi } from '../aiNavigation'
import type { ModuleManifest } from './types'
import './daily.css'

const STATUS_LABEL: Record<DailyArticleStatus, string> = {
  keep: '资料',
  archive: '已归档',
  item: '已转事项',
  unverified: '待核实'
}

const STATUS_ORDER: DailyArticleStatus[] = ['keep', 'archive', 'item', 'unverified']

const ACTION_CATEGORIES = ['需行动', '重要通知', '可选机会', '一般信息', '不确定']

const PAGE_SIZE = 20
const COLS_PER_PAGE = 3
const ROW_LIMIT = 12
const WHEEL_THRESHOLD = 60
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

const VIEWS: { key: 'board' | 'search' | 'history'; label: string }[] = [
  { key: 'board', label: '看板' },
  { key: 'search', label: '搜索' },
  { key: 'history', label: '历史' }
]

interface SourceRow extends DailySourceConfig {
  key: string
}

function toRows(sources: DailySourceConfig[]): SourceRow[] {
  return sources.map((s, i) => ({ ...s, key: s.id + '-' + i }))
}

function todayStr(): string {
  return dayjs().format('YYYY-MM-DD')
}

function weekdayOf(dateKey: string): string {
  return '星期' + WEEK[dayjs(dateKey).day()]
}

function fmtClock(iso: string | null): string {
  if (!iso) return '—'
  const d = dayjs(iso)
  return d.isValid() ? d.format('HH:mm') : '—'
}

function fmtStamp(iso: string | null): string {
  if (!iso) return '—'
  const d = dayjs(iso)
  return d.isValid() ? d.format('MM-DD HH:mm') : '—'
}

function paragraphsOf(content: string): string[] {
  return (content ?? '')
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function DailyPage(): ReactElement {
  const { message } = AntApp.useApp()
  const api = window.api as RendererApi & DailyApi
  const [view, setView] = useState<'board' | 'search' | 'history'>('board')
  const [dateKey, setDateKey] = useState<string>(todayStr())
  const [board, setBoard] = useState<DailyBoard | null>(null)
  const [status, setStatus] = useState<DailyStatus | null>(null)
  const [reports, setReports] = useState<DailyReportsResult | null>(null)
  const [reportPage, setReportPage] = useState(1)
  const [focus, setFocus] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [searchResult, setSearchResult] = useState<DailySearchResult | null>(null)
  const [searchPage, setSearchPage] = useState(1)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchSourceId, setSearchSourceId] = useState<string | undefined>(undefined)
  const [searchTopicId, setSearchTopicId] = useState<string | undefined>(undefined)
  const [searchStatus, setSearchStatus] = useState<'all' | DailyArticleStatus>('all')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [zhihuRecommendCount, setZhihuRecommendCount] = useState(3)
  const [zhihuCounterCount, setZhihuCounterCount] = useState(3)
  const [savingZhihu, setSavingZhihu] = useState(false)
  const [sources, setSources] = useState<SourceRow[]>([])
  const [savedSources, setSavedSources] = useState<DailySourceConfig[]>([])
  const [saving, setSaving] = useState(false)
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [detail, setDetail] = useState<DailyArticle | null>(null)
  const [failOpen, setFailOpen] = useState(false)
  const wheelAcc = useRef(0)

  const refreshBoard = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [b, st, f, rep] = await Promise.all([
        api.dailyBoard(dateKey),
        api.dailyStatus(),
        api.dailyFocusGet(),
        api.dailyReportsList({ limit: PAGE_SIZE, offset: (reportPage - 1) * PAGE_SIZE })
      ])
      setBoard(b)
      setStatus(st)
      setFocus(f)
      setReports(rep)
    } catch (error) {
      message.error('日报加载失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setLoading(false)
    }
  }, [api, message, dateKey, reportPage])

  useEffect(() => {
    void refreshBoard()
  }, [refreshBoard])

  const loadSources = useCallback(async (): Promise<void> => {
    try {
      const src = await api.dailySourcesGet()
      setSources(toRows(src))
      setSavedSources(src)
    } catch (error) {
      message.error('来源加载失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [api, message])

  useEffect(() => {
    if (settingsOpen) void loadSources()
  }, [settingsOpen, loadSources])

  useEffect(() => {
    if (!settingsOpen) return
    void window.api
      .settingsGet()
      .then((s) => {
        setZhihuRecommendCount(s.zhihuRecommendCount)
        setZhihuCounterCount(s.zhihuCounterCount)
      })
      .catch(() => {})
  }, [settingsOpen])

  const saveZhihuCount = async (): Promise<void> => {
    setSavingZhihu(true)
    try {
      await window.api.settingsSet({ zhihuRecommendCount, zhihuCounterCount })
      message.success('已保存知乎推荐与反推荐条数')
    } catch (error) {
      message.error('保存失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSavingZhihu(false)
    }
  }

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true)
    try {
      const r = await api.dailyGenerate()
      if (r.ok) message.success(r.message)
      else message.warning(r.message)
      const failed = (r.sources ?? []).filter((s) => s.error)
      if (failed.length > 0) {
        message.warning('部分源失败：' + failed.map((s) => s.label).join('、'), 5)
      }
    } catch (error) {
      message.error('生成失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setGenerating(false)
      void refreshBoard()
    }
  }

  const doSearch = useCallback(async (): Promise<void> => {
    try {
      const r = await api.dailySearch({
        keyword: searchKeyword || undefined,
        sourceId: searchSourceId,
        topicId: searchTopicId,
        status: searchStatus,
        limit: PAGE_SIZE,
        offset: (searchPage - 1) * PAGE_SIZE
      })
      setSearchResult(r)
    } catch (error) {
      message.error('搜索失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [api, message, searchKeyword, searchSourceId, searchTopicId, searchStatus, searchPage])

  useEffect(() => {
    if (view === 'search') void doSearch()
  }, [view, doSearch])

  const handleStatus = async (id: number, next: DailyArticleStatus): Promise<void> => {
    try {
      const r = await api.dailyArticleStatus(id, next)
      r.ok ? message.success(r.message) : message.error(r.message)
      if (r.ok) setDetail((d) => (d && d.id === id ? { ...d, status: next } : d))
    } catch (error) {
      message.error('处理失败：' + (error instanceof Error ? error.message : String(error)))
    }
    if (view === 'board') void refreshBoard()
    else void doSearch()
  }

  const handleCategory = async (id: number, category: string): Promise<void> => {
    try {
      const r = await api.dailyArticleCategory(id, category)
      r.ok ? message.success(r.message) : message.error(r.message)
      if (r.ok) setDetail((d) => (d && d.id === id ? { ...d, category } : d))
    } catch (error) {
      message.error('分类失败：' + (error instanceof Error ? error.message : String(error)))
    }
    if (view === 'board') void refreshBoard()
    else void doSearch()
  }

  const openUrl = (url: string): void => {
    void api.appOpenExternal(url)
  }

  const handleHandoffArticle = (a: DailyArticle): void => {
    handoffToAi({ kind: 'article', id: a.id, title: a.title })
  }

  const handleHandoffReport = (): void => {
    if (board?.report) handoffToAi({ kind: 'daily', id: board.report.id, title: board.report.title })
  }

  const updateSource = (key: string, patch: Partial<DailySourceConfig>): void => {
    setSources((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  const removeSource = (key: string): void => {
    setSources((prev) => prev.filter((s) => s.key !== key))
  }

  const addCustomSource = (): void => {
    const stamp = Date.now()
    setSources((prev) => [
      ...prev,
      { key: 'custom-' + stamp, id: 'custom-' + stamp, label: '自定义源', endpoint: 'https://', enabled: true, builtin: false }
    ])
  }

  const dirty = useMemo(() => {
    const now = sources.map((s) => ({ id: s.id, label: s.label, endpoint: s.endpoint, enabled: s.enabled, builtin: s.builtin }))
    return JSON.stringify(now) !== JSON.stringify(savedSources)
  }, [sources, savedSources])

  const handleSaveSources = async (): Promise<void> => {
    setSaving(true)
    try {
      const clean: DailySourceConfig[] = sources.map((s) => ({
        id: s.id,
        label: s.label,
        endpoint: s.endpoint,
        enabled: s.enabled,
        builtin: s.builtin
      }))
      const r = await api.dailySourcesSet(clean)
      if (r.ok) message.success(r.message)
      else message.warning(r.message)
      await loadSources()
    } catch (error) {
      message.error('保存失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSaving(false)
    }
  }

  const handleRestoreDefaults = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await api.dailySourcesSet([])
      if (r.ok) message.success(r.message)
      else message.warning(r.message)
      await loadSources()
    } finally {
      setSaving(false)
    }
  }

  const toggleFocus = (id: string, checked: boolean): void => {
    setFocus((prev) => {
      const next = checked ? [...prev, id] : prev.filter((t) => t !== id)
      return DAILY_TOPICS.map((t) => t.id).filter((tid) => next.includes(tid))
    })
  }

  const saveFocus = async (): Promise<void> => {
    try {
      const r = await api.dailyFocusSet(focus)
      if (r.ok) message.success(r.message)
      else message.warning(r.message)
    } catch (error) {
      message.error('关注保存失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const today = todayStr()

  const goToday = (): void => {
    setDateKey(today)
    setReportPage(1)
    setPage(0)
  }

  const shiftDate = (delta: number): void => {
    setDateKey(dayjs(dateKey).add(delta, 'day').format('YYYY-MM-DD'))
    setReportPage(1)
    setPage(0)
  }

  const onDatePick = (d: Dayjs | null): void => {
    if (d) {
      setDateKey(d.format('YYYY-MM-DD'))
      setReportPage(1)
      setPage(0)
    }
  }

  const report = board?.report ?? null

  const columns = useMemo(() => {
    const list = [...(board?.columns ?? [])]
    list.sort((a, b) => {
      if (a.topicId === null && b.topicId !== null) return 1
      if (b.topicId === null && a.topicId !== null) return -1
      return b.articles.length - a.articles.length
    })
    return list
  }, [board])

  const total = useMemo(() => columns.reduce((n, c) => n + c.articles.length, 0), [columns])

  const pageCount = Math.max(1, Math.ceil(columns.length / COLS_PER_PAGE))
  const visibleColumns = columns.slice(page * COLS_PER_PAGE, page * COLS_PER_PAGE + COLS_PER_PAGE)

  const failedSources = useMemo(() => (report?.sources ?? []).filter((s) => s.error), [report])
  const showStatus = generating || status?.generating === true || failedSources.length > 0

  const reportNo = useMemo(() => {
    const items = reports?.items ?? []
    const i = items.findIndex((r) => r.dateKey === dateKey)
    return i >= 0 ? (reportPage - 1) * PAGE_SIZE + i + 1 : null
  }, [reports, dateKey, reportPage])

  const overlineRight =
    dayjs(dateKey).format('YYYY / MM / DD') +
    ' · ' +
    weekdayOf(dateKey) +
    (reportNo !== null ? ' · NO.' + String(reportNo).padStart(3, '0') : '')

  const detailParagraphs = useMemo(() => (detail ? paragraphsOf(detail.content) : []), [detail])

  const statusMenu: MenuProps['items'] = STATUS_ORDER.map((s) => ({ key: s, label: STATUS_LABEL[s] }))
  const categoryMenu: MenuProps['items'] = ACTION_CATEGORIES.map((c) => ({ key: c, label: c }))

  useEffect(() => {
    setPage(0)
    setExpanded({})
  }, [dateKey])

  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1))
  }, [pageCount])

  const turnPage = useCallback(
    (delta: number): void => {
      setPage((p) => {
        const next = p + delta
        return next < 0 || next > pageCount - 1 ? p : next
      })
    },
    [pageCount]
  )

  useEffect(() => {
    if (view !== 'board') return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (detail !== null || settingsOpen) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase() ?? ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable === true) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        turnPage(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        turnPage(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, detail, settingsOpen, turnPage])

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    wheelAcc.current += e.deltaX
    if (Math.abs(wheelAcc.current) >= WHEEL_THRESHOLD) {
      turnPage(wheelAcc.current > 0 ? 1 : -1)
      wheelAcc.current = 0
    }
  }

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const historyMeta = (r: { articleCount: number; status: 'complete' | 'partial' | 'failed' }): string =>
    r.articleCount + ' 条 · ' + (r.status === 'complete' ? '已生成' : r.status === 'partial' ? '部分失败' : '生成失败')

  return (
    <div className="daily-page">
      <div className="daily-overline">
        <span>INFOAGENT / DAILY</span>
        <span>{overlineRight}</span>
      </div>

      <div className="daily-title-row">
        <div className="daily-title-left">
          <h1 className="daily-h1">今日日报</h1>
          {report && (
            <span className="daily-sub">
              {total} 条{report.generatedAt ? ' · ' + fmtClock(report.generatedAt) + ' 生成' : ''}
            </span>
          )}
        </div>
        <div className="daily-actions">
          <div className="daily-stepper">
            <button type="button" className="daily-step" aria-label="前一天" onClick={() => shiftDate(-1)}>
              {'‹'}
            </button>
            <DatePicker
              className="daily-datepick"
              value={dayjs(dateKey)}
              allowClear={false}
              format="YYYY-MM-DD"
              suffixIcon={null}
              variant="borderless"
              onChange={onDatePick}
            />
            <button
              type="button"
              className="daily-step"
              aria-label="后一天"
              disabled={dateKey >= today}
              onClick={() => shiftDate(1)}
            >
              {'›'}
            </button>
          </div>
          <button type="button" className="daily-text-btn" onClick={goToday}>
            今天
          </button>
          <Button type="primary" className="daily-gen" loading={generating} onClick={() => void handleGenerate()}>
            生成日报
          </Button>
          <button type="button" className="daily-text-btn" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </div>

      {showStatus && (
        <div className="daily-status">
          {(generating || status?.generating === true) && <span className="daily-status-text">正在生成…</span>}
          {failedSources.length > 0 && (
            <button type="button" className="daily-status-fail" onClick={() => setFailOpen((v) => !v)}>
              <i className="daily-dot" />
              {failedSources.length} 个来源失败：{failedSources.map((s) => s.label).join('、')}
            </button>
          )}
          {failOpen && failedSources.length > 0 && (
            <div className="daily-status-detail">
              {failedSources.map((s) => (
                <div key={s.sourceId}>
                  {s.label}：{s.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="daily-rule" />

      <div className="daily-viewbar">
        <div className="daily-tabs">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={'daily-tab' + (view === v.key ? ' is-on' : '')}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'board' && (
        report === null || total === 0 ? (
          <div className="daily-empty">
            <div className="daily-empty-title">{loading ? '正在读取…' : '今日尚未生成日报'}</div>
            {!loading && (
              <>
                <Button type="primary" className="daily-gen" onClick={() => void handleGenerate()}>
                  生成日报
                </Button>
                <div className="daily-empty-note">
                  {status?.nextRunAt ? '下次自动生成 ' + fmtClock(status.nextRunAt) : '每个工作日自动生成'}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="daily-pager" onWheel={onWheel}>
              <button
                type="button"
                className="daily-arrow daily-arrow-prev"
                aria-label="上一页"
                disabled={page === 0}
                onClick={() => turnPage(-1)}
              >
                {'‹'}
              </button>
              <div className="daily-cols" key={page}>
                {visibleColumns.map((col) => {
                  const key = col.topicId ?? 'unfiled'
                  const open = expanded[key] === true
                  const shown = open ? col.articles : col.articles.slice(0, ROW_LIMIT)
                  return (
                    <section key={key} className="daily-col">
                      <div className="daily-col-head">
                        <span className="daily-col-title">{col.topicLabel}</span>
                        <span className="daily-col-count">{String(col.articles.length).padStart(2, '0')}</span>
                      </div>
                      <div className="daily-col-body">
                        {shown.map((a) => (
                          <div
                            key={a.id}
                            className={'daily-row' + (a.status === 'archive' ? ' is-archived' : '')}
                            title={a.title}
                            onClick={() => setDetail(a)}
                          >
                            <span className="daily-row-title">{a.title}</span>
                            <span className="daily-row-ops">
                              {a.url && (
                                <button
                                  type="button"
                                  className="daily-op"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openUrl(a.url as string)
                                  }}
                                >
                                  打开
                                </button>
                              )}
                              <button
                                type="button"
                                className="daily-op"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleHandoffArticle(a)
                                }}
                              >
                                AI
                              </button>
                              {a.status !== 'archive' && (
                                <button
                                  type="button"
                                  className="daily-op"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void handleStatus(a.id, 'archive')
                                  }}
                                >
                                  归档
                                </button>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                      {col.articles.length > ROW_LIMIT && (
                        <button type="button" className="daily-more" onClick={() => toggleExpanded(key)}>
                          {open ? '收起' : '还有 ' + (col.articles.length - ROW_LIMIT) + ' 条'}
                        </button>
                      )}
                    </section>
                  )
                })}
              </div>
              <button
                type="button"
                className="daily-arrow daily-arrow-next"
                aria-label="下一页"
                disabled={page >= pageCount - 1}
                onClick={() => turnPage(1)}
              >
                {'›'}
              </button>
            </div>
            {pageCount > 1 && (
              <div className="daily-foot">
                <div className="daily-ticks">
                  {Array.from({ length: pageCount }, (_, i) => (
                    <button
                      key={i}
                      type="button"
                      className={'daily-tick' + (i === page ? ' is-on' : '')}
                      aria-label={'第 ' + (i + 1) + ' 页'}
                      onClick={() => setPage(i)}
                    />
                  ))}
                </div>
                <span className="daily-pageno">
                  {page + 1} / {pageCount}
                </span>
              </div>
            )}
          </>
        )
      )}

      {view === 'search' && (
        <>
          <div className="daily-filters">
            <span className="daily-filter-kw">
              <Input
                placeholder="关键词"
                allowClear
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                onPressEnter={() => {
                  setSearchPage(1)
                  void doSearch()
                }}
              />
            </span>
            <Select
              className="daily-filter-sel"
              allowClear
              placeholder="来源"
              value={searchSourceId}
              options={board?.report?.sources.map((s) => ({ value: s.sourceId, label: s.label })) ?? []}
              onChange={(v?: string) => {
                setSearchSourceId(v)
                setSearchPage(1)
              }}
            />
            <Select
              className="daily-filter-sel"
              allowClear
              placeholder="主题"
              value={searchTopicId}
              options={DAILY_TOPICS.map((t) => ({ value: t.id, label: t.label }))}
              onChange={(v?: string) => {
                setSearchTopicId(v)
                setSearchPage(1)
              }}
            />
            <Select
              className="daily-filter-sel daily-filter-sel-sm"
              allowClear
              placeholder="状态"
              value={searchStatus}
              options={[
                { value: 'all', label: '全部' },
                { value: 'keep', label: '资料' },
                { value: 'archive', label: '已归档' },
                { value: 'item', label: '已转事项' },
                { value: 'unverified', label: '待核实' }
              ]}
              onChange={(v?: string) => {
                setSearchStatus((v as 'all' | DailyArticleStatus) ?? 'all')
                setSearchPage(1)
              }}
            />
            <Button
              type="primary"
              className="daily-gen"
              onClick={() => {
                setSearchPage(1)
                void doSearch()
              }}
            >
              搜索
            </Button>
          </div>

          <div className="daily-result-list">
            {(searchResult?.items ?? []).map((a) => (
              <div key={a.id} className="daily-row daily-row-search" title={a.title} onClick={() => setDetail(a)}>
                <span className="daily-row-title">{a.title}</span>
                <span className="daily-row-src">
                  {a.sourceLabel} · {dayjs(a.publishedAt ?? a.createdAt).format('MM-DD')}
                </span>
              </div>
            ))}
            {searchResult !== null && searchResult.items.length === 0 && <div className="daily-none">无匹配资讯</div>}
          </div>

          {searchResult !== null && searchResult.total > 0 && (
            <div className="daily-pager-line">
              <Pagination
                size="small"
                current={searchPage}
                pageSize={PAGE_SIZE}
                total={searchResult.total}
                onChange={(p) => setSearchPage(p)}
                showSizeChanger={false}
              />
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        <>
          <div className="daily-history-list">
            {(reports?.items ?? []).map((r) => (
              <div
                key={r.id}
                className={'daily-row daily-row-hist' + (r.dateKey === dateKey ? ' is-on' : '')}
                onClick={() => {
                  setDateKey(r.dateKey)
                  setReportPage(1)
                  setPage(0)
                  setView('board')
                }}
              >
                <span className="daily-hist-date">{r.dateKey}</span>
                <span className="daily-hist-week">{weekdayOf(r.dateKey)}</span>
                <span className="daily-hist-meta">{historyMeta(r)}</span>
              </div>
            ))}
            {(reports?.items ?? []).length === 0 && <div className="daily-none">暂无历史日报</div>}
          </div>
          {(reports?.total ?? 0) > 0 && (
            <div className="daily-pager-line">
              <Pagination
                size="small"
                current={reportPage}
                pageSize={PAGE_SIZE}
                total={reports?.total ?? 0}
                onChange={(p) => setReportPage(p)}
                showSizeChanger={false}
              />
            </div>
          )}
        </>
      )}

      <div className="daily-footer">
        <span>InfoAgent 自动汇编</span>
        <div className="daily-footer-actions">
          {report && (
            <button type="button" className="daily-footer-link" onClick={handleHandoffReport}>
              交给 AI
            </button>
          )}
          <button type="button" className="daily-footer-link" onClick={() => setView('history')}>
            历史日报
          </button>
        </div>
      </div>

      <Drawer
        open={detail !== null}
        width={520}
        closable={false}
        onClose={() => setDetail(null)}
        className="daily-drawer"
        classNames={{ body: 'daily-drawer-body', footer: 'daily-drawer-foot' }}
        footer={
          detail && (
            <div className="daily-drawer-actions">
              {detail.url && (
                <Button
                  size="small"
                  type="primary"
                  className="daily-btn-dark"
                  onClick={() => openUrl(detail.url as string)}
                >
                  打开原文
                </Button>
              )}
              <Button size="small" type={detail.url ? 'text' : 'primary'} onClick={() => handleHandoffArticle(detail)}>
                交给 AI
              </Button>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: statusMenu,
                  className: 'daily-menu-list',
                  onClick: ({ key }) => void handleStatus(detail.id, key as DailyArticleStatus)
                }}
              >
                <Button size="small" type="text">
                  标记去向
                </Button>
              </Dropdown>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: categoryMenu,
                  className: 'daily-menu-list',
                  onClick: ({ key }) => void handleCategory(detail.id, key)
                }}
              >
                <Button size="small" type="text">
                  改分类
                </Button>
              </Dropdown>
            </div>
          )
        }
      >
        {detail && (
          <div className="daily-detail">
            <div className="daily-detail-head">
              <span className="daily-overline">
                {detail.sourceLabel} · {fmtStamp(detail.publishedAt ?? detail.createdAt)}
              </span>
              <button type="button" className="daily-detail-close" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
            <h2 className="daily-detail-title">{detail.title}</h2>
            <div className="daily-detail-body">
              {detailParagraphs.length === 0 ? (
                <p className="daily-detail-empty">暂无正文</p>
              ) : (
                detailParagraphs.map((p, i) => <p key={i}>{p}</p>)
              )}
            </div>
            {(detail.topicMatches.length > 0 || (detail.itemId !== null && detail.itemTitle)) && (
              <div className="daily-detail-meta">
                {detail.topicMatches.length > 0 && <div>归类依据：{detail.topicMatches.join('、')}</div>}
                {detail.itemId !== null && detail.itemTitle && (
                  <div>
                    已转事项：{detail.itemTitle}（#{detail.itemId}）
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Drawer
        title="日报设置"
        width={560}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        className="daily-drawer"
        classNames={{ body: 'daily-drawer-body', header: 'daily-drawer-head' }}
      >
        <div className="daily-settings">
          <div className="daily-section-label">平台来源</div>
          <div className="daily-hint">自定义端点需返回 JSON 条目数组（title/score/url/content）；空列表保存即恢复内置默认。</div>
          <div className="daily-sources">
            {sources.length === 0 ? (
              <div className="daily-none">暂无源，添加自定义源或恢复默认</div>
            ) : (
              sources.map((s) => (
                <div key={s.key} className="daily-source-row">
                  <Switch size="small" checked={s.enabled} onChange={(v) => updateSource(s.key, { enabled: v })} />
                  {s.builtin && <span className="daily-badge">内置</span>}
                  <Input
                    className="daily-source-label"
                    value={s.label}
                    onChange={(e) => updateSource(s.key, { label: e.target.value })}
                    placeholder="源名称"
                    maxLength={50}
                  />
                  <Input
                    className="daily-source-endpoint"
                    value={s.endpoint}
                    onChange={(e) => updateSource(s.key, { endpoint: e.target.value })}
                    placeholder="https://…"
                  />
                  <Popconfirm title="删除该源？" onConfirm={() => removeSource(s.key)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              ))
            )}
          </div>
          <div className="daily-settings-row">
            <Button size="small" type="text" onClick={addCustomSource}>
              添加自定义源
            </Button>
            <Popconfirm
              title="放弃所有自定义配置，恢复内置默认源（B站/抖音/百度）？"
              onConfirm={() => void handleRestoreDefaults()}
            >
              <Button size="small" type="text">
                恢复默认
              </Button>
            </Popconfirm>
            <Button
              size="small"
              type="primary"
              className="daily-btn-dark"
              disabled={!dirty}
              loading={saving}
              onClick={() => void handleSaveSources()}
            >
              保存来源
            </Button>
          </div>

          <div className="daily-section-label daily-section-gap">知乎推荐与反推荐</div>
          <div className="daily-hint">
            推荐按你的兴趣标签从知乎推荐流里排序；反推荐以推荐位为种子，找同一类议题的另一面。显示在面板「知乎」来源里。
          </div>
          <div className="daily-settings-row">
            <span>推荐条数</span>
            <Select
              aria-label="知乎推荐每天条数"
              value={zhihuRecommendCount}
              style={{ width: 100 }}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} 条` }))}
              onChange={setZhihuRecommendCount}
            />
            <span>反推荐条数</span>
            <Select
              aria-label="知乎反推荐每天条数"
              value={zhihuCounterCount}
              style={{ width: 100 }}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} 条` }))}
              onChange={setZhihuCounterCount}
            />
            <Button
              size="small"
              type="primary"
              className="daily-btn-dark"
              loading={savingZhihu}
              onClick={() => void saveZhihuCount()}
            >
              保存条数
            </Button>
          </div>

          <div className="daily-section-label daily-section-gap">固定关注话题</div>
          <div className="daily-hint">固定关注列始终显示；未选中的话题在当天有内容时进入「今日发现」。</div>
          <div className="daily-focus-grid">
            {DAILY_TOPICS.map((t) => (
              <div key={t.id} className="daily-focus-item">
                <Switch size="small" checked={focus.includes(t.id)} onChange={(v) => toggleFocus(t.id, v)} />
                <span>{t.label}</span>
              </div>
            ))}
          </div>
          <div className="daily-settings-row">
            <Button size="small" type="primary" className="daily-btn-dark" onClick={() => void saveFocus()}>
              保存关注
            </Button>
          </div>
        </div>
      </Drawer>
    </div>
  )
}

export const dailyModule: ModuleManifest = {
  id: 'daily',
  title: '日报',
  icon: <CalendarOutlined />,
  route: '/daily',
  enabled: true,
  page: () => <DailyPage />
}
