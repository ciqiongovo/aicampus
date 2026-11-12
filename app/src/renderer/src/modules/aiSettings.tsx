import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  ArrowLeftOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons'
import type {
  AgentPolicy,
  AgentRule,
  AgentRuleInput,
  MemoryHistoryEntry,
  MemoryItem,
  MemorySourceKind,
  RuleAction,
  RuleActionType,
  RuleCondition,
  RuleEnforcement
} from '@shared/cognition'
import { DEFAULT_AGENT_POLICY, READ_DOMAIN_DEFAULT, RULE_ACTION_TYPES } from '@shared/cognition'
import type { BackgroundJob } from '@shared/workspace'
import './aiSettings.css'

const { Text } = Typography

function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
}

/** 解析记忆审计时间：带 Z/偏移原样解析；无时区旧串按 UTC 处理（不当作本轮刚确认） */
function parseAuditTime(iso: string): Date | null {
  const s = iso.trim()
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(s)
  const d = new Date(hasTz ? s : s + 'Z')
  return Number.isNaN(d.getTime()) ? null : d
}

/** 记忆审计时间：用 policy.timeZone 显示本地时间 + 短时区名 + IANA 时区，可回查 */
function fmtTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—'
  const d = parseAuditTime(iso)
  if (!d) return iso + '（无法解析）'
  if (!timeZone) return d.toLocaleString('zh-CN', { hour12: false })
  const base = d.toLocaleString('zh-CN', { hour12: false, timeZone, timeZoneName: 'short' })
  return base + ' · ' + timeZone
}

const SECTION_OPTIONS = [
  { value: 'background', label: '背景' },
  { value: 'goal', label: '当前目标' },
  { value: 'interest', label: '兴趣关注' },
  { value: 'habit', label: '使用习惯' },
  { value: 'identity', label: '身份' },
  { value: 'general', label: '一般' }
]

function sectionLabel(section: string): string {
  return SECTION_OPTIONS.find((s) => s.value === section)?.label ?? section
}

function sourceKindLabel(kind: MemorySourceKind): string {
  return kind === 'explicit' ? '主动' : '推断'
}

// ---------------------------------------------------------------------------
// 关于我
// ---------------------------------------------------------------------------

function AboutMeCard() {
  const { message } = AntApp.useApp()
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [historyFor, setHistoryFor] = useState<MemoryItem | null>(null)
  const [history, setHistory] = useState<MemoryHistoryEntry[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [editing, setEditing] = useState<MemoryItem | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editSection, setEditSection] = useState('general')
  const [saving, setSaving] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newSection, setNewSection] = useState('general')
  const [showArchived, setShowArchived] = useState(false)
  const [policy, setPolicy] = useState<AgentPolicy>(DEFAULT_AGENT_POLICY)

  const reload = useCallback(async () => {
    try {
      setItems(await window.api.memoryList({ includeArchived: true }))
      setPolicy(await window.api.agentPolicyGet())
    } catch (e) {
      message.error('读取画像失败：' + errText(e))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void reload()
  }, [reload])

  const active = useMemo(() => items.filter((m) => m.status !== 'archived'), [items])
  const archived = useMemo(() => items.filter((m) => m.status === 'archived'), [items])

  const freshnessMs = policy.memoryFreshnessDays * 24 * 60 * 60 * 1000
  const isStale = (m: MemoryItem): boolean => {
    if (!m.lastConfirmedAt) return false
    const t = new Date(m.lastConfirmedAt).getTime()
    return Number.isFinite(t) && Date.now() - t > freshnessMs
  }

  const groups = useMemo(() => {
    const map = new Map<string, MemoryItem[]>()
    for (const m of active) {
      const arr = map.get(m.section) ?? []
      arr.push(m)
      map.set(m.section, arr)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [active])

  // 简短概览只基于「明确表达且仍在新鲜期」的当前事实，candidate/stale 不作为当前事实
  const overview = active.filter((m) => m.sourceKind === 'explicit' && !isStale(m)).map((m) => m.content).join('；')

  const doConfirm = async (id: number) => {
    try {
      await window.api.memoryConfirm(id)
      message.success('已确认这条记忆')
      void reload()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const doArchive = async (id: number) => {
    try {
      await window.api.memoryArchive(id)
      message.success('已停用这条记忆（保留历史）')
      void reload()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const openHistory = async (m: MemoryItem) => {
    try {
      setHistory(await window.api.memoryHistory(m.id))
      setHistoryFor(m)
      setHistoryOpen(true)
    } catch (e) {
      message.error(errText(e))
    }
  }

  const openEdit = (m: MemoryItem) => {
    setEditing(m)
    setEditContent(m.content)
    setEditSection(m.section)
  }

  const saveEdit = async () => {
    if (!editing) return
    setSaving(true)
    try {
      await window.api.memorySave({ id: editing.id, content: editContent, section: editSection })
      message.success('已更新并确认')
      setEditing(null)
      void reload()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const saveNew = async () => {
    if (!newContent.trim()) return
    setSaving(true)
    try {
      await window.api.memorySave({ content: newContent, section: newSection })
      message.success('已新增明确记忆')
      setNewOpen(false)
      setNewContent('')
      setNewSection('general')
      void reload()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const renderMemory = (m: MemoryItem) => (
    <div key={m.id} className="ais-mem">
      <div className="ais-mem-content">{m.content}</div>
      <div className="ais-mem-meta">
        <Tag color={m.sourceKind === 'explicit' ? 'blue' : 'purple'} style={{ marginInlineEnd: 0 }}>
          {sourceKindLabel(m.sourceKind)}
        </Tag>
        {m.candidate && <Tag color="orange" style={{ marginInlineEnd: 0 }}>待确认</Tag>}
        {isStale(m) && <Tag color="volcano" style={{ marginInlineEnd: 0 }}>待重确认</Tag>}
        {m.manualEdited && <Tag color="cyan" style={{ marginInlineEnd: 0 }}>人工编辑</Tag>}
        <span className="ais-mem-version">v{m.revision}</span>
      </div>
      <div className="ais-mem-times">
        <span>记录 {fmtTime(m.recordedAt, policy.timeZone)}</span>
        <span className="ais-mem-times-sep">·</span>
        <span>最后确认 {fmtTime(m.lastConfirmedAt, policy.timeZone)}</span>
      </div>
      <div className="ais-mem-source">
        <Text type="secondary" style={{ fontSize: 12 }}>
          来源：{m.sourceRef.type}{m.sourceRef.label ? ' · ' + m.sourceRef.label : ''}
        </Text>
        {m.sourceRef.excerpt && (
          <Tooltip title={m.sourceRef.excerpt}>
            <Text type="secondary" className="ais-mem-excerpt">证据</Text>
          </Tooltip>
        )}
      </div>
      <div className="ais-mem-actions">
        {m.candidate && (
          <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => void doConfirm(m.id)}>确认</Button>
        )}
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(m)}>编辑</Button>
        <Button size="small" icon={<HistoryOutlined />} onClick={() => void openHistory(m)}>版本</Button>
        {m.status !== 'archived' && (
          <Popconfirm
            title="停用这条记忆？"
            description="停用后保留历史，不再参与当前个性化。"
            okText="停用"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void doArchive(m.id)}
          >
            <Button size="small" danger icon={<StopOutlined />}>停用</Button>
          </Popconfirm>
        )}
      </div>
    </div>
  )

  return (
    <Card
      title="关于我"
      extra={<Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setNewOpen(true)}>新增记忆</Button>}
      className="ais-card"
    >
      <div className="ais-mem-overview">
        <Text type="secondary">简短概览：</Text>
        <Text>{overview || '暂无已确认且新鲜的明确信息，聊天的明确表达会记录到这里。'}</Text>
        <div className="ais-mem-fresh-note">
          <Text type="secondary" style={{ fontSize: 12 }}>
            新鲜期 {policy.memoryFreshnessDays} 天（可在「规则与权限」中配置）：超过新鲜期的已确认记忆标记「待重确认」，未确认推断标记「待确认」，二者均不作为当前事实使用。
          </Text>
        </div>
      </div>
      {loading ? (
        <div className="ais-center"><Text type="secondary">读取中…</Text></div>
      ) : active.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有结构化画像" />
      ) : (
        groups.map(([section, mems]) => (
          <div key={section} className="ais-mem-section">
            <div className="ais-mem-section-title">{sectionLabel(section)}（{mems.length}）</div>
            <div className="ais-mem-grid">
              {mems.map(renderMemory)}
            </div>
          </div>
        ))
      )}

      {archived.length > 0 && (
        <div className="ais-mem-archived">
          <Button type="link" size="small" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '收起' : '展开'}已停用记忆（{archived.length}）
          </Button>
          {showArchived && (
            <div className="ais-mem-grid">
              {archived.map((m) => (
                <div key={m.id} className="ais-mem ais-mem-archived-item">
                  <div className="ais-mem-content">{m.content}</div>
                  <div className="ais-mem-times">
                    <span>记录 {fmtTime(m.recordedAt, policy.timeZone)}</span>
                  </div>
                  <Button size="small" icon={<HistoryOutlined />} onClick={() => void openHistory(m)}>版本</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal title="新增明确记忆" rootClassName="ais-modal" open={newOpen} okText="保存" cancelText="取消" confirmLoading={saving} onOk={() => void saveNew()} onCancel={() => setNewOpen(false)}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary">人工录入视为「明确表达」，保存后即已确认。</Text>
          <Input.TextArea value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder="例如：我在准备研究生入学考试" autoSize={{ minRows: 2, maxRows: 5 }} />
          <Select value={newSection} onChange={setNewSection} options={SECTION_OPTIONS} style={{ width: '100%' }} />
        </Space>
      </Modal>

      <Modal title="编辑记忆" rootClassName="ais-modal" open={editing !== null} okText="保存并确认" cancelText="取消" confirmLoading={saving} onOk={() => void saveEdit()} onCancel={() => setEditing(null)}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary">编辑后内容作为新版本，旧版本保留在「版本」中。</Text>
          <Input.TextArea value={editContent} onChange={(e) => setEditContent(e.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} />
          <Select value={editSection} onChange={setEditSection} options={SECTION_OPTIONS} style={{ width: '100%' }} />
        </Space>
      </Modal>

      <Drawer
        title={historyFor ? '版本历史：' + (historyFor.content.slice(0, 30)) : '版本历史'}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        width={480}
      >
        {history.length === 0 && <Empty description="无版本记录" />}
        <div className="ais-history-list">
          {history.map((h) => (
            <div key={h.id} className="ais-history-entry">
              <div className="ais-history-head">
                <Tag color={h.changeKind === 'confirm' ? 'green' : h.changeKind === 'archive' ? 'default' : 'blue'}>
                  {h.changeKind === 'create' ? '新建' : h.changeKind === 'update' ? '更新' : h.changeKind === 'confirm' ? '仅确认' : h.changeKind === 'promote' ? '转确认' : '停用'}
                </Tag>
                <span className="ais-history-version">v{h.revision}</span>
                <span className="ais-history-time">{fmtTime(h.changedAt, policy.timeZone)}</span>
              </div>
              <div className="ais-history-content">{h.content}</div>
              <div className="ais-history-meta">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {sourceKindLabel(h.sourceKind)} · 记录 {fmtTime(h.recordedAt, policy.timeZone)} · 确认 {fmtTime(h.lastConfirmedAt, policy.timeZone)} · {h.changedBy}
                </Text>
              </div>
            </div>
          ))}
        </div>
      </Drawer>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 工作规则与权限
// ---------------------------------------------------------------------------

const JOB_STATUS_META: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '待处理' },
  running: { color: 'processing', text: '处理中' },
  done: { color: 'success', text: '完成' },
  failed: { color: 'error', text: '失败' },
  conflict: { color: 'warning', text: '冲突待处理' },
  waiting_confirmation: { color: 'warning', text: '待授权' }
}

function TagBucket({ label, items, color, onChange }: { label: string; items: string[]; color: string; onChange: (next: string[]) => void }) {
  const [text, setText] = useState('')
  const add = () => {
    const v = text.trim()
    if (!v) return
    if (!items.includes(v)) onChange([...items, v])
    setText('')
  }
  return (
    <div className="ais-bucket">
      <div className="ais-bucket-label">{label}</div>
      <div className="ais-bucket-tags">
        {items.map((t) => (
          <Tag key={t} closable color={color} onClose={() => onChange(items.filter((x) => x !== t))}>{t}</Tag>
        ))}
        {items.length === 0 && <Text type="secondary">（空）</Text>}
      </div>
      <div className="ais-bucket-add">
        <Input size="small" value={text} onChange={(e) => setText(e.target.value)} onPressEnter={add} placeholder="添加操作名，如 create_item" />
        <Button size="small" onClick={add}>添加</Button>
      </div>
    </div>
  )
}

function ruleActionSummary(rule: AgentRule): string {
  return rule.action.type + (rule.action.params && Object.keys(rule.action.params).length ? ' ' + JSON.stringify(rule.action.params) : '')
}

function RulesAndPolicyCard() {
  const { message } = AntApp.useApp()
  const [policy, setPolicy] = useState<AgentPolicy>(DEFAULT_AGENT_POLICY)
  const [rules, setRules] = useState<AgentRule[]>([])
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [loading, setLoading] = useState(true)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [ruleId, setRuleId] = useState<number | null>(null)
  const [ruleName, setRuleName] = useState('')
  const [ruleDesc, setRuleDesc] = useState('')
  const [ruleScope, setRuleScope] = useState('global')
  const [ruleEnforcement, setRuleEnforcement] = useState<RuleEnforcement>('mandatory')
  const [ruleEnabled, setRuleEnabled] = useState(true)
  const [ruleConditions, setRuleConditions] = useState<RuleCondition[]>([])
  const [ruleActionType, setRuleActionType] = useState<RuleActionType>('route_info')
  const [ruleActionParams, setRuleActionParams] = useState('')
  const [ruleSaving, setRuleSaving] = useState(false)
  const [retryingId, setRetryingId] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      setPolicy(await window.api.agentPolicyGet())
      setRules(await window.api.agentRulesList())
      setJobs(await window.api.agentBackgroundList())
    } catch (e) {
      message.error('读取规则与权限失败：' + errText(e))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void reload()
  }, [reload])

  const savePolicy = async () => {
    setSavingPolicy(true)
    try {
      const res = await window.api.agentPolicySet(policy)
      if (res.policy) setPolicy(res.policy)
      message.success('权限策略已保存')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSavingPolicy(false)
    }
  }

  const toggleDomain = (domain: string, checked: boolean) => {
    setPolicy((p) => ({
      ...p,
      readDomains: checked ? (p.readDomains.includes(domain) ? p.readDomains : [...p.readDomains, domain]) : p.readDomains.filter((d) => d !== domain)
    }))
  }

  const setBucket = (key: 'writeAuto' | 'writeConfirm' | 'writeDeny', next: string[]) => {
    setPolicy((p) => {
      if (key === 'writeAuto') return { ...p, writeAuto: next }
      if (key === 'writeConfirm') return { ...p, writeConfirm: next }
      return { ...p, writeDeny: next }
    })
  }

  const openNewRule = () => {
    setRuleId(null)
    setRuleName('')
    setRuleDesc('')
    setRuleScope('global')
    setRuleEnforcement('mandatory')
    setRuleEnabled(true)
    setRuleConditions([])
    setRuleActionType('route_info')
    setRuleActionParams('')
    setRuleModalOpen(true)
  }

  const openEditRule = (r: AgentRule) => {
    setRuleId(r.id)
    setRuleName(r.name)
    setRuleDesc(r.description)
    setRuleScope(r.scope)
    setRuleEnforcement(r.enforcement)
    setRuleEnabled(r.enabled)
    setRuleConditions(r.conditions.map((c) => ({ ...c })))
    setRuleActionType(r.action.type)
    setRuleActionParams(r.action.params ? JSON.stringify(r.action.params) : '')
    setRuleModalOpen(true)
  }

  const saveRule = async () => {
    if (!ruleName.trim()) {
      message.warning('请填写规则名称')
      return
    }
    let params: RuleAction['params']
    if (ruleActionParams.trim()) {
      try {
        params = JSON.parse(ruleActionParams) as RuleAction['params']
      } catch {
        message.warning('动作参数不是合法 JSON')
        return
      }
    }
    const input: AgentRuleInput = {
      id: ruleId ?? undefined,
      name: ruleName.trim(),
      description: ruleDesc.trim() || undefined,
      scope: ruleScope.trim() || 'global',
      enforcement: ruleEnforcement,
      enabled: ruleEnabled,
      conditions: ruleConditions.filter((c) => c.field.trim()),
      action: { type: ruleActionType, params },
      modifiedBy: 'user'
    }
    setRuleSaving(true)
    try {
      await window.api.agentRuleSave(input)
      message.success('规则已保存')
      setRuleModalOpen(false)
      void reload()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setRuleSaving(false)
    }
  }

  const deleteRule = async (id: number) => {
    try {
      await window.api.agentRuleDelete(id)
      message.success('规则已删除')
      void reload()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const saveRuleToggle = async (r: AgentRule) => {
    try {
      await window.api.agentRuleSave({
        id: r.id,
        scope: r.scope,
        name: r.name,
        description: r.description || undefined,
        enforcement: r.enforcement,
        conditions: r.conditions,
        action: r.action,
        enabled: !r.enabled,
        modifiedBy: 'user'
      })
      void reload()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const retryJob = async (id: number) => {
    setRetryingId(id)
    try {
      setJobs(await window.api.agentBackgroundRetry(id))
      message.success('已重试后台任务')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setRetryingId(null)
    }
  }

  const addCondition = () => {
    setRuleConditions((c) => [...c, { field: '', op: 'contains', value: '' }])
  }

  const updateCondition = (idx: number, patch: Partial<RuleCondition>) => {
    setRuleConditions((c) => c.map((cond, i) => (i === idx ? { ...cond, ...patch } : cond)))
  }

  const removeCondition = (idx: number) => {
    setRuleConditions((c) => c.filter((_, i) => i !== idx))
  }

  return (
    <Card title="工作规则与权限" className="ais-card">
      {loading ? (
        <div className="ais-center"><Text type="secondary">读取中…</Text></div>
      ) : (
        <>
          <div className="ais-subsection">
            <div className="ais-subsection-title">数据读范围</div>
            <Alert type="info" showIcon message="Agent 只能检索这里勾选的业务数据域；模型不能自行扩大权限。" />
            <div className="ais-domain-list">
              {READ_DOMAIN_DEFAULT.map((d) => (
                <Checkbox key={d} checked={policy.readDomains.includes(d)} onChange={(e) => toggleDomain(d, e.target.checked)}>
                  {d}
                </Checkbox>
              ))}
              {policy.readDomains.filter((d) => !READ_DOMAIN_DEFAULT.includes(d as (typeof READ_DOMAIN_DEFAULT)[number])).map((d) => (
                <Tag key={d} closable onClose={() => toggleDomain(d, false)}>{d}</Tag>
              ))}
            </div>
          </div>

          <div className="ais-subsection">
            <div className="ais-subsection-title">写入分级确认</div>
            <Alert type="info" showIcon message="普通可撤销写入默认自动执行；高风险（删除/对外发送等）默认确认；默认不禁止。权限只能由你在设置中修改。" />
            <TagBucket label="自动执行（普通写入）" items={policy.writeAuto} color="green" onChange={(n) => setBucket('writeAuto', n)} />
            <TagBucket label="需确认（高风险）" items={policy.writeConfirm} color="orange" onChange={(n) => setBucket('writeConfirm', n)} />
            <TagBucket label="明确禁止" items={policy.writeDeny} color="red" onChange={(n) => setBucket('writeDeny', n)} />
          </div>

          <div className="ais-subsection">
            <div className="ais-subsection-title">学习、后台与时间</div>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space size={24}>
                <span>画像学习 <Switch checked={policy.learningEnabled} onChange={(v) => setPolicy((p) => ({ ...p, learningEnabled: v }))} /></span>
                <span>后台自动处理 <Switch checked={policy.backgroundEnabled} onChange={(v) => setPolicy((p) => ({ ...p, backgroundEnabled: v }))} /></span>
              </Space>
              <Space size={16}>
                <span>新鲜期（天）</span>
                <InputNumber min={1} max={3650} value={policy.memoryFreshnessDays} onChange={(v) => setPolicy((p) => ({ ...p, memoryFreshnessDays: v ?? 30 }))} />
                <span>时区</span>
                <Input style={{ width: 180 }} value={policy.timeZone} onChange={(e) => setPolicy((p) => ({ ...p, timeZone: e.target.value }))} placeholder="Asia/Shanghai" />
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>新鲜期不是硬编码的 30 天；相关旧话题超过新鲜期再次出现时，会先告知旧认知并询问是否仍成立。</Text>
            </Space>
          </div>

          <div className="ais-subsection-actions">
            <Button type="primary" loading={savingPolicy} onClick={() => void savePolicy()}>保存权限策略</Button>
          </div>

          <div className="ais-subsection">
            <div className="ais-subsection-title">
              长期规则
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openNewRule}>新增规则</Button>
            </div>
            {rules.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无长期规则" />
            ) : (
              <div className="ais-rule-list">
                {rules.map((r) => (
                  <div key={r.id} className="ais-rule">
                    <div className="ais-rule-main">
                      <div className="ais-rule-head">
                        <Text strong>{r.name}</Text>
                        <Tag color={r.enforcement === 'mandatory' ? 'red' : 'blue'} style={{ marginInlineEnd: 0 }}>
                          {r.enforcement === 'mandatory' ? '强制' : '偏好'}
                        </Tag>
                        <Tag style={{ marginInlineEnd: 0 }}>{r.scope}</Tag>
                      </div>
                      {r.description && <div className="ais-rule-desc">{r.description}</div>}
                      <div className="ais-rule-action">
                        <Text type="secondary" style={{ fontSize: 12 }}>{ruleActionSummary(r)}</Text>
                      </div>
                    </div>
                    <div className="ais-rule-side">
                      <Switch size="small" checked={r.enabled} onChange={() => void saveRuleToggle(r)} />
                      <Button size="small" icon={<EditOutlined />} onClick={() => openEditRule(r)} />
                      <Popconfirm title="删除这条规则？" onConfirm={() => void deleteRule(r.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ais-subsection">
            <div className="ais-subsection-title">
              后台处理记录
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>
            </div>
            <Button type="link" size="small" onClick={() => setJobsOpen((v) => !v)}>
              {jobsOpen ? '收起' : '展开'}后台任务（{jobs.length}）
            </Button>
            {jobsOpen && (
              jobs.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无后台任务" />
              ) : (
                <div className="ais-jobs-list">
                  {jobs.map((j) => {
                    const meta = JOB_STATUS_META[j.status] ?? { color: 'default', text: j.status }
                    const needsAttention = j.status === 'conflict' || j.status === 'waiting_confirmation'
                    return (
                      <div key={j.id} className="ais-job">
                        <div className="ais-job-head">
                          <Text className="ais-job-key">{j.sourceKey}</Text>
                          <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>
                          <span className="ais-job-time">{fmtTime(j.updatedAt)}</span>
                          <span className="ais-job-attempts">第 {j.attempts} 次</span>
                        </div>
                        {j.result && <div className="ais-job-result">{j.result}</div>}
                        {needsAttention && (
                          <Alert type="warning" showIcon message="该后台任务需要处理：请在上方调整规则，或回到 JARVIS 交给 AI 处理。" />
                        )}
                        <Button size="small" icon={<ReloadOutlined />} loading={retryingId === j.id} onClick={() => void retryJob(j.id)}>重试</Button>
                      </div>
                    )
                  })}
                </div>
              )
            )}
          </div>
        </>
      )}

      <Modal rootClassName="ais-modal" title={ruleId === null ? '新增规则' : '编辑规则'} open={ruleModalOpen} okText="保存" cancelText="取消" confirmLoading={ruleSaving} onOk={() => void saveRule()} onCancel={() => setRuleModalOpen(false)} width={620}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space style={{ width: '100%' }}>
            <span style={{ width: 60 }}>名称</span>
            <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="规则名称" />
          </Space>
          <Space style={{ width: '100%', alignItems: 'flex-start' }}>
            <span style={{ width: 60 }}>说明</span>
            <Input.TextArea value={ruleDesc} onChange={(e) => setRuleDesc(e.target.value)} autoSize={{ minRows: 1, maxRows: 3 }} />
          </Space>
          <Space style={{ width: '100%' }}>
            <span style={{ width: 60 }}>范围</span>
            <Input value={ruleScope} onChange={(e) => setRuleScope(e.target.value)} placeholder="mail / item / info / global …" />
            <span>强制</span>
            <Select value={ruleEnforcement} onChange={setRuleEnforcement} options={[{ value: 'mandatory', label: '强制' }, { value: 'preference', label: '偏好' }]} style={{ width: 110 }} />
            <span>启用</span>
            <Switch checked={ruleEnabled} onChange={setRuleEnabled} />
          </Space>
          <div>
            <div className="ais-subsection-title">
              条件（AND）
              <Button size="small" icon={<PlusOutlined />} onClick={addCondition}>添加条件</Button>
            </div>
            {ruleConditions.length === 0 && <Text type="secondary">无条件（始终匹配）</Text>}
            {ruleConditions.map((c, i) => (
              <div key={i} className="ais-condition-row">
                <Input size="small" value={c.field} onChange={(e) => updateCondition(i, { field: e.target.value })} placeholder="字段" style={{ width: 120 }} />
                <Select size="small" value={c.op} onChange={(v) => updateCondition(i, { op: v })} options={[
                  { value: 'eq', label: '等于' }, { value: 'neq', label: '不等于' }, { value: 'contains', label: '包含' },
                  { value: 'missing', label: '缺失' }, { value: 'present', label: '存在' }
                ]} style={{ width: 100 }} />
                <Input size="small" value={c.value ?? ''} onChange={(e) => updateCondition(i, { value: e.target.value })} placeholder="值" disabled={c.op === 'missing' || c.op === 'present'} />
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeCondition(i)} />
              </div>
            ))}
          </div>
          <div>
            <div className="ais-subsection-title">动作</div>
            <Space style={{ width: '100%' }}>
              <span>类型</span>
              <Select value={ruleActionType} onChange={setRuleActionType} options={RULE_ACTION_TYPES.map((t) => ({ value: t, label: t }))} style={{ width: 220 }} />
            </Space>
            <Space style={{ width: '100%', alignItems: 'flex-start', marginTop: 8 }}>
              <span>参数</span>
              <Input.TextArea value={ruleActionParams} onChange={(e) => setRuleActionParams(e.target.value)} placeholder='JSON，如 {"destination":"keep"}' autoSize={{ minRows: 1, maxRows: 4 }} />
            </Space>
          </div>
        </Space>
      </Modal>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

function AiSettingsInner() {
  const navigate = useNavigate()
  return (
    <div className="ais-page">
      <div className="ais-header">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/jarvis')}>返回 JARVIS</Button>
        <div>
          <div className="ais-header-title">AI 设置</div>
          <div className="ais-header-sub">画像、工作规则与权限</div>
        </div>
      </div>
      <div className="ais-notice">
        <span className="ais-notice-text">模型与连接已移至 设置 → AI 配置。</span>
        <Button type="link" size="small" className="ais-link-btn" onClick={() => navigate('/settings')}>
          去设置 →
        </Button>
      </div>
      <div className="ais-body">
        <AboutMeCard />
        <RulesAndPolicyCard />
      </div>
    </div>
  )
}

export function AiSettingsPage() {
  return (
    <AntApp>
      <AiSettingsInner />
    </AntApp>
  )
}
