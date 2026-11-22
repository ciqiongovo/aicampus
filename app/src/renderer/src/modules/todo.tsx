import { CheckSquareOutlined } from '@ant-design/icons'
import type { ModuleManifest } from './types'
import { TodoPage } from './todo/TodoPage'

export const todoModule: ModuleManifest = {
  id: 'todo',
  group: 'work',
  title: '待办',
  icon: <CheckSquareOutlined />,
  route: '/todo',
  enabled: true,
  page: () => <TodoPage />
}
