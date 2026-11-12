import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '../theme'
import { CustomMailTagBadges } from './mail/tagControls'
import type { TagMatchMode } from './mail/tagControls'
import { MailSearchToolbar } from './mail/searchToolbar'
import type { MailFilters } from './mail/searchToolbar'
import {
  App as AntApp,
  Button,
  Empty,
  Pagination,
  Skeleton,
  Space,
  Switch,
  Table,
  Tooltip
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AimOutlined,
  ArrowLeftOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  MailOutlined,
  PaperClipOutlined,
  RobotOutlined,
  StarFilled,
  StarOutlined,
  SyncOutlined
} from '@ant-design/icons'
import type {
  AccountInfo,
  AccountSyncStatus,
  MailAccountNode,
  MailDetail,
  MailListItem
} from '@shared/types'
import type { ModuleManifest } from './types'
import { handoffToAi } from '../aiNavigation'

const PAGE_SIZE_OPTIONS = ['20', '50', '100']
const STATUS_POLL_MS = 5000
const AUTO_SYNC_MS = 5 * 60 * 1000

const ANALYSIS_STATUS_TEXT: Record<string, string> = {
  pending: '待分析',
  analyzed: '已分析',
  failed: '分析失败',
  skipped: '已跳过'
}

const FOLDER_LABELS: Record<string, string> = {
  INBOX: '收件箱',
  Sent: '已发送',
  'Sent Messages': '已发送',
  'Sent Items': '已发送',
  Drafts: '草稿箱',
  Trash: '废件箱',
  'Deleted Messages': '废件箱',
  Junk: '垃圾邮件',
  Spam: '垃圾邮件'
}

const EMPTY_FILTERS: MailFilters = { unreadOnly: false, hasAttachment: false, starredOnly: false }

function folderLabel(folder: string): string {
  return FOLDER_LABELS[folder] ?? FOLDER_LABELS[folder.toLowerCase()] ?? folder
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '—'
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / 1024 / 1024).toFixed(2) + ' MB'
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 列表里的紧凑时间：今天只显示时分，今年省略年份（贴近邮件客户端习惯） */
function formatListTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value
  const pad = (num: number): string => String(num).padStart(2, '0')
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return pad(date.getHours()) + ':' + pad(date.getMinutes())
  if (date.getFullYear() === now.getFullYear()) {
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/** 从 "张三 <a@b.com>" 里取出显示名，没有显示名就退回原地址 */
function fromDisplay(value: string): string {
  const text = (value ?? '').trim()
  const left = text.indexOf('<')
  if (left > 0) {
    const name = text.slice(0, left).trim().replace(/^"(.*)"$/, '$1').trim()
    if (name) return name
    return text.slice(left + 1).replace(/>$/, '').trim()
  }
  return text
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 构造邮件正文 iframe 的 srcdoc：正文经主进程清洗后在此再包一层展示样式；
 * evidence 非空时用 DOMParser 遍历文本节点，把证据原句包进 mark.mail-ev（data-ev=下标），
 * 供「在正文中定位」滚动定位。解析失败时退回原文，不阻塞阅读。
 */
function buildSrcDoc(html: string, text = '', evidence: string[] = [], dark = false): string {
  const content = html || '<pre>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>'
  const terms = evidence.map((t) => t.trim()).filter((t) => t.length >= 2)
  let bodyHtml = content
  if (terms.length > 0) {
    try {
      const doc = new DOMParser().parseFromString('<html><body>' + content + '</body></html>', 'text/html')
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
      const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi')
      for (const node of textNodes) {
        const parentTag = node.parentElement?.tagName ?? ''
        if (/^(STYLE|SCRIPT|MARK)$/i.test(parentTag)) continue
        re.lastIndex = 0
        if (!re.test(node.data)) continue
        re.lastIndex = 0
        const frag = doc.createDocumentFragment()
        let last = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(node.data)) !== null) {
          const matched = m[0]
          if (matched.length === 0) { re.lastIndex++; continue }
          if (m.index > last) frag.appendChild(doc.createTextNode(node.data.slice(last, m.index)))
          const mark = doc.createElement('mark')
          mark.className = 'mail-ev'
          const termIdx = terms.findIndex((t) => t.toLowerCase() === matched.toLowerCase())
          mark.setAttribute('data-ev', String(termIdx >= 0 ? termIdx : 0))
          mark.textContent = matched
          frag.appendChild(mark)
          last = m.index + matched.length
        }
        if (last < node.data.length) frag.appendChild(doc.createTextNode(node.data.slice(last)))
        node.parentNode?.replaceChild(frag, node)
      }
      bodyHtml = doc.body.innerHTML
    } catch {
      bodyHtml = content
    }
  }
  const head =
    '<meta charset="utf-8" />' +
    '<base target="_blank" />' +
    '<style>' +
    `html,body{margin:0;padding:0;}body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;` +
    `font-size:14px;line-height:1.7;color:${dark ? '#F2F2F2' : '#222'};background:${dark ? '#1B1B1B' : '#FFFFFF'};` +
    `padding:2px 4px 12px;word-break:break-word;}` +
    `img{max-width:100%;height:auto;}table{max-width:100%;}a{color:${dark ? '#8FB3FF' : '#1677ff'};}` +
    `blockquote{border-left:3px solid ${dark ? '#444444' : '#e5e5e5'};margin:8px 0;padding:0 0 0 10px;` +
    `color:${dark ? '#BDBDBD' : '#555'};}` +
    'pre{white-space:pre-wrap;word-break:break-word;}' +
    'mark.mail-ev{background:#ffe58f;color:#222;padding:0 1px;border-radius:2px;}' +
    'mark.mail-ev-active{background:#ffa940;outline:2px solid #d46b08;}' +
    '</style>'
  return '<!DOCTYPE html><html lang="zh-CN"><head>' + head + '</head><body>' + bodyHtml + '</body></html>'
}

function MailPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { resolved: themeMode } = useTheme()
  const darkBody = themeMode === 'dark'
  const navigate = useNavigate()
  const location = useLocation()

  const [accounts, setAccounts] = useState<AccountInfo[]>([])
  const [nodes, setNodes] = useState<MailAccountNode[]>([])
  const [statuses, setStatuses] = useState<AccountSyncStatus[]>([])

  const [scopeAccountId, setScopeAccountId] = useState<number | undefined>(undefined)
  const [scopeFolder, setScopeFolder] = useState<string | undefined>(undefined)

  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [filters, setFilters] = useState<MailFilters>(EMPTY_FILTERS)
  const [tagMatch, setTagMatch] = useState<TagMatchMode>('any')
  const [tagIds, setTagIds] = useState<number[]>([])

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(Number(PAGE_SIZE_OPTIONS[0]))
  const [list, setList] = useState<{ total: number; items: MailListItem[] } | null>(null)
  const [loading, setLoading] = useState(false)

  const [fetching, setFetching] = useState(false)
  const [reloading, setReloading] = useState(false)

  const [detailId, setDetailId] = useState<number | null>(null)
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [reanalyzing, setReanalyzing] = useState(false)
  // 从面板点邮件标题进入时，退出阅读要回面板，而不是留在邮件模块的列表里
  const [returnToPanel, setReturnToPanel] = useState(false)

  // 键盘导航：当前高亮行（列表视图下，指向 list.items 的下标）
  const [cursor, setCursor] = useState(0)
  // 文件夹侧边栏宽度（可拖动调整，160–480px）
  const [folderWidth, setFolderWidth] = useState(224)

  const scopePickedRef = useRef(false)
  const wasSyncingRef = useRef(false)
  const listRequestRef = useRef(0)
  const bodyFrameRef = useRef<HTMLIFrameElement>(null)

  /** 定位证据 i 在正文中的原文：清除上次高亮，滚动到对应 mark 元素并高亮 */
  const locateEvidence = (index: number): void => {
    const doc = bodyFrameRef.current?.contentDocument
    if (!doc) {
      message.warning('正文暂不可用，无法定位')
      return
    }
    const target = doc.querySelector('mark.mail-ev[data-ev="' + index + '"]') as HTMLElement | null
    if (!target) {
      message.info('该条证据未能在正文中找到对应原文（可能来自附件或转述）')
      return
    }
    doc.querySelectorAll('mark.mail-ev-active').forEach((el) => el.classList.remove('mail-ev-active'))
    target.classList.add('mail-ev-active')
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await window.api.accountsList())
    } catch (error) {
      message.error('读取账号失败：' + errText(error))
    }
  }, [message])

  const loadFolders = useCallback(async (): Promise<MailAccountNode[]> => {
    try {
      const result = await window.api.mailFolders()
      setNodes(result)
      return result
    } catch (error) {
      message.error('读取文件夹失败：' + errText(error))
      return []
    }
  }, [message])

  const loadList = useCallback(async () => {
    const requestId = ++listRequestRef.current
    setLoading(true)
    try {
      const result = await window.api.mailList({
        accountId: scopeAccountId,
        folder: scopeFolder,
        keyword: keyword || undefined,
        ...filters,
        tagIds: tagIds.length ? tagIds : undefined,
        tagMatch,
        limit: pageSize,
        offset: (page - 1) * pageSize
      })
      if (requestId !== listRequestRef.current) return
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize))
      if (page > lastPage) { setPage(lastPage); return }
      setList(result)
    } catch (error) {
      if (requestId === listRequestRef.current) message.error('读取邮件列表失败：' + errText(error))
    } finally {
      if (requestId === listRequestRef.current) setLoading(false)
    }
  }, [filters, keyword, message, page, pageSize, scopeAccountId, scopeFolder, tagIds, tagMatch])

  // 首次进入：载入账号与文件夹树，并默认落在第一个账号的主文件夹上
  useEffect(() => {
    void (async () => {
      void loadAccounts()
      const result = await loadFolders()
      if (!scopePickedRef.current && result.length > 0) {
        scopePickedRef.current = true
        setScopeAccountId(result[0].accountId)
        setScopeFolder(result[0].folders[0]?.folder)
      }
    })()
  }, [loadAccounts, loadFolders])

  useEffect(() => {
    void loadList()
  }, [loadList])

  // 自动收取：进入页面立即 + 每 5 分钟一次（静默，失败不打扰）。syncAll 内部跳过无凭据账号、单账号失败不影响其余
  useEffect(() => {
    let alive = true
    const autoSync = async (): Promise<void> => {
      try {
        if (!alive) return
        await window.api.mailSyncAll()
      } catch {
        /* 自动收取失败静默 */
      }
    }
    void autoSync()
    const timer = window.setInterval(() => void autoSync(), AUTO_SYNC_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  // 同步状态轮询：用于文件夹树上的「收取中」与错误提示
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const result = await window.api.mailSyncStatus()
        if (alive) setStatuses(result)
      } catch {
        /* 状态轮询失败不打扰用户 */
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), STATUS_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  // 收取结束后自动刷新本地列表与计数（手动或自动收取结束都会走到这里）
  useEffect(() => {
    const syncing = statuses.some((item) => item.state === 'syncing')
    if (wasSyncingRef.current && !syncing) {
      void loadFolders()
      void loadList()
    }
    wasSyncingRef.current = syncing
  }, [statuses, loadFolders, loadList])

  // 后台 AI 与收取并非同时结束：分析计数变化时刷新标签，避免只刷新收取结果。
  useEffect(() => {
    let active = true
    let previous = ''
    const tick = async (): Promise<void> => {
      try {
        const status = await window.api.aiStatus()
        if (!active) return
        const current = [status.analyzed, status.failed, status.skipped].join(':')
        if (previous && current !== previous) void loadList()
        previous = current
      } catch { /* AI 状态暂不可用，不影响本地搜索 */ }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), STATUS_POLL_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [loadList])

  // 分页 / 筛选变化时重置键盘高亮
  useEffect(() => {
    setCursor(0)
  }, [page, pageSize, filters, keyword, scopeAccountId, scopeFolder, tagIds, tagMatch])

  // 高亮行滚入视野（仅列表视图）
  useEffect(() => {
    if (detailId !== null) return
    document.querySelector('.mail-row-cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, detailId, list])

  const syncingIds = useMemo(
    () => new Set(statuses.filter((item) => item.state === 'syncing').map((item) => item.accountId)),
    [statuses]
  )

  const totalUnread = useMemo(() => nodes.reduce((sum, node) => sum + node.unread, 0), [nodes])

  const scopeTitle = useMemo(() => {
    if (scopeAccountId === undefined) return '全部邮件'
    const node = nodes.find((item) => item.accountId === scopeAccountId)
    const name = node ? node.label || node.address : '账号 ' + scopeAccountId
    return name + ' · ' + (scopeFolder ? folderLabel(scopeFolder) : '全部文件夹')
  }, [nodes, scopeAccountId, scopeFolder])

  const selectScope = useCallback((accountId: number | undefined, folder: string | undefined) => {
    scopePickedRef.current = true
    setReturnToPanel(false)
    setScopeAccountId(accountId)
    setScopeFolder(folder)
    setPage(1)
    setCursor(0)
    setDetail(null)
    setDetailId(null)
  }, [])

  const applyKeyword = useCallback((value: string) => {
    setKeyword(value.trim())
    setPage(1)
  }, [])

  const handleFetch = useCallback(async () => {
    const targets = scopeAccountId === undefined ? accounts.map((item) => item.id) : [scopeAccountId]
    if (targets.length === 0) {
      message.warning('还没有邮箱账号，请先到「设置 → 账号管理」添加')
      return
    }
    setFetching(true)
    const texts: string[] = []
    let allOk = true
    try {
      for (const id of targets) {
        const result = await window.api.mailSync(id)
        texts.push(result.message)
        if (!result.ok) allOk = false
      }
      if (allOk) message.success(texts.join('；'))
      else message.error(texts.join('；'))
    } catch (error) {
      message.error('收取失败：' + errText(error))
    } finally {
      setFetching(false)
      await loadFolders()
      await loadList()
      try {
        setStatuses(await window.api.mailSyncStatus())
      } catch {
        /* 忽略 */
      }
    }
  }, [accounts, loadFolders, loadList, message, scopeAccountId])

  const handleReload = useCallback(async () => {
    setReloading(true)
    try {
      await loadFolders()
      await loadList()
    } finally {
      setReloading(false)
    }
  }, [loadFolders, loadList])

  const openDetail = useCallback(
    async (item: Pick<MailListItem, 'id' | 'unread'>) => {
      setDetailId(item.id)
      setDetail(null)
      try {
        const full = await window.api.mailGet(item.id)
        setDetail(full)
        if (full && item.unread) {
          await window.api.mailSetUnread(item.id, false)
          setList((prev) =>
            prev
              ? { ...prev, items: prev.items.map((row) => (row.id === item.id ? { ...row, unread: false } : row)) }
              : prev
          )
          void loadFolders()
        }
      } catch (error) {
        message.error('打开邮件失败：' + errText(error))
      }
    },
    [loadFolders, message]
  )

  useEffect(() => {
    const state = location.state as { openTaggedMail?: MailListItem; openMailId?: number; fromPanel?: boolean } | null
    const selected = state?.openTaggedMail ?? (Number.isSafeInteger(state?.openMailId) ? { id: state!.openMailId!, unread: true } : null)
    if (!selected) return
    setReturnToPanel(state?.fromPanel === true)
    void openDetail(selected)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate, openDetail])

  const closeDetail = useCallback(() => {
    setDetailId(null)
    setDetail(null)
    if (returnToPanel) {
      setReturnToPanel(false)
      navigate('/panel')
    }
  }, [navigate, returnToPanel])

  // 拖动文件夹栏分隔条调整侧边栏宽度（160–480px，双击恢复默认 224px）
  const startFolderResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const shell = event.currentTarget.parentElement
    if (!shell) return
    const shellLeft = shell.getBoundingClientRect().left
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (move: MouseEvent): void => {
      setFolderWidth(Math.min(480, Math.max(160, move.clientX - shellLeft)))
    }
    const onUp = (): void => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const reanalyze = useCallback(async () => {
    if (detailId === null) return
    setReanalyzing(true)
    try {
      const result = await window.api.aiAnalyze(detailId)
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      const full = await window.api.mailGet(detailId)
      if (full) setDetail(full)
      await loadList()
    } catch (error) {
      message.error('分析失败：' + errText(error))
    } finally {
      setReanalyzing(false)
    }
  }, [detailId, loadList, message])

  const setUnreadFlag = useCallback(
    async (unread: boolean) => {
      if (detailId === null) return
      try {
        await window.api.mailSetUnread(detailId, unread)
        setDetail((prev) => (prev ? { ...prev, unread } : prev))
        setList((prev) =>
          prev
            ? { ...prev, items: prev.items.map((row) => (row.id === detailId ? { ...row, unread } : row)) }
            : prev
        )
        await loadFolders()
      } catch (error) {
        message.error('标记失败：' + errText(error))
      }
    },
    [detailId, loadFolders, message]
  )

  const toggleStar = useCallback(
    async (id: number, current: boolean) => {
      const next = !current
      setList((prev) =>
        prev
          ? { ...prev, items: prev.items.map((row) => (row.id === id ? { ...row, starred: next } : row)) }
          : prev
      )
      setDetail((prev) => (prev && prev.id === id ? { ...prev, starred: next } : prev))
      try {
        await window.api.mailSetStarred(id, next)
      } catch (error) {
        message.error('星标失败：' + errText(error))
        setList((prev) =>
          prev
            ? { ...prev, items: prev.items.map((row) => (row.id === id ? { ...row, starred: !next } : row)) }
            : prev
        )
        setDetail((prev) => (prev && prev.id === id ? { ...prev, starred: !next } : prev))
      }
    },
    [message]
  )

  const downloadAttachment = useCallback(
    async (filename: string | null) => {
      if (detailId === null) return
      try {
        const result = await window.api.mailAttachmentDownload(detailId, filename)
        if (result.canceled) return
        if (result.ok) message.success(result.message)
        else message.error(result.message)
      } catch (error) {
        message.error('下载失败：' + errText(error))
      }
    },
    [detailId, message]
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // 搜索、下拉选择和弹窗的按键不能触发列表导航或打开邮件。
      if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input, textarea, button, a, [role="combobox"], [role="dialog"]'))) return
      if (event.key === 'Escape') {
        if (detailId !== null) {
          event.preventDefault()
          closeDetail()
        }
        return
      }
      if (detailId !== null) return
      const items = list?.items ?? []
      if (items.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((c) => Math.min(c + 1, items.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((c) => Math.max(c - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const item = items[Math.min(cursor, items.length - 1)] ?? items[0]
        if (item) void openDetail(item)
      }
    },
    [cursor, detailId, list, openDetail, closeDetail]
  )

  const columns = useMemo<ColumnsType<MailListItem>>(
    () => [
      {
        key: 'star',
        width: 30,
        render: (_value, record) => (
          <span
            className="mail-star"
            title={record.starred ? '取消星标' : '加星标'}
            onClick={(event) => {
              event.stopPropagation()
              void toggleStar(record.id, record.starred)
            }}
          >
            {record.starred ? <StarFilled className="mail-star-on" /> : <StarOutlined />}
          </span>
        )
      },
      {
        key: 'unread',
        width: 26,
        render: (_value, record) => (
          <span className={record.unread ? 'mail-dot mail-dot-on' : 'mail-dot'} />
        )
      },
      {
        title: '发件人',
        dataIndex: 'fromAddr',
        width: 166,
        ellipsis: true,
        render: (value: string) => (
          <Tooltip title={value} mouseEnterDelay={0.4}>
            <span>{fromDisplay(value) || '(未知发件人)'}</span>
          </Tooltip>
        )
      },
      {
        title: '主题',
        dataIndex: 'subject',
        ellipsis: true,
        render: (value: string, record) => (
          <div className="mail-subject-with-tags">
            <span className={record.unread ? 'mail-subject mail-subject-unread' : 'mail-subject'}>
              {record.attachmentCount > 0 ? <PaperClipOutlined className="mail-clip" /> : null}
              <span className="mail-subject-text">{value}</span>
            </span>
            {!!record.tags?.length && <CustomMailTagBadges tags={record.tags} />}
          </div>
        )
      },
      {
        title: '时间',
        dataIndex: 'dateUtc',
        width: 106,
        render: (value: string | null) => (
          <Tooltip title={formatDate(value)} mouseEnterDelay={0.4}>
            <span className="mail-muted">{formatListTime(value)}</span>
          </Tooltip>
        )
      }
    ],
    [toggleStar]
  )

  const emptyList = (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        keyword
          ? '没有匹配的邮件'
          : Object.values(filters).some(Boolean) || tagIds.length > 0
            ? '当前筛选条件下没有邮件'
            : '这个文件夹还没有邮件'
      }
    />
  )

  const noAccount = (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <span>
          还没有邮箱账号，先去{' '}
          <a onClick={() => navigate('/settings?tab=accounts')}>设置 → 账号管理</a> 添加
        </span>
      }
    />
  )

  return (
    <div className="mail-shell" onKeyDown={handleKeyDown}>
      <aside
        className="mail-folders"
        style={{ width: folderWidth, flex: '0 0 ' + folderWidth + 'px' }}
      >
        <div className="mail-folders-head">
          <span>文件夹</span>
          <span className="mail-muted">
            {accounts.length} 个账号 ·{' '}
            <a className="mail-account-link" onClick={() => navigate('/settings?tab=accounts')}>
              管理
            </a>
          </span>
        </div>
        <div className="mail-tree">
          <div
            className={
              scopeAccountId === undefined ? 'mail-tree-row mail-tree-row-active' : 'mail-tree-row'
            }
            onClick={() => selectScope(undefined, undefined)}
          >
            <InboxOutlined />
            <span className="mail-tree-label">全部邮件</span>
            <span className="mail-tree-count">{totalUnread > 0 ? totalUnread : ''}</span>
          </div>
          {nodes.map((node) => (
            <div className="mail-tree-account" key={node.accountId}>
              <div className="mail-tree-account-head" title={node.address}>
                <span className="mail-tree-account-name">{node.label || node.address}</span>
                {node.syncError ? (
                  <Tooltip title={'上次收取失败：' + node.syncError}>
                    <ExclamationCircleOutlined className="mail-tree-error" />
                  </Tooltip>
                ) : null}
                {syncingIds.has(node.accountId) ? <SyncOutlined spin className="mail-tree-spin" /> : null}
              </div>
              <div
                className={
                  scopeAccountId === node.accountId && scopeFolder === undefined
                    ? 'mail-tree-row mail-tree-row-indent mail-tree-row-active'
                    : 'mail-tree-row mail-tree-row-indent'
                }
                onClick={() => selectScope(node.accountId, undefined)}
              >
                <FolderOpenOutlined />
                <span className="mail-tree-label">该账号全部</span>
                <span className="mail-tree-count mail-tree-count-dim">{node.total > 0 ? node.total : ''}</span>
              </div>
              {node.folders.map((folder) => (
                <div
                  className={
                    scopeAccountId === node.accountId && scopeFolder === folder.folder
                      ? 'mail-tree-row mail-tree-row-indent mail-tree-row-active'
                      : 'mail-tree-row mail-tree-row-indent'
                  }
                  key={node.accountId + ':' + folder.folder}
                  onClick={() => selectScope(node.accountId, folder.folder)}
                >
                  <InboxOutlined />
                  <span className="mail-tree-label">{folderLabel(folder.folder)}</span>
                  <span className={folder.unread > 0 ? 'mail-tree-count' : 'mail-tree-count mail-tree-count-dim'}>
                    {folder.unread > 0 ? folder.unread : folder.total > 0 ? folder.total : ''}
                  </span>
                </div>
              ))}
              <div className="mail-tree-account-foot">
                {node.lastSyncAt ? '上次收取 ' + formatDate(node.lastSyncAt) : '尚未收取过'}
              </div>
            </div>
          ))}
        </div>
        <div className="mail-folders-foot mail-auto-sync-note">
          <SyncOutlined spin={fetching || syncingIds.size > 0} />
          <span>{fetching || syncingIds.size > 0 ? '正在收取邮件' : '每 5 分钟自动收取'}</span>
        </div>
      </aside>

      <div
        className="mail-folders-resizer"
        title="拖动调整侧边栏宽度"
        onMouseDown={startFolderResize}
        onDoubleClick={() => setFolderWidth(224)}
      />

      <section className="mail-list-pane">
        {detailId !== null ? (
          <div className="mail-reading">
            <div className="mail-reading-head">
              <Tooltip title={returnToPanel ? '返回面板（Esc）' : '返回列表（Esc）'}>
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  onClick={closeDetail}
                >
                  {returnToPanel ? '返回面板' : '返回'}
                </Button>
              </Tooltip>
              <div className="mail-reading-title">{detail ? detail.subject : '载入中…'}</div>
              <Button
                type="text"
                size="small"
                icon={detail?.starred ? <StarFilled className="mail-star-on" /> : <StarOutlined />}
                title="加星标"
                onClick={() => detail && void toggleStar(detail.id, detail.starred)}
              />
            </div>
            {detail ? (
              <div className="mail-reading-body">
                <div className="mail-meta">
                  <div className="mail-meta-row">
                    <span className="mail-meta-label">发件人</span>
                    <span className="mail-meta-value">{detail.fromAddr || '—'}</span>
                  </div>
                  <div className="mail-meta-row">
                    <span className="mail-meta-label">收件人</span>
                    <span className="mail-meta-value">{detail.toAddr || '—'}</span>
                  </div>
                  {detail.cc ? (
                    <div className="mail-meta-row">
                      <span className="mail-meta-label">抄送</span>
                      <span className="mail-meta-value">{detail.cc}</span>
                    </div>
                  ) : null}
                  <div className="mail-meta-row">
                    <span className="mail-meta-label">时间</span>
                    <span className="mail-meta-value">
                      {formatDate(detail.dateUtc)} · {detail.accountLabel} · {folderLabel(detail.folder)} ·{' '}
                      {formatBytes(detail.size)}
                    </span>
                  </div>
                </div>

                <div className="mail-custom-tag-detail"><span className="mail-meta-label">自定义标签</span>{detail.tags?.length ? <CustomMailTagBadges tags={detail.tags} /> : <span className="mail-muted">暂无匹配标签</span>}</div>

                <div className="mail-actions">
                  <span>
                    未读
                    <Switch
                      size="small"
                      style={{ marginLeft: 6 }}
                      checked={detail.unread}
                      onChange={(checked) => void setUnreadFlag(checked)}
                    />
                  </span>
                  <Tooltip title="将当前邮件作为引用交给 AI 处理">
                    <Button
                      size="small"
                      icon={<RobotOutlined />}
                      onClick={() => handoffToAi({ kind: 'email', id: detail.id, title: detail.subject })}
                    >
                      交给AI
                    </Button>
                  </Tooltip>
                </div>

                {detail.attachments.length > 0 ? (
                  <div className="mail-attach-list">
                    {detail.attachments.map((item, index) => (
                      <div className="mail-attach-row" key={index}>
                        <PaperClipOutlined />
                        <span className="mail-attach-name">{item.filename || '(未命名附件)'}</span>
                        <span className="mail-attach-size">
                          {formatBytes(item.size)} · {item.contentType}
                        </span>
                        <Tooltip title="从服务器下载此附件">
                          <Button
                            type="link"
                            size="small"
                            icon={<DownloadOutlined />}
                            onClick={() => void downloadAttachment(item.filename)}
                          >
                            下载
                          </Button>
                        </Tooltip>
                      </div>
                    ))}
                  </div>
                ) : null}

                <iframe
                  ref={bodyFrameRef}
                  className="mail-body-frame"
                  title={'邮件正文 ' + detail.id}
                  sandbox="allow-popups allow-same-origin"
                  srcDoc={buildSrcDoc(
                    detail.bodyHtml || '',
                    detail.bodyText || '',
                    detail.analysis?.evidence ?? [],
                    darkBody
                  )}
                />

                {detail.analysis ? (
                  <div className="mail-detail-block">
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <span className="mail-detail-label">AI 分析</span>
                      <Button type="link" size="small" loading={reanalyzing} onClick={() => void reanalyze()}>
                        重新分析
                      </Button>
                    </Space>
                    <Space size={8} wrap>
                      <span className="mail-muted">
                        {ANALYSIS_STATUS_TEXT[detail.analysis.status] ?? detail.analysis.status}
                        {detail.analysis.model ? ' · ' + detail.analysis.model : ''}
                        {detail.analysis.confidence !== null
                          ? ' · 置信度 ' + detail.analysis.confidence
                          : ''}
                      </span>
                    </Space>
                    {detail.analysis.summary ? <div>{detail.analysis.summary}</div> : null}
                    {detail.analysis.actionRequired ? (
                      <div>需要行动：{detail.analysis.actionRequired}</div>
                    ) : null}
                    {detail.analysis.deadlineAt ? <div>截止时间：{formatDate(detail.analysis.deadlineAt)}</div> : null}
                    {detail.analysis.evidence.length > 0 ? (
                      <div className="mail-evidence-list">
                        <span className="mail-detail-label">原文证据</span>
                        {detail.analysis.evidence.map((text, index) => (
                          <div className="mail-evidence-row" key={index}>
                            <span className="mail-evidence-text">{text}</span>
                            <Button
                              type="link"
                              size="small"
                              icon={<AimOutlined />}
                              onClick={() => locateEvidence(index)}
                            >
                              在正文中定位
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {detail.analysis.error ? (
                      <div className="mail-muted">分析错误：{detail.analysis.error}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mail-reading-body">
                <Skeleton active paragraph={{ rows: 6 }} />
              </div>
            )}
          </div>
        ) : (
          <>
            <MailSearchToolbar
              scopeTitle={scopeTitle} total={list?.total}
              keyword={keyword} keywordInput={keywordInput}
              onKeywordInputChange={setKeywordInput} onSearch={applyKeyword}
              filters={filters} onFiltersChange={(value) => { setFilters(value); setPage(1) }}
              tagIds={tagIds} tagMatch={tagMatch}
              onTagIdsChange={(ids) => { setTagIds(ids); setPage(1) }}
              onTagMatchChange={(mode) => { setTagMatch(mode); setPage(1) }}
              onClear={() => { setKeyword(''); setKeywordInput(''); setTagIds([]); setTagMatch('any'); setFilters(EMPTY_FILTERS); setPage(1) }}
              onTagsChanged={() => void loadList()}
              fetching={fetching} reloading={reloading}
              onFetch={() => void handleFetch()} onReload={() => void handleReload()}
            />
            <div className="mail-list-scroll">
              <Table<MailListItem>
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={list?.items ?? []}
                loading={loading}
                pagination={false}
                scroll={{ x: 560 }}
                onRow={(record, index) => ({
                  onClick: () => void openDetail(record),
                  onMouseEnter: () => setCursor(index ?? 0)
                })}
                rowClassName={(record, index) => {
                  const active = record.id === detailId ? ' mail-row-active' : ''
                  const cursorCls = index === cursor ? ' mail-row-cursor' : ''
                  return 'mail-row' + active + cursorCls
                }}
                locale={{ emptyText: accounts.length === 0 ? noAccount : emptyList }}
              />
            </div>
            <div className="mail-list-foot">
              <Pagination
                size="small"
                current={page}
                pageSize={pageSize}
                total={list?.total ?? 0}
                showSizeChanger
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                showTotal={(total) => '共 ' + total + ' 封'}
                onChange={(nextPage, nextSize) => {
                  setPage(nextPage)
                  setPageSize(nextSize)
                }}
              />
            </div>
          </>
        )}
      </section>
    </div>
  )
}

export const mailModule: ModuleManifest = {
  id: 'mail',
  title: '邮件',
  icon: <MailOutlined />,
  route: '/mail',
  enabled: true,
  page: () => <MailPage />
}
