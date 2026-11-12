import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  LogoutOutlined,
  PlusOutlined,
  SettingOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type {
  AccountInfo,
  AccountInput,
  AccountSyncStatus,
  AIProviderPreset,
  AiConfigInput,
  AiTestResult,
  AiStatus,
  AppInfo,
  MailProviderPreset,
  OauthPollResult,
  SettingsPatch,
  ZhihuStatus
} from '@shared/types'
import type { ImQcePhase, ImQceRuntimeStatus } from '../../../shared/im'
import type { ModuleManifest } from './types'
import { goToAiSettings } from '../aiNavigation'
import { TagPreferencesEditor } from './tagPreferences'
import './settings.css'
import { ChatPane } from './chat'
import { ManualPane } from './manual'

function AboutPane() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    window.api
      .appInfo()
      .then(setInfo)
      .catch(() => setFailed(true))
  }, [])

  if (failed) {
    return <Typography.Text type="danger">无法获取应用信息（IPC 未就绪）</Typography.Text>
  }

  return (
    <Descriptions bordered column={1} size="small">
      <Descriptions.Item label="应用名称">InfoAgent</Descriptions.Item>
      <Descriptions.Item label="版本">{info?.version ?? '读取中…'}</Descriptions.Item>
      <Descriptions.Item label="Electron">{info?.electron ?? '读取中…'}</Descriptions.Item>
      <Descriptions.Item label="Chromium">{info?.chrome ?? '读取中…'}</Descriptions.Item>
      <Descriptions.Item label="数据目录">{info?.userDataPath ?? '读取中…'}</Descriptions.Item>
    </Descriptions>
  )
}

/** IPC 拒绝错误 → 去掉 Electron 包装前缀，直接展示主进程信息 */
function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 连通测试的密钥来源说明（keySource） */
const KEY_SOURCE_LABEL: Record<string, string> = {
  input: '本次使用新输入的密钥',
  saved: '已复用同端点已保存密钥',
  none: '该端点不需要密钥'
}

/** 连通测试失败类别（code） */
const TEST_CODE_LABEL: Record<string, string> = {
  success: '调用成功',
  config: '配置缺失',
  auth: '鉴权失败（401/403）',
  rate_limit: '限流（429）',
  network: '网络/超时',
  endpoint: '端点或模型错误',
  model: '模型调用失败'
}

const STATE_TAG: Record<AccountSyncStatus['state'], { color: string; text: string }> = {
  never: { color: 'default', text: '未同步' },
  syncing: { color: 'processing', text: '同步中' },
  idle: { color: 'success', text: '已同步' },
  error: { color: 'error', text: '同步失败' }
}

interface AccountFormValues extends AccountInput {
  secret: string
}

function AccountsInner() {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<AccountFormValues>()
  const [accounts, setAccounts] = useState<AccountInfo[]>([])
  const [providers, setProviders] = useState<MailProviderPreset[]>([])
  const [statuses, setStatuses] = useState<AccountSyncStatus[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AccountInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncingId, setSyncingId] = useState<number | null>(null)
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthState, setOauthState] = useState<string | null>(null)
  const [oauthStatus, setOauthStatus] = useState<OauthPollResult | null>(null)
  const [oauthAuthUrl, setOauthAuthUrl] = useState('')
  const [oauthBusy, setOauthBusy] = useState(false)
  const oauthTimerRef = useRef<number | null>(null)

  const watchedProvider = Form.useWatch('provider', form)

  const load = useCallback(() => {
    window.api.accountsList().then(setAccounts).catch(() => {})
    window.api.mailSyncStatus().then(setStatuses).catch(() => {})
  }, [])

  useEffect(() => {
    window.api.mailProvidersList().then(setProviders).catch(() => {})
    load()
    // 每 5 秒刷新同步状态（同步在后台进行时界面实时可见）
    const timer = setInterval(() => window.api.mailSyncStatus().then(setStatuses).catch(() => {}), 5000)
    return () => clearInterval(timer)
  }, [load])

  // 关闭弹窗时：停止轮询并取消未完成的 OAuth 授权会话
  useEffect(() => {
    if (modalOpen) return
    if (oauthState) void window.api.accountsOauthCancel(oauthState)
    stopOauthPoll()
    setOauthState(null)
    setOauthStatus(null)
    setOauthAuthUrl('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen])

  // 打开弹窗时按预设/账号填充表单，并重置 OAuth 会话状态
  useEffect(() => {
    if (!modalOpen) return
    if (oauthState) void window.api.accountsOauthCancel(oauthState)
    stopOauthPoll()
    setOauthState(null)
    setOauthStatus(null)
    setOauthAuthUrl('')
    const fallback = providers[0]
    if (editing) {
      setOauthClientId(editing.oauthClientId ?? '')
      form.setFieldsValue({
        provider: editing.provider,
        label: editing.label,
        address: editing.address,
        username: editing.username,
        secret: '',
        host: editing.host,
        port: editing.port,
        encryption: editing.encryption,
        folder: editing.folder,
        authMode: editing.authMode,
        aiEnabled: editing.aiEnabled,
        aiProvider: editing.aiProvider ?? '',
        aiBaseUrl: editing.aiBaseUrl ?? '',
        aiModel: editing.aiModel ?? ''
      })
    } else if (fallback) {
      setOauthClientId('')
      form.setFieldsValue({
        provider: fallback.id,
        label: '',
        address: '',
        username: '',
        secret: '',
        host: fallback.host,
        port: fallback.port,
        encryption: fallback.encryption,
        folder: fallback.defaultFolder,
        authMode: fallback.authMode,
        aiEnabled: true
      })
    }
  }, [modalOpen, editing, providers, form])

  const provider = useMemo(() => providers.find((p) => p.id === watchedProvider), [providers, watchedProvider])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  const openEdit = (row: AccountInfo) => {
    setEditing(row)
    form.resetFields()
    setModalOpen(true)
  }

  const doClearSecret = async () => {
    if (!editing) return
    try {
      const updated = await window.api.accountsClearSecret(editing.id)
      setEditing(updated)
      message.success('已清除该账号的已保存凭据，重新同步或测试连接前需重新填写授权码或重新 OAuth 登录')
      load()
    } catch (error) {
      message.error(errText(error))
    }
  }

  const stopOauthPoll = () => {
    if (oauthTimerRef.current !== null) {
      clearInterval(oauthTimerRef.current)
      oauthTimerRef.current = null
    }
  }

  const startOauthPoll = (state: string) => {
    stopOauthPoll()
    oauthTimerRef.current = window.setInterval(() => {
      window.api
        .accountsOauthPoll(state)
        .then((result) => {
          setOauthStatus(result)
          if (result.status === 'done') {
            stopOauthPoll()
            if (result.email) form.setFieldsValue({ address: result.email, username: result.email })
            message.success(result.email ? `OAuth 授权成功：${result.email}，保存后生效` : 'OAuth 授权成功，保存后生效')
          } else if (result.status === 'error' || result.status === 'cancelled' || result.status === 'expired') {
            stopOauthPoll()
            if (result.status !== 'cancelled') message.error(result.message ?? 'OAuth 授权失败')
          }
        })
        .catch(() => {})
    }, 1500)
  }

  const doOauthLogin = async () => {
    const clientId = oauthClientId.trim()
    if (!clientId) {
      message.warning('请先填写 OAuth 客户端 ID（在 Azure AD / Google Cloud 注册应用获得）')
      return
    }
    if (!provider) return
    setOauthBusy(true)
    try {
      const result = await window.api.accountsOauthBegin(provider.id, clientId)
      if (!result.ok || !result.state) {
        message.error(result.message ?? '无法发起 OAuth 授权')
        return
      }
      setOauthState(result.state)
      setOauthAuthUrl(result.authUrl ?? '')
      setOauthStatus({ status: 'pending' })
      startOauthPoll(result.state)
      message.info('已在浏览器中打开授权页面，请登录并完成授权')
    } catch (error) {
      message.error(errText(error))
    } finally {
      setOauthBusy(false)
    }
  }

  // 切换预设服务商 → 自动带出主机/端口/加密/文件夹（自定义除外，全手填）
  const onProviderChange = (id: string) => {
    // 服务商切换后原 OAuth 会话不再适用
    if (oauthState) void window.api.accountsOauthCancel(oauthState)
    stopOauthPoll()
    setOauthState(null)
    setOauthStatus(null)
    setOauthAuthUrl('')
    const p = providers.find((x) => x.id === id)
    if (!p) return
    if (p.custom) {
      // 自定义：清空并让用户手填，避免沿用上一个预设的服务器参数
      form.setFieldsValue({ host: '', port: 993, encryption: 'ssl', folder: 'INBOX', authMode: 'password' })
      return
    }
    form.setFieldsValue({
      host: p.host,
      port: p.port,
      encryption: p.encryption,
      folder: p.defaultFolder,
      authMode: p.authMode
    })
  }

  const buildInput = async (): Promise<AccountInput | null> => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return null
    // 高级设置可调整服务器参数：用户值优先，未填时回落到预设注册表
    const preset = providers.find((p) => p.id === values.provider)
    return {
      provider: values.provider,
      label: values.label?.trim() || values.address.trim(),
      address: values.address.trim(),
      username: values.username?.trim() || values.address.trim(),
      secret: values.secret?.trim() || undefined,
      host: values.host?.trim() || preset?.host || '',
      port: values.port ?? preset?.port ?? 993,
      encryption: values.encryption || preset?.encryption || 'ssl',
      folder: values.folder?.trim() || preset?.defaultFolder || 'INBOX',
      authMode: preset?.authMode ?? values.authMode ?? 'password',
      oauthState: oauthStatus?.status === 'done' ? oauthState ?? undefined : undefined,
      aiEnabled: values.aiEnabled !== false,
      aiProvider: values.aiProvider?.trim() || undefined,
      aiBaseUrl: values.aiBaseUrl?.trim() || undefined,
      aiModel: values.aiModel?.trim() || undefined
    }
  }

  const doTest = async () => {
    const input = await buildInput()
    if (!input) return
    if (!input.secret && !editing && oauthStatus?.status !== 'done') {
      message.warning('请先填写授权码，或完成 OAuth 登录')
      return
    }
    setTesting(true)
    try {
      const result = await window.api.accountsTest(input, editing?.id)
      if (result.ok) message.success(result.message)
      else message.error(result.message)
    } catch (error) {
      message.error(errText(error))
    } finally {
      setTesting(false)
    }
  }

  const doSave = async () => {
    const input = await buildInput()
    if (!input) return
    if (!input.secret && !editing && oauthStatus?.status !== 'done') {
      message.warning('创建账号必须填写授权码，或完成 OAuth 登录')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await window.api.accountsUpdate(editing.id, input)
        message.success('账号已更新')
      } else {
        await window.api.accountsCreate(input)
        message.success('账号已添加，可点击「同步」拉取邮件')
      }
      setModalOpen(false)
      load()
    } catch (error) {
      message.error(errText(error))
    } finally {
      setSaving(false)
    }
  }

  const doSync = async (id: number) => {
    setSyncingId(id)
    try {
      const result = await window.api.mailSync(id)
      if (result.ok) message.success(result.message)
      else message.error(result.message)
    } catch (error) {
      message.error(errText(error))
    } finally {
      setSyncingId(null)
      load()
    }
  }

  const doDelete = async (row: AccountInfo) => {
    try {
      await window.api.accountsDelete(row.id)
      message.success('账号已删除')
      load()
    } catch (error) {
      message.error(errText(error))
    }
  }

  const statusById = useMemo(() => {
    const map = new Map<number, AccountSyncStatus>()
    for (const s of statuses) map.set(s.accountId, s)
    return map
  }, [statuses])

  const columns: ColumnsType<AccountInfo> = [
    {
      title: '邮箱账号',
      dataIndex: 'label',
      render: (label: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.address}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '服务器',
      key: 'host',
      render: (_, row) => (
        <Typography.Text>
          {row.host}:{row.port}
          <Tag style={{ marginLeft: 8 }}>{row.encryption === 'ssl' ? 'SSL' : 'STARTTLS'}</Tag>
        </Typography.Text>
      )
    },
    {
      title: '状态',
      key: 'state',
      width: 110,
      render: (_, row) => {
        const status = statusById.get(row.id)
        const conf = STATE_TAG[status?.state ?? 'never']
        const tag = <Tag color={conf.color}>{conf.text}</Tag>
        const err = status?.error ?? row.syncError
        return err ? <Tooltip title={err}>{tag}</Tooltip> : tag
      }
    },
    {
      title: 'AI 分析',
      key: 'aiEnabled',
      width: 100,
      render: (_, row) =>
        row.aiEnabled ? (
          <Tag color="green">开启</Tag>
        ) : (
          <Tag>关闭</Tag>
        )
    },
    {
      title: '最近同步',
      dataIndex: 'lastSyncAt',
      render: (value: string | null) => <Typography.Text type="secondary">{formatTime(value)}</Typography.Text>
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" icon={<SyncOutlined />} loading={syncingId === row.id} onClick={() => doSync(row.id)}>
            同步
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该邮箱账号？"
            description="已同步的邮件与分析结果会一并删除，且不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => doDelete(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text type="secondary">
          授权码（应用密码）经系统加密后保存在本机，不会写入日志或上传。
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          添加邮箱账号
        </Button>
      </Space>
      <Table<AccountInfo>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={accounts}
        locale={{ emptyText: <Empty description="还没有邮箱账号，点击右上角「添加邮箱账号」开始" /> }}
        pagination={false}
      />
      <Modal
        title={editing ? '编辑邮箱账号' : '添加邮箱账号'}
        open={modalOpen}
        rootClassName="set-modal"
        width={560}
        onCancel={() => setModalOpen(false)}
        footer={[
          <Button key="test" icon={<SyncOutlined />} loading={testing} onClick={doTest}>
            测试连接
          </Button>,
          <Button key="cancel" onClick={() => setModalOpen(false)}>
            取消
          </Button>,
          <Button key="save" type="primary" loading={saving} onClick={doSave}>
            保存
          </Button>
        ]}
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item name="provider" label="邮箱服务商" rules={[{ required: true, message: '请选择邮箱服务商' }]}>
            <Select options={providers.map((p) => ({ value: p.id, label: p.label }))} onChange={onProviderChange} />
          </Form.Item>
          {provider && (
            <Alert
              type="info"
              showIcon
              message={provider.label}
              description={
                <Space direction="vertical" size={2}>
                  <span>{provider.helpText}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {provider.custom
                      ? '自定义 IMAP：请在下方填写服务器地址、端口与加密方式。'
                      : `服务器：${provider.host}:${provider.port}（${provider.encryption === 'ssl' ? 'SSL/TLS' : 'STARTTLS'}）｜文件夹：${provider.defaultFolder}`}
                  </Typography.Text>
                  {provider.helpUrl && (
                    <Typography.Link onClick={() => void window.api.appOpenExternal(provider.helpUrl!)}>
                      打开授权帮助页面 ↗
                    </Typography.Link>
                  )}
                </Space>
              }
              style={{ marginBottom: 16 }}
            />
          )}
          <Form.Item name="label" label="显示名称" rules={[{ required: true, message: '请填写显示名称' }]}>
            <Input placeholder="如：工作邮箱 / 学校邮箱" />
          </Form.Item>
          <Form.Item
            name="address"
            label="邮箱地址"
            rules={[
              { required: true, message: '请填写邮箱地址' },
              { type: 'email', message: '邮箱地址格式不正确' }
            ]}
          >
            <Input placeholder="you@example.com" />
          </Form.Item>
          <Form.Item name="username" label="登录用户名">
            <Input placeholder="默认与邮箱地址相同" />
          </Form.Item>
          <Form.Item
            name="secret"
            label={editing ? '授权码 / 密码（留空则不修改）' : '授权码 / 密码'}
            rules={editing || oauthStatus?.status === 'done' ? [] : [{ required: true, message: '请填写授权码，或完成上方 OAuth 登录' }]}
            extra={
              editing?.hasSecret ? (
                <Popconfirm
                  title="清除该账号已保存的授权码？"
                  description="清除后，同步与测试连接需要重新填写授权码；历史邮件与分析结果不受影响。"
                  okText="清除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={doClearSecret}
                >
                  <Button size="small" danger>清除已保存凭据</Button>
                </Popconfirm>
              ) : undefined
            }
          >
            <Input.Password placeholder="授权码不是网页登录密码" autoComplete="new-password" />
          </Form.Item>
          {provider && (provider.id === 'outlook' || provider.id === 'gmail') && (
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text strong>
                  {provider.id === 'outlook' ? 'Microsoft 账号登录（OAuth，推荐）' : 'Google 账号登录（OAuth，推荐）'}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  使用 {provider.id === 'outlook' ? 'Microsoft' : 'Google'} 账号网页授权登录，无需应用密码。需先在
                  {provider.id === 'outlook' ? ' Azure AD 应用注册' : ' Google Cloud Console'} 创建应用，将重定向 URI
                  注册为 http://127.0.0.1 并取得客户端 ID。
                </Typography.Text>
                {editing?.oauthBound && (
                  <Space size={8}>
                    <Tag color="green">已绑定 OAuth 登录</Tag>
                    <Popconfirm
                      title="解除 OAuth 绑定？"
                      description="解除后该账号同步将停止，需重新 OAuth 登录或填写应用密码。"
                      okText="解除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={doClearSecret}
                    >
                      <Button size="small" danger>解除绑定</Button>
                    </Popconfirm>
                  </Space>
                )}
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    placeholder="OAuth 客户端 ID（Client ID）"
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    disabled={oauthBusy}
                    style={{ flex: 1 }}
                  />
                  <Button type="primary" loading={oauthBusy} onClick={doOauthLogin}>
                    {provider.id === 'outlook' ? '使用 Microsoft 账号登录' : '使用 Google 账号登录'}
                  </Button>
                </Space.Compact>
                {oauthStatus?.status === 'pending' && <Tag color="processing">等待浏览器授权…</Tag>}
                {oauthStatus?.status === 'done' && (
                  <Tag color="success">{oauthStatus.email ? `已授权：${oauthStatus.email}` : '已授权，保存后生效'}</Tag>
                )}
                {oauthStatus?.status === 'error' && <Tag color="error">{oauthStatus.message ?? '授权失败'}</Tag>}
                {oauthStatus?.status === 'expired' && <Tag color="warning">授权会话已超时，请重新发起</Tag>}
                {oauthStatus?.status === 'cancelled' && <Tag>已取消</Tag>}
                {oauthAuthUrl && oauthStatus?.status === 'pending' && (
                  <Typography.Link onClick={() => void window.api.appOpenExternal(oauthAuthUrl)}>
                    浏览器没有自动打开？点击手动打开授权页面 ↗
                  </Typography.Link>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  仍可在上方「授权码 / 密码」中填写应用密码作为降级方式。
                </Typography.Text>
              </Space>
            </div>
          )}
          <Form.Item name="aiEnabled" valuePropName="checked" extra="关闭后该账号邮件不参与 AI 分析，保持「待分析」状态；重新开启即恢复。">
            <Checkbox>参与 AI 分析与信息流</Checkbox>
          </Form.Item>
          <Form.Item label="AI 端点覆盖（可选）" extra="服务商 / Base URL / 模型三项齐全才生效，否则跟随全局 AI 配置；API Key 始终使用全局配置。">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item name="aiProvider" noStyle>
                <Input placeholder="服务商标识（留空 = 跟随全局），如 deepseek" />
              </Form.Item>
              <Form.Item name="aiBaseUrl" noStyle>
                <Input placeholder="Base URL（留空 = 跟随全局），如 https://api.deepseek.com/v1" />
              </Form.Item>
              <Form.Item name="aiModel" noStyle>
                <Input placeholder="模型（留空 = 跟随全局），如 deepseek-chat" />
              </Form.Item>
            </Space>
          </Form.Item>
          <Collapse
            ghost
            items={[
              {
                key: 'advanced',
                label: '高级设置（服务器参数，一般无需修改）',
                children: (
                  <>
                    <Form.Item
                      name="host"
                      label="IMAP 服务器地址"
                      rules={provider?.custom ? [{ required: true, message: '请填写服务器地址' }] : []}
                    >
                      <Input placeholder="imap.example.com" />
                    </Form.Item>
                    <Space size="middle" style={{ display: 'flex' }}>
                      <Form.Item
                        name="port"
                        label="端口"
                        rules={provider?.custom ? [{ required: true, message: '请填写端口' }] : []}
                        style={{ width: 140 }}
                      >
                        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                      </Form.Item>
                      <Form.Item name="encryption" label="加密方式" style={{ width: 180 }}>
                        <Select
                          options={[
                            { value: 'ssl', label: 'SSL/TLS' },
                            { value: 'starttls', label: 'STARTTLS' }
                          ]}
                        />
                      </Form.Item>
                      <Form.Item name="folder" label="文件夹" style={{ flex: 1 }}>
                        <Input placeholder="INBOX" />
                      </Form.Item>
                    </Space>
                  </>
                )
              }
            ]}
            style={{ marginBottom: 24 }}
          />
          <Form.Item name="authMode" hidden>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}

const QCE_PHASE_META: Record<ImQcePhase, { color: string; text: string }> = {
  online: { color: 'green', text: '已登录' },
  starting: { color: 'blue', text: '启动中' },
  waiting_login: { color: 'orange', text: '等待扫码' },
  stopped: { color: 'default', text: '未启动' },
  qq_not_found: { color: 'gold', text: '未检测到 QQ' },
  missing_runtime: { color: 'red', text: '缺少运行集' },
  unsupported: { color: 'default', text: '不支持' },
  error: { color: 'red', text: '出错' }
}

const QCE_PHASE_HINT: Record<ImQcePhase, { type: 'info' | 'success' | 'warning' | 'error'; title: string; body: string }> = {
  online: {
    type: 'success',
    title: 'QQ 已登录，可以同步',
    body: '同步会读取 QCE 提供的本地接口，不接触 QQ 密码，也不会改动 QCE 里的原始数据。'
  },
  starting: {
    type: 'info',
    title: '正在启动内置 QCE',
    body: 'QQ 登录窗通常会在 10–30 秒内出现；若被安全软件拦截，可点「检测连接」查看状态。'
  },
  waiting_login: {
    type: 'info',
    title: 'QCE 已就绪，等待扫码',
    body: '请在 QQ 登录窗中完成扫码或快捷登录；登录成功后这里会自动变成「已登录」。'
  },
  stopped: {
    type: 'info',
    title: '还没登录 QQ',
    body: '点「登录 QQ」，InfoAgent 会启动内置 QCE 运行集（约 48MB），随后弹出 QQ 登录窗扫码即可。'
  },
  qq_not_found: {
    type: 'warning',
    title: '没有找到 QQNT',
    body: '内置 QCE 需要 QQNT 9.9.x。请先安装 QQ，或点「选择 QQ.exe」手动指定安装位置。'
  },
  missing_runtime: {
    type: 'error',
    title: '安装包缺少 QCE 运行集',
    body: '请重新安装完整的 InfoAgent 安装包，或执行 node scripts/prepare-qce.cjs 生成 resources/qce。'
  },
  unsupported: {
    type: 'warning',
    title: '当前系统不支持',
    body: '内置 QCE 依赖 Windows 注入器，目前只支持 Windows x64。'
  },
  error: {
    type: 'error',
    title: '启动或登录失败',
    body: '可点「检测连接」重试；仍失败时展开「最近日志」，把最后几行发给开发者。'
  }
}

function QqAccountSection() {
  const { message, modal } = AntApp.useApp()
  const [status, setStatus] = useState<ImQceRuntimeStatus | null>(null)
  const [busy, setBusy] = useState<'check' | 'sync' | 'launch' | 'logout' | 'pick' | null>(null)
  const [logTail, setLogTail] = useState<string[]>([])

  const refresh = useCallback(async () => {
    const next = await window.api.imQceRuntime()
    setStatus(next)
    return next
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => message.error('检测 QQ 连接失败：' + errText(error)))
  }, [message, refresh])

  // 启动 / 等待扫码期间自动轮询，登录成功后停止
  useEffect(() => {
    if (!status) return
    if (status.phase !== 'starting' && status.phase !== 'waiting_login') return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 2500)
    return () => clearInterval(timer)
  }, [refresh, status])

  const check = async (): Promise<void> => {
    setBusy('check')
    try {
      const next = await refresh()
      setLogTail(next.logPath ? await window.api.imQceLogTail(20) : [])
    } catch (error) {
      message.error('检测 QQ 连接失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const launch = async (): Promise<void> => {
    setBusy('launch')
    try {
      const next = await window.api.imQceLaunch()
      setStatus(next)
      if (next.phase === 'error') message.error(next.detail)
      else message.info('已启动 QCE，请在 QQ 登录窗扫码')
    } catch (error) {
      message.error('启动 QQ 失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const requestLaunch = (): void => {
    if (status?.qqRunning) {
      modal.confirm({
        title: '重新启动 QQ？',
        content: '当前 QQ 正在运行。NapCat 只能注入由启动器拉起的 QQ，继续会先关闭现有 QQ，再自动重新打开。',
        okText: '继续登录',
        cancelText: '取消',
        onOk: () => launch()
      })
      return
    }
    modal.confirm({
      title: '登录 QQ？',
      content: '将启动内置 QCE 运行集并打开 QQ 登录窗；扫码后即可同步群聊。',
      okText: '登录',
      cancelText: '取消',
      onOk: () => launch()
    })
  }

  const logout = (): void => {
    modal.confirm({
      title: '退出登录？',
      content: '会关闭 QQ 与 QCE，并结束当前登录；已同步到本机的聊天记录不受影响。',
      okText: '退出登录',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBusy('logout')
        try {
          const next = await window.api.imQceLogout()
          setStatus(next)
          setLogTail([])
          message.success('已退出登录')
        } catch (error) {
          message.error('退出登录失败：' + errText(error))
        } finally {
          setBusy(null)
        }
      }
    })
  }

  const pickQq = async (): Promise<void> => {
    setBusy('pick')
    try {
      const qqPath = await window.api.imQcePickQq()
      if (qqPath) {
        message.success('已保存 QQ 路径')
        await refresh()
      }
    } catch (error) {
      message.error('选择 QQ 失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const sync = async (): Promise<void> => {
    setBusy('sync')
    try {
      const result = await window.api.imSyncQce({ enableNew: true })
      if (result.online && result.errors.length === 0) message.success(result.message)
      else message.warning(result.message)
      await refresh()
    } catch (error) {
      message.error('QQ 同步失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const phase = status?.phase ?? 'stopped'
  const meta = QCE_PHASE_META[phase]
  const hint = QCE_PHASE_HINT[phase]
  const canLogin =
    !busy && phase !== 'online' && phase !== 'starting' && phase !== 'missing_runtime' && phase !== 'unsupported'
  const canLogout = !busy && (status?.online === true || status?.qqRunning === true)
  const canSync = !busy && status?.online === true

  return (
    <Card size="small" title="QQ" extra={<Tag color={meta.color}>{meta.text}</Tag>}>
      <p className="account-desc">
        InfoAgent 内置 QCE（NapCat）运行集：登录、扫码、退出都在本页完成，不接触 QQ 密码，令牌由 QCE 自己管理。
      </p>
      <Descriptions
        size="small"
        column={1}
        colon={false}
        items={[
          {
            key: 'phase',
            label: '当前状态',
            children: (
              <Typography.Text type={status?.online ? undefined : 'secondary'}>
                {status?.detail ?? '正在检测…'}
              </Typography.Text>
            )
          },
          {
            key: 'runtime',
            label: '运行集',
            children: status?.runtimeVersion ? (
              <Typography.Text code>QCE {status.runtimeVersion}</Typography.Text>
            ) : (
              <Typography.Text type="secondary">未找到</Typography.Text>
            )
          },
          {
            key: 'qq',
            label: 'QQ 路径',
            children: status?.qqPath ? (
              <Typography.Text code ellipsis={{ tooltip: status.qqPath }} style={{ maxWidth: 420 }}>
                {status.qqPath}
              </Typography.Text>
            ) : (
              <Space size={4}>
                <Typography.Text type="secondary">未检测到</Typography.Text>
                <Button size="small" type="link" loading={busy === 'pick'} onClick={() => void pickQq()}>
                  选择 QQ.exe
                </Button>
              </Space>
            )
          },
          {
            key: 'address',
            label: 'QCE 地址',
            children: <Typography.Text code>{status?.baseUrl ?? 'http://127.0.0.1:40653'}</Typography.Text>
          }
        ]}
      />
      <Alert className="account-note" type={hint.type} showIcon message={hint.title} description={hint.body} />
      {phase === 'error' && logTail.length > 0 ? (
        <Collapse
          size="small"
          className="account-note"
          items={[
            {
              key: 'log',
              label: '最近日志',
              children: (
                <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
                  {logTail.join('\n')}
                </Typography.Paragraph>
              )
            }
          ]}
        />
      ) : null}
      <Space wrap className="account-actions">
        <Button
          type="primary"
          icon={<LoginOutlined />}
          loading={busy === 'launch'}
          disabled={!canLogin}
          onClick={requestLaunch}
        >
          登录 QQ
        </Button>
        <Button danger icon={<LogoutOutlined />} loading={busy === 'logout'} disabled={!canLogout} onClick={logout}>
          退出登录
        </Button>
        <Button icon={<SyncOutlined />} loading={busy === 'check'} onClick={() => void check()}>
          检测连接
        </Button>
        <Button icon={<ThunderboltOutlined />} loading={busy === 'sync'} disabled={!canSync} onClick={() => void sync()}>
          从 QQ 同步
        </Button>
        <Button
          type="link"
          size="small"
          icon={<FolderOpenOutlined />}
          onClick={() => void window.api.imQceReveal().catch(() => undefined)}
        >
          打开运行集目录
        </Button>
      </Space>
    </Card>
  )
}

function ZhihuAccountSection() {
  const { message } = AntApp.useApp()
  const [status, setStatus] = useState<ZhihuStatus | null>(null)
  const [busy, setBusy] = useState<'login' | 'sync' | 'logout' | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await window.api.zhihuStatus())
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => message.error('读取知乎状态失败：' + errText(error)))
  }, [message, refresh])

  const connect = async (): Promise<void> => {
    setBusy('login')
    try {
      const result = await window.api.zhihuLogin()
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      await refresh()
    } catch (error) {
      message.error('连接知乎失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const sync = async (): Promise<void> => {
    setBusy('sync')
    try {
      const result = await window.api.zhihuSync(true)
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      await refresh()
    } catch (error) {
      message.error('生成知乎内容失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy('logout')
    try {
      const result = await window.api.zhihuLogout()
      if (result.ok) message.success(result.message)
      else message.error(result.message)
      await refresh()
    } catch (error) {
      message.error('退出知乎账号失败：' + errText(error))
    } finally {
      setBusy(null)
    }
  }

  const state = !status
    ? { color: 'default', text: '读取中…' }
    : status.loggedIn
      ? { color: 'green', text: '已登录' }
      : { color: 'default', text: '未登录' }

  return (
    <Card size="small" title="知乎" extra={<Tag color={state.color}>{state.text}</Tag>}>
      <p className="account-desc">
        连接后使用独立会话读取知乎推荐流，不在应用里保存知乎密码；每天条数在「日报 → 日报设置」中调整。
      </p>
      <Descriptions
        size="small"
        column={1}
        colon={false}
        items={[
          { key: 'lastSync', label: '上次同步', children: formatTime(status?.lastSyncAt ?? null) },
          {
            key: 'today',
            label: '今日生成',
            children: status ? `推荐 ${status.todayRecommendCount} 条 · 反推荐 ${status.todayCounterCount} 条` : '—'
          },
          {
            key: 'target',
            label: '每日目标',
            children: status ? `推荐 ${status.recommendCount} 条 · 反推荐 ${status.counterCount} 条` : '—'
          },
          {
            key: 'tags',
            label: '兴趣标签',
            children: status?.tags.length ? (
              <Space size={[4, 4]} wrap>
                {status.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
              </Space>
            ) : (
              <Typography.Text type="secondary">连接后按「我的关心」自动生成</Typography.Text>
            )
          }
        ]}
      />
      {status?.lastError && (
        <Alert className="account-note" type="warning" showIcon message={status.lastError} />
      )}
      <Space wrap className="account-actions">
        {status?.loggedIn ? (
          <>
            <Button type="primary" icon={<SyncOutlined />} loading={busy === 'sync'} onClick={() => void sync()}>
              立即同步
            </Button>
            <Popconfirm
              title="退出知乎账号？"
              description="只清除本机保存的知乎登录态，已生成的推荐条目和资料不会删除；下次需要重新扫码登录。"
              okText="退出登录"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void logout()}
            >
              <Button danger icon={<DeleteOutlined />} loading={busy === 'logout'}>
                退出登录
              </Button>
            </Popconfirm>
          </>
        ) : (
          <Button type="primary" loading={busy === 'login'} onClick={() => void connect()}>
            扫码连接知乎
          </Button>
        )}
        {!status?.loggedIn && (
          <Typography.Text type="secondary" className="account-hint">
            登录窗口关闭后若未完成扫码，可重新点击连接。
          </Typography.Text>
        )}
      </Space>
    </Card>
  )
}

function AccountCenterPane() {
  return (
    <AntApp>
      <div className="account-center">
        <Card size="small" title="邮箱账号" extra={<Tag>IMAP / OAuth</Tag>}>
          <AccountsInner />
        </Card>
        <QqAccountSection />
        <ZhihuAccountSection />
      </div>
    </AntApp>
  )
}

function AiConfigInner() {
  const { message } = AntApp.useApp()
  const [providers, setProviders] = useState<AIProviderPreset[]>([])
  const [provider, setProvider] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [authorizedAt, setAuthorizedAt] = useState<string | null>(null)
  const [excludeAttachments, setExcludeAttachments] = useState(false)
  const [userGrade, setUserGrade] = useState('')
  const [userMajor, setUserMajor] = useState('')
  const [consentOpen, setConsentOpen] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)
  const pendingPatchRef = useRef<SettingsPatch | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [testResult, setTestResult] = useState<AiTestResult | null>(null)

  const refreshStatus = useCallback(() => {
    window.api.aiStatus().then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    window.api.aiProvidersList().then(setProviders).catch(() => {})
    window.api
      .settingsGet()
      .then((s) => {
        setProvider(s.aiProvider || '')
        setBaseURL(s.aiBaseURL || '')
        setModel(s.aiModel || '')
        setHasKey(s.hasAiKey)
        setAuthorized(s.aiAuthorized)
        setAuthorizedAt(s.aiAuthorizedAt)
        setExcludeAttachments(s.aiExcludeAttachments)
        setUserGrade(s.userGrade || '')
        setUserMajor(s.userMajor || '')
      })
      .catch(() => {})
    refreshStatus()
  }, [refreshStatus])

  const preset = useMemo(() => providers.find((p) => p.id === provider), [providers, provider])
  const keyRequired = preset?.apiKeyRequired ?? true

  const onProviderChange = (id: string) => {
    setProvider(id)
    const p = providers.find((x) => x.id === id)
    if (!p) return
    setBaseURL(p.baseURL)
    setModel(p.models[0] ?? '')
  }

  const currentConfig = (): AiConfigInput => ({
    provider,
    baseURL: baseURL.trim(),
    model: model.trim(),
    apiKey: apiKey.trim()
  })

  const validate = (): AiConfigInput | null => {
    const cfg = currentConfig()
    if (!cfg.baseURL) {
      message.warning('请先填写 baseURL（服务商 API 地址）')
      return null
    }
    if (!cfg.model) {
      message.warning('请填写模型名')
      return null
    }
    if (keyRequired && !cfg.apiKey && !hasKey) {
      message.warning('该服务商需要 API Key')
      return null
    }
    return cfg
  }

  const doTest = async () => {
    const cfg = validate()
    if (!cfg) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.aiTest(cfg)
      setTestResult(result)
      if (result.ok) {
        message.success(
          result.message + (result.latencyMs !== undefined ? '（' + result.latencyMs + 'ms）' : '')
        )
      } else {
        message.error(result.message)
      }
    } catch (error) {
      message.error(errText(error))
    } finally {
      setTesting(false)
    }
  }

  const savePatch = async (patch: SettingsPatch): Promise<void> => {
    setSaving(true)
    try {
      await window.api.settingsSet(patch)
      setHasKey(hasKey || !!patch.aiApiKey)
      setApiKey('')
      message.success('AI 配置已保存')
      refreshStatus()
      void window.api.aiAnalyzeAll().catch(() => {})
    } catch (error) {
      message.error(errText(error))
    } finally {
      setSaving(false)
    }
  }

  const doSave = async () => {
    const cfg = validate()
    if (!cfg) return
    const patch: SettingsPatch = {
      aiProvider: provider,
      aiBaseURL: cfg.baseURL,
      aiModel: cfg.model,
      aiIsLocal: !!preset?.isLocal,
      aiExcludeAttachments: excludeAttachments,
      userGrade: userGrade.trim(),
      userMajor: userMajor.trim()
    }
    if (cfg.apiKey) patch.aiApiKey = cfg.apiKey
    // A2：首次保存先弹授权确认
    if (!authorized) {
      pendingPatchRef.current = patch
      setConsentChecked(false)
      setConsentOpen(true)
      return
    }
    await savePatch(patch)
  }

  const confirmConsent = async () => {
    const patch = pendingPatchRef.current
    if (!patch || !consentChecked) return
    patch.aiAuthorizedFor = provider + '|' + patch.aiBaseURL
    patch.aiAuthorizedAt = new Date().toISOString()
    pendingPatchRef.current = null
    setConsentOpen(false)
    setAuthorized(true)
    setAuthorizedAt(patch.aiAuthorizedAt)
    await savePatch(patch)
  }

  const doRevoke = () => {
    Modal.confirm({
      title: '撤回 AI 授权',
      content: '撤回后将清除已保存的 API Key，AI 分析立即停止，直至你重新授权。已生成的分析结果不受影响。确定撤回？',
      okText: '撤回',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.settingsSet({ aiApiKey: '', aiAuthorizedFor: '', aiAuthorizedAt: '' })
        setHasKey(false)
        setAuthorized(false)
        setAuthorizedAt(null)
        setApiKey('')
        message.success('已撤回 AI 授权并清除 API Key')
        refreshStatus()
      }
    })
  }

  const doAnalyzeAll = async () => {
    setAnalyzing(true)
    try {
      const result = await window.api.aiAnalyzeAll()
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      refreshStatus()
    } catch (error) {
      message.error(errText(error))
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%', maxWidth: 640 }} size="middle">
      <Alert
        type="info"
        showIcon
        message="AI 服务商配置"
        description="结构化分析请求只从本机主进程发出，直连你选择的服务商，不经过第三方中转。API Key 经系统凭据加密后仅保存在本机数据库；首次使用需完成数据授权。"
      />
      <Space wrap>
        <Typography.Text strong>AI 数据授权：</Typography.Text>
        <Tag color={authorized ? 'green' : 'orange'}>{authorized ? '已授权' : '未授权'}</Tag>
        {authorized && authorizedAt ? (
          <Typography.Text type="secondary">授权于 {new Date(authorizedAt).toLocaleString()}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">未授权时无法分析，保存配置时将弹出授权确认</Typography.Text>
        )}
        <Button danger size="small" disabled={!authorized} onClick={doRevoke}>
          撤回授权
        </Button>
      </Space>
      <Form layout="vertical">
        <Form.Item label="服务商">
          <Select
            value={provider || undefined}
            placeholder="选择 AI 服务商"
            options={providers.map((p) => ({ value: p.id, label: p.label }))}
            onChange={onProviderChange}
          />
        </Form.Item>
        <Form.Item label="Base URL" extra={preset?.apiKeyHelp}>
          <Input
            value={baseURL}
            placeholder="OpenAI 兼容端点，如 https://api.deepseek.com/v1"
            onChange={(e) => setBaseURL(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="模型">
          <AutoComplete
            value={model}
            placeholder="选择或输入模型名"
            options={(preset?.models ?? []).map((m) => ({ value: m }))}
            onChange={setModel}
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item label="API Key" required={keyRequired} extra={hasKey && !apiKey.trim() ? '已保存密钥：留空则同端点连通测试复用已保存密钥，不回传密钥。' : undefined}>
          <Input.Password
            value={apiKey}
            placeholder={hasKey ? '已保存（留空则不修改）' : keyRequired ? '请输入 API Key' : '本地端点可留空'}
            autoComplete="new-password"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="附件处理">
          <Checkbox
            checked={excludeAttachments}
            onChange={(e) => setExcludeAttachments(e.target.checked)}
          >
            不读取附件信息（开启后附件文件名也不会发送给 AI，仅分析正文）
          </Checkbox>
        </Form.Item>
        <Form.Item label="适用性上下文（可选）" extra="年级 / 专业将随邮件内容一并提供给 AI，用于判断事项适用对象、为信息流画像打底；可留空。">
          <Space style={{ display: 'flex' }}>
            <Input value={userGrade} placeholder="年级，如 大一" onChange={(e) => setUserGrade(e.target.value)} style={{ width: 160 }} />
            <Input value={userMajor} placeholder="专业，如 计算机科学" onChange={(e) => setUserMajor(e.target.value)} style={{ flex: 1 }} />
          </Space>
        </Form.Item>
      </Form>
      <Space wrap>
        <Button icon={<SyncOutlined />} loading={testing} onClick={doTest}>
          测试连通
        </Button>
        <Button type="primary" loading={saving} onClick={doSave}>
          保存
        </Button>
        <Button icon={<ThunderboltOutlined />} loading={analyzing} onClick={doAnalyzeAll}>
          立即分析待处理邮件
        </Button>
      </Space>
      {status ? (
        <Alert
          type={status.configured ? 'success' : 'warning'}
          showIcon
          message={
            status.configured
              ? '当前配置：' + status.provider + ' / ' + status.model
              : '尚未配置 AI 服务商，邮件分析将保持「待分析」'
          }
          description={
            <Space size="middle">
              <span>待分析 {status.pending}</span>
              <span>已分析 {status.analyzed}</span>
              <span>失败 {status.failed}</span>
              <span>已跳过 {status.skipped}</span>
            </Space>
          }
        />
      ) : null}
      {testResult && (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          message={testResult.ok ? '连通测试成功' : '连通测试未通过'}
          description={
            <Space direction="vertical" size={2}>
              {testResult.keySource && (
                <span>密钥来源：{KEY_SOURCE_LABEL[testResult.keySource] ?? testResult.keySource}</span>
              )}
              {!testResult.ok && testResult.code && (
                <span>错误类别：{TEST_CODE_LABEL[testResult.code] ?? testResult.code}</span>
              )}
              <span>{testResult.message}</span>
            </Space>
          }
        />
      )}
      <Modal
        title="AI 数据使用授权"
        open={consentOpen}
        okText="同意并保存"
        cancelText="取消"
        okButtonProps={{ disabled: !consentChecked }}
        onOk={confirmConsent}
        onCancel={() => setConsentOpen(false)}
      >
        <Typography.Paragraph>
          开启 AI 分析后，待分析邮件的<Typography.Text strong>主题、发件人、正文</Typography.Text>
          （是否包含附件信息取决于你的附件设置）以及你填写的适用性上下文（年级/专业）将发送至所选服务商（{provider || '未选择'}，
          {baseURL || '未填写'}）处理，用于生成分类与事项抽取结果。
        </Typography.Paragraph>
        <Checkbox checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)}>
          我已知悉并同意将邮件内容发送至所选服务商进行分析
        </Checkbox>
      </Modal>
    </Space>
  )
}

/** AI 连接表单本体（设置 →「AI 配置」Tab 的「模型与连接」卡片内渲染） */
export function AiConfigSection() {
  return <AiConfigInner />
}

/** 「AI 配置」Tab：模型与连接表单（原样复用）+ 指向 AI 工作台设置的画像/规则入口 */
function AiConfigPane() {
  return (
    <div className="set-stack">
      <Card className="set-card" title="模型与连接">
        <p className="set-card-sub">对话模型、接口地址与密钥；保存后立即生效。</p>
        <AiConfigSection />
      </Card>
      <Card className="set-card" title="画像与工作规则">
        <p className="set-card-sub">个人画像、行为规则与权限确认在 AI 工作台设置中维护。</p>
        <Button type="link" className="set-link-btn" onClick={() => goToAiSettings()}>
          前往 AI 工作台设置 →
        </Button>
      </Card>
    </div>
  )
}

function ReminderSettingsPane() {
  return (
    <AntApp>
      <ReminderSettingsInner />
    </AntApp>
  )
}

/** A6：提醒偏好设置——通知开关 + 默认提前时间（M7 遗留占位替换为可用表单） */
function ReminderSettingsInner() {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [advance, setAdvance] = useState(30)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const view = await window.api.settingsGet()
        setEnabled(view.reminderEnabled)
        setAdvance(view.reminderAdvanceMinutes)
      } catch (error) {
        message.error('读取提醒设置失败：' + errText(error))
      } finally {
        setLoading(false)
      }
    })()
  }, [message])

  const doSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const view = await window.api.settingsSet({
        reminderEnabled: enabled,
        reminderAdvanceMinutes: advance
      })
      setEnabled(view.reminderEnabled)
      setAdvance(view.reminderAdvanceMinutes)
      message.success('提醒设置已保存')
    } catch (error) {
      message.error('保存提醒设置失败：' + errText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ maxWidth: 640 }}>
      <Alert
        type="info"
        showIcon
        message="提醒开关与默认提前时间"
        description="关闭桌面通知后不再弹出到期提醒；默认提前时间用于在确认带截止时间的事项时自动创建提醒，可逐条手动修改。"
      />
      <Form layout="vertical">
        <Form.Item label="桌面通知">
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)}>
            开启到期桌面通知
          </Checkbox>
        </Form.Item>
        <Form.Item label="默认提前提醒时间" extra="单位：分钟，范围 0～10080（7 天）。">
          <InputNumber
            min={0}
            max={10080}
            step={5}
            value={advance}
            onChange={(value) => setAdvance(value ?? 0)}
            addonAfter="分钟"
          />
        </Form.Item>
      </Form>
      <Space>
        <Button type="primary" loading={loading || saving} onClick={() => void doSave()}>
          保存提醒设置
        </Button>
      </Space>
    </Space>
  )
}

function GeneralPane() {
  return (
    <AntApp>
      <GeneralInner />
    </AntApp>
  )
}

/** P6：常规设置——开机自启动（仅打包版写入 Windows 登录项） */
function GeneralInner() {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [autoLaunch, setAutoLaunch] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const view = await window.api.settingsGet()
        setAutoLaunch(view.autoLaunch)
      } catch (error) {
        message.error('读取常规设置失败：' + errText(error))
      } finally {
        setLoading(false)
      }
    })()
  }, [message])

  const doSave = async (value: boolean): Promise<void> => {
    setSaving(true)
    try {
      const view = await window.api.settingsSet({ autoLaunch: value })
      setAutoLaunch(view.autoLaunch)
      message.success(view.autoLaunch ? '已开启开机自启动' : '已关闭开机自启动')
    } catch (error) {
      message.error('保存开机自启动设置失败：' + errText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ maxWidth: 640 }}>
      <Alert
        type="info"
        showIcon
        message="开机自启动"
        description="开启后，安装版 InfoAgent 将随 Windows 登录自动启动并驻留托盘；开发调试模式不写入系统登录项。"
      />
      <Space>
        <Switch
          checked={autoLaunch}
          loading={loading || saving}
          checkedChildren="开"
          unCheckedChildren="关"
          onChange={(checked) => void doSave(checked)}
        />
        <Typography.Text type="secondary">随 Windows 登录自动启动</Typography.Text>
      </Space>
    </Space>
  )
}

const SETTINGS_TAB_KEYS = ['general', 'accounts', 'ai', 'interest', 'reminder', 'chat', 'manual', 'about'] as const

function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab') ?? 'general'
  const activeKey = SETTINGS_TAB_KEYS.includes(requested as (typeof SETTINGS_TAB_KEYS)[number])
    ? requested
    : 'general'

  const changeTab = (key: string): void => {
    const next = new URLSearchParams(searchParams)
    if (key === 'general') next.delete('tab')
    else next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="set-page">
      <Tabs
        className="set-tabs"
        size="small"
        activeKey={activeKey}
        onChange={changeTab}
        items={[
          {
            key: 'general',
            label: '常规',
            children: <GeneralPane />
          },
          {
            key: 'accounts',
            label: '账号管理',
            children: <AccountCenterPane />
          },
          {
            key: 'ai',
            label: 'AI 配置',
            children: <AiConfigPane />
          },
          {
            key: 'interest',
            label: '我的关心',
            children: <div className="set-card" style={{ padding: 20 }}><TagPreferencesEditor /></div>
          },
          {
            key: 'reminder',
            label: '提醒设置',
            children: <ReminderSettingsPane />
          },
          {
            key: 'chat',
            label: '聊天记录',
            children: (
              <AntApp>
                <div className="set-chat">
                  <ChatPane />
                </div>
              </AntApp>
            )
          },
          {
            key: 'manual',
            label: '用户手册',
            children: <ManualPane />
          },
          {
            key: 'about',
            label: '关于',
            children: <AboutPane />
          }
        ]}
      />
    </div>
  )
}

export const settingsModule: ModuleManifest = {
  id: 'settings',
  title: '设置',
  icon: <SettingOutlined />,
  route: '/settings',
  enabled: true,
  page: () => <SettingsPage />
}
