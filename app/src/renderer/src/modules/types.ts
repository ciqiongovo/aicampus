import type { ReactElement, ReactNode } from 'react'

/** 板块模块清单：新增板块 = 新增一个 manifest 并注册，导航/路由自动生成 */
export interface ModuleManifest {
  id: string
  title: string
  icon: ReactElement
  route: string
  enabled: boolean
  /**
   * 放哪一档导航。
   *
   * 侧栏第一屏只放「和看兄弟高校在办什么直接相关」的板块；面板块、日报、
   * 邮件这些个人资讯工具收进「更多」。它们不是不能用，是天天摆在最上面
   * 会让人以为这是个大杂烩，而不是一个对标工作台。
   */
  nav?: 'more'
  page: () => ReactNode
}
