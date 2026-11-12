const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { layoutKeywordCloud } = require('../.test-out/renderer/src/modules/keywordCloudLayout.js')

const measure = (s, size) => [...s].reduce((n, c) => n + (/[\u3400-\u9fff]/u.test(c) ? size : size * 0.62), 0)
function check(words, width, height) {
  for (const word of words) {
    const w = word.rotate ? word.height : word.width
    const h = word.rotate ? word.width : word.height
    assert.ok(word.x - w / 2 >= 0 && word.x + w / 2 <= width)
    assert.ok(word.y - h / 2 >= 0 && word.y + h / 2 <= height)
  }
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) {
    const a = words[i], b = words[j]
    const aw = a.rotate ? a.height : a.width, ah = a.rotate ? a.width : a.height
    const bw = b.rotate ? b.height : b.width, bh = b.rotate ? b.width : b.height
    assert.ok(Math.abs(a.x - b.x) >= (aw + bw) / 2 || Math.abs(a.y - b.y) >= (ah + bh) / 2, `${a.keyword} and ${b.keyword} overlap`)
  }
}

test('cloud keeps all words inside bounds without overlap, ordered by absolute weight', () => {
  const items = Array.from({ length: 36 }, (_, i) => ({ keyword: `实习项目${i}`, weight: i % 9 === 0 ? -(37 - i) / 15 : (37 - i) / 15 }))
  const words = layoutKeywordCloud(items, 760, 430, measure)
  assert.equal(words.length, items.length)
  check(words, 760, 430)
  for (let i = 1; i < words.length; i++) assert.ok(words[i - 1].fontSize >= words[i].fontSize)
  assert.deepEqual(words, layoutKeywordCloud(items, 760, 430, measure))
})

test('cloud handles empty geometry and narrow/dense profiles', () => {
  assert.deepEqual(layoutKeywordCloud([{ keyword: 'A', weight: 1 }], 0, 200, measure), [])
  const items = Array.from({ length: 200 }, (_, i) => ({ keyword: `项目${i}`, weight: 3 - i / 200 }))
  const start = performance.now()
  const words = layoutKeywordCloud(items, 520, 520, measure)
  assert.equal(words.length, items.length)
  check(words, 520, 520)
  assert.ok(performance.now() - start < 8000, 'layout should remain responsive')
})
