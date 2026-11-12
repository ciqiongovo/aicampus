import { safeStorage } from 'electron'

/**
 * 凭据加密存储：仅使用 Electron safeStorage（Windows 上即 DPAPI，与用户账户绑定）。
 * safeStorage 不可用时直接拒绝保存，绝不落盘明文或可逆编码（验收 A1）。
 */
export function encryptSecret(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统凭据加密不可用（safeStorage 未就绪），已拒绝保存明文凭据')
  }
  return 'enc:' + safeStorage.encryptString(plain).toString('base64')
}

/** 是否为加密格式（enc: 前缀） */
export function isEncryptedSecret(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith('enc:')
}

/** 解密；兼容读取历史版本 'plain:' 可逆编码（仅过渡用，见 migrateSecret） */
export function decryptSecret(stored: string): string {
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  }
  throw new Error('未知的凭据存储格式，无法解密')
}

/**
 * 历史可逆编码迁移：safeStorage 可用时把 'plain:' 值重新加密为 'enc:'。
 * safeStorage 不可用时原样返回（调用方应拒绝使用该凭据）。
 */
export function migrateSecret(stored: string): string {
  if (stored.startsWith('plain:') && safeStorage.isEncryptionAvailable()) {
    const plain = Buffer.from(stored.slice(6), 'base64').toString('utf8')
    return encryptSecret(plain)
  }
  return stored
}

export function hasSecret(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.length > 0
}
