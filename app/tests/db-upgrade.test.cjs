'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {DatabaseSync}=require('node:sqlite')
const {mkdtempSync,readdirSync,rmSync}=require('node:fs')
const {join}=require('node:path')
const {tmpdir}=require('node:os')
const {openDatabase}=require('../.test-out/main/db/database.js')
test('existing SQLite is snapshotted consistently before upgrade, no repeated backup after schema current',()=>{
 const dir=mkdtempSync(join(tmpdir(),'infoagent-upgrade-')),path=join(dir,'old.db')
 try{
  const original=new DatabaseSync(path);original.exec("PRAGMA journal_mode=WAL;CREATE TABLE preserved_input(value TEXT);INSERT INTO preserved_input VALUES('保留的原始数据')");original.close()
  const upgraded=openDatabase(path);assert.equal(upgraded.prepare('SELECT value FROM preserved_input').get().value,'保留的原始数据');assert.equal(upgraded.prepare('SELECT max(version) AS v FROM schema_migrations').get().v,29);upgraded.close()
  const files=readdirSync(dir).filter(f=>f.endsWith('.bak'));assert.equal(files.length,1)
  const snapshot=new DatabaseSync(join(dir,files[0]));assert.equal(snapshot.prepare('SELECT value FROM preserved_input').get().value,'保留的原始数据');assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='ai_conversations'").get(),undefined);snapshot.close()
  openDatabase(path).close();assert.equal(readdirSync(dir).filter(f=>f.endsWith('.bak')).length,1)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
