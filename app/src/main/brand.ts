/**
 * 品牌与应用数据目录。
 *
 * 应用从 InfoAgent 改名为「知枢」后，Electron 的 userData 目录会跟着 productName 变，
 * 用户已有的库（公众号源、原文、抽取结果、账号密文）就找不着了。
 * 所以目录名在这里定死，并在新目录还没有库时把旧库整体搬过来。
 *
 * 目录用英文 ZhiShu 而不是「知枢」：路径会进 spawn 参数、SQLite 连接串、
 * 打包工具的缓存目录，中文字符在这些地方最容易变成乱码或解析失败。
 * 显示给用户的名字走 APP_NAME，两者分开。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const APP_NAME = '知枢'
export const APP_NAME_EN = 'ZhiShu'
/** 报名表里的全称，用在窗口副标题与关于信息里 */
export const APP_TAGLINE = '高校活动对标与决策支持'
export const APP_ID = 'com.zhishu.desktop'
export const DB_FILE = 'zhishu.db'

/**
 * 旧版目录名。产品名与包名大小写不一致，历史上两种拼法都出现过，
 * 都试一遍不算多余——漏试一次的代价是用户以为数据丢了。
 */
const LEGACY_DIRS = ['InfoAgent', 'infoagent']
const LEGACY_DB = 'infoagent.db'

export interface UserDataReady {
  dir: string
  dbPath: string
  /** 是否从旧版 InfoAgent 目录搬过一次库 */
  migrated: boolean
}

/**
 * 在最早期调用（app ready 之前、任何 getPath('userData') 之前）。
 *
 * 用 VACUUM INTO 而不是文件复制：旧库是 WAL 模式，最近的写入可能还躺在 -wal 里，
 * 只 copy 主文件会丢掉最近几天的数据。打开旧库时 SQLite 会自己把 WAL 叠回去，
 * 导出来的才是完整状态。
 */
export function prepareUserData(): UserDataReady {
  const dataRoot = app.getPath('appData')
  const dir = join(dataRoot, APP_NAME_EN)
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)

  const dbPath = join(dir, DB_FILE)
  let migrated = false
  if (!existsSync(dbPath)) {
    for (const legacyDir of LEGACY_DIRS) {
      const legacy = join(dataRoot, legacyDir, LEGACY_DB)
      if (!existsSync(legacy) || statSync(legacy).size === 0) continue
      if (copyDatabase(legacy, dbPath)) {
        migrated = true
        break
      }
    }
  }
  return { dir, dbPath, migrated }
}

function copyDatabase(from: string, to: string): boolean {
  let source: DatabaseSync | null = null
  try {
    source = new DatabaseSync(from)
    // VACUUM INTO 要求目标文件不存在，调用前已确认过
    source.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`)
    return true
  } catch {
    // 搬不动就用空库启动：宁可让用户看到「库里还没有文章」，
    // 也不要因为迁移失败把应用卡在启动阶段
    return false
  } finally {
    try {
      source?.close()
    } catch {
      /* 关不掉也无所谓，进程紧接着就往下走 */
    }
  }
}
