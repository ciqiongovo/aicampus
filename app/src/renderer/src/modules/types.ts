import type { ReactElement, ReactNode } from 'react'

/** 板块模块清单：新增板块 = 新增一个 manifest 并注册，导航/路由自动生成 */
export interface ModuleManifest {
  id: string
  title: string
  icon: ReactElement
  route: string
  enabled: boolean
  page: () => ReactNode
}
