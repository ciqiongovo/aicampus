import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { DatabaseSync } from 'node:sqlite'
import { getAccount, getEmail } from '../../db'
import { decryptSecret, hasSecret } from './secret'

export interface AttachmentDownload {
  filename: string
  contentType: string
  content: Buffer
}

/**
 * 按需拉取某封邮件的某个附件：连 IMAP 拉该 UID 原文 → mailparser 解析 → 按文件名匹配附件。
 * 附件本体不落库（避免 DB 膨胀），只在用户点「下载」时实时从服务器取；全程只读、不标已读。
 */
export async function fetchAttachment(
  db: DatabaseSync,
  emailId: number,
  filename: string | null
): Promise<AttachmentDownload> {
  const email = getEmail(db, emailId)
  if (!email) throw new Error('邮件不存在，可能已被删除')
  const account = getAccount(db, email.account_id)
  if (!account) throw new Error('账号不存在')
  if (!hasSecret(account.secret_enc)) throw new Error('账号未保存凭据，请编辑账号补填授权码')
  const secret = decryptSecret(account.secret_enc)

  const client = new ImapFlow({
    host: account.host,
    port: account.port ?? 993,
    secure: account.encryption === 'ssl',
    doSTARTTLS: account.encryption === 'starttls' ? true : undefined,
    auth: { user: account.username, pass: secret },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000
  })

  try {
    await client.connect()
    await client.mailboxOpen(email.folder || 'INBOX', { readOnly: true })
    const sources: Buffer[] = []
    for await (const message of client.fetch({ uid: String(email.uid) }, { source: true, uid: true }, { uid: true })) {
      if (message.uid === email.uid && message.source && message.source.length > 0) sources.push(message.source)
    }
    if (sources.length === 0) throw new Error('服务器未返回该邮件原文，可能已被移动或删除')
    const parsed = await simpleParser(sources[0], { skipImageLinks: true })
    const attachments = parsed.attachments ?? []
    const target =
      filename === null || filename === ''
        ? attachments[0]
        : attachments.find((a) => a.filename === filename)
    if (!target) throw new Error('附件不存在：' + (filename ?? '(未命名)'))
    const content = target.content as Buffer | undefined
    if (!content || content.length === 0) throw new Error('附件内容为空，无法保存')
    return {
      filename: target.filename || 'attachment',
      contentType: target.contentType || 'application/octet-stream',
      content
    }
  } finally {
    try {
      await client.logout()
    } catch {
      /* 忽略 */
    }
    client.close()
  }
}
