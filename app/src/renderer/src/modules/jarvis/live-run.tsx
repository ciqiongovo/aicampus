import { Button, Space } from 'antd'
import { CheckOutlined, CloseOutlined, StopOutlined } from '@ant-design/icons'
import type { AgentRun, AgentStep } from '@shared/workspace'
import { ThoughtsBlock } from './thoughts'
import { prettyArgs, ToolStepsBlock, toolLabel } from './tool-step'

const RISK_META: Record<AgentStep['risk'], { label: string; consequence: string }> = {
  read: { label: '只读', consequence: '仅读取业务数据，不产生写入。' },
  normal: { label: '普通写入', consequence: '执行可撤销的普通写入操作。' },
  high: { label: '高风险', consequence: '高影响操作：提交后可能不可撤销，请核对后确认。' }
}

function ConfirmCard({ step, deciding, onDecide }: {
  step: AgentStep
  deciding: boolean
  onDecide: (approved: boolean) => void
}) {
  const risk = RISK_META[step.risk] ?? RISK_META.high
  return (
    <div className="jarvis-confirm">
      <div className="jarvis-confirm-head">
        <span className="jarvis-confirm-dot" aria-hidden="true" />
        <span className="jarvis-confirm-title">{toolLabel(step.tool)}</span>
        <span className="jarvis-confirm-risk">{risk.label}</span>
      </div>
      <div className="jarvis-confirm-consequence">{risk.consequence}</div>
      <pre className="jarvis-tool-pre jarvis-confirm-args">{prettyArgs(step.args)}</pre>
      <Space size={8} className="jarvis-confirm-actions">
        <Button size="small" type="primary" icon={<CheckOutlined />} loading={deciding} onClick={() => onDecide(true)}>
          批准执行
        </Button>
        <Button size="small" icon={<CloseOutlined />} loading={deciding} onClick={() => onDecide(false)}>
          拒绝
        </Button>
      </Space>
    </div>
  )
}

export function LiveRun({ run, deciding, onDecide, onStop }: {
  run: AgentRun
  deciding: boolean
  onDecide: (stepId: string, approved: boolean) => void
  onStop: () => void
}) {
  const waiting = run.steps.filter((step) => step.status === 'waiting_confirmation')
  const isWaiting = run.status === 'waiting_confirmation' && waiting.length > 0
  const statusText = isWaiting
    ? '等待你的确认'
    : run.status === 'waiting_confirmation'
      ? '等待确认中'
      : '正在执行'

  return (
    <div className="jarvis-live">
      <div className="jarvis-live-head">
        <span className="jarvis-live-status">
          <span className={run.status === 'running' ? 'jarvis-live-dot is-running' : 'jarvis-live-dot'} aria-hidden="true" />
          {statusText}
        </span>
        <Button type="text" size="small" className="jarvis-live-stop" icon={<StopOutlined />} onClick={onStop}>
          停止
        </Button>
      </div>
      <ThoughtsBlock thoughts={run.thoughts} running />
      <ToolStepsBlock steps={run.steps} collapsible />
      {isWaiting && (
        <div className="jarvis-confirm-list">
          {waiting.map((step) => (
            <ConfirmCard
              key={step.id}
              step={step}
              deciding={deciding}
              onDecide={(approved) => onDecide(step.id, approved)}
            />
          ))}
        </div>
      )}
      {run.status === 'running' && (
        <div className="jarvis-waiting" role="status" aria-label="正在处理">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  )
}
