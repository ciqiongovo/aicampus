import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { AddressObject } from 'mailparser'
import type { DatabaseSync } from 'node:sqlite'
import { countEmailsBySubject, findByUid, getByEmailId, updateAccount, upsertAnalysis, upsertEmail } from '../../db'
import type { AccountRow } from '../../db/types'
import type { EncryptionMode, TestConnectionResult } from '../../../shared/types'

/** 首登全量拉取上限（封，取最新 N 封） */
export const MAX_FULL_FETCH = 500
/** 单封正文下载上限（字节）；超限按截断解析 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 单条 UID FETCH 请求携带的 UID 数量（控制命令行长度与内存占用） */
export const FETCH_BATCH_SIZE = 100
/** 解析失败时写入的主题标记：既提示用户，也用于下次同步自动重拉这些邮件 */
export const PARSE_FAILED_SUBJECT = '(解析失败)'

export interface ImapEndpoint {
  host: string
  port: number
  encryption: EncryptionMode
  username: string
  secret: string
  /** OAuth 登录：与 secret 二选一（imapflow XOAUTH2） */
  accessToken?: string
}

function createClient(endpoint: ImapEndpoint): ImapFlow {
  return new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.encryption === 'ssl',
    doSTARTTLS: endpoint.encryption === 'starttls' ? true : undefined,
    auth: endpoint.accessToken ? { user: endpoint.username, accessToken: endpoint.accessToken } : { user: endpoint.username, pass: endpoint.secret },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000
  })
}

/** 把底层错误翻译成界面可展示的中文排查提示 */
export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = (error as NodeJS.ErrnoException).code ?? ''
  const response = (error as { response?: unknown }).response
  const text = typeof response === 'string' ? response : ''
  if (/auth|login|credential|incorrect|authentication/i.test(raw + ' ' + text)) {
    return '认证失败：请检查用户名与授权码（授权码不是网页登录密码）'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(code + ' ' + raw)) return '无法解析服务器地址，请检查主机名'
  if (/ECONNREFUSED|ECONNRESET/i.test(code + ' ' + raw)) return '连接被拒绝：请检查端口与防火墙设置'
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed? ?out/i.test(code + ' ' + raw)) return '连接超时：请检查网络或服务器地址'
  if (/certificate|self.signed|UNABLE_TO_VERIFY|TLS|SSL/i.test(raw)) return 'SSL/TLS 校验失败：请确认服务器与加密方式设置'
  return '连接失败：' + raw
}

/** 连接测试：登录认证 + 读取文件夹列表（只读，不修改任何邮件） */
export async function testConnection(endpoint: ImapEndpoint): Promise<TestConnectionResult> {
  const client = createClient(endpoint)
  try {
    await client.connect()
    const mailboxes = await client.list()
    await client.logout()
    return {
      ok: true,
      message: '连接成功：认证通过，服务器共有 ' + mailboxes.length + ' 个文件夹',
      folderCount: mailboxes.length,
      folders: mailboxes.map((m) => m.path).slice(0, 20)
    }
  } catch (error) {
    return { ok: false, message: friendlyError(error) }
  } finally {
    try {
      client.close()
    } catch {
      /* 已断开 */
    }
  }
}

/** mailparser 的地址字段单地址时是对象、多地址时是数组：统一转成「名字 <地址>」文本 */
function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return ''
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join(', ')
}

interface ParsedParts {
  /** false 表示解析失败，仅留下占位信息 */
  ok: boolean
  subject: string
  messageId: string
  fromAddr: string
  toAddr: string
  cc: string
  dateUtc: string | null
  dateRaw: string | null
  unread: number
  bodyText: string
  bodyHtml: string
  attachmentsJson: string
}

/** mailparser 解析邮件原文；解析失败时降级为最小可用信息（不阻塞同步，但会计数并打日志） */
async function parseMessage(source: Buffer, uid: number): Promise<ParsedParts> {
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true })
    const attachments = (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size ?? 0
    }))
    const validDate = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null
    return {
      ok: true,
      subject: parsed.subject ?? '(无主题)',
      messageId: parsed.messageId ?? '',
      fromAddr: addressText(parsed.from),
      toAddr: addressText(parsed.to),
      cc: addressText(parsed.cc),
      dateUtc: validDate ? validDate.toISOString() : null,
      dateRaw: validDate ? validDate.toString() : null,
      unread: 1,
      bodyText: parsed.text ?? '',
      bodyHtml: typeof parsed.html === 'string' ? parsed.html : '',
      attachmentsJson: JSON.stringify(attachments)
    }
  } catch (error) {
    console.error('[mail] 解析失败 uid=' + uid + '：' + (error instanceof Error ? error.message : String(error)))
    return {
      ok: false,
      subject: PARSE_FAILED_SUBJECT,
      messageId: '',
      fromAddr: '',
      toAddr: '',
      cc: '',
      dateUtc: null,
      dateRaw: null,
      unread: 1,
      bodyText: '',
      bodyHtml: '',
      attachmentsJson: '[]'
    }
  }
}

export interface SyncOutcome {
  added: number
  updated: number
  skipped: number
  lastUid: number
  uidValidity: number
  message: string
}

/**
 * 只读增量同步：
 * - mailboxOpen(readOnly) = EXAMINE，fetch 全程 BODY.PEEK，不标已读/不移动/不删除；
 * - 首登全量（最多最新 MAX_FULL_FETCH 封）；UIDVALIDITY 变化视为重置全量；
 * - 之后按 UID 增量（last_uid + 1 起）；
 * - 成功/失败均写回 accounts（last_uid/uidvalidity/last_sync_at/sync_error）。
 */
export async function syncAccount(
  db: DatabaseSync,
  account: AccountRow,
  secret: string,
  accessToken?: string
): Promise<SyncOutcome> {
  const folder = account.folder || 'INBOX'
  const client = createClient({
    host: account.host,
    port: account.port ?? 993,
    encryption: account.encryption,
    username: account.username,
    secret,
    accessToken
  })
  try {
    await client.connect()
    const mailbox = await client.mailboxOpen(folder, { readOnly: true })
    const uidValidity = Number(mailbox.uidValidity)
    const isFirstSync = account.last_uidvalidity === null
    const validityChanged = !isFirstSync && account.last_uidvalidity !== uidValidity

    let lastUid = account.last_uid ?? 0
    if (validityChanged) {
      // 服务器重置了 UID 体系，旧邮件 UID 作废：清空重导
      db.prepare('DELETE FROM emails WHERE account_id = ?').run(account.id)
      lastUid = 0
    }

    // 历史自愈：此前解析失败的邮件（正文为空、主题带失败标记）下次同步自动重拉重解析
    const brokenCount = countEmailsBySubject(db, account.id, PARSE_FAILED_SUBJECT)

    // 首登 / UID 体系重置 / 上次同步为空 / 存在解析失败的历史邮件 → 拉最新 MAX_FULL_FETCH 封；否则按 UID 增量
    const needsFull = isFirstSync || validityChanged || lastUid === 0 || brokenCount > 0

    // 1) 先只取 UID 列表（很轻，只要 UID 属性）。UID 由服务器分配、可能稀疏且数值很大
    //    （实测本校 Coremail UID≈1.78e9 且有空洞），因此不能用 mailbox.exists 推算窗口，
    //    也不能依赖 mailbox.uidNext——该服务器 EXAMINE/STATUS 都不返回 UIDNEXT。
    const allUids: number[] = []
    for await (const row of client.fetch({ uid: '1:*' }, { uid: true }, { uid: true })) {
      if (typeof row.uid === 'number' && row.uid > 0) allUids.push(row.uid)
    }
    allUids.sort((a, b) => a - b)

    // 2) 本次目标 UID：首登取最新 N 封；增量 = lastUid 之后的新邮件 + 最早缺口回填。
    //    首登限量会在服务器留「最早的若干封」未导入，回填按较新→较旧补齐，每轮 cap 与首登同量级。
    const backfillUids: number[] = []
    const targetUids = (() => {
      if (needsFull) return allUids.slice(Math.max(0, allUids.length - MAX_FULL_FETCH))
      const incremental = allUids.filter((uid) => uid > lastUid)
      const minRow = db
        .prepare('SELECT MIN(uid) AS min_uid FROM emails WHERE account_id = ? AND folder = ?')
        .get(account.id, folder) as { min_uid: number | null }
      const minImported = minRow.min_uid
      if (minImported !== null) {
        const older = allUids.filter((uid) => uid < minImported)
        backfillUids.push(...older.slice(Math.max(0, older.length - MAX_FULL_FETCH)))
      }
      return incremental.concat(backfillUids).sort((a, b) => a - b)
    })()
    const backfillSet = new Set(backfillUids)

    let added = 0
    let updated = 0
    let skipped = 0
    let parseFailed = 0
    let backfilled = 0

    // 3) 分批 UID FETCH。第三个参数 options.uid=true 才是 UID FETCH，否则区间会被当作
    //    序列号（query.uid 只表示「响应里带回 UID 属性」）。全程 BODY.PEEK，不标已读。
    for (let offset = 0; offset < targetUids.length; offset += FETCH_BATCH_SIZE) {
      const batch = targetUids.slice(offset, offset + FETCH_BATCH_SIZE)
      for await (const message of client.fetch(batch.join(','), {
        uid: true,
        flags: true,
        source: { maxLength: MAX_BODY_BYTES }
      }, { uid: true })) {
        if (typeof message.uid !== 'number' || message.uid <= 0) {
          skipped++
          continue
        }
        lastUid = Math.max(lastUid, message.uid)
        if (!message.source || message.source.length === 0) {
          // 服务器没给正文（少见）：计数并报给界面，绝不静默变成「导入 0 封」
          skipped++
          continue
        }
        const parts = await parseMessage(message.source, message.uid)
        if (!parts.ok) parseFailed++
        // 服务器 FLAGS 为准：带 \Seen 的算已读
        if (message.flags) parts.unread = message.flags.has('\\Seen') ? 0 : 1
        const existed = findByUid(db, account.id, folder, message.uid) !== undefined
        const emailId = upsertEmail(db, {
          account_id: account.id,
          folder,
          uid: message.uid,
          message_id: parts.messageId || 'uid-' + message.uid + '@local',
          subject: parts.subject,
          from_addr: parts.fromAddr,
          to_addr: parts.toAddr,
          cc: parts.cc,
          date_utc: parts.dateUtc,
          date_raw: parts.dateRaw,
          unread: parts.unread,
          body_text: parts.bodyText,
          body_html: parts.bodyHtml,
          attachments_json: parts.attachmentsJson,
          size: message.source.length
        })
        // 新入库邮件建「待分析」管线记录；已分析的记录不重置（避免重复分析）
        if (!getByEmailId(db, emailId)) {
          upsertAnalysis(db, {
            email_id: emailId,
            status: 'pending',
            category: null,
            summary: null,
            action_required: null,
            deadline_raw: null,
            deadline_at: null,
            deadline_kind: null,
            event_start_at: null,
            applicable_to: null,
            confidence: null,
            tier: null,
            evidence_json: '[]',
            model: null,
            provider: null,
            error: null,
            analyzed_at: null
          })
        }
        if (existed) updated++
        else {
          added++
          if (backfillSet.has(message.uid)) backfilled++
        }
      }
      // 批次正常结束即推进游标：期间被删除或正文为空的邮件不阻塞后续同步
      lastUid = Math.max(lastUid, batch[batch.length - 1])
    }

    updateAccount(db, account.id, {
      lastUidvalidity: uidValidity,
      lastUid,
      lastSyncAt: new Date().toISOString(),
      syncError: null
    })

    let message: string
    if (needsFull) {
      if (allUids.length === 0) {
        message = '邮箱为空：' + folder + ' 中没有可同步的邮件'
      } else if (added + updated === 0) {
        message = '未导入任何邮件：服务器返回 ' + skipped + ' 封但都没有正文，请稍后重试同步'
      } else {
        const capped =
          allUids.length > MAX_FULL_FETCH ? '（共 ' + allUids.length + ' 封，本次导入最新 ' + MAX_FULL_FETCH + ' 封）' : ''
        const notes: string[] = []
        if (skipped > 0) notes.push('跳过 ' + skipped + ' 封')
        if (parseFailed > 0) notes.push('解析失败 ' + parseFailed + ' 封')
        const noteText = notes.length > 0 ? '，' + notes.join('、') : ''
        const head = brokenCount > 0 && !isFirstSync ? '重新解析完成：更新 ' : '首次同步完成：导入 '
        message = head + (added + updated) + ' 封' + capped + noteText
      }
    } else {
      const parts = ['新增 ' + added + ' 封', '更新 ' + updated + ' 封']
      if (backfilled > 0) parts.push('回填 ' + backfilled + ' 封')
      if (skipped > 0) parts.push('跳过 ' + skipped + ' 封')
      message = '同步完成：' + parts.join('、')
    }
    return { added, updated, skipped, lastUid, uidValidity, message }
  } catch (error) {
    const message = friendlyError(error)
    updateAccount(db, account.id, { syncError: message })
    throw new Error(message)
  } finally {
    try {
      await client.logout()
    } catch {
      /* 忽略 */
    }
    client.close()
  }
}
