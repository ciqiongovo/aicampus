'use strict'
// 导入落库的集成测试：公众号名建源、学校归属、未采集也能在列表里筛到
// 先编译：tsc -p tsconfig.test.json
// 再运行：node tests/benchmark-import-db.test.cjs
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')

const { benchmarkMigrations } = require('../.test-out/main/db/benchmarkSchema.js')
const dao = require('../.test-out/main/db/dao/benchmarkDao.js')
const { importLinkText } = require('../.test-out/main/services/benchmark/import-links.js')

let passed = 0
let failed = 0

function run(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

function makeDb() {
  const db = new DatabaseSync(':memory:')
  for (const migration of benchmarkMigrations) {
    for (const sql of migration.up) db.exec(sql)
  }
  return db
}

function url(mid) {
  return `https://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=${mid}&idx=1&sn=98272891260c9492f0f6dfb9d14bde8a`
}

const CSV = [
  '公众号名称,文章标题,文章链接,发布时间',
  `上海交通大学学生会,迎新晚会预告,${url(3001)},2025-09-10 19:30:00`,
  `上海交通大学学生会,社团招新,${url(3002)},2025-09-12 08:00:00`
].join('\n')

run('导入表格：公众号名建成源，文章挂到源上', () => {
  const db = makeDb()
  const r = importLinkText(db, CSV)
  assert.equal(r.accepted, 2)
  assert.equal(r.accounts, 1)
  const sources = dao.listSources(db)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, '上海交通大学学生会')
  // 名字里的校名会被猜出来，不用人手填
  assert.equal(sources[0].school, '上海交通大学')
  assert.equal(sources[0].articleCount, 2)
})

run('导入时选的学校兜底：号名猜不出校名也能归类', () => {
  const db = makeDb()
  // 「上工程团委」里没有完整校名，靠名字猜不出来，只能靠用户选的学校
  const text = [`上工程团委,迎新晚会,${url(3010)},2025-09-10 19:30:00`].join('\n')
  const r = importLinkText(db, text, '上海工程技术大学')
  assert.equal(r.accepted, 1)
  const row = dao.listArticles(db, { school: '上海工程技术大学' })[0]
  assert.ok(row, '按学校应能筛到')
  assert.equal(row.school, '上海工程技术大学')
  assert.equal(row.sourceName, '上工程团委')
  assert.equal(row.title, '迎新晚会')
  assert.equal(row.publishedAt, '2025-09-10 19:30:00')
})

run('没采正文也能按学校筛到（hint_school 兜底）', () => {
  const db = makeDb()
  // 纯链接，没有公众号名，只有用户选的学校
  importLinkText(db, url(3020), '同济大学')
  const rows = dao.listArticles(db, { school: '同济大学' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'new')
  assert.equal(rows[0].school, '同济大学')
  assert.ok(dao.listSchools(db).includes('同济大学'), '筛选下拉里也要有这所学校')
})

run('同一份表再导一次：全部算重复，不重复建源', () => {
  const db = makeDb()
  importLinkText(db, CSV)
  const again = importLinkText(db, CSV)
  assert.equal(again.accepted, 0)
  assert.equal(again.duplicated, 2)
  assert.equal(dao.listSources(db).length, 1)
})

run('已有归属的号不会被这批导入选的学校改掉', () => {
  const db = makeDb()
  dao.ensureSourceForImport(db, '复旦大学学生会', '复旦大学')
  importLinkText(db, [`复旦大学学生会,迎新,${url(3030)},2025-09-01 10:00:00`].join('\n'), '同济大学')
  const src = dao.listSources(db).find((s) => s.name === '复旦大学学生会')
  assert.equal(src.school, '复旦大学')
})

run('表格里没有链接的行不会被算进任何一类', () => {
  const db = makeDb()
  const r = importLinkText(db, ['公众号名称,文章标题,文章链接', '上海大学学生会,没有链接的行,'].join('\n'))
  assert.equal(r.accepted, 0)
  assert.equal(r.invalid, 0)
  assert.equal(dao.listArticles(db, {}).length, 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
