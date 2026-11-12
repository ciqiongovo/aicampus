import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentThought } from '@shared/workspace'

interface ThoughtsBlockProps {
  thoughts: AgentThought[]
  running: boolean
}

/** 同一 seq 在流式过程中会被反复写库，这里按 seq 去重并只保留最后一条内容。 */
function normalizeThoughts(thoughts: AgentThought[]): AgentThought[] {
  const bySeq = new Map<number, AgentThought>()
  for (const thought of thoughts) {
    if (!thought.content.trim()) continue
    bySeq.set(thought.seq, thought)
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq)
}

function lastLine(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

function ThoughtItems({ items }: { items: AgentThought[] }) {
  return (
    <>
      {items.map((thought, index) => (
        <p className="jarvis-thought-item" key={thought.id}>
          <span className="jarvis-thought-seq">{String(index + 1).padStart(2, '0')}</span>
          <span className="jarvis-thought-text">{thought.content}</span>
        </p>
      ))}
    </>
  )
}

export function ThoughtsBlock({ thoughts, running }: ThoughtsBlockProps) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const items = useMemo(() => normalizeThoughts(thoughts), [thoughts])

  // 运行中展开后跟随最新内容滚动。
  useEffect(() => {
    if (!running || !open) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [running, open, items])

  if (items.length === 0) return null

  if (running) {
    const latest = items[items.length - 1]
    const preview = lastLine(latest.content)
    return (
      <div className="jarvis-thought-live-wrap">
        <button
          type="button"
          className="jarvis-thought-live"
          aria-expanded={open}
          title={open ? '收起完整思考' : '展开完整思考'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="jarvis-thought-rail" aria-hidden="true" />
          <span className="jarvis-thought-label">思考中</span>
          <span className="jarvis-thought-preview" title={preview} aria-live="polite">
            {preview}
          </span>
          <span className={open ? 'jarvis-chevron is-open' : 'jarvis-chevron'} aria-hidden="true" />
        </button>
        {open && (
          <div className="jarvis-thoughts-body jarvis-live-thoughts-body" ref={bodyRef}>
            <ThoughtItems items={items} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="jarvis-thoughts">
      <button
        type="button"
        className="jarvis-thoughts-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="jarvis-thoughts-title">思考过程 · {items.length} 段</span>
        <span className={open ? 'jarvis-chevron is-open' : 'jarvis-chevron'} aria-hidden="true" />
      </button>
      {open && (
        <div className="jarvis-thoughts-body">
          <ThoughtItems items={items} />
        </div>
      )}
    </div>
  )
}
