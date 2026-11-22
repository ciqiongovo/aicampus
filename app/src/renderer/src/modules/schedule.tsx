import { CalendarOutlined } from '@ant-design/icons'
import type { ModuleManifest } from './types'
import { SchedulePage } from './schedule/SchedulePage'

export const scheduleModule: ModuleManifest = {
  id: 'schedule',
  group: 'work',
  title: '日程',
  icon: <CalendarOutlined />,
  route: '/schedule',
  enabled: true,
  page: () => <SchedulePage />
}
