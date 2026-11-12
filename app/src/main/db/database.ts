import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { migrate, latestSchemaVersion } from './migrations'
/** A consistent SQLite snapshot (including committed WAL data) is taken before upgrading an existing application DB. */
export function openDatabase(dbPath: string): DatabaseSync {
  const existing=dbPath!==':memory:'&&existsSync(dbPath)
  const db=new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    const hasMigrations=!!db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()
    const current=hasMigrations?(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number|null}).v??0:0
    if(existing&&current<latestSchemaVersion()) {
      const backup=dbPath+'.pre-v'+latestSchemaVersion()+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.bak'
      db.exec("VACUUM INTO '"+backup.replace(/'/g,"''")+"'")
      console.log('[db] 升级前已保存一致性数据库备份（含隐私数据，请妥善保管）')
    }
    migrate(db)
    return db
  } catch(error) { db.close();throw error }
}
