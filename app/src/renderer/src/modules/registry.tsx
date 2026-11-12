import type { ModuleManifest } from './types'
import { jarvisModule } from './jarvis'
import { panelModule } from './panel'
import { dailyModule } from './daily'
import { mailModule } from './mail'
import { todoModule } from './todo'
import { scheduleModule } from './schedule'
import { materialsModule } from './materials'
import { settingsModule } from './settings'

/** 模块注册表：侧边栏导航、路由表、设置入口全部由此生成 */
export const modules: ModuleManifest[] = [
  jarvisModule,
  panelModule,
  dailyModule,
  mailModule,
  todoModule,
  scheduleModule,
  materialsModule,
  settingsModule
]

