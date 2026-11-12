import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ResourceKind, ResourceReference } from '@shared/workspace'
import { isResourceKind, RESOURCE_LABEL } from './resources'

interface AssistantMarkdownProps {
  content: string
  references: ResourceReference[]
  onOpenResource: (ref: ResourceReference) => void
}

type Block =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listItems: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', lines: paragraph })
      paragraph = []
    }
  }
  const flushList = () => {
    if (listType === 'ul') blocks.push({ type: 'ul', items: listItems })
    else if (listType === 'ol') blocks.push({ type: 'ol', items: listItems })
    listType = null
    listItems = []
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line)
    if (unordered) {
      flushParagraph()
      if (listType === 'ul') listItems.push(unordered[1])
      else {
        flushList()
        listType = 'ul'
        listItems.push(unordered[1])
      }
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (listType === 'ol') listItems.push(ordered[1])
      else {
        flushList()
        listType = 'ol'
        listItems.push(ordered[1])
      }
      continue
    }
    flushList()
    paragraph.push(line.trimStart())
  }
  flushParagraph()
  flushList()
  return blocks
}

function parseResourceHref(href: string): { kind: ResourceKind; id: number } | null {
  const match = /^infoagent:\/\/([a-z]+)\/(\d+)$/.exec(href.trim())
  if (!match) return null
  const kind = match[1]
  if (!isResourceKind(kind)) return null
  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id <= 0) return null
  return { kind, id }
}

function countChar(value: string, target: string): number {
  let count = 0
  for (const char of value) {
    if (char === target) count += 1
  }
  return count
}

function cleanUrl(value: string): { url: string; trailing: string } {
  let url = value
  let trailing = ''
  const punctuation = '.,;:!?，。；：！？、'
  while (url.length > 0 && punctuation.includes(url[url.length - 1])) {
    trailing = url[url.length - 1] + trailing
    url = url.slice(0, -1)
  }
  while (url.endsWith(')') && countChar(url, '(') < countChar(url, ')')) {
    trailing = ')' + trailing
    url = url.slice(0, -1)
  }
  return { url, trailing }
}

function renderExternalLink(href: string, label: string, key: string): ReactNode {
  return (
    <a
      key={key}
      className="jarvis-md-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        void window.api.appOpenExternal(href).catch(() => undefined)
      }}
    >
      {label}
      <span className="jarvis-external-mark" aria-hidden="true">↗</span>
    </a>
  )
}

function appendInline(
  text: string,
  nodes: ReactNode[],
  keyBase: string,
  onOpenResource: (ref: ResourceReference) => void
): void {
  const pattern = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\((?:infoagent:\/\/|https?:\/\/)[^)\s]+\))|(https?:\/\/[^\s<>"'）)]+)/g
  let last = 0
  let index = 0
  let match = pattern.exec(text)
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (match[1]) {
      const inner = token.slice(2, -2)
      const innerKey = keyBase + '-b' + String(index)
      nodes.push(
        <strong key={innerKey} className="jarvis-md-strong">
          {renderInline(inner, onOpenResource, innerKey)}
        </strong>
      )
    } else if (match[2]) {
      nodes.push(<code key={keyBase + '-c' + String(index)} className="jarvis-md-code">{token.slice(1, -1)}</code>)
    } else if (match[3]) {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token)
      if (link) {
        const label = link[1]
        const href = link[2]
        if (href.startsWith('infoagent://')) {
          const target = parseResourceHref(href)
          if (target) {
            nodes.push(
              <button
                key={keyBase + '-r' + String(index)}
                type="button"
                className="jarvis-resource-link"
                title={'打开：' + label}
                onClick={() => onOpenResource({ kind: target.kind, id: target.id, title: label })}
              >
                <span className="jarvis-resource-mark" aria-hidden="true">▸</span>
                {label}
              </button>
            )
          } else {
            nodes.push(label)
          }
        } else if (href.startsWith('http://') || href.startsWith('https://')) {
          nodes.push(renderExternalLink(href, label, keyBase + '-l' + String(index)))
        } else {
          nodes.push(label)
        }
      } else {
        nodes.push(token)
      }
    } else if (match[4]) {
      const { url, trailing } = cleanUrl(match[4])
      nodes.push(renderExternalLink(url, url, keyBase + '-u' + String(index)))
      if (trailing) nodes.push(trailing)
    } else {
      nodes.push(token)
    }
    last = pattern.lastIndex
    index += 1
    match = pattern.exec(text)
  }
  if (last < text.length) nodes.push(text.slice(last))
}

function renderInline(
  text: string,
  onOpenResource: (ref: ResourceReference) => void,
  keyBase: string
): ReactNode[] {
  const nodes: ReactNode[] = []
  const segments = text.split('\n')
  segments.forEach((segment, segmentIndex) => {
    if (segmentIndex > 0) nodes.push(<br key={keyBase + '-br' + String(segmentIndex)} />)
    appendInline(segment, nodes, keyBase + '-s' + String(segmentIndex), onOpenResource)
  })
  return nodes
}

function hasResourceLink(content: string): boolean {
  return /\[[^\]]+\]\(infoagent:\/\/[a-z]+\/\d+\)/.test(content)
}

export function ReferenceChips({ references, onOpenResource }: {
  references: ResourceReference[]
  onOpenResource: (ref: ResourceReference) => void
}) {
  const seen = new Set<string>()
  const items = references.filter((ref) => {
    const key = ref.kind + ':' + String(ref.id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (items.length === 0) return null
  return (
    <div className="jarvis-refs">
      {items.map((ref) => {
        const label = ref.title || (RESOURCE_LABEL[ref.kind] + ' #' + String(ref.id))
        return (
          <button
            key={ref.kind + ':' + String(ref.id)}
            type="button"
            className="jarvis-ref-chip"
            title={label}
            onClick={() => onOpenResource(ref)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

export function AssistantMarkdown({ content, references, onOpenResource }: AssistantMarkdownProps) {
  const blocks = useMemo(() => parseBlocks(content), [content])
  const showReferences = !hasResourceLink(content)
  return (
    <div className="jarvis-md">
      {blocks.map((block, index) => {
        const key = 'md-block-' + String(index)
        if (block.type === 'paragraph') {
          return (
            <p className="jarvis-md-p" key={key}>
              {renderInline(block.lines.join('\n'), onOpenResource, key)}
            </p>
          )
        }
        if (block.type === 'ul') {
          return (
            <ul className="jarvis-md-list" key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={key + '-li' + String(itemIndex)}>
                  {renderInline(item, onOpenResource, key + '-li' + String(itemIndex))}
                </li>
              ))}
            </ul>
          )
        }
        return (
          <ol className="jarvis-md-list" key={key}>
            {block.items.map((item, itemIndex) => (
              <li key={key + '-li' + String(itemIndex)}>
                {renderInline(item, onOpenResource, key + '-li' + String(itemIndex))}
              </li>
            ))}
          </ol>
        )
      })}
      {showReferences && <ReferenceChips references={references} onOpenResource={onOpenResource} />}
    </div>
  )
}
