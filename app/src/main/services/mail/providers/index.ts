import type { MailProviderPreset } from '../../../../shared/types'

/**
 * 邮箱服务商预设注册表（硬性架构要求：不写死）。
 * 新增服务商 = 在此追加一条预设，账号向导与列表自动出现新入口，无需改 UI 代码。
 */
const providers: MailProviderPreset[] = [
  {
    id: 'qq',
    label: 'QQ 邮箱',
    host: 'imap.qq.com',
    port: 993,
    encryption: 'ssl',
    defaultFolder: 'INBOX',
    authMode: 'appPassword',
    helpText: '请输入 QQ 邮箱的「授权码」，不是网页登录密码。获取方法：登录 mail.qq.com → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 生成授权码。',
    helpUrl: 'https://service.mail.qq.com/detail/0/75'
  },
  {
    id: 'netease163',
    label: '163 邮箱',
    host: 'imap.163.com',
    port: 993,
    encryption: 'ssl',
    defaultFolder: 'INBOX',
    authMode: 'appPassword',
    helpText: '请输入 163 邮箱的「客户端授权密码」。获取方法：登录 mail.163.com → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 新增授权码。',
    helpUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2'
  },
  {
    id: 'outlook',
    label: 'Outlook 个人邮箱',
    host: 'outlook.office365.com',
    port: 993,
    encryption: 'ssl',
    defaultFolder: 'INBOX',
    authMode: 'appPassword',
    helpText: '请输入 Outlook 的「应用密码」。获取方法：account.microsoft.com → 安全 → 开启两步验证 → 创建应用密码。',
    helpUrl: 'https://support.microsoft.com/zh-cn/account-billing/'
  },
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    encryption: 'ssl',
    defaultFolder: 'INBOX',
    authMode: 'appPassword',
    helpText: '请输入 Gmail 的「应用专用密码」。获取方法：myaccount.google.com → 开启两步验证 → App passwords → 创建。',
    helpUrl: 'https://support.google.com/accounts/answer/185833'
  },
  {
    id: 'shanghaitech',
    label: '上海科技大学邮箱',
    host: 'imap.shanghaitech.edu.cn',
    port: 993,
    encryption: 'ssl',
    defaultFolder: 'INBOX',
    authMode: 'appPassword',
    helpText: '请输入学校邮箱的「客户端授权码」：在学校邮箱网页端设置中开启客户端授权后获取。'
  },
  {
    id: 'custom',
    label: '其他邮箱（自定义 IMAP）',
    host: '',
    port: 993,
    encryption: 'ssl',
    defaultFolder: 'INBOX',
    authMode: 'password',
    custom: true,
    helpText: '自定义 IMAP：自行填写服务器地址、端口、加密方式与文件夹。密码一般填「授权码/应用密码」（主流邮箱需先开启客户端授权）。'
  }
]

export function listProviders(): MailProviderPreset[] {
  return providers
}

export function getProvider(id: string): MailProviderPreset | undefined {
  return providers.find((p) => p.id === id)
}
