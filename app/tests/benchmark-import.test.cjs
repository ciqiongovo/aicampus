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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
