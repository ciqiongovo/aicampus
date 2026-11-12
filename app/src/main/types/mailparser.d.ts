/**
 * mailparser 3.x 精简类型声明（官方包未内置类型）：
 * 仅声明 InfoAgent 实际使用的 API 面，避免引入已停更的 @types/mailparser。
 */
declare module 'mailparser' {
  export interface AddressObject {
    text: string
    value?: { address: string; name: string }[]
    html?: string
  }

  export interface AttachmentCommon {
    filename?: string | null
    contentType: string
    size?: number
    content?: Buffer
  }

  export interface ParsedMail {
    text?: string
    html?: string | false
    subject?: string
    messageId?: string
    date?: Date
    /* 注意：单地址时 mailparser 返回单个 AddressObject，多地址时才返回数组，两种形态都要兼容 */
    from?: AddressObject | AddressObject[]
    to?: AddressObject | AddressObject[]
    cc?: AddressObject | AddressObject[]
    bcc?: AddressObject | AddressObject[]
    attachments?: AttachmentCommon[]
  }

  export interface SimpleParserOptions {
    skipImageLinks?: boolean
  }

  export function simpleParser(source: Buffer | string, options?: SimpleParserOptions): Promise<ParsedMail>
}
