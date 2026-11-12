'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// Independent source test: no build output or tsconfig/package edits required.
function loadTs(relative) {
  const filename = path.resolve(__dirname, relative)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod._compile(compiled, filename)
  return mod.exports
}
const { sanitizeEmailHtml: clean } = loadTs('../src/main/services/mail/sanitize.ts')
const { normalizeExternalUrl, createConfirmedExternalOpener } = loadTs('../src/main/services/externalLinkSafety.ts')

test('preserves safe email layout and automatic http/https/data raster images', () => {
  const html = clean('<table cellpadding="4"><tr><td style="color:#123456; padding:4px; font-weight:bold">Hello &amp; 中文<img src="http://example.test/a.png"><img src="https://example.test/a.png?a=1&amp;b=2"><img src="data:image/png;base64,iVBORw0KGgo="></td></tr></table>')
  assert.match(html, /<table cellpadding="4">/)
  assert.match(html, /color:#123456;padding:4px;font-weight:bold/)
  assert.match(html, /Hello &amp; 中文/)
  assert.ok(html.includes('src="http://example.test/a.png"'))
  assert.ok(html.includes('src="https://example.test/a.png?a=1&amp;b=2"'))
  assert.ok(html.includes('src="data:image/png;base64,iVBORw0KGgo="'))
  assert.match(html, /referrerpolicy="no-referrer"/)
  for (const type of ['jpeg', 'gif', 'webp', 'avif']) assert.ok(clean('<img src="data:image/' + type + ';base64,AAAA">').includes('src="data:image/'))
})

test('removes executable content, form, refresh, base, foreign namespaces and event attributes', () => {
  const html = clean('<script>alert(1)</script><iframe srcdoc="x"></iframe><object>x</object><embed src="x"><form action="https://evil.test"><input></form><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><svg><a xlink:href="javascript:alert(1)">x</a></svg><math><mtext>x</mtext></math><p onclick="x" onfocus=x>safe</p>')
  assert.equal(html, '<p>safe</p>')
})

test('decoded entity and control-obfuscated dangerous protocols cannot survive', () => {
  for (const url of ['java&#x73;cript:alert(1)', 'jav&#97;script:alert(1)', 'java&Tab;script:alert(1)', 'javascript&colon;alert(1)', 'vbscript:msgbox(1)', 'data:text/html,evil', 'file:///etc/passwd', 'blob:https://example.test/x', '//evil.test/x']) {
    const html = clean('<a href="' + url + '">go</a><img src="' + url + '">')
    assert.ok(!html.includes('href='), html)
    assert.ok(!html.includes('src='), html)
  }
})

test('srcset, background, ping, namespaced attributes, and SVG data images are dropped', () => {
  const html = clean('<a href="https://example.test/" ping="https://evil.test" xlink:href="javascript:1">go</a><img srcset="https://evil.test/a 1x" lowsrc="https://evil.test" src="data:image/svg+xml;base64,AAAA" onerror=x><table background="https://evil.test/a"></table>')
  assert.ok(!/srcset|lowsrc|ping=|xlink|onerror|background=|svg\+xml/.test(html), html)
  assert.ok(html.includes('href="https://example.test/"'))
  assert.match(html, /target="_blank" rel="noopener noreferrer"/)
})

test('CSS URL, import, escaped URL, expression, font and image functions cannot exfiltrate', () => {
  const html = clean('<style>@import "https://evil.test"; @font-face{src:url(https://evil.test)}</style><p style="background-image:url(https://evil.test);background:url(https://evil.test);color:expression(alert(1));font-family:u\\72l(https://evil.test);list-style-image:image-set(url(https://evil.test));--x:url(https://evil.test);width:calc(1px);color:rgb(1, 2, 3);text-align:center">safe</p>')
  assert.equal(html, '<p style="color:rgb(1, 2, 3);text-align:center">safe</p>')
})

test('malformed quotes, duplicate attributes, raw text and mXSS-like payloads remain inert', () => {
  const payloads = [
    '<img src="https://example.test/a" src="javascript:alert(1)" onerror=alert(1)>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<p title="&quot; onmouseover=&quot;evil">&lt;script&gt;evil&lt;/script&gt;</p>',
    '<textarea><img src=x onerror=alert(1)></textarea><p>safe</p>'
  ]
  for (const payload of payloads) {
    const html = clean(payload)
    assert.ok(!/<(?:script|svg|math|style|noscript|textarea)\b|\son[a-z]+=/i.test(html.replace(/title="[^"]*"/g, '')), html)
    assert.equal(clean(html), html)
  }
})

test('deep input is bounded and empty input remains empty', () => {
  assert.equal(clean(''), '')
  assert.ok(clean('<div>'.repeat(500) + '<script>evil</script>' + '</div>'.repeat(500)).length < 2000)
})

test('parser resolves from existing mailparser at the production output location', () => {
  const runtimeRequire = Module.createRequire(path.resolve(__dirname, '../out/main/index.js'))
  const mailRequire = Module.createRequire(runtimeRequire.resolve('mailparser'))
  assert.equal(typeof mailRequire('htmlparser2').parseDocument, 'function')
})

test('external gate rejects unsafe, ambiguous, credential and control URLs before confirmation', async () => {
  let calls = 0
  const gate = createConfirmedExternalOpener({ confirm: async () => { calls++; return true }, open: async () => { calls++ } })
  for (const url of ['javascript:1', 'data:text/html,x', 'file:///tmp/x', 'mailto:x@y', '//evil.test', ' https://example.test', 'https://', 'https://user:pass@example.test', 'https://example.test/\n', 'https://example.test/\\evil', 'https://example.test/\u202eevil']) {
    assert.equal(normalizeExternalUrl(url), null, url)
    assert.equal(await gate(url), false)
  }
  assert.equal(calls, 0)
})

test('external open is strictly after explicit confirmation and receives canonical URL', async () => {
  const events = []
  const gate = createConfirmedExternalOpener({ confirm: async (url, hostname) => { events.push(['confirm', url, hostname]); return true }, open: async url => { events.push(['open', url]) } })
  assert.equal(await gate('HTTPS://EXAMPLE.TEST:443/path?q=1'), true)
  assert.deepEqual(events, [['confirm', 'https://example.test/path?q=1', 'example.test'], ['open', 'https://example.test/path?q=1']])
})

test('cancel, confirmation failure and shell failure fail closed and release gate', async () => {
  let opened = 0
  let mode = 'cancel'
  const gate = createConfirmedExternalOpener({ confirm: async () => { if (mode === 'throw') throw Error('dialog'); return mode !== 'cancel' }, open: async () => { opened++; if (mode === 'shell') throw Error('shell') } })
  assert.equal(await gate('https://example.test/'), false)
  mode = 'throw'; assert.equal(await gate('https://example.test/'), false)
  assert.equal(opened, 0)
  mode = 'shell'; assert.equal(await gate('https://example.test/'), false)
  mode = 'ok'; assert.equal(await gate('https://example.test/'), true)
  assert.equal(opened, 2)
})

test('pending confirmation suppresses repeated clicks rather than queueing dialogs', async () => {
  let resolve
  let calls = 0
  const gate = createConfirmedExternalOpener({ confirm: () => { calls++; return new Promise(r => { resolve = r }) }, open: async () => {} })
  const first = gate('https://example.test/one')
  assert.equal(await gate('https://example.test/two'), false)
  assert.equal(calls, 1)
  resolve(true)
  assert.equal(await first, true)
})
