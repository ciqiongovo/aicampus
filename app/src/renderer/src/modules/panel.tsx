import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Dropdown, Empty, Input, Modal, Skeleton, Select, Tag, Tooltip, message } from 'antd'
import { PREF } from '../prefs'
import {
  ArrowRightOutlined,
  BookOutlined,
  BulbOutlined,
  CalendarOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  InboxOutlined,
  ReloadOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ModuleManifest } from './types'
import { PANEL_ACTIONS, panelActionLabel, DEFAULT_FEEDBACK_SENSITIVITY, isFeedbackSensitivityLevel } from '../../../shared/panel'
import type { FeedbackSensitivityLevel, PanelActionKey, PanelKeywordProfile, PanelOverview, PanelOverviewQuery, PanelRecommendation } from '../../../shared/panel'
import { PANEL_TOPICS } from '../../../shared/topics'
import { PANEL_PAGE_SIZE, PanelDataSession } from './panelState'
import { QqPanelBlock } from './qqSource'
import { KeywordProfile } from './keywordProfile'
import { FeedbackSensitivityMenu } from './feedbackSensitivityMenu'
import { InterestFeedSection, zhihuInterestApi } from './panel/InterestFeedSection'
import { ZHIHU_FEED_TEMPLATE } from '../../../shared/feedPlatform'
import type { MaterialFolder } from '../../../shared/materials'
import './panel.css'

const RADAR_TOPICS = PANEL_TOPICS.filter((topic) => topic.id !== 'uncategorized')
const DEFAULT_CONCERN = 5
const PRIORITY_TABS = [
  { key: 'focus', label: '重点邮件' },
  { key: 'other', label: '其他邮件' }
] as const

const ACTION_ICON: Record<PanelActionKey, JSX.Element> = {
  ignore: <EyeInvisibleOutlined />,
  archive: <InboxOutlined />,
  material: <BookOutlined />,
  schedule: <CalendarOutlined />,
  todo: <CheckSquareOutlined />
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
})

function whenText(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return dateFormatter.format(date)
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t < Date.now()
}

/** 与“我的关心”共用同一组主题权重；这里只做紧凑预览，编辑仍在设置页。 */
function ConcernRadar({ weights }: { weights: Record<string, number> }): JSX.Element {
  const cx = 120
  const cy = 100
  const radius = 62
  const point = (index: number, scale: number): [number, number] => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / RADAR_TOPICS.length
    return [cx + Math.cos(angle) * radius * scale, cy + Math.sin(angle) * radius * scale]
  }
  const polygon = (scale: number): string =>
    RADAR_TOPICS.map((_, index) => point(index, scale).map((n) => n.toFixed(1)).join(',')).join(' ')
  const value = (id: string): number => Math.max(0, Math.min(10, weights[id] ?? DEFAULT_CONCERN))

  return (
    <svg className="panel-radar" viewBox="0 0 240 204" role="img" aria-label="八类主题关心程度雷达图">
      {[0.25, 0.5, 0.75, 1].map((level) => (
        <polygon key={level} points={polygon(level)} className="panel-radar-ring" />
      ))}
      {RADAR_TOPICS.map((topic, index) => {
        const [x, y] = point(index, 1)
        return <line key={topic.id} x1={cx} y1={cy} x2={x} y2={y} className="panel-radar-spoke" />
      })}
      {RADAR_TOPICS.map((topic, index) => {
        const [x, y] = point(index, 1.29)
        return (
          <text key={topic.id} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="panel-radar-label">
            {topic.name}
          </text>
        )
      })}
      <polygon
        points={RADAR_TOPICS.map((topic, index) => point(index, value(topic.id) / 10).map((n) => n.toFixed(1)).join(',')).join(' ')}
        className="panel-radar-area"
      />
      {RADAR_TOPICS.map((topic, index) => {
        const [x, y] = point(index, value(topic.id) / 10)
        return (
          <circle key={topic.id} cx={x} cy={y} r="2.6" className="panel-radar-dot">
            <title>{`${topic.name} ${value(topic.id).toFixed(1)}`}</title>
          </circle>
        )
      })}
    </svg>
  )
}

function ConcernRail({ overview, onAdjust, sensitivity, onSensitivity }: {
  overview: PanelOverview
  onAdjust: () => void
  sensitivity: FeedbackSensitivityLevel
  onSensitivity: (next: FeedbackSensitivityLevel) => void
}): JSX.Element {
  const top = useMemo(
    () =>
      [...RADAR_TOPICS]
        .map((topic) => ({ ...topic, value: overview.concerns[topic.id] ?? DEFAULT_CONCERN }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 3),
    [overview.concerns]
  )
  return (
    <section className="panel-rail-card">
      <div className="panel-rail-head">
        <span>关心雷达</span>
        <span className="panel-rail-head-actions">
          <FeedbackSensitivityMenu kind="radar" value={sensitivity} onChange={onSensitivity} persist showLabel />
          <button type="button" className="panel-link" onClick={onAdjust}>
            调整
          </button>
        </span>
      </div>
      <ConcernRadar weights={overview.concerns} />
      <div className="panel-concern-top">
        {top.map((topic) => (
          <div className="panel-concern-row" key={topic.id}>
            <span>{topic.name}</span>
            <b>{topic.value.toFixed(1)}</b>
          </div>
        ))}
      </div>
    </section>
  )
}

function SignalChips({ overview }: { overview: PanelOverview }): JSX.Element {
  if (overview.learning.length === 0) {
    return <p className="panel-quiet">处置几条后，这里会记下你的取舍。</p>
  }
  return (
    <div className="panel-signals">
      {overview.learning.map((signal) => (
        <Tag
          key={signal.dimension + signal.key}
          bordered={false}
          className={signal.weight >= 0 ? 'panel-signal panel-signal-up' : 'panel-signal panel-signal-down'}
        >
          {signal.dimension === 'topic' ? '主题' : '来源'} · {signal.label}
          <span>{signal.weight >= 0 ? '更关心' : '少看'}</span>
        </Tag>
      ))}
    </div>
  )
}

const RecommendationCard = memo(function RecommendationCard({
  item,
  busy,
  disabled,
  onAct,
  onOpenEmail
}: {
  item: PanelRecommendation
  busy: boolean
  disabled: boolean
  onAct: (item: PanelRecommendation, action: PanelActionKey) => void
  onOpenEmail: (emailId: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const overdue = isOverdue(item.deadlineAt ?? item.eventStartAt)
  const arrived = whenText(item.receivedAt)
  const alternatives = PANEL_ACTIONS.filter((action) => action.key !== item.recommendedAction)
  return (
    <article className={item.urgent ? 'panel-card panel-card-urgent' : 'panel-card'} aria-busy={busy}>
      <div className="panel-card-content">
        <div className="panel-card-meta">
          {item.urgent && <strong className="panel-urgent-badge">紧急 · 近3天未读且有截止时间</strong>}
          {item.topicLabel && <span className={`panel-topic panel-topic-${item.topic}`}>{item.topicLabel}</span>}
          <span className="panel-source-label">{item.sourceLabel}</span>
          {arrived && (
            <time className="panel-arrival" dateTime={item.receivedAt} title={`到达时间：${arrived}`}>
              {arrived} 到达
            </time>
          )}
        </div>
        <h3 className="panel-card-title">{item.emailId !== null ? <button type="button" className="panel-open-email" onClick={() => onOpenEmail(item.emailId!)}>{item.title}</button> : item.title}</h3>
        {item.excerpt && (
          <button
            type="button"
            className={open ? 'panel-card-excerpt panel-card-excerpt-open' : 'panel-card-excerpt'}
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            title={open ? '收起摘要' : '展开摘要'}
          >
            {item.excerpt}
          </button>
        )}
        <div className="panel-card-detail">
          <div className="panel-reason" title={item.reason}>
            <BulbOutlined />
            <span>{item.reason}</span>
          </div>
          {(item.deadlineAt || item.eventStartAt) && (
            <span className={overdue ? 'panel-time panel-time-overdue' : 'panel-time'}>
              <ClockCircleOutlined />
              {item.deadlineAt ? '截止' : '日程'} {whenText(item.deadlineAt ?? item.eventStartAt)}
            </span>
          )}
        </div>
      </div>
      <div className="panel-card-actions">
        <div className="panel-action-buttons">
          <button
            type="button"
            className="panel-primary"
            disabled={disabled || busy}
            onClick={() => onAct(item, item.recommendedAction)}
          >
            {ACTION_ICON[item.recommendedAction]}
            {busy ? '处理中…' : panelActionLabel(item.recommendedAction)}
          </button>
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            disabled={disabled || busy}
            menu={{
              items: alternatives.map((action) => ({
                key: action.key,
                icon: ACTION_ICON[action.key],
                label: (
                  <div className="panel-menu-item">
                    <b>{action.label}</b>
                    <span>{action.hint}</span>
                  </div>
                )
              })),
              onClick: ({ key }) => onAct(item, key as PanelActionKey)
            }}
          >
            <button type="button" className="panel-more" aria-label={`为“${item.title}”选择其他动作`} disabled={disabled || busy}>
              <DownOutlined />
            </button>
          </Dropdown>
        </div>
      </div>
    </article>
  )
})

function todayKey(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const PanelPage = memo(function PanelPage(): JSX.Element {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [overview, setOverview] = useState<PanelOverview | null>(null)
  const [sources, setSources] = useState<PanelOverview['sources']>([])
  const [sourceKey, setSourceKey] = useState<string | undefined>('email')
  const [saveTarget, setSaveTarget] = useState<PanelRecommendation | null>(null)
  const [saveFolder, setSaveFolder] = useState('uncategorized')
  const [saveFolders, setSaveFolders] = useState<MaterialFolder[]>([])
  const [newFolderName, setNewFolderName] = useState('')
  const [savingMaterial, setSavingMaterial] = useState(false)
  const [mailDateRange, setMailDateRange] = useState<PanelOverviewQuery['mailDateRange']>(7)
  const [qqDateRange, setQqDateRange] = useState<import('../../../shared/im').QqPanelRange>(3)
  const [qqKeywordProfile, setQqKeywordProfile] = useState<PanelKeywordProfile[] | undefined>(undefined)
  const [feedbackSensitivity, setFeedbackSensitivity] = useState<{ radar: FeedbackSensitivityLevel; keyword: FeedbackSensitivityLevel }>({
    radar: DEFAULT_FEEDBACK_SENSITIVITY,
    keyword: DEFAULT_FEEDBACK_SENSITIVITY
  })
  const [priority, setPriority] = useState<PanelRecommendation['priority']>('focus')
  const [loading, setLoading] = useState(true)
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined])
  const [continuing, setContinuing] = useState(false)
  const [actingId, setActingId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const mounted = useRef(false)
  const mutationInFlight = useRef(false)
  const session = useMemo(() => new PanelDataSession(window.api, {
    overview: (data) => {
      setOverview(data)
      if (data) setSources(data.sources)
    },
    loading: setLoading,
    error: setError
  }), [])

  useEffect(() => {
    mounted.current = true
    session.start()
    // Retire the old email-content cache without reading/parsing it. Never write it again.
    try { localStorage.removeItem(PREF.panelSnapshot) } catch { /* storage may be disabled */ }
    return () => { mounted.current = false; session.stop() }
  }, [session])

  const loadQqKeywordProfile = useCallback(async (): Promise<void> => {
    try {
      setQqKeywordProfile(await window.api.panelKeywordProfile())
    } catch {
      /* 画像读取失败不阻塞 QQ 列表 */
    }
  }, [])

  useEffect(() => {
    if (sourceKey === undefined) void loadQqKeywordProfile()
  }, [sourceKey, loadQqKeywordProfile])

  useEffect(() => {
    void window.api.settingsGet().then((settings) => {
      setFeedbackSensitivity({
        radar: isFeedbackSensitivityLevel(settings.radarSensitivity) ? settings.radarSensitivity : DEFAULT_FEEDBACK_SENSITIVITY,
        keyword: isFeedbackSensitivityLevel(settings.keywordSensitivity) ? settings.keywordSensitivity : DEFAULT_FEEDBACK_SENSITIVITY
      })
    }).catch(() => { /* 读取失败时保持默认灵敏度 */ })
  }, [])

  const changeFeedbackSensitivity = useCallback((kind: 'radar' | 'keyword', next: FeedbackSensitivityLevel): void => {
    setFeedbackSensitivity((previous) => ({ ...previous, [kind]: next }))
    if (kind === 'keyword') void loadQqKeywordProfile()
  }, [loadQqKeywordProfile])

  useEffect(() => {
    const updateActivity = (): void => session.setActive(pathname === '/panel' && sourceKey !== undefined && document.visibilityState === 'visible')
    const refreshVisible = (): void => {
      if (pathname === '/panel' && sourceKey !== undefined && document.visibilityState === 'visible') session.generate()
    }
    updateActivity()
    const interval = window.setInterval(refreshVisible, 15_000)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', updateActivity)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', updateActivity)
      session.setActive(false)
    }
  }, [pathname, session, sourceKey])

  const refresh = useCallback((): void => session.generate(true), [session])
  // 第一个 tab 是“重点”：汇总所有来源里的重点条目。只有邮箱有重点/其他分组，
  // 其他来源各自展示自己的全部内容。
  const priorityOf = useCallback((key: string | undefined): PanelRecommendation['priority'] | undefined => {
    if (key === undefined) return undefined
    return sources.find((source) => source.key === key)?.kind === 'email' ? priority : undefined
  }, [sources, priority])
  const changeSource = useCallback((key: string | undefined): void => {
    if (key === sourceKey) return
    setSourceKey(key)
    setCursors([undefined])
    if (key !== undefined) session.selectView(key, priorityOf(key), undefined, mailDateRange)
  }, [session, sourceKey, priorityOf, mailDateRange])
  const changePriority = useCallback((value: PanelRecommendation['priority']): void => {
    setPriority(value)
    setCursors([undefined])
    session.selectView(sourceKey, value, undefined, mailDateRange)
  }, [session, sourceKey, mailDateRange])

  const runMutation = useCallback(async (
    kind: number | 'continue',
    operation: (key: string | undefined, query: PanelOverviewQuery) => Promise<PanelOverview | undefined>
  ): Promise<void> => {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    if (typeof kind === 'number') setActingId(kind)
    else setContinuing(true)
    try {
      await session.mutate(operation, kind === 'continue')
    } catch (e) {
      if (mounted.current) message.error(e instanceof Error ? e.message : String(e))
    } finally {
      mutationInFlight.current = false
      if (mounted.current) {
        setActingId(null)
        setContinuing(false)
      }
    }
  }, [session])

  const act = useCallback((item: PanelRecommendation, action: PanelActionKey, folder?: string): void => {
    if (action === 'material' && folder === undefined) {
      setSaveFolder('uncategorized'); setNewFolderName(''); setSaveTarget(item)
      void window.api.materialsList().then(result => setSaveFolders(result.folders)).catch(e => message.error(String(e)))
      return
    }
    void runMutation(item.id, async (key, query) => {
      const result = await window.api.panelAct(item.id, action, folder)
      if (!mounted.current) return
      if (!result.ok) { message.error(result.message); return }
      // Remove immediately even if the reconciliation read fails. Every source cache was invalidated.
      session.removeHandled(item.id)
      message.success(result.message)
      return window.api.panelOverview(key, false, query)
    })
  }, [runMutation, session])

  const next = useCallback((): void => {
    void runMutation('continue', (key, query) => window.api.panelContinue(key, query))
  }, [runMutation])

  const activeSource = useMemo(
    () => (sourceKey ? sources.find((source) => source.key === sourceKey) : undefined),
    [sources, sourceKey]
  )
  // 重点/其他分组只属于邮箱；跨来源的“重点”tab 固定只看重点，其他来源不套用邮件分组。
  const isMailView = activeSource?.kind === 'email'
  const isFocusView = sourceKey === undefined
  const beforeInfoId = cursors[cursors.length - 1]
  useEffect(() => { if (sourceKey !== undefined) session.selectView(sourceKey, priorityOf(sourceKey), beforeInfoId, mailDateRange) }, [session, sourceKey, priorityOf, beforeInfoId, mailDateRange])
  const movePage = (older: boolean): void => {
    const cursor = overview?.nextBeforeInfoId
    const nextCursors = older && cursor != null ? [...cursors, cursor] : cursors.slice(0, -1)
    if (nextCursors.length === 0) return
    setCursors(nextCursors)
    session.selectView(sourceKey, priorityOf(sourceKey), nextCursors[nextCursors.length - 1], mailDateRange)
  }
  const counts = overview?.priorityCounts ?? { focus: 0, other: 0 }
  const cards = overview?.recommendations ?? []
  const viewPending = overview?.pendingTotal ?? cards.length
  const hasCards = isMailView ? counts.focus + counts.other > 0 : viewPending > 0
  const batchFinished = overview !== null && overview.batchProcessed > 0 && !hasCards
  const processing = actingId !== null || continuing
  const activeLabel = sourceKey ? (sources.find((s) => s.key === sourceKey)?.label ?? '全部来源') : '全部来源的重点'

  return (
    <div className="panel-page">
      <Modal title="存为资料" open={saveTarget !== null} okText="保存" cancelText="取消" confirmLoading={savingMaterial} onCancel={() => setSaveTarget(null)} onOk={async () => {
        if (!saveTarget) return
        setSavingMaterial(true)
        try {
          const folder = newFolderName.trim() ? await window.api.materialsCreateFolder(newFolderName.trim()) : saveFolder
          act(saveTarget, 'material', folder)
          setSaveTarget(null)
        } catch (e) { message.error(String(e)) } finally { setSavingMaterial(false) }
      }}>
        <p>选择保存文件夹，或填写名称创建新文件夹。</p>
        <Select aria-label="保存文件夹" style={{width: '100%'}} value={saveFolder} onChange={setSaveFolder} options={saveFolders.map(f => ({value: f.key, label: f.label}))} />
        <Input style={{marginTop: 12}} maxLength={60} placeholder="新建文件夹（可选）" value={newFolderName} onChange={e => setNewFolderName(e.target.value)} />
      </Modal>

      <header className="panel-bar">
        <div className="panel-source-picker">
          <label htmlFor="panel-source-select">信息来源</label>
          <Select id="panel-source-select" aria-label="面板信息来源" value={sourceKey ?? 'qq'} style={{ width: 190 }}
            options={[
              { value: 'email', label: '邮件' },
              { value: 'qq', label: 'QQ 群聊' },
              { value: 'zhihu', label: '知乎' }
            ]}
            onChange={(key) => changeSource(key === 'qq' ? undefined : key)}
          />
        </div>
        <div className="panel-tools">
          <Tooltip title="AI 设置">
            <Button type="text" size="small" icon={<SettingOutlined />} onClick={() => navigate('/settings')} />
          </Tooltip>
          {sourceKey !== undefined && sourceKey !== 'zhihu' && <Tooltip title="刷新">
            <Button type="text" size="small" icon={<ReloadOutlined />} loading={loading} disabled={processing} onClick={() => void refresh()} />
          </Tooltip>}
        </div>
      </header>

      {sourceKey === undefined ? (
        <div className="panel-qq-view">
          <div className="panel-qq-filter">
            <span>QQ 消息时间</span>
            <Select aria-label="QQ 消息日期" value={qqDateRange} style={{ width: 135 }}
              options={[...([1, 3, 7, 30] as const).map(days => ({ value: days, label: `${days}天内` })), { value: 'older30', label: '30天前' }]}
              onChange={setQqDateRange} />
          </div>
          <div className="panel-layout">
            <main className="panel-main">
              <QqPanelBlock dateKey={todayKey()} range={qqDateRange} onFeedback={loadQqKeywordProfile} />
            </main>
            <aside className="panel-rail" aria-label="全局关键词画像">
              <KeywordProfile
                items={qqKeywordProfile}
                action={<FeedbackSensitivityMenu kind="keyword" value={feedbackSensitivity.keyword} onChange={(next) => changeFeedbackSensitivity('keyword', next)} persist showLabel />}
              />
            </aside>
          </div>
        </div>
      ) : sourceKey === 'zhihu' ? (
        <InterestFeedSection
          template={ZHIHU_FEED_TEMPLATE}
          api={zhihuInterestApi(window.api)}
          onOpenSettings={() => navigate('/daily')}
          onOpenAccounts={() => navigate('/settings?tab=accounts')}
        />
      ) : <>
      {error && <Alert type="error" showIcon message="读取失败" description={error} className="panel-alert" />}
      {overview && !overview.aiConfigured && overview.aiMessage && (
        <Alert
          type="warning"
          showIcon
          className="panel-alert"
          message={overview.aiMessage}
          action={
            <Button size="small" onClick={() => navigate('/settings')}>
              去配置
            </Button>
          }
        />
      )}

      <div className={isMailView ? 'panel-layout' : 'panel-layout panel-layout-wide'}>
        <main className="panel-main" aria-busy={loading}>
          {isMailView && (
          <div className="panel-mail-tabs" role="tablist" aria-label="邮件分组">
            {PRIORITY_TABS.map((tab) => (
              <button
                key={tab.key}
                id={`panel-mail-tab-${tab.key}`}
                type="button"
                role="tab"
                aria-selected={priority === tab.key}
                aria-controls="panel-mail-list"
                tabIndex={priority === tab.key ? 0 : -1}
                className={priority === tab.key ? 'panel-mail-tab active' : 'panel-mail-tab'}
                onClick={() => changePriority(tab.key)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const key = event.key === 'Home' ? 'focus' : event.key === 'End' ? 'other' : tab.key === 'focus' ? 'other' : 'focus'
                  changePriority(key)
                  document.getElementById(`panel-mail-tab-${key}`)?.focus()
                }}
              >
                {tab.label}
                <span className="panel-mail-count">{counts[tab.key]}</span>
              </button>
            ))}
            <Select aria-label="邮件发送日期" value={mailDateRange} style={{ width: 132 }}
              options={[...([1, 3, 7, 14, 30] as const).map((days) => ({ value: days, label: `${days}天内` })), { value: 'older30', label: '30天前' }]}
              onChange={(value) => { setMailDateRange(value); setCursors([undefined]); session.selectView(sourceKey, priorityOf(sourceKey), undefined, value) }}
            />
            <span className="panel-tabs-meta">
              {overview && hasCards && (
                <span className="panel-batch-stats">
                  {overview.batchProcessed}/{overview.batchTotal} · 待读 {overview.remaining}
                </span>
              )}
              <span className="panel-live-note"><i />自动更新</span>
            </span>
          </div>
          )}

          <div
            id="panel-mail-list"
            role={isMailView ? 'tabpanel' : undefined}
            aria-labelledby={isMailView ? `panel-mail-tab-${priority}` : undefined}
          >
            {loading && !overview ? (
              <div className="panel-skeleton">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} active title={false} paragraph={{ rows: 2 }} className="panel-skeleton-card" />
                ))}
              </div>
            ) : overview && cards.length > 0 ? (
              <>
                <div className="panel-list">
                  {cards.map((item) => (
                    <RecommendationCard
                      key={item.id}
                      item={item}
                      busy={actingId === item.id}
                      disabled={processing}
                      onAct={act}
                      onOpenEmail={(emailId) => navigate('/mail', { state: { openMailId: emailId, fromPanel: true } })}
                    />
                  ))}
                </div>
                <div className="panel-stream-foot">
                  <span>
                    {isMailView && priority === 'focus' && counts.other > 0
                      ? '其他邮件可稍后处理，不影响继续阅读'
                      : isMailView
                        ? '新到邮件会自动加入，按到达时间排列'
                        : isFocusView
                          ? '这里汇总所有来源的重点内容，按到达时间排列'
                          : '新内容会自动加入，按到达时间排列'}
                  </span>
                  {overview.remaining > 0 && (
                    <Button
                      size="small"
                      icon={<ArrowRightOutlined />}
                      loading={continuing}
                      disabled={processing}
                      onClick={() => void next()}
                    >
                      继续阅读下一批
                    </Button>
                  )}
                </div>
              </>
            ) : overview ? (
              <div className="panel-done">
                <Empty
                  image={<InboxOutlined className="panel-done-icon" />}
                  description={
                    <div className="panel-done-copy">
                      <b>
                        {isMailView
                          ? hasCards
                            ? priority === 'focus'
                              ? '暂时没有重点邮件'
                              : '暂时没有其他邮件'
                            : batchFinished
                              ? '这一批读完了'
                              : '暂时没有待处理邮件'
                          : isFocusView
                            ? batchFinished
                              ? '这一批读完了'
                              : '暂时没有重点内容'
                            : batchFinished
                              ? '这一批读完了'
                              : '暂时没有待处理内容'}
                      </b>
                      {isMailView ? (
                        priority === 'focus' && counts.other > 0 ? (
                          <span>还有 {counts.other} 封其他邮件，可以按需查看，也可以直接继续。</span>
                        ) : priority === 'other' && counts.focus > 0 ? (
                          <span>还有 {counts.focus} 封重点邮件等待处理。</span>
                        ) : (
                          <span>{overview.remaining > 0 ? '可以继续阅读下一批，新到邮件也会自动加入。' : '新邮件到达后，会自动出现在这里。'}</span>
                        )
                      ) : isFocusView ? (
                        <span>
                          {overview.remaining > 0
                            ? '可以继续阅读下一批，新内容也会自动加入。'
                            : '各来源的重点内容都会汇总到这里；切换来源可以查看该来源的全部内容。'}
                        </span>
                      ) : (
                        <span>
                          {overview.remaining > 0 ? '可以继续阅读下一批，新内容也会自动加入。' : '新内容到达后，会自动出现在这里。'}
                        </span>
                      )}
                    </div>
                  }
                >
                  <div className="panel-empty-actions">
                    {isMailView && priority === 'focus' && counts.other > 0 && (
                      <Button onClick={() => changePriority('other')}>查看其他邮件 · {counts.other}</Button>
                    )}
                    {isMailView && priority === 'other' && counts.focus > 0 && (
                      <Button onClick={() => changePriority('focus')}>查看重点邮件 · {counts.focus}</Button>
                    )}
                    {overview.remaining > 0 ? (
                      <Button
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        loading={continuing}
                        disabled={processing}
                        onClick={() => void next()}
                      >
                        继续阅读下一批
                      </Button>
                    ) : (
                      <Button icon={<ReloadOutlined />} disabled={processing} onClick={() => void refresh()}>
                        刷新看看
                      </Button>
                    )}
                  </div>
                </Empty>
              </div>
            ) : null}
          </div>
          {overview && (viewPending > 0 || cursors.length > 1) && (
            <nav className="panel-stream-foot" aria-label="待读内容分页">
              <span>第 {cursors.length} 页 · 本页 {cards.length} 条 · 共 {viewPending} 条待处理（每页 {PANEL_PAGE_SIZE} 条）</span>
              <div>
                <Button size="small" disabled={cursors.length === 1 || processing} onClick={() => movePage(false)}>较新内容</Button>
                <Button size="small" disabled={overview.nextBeforeInfoId == null || processing} onClick={() => movePage(true)}>较早内容</Button>
                {cursors.length > 1 && <Button size="small" disabled={processing} onClick={() => {
                  setCursors([undefined])
                  session.selectView(sourceKey, isMailView ? priority : undefined, undefined, mailDateRange)
                }}>回到最新</Button>}
              </div>
            </nav>
          )}
        </main>

        {overview && isMailView && (
          <aside className="panel-rail" aria-label="邮件偏好、关心雷达与关键词画像">
            <ConcernRail
              overview={overview}
              onAdjust={() => navigate('/settings')}
              sensitivity={feedbackSensitivity.radar}
              onSensitivity={(next) => changeFeedbackSensitivity('radar', next)}
            />
            <KeywordProfile
              items={overview.keywordProfile}
              action={<FeedbackSensitivityMenu kind="keyword" value={feedbackSensitivity.keyword} onChange={(next) => changeFeedbackSensitivity('keyword', next)} persist showLabel />}
            />
            <section className="panel-rail-card">
              <div className="panel-rail-head">
                <span>偏好</span>
                <span className="panel-rail-note">{activeLabel}</span>
              </div>
              <SignalChips overview={overview} />
            </section>
          </aside>
        )}
      </div>
      </>}
    </div>
  )
})

export const panelModule: ModuleManifest = {
  id: 'panel',
  group: 'work',
  title: '面板',
  icon: <ThunderboltOutlined />,
  route: '/panel',
  enabled: true,
  page: () => <PanelPage />
}
