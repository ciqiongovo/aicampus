'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { mkdtempSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { openDatabase } = require('../.test-out/main/db/database.js')
const { latestSchemaVersion } = require('../.test-out/main/db/migrations.js')

test('existing SQLite is snapshotted consistently before upgrade, no repeated backup after schema current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infoagent-upgrade-'))
  const path = join(dir, 'old.db')
  // 断言失败时也要把连接关掉：Windows 上句柄没放，WAL 文件就删不掉，
  // 真正的失败原因会被 finally 里的 EBUSY 盖住，看着像文件系统的问题
  const opened = []
  const open = (file) => {
    const db = openDatabase(file)
    opened.push(db)
    return db
  }
  try {
    const original = new DatabaseSync(path)
    original.exec(
      "PRAGMA journal_mode=WAL;CREATE TABLE preserved_input(value TEXT);INSERT INTO preserved_input VALUES('保留的原始数据')"
    )
    original.close()

    const upgraded = open(path)
    assert.equal(upgraded.prepare('SELECT value FROM preserved_input').get().value, '保留的原始数据')
    // 断言「升到最新版」而不是写死某个数字：每加一条迁移都要来改这里，会让人干脆把这条删掉
    assert.equal(
      upgraded.prepare('SELECT max(version) AS v FROM schema_migrations').get().v,
      latestSchemaVersion()
    )

    const files = readdirSync(dir).filter((f) => f.endsWith('.bak'))
    assert.equal(files.length, 1)

    const snapshot = new DatabaseSync(join(dir, files[0]))
    assert.equal(snapshot.prepare('SELECT value FROM preserved_input').get().value, '保留的原始数据')
    assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='ai_conversations'").get(), undefined)
    snapshot.close()

    open(path).close()
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1)
  } finally {
    for (const db of opened) {
      try {
        db.close()
      } catch {
        // 已经关过了
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
