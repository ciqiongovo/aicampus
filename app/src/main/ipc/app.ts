import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { IPC } from '../../shared/types'
import type { AppInfo, SaveTextResult } from '../../shared/types'
import { openExternalSafely } from '../services/externalOpen'

/** 太长会撑爆对话框标题栏，也没有哪份简报需要这么长的名字 */
const MAX_NAME_LEN = 80

/**
 * 把渲染进程给的文件名收敛成一个安全的纯文件名。
 *
 * 中途可能夹带路径分隔符（简报标题里出现「/」「:」很常见），
 * 一律拆成单段再拼回来，别让保存路径跑出用户选定的目录。
 */
function safeFileName(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return fallback
  const base = basename(text.replace(/[\\/:*?"<>|]/g, '-')).slice(0, MAX_NAME_LEN).trim()
  if (!base) return fallback
  return extname(base) ? base : `${base}.md`
}

export function registerAppIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    userDataPath: app.getPath('userData'),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }))
  ipcMain.handle(IPC.appOpenExternal, (_event, url: string): Promise<boolean> => {
    if (typeof url !== 'string') return Promise.resolve(false)
    return openExternalSafely(url)
  })

  // 导出纯文本或 HTML（简报、对标报告）。走系统保存对话框，落哪儿由用户决定。
  ipcMain.handle(
    IPC.appSaveText,
    async (event, rawName: unknown, content: unknown, kind: unknown): Promise<SaveTextResult> => {
      if (typeof content !== 'string') return { ok: false, message: '内容不是文本，无法保存' }
      const isHtml = kind === 'html'
      const defaultName = safeFileName(rawName, isHtml ? '对标报告.html' : '简报.md')
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: isHtml ? '保存报告' : '保存文件',
        defaultPath: defaultName,
        filters: isHtml
          ? [
              { name: '网页（可用浏览器打开、可打印）', extensions: ['html'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          : [
              { name: 'Markdown', extensions: ['md'] },
              { name: '纯文本', extensions: ['txt'] },
              { name: '所有文件', extensions: ['*'] }
            ]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        // 加 BOM：Windows 上的记事本打开无 BOM 的 UTF-8 中文会乱码，
        // 而「存下来双击看看」正是最自然的使用方式。
        // HTML 不加：BOM 会跑到 <!DOCTYPE> 前面，个别浏览器会进怪异模式。
        const payload = isHtml ? content : `\uFEFF${content}`
        await writeFile(result.filePath, payload, 'utf8')
        return { ok: true, path: result.filePath }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
