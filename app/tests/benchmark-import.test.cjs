'use strict'
// 链接导入的解析测试：CSV 带标题/时间、纯文本粘贴、转义与残渣清理
// 先编译：tsc -p tsconfig.test.json
// 再运行：node tests/benchmark-import.test.cjs
const assert = require('node:assert/strict')

const { parseLinkRows } = require('../.test-out/main/services/benchmark/link-import.js')
const { articleUrlKey } = require('../.test-out/shared/benchmark.js')

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

/** wechatDownload 导出的真实表头 */
const HEADER = 'title,url,time,like_num,read_num,share_num,comment_count'

function url(mid, idx = 1) {
  return `http://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=${mid}&idx=${idx}&sn=98272891260c9492f0f6dfb9d14bde8a&chksm=f2b6330c820bc5fab&scene=27#wechat_redirect`
}

run('CSV：标题与时间都带出来', () => {
  const text = [
    HEADER,
    `科技爱好者周刊#323：技术公司的口号比拼,${url(2650238548)},2024-11-01 08:32:43,0,0,0,{}`,
    `迎新晚会预告,${url(2650238549)},2025-09-01 12:00:00,3,120,4,{}`
  ].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 2, '应解析出两条')
  assert.equal(rows[0].title, '科技爱好者周刊#323：技术公司的口号比拼')
  assert.equal(rows[0].publishedAt, '2024-11-01 08:32:43')
  assert.equal(rows[1].title, '迎新晚会预告')
  assert.equal(rows[1].publishedAt, '2025-09-01 12:00:00')
  // 锚点必须去掉：带着 #wechat_redirect 抓页面会多一次跳转
  assert.ok(!rows[0].url.includes('#'), 'URL 不应带锚点')
  assert.ok(rows[0].url.includes('&mid='), '&amp; 应还原成 &')
})

run('CSV：标题里有逗号和双引号', () => {
  const text = [
    HEADER,
    `"迎新晚会，我们来啦 ""2025""",${url(2650238600)},2025-09-02 19:30:00,0,0,0,{}`
  ].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '迎新晚会，我们来啦 "2025"')
  assert.equal(rows[0].publishedAt, '2025-09-02 19:30:00')
})

run('URL 里的 &amp; 被还原，去重键能算出来', () => {
  const text = `标题,${url(2650238610).replace(/&/g, '&amp;')},2025-09-03 08:00:00`
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].url.includes('&mid='), '应还原成 &')
  assert.ok(articleUrlKey(rows[0].url), '应能算出 __biz+mid+idx')
})

run('纯文本：一行一个链接，不把上下文当标题', () => {
  const text = ['看这个：' + url(2650238620), '', '还有 ' + url(2650238621)].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, '')
  assert.equal(rows[0].publishedAt, null)
})

run('BOM 不影响第一行', () => {
  const text = '\uFEFF' + [HEADER, `带 BOM 的标题,${url(2650238630)},2025-09-04 10:00:00`].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows[0].title, '带 BOM 的标题')
})

run('同一行多个链接：标题只给第一个', () => {
  const text = `标题甲,${url(2650238640)},${url(2650238641)},2025-09-05 11:00:00`
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, '标题甲')
  assert.equal(rows[1].title, '')
  assert.equal(rows[1].publishedAt, null)
})

run('只有表头、没有数据：返回空数组', () => {
  assert.deepEqual(parseLinkRows(HEADER), [])
  assert.deepEqual(parseLinkRows(''), [])
})

run('短链没有 __biz，但也能算出稳定的去重键', () => {
  const rows = parseLinkRows('https://mp.weixin.qq.com/s/AbCdEfGhIjK')
  assert.equal(rows.length, 1)
  assert.equal(articleUrlKey(rows[0].url), 'short:/s/AbCdEfGhIjK')
})

run('末尾粘着句读和右括号也能清掉', () => {
  const rows = parseLinkRows(`（原文：${url(2650238650)}）。`)
  assert.equal(rows.length, 1)
  assert.ok(!/[)）。]$/.test(rows[0].url), 'URL 末尾不应带标点')
  assert.ok(articleUrlKey(rows[0].url))
})

// ---------------- 中文表头 / 公众号名 / Excel 导出 ----------------

run('中文表头：公众号名在第一列也不会被当成标题', () => {
  const text = [
    '公众号名称,文章标题,文章链接,发布时间,阅读数',
    `上海交通大学学生会,"迎新晚会，我们来啦",${url(2650238700)},2025-09-10 19:30:00,1200`,
    `上海交通大学学生会,社团招新,${url(2650238701)},2025-09-12 08:00:00,800`
  ].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, '迎新晚会，我们来啦')
  assert.equal(rows[0].account, '上海交通大学学生会')
  assert.equal(rows[0].publishedAt, '2025-09-10 19:30:00')
  assert.equal(rows[1].title, '社团招新')
})

run('中文表头：列顺序换了也按表头取值', () => {
  const text = [
    '发布时间,文章链接,公众号名称,文章标题',
    `2025/9/1 12:00,${url(2650238710)},同济大学团委,开学第一课`
  ].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows[0].title, '开学第一课')
  assert.equal(rows[0].account, '同济大学团委')
  assert.equal(rows[0].publishedAt, '2025-09-01 12:00:00')
})

run('没有表头：同一列重复出现的公众号名不会被当成标题', () => {
  const text = [
    `复旦大学学生会,迎新晚会,${url(2650238720)},2025-09-02 19:00:00`,
    `复旦大学学生会,社团招新嘉年华,${url(2650238721)},2025-09-03 19:00:00`,
    `复旦大学学生会,新生答疑,${url(2650238722)},2025-09-04 19:00:00`
  ].join('\n')
  const rows = parseLinkRows(text)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].account, '复旦大学学生会')
  assert.equal(rows[0].title, '迎新晚会')
  assert.equal(rows[1].title, '社团招新嘉年华')
})

run('「2026年10月11日」这种写法也认', () => {
  const rows = parseLinkRows(`标题,${url(2650238730)},2026年10月11日 09:05`)
  assert.equal(rows[0].publishedAt, '2026-10-11 09:05:00')
})

run('Excel 把日期存成数字时按序列号换算', () => {
  // 45292 = 2024-01-01（Excel 的 1899-12-30 起算）
  const rows = parseLinkRows(`标题,${url(2650238740)},45292.5`)
  assert.equal(rows[0].publishedAt, '2024-01-01 12:00:00')
})

run('表头行本身不会变成一篇文章', () => {
  const rows = parseLinkRows('公众号名称,文章标题,文章链接,发布时间')
  assert.equal(rows.length, 0)
})

// ---------------- xlsx ----------------

const { xlsxToCsv } = require('../.test-out/main/services/benchmark/xlsx.js')

/** 造一个最小的 xlsx（zip + 两个 XML），够测「解压 → 读表」这条链 */
function makeXlsx(rows) {
  const zlib = require('node:zlib')
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const shared = []
  const sheetRows = rows
    .map((cells, r) => {
      const tds = cells
        .map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
          shared.push(cell)
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`
        })
        .join('')
      return `<row r="${r + 1}">${tds}</row>`
    })
    .join('')
  const files = {
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst>${shared
      .map((s) => `<si><t>${esc(s)}</t></si>`)
      .join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`
  }

  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const data = zlib.deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

run('xlsx 能解出表头、标题、链接和时间', () => {
  const buf = makeXlsx([
    ['公众号名称', '文章标题', '文章链接', '发布时间'],
    ['上海大学学生会', '迎新晚会预告', url(2650238750), 45678.5],
    ['上海大学学生会', '社团招新', url(2650238751), '2025-09-20 10:00:00']
  ])
  const rows = parseLinkRows(xlsxToCsv(buf))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].account, '上海大学学生会')
  assert.equal(rows[0].title, '迎新晚会预告')
  assert.equal(rows[0].publishedAt, '2025-01-21 12:00:00')
  assert.equal(rows[1].publishedAt, '2025-09-20 10:00:00')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)