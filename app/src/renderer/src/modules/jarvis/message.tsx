import { PaperClipOutlined } from '@ant-design/icons'
import type { AgentRun, ChatAttachment, ResourceReference, WorkspaceMessage } from '@shared/workspace'
import { AssistantMarkdown, ReferenceChips } from './assistant-markdown'
import { ThoughtsBlock } from './thoughts'
import { ToolStepsBlock } from './tool-step'

function AttachmentChips({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="jarvis-attachments">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className={attachment.status === 'failed' ? 'jarvis-attachment is-failed' : 'jarvis-attachment'}
          title={attachment.name}
        >
          <PaperClipOutlined />
          {attachment.name}
          {attachment.status === 'failed' ? ' · 解析失败' : ''}
        </span>
      ))}
    </div>
  )
}

export function MessageRow({ msg, run, onOpenResource }: {
  msg: WorkspaceMessage
  run?: AgentRun
  onOpenResource: (ref: ResourceReference) => void
}) {
  if (msg.role === 'user') {
    return (
      <div className="jarvis-msg jarvis-msg-user">
        <div className="jarvis-user-stack">
          <div className="jarvis-user-bubble">{msg.content}</div>
          <ReferenceChips references={msg.references} onOpenResource={onOpenResource} />
          <AttachmentChips attachments={msg.attachments} />
        </div>
      </div>
    )
  }
  return (
    <div className="jarvis-msg jarvis-msg-assistant">
      <div className="jarvis-assistant">
        <ThoughtsBlock thoughts={run?.thoughts ?? []} running={false} />
        <ToolStepsBlock steps={run?.steps ?? []} collapsible status={run?.status} />
        <AssistantMarkdown content={msg.content} references={msg.references} onOpenResource={onOpenResource} />
        <AttachmentChips attachments={msg.attachments} />
      </div>
    </div>
  )
}
