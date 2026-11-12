import { MAIL_PARENT_LABELS, matchTopics } from './mailTags'

/** 面板/资料共用的八类主题；旧的分析分类（需行动、可选机会…）不再进入偏好画像。 */
export type PanelTopic = (typeof MAIL_PARENT_LABELS)[number]['id'] | 'uncategorized'

export const UNCATEGORIZED_TOPIC = 'uncategorized' as const

export const PANEL_TOPICS: ReadonlyArray<{ id: PanelTopic; name: string }> = [
  ...MAIL_PARENT_LABELS.map((item) => ({ id: item.id as PanelTopic, name: item.name })),
  { id: UNCATEGORIZED_TOPIC, name: '未分类' }
]

const TOPIC_NAMES = new Map<string, string>(PANEL_TOPICS.map((item) => [item.id, item.name]))

export function topicName(id: string | null | undefined): string {
  if (!id) return '未分类'
  return TOPIC_NAMES.get(id) ?? id
}

export function isPanelTopic(value: string | null | undefined): value is PanelTopic {
  return Boolean(value) && TOPIC_NAMES.has(value as string)
}

/** 从标题/正文/摘要里取一个主主题；无法归类时归入未分类，不把旧分析分类混进来。 */
export function inferTopic(text: string): PanelTopic {
  const { parents } = matchTopics(text)
  return parents.length > 0 ? (parents[0] as PanelTopic) : UNCATEGORIZED_TOPIC
}
