import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'antd/dist/reset.css'
import App from './App'
import { ThemeProvider } from './theme'
import './styles.css'
import './theme.css'
import { migratePrefs } from './prefs'

dayjs.locale('zh-cn')

// 早于任何读取偏好的代码：旧键要先搬到新名下，否则用户会以为设置丢了
migratePrefs()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </ThemeProvider>
  </React.StrictMode>
)
