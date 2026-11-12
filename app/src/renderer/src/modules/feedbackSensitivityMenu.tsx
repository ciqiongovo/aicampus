import { useState } from 'react'
import { App as AntApp, Button, Popover, Segmented, Tag } from 'antd'
import { ControlOutlined } from '@ant-design/icons'
import {
  FEEDBACK_BASE,
  FEEDBACK_SENSITIVITY_OPTIONS,
  feedbackSensitivityMultiplier,
  feedbackSensitivityOption,
  isFeedbackSensitivityLevel
} from '@shared/panel'
import type { FeedbackSensitivityLevel } from '@shared/panel'
import './feedbackSensitivityMenu.css'

export type FeedbackSensitivityKind = 'radar' | 'keyword'

/** 雷达/关键词两张卡片右上角共用的反馈灵敏度菜单；面板里改动立即落库，设置页交给底部保存。 */
export function FeedbackSensitivityMenu({
  kind,
  value,
  onChange,
  persist = false,
  showLabel = false,
  ariaLabel
}: {
  kind: FeedbackSensitivityKind
  value: FeedbackSensitivityLevel
  onChange: (next: FeedbackSensitivityLevel) => void
  persist?: boolean
  showLabel?: boolean
  ariaLabel?: string
}): JSX.Element {
  const { message } = AntApp.useApp()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const option = feedbackSensitivityOption(value)
  const gain = feedbackSensitivityMultiplier(value)
  const title = kind === 'radar' ? '关心雷达灵敏度' : '关键词画像灵敏度'

  const effect = kind === 'radar'
    ? `面板处置单封邮件：单项 ${(FEEDBACK_BASE.radarPanelAct * gain).toFixed(2)}；邮件评级 A/D：单项 ${(FEEDBACK_BASE.radarRating * gain).toFixed(2)}。忽略为负向，归档不改变权重。`
    : `单封邮件：关键词 +${(FEEDBACK_BASE.emailKeyword * gain).toFixed(2)}，14 天内重复再 +${(FEEDBACK_BASE.emailRepeat * gain).toFixed(2)}；单条 QQ：+${(FEEDBACK_BASE.qqKeyword * gain).toFixed(2)}，重复再 +${(FEEDBACK_BASE.qqRepeat * gain).toFixed(2)}。`

  const change = async (next: FeedbackSensitivityLevel): Promise<void> => {
    if (!isFeedbackSensitivityLevel(next) || next === value) return
    onChange(next)
    if (!persist) return
    setSaving(true)
    try {
      await window.api.settingsSet(kind === 'radar' ? { radarSensitivity: next } : { keywordSensitivity: next })
      message.success(`${title}已设为${feedbackSensitivityOption(next).label}`)
    } catch (error) {
      onChange(value)
      message.error('保存灵敏度失败：' + String(error))
    } finally {
      setSaving(false)
    }
  }

  const content = (
    <div className="fsm-pop">
      <div className="fsm-pop-head">
        <strong>{title}</strong>
        <Tag>{option.label} · ×{option.multiplier}</Tag>
      </div>
      <Segmented
        block
        size="small"
        value={value}
        disabled={saving}
        options={FEEDBACK_SENSITIVITY_OPTIONS.map((item) => ({ label: item.label, value: item.level }))}
        onChange={(next) => void change(next as FeedbackSensitivityLevel)}
      />
      <p className="fsm-pop-hint">{option.hint}</p>
      <p className="fsm-pop-effect">{effect}</p>
      <p className="fsm-pop-foot">{persist ? '改动立即生效，只影响之后的新反馈。' : '修改后随底部“保存关心设置”生效，不追溯已有画像。'}</p>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      content={content}
      overlayClassName="fsm-overlay"
    >
      <Button
        type="text"
        size="small"
        className="fsm-trigger"
        icon={<ControlOutlined />}
        loading={saving}
        aria-label={ariaLabel ?? title}
        title={ariaLabel ?? title}
      >
        {showLabel ? '灵敏度' : null}
      </Button>
    </Popover>
  )
}
