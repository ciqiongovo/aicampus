/**
 * 本地偏好的键名前缀与一次性搬家。
 *
 * 应用原来叫 InfoAgent，本地存的主题、导航开关、关键字视图全挂在 `infoagent.*`
 * 上。改名之后如果直接换成 `zhishu.*`，用户打开会发现主题回到默认、侧栏展开状态
 * 也没了——这类「设置丢了」的反馈很难查，因为没人会想到是键名前缀变的。
 *
 * 所以在渲染进程启动的最早一步，把所有旧键原样复制到新名下（旧的留着不删：
 * 万一回滚到旧版本，那边还在读旧键）。只搬一次，之后新键存在就不再扫。
 */
export const PREF = {
  navVisible: 'zhishu.navVisible',
  navPinned: 'zhishu.navPinned',
  themeMode: 'zhishu.themeMode',
  palette: 'zhishu.palette',
  vivid: 'zhishu.vivid',
  aiReturn: 'zhishu.aiReturn',
  activeConversation: 'zhishu.activeConversation',
  panelSnapshot: 'zhishu.panel.snapshot.v1',
  keywordView: 'zhishu.keywordView'
} as const

const LEGACY_PREFIX = 'infoagent.'
const PREFIX = 'zhishu.'

/**
 * 「把这条内容交给 AI」的事件名。
 *
 * 旧名 infoagent:ai-handoff 只用于兼容：老窗口里可能还有监听在等旧事件名，
 * 一次性广播两个名字成本极低，漏发则表现为点了「问 AI」没反应。
 */
export const AI_HANDOFF_EVENT = 'zhishu:ai-handoff'
export const LEGACY_AI_HANDOFF_EVENT = 'infoagent:ai-handoff'

export function migratePrefs(): void {
  try {
    const moved: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(LEGACY_PREFIX)) continue
      const next = PREFIX + key.slice(LEGACY_PREFIX.length)
      if (localStorage.getItem(next) !== null) continue
      const value = localStorage.getItem(key)
      if (value === null) continue
      localStorage.setItem(next, value)
      moved.push(key)
    }
    // 会话里的一次性状态（AI 返回位置）不跨会话，直接搬过一次即可
    const sessionReturn = sessionStorage.getItem('infoagent.aiReturn')
    if (sessionReturn !== null && sessionStorage.getItem(PREF.aiReturn) === null) {
      sessionStorage.setItem(PREF.aiReturn, sessionReturn)
    }
    if (moved.length) console.info(`[知枢] 已迁移 ${moved.length} 项旧偏好`)
  } catch {
    // 存储被禁用时不该影响启动：拿不到旧值就按默认走，比白屏强
  }
}
