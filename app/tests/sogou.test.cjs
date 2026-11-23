'use strict'
// 搜狗检索通道的解析测试：结果页有条目、有号名、有精确时间；
// 认号要认对，别把学校官号当成学生会。
// 先编译：npx tsc -p tsconfig.test.json
// 再运行：node tests/sogou.test.cjs
const assert = require('node:assert/strict')
const {
  parseSogouItems,
  pickCanonical,
  extractIdentity
} = require('../.test-out/main/services/benchmark/sogou.js')

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

/** 按搜狗真实结构裁的一段结果页：两条都属于「同济大学学生会」 */
const HTML = `
<div class="news-box"><ul class="news-list">
<li id="sogou_vr_11002601_box_0" d="ab735a258a90e8e1-6bee54fcbd896b2a-15d95ed456ad95a47e7c1ec6bfb898a0">
  <div class="txt-box">
    <h3><a target="_blank" href="/link?url=dn9a_-gY295K0Rci_xozVXfd_A&amp;type=2&amp;token=B9D0" id="sogou_vr_11002601_title_0"><em><!--red_beg-->同济大学学生会<!--red_end--></em>改革进行时</a></h3>
    <p class="txt-info">为落实共青团中央……</p>
    <div class="s-p">
      <span class="all-time-y2">同济大学学生会</span>
      <span class="s2"><script>document.write(timeConvert('1700753669'))</script></span>
    </div>
  </div>
</li>
<li id="sogou_vr_11002601_box_1" d="ab735a258a90e8e1-6bee54fcbd896b2a-e5124fe594f9fe63b22c91ed4775caff">
  <div class="txt-box">
    <h3><a target="_blank" href="/link?url=dn9a_-gY295K0Rci_xozVXfd_B&amp;type=2&amp;token=B9D0" id="sogou_vr_11002601_title_1">部门调整公示</a></h3>
    <div class="s-p">
      <span class="all-time-y2">同济大学学生会</span>
      <span class="s2"><script>document.write(timeConvert('1576597429'))</script></span>
    </div>
  </div>
</li>
</ul></div>`

function item(account, title) {
  return {
    title,
    account,
    publishedAt: null,
    fingerprint: '',
    link: '/link?url=x',
    cookie: ''
  }
}

run('结果页解析：标题去掉高亮标签，号名与时间都取到', () => {
  const items = parseSogouItems(HTML)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '同济大学学生会改革进行时')
  assert.equal(items[0].account, '同济大学学生会')
  // 1700753669 → 2023-11-23 23:34:29（东八区）
  assert.equal(items[0].publishedAt, '2023-11-23 23:34:29')
  assert.equal(items[1].title, '部门调整公示')
  // 实体 &amp; 要还原，否则带上 &type=2 时解链会 404
  assert.ok(items[0].link.includes('&type=2'), 'link 应还原 &amp;')
})

run('指纹逐条不同，可用于去重', () => {
  const items = parseSogouItems(HTML)
  assert.notEqual(items[0].fingerprint, items[1].fingerprint)
  assert.ok(items[0].fingerprint.length > 20)
})

run('认号：号名与查询词一字不差，直接用', () => {
  const items = [item('同济大学学生会', 'a'), item('同济大学学生会', 'b'), item('其他号', 'c')]
  assert.equal(pickCanonical(items, '同济大学学生会'), '同济大学学生会')
})

run('认号：只有一条完全一致也认（不能按频次取胜）', () => {
  // 真实情况：搜「上海交通大学学生会」，结果里高频的是「上海交通大学」学校官号
  const items = [
    item('上海交通大学', 'a'),
    item('上海交通大学', 'b'),
    item('上海交通大学', 'c'),
    item('上海交通大学学生会', 'd')
  ]
  assert.equal(pickCanonical(items, '上海交通大学学生会'), '上海交通大学学生会')
})

run('认号：只有更宽泛的官号时不认，宁可报没找到', () => {
  const items = [item('上海交通大学', 'a'), item('上海交通大学', 'b')]
  assert.equal(pickCanonical(items, '上海交通大学学生会'), '')
})

run('认号：号名比查询更详细时可以认（花名场景）', () => {
  const items = [item('团聚上大', 'a'), item('团聚上大', 'b')]
  assert.equal(pickCanonical(items, '上大'), '团聚上大')
})

run('认号：一条都对不上就返回空，不要硬塞噪声', () => {
  const items = [item('自主选拔在线', 'a'), item('高校人才网V', 'b')]
  assert.equal(pickCanonical(items, '上海科技大学学生会'), '')
})

run('从文章页取规范地址：__biz + mid + idx 合成永久链接', () => {
  const html = `<script>var biz = "MzI2MzIxMDcxOA=="; var mid = "2650334585"; var idx = "1";</script>`
  const got = extractIdentity(html)
  assert.ok(got)
  assert.equal(got.key, 'MzI2MzIxMDcxOA==:2650334585:1')
  assert.ok(got.url.startsWith('https://mp.weixin.qq.com/s?__biz='))
})

run('取不到 biz/mid 时返回 null，不编一个假地址', () => {
  assert.equal(extractIdentity('<html>环境异常</html>'), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
