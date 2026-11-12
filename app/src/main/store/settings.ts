import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_SETTINGS } from '../../shared/types'
import type { AppSettings, SettingsPatch } from '../../shared/types'
import { getAllSettings, setSetting } from '../db/dao/settingsDao'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../services/mail/secret'
import { deriveConnectionPatch } from '../services/ai/connection'

const KEY_AI_API_KEY = 'aiApiKey'

function legacyFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * SQLite settings 表存储（key/value，见 migrations.ts v1）。
 * 首启自动导入旧版 settings.json，成功后改名 .migrated.bak 留档。
 * aiApiKey 落盘前强制 safeStorage 加密（A1）；内存缓存保留解密后的明文仅供主进程内部使用，
 * 渲染进程只能拿到脱敏后的 SettingsView（见 ipc/settings.ts）。
 */
export class SettingsStore {
  private cache: AppSettings | null = null

  constructor(private db: DatabaseSync) {}

  private async importLegacy(): Promise<void> {
    try {
      const raw = await fs.readFile(legacyFile(), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) setSetting(this.db, key, value)
      await fs.rename(legacyFile(), legacyFile() + '.migrated.bak')
      console.log('[settings] 已把旧版 settings.json 导入数据库')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.warn('[settings] 旧版导入失败：', error)
    }
  }

  /** 历史版本曾把 aiApiKey 明文写库：启动时自动迁移为 safeStorage 加密（返回解密后明文供缓存） */
  private migrateAiKey(raw: string): string {
    if (!raw) return ''
    if (isEncryptedSecret(raw)) {
      try {
        return decryptSecret(raw)
      } catch (error) {
        // safeStorage 密文与当前系统账户/用户数据目录绑定（Local State 里的 app-bound 密钥）。
        // 换机器、换 Windows 账户或 --user-data-dir 后解不开属预期：不能让它冒泡崩主进程，
        // 仅本轮以空 Key 启动，让用户在设置里重新填写。
        console.warn(
          '[settings] aiApiKey 解密失败，本次以空 Key 启动（请在设置中重新填写 AI Key）：',
          (error as Error).message
        )
        return ''
      }
    }
    const plain = raw.startsWith('plain:') ? Buffer.from(raw.slice(6), 'base64').toString('utf8') : raw
    const encrypted = encryptSecret(plain)
    setSetting(this.db, KEY_AI_API_KEY, encrypted)
    console.log('[settings] 已将历史明文 aiApiKey 迁移为 safeStorage 加密')
    return plain
  }

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache
    const stored = getAllSettings(this.db)
    if (Object.keys(stored).length === 0) {
      await this.importLegacy()
      const fresh = getAllSettings(this.db)
      this.cache = { ...DEFAULT_SETTINGS, ...fresh } as AppSettings
    } else {
      this.cache = { ...DEFAULT_SETTINGS, ...stored } as AppSettings
    }
    this.cache.aiApiKey = this.migrateAiKey(this.cache.aiApiKey)
    return this.cache
  }

  async get(): Promise<AppSettings> {
    return this.load()
  }

  /** 同步读取内存缓存（未加载时为默认值）；供提醒调度器等非异步上下文使用 */
  peek(): AppSettings {
    return this.cache ?? DEFAULT_SETTINGS
  }

  async set(patch: SettingsPatch): Promise<AppSettings> {
    const current = await this.load()
    // 连接保存路径修复：换端点且本次未提供非空新 Key → 清空旧 Key；换端点未重新授权 → 清空旧授权
    // （避免只合并 patch 导致旧 Key/授权残留，被 UI 对「新端点」确认授权后发往新端点）
    const derived = deriveConnectionPatch(current, patch)
    const next = { ...current, ...patch, ...derived }
    this.cache = next
    for (const [key, value] of Object.entries({ ...patch, ...derived })) {
      if (key === KEY_AI_API_KEY) {
        const v = typeof value === 'string' ? value.trim() : ''
        setSetting(this.db, KEY_AI_API_KEY, v ? encryptSecret(v) : '')
        continue
      }
      setSetting(this.db, key, value)
    }
    return next
  }
}
