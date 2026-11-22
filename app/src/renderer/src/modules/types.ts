import type { ReactElement, ReactNode } from 'react'

/** 板块模块清单：新增板块 = 新增一个 manifest 并注册，导航/路由自动生成 */
export interface ModuleManifest {
  id: string
  title: string
  icon: ReactElement
  route: string
  enabled: boolean
  /**
   * 放哪一组。不填就单独摆在最上面（只留给对话首页）。
   *
   * 学长看过一版之后说「功能比较杂、比较混乱」——九个板块平铺，看不出主次。
   * 现在按「消息从哪来 / 在哪干活 / 其他」三组收口：
   * - source：公众号对标、邮件、QQ 群，都是原料
   * - work：面板、日程、待办、资料，日常在处理的东西
   * - more：日报这类不是天天开的东西
   */
  group?: 'source' | 'work' | 'more'
  page: () => ReactNode
}
