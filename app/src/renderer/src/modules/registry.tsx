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
 * 顺序即优先级，第一项就是启动页。
 *
 * 学长看过一版之后给了三条意见：一打开不知道干什么；公众号采集不该占着
 * 第一页；整体功能杂而乱。所以起始页换回会对话的 JARVIS——它才是这个
 * 软件的门面；公众号采集降成「消息来源」里的原料，和邮件并列。
 */
export const modules: ModuleManifest[] = [
  jarvisModule,
  benchmarkModule,
  mailModule,
  panelModule,
  scheduleModule,
  todoModule,
  materialsModule,
  dailyModule,
  settingsModule
]
