import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { IPC } from '../../shared/types'
import type {
  AttachmentDownloadResult,
  AttachmentInfo,
  MailAccountNode,
  MailAnalysisBrief,
  MailDetail,
  MailFolderNode,
  MailListItem,
  MailListQuery,
  MailListResult
} from '../../shared/types'
import {
  countEmailsByFolder,
  getByEmailId,
  getEmail,
  getEmailListItem,
  listAccounts,
  parseEvidence,
  searchEmails,
  setEmailStarred,
  setEmailUnread
} from '../db'
import type { EmailListRow } from '../db/dao/emailsDao'
import { fetchAttachment } from '../services/mail/attachment'
import type { AnalysisPipeline } from '../services/ai/pipeline'
import { listProviders } from '../services/mail/providers'
import { htmlToText, sanitizeEmailHtml } from '../services/mail/sanitize'
import type { SyncManager } from '../services/mail/syncManager'

/** 邮件域 IPC：服务商注册表 + 手动同步 + 实时状态 + 列表/搜索/详情（M5） */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const ANALYSIS_STATUS_VALUES = ['pending', 'analyzed', 'failed', 'skipped'] as const

function parseAttachments(json: string): AttachmentInfo[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.map((raw) => {
      const item = (raw ?? {}) as Partial<AttachmentInfo>
      return {
        filename: typeof item.filename === 'string' && item.filename ? item.filename : null,
        contentType:
          typeof item.contentType === 'string' && item.contentType ? item.contentType : 'application/octet-stream',
        size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0
      }
    })
  } catch {
    return []
  }
}

function toListItem(row: EmailListRow): MailListItem {
  return {
    id: row.id,
    accountId: row.account_id,
    accountLabel: row.account_label,
    folder: row.folder,
    subject: row.subject || '(无主题)',
    fromAddr: row.from_addr,
    toAddr: row.to_addr,
    dateUtc: row.date_utc,
    unread: row.unread === 1,
    starred: row.starred === 1,
    size: row.size,
    attachmentCount: parseAttachments(row.attachments_json).length,
    category: row.category,
    analysisStatus: (row.analysis_status as MailListItem['analysisStatus']) ?? null,
    tags: row.tags ?? []
  }
}

export function registerMailIpc(db: DatabaseSync, syncManager: SyncManager, pipeline: AnalysisPipeline): void {
  ipcMain.handle(IPC.mailProvidersList, () => listProviders())
  // 同步成功后自动消费待分析队列（A3：同步 → AI 分析闭环）
  ipcMain.handle(IPC.mailSync, async (_event, accountId: number) => {
    const result = await syncManager.syncOne(accountId)
    if (result.ok) void pipeline.analyzePending()
    return result
  })
  ipcMain.handle(IPC.mailSyncAll, async (): Promise<void> => {
    await syncManager.syncAll()
    void pipeline.analyzePending()
  })
  ipcMain.handle(IPC.mailSyncStatus, () => syncManager.allStatus())

  // 左侧文件夹树：计数全部来自本地库（不走网络），所以切文件夹、看未读都是瞬时的
  ipcMain.handle(IPC.mailFolders, (): MailAccountNode[] => {
    const counts = countEmailsByFolder(db)
    const grouped = new Map<number, MailFolderNode[]>()
    for (const row of counts) {
      const list = grouped.get(row.account_id) ?? []
      list.push({ folder: row.folder, total: row.total, unread: row.unread })
      grouped.set(row.account_id, list)
    }
    return listAccounts(db).map((account) => {
      const folders = grouped.get(account.id) ?? []
      if (!folders.some((item) => item.folder === account.folder)) {
        // 默认文件夹即使还没收到信也显示出来，避免账号下空空如也
        folders.push({ folder: account.folder, total: 0, unread: 0 })
      }
      folders.sort((a, b) => {
        if (a.folder === b.folder) return 0
        if (a.folder === account.folder) return -1
        if (b.folder === account.folder) return 1
        return a.folder.localeCompare(b.folder)
      })
      return {
        accountId: account.id,
        provider: account.provider,
        label: account.label,
        address: account.address,
        folders,
        total: folders.reduce((sum, item) => sum + item.total, 0),
        unread: folders.reduce((sum, item) => sum + item.unread, 0),
        lastSyncAt: account.last_sync_at,
        syncError: account.sync_error
      }
    })
  })

  ipcMain.handle(IPC.mailList, (_event, rawQuery: MailListQuery | undefined): MailListResult => {
    const query = rawQuery ?? {}
    const rawLimit = Number(query.limit)
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const rawOffset = Number(query.offset)
    const offset = Math.max(Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0, 0)
    const accountId = Number(query.accountId)
    const { total, rows } = searchEmails(db, {
      accountId: Number.isInteger(accountId) ? accountId : undefined,
      folder: typeof query.folder === 'string' ? query.folder : undefined,
      keyword: typeof query.keyword === 'string' ? query.keyword : undefined,
      tagIds: query.tagIds,
      tagMatch: query.tagMatch === 'all' ? 'all' : 'any',
      unreadOnly: query.unreadOnly === true,
      hasAttachment: query.hasAttachment === true,
      starredOnly: query.starredOnly === true,
      category: typeof query.category === 'string' && query.category.trim() !== '' ? query.category.trim() : undefined,
      analysisStatus:
        typeof query.analysisStatus === 'string' &&
        (ANALYSIS_STATUS_VALUES as readonly string[]).includes(query.analysisStatus)
          ? query.analysisStatus
          : undefined,
      limit,
      offset
    })
    return { total, items: rows.map(toListItem) }
  })

  ipcMain.handle(IPC.mailGet, (_event, rawId: unknown): MailDetail | null => {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) return null
    const row = getEmailListItem(db, id)
    const full = getEmail(db, id)
    if (!row || !full) return null
    const analysis = getByEmailId(db, id)
    const brief: MailAnalysisBrief | null = analysis
      ? {
          status: analysis.status,
          category: analysis.category,
          summary: analysis.summary,
          actionRequired: analysis.action_required,
          deadlineAt: analysis.deadline_at,
          confidence: analysis.confidence,
          model: analysis.model,
          error: analysis.error,
          evidence: parseEvidence(analysis.evidence_json)
        }
      : null
    return {
      ...toListItem(row),
      messageId: full.message_id,
      cc: full.cc,
      dateRaw: full.date_raw,
      bodyHtml: sanitizeEmailHtml(full.body_html),
      bodyText: full.body_text || htmlToText(full.body_html),
      attachments: parseAttachments(full.attachments_json),
      analysis: brief
    }
  })

  ipcMain.handle(IPC.mailSetUnread, (_event, rawId: unknown, unread: unknown): void => {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) return
    setEmailUnread(db, id, unread === true ? 1 : 0)
  })

  ipcMain.handle(IPC.mailSetStarred, (_event, rawId: unknown, starred: unknown): void => {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) return
    setEmailStarred(db, id, starred === true)
  })

  // 附件下载：实时从服务器拉原文取附件，经系统保存对话框落盘。全程只读、不标已读。
  ipcMain.handle(
    IPC.mailAttachmentDownload,
    async (event, rawId: unknown, filename: unknown): Promise<AttachmentDownloadResult> => {
      const id = Number(rawId)
      if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '邮件 ID 无效' }
      try {
        const att = await fetchAttachment(db, id, typeof filename === 'string' ? filename : null)
        // path.basename 防路径穿越：无论服务器给的文件名有多险恶，都只落成纯文件名
        const safeName = basename(att.filename)
        const win = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: '保存附件',
          defaultPath: safeName,
          filters: [{ name: '所有文件', extensions: ['*'] }]
        }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { ok: false, canceled: true, message: '已取消保存' }
        await writeFile(result.filePath, att.content)
        return { ok: true, savedPath: result.filePath, message: '已保存到 ' + result.filePath }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
