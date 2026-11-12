import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, DatePicker, Drawer, Empty, Input, Modal, Space, Spin, Switch, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { ImportOutlined, MessageOutlined, ReloadOutlined, SearchOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type {
  ImDigestResult,
  ImDoctorReport,
  ImInsightInfo,
  ImMessageInfo,
  ImQqSource,
  ImSearchResult,
  ImSessionInfo
} from '../../../shared/im'
import './chat.css'

const KIND_LABEL: Record<string, string> = { peer: '私聊', group: '群聊', official: '公众号' }
const PLATFORM_LABEL: Record<string, string> = { wechat: '微信', qq: 'QQ' }
const INSIGHT_LABEL: Record<string, string> = {
  topic: '主题',
  decision: '决定',
  todo: '待办',
  fact: '事实',
  link: '链接',
  question: '待确认'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortWhen(value: string | null): string {
  if (!value) return '—'
  const date = dayjs(value)
  return date.isValid() ? date.format('MM-DD HH:mm') : value
}

export function ChatPane(): JSX.Element {
  const navigate = useNavigate()
  const [doctor, setDoctor] = useState<ImDoctorReport | null>(null)
  const [sessions, setSessions] = useState<ImSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null)

  const [activeSession, setActiveSession] = useState<ImSessionInfo | null>(null)
  const [messages, setMessages] = useState<ImMessageInfo[]>([])
  const [messageTotal, setMessageTotal] = useState(0)
  const [messageLoading, setMessageLoading] = useState(false)

  const [digestDay, setDigestDay] = useState<Dayjs>(dayjs())
  const [digest, setDigest] = useState<ImDigestResult | null>(null)

  const [keyword, setKeyword] = useState('')
  const [search, setSearch] = useState<ImSearchResult | null>(null)

  const [syncOpen, setSyncOpen] = useState(false)
  const [syncBase, setSyncBase] = useState('http://127.0.0.1:5030')
  const [syncToken, setSyncToken] = useState('')

  const [insights, setInsights] = useState<ImInsightInfo[]>([])
  const [qqSources, setQqSources] = useState<ImQqSource[]>([])
  const [qqSelected, setQqSelected] = useState<number[]>([])
  const [qqSaving, setQqSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [report, list, sources] = await Promise.all([
        window.api.imDoctor(),
        window.api.imSessions(),
        window.api.imQqSources()
      ])
      setDoctor(report)
      setSessions(list)
      setQqSources(sources)
      setQqSelected(sources.filter((item) => item.selected).map((item) => item.sessionId))
    } catch (error) {
      setNotice({ type: 'error', text: '读取聊天记录状态失败：' + errorText(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadMessages = useCallback(async (session: ImSessionInfo, beforeSeq?: number) => {
    setMessageLoading(true)
    try {
      const page = await window.api.imMessages(session.id, beforeSeq, 50)
      setMessageTotal(page.total)
      setMessages((prev) => (beforeSeq ? [...page.items, ...prev] : page.items))
    } catch (error) {
      setNotice({ type: 'error', text: '读取消息失败：' + errorText(error) })
    } finally {
      setMessageLoading(false)
    }
  }, [])

  const openSession = async (session: ImSessionInfo): Promise<void> => {
    setActiveSession(session)
    setMessages([])
    setInsights([])
    await loadMessages(session)
    try {
      setInsights(await window.api.imInsights({ sessionId: session.id, status: 'new' }))
    } catch {
      setInsights([])
    }
  }

  const toggleSession = async (session: ImSessionInfo, enabled: boolean): Promise<void> => {
    try {
      await window.api.imSessionToggle(session.id, enabled)
      setSessions((prev) => prev.map((item) => (item.id === session.id ? { ...item, enabled } : item)))
    } catch (error) {
      setNotice({ type: 'error', text: '切换失败：' + errorText(error) })
    }
  }

  const saveQqSources = async (): Promise<void> => {
    setQqSaving(true)
    try {
      const saved = await window.api.imQqSourcesSet(qqSelected)
      setQqSelected(saved)
      setQqSources((prev) => prev.map((item) => ({ ...item, selected: saved.includes(item.sessionId) })))
      setNotice({ type: 'success', text: `已保存 ${saved.length} 个群作为 AI 信息来源` })
    } catch (error) {
      setNotice({ type: 'error', text: '保存失败：' + errorText(error) })
    } finally {
      setQqSaving(false)
    }
  }

  const importQq = async (): Promise<void> => {
    setBusy('import')
    try {
      const files = await window.api.imPickImportFiles()
      if (files.length === 0) return
      const result = await window.api.imImportFile(files, { enable: true })
      setNotice({
        type: result.errors.length > 0 ? 'warning' : 'success',
        text: `导入完成：新增 ${result.inserted} 条、更新 ${result.updated} 条、会话 ${result.sessions} 个${result.errors.length > 0 ? '；' + result.errors[0] : ''}`
      })
      await load()
    } catch (error) {
      setNotice({ type: 'error', text: '导入失败：' + errorText(error) })
    } finally {
      setBusy('')
    }
  }

  const syncWechat = async (): Promise<void> => {
    setBusy('sync')
    try {
      const result = await window.api.imSync({ baseUrl: syncBase, token: syncToken || undefined, enableNew: true })
      setNotice({ type: result.ok ? 'success' : 'warning', text: result.message })
      if (result.ok) {
        setSyncOpen(false)
        await load()
      }
    } catch (error) {
      setNotice({ type: 'error', text: '同步失败：' + errorText(error) })
    } finally {
      setBusy('')
    }
  }

  const understand = async (session: ImSessionInfo): Promise<void> => {
    setBusy('understand-' + session.id)
    try {
      const result = await window.api.imUnderstand(session.id, {})
      setNotice({ type: result.ok ? 'success' : 'warning', text: result.message })
      await load()
      if (activeSession?.id === session.id) {
        setInsights(await window.api.imInsights({ sessionId: session.id, status: 'new' }))
      }
    } catch (error) {
      setNotice({ type: 'error', text: '理解失败：' + errorText(error) })
    } finally {
      setBusy('')
    }
  }

  const runDigest = useCallback(async (day: Dayjs) => {
    try {
      setDigest(await window.api.imDigest(day.format('YYYY-MM-DD')))
    } catch (error) {
      setNotice({ type: 'error', text: '生成摘要失败：' + errorText(error) })
    }
  }, [])

  useEffect(() => {
    void runDigest(digestDay)
  }, [digestDay, runDigest])

  const runSearch = async (): Promise<void> => {
    if (!keyword.trim()) {
      setSearch(null)
      return
    }
    try {
      setSearch(await window.api.imSearch(keyword.trim()))
    } catch (error) {
      setNotice({ type: 'error', text: '搜索失败：' + errorText(error) })
    }
  }

  const columns = useMemo<ColumnsType<ImSessionInfo>>(
    () => [
      {
        title: '平台',
        dataIndex: 'platform',
        width: 70,
        render: (value: string) => <Tag color={value === 'wechat' ? 'green' : 'blue'}>{PLATFORM_LABEL[value] ?? value}</Tag>
      },
      {
        title: '会话',
        dataIndex: 'title',
        render: (value: string, row) => (
          <div className="chat-session-title">
            <span>{value || row.platformSessionId}</span>
            <small>
              {KIND_LABEL[row.kind] ?? row.kind}
              {row.memberCount > 0 ? ` · ${row.memberCount} 人` : ''}
            </small>
          </div>
        )
      },
      { title: '消息', dataIndex: 'messageCount', width: 80 },
      { title: '最近', dataIndex: 'lastMsgAt', width: 110, render: (value: string | null) => shortWhen(value) },
      {
        title: '采集',
        dataIndex: 'enabled',
        width: 80,
        render: (value: boolean, row) => <Switch size="small" checked={value} onChange={(next) => void toggleSession(row, next)} />
      },
      {
        title: '操作',
        width: 190,
        render: (_value, row) => (
          <div className="chat-actions">
            <Button size="small" type="link" icon={<MessageOutlined />} onClick={() => void openSession(row)}>
              查看
            </Button>
            <Button
              size="small"
              type="link"
              icon={<ThunderboltOutlined />}
              loading={busy === 'understand-' + row.id}
              onClick={() => void understand(row)}
            >
              理解
            </Button>
          </div>
        )
      }
    ],
    // understand/toggle 都是稳定闭包内的状态更新，仅依赖 busy 与选中会话
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, activeSession]
  )

  const messageColumn: ColumnsType<ImMessageInfo> = [
    { title: '时间', dataIndex: 'sentAt', width: 110, render: (value: string) => shortWhen(value) },
    {
      title: '发送者',
      dataIndex: 'senderName',
      width: 110,
      render: (value: string, row) => (row.isSelf ? '我' : value || row.senderId || '未知')
    },
    {
      title: '内容',
      dataIndex: 'text',
      render: (value: string, row) => (
        <div className={row.deleted ? 'chat-msg deleted' : 'chat-msg'}>
          {row.quoteText ? <div className="chat-quote">回复：{row.quoteText}</div> : null}
          <span>{value || `[${row.kind}]`}</span>
        </div>
      )
    }
  ]

  const hasSession = sessions.length > 0

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div>
          <h1>聊天记录</h1>
          <p>把微信 / QQ 的聊天读进来，抽主题、决定、待办和链接；数据只存在本机。</p>
        </div>
        <div className="chat-header-actions">
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button icon={<ImportOutlined />} loading={busy === 'import'} onClick={() => void importQq()}>
            导入聊天记录
          </Button>
          <Button type="primary" icon={<SyncOutlined />} onClick={() => setSyncOpen(true)}>
            同步微信
          </Button>
        </div>
      </header>

      <Card
        size="small"
        className="chat-sources"
        title="AI 信息来源（QQ）"
        extra={
          <Space size={8}>
            <Tag color={qqSelected.length > 0 ? 'blue' : 'default'}>已选 {qqSelected.length} 个群</Tag>
            <Button size="small" type="link" onClick={() => navigate('/settings?tab=accounts')}>
              账号管理
            </Button>
          </Space>
        }
      >
        <p className="chat-muted">
          按最近消息数从多到少排列。选中的群会作为日报的信息来源，先清洗、再按时间切窗格式化，最后才交给模型抽取；不会把整段聊天原文直接丢给模型。
        </p>
        <p className="chat-muted">QQ 登录、连接检测与同步已统一到「设置 → 账号管理」。</p>
        <Table
          rowKey="sessionId"
          size="small"
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
          dataSource={qqSources}
          rowSelection={{
            selectedRowKeys: qqSelected,
            onChange: (keys) => setQqSelected(keys.map((key) => Number(key)))
          }}
          columns={[
            {
              title: '群',
              dataIndex: 'title',
              render: (title: string) => <span className="chat-source-title">{title || '未命名群'}</span>
            },
            {
              title: '消息数',
              dataIndex: 'messageCount',
              width: 90,
              sorter: (a: ImQqSource, b: ImQqSource) => a.messageCount - b.messageCount
            },
            {
              title: '最近消息',
              dataIndex: 'lastMessageAt',
              width: 130,
              render: (value: string | null) => shortWhen(value)
            }
          ]}
          locale={{ emptyText: '还没有 QQ 群数据，先到「设置 → 账号管理」完成一次 QQ 同步' }}
        />
        <Space style={{ marginTop: 12 }}>
          <Button
            size="small"
            type="primary"
            loading={qqSaving}
            disabled={qqSources.length === 0}
            onClick={() => void saveQqSources()}
          >
            保存信息来源
          </Button>
          <span className="chat-muted">保存后，日报的「QQ」一栏只会统计这些群当天抽取出的结论。</span>
        </Space>
      </Card>

      {notice ? (
        <Alert
          className="chat-notice"
          type={notice.type}
          message={notice.text}
          closable
          onClose={() => setNotice(null)}
          showIcon
        />
      ) : null}

      {doctor ? (
        <Card size="small" className="chat-doctor" title="环境检查" extra={<Tag color={doctor.ok ? 'green' : 'orange'}>{doctor.ok ? '可用' : '待配置'}</Tag>}>
          <div className="chat-check-grid">
            {doctor.checks.map((check) => (
              <div key={check.name} className="chat-check">
                <Tag color={check.ok ? 'green' : 'default'}>{check.name}</Tag>
                <span>{check.detail}</span>
              </div>
            ))}
          </div>
          {doctor.hints.length > 0 ? (
            <ul className="chat-hints">
              {doctor.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <Spin spinning={loading}>
        <Card size="small" title={hasSession ? `会话（${sessions.length}）` : '会话'}>
          {hasSession ? (
            <Table
              rowKey="id"
              size="small"
              pagination={{ pageSize: 12, hideOnSinglePage: true }}
              columns={columns}
              dataSource={sessions}
            />
          ) : (
            <Empty description="还没有采集到会话。点「导入聊天记录」选 QQ 或微信导出的 txt；也可以在「同步微信」里填自备采集服务的地址。" />
          )}
        </Card>
      </Spin>

      <div className="chat-split">
        <Card
          size="small"
          title="当日摘要"
          extra={<DatePicker value={digestDay} onChange={(value) => value && setDigestDay(value)} allowClear={false} size="small" />}
        >
          {digest ? (
            <div className="chat-digest">
              <div className="chat-digest-counts">
                {Object.entries(digest.counts).map(([kind, count]) => (
                  <Tag key={kind}>{INSIGHT_LABEL[kind] ?? kind} {count}</Tag>
                ))}
              </div>
              <pre>{digest.markdown}</pre>
            </div>
          ) : (
            <Empty description="选择日期查看当天从聊天里抽出的结论" />
          )}
        </Card>

        <Card size="small" title="全文搜索">
          <Input.Search
            value={keyword}
            placeholder="搜聊天内容，如「会议」「deadline」"
            enterButton={<SearchOutlined />}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={() => void runSearch()}
          />
          {search ? (
            <div className="chat-search-result">
              <div className="chat-search-meta">
                <span>命中 {search.total} 条</span>
                <Tag>{search.mode === 'fts' ? 'FTS 索引' : 'LIKE 回退'}</Tag>
              </div>
              {search.items.map((item) => (
                <div key={item.id} className="chat-search-item">
                  <small>{shortWhen(item.sentAt)} · {item.senderName || '未知'}</small>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      <Drawer
        width={620}
        open={Boolean(activeSession)}
        title={activeSession ? `${PLATFORM_LABEL[activeSession.platform] ?? ''} · ${activeSession.title}` : ''}
        onClose={() => setActiveSession(null)}
      >
        {activeSession ? (
          <>
            <div className="chat-drawer-actions">
              <Button size="small" loading={busy === 'understand-' + activeSession.id} onClick={() => void understand(activeSession)} icon={<ThunderboltOutlined />}>
                理解未处理部分
              </Button>
              <span className="chat-muted">共 {messageTotal} 条，已理解到 #{activeSession.summarySeq}</span>
            </div>
            {insights.length > 0 ? (
              <div className="chat-insights">
                {insights.map((item) => (
                  <div key={item.id} className="chat-insight">
                    <Tag>{INSIGHT_LABEL[item.kind] ?? item.kind}</Tag>
                    <span>{item.title}</span>
                    {item.dueAt ? <small>截止 {item.dueAt}</small> : null}
                  </div>
                ))}
              </div>
            ) : null}
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              columns={messageColumn}
              dataSource={messages}
              loading={messageLoading}
            />
            {messages.length < messageTotal ? (
              <div className="chat-load-more">
                <Button
                  size="small"
                  loading={messageLoading}
                  onClick={() => {
                    const first = messages[0]
                    if (first) void loadMessages(activeSession, first.seq)
                  }}
                >
                  加载更早
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <Modal
        title="同步微信（自备本地采集服务）"
        open={syncOpen}
        onCancel={() => setSyncOpen(false)}
        onOk={() => void syncWechat()}
        okText="开始同步"
        confirmLoading={busy === 'sync'}
      >
        <p className="chat-muted">
          填本机自备采集服务的地址与令牌即可拉取微信消息（需兼容 chatlog HTTP 接口）。没有该服务时，用「导入聊天记录」导入微信导出的 txt。
        </p>
        <Input addonBefore="地址" value={syncBase} onChange={(event) => setSyncBase(event.target.value)} />
        <Input
          addonBefore="令牌"
          className="chat-token"
          value={syncToken}
          placeholder="chatlog 的 access token（可留空）"
          onChange={(event) => setSyncToken(event.target.value)}
        />
      </Modal>
    </div>
  )
}
