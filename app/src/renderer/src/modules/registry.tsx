import type { ModuleManifest } from './types'
import { jarvisModule } from './jarvis'
import { panelModule } from './panel'
import { dailyModule } from './daily'
import { mailModule } from './mail'
import { todoModule } from './todo'
import { scheduleModule } from './schedule'
import { materialsModule } from './materials'
import { benchmarkModule } from './benchmark'
import { settingsModule } from './settings'

/**
 * 模块注册表：侧边栏导航、路由表、设置入口全部由此生成。
 *
 * 顺序即优先级。这个软件的主线是「看兄弟高校在办什么」，
 * 所以公众号对标放在第一位，原来自带的邮件/日程/待办退到后半段当辅助。
 */
export const modules: ModuleManifest[] = [
  benchmarkModule,
  panelModule,
  dailyModule,
  jarvisModule,
  scheduleModule,
  todoModule,
  mailModule,
  materialsModule,
  settingsModule
]

