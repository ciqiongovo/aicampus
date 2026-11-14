import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { AppSettings, SettingsPatch, SettingsView } from '../../shared/types'
import type { SettingsStore } from '../store/settings'
import { hasSecret } from '../services/mail/secret'

/** 渲染进程可见设置：永不携带 aiApiKey 本体（A1 IPC 脱敏） */
function toView(s: AppSettings): SettingsView {
  const hasKey = hasSecret(s.aiApiKey)
  const aiAuthorized = !!s.aiAuthorizedFor && s.aiAuthorizedFor === s.aiProvider + '|' + s.aiBaseURL
  return {
    reminderEnabled: s.reminderEnabled,
    reminderAdvanceMinutes: s.reminderAdvanceMinutes,
    aiProvider: s.aiProvider,
    aiBaseURL: s.aiBaseURL,
    aiModel: s.aiModel,
    aiIsLocal: s.aiIsLocal,
    hasAiKey: hasKey,
    aiConfigured: (hasKey || s.aiIsLocal) && !!s.aiProvider && !!s.aiBaseURL && !!s.aiModel,
    aiAuthorized,
    aiAuthorizedAt: s.aiAuthorizedAt || null,
    aiExcludeAttachments: s.aiExcludeAttachments,
    userGrade: s.userGrade,
    userMajor: s.userMajor,
    autoLaunch: s.autoLaunch,
    radarSensitivity: s.radarSensitivity,
    keywordSensitivity: s.keywordSensitivity,
    zhihuRecommendCount: s.zhihuRecommendCount,
    zhihuCounterCount: s.zhihuCounterCount,
    benchOurContext: s.benchOurContext
  }
}

export function registerSettingsIpc(store: SettingsStore): void {
  ipcMain.handle(IPC.settingsGet, async (): Promise<SettingsView> => toView(await store.get()))
  ipcMain.handle(
    IPC.settingsSet,
    async (_event, patch: SettingsPatch): Promise<SettingsView> => {
      const next = await store.set(patch)
      // P6 自启：设置变更时同步 Windows 登录项（仅打包版，开发模式不写注册表）
      if (typeof patch.autoLaunch === 'boolean' && app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: patch.autoLaunch })
      }
      return toView(next)
    }
  )
}
