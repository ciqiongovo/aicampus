import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  FileAddOutlined,
  PaperClipOutlined,
  PlusOutlined,
  RobotOutlined,
  RollbackOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined
} from '@ant-design/icons'
import type { CounterRecItem } from '@shared/types'
import type {
  AgentRun,
  ChatAttachment,
  Conversation,
  ResourceReference,
  WorkspaceMessage
} from '@shared/workspace'
import { goToAiSettings, returnFromAi, takeAiHandoff } from '../aiNavigation'
import type { ModuleManifest } from './types'
import { LiveRun } from './jarvis/live-run'
import { MessageRow } from './jarvis/message'
import { ResourceDrawer } from './jarvis/resource-drawer'
import type { ResourceViewerState } from './jarvis/resource-drawer'
import './jarvis.css'

const { TextArea } = Input
const { Text } = Typography

const ACTIVE_CONVERSATION_KEY = 'infoagent.activeConversation'
const HANDOFF_EVENT = 'infoagent:ai-handoff'

function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

const QUICK_PROMPTS = [
  '帮我梳理一下最近的待办和截止时间',
  '检索信息流里待核实的内容',
  '今天的日报讲了什么？',
  '记住：我更喜欢在早上处理需要专注的事'
]

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  search: string
  onSearch: (value: string) => void
  onCreate: () => void
  onSelect: (id: string) => void
  onRename: (c: Conversation) => void
  onDelete: (c: Conversation) => void
}

function ConversationSidebar({ conversations, activeId, search, onSearch, onCreate, onSelect, onRename, onDelete }: SidebarProps) {
  return (
    <div className="jarvis-sidebar">
      <div className="jarvis-sidebar-head">
        <Text className="jarvis-sidebar-title">会话</Text>
        <Tooltip title="新建会话">
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={onCreate} className="jarvis-icon-button" />
        </Tooltip>
      </div>
      <Input
        allowClear
        size="small"
        prefix={<SearchOutlined />}
        placeholder="搜索会话"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        className="jarvis-sidebar-search"
      />
      <div className="jarvis-sidebar-list">
        {conversations.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={'jarvis-conv' + (c.id === activeId ? ' is-active' : '')}
            onClick={() => onSelect(c.id)}
          >
            <div className="jarvis-conv-main">
              <div className="jarvis-conv-title">{c.title}</div>
              <div className="jarvis-conv-time">{fmtTime(c.updatedAt)}</div>
            </div>
            <Button
              type="text"
              size="small"
              className="jarvis-conv-rename"
              onClick={(e) => { e.stopPropagation(); onRename(c) }}
            >
              重命名
            </Button>
            <Button className="jarvis-conv-delete" type="text" size="small" danger onClick={(e) => { e.stopPropagation(); onDelete(c) }}>删除</Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function JarvisPage() {
  const { message, modal } = AntApp.useApp()
  const location = useLocation()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<WorkspaceMessage[]>([])
  const [runsById, setRunsById] = useState<Record<string, AgentRun>>({})
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [sending, setSending] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [references, setReferences] = useState<ResourceReference[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [choosingAttachment, setChoosingAttachment] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [counter, setCounter] = useState<CounterRecItem | null>(null)
  const [counterActing, setCounterActing] = useState(false)
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null)
  const [hasReturn, setHasReturn] = useState(false)
  const [resourceViewer, setResourceViewer] = useState<ResourceViewerState | null>(null)
  const [resourceLoading, setResourceLoading] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const pollTimerRef = useRef<number | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const searchRef = useRef('')

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const loadConversations = useCallback(async (keyword: string) => {
    try {
      setConversations(await window.api.conversationsList(keyword))
    } catch {
      /* 忽略 */
    }
  }, [])

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await window.api.conversationGet(id)
      if (activeIdRef.current !== id) return
      setMessages(d.messages)
      const map: Record<string, AgentRun> = {}
      for (const r of d.runs) map[r.id] = r
      setRunsById(map)
    } catch {
      /* 忽略 */
    }
  }, [])

  const pollRun = useCallback((runId: string, conversationId: string) => {
    stopPolling()
    const tick = async () => {
      if (activeIdRef.current !== conversationId) { stopPolling(); return }
      try {
        const run = await window.api.agentRunGet(runId)
        if (activeIdRef.current !== conversationId) { stopPolling(); return }
        setActiveRun(run)
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          stopPolling()
          setActiveRun(null)
          void refreshDetail(conversationId)
          void loadConversations(searchRef.current)
        }
      } catch {
        if (activeIdRef.current !== conversationId) return
        stopPolling()
        setActiveRun(null)
        void refreshDetail(conversationId)
      }
    }
    void tick()
    pollTimerRef.current = window.setInterval(tick, 1200)
  }, [stopPolling, refreshDetail, loadConversations])

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true)
    try {
      const d = await window.api.conversationGet(id)
      if (activeIdRef.current !== id) return
      setMessages(d.messages)
      const map: Record<string, AgentRun> = {}
      for (const r of d.runs) map[r.id] = r
      setRunsById(map)
      const active = d.runs.find((r) => r.status === 'running' || r.status === 'waiting_confirmation')
      if (active) {
        setActiveRun(active)
        pollRun(active.id, id)
      } else {
        setActiveRun(null)
        stopPolling()
      }
    } catch (e) {
      message.error('加载会话失败：' + errText(e))
    } finally {
      setLoadingDetail(false)
    }
  }, [pollRun, stopPolling, message])

  const selectConversation = useCallback((id: string) => {
    setActiveId(id)
    activeIdRef.current = id
    sessionStorage.setItem(ACTIVE_CONVERSATION_KEY, id)
    setInput('')
    setPendingAttachments([])
    void loadDetail(id)
  }, [loadDetail])

  const refreshConversationsAndDetail = useCallback(async () => {
    try {
      const list = await window.api.conversationsList(searchRef.current)
      setConversations(list)
      let target = activeIdRef.current
      if (!target || !list.some((c) => c.id === target)) {
        const saved = sessionStorage.getItem(ACTIVE_CONVERSATION_KEY)
        target = (saved && list.some((c) => c.id === saved)) ? saved : (list[0]?.id ?? null)
        if (target) {
          activeIdRef.current = target
          setActiveId(target)
          sessionStorage.setItem(ACTIVE_CONVERSATION_KEY, target)
        }
      }
      if (target) {
        await loadDetail(target)
      } else {
        setActiveId(null)
        setMessages([])
        setRunsById({})
        setActiveRun(null)
        stopPolling()
      }
    } catch (e) {
      message.error('加载会话失败：' + errText(e))
    }
  }, [loadDetail, stopPolling, message])

  // 一次性：反推荐、AI 配置、handoff 事件监听
  useEffect(() => {
    const onHandoff = () => {
      const ref = takeAiHandoff()
      if (ref) {
        setHasReturn(true)
        setReferences((prev) => (prev.some((r) => r.kind === ref.kind && r.id === ref.id) ? prev : [...prev, ref]))
      }
    }
    window.addEventListener(HANDOFF_EVENT, onHandoff)
    void (async () => {
      try { setCounter(await window.api.counterToday()) } catch { /* 忽略 */ }
      try {
        const s = await window.api.settingsGet()
        setAiConfigured(s.aiConfigured)
      } catch { setAiConfigured(false) }
    })()
    return () => window.removeEventListener(HANDOFF_EVENT, onHandoff)
  }, [])

  // 路由感知：进入 /jarvis 时读取 handoff、刷新会话历史与详情（keepalive 不卸载）
  useEffect(() => {
    if (location.pathname !== '/jarvis') return
    const ref = takeAiHandoff()
    if (ref) {
      setHasReturn(true)
      setReferences((prev) => (prev.some((r) => r.kind === ref.kind && r.id === ref.id) ? prev : [...prev, ref]))
    }
    void refreshConversationsAndDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const refreshCounter = useCallback(async () => {
    try { setCounter(await window.api.counterToday()) } catch { /* 忽略 */ }
  }, [])

  const actCounter = useCallback(async (action: 'go' | 'ignore') => {
    if (!counter || counterActing) return
    setCounterActing(true)
    try {
      const res = await window.api.counterAct(counter.id, action)
      if (res.ok) message.success(res.message)
      else message.warning(res.message)
      setCounter(res.item ?? null)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setCounterActing(false)
    }
  }, [counter, counterActing, message])

  const createConversation = useCallback(async () => {
    try {
      const c = await window.api.conversationCreate()
      setConversations((prev) => [c, ...prev.filter((x) => x.id !== c.id)])
      selectConversation(c.id)
    } catch (e) {
      message.error('新建会话失败：' + errText(e))
    }
  }, [selectConversation, message])

  const doRename = useCallback(async () => {
    if (!renameTarget) return
    setRenaming(true)
    try {
      const c = await window.api.conversationRename(renameTarget.id, renameTitle)
      setConversations((prev) => prev.map((x) => (x.id === c.id ? c : x)))
      setRenameTarget(null)
    } catch (e) {
      message.error('重命名失败：' + errText(e))
    } finally {
      setRenaming(false)
    }
  }, [renameTarget, renameTitle, message])

  const send = useCallback(async (text?: string) => {
    const fromTextarea = text === undefined
    const content = (text ?? input).trim()
    const readyAttachments = pendingAttachments.filter((a) => a.status === 'ready')
    if (sending) return
    // 内容与就绪附件都为空时不发送
    if (!content && readyAttachments.length === 0) return
    if (content === '去' && counter?.status === 'pending') {
      setInput('')
      void actCounter('go')
      return
    }
    if (!activeId) {
      message.info('请先新建或选择一个会话')
      return
    }
    const draft = input
    setSending(true)
    try {
      const run = await window.api.agentSend({
        conversationId: activeId,
        content,
        references,
        attachmentIds: readyAttachments.map((a) => a.id),
        requestId: crypto.randomUUID()
      })
      // 成功后清空草稿；若发送期间用户已输入新内容则不覆盖
      if (fromTextarea) setInput((cur) => (cur === draft ? '' : cur))
      setReferences([])
      setPendingAttachments([])
      setActiveRun(run)
      pollRun(run.id, activeId)
      void refreshDetail(activeId)
    } catch (e) {
      message.error('发送失败：' + errText(e))
    } finally {
      setSending(false)
      void refreshCounter()
    }
  }, [input, sending, counter, activeId, references, pendingAttachments, actCounter, pollRun, refreshDetail, refreshCounter, message])

  const decide = useCallback(async (stepId: string, approved: boolean) => {
    if (!activeRun) return
    setDeciding(true)
    try {
      const run = await window.api.agentDecide(activeRun.id, stepId, approved)
      setActiveRun(run)
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        stopPolling()
        setActiveRun(null)
        void refreshDetail(activeRun.conversationId)
        void loadConversations(searchRef.current)
      } else {
        pollRun(run.id, activeRun.conversationId)
      }
    } catch (e) {
      message.error('处理确认失败：' + errText(e))
    } finally {
      setDeciding(false)
    }
  }, [activeRun, stopPolling, refreshDetail, loadConversations, pollRun, message])

  const stopRun = useCallback(async () => {
    if (!activeRun) return
    try {
      const run = await window.api.agentStop(activeRun.id)
      setActiveRun(run)
      stopPolling()
      setActiveRun(null)
      message.info('任务已停止；已提交的写入操作不会回滚。')
      void refreshDetail(activeRun.conversationId)
      void loadConversations(searchRef.current)
    } catch (e) {
      message.error('停止失败：' + errText(e))
    }
  }, [activeRun, stopPolling, refreshDetail, loadConversations, message])

  const chooseAttachment = useCallback(async () => {
    if (!activeId) { message.info('请先选择一个会话'); return }
    setChoosingAttachment(true)
    try {
      const res = await window.api.agentAttachmentChoose(activeId)
      // 无论整体 ok 与否都合并返回附件：解析失败的仍展示（标记失败、不参与发送）
      const byId = new Map<string, ChatAttachment>()
      for (const a of pendingAttachments) byId.set(a.id, a)
      for (const a of res.attachments) byId.set(a.id, a)
      setPendingAttachments(Array.from(byId.values()))
      if (res.ok) {
        if (res.attachments.some((a) => a.status === 'failed')) {
          message.warning('部分附件解析失败，仅发送解析就绪的文件')
        }
      } else {
        message.warning(res.message || '选择附件失败')
      }
    } catch (e) {
      message.error('添加附件失败：' + errText(e))
    } finally {
      setChoosingAttachment(false)
    }
  }, [activeId, pendingAttachments, message])

  const removeReference = useCallback((ref: ResourceReference) => {
    setReferences((prev) => prev.filter((r) => !(r.kind === ref.kind && r.id === ref.id)))
  }, [])

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const openResource = useCallback(async (ref: ResourceReference) => {
    setResourceLoading(true)
    try {
      const detail = await window.api.agentResourceGet(ref)
      setResourceViewer({ ref, detail })
    } catch (e) {
      message.error('读取资源失败：' + errText(e))
    } finally {
      setResourceLoading(false)
    }
  }, [message])

  const loadMoreResource = useCallback(async () => {
    if (!resourceViewer) return
    setResourceLoading(true)
    try {
      const next = await window.api.agentResourceGet(resourceViewer.ref, resourceViewer.detail.offset + resourceViewer.detail.content.length)
      setResourceViewer((v) => v ? {
        ref: v.ref,
        detail: { ...next, content: v.detail.content + next.content, offset: v.detail.offset }
      } : v)
    } catch (e) {
      message.error('继续读取失败：' + errText(e))
    } finally {
      setResourceLoading(false)
    }
  }, [resourceViewer, message])

  const onSearch = useCallback((value: string) => {
    setSearch(value)
    searchRef.current = value
    void loadConversations(value)
  }, [loadConversations])

  const terminalRuns = useMemo(() => {
    const map: Record<string, AgentRun> = {}
    for (const r of Object.values(runsById)) {
      if (r.status !== 'running' && r.status !== 'waiting_confirmation') map[r.id] = r
    }
    return map
  }, [runsById])

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, activeRun, sending])

  return (
    <div className="jarvis-page">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        search={search}
        onSearch={onSearch}
        onCreate={createConversation}
        onSelect={selectConversation}
        onDelete={(c) => modal.confirm({
          title: '删除会话？',
          content: `将永久删除“${c.title}”及其消息、附件和执行记录。`,
          okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
          onOk: async () => {
            try {
              await window.api.conversationDelete(c.id)
              if (activeIdRef.current === c.id) {
                stopPolling()
                activeIdRef.current = null
                sessionStorage.removeItem(ACTIVE_CONVERSATION_KEY)
                setActiveId(null); setMessages([]); setRunsById({}); setActiveRun(null)
                setInput(''); setPendingAttachments([]); setReferences([]); setResourceViewer(null)
              }
              await refreshConversationsAndDetail()
              message.success('会话已删除')
            } catch (e) { message.error('删除失败：' + errText(e)); throw e }
          }
        })}
        onRename={(c) => { setRenameTarget(c); setRenameTitle(c.title) }}
      />
      <div className="jarvis-main">
        <div className="jarvis-head">
          <div className="jarvis-head-main">
            <Avatar size={28} shape="square" icon={<RobotOutlined />} className="jarvis-avatar" />
            <div className="jarvis-head-text">
              <div className="jarvis-title">{activeConversation?.title ?? 'JARVIS'}</div>
              <div className="jarvis-sub">应用内 Agent · 对话、工具执行、可追溯</div>
            </div>
          </div>
          <div className="jarvis-head-actions">
            {aiConfigured === false && <span className="jarvis-flag">AI 未配置</span>}
            {hasReturn && (
              <Button
                size="small"
                type="text"
                icon={<RollbackOutlined />}
                onClick={() => { setHasReturn(false); returnFromAi() }}
              >
                返回原业务页
              </Button>
            )}
            <Button size="small" type="text" icon={<SettingOutlined />} onClick={() => goToAiSettings()}>
              AI 设置
            </Button>
          </div>
        </div>

        {aiConfigured === false && (
          <Alert
            className="jarvis-ai-alert"
            type="warning"
            showIcon
            message="AI 尚未配置或授权"
            description="请到「设置 → AI 配置」完成配置与授权，再回到这里对话。"
          />
        )}

        <div className="jarvis-list" ref={listRef}>
          <div className="jarvis-thread">
            {counter && counter.status === 'pending' && (
              <div className="jarvis-counter">
                <div className="jarvis-counter-head">
                  <span className="jarvis-counter-label">今日反推荐</span>
                  <span className="jarvis-counter-src">来源：{counter.sourceLabel}</span>
                </div>
                <div className="jarvis-counter-title">{counter.title}</div>
                <div className="jarvis-counter-reason">{counter.reason}</div>
                <Space size={8} className="jarvis-counter-actions">
                  <Button size="small" type="primary" loading={counterActing} onClick={() => void actCounter('go')}>
                    去——转成事项
                  </Button>
                  <Button size="small" disabled={counterActing} onClick={() => void actCounter('ignore')}>
                    忽略
                  </Button>
                </Space>
              </div>
            )}
            {counter && counter.status !== 'pending' && (
              <Alert
                className="jarvis-notice"
                type={counter.status === 'done' ? 'success' : 'info'}
                showIcon
                message={counter.status === 'done' ? '今日反推荐已转成事项，可到「信息面板」查看' : '今日反推荐已忽略'}
              />
            )}
            {loadingDetail && messages.length === 0 ? (
              <div className="jarvis-center"><Spin /></div>
            ) : messages.length === 0 && !activeRun ? (
              <div className="jarvis-welcome">
                <div className="jarvis-welcome-kicker">AI 工作台</div>
                <div className="jarvis-welcome-title">你好，我是 JARVIS</div>
                <div className="jarvis-welcome-text">
                  我可以检索你的邮件、事项、信息流与日报，连续使用工具完成任务，并在需要高影响操作时先征得你的确认。
                </div>
                <div className="jarvis-quick">
                  {QUICK_PROMPTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="jarvis-quick-item"
                      disabled={sending}
                      onClick={() => void send(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                msg={m}
                run={terminalRuns[m.runId ?? '']}
                onOpenResource={(r) => void openResource(r)}
              />
            ))}
            {activeRun && (
              <LiveRun
                run={activeRun}
                deciding={deciding}
                onDecide={(sid, ok) => void decide(sid, ok)}
                onStop={() => void stopRun()}
              />
            )}
            {sending && !activeRun && (
              <div className="jarvis-typing" role="status" aria-label="正在发送">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </div>

        <div className="jarvis-compose">
          {(references.length > 0 || pendingAttachments.length > 0) && (
            <div className="jarvis-compose-tags">
              {references.map((r) => (
                <Tag key={r.kind + ':' + r.id} closable onClose={() => removeReference(r)} className="jarvis-chip">
                  引用：{r.title || (r.kind + '#' + r.id)}
                </Tag>
              ))}
              {pendingAttachments.map((a) => (
                <Tag
                  key={a.id}
                  closable
                  onClose={() => removePendingAttachment(a.id)}
                  icon={<PaperClipOutlined />}
                  className={a.status === 'failed' ? 'jarvis-chip is-failed' : 'jarvis-chip'}
                >
                  {a.name}{a.status === 'failed' ? '（解析失败）' : ''}
                </Tag>
              ))}
            </div>
          )}
          <div className="jarvis-input">
            <Button
              className="jarvis-attach-button"
              icon={<FileAddOutlined />}
              loading={choosingAttachment}
              onClick={() => void chooseAttachment()}
            >
              附件
            </Button>
            <TextArea
              className="jarvis-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="和 JARVIS 说点什么…"
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
            <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={() => void send()}>
              发送
            </Button>
          </div>
          <div className="jarvis-compose-hint">Enter / Ctrl+Enter 发送 · Shift+Enter 换行</div>
        </div>
      </div>

      <ResourceDrawer
        viewer={resourceViewer}
        loading={resourceLoading}
        onClose={() => setResourceViewer(null)}
        onLoadMore={() => void loadMoreResource()}
      />

      <Modal
        className="jarvis-rename-modal"
        title="重命名会话"
        open={renameTarget !== null}
        okText="保存"
        cancelText="取消"
        confirmLoading={renaming}
        onOk={() => void doRename()}
        onCancel={() => setRenameTarget(null)}
      >
        <Input
          value={renameTitle}
          onChange={(e) => setRenameTitle(e.target.value)}
          onPressEnter={() => void doRename()}
          placeholder="会话名称"
          maxLength={120}
        />
      </Modal>
    </div>
  )
}

export const jarvisModule: ModuleManifest = {
  id: 'jarvis',
  title: 'JARVIS',
  icon: <RobotOutlined />,
  route: '/jarvis',
  enabled: true,
  page: () => <JarvisPage />
}
