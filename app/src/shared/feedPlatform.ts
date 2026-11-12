/**
 * 兴趣流平台模板：任何「登录后能读到个性化推荐流」的平台都可以复用这套双板块结构。
 * 当前接入知乎；新增平台时提供同形状的 capture 适配器与一个模板配置即可复用面板 UI。
 */
import type { ZhihuBoard } from './zhihu'

export interface FeedBoardTemplate {
  key: ZhihuBoard
  label: string
  hint: string
}

export interface FeedPlatformTemplate {
  id: string
  /** 来源下拉里的名字 */
  label: string
  /** 标题前的小标记 */
  kicker: string
  /** 页面主标题 */
  title: string
  /** 两个板块的文案；顺序即 UI 里的顺序 */
  boards: FeedBoardTemplate[]
}

export const ZHIHU_FEED_TEMPLATE: FeedPlatformTemplate = {
  id: 'zhihu',
  label: '知乎',
  kicker: '兴趣',
  title: '知乎',
  boards: [
    {
      key: 'recommend',
      label: '推荐',
      hint: '按你的兴趣标签排序；贴近你最近关注的方向。'
    },
    {
      key: 'counter',
      label: '反推荐',
      hint: '以推荐位为种子，找同一类议题的另一面；不是随机换话题。'
    }
  ]
}
