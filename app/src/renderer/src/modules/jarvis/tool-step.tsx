import { useState } from 'react'
import { DownOutlined } from '@ant-design/icons'
import type { AgentRun, AgentStep } from '@shared/workspace'
import { isResourceKind, RESOURCE_LABEL } from './resources'

/** 真实工具名与历史名并存：新运行使用后者，旧运行记录仍能显示中文名。 */
export const TOOL_LABEL: Record<string, string> = {
  search: '搜索业务数据',
  read: '读取资源详情',
  search_resources: '搜索业务数据',
  read_resource: '读取资源详情',
  search_memories: '检索相关记忆',
  search_chat: '搜索历史消息',
  read_chat: '读取历史消息',
  create_item: '创建事项',
  update_item: '更新事项',
  delete_item: '删除事项',
  create_reminder: '创建提醒',
  delete_reminder: '删除提醒',
  mail_flags: '更新邮件状态',
  route_info: '分流信息',
  route_article: '处理日报资讯',
  set_category: '更新行动分类',
  save_info: '保存信息',
  require_deadline: '截止日期校验',
  learn_memory: '记录画像记忆',
  save_memory: '写入画像记忆',
  reconfirm_memory: '重确认记忆',
  delete_memory: '停用记忆',
  propose_rule: '提议长期规则',
  send_email: '对外发送',
  archive: '归档',
  notify: '通知'
}

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool
}

export function prettyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args ?? '')
  }
}

function prettyResult(result: string): string {
  const trimmed = result.trim()
  if (!trimmed) return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string') return parsed
    return JSON.stringify(parsed, null, 2)
  } catch {
    return result
  }
}

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function idArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return ''
}

function boolArg(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key]
  return typeof value === 'boolean' ? value : null
}

function clip(value: string, max = 60): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? normalized.slice(0, max) + '…' : normalized
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function kindLabel(value: string): string {
  return isResourceKind(value) ? RESOURCE_LABEL[value] : value
}

/** 一行参数摘要：优先讲清对象与动作，未知工具退化为第一个文本参数。 */
export function stepSummary(step: AgentStep): string {
  const args = step.args
  const id = idArg(args, 'id')
  switch (step.tool) {
    case 'search': {
      const keyword = textArg(args, 'keyword')
      if (keyword) return `搜索「${clip(keyword)}」`
      const domain = textArg(args, 'domain')
      if (domain) return `浏览${domain === 'all' ? '全部业务数据' : kindLabel(domain)}`
      return '搜索业务数据'
    }
    case 'read': {
      const kind = textArg(args, 'kind')
      if (kind && id) return `读取${kindLabel(kind)} #${id}`
      return id ? `读取资源 #${id}` : '读取资源详情'
    }
    case 'search_resources':
    case 'read_resource':
      return step.tool === 'read_resource' ? '读取资源详情' : '搜索业务数据'
    case 'create_item': {
      const title = textArg(args, 'title')
      return title ? `创建事项「${clip(title)}」` : '创建事项'
    }
    case 'update_item': {
      const title = textArg(args, 'title')
      if (title) return `更新事项「${clip(title)}」`
      return id ? `更新事项 #${id}` : '更新事项'
    }
    case 'delete_item':
      return id ? `删除事项 #${id}` : '删除事项'
    case 'create_reminder': {
      const itemId = idArg(args, 'itemId')
      if (itemId) return `为事项 #${itemId} 设置提醒`
      const remindAt = textArg(args, 'remindAt')
      return remindAt ? `设置提醒 ${remindAt}` : '设置提醒'
    }
    case 'delete_reminder':
      return id ? `删除提醒 #${id}` : '删除提醒'
    case 'mail_flags': {
      const parts: string[] = []
      if (id) parts.push(`标记邮件 #${id}`)
      const unread = boolArg(args, 'unread')
      if (unread !== null) parts.push(unread ? '标为未读' : '标为已读')
      const starred = boolArg(args, 'starred')
      if (starred !== null) parts.push(starred ? '加星' : '取消星标')
      return parts.length > 0 ? parts.join(' · ') : '更新邮件状态'
    }
    case 'route_info': {
      const infoId = idArg(args, 'infoId')
      const destination = textArg(args, 'destination')
      if (infoId) return `分流信息 #${infoId}${destination ? ` 到 ${destination}` : ''}`
      return '分流信息'
    }
    case 'route_article': {
      const destination = textArg(args, 'destination')
      return id ? `处理资讯 #${id}${destination ? ` · ${destination}` : ''}` : '处理日报资讯'
    }
    case 'set_category': {
      const kind = textArg(args, 'kind')
      const category = textArg(args, 'category')
      if (kind && id) return `更新${kindLabel(kind)} #${id} 分类${category ? ` 为「${clip(category, 30)}」` : ''}`
      return '更新行动分类'
    }
    case 'save_info': {
      const title = textArg(args, 'title')
      return title ? `保存信息「${clip(title)}」` : '保存信息'
    }
    case 'search_memories': {
      const query = textArg(args, 'query')
      return query ? `检索记忆「${clip(query)}」` : '检索相关记忆'
    }
    case 'search_chat': {
      const keyword = textArg(args, 'keyword')
      return keyword ? `搜索会话「${clip(keyword)}」` : '搜索历史消息'
    }
    case 'read_chat': {
      const messageId = textArg(args, 'messageId')
      return messageId ? `读取消息 #${messageId}` : '读取历史消息'
    }
    case 'learn_memory': {
      const field = textArg(args, 'field')
      return field ? `记录偏好 ${clip(field, 40)}` : '记录画像记忆'
    }
    case 'reconfirm_memory':
      return id ? `重确认记忆 #${id}` : '重确认记忆'
    case 'propose_rule': {
      const title = textArg(args, 'title') || textArg(args, 'name')
      return title ? `提议规则「${clip(title)}」` : '提议长期规则'
    }
    default: {
      const pairs = Object.entries(args)
        .map(([key, value]) => [key, clip(scalar(value), 30)] as const)
        .filter(([, value]) => value.length > 0)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${value}`)
      return pairs.length > 0 ? clip(pairs.join(' / '), 60) : '执行操作'
    }
  }
}

const STATUS_CLASS: Record<AgentStep['status'], string> = {
  completed: 'is-completed',
  failed: 'is-failed',
  waiting_confirmation: 'is-waiting',
  denied: 'is-denied'
}

const STATUS_TEXT: Record<AgentStep['status'], string> = {
  completed: '已完成',
  failed: '失败',
  waiting_confirmation: '等待确认',
  denied: '已拒绝'
}

const RUN_STATUS_TEXT: Record<AgentRun['status'], string> = {
  running: '运行中',
  waiting_confirmation: '等待确认',
  completed: '任务完成',
  failed: '任务失败',
  cancelled: '已停止'
}

export function ToolStepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false)
  const result = open ? prettyResult(step.result) : ''
  return (
    <div className={open ? 'jarvis-tool-item is-open' : 'jarvis-tool-item'}>
      <button
        type="button"
        className="jarvis-tool-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={`jarvis-tool-dot ${STATUS_CLASS[step.status]}`}
          title={STATUS_TEXT[step.status]}
          aria-label={STATUS_TEXT[step.status]}
        />
        <span className="jarvis-tool-name">{toolLabel(step.tool)}</span>
        <span className="jarvis-tool-summary">{stepSummary(step)}</span>
        <span className="jarvis-tool-action">{open ? '收起' : '查看'}</span>
      </button>
      {open && (
        <div className="jarvis-tool-panel">
          <div className="jarvis-tool-section">
            <div className="jarvis-tool-label">参数</div>
            <pre className="jarvis-tool-pre">{prettyArgs(step.args)}</pre>
          </div>
          <div className="jarvis-tool-section">
            <div className="jarvis-tool-label">结果</div>
            {result ? <pre className="jarvis-tool-pre">{result}</pre> : <div className="jarvis-tool-empty">无返回内容</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export function ToolStepsBlock({ steps, collapsible = false, status }: { steps: AgentStep[]; collapsible?: boolean; status?: AgentRun['status'] }) {
  const [collapsed, setCollapsed] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className="jarvis-tools" aria-label="工具调用">
      {collapsible && (
        <button
          type="button"
          className="jarvis-tools-head"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>运行记录 · {steps.length} 步</span>
          <span className="jarvis-tools-head-action">
            {status && <span className={'jarvis-tools-status is-' + status}>{RUN_STATUS_TEXT[status]}</span>}
            {collapsed ? '展开' : '收起'}
            <DownOutlined rotate={collapsed ? -90 : 0} />
          </span>
        </button>
      )}
      {!collapsed &&
        steps.map((step) => (
          <ToolStepRow key={step.id} step={step} />
        ))}
    </div>
  )
}
