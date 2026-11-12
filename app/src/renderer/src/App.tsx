import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Badge, Button, Layout, Menu, Space, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { DesktopOutlined, MenuOutlined, MoonOutlined, PushpinFilled, PushpinOutlined, CloseOutlined, SunOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import { modules } from './modules/registry'
import type { ModuleManifest } from './modules/types'
import { AiSettingsPage } from './modules/aiSettings'
import { beginSiderResize } from './frameResize'
import appIcon from '../../../resources/icon.png'
import type { AppInfo } from '@shared/types'
import { useTheme } from './theme'

const { Sider, Header, Content } = Layout

/** Sync telemetry must not broadcast a shell update to every mounted business view. */
const MailSyncBadge = memo(function MailSyncBadge(): JSX.Element {
  const [info, setInfo] = useState({ total: 0, syncing: 0, errors: 0 })
  useEffect(() => {
    let disposed = false
    let pending = false
    const refresh = async (): Promise<void> => {
      if (disposed || pending || document.visibilityState !== 'visible') return
      pending = true
      try {
        const list = await window.api.mailSyncStatus()
        if (disposed) return
        const next = { total: list.length, syncing: list.filter((s) => s.state === 'syncing').length, errors: list.filter((s) => s.state === 'error').length }
        setInfo((previous) => previous.total === next.total && previous.syncing === next.syncing && previous.errors === next.errors ? previous : next)
      } catch { /* Keep the last known badge on transient IPC errors. */ }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    const visible = (): void => { void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [])
  return info.total === 0 ? <Badge status="default" text="邮件同步：未配置账号" />
    : info.syncing > 0 ? <Badge status="processing" text={`邮件同步：${info.syncing}/${info.total}`} />
      : info.errors > 0 ? <Badge status="error" text={`邮件同步：${info.errors}个账号异常`} />
        : <Badge status="success" text={`邮件同步：正常（${info.total}个账号）`} />
})

const ModulePage = memo(function ModulePage({ module }: { module: ModuleManifest }): JSX.Element {
  return module.enabled ? <>{module.page()}</> : <div className="app-placeholder"><div className="app-placeholder-overline">{module.id.toUpperCase()}</div><div className="app-placeholder-text">{module.title} · 此模块规划中</div></div>
})

export default function App(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const { mode, palette, resolved, cycleMode, setPalette } = useTheme()
  const modeLabel = mode === 'dark' ? '深色' : mode === 'system' ? '跟随系统' : '浅色'
  const modeIcon = mode === 'dark' ? <MoonOutlined /> : mode === 'system' ? <DesktopOutlined /> : <SunOutlined />
  const [siderWidth, setSiderWidth] = useState(200)
  const [navVisible, setNavVisible] = useState(() => localStorage.getItem('infoagent.navVisible') !== 'false')
  const [navPinned, setNavPinned] = useState(() => localStorage.getItem('infoagent.navPinned') !== 'false')
  const [visited, setVisited] = useState<Set<string>>(() => new Set([location.pathname]))
  useEffect(() => { setVisited((previous) => previous.has(location.pathname) ? previous : new Set([...previous, location.pathname])) }, [location.pathname])
  useEffect(() => { localStorage.setItem('infoagent.navVisible', String(navVisible)) }, [navVisible])
  useEffect(() => { localStorage.setItem('infoagent.navPinned', String(navPinned)) }, [navPinned])
  useEffect(() => {
    let live = true
    void window.api.appInfo().then((info) => { if (live) setAppInfo(info) }).catch(() => { if (live) setAppInfo(null) })
    return () => { live = false }
  }, [])
  const menuItems: MenuProps['items'] = useMemo(() => modules.map((m) => ({ key: m.route, icon: m.icon, label: <Space size={6}>{m.title}{!m.enabled && <Tag>规划中</Tag>}</Space> })), [])
  const fallbackRoute = modules.find((m) => m.enabled)?.route ?? '/jarvis'
  const currentKey = '/' + (location.pathname.split('/')[1] ?? '')
  const validRoute = modules.some((m) => m.route === location.pathname) || location.pathname === '/jarvis/settings'
  useEffect(() => { if (!validRoute) navigate(fallbackRoute, { replace: true }) }, [validRoute, fallbackRoute, navigate])

  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { resizeCleanup.current?.(); resizeCleanup.current = null }, [navVisible, navPinned])
  const startSiderResize = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const root = event.currentTarget.parentElement
    if (!root) return
    resizeCleanup.current?.()
    resizeCleanup.current = beginSiderResize(window, document.body, root.getBoundingClientRect().left, setSiderWidth)
  }, [])

  return <Layout style={{ height: '100vh' }}>
    {navVisible && <Sider width={siderWidth} theme={resolved === 'dark' ? 'dark' : 'light'} className={navPinned ? 'app-sider' : 'app-sider app-nav-floating'} style={{ borderRight: '1px solid var(--line)' }}>
      <div className="app-logo"><img className="app-logo-icon" src={appIcon} alt="InfoAgent" /><div className="app-logo-text"><div className="app-logo-title">INFOAGENT</div><div className="app-logo-sub">个人资讯工作台</div></div></div>
      <div className="app-nav-controls"><Tooltip title={navPinned ? '取消固定，选择模块后自动隐藏' : '固定导航，保持展开'}><Button type="text" className={navPinned ? 'app-nav-btn app-nav-btn-active' : 'app-nav-btn'} aria-label={navPinned ? '取消固定导航' : '固定导航'} icon={navPinned ? <PushpinFilled /> : <PushpinOutlined />} onClick={() => setNavPinned((p) => !p)} /></Tooltip><Button type="text" className="app-nav-btn" aria-label="隐藏导航" icon={<CloseOutlined />} onClick={() => setNavVisible(false)} /></div>
      <Menu theme={resolved === 'dark' ? 'dark' : 'light'} mode="inline" selectedKeys={[currentKey]} items={menuItems} onClick={({ key }) => { navigate(key); if (!navPinned) setNavVisible(false) }} />
    </Sider>}
    {navVisible && navPinned && <div className="app-sider-resizer" title="拖动调整导航宽度" onMouseDown={startSiderResize} onDoubleClick={() => setSiderWidth(200)} />}
    <Layout style={{ minWidth: 0 }}>
      <Header className="app-header"><Space><Button type="text" className="app-header-btn" aria-label={navVisible ? '隐藏模块导航' : '显示模块导航'} icon={<MenuOutlined />} onClick={() => setNavVisible((v) => !v)} /><MailSyncBadge /></Space><Space><Tooltip title={`外观：${modeLabel}（点击切换 浅色 → 深色 → 跟随系统）`}><Button type="text" className="app-header-btn" aria-label={`切换外观，当前${modeLabel}`} icon={modeIcon} onClick={cycleMode} /></Tooltip><Tooltip title="切换配色包：多巴胺 / 经典"><Button size="small" type={palette === 'vivid' ? 'primary' : 'default'} onClick={() => setPalette(palette === 'vivid' ? 'classic' : 'vivid')} aria-label="切换配色包">{palette === 'vivid' ? '多巴胺' : '经典'}</Button></Tooltip><Typography.Text type="secondary">v{appInfo?.version ?? '0.3.0'}</Typography.Text></Space></Header>
      <Content className="app-content">
        {/* Keep real selection, filters, iframe scroll and reading position across route changes. */}
        {modules.map((m) => (visited.has(m.route) || location.pathname === m.route) && <section key={m.id} className="app-module" hidden={location.pathname !== m.route} aria-hidden={location.pathname !== m.route}><ModulePage module={m} /></section>)}
        {location.pathname === '/jarvis/settings' && <AiSettingsPage />}
      </Content>
    </Layout>
  </Layout>
}
