const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// Compile pure renderer helpers in memory: no Electron, browser, user database or network.
function loadHelper(relative) {
  const filename = path.join(__dirname, '..', relative)
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = new Module(filename, moduleParent)
  module.filename = filename
  module.paths = Module._nodeModulePaths(path.dirname(filename))
  module._compile(output, filename)
  return module.exports
}
const moduleParent = module
const { PanelDataSession, PanelMemoryCache, sharePanelRows, PANEL_PAGE_SIZE } = loadHelper('src/renderer/src/modules/panelState.ts')
const { beginSiderResize } = loadHelper('src/renderer/src/frameResize.ts')
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function overview(ids = [], extra = {}) {
  return { batchId: 1, mode: 'initial', batchTotal: 80, batchProcessed: 2, remaining: 50, sources: [{ key: 'mail', kind: 'email', pending: 80 }], recommendations: ids.map((id) => ({ id, infoId: id, title: `card ${id}`, priority: 'focus' })), aiConfigured: true, aiMessage: '', learning: [], concerns: {}, pendingTotal: 80, priorityCounts: { focus: 80, other: 20 }, nextBeforeInfoId: 51, ...extra }
}
function fixture() {
  const requests = [], commits = [], errors = [], loading = []
  const api = { panelOverview: (key, generate, query) => {
    const request = { key, generate, query, ...deferred() }
    requests.push(request)
    return request.promise
  } }
  const session = new PanelDataSession(api, { overview: (data) => commits.push(data), loading: (value) => loading.push(value), error: (value) => errors.push(value) })
  session.start()
  return { session, requests, commits, errors, loading }
}
async function ready(f, ids = [1]) {
  f.session.setActive(true)
  f.requests[0].resolve(overview(ids))
  await tick()
  f.requests[1].resolve(overview(ids))
  await tick()
}

test('startup read is immediate; generation response commits directly with no reread', async () => {
  const f = fixture()
  f.session.setActive(true)
  assert.deepEqual(f.requests.map((r) => r.generate), [false])
  assert.equal(f.requests[0].query.limit, 30)
  f.requests[0].resolve(overview([1]))
  await tick()
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [1])
  f.requests[1].resolve(overview([2, 1]))
  await tick()
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [2, 1])
  assert.deepEqual(f.requests.map((r) => r.generate), [false, true])
})

test('timer/focus requests coalesce into a single generation lane', async () => {
  const f = fixture()
  await ready(f)
  for (let i = 0; i < 20; i++) f.session.generate()
  assert.equal(f.requests.length, 3)
  f.requests[2].resolve(overview([2]))
  await tick()
  assert.equal(f.requests.length, 3)
})

test('route/document hiding before initial read finishes never starts generation', async () => {
  const f = fixture()
  f.session.setActive(true)
  f.session.setActive(false)
  f.requests[0].resolve(overview([1]))
  await tick()
  f.session.generate()
  assert.equal(f.requests.length, 1)
  assert.equal(f.commits.length, 0)
})

test('hidden and stopped sessions reject late generation responses', async () => {
  for (const stop of [false, true]) {
    const f = fixture()
    await ready(f)
    f.session.generate()
    const count = f.commits.length
    stop ? f.session.stop() : f.session.setActive(false)
    f.requests[2].resolve(overview([99]))
    await tick()
    assert.equal(f.commits.length, count)
    f.session.generate()
    assert.equal(f.requests.length, 3)
  }
})

test('source/priority/cursor changes fence old replies and forward bounded exact queries', async () => {
  const f = fixture()
  await ready(f)
  f.session.generate()
  f.session.selectView('mail', 'other', 500)
  assert.deepEqual(f.requests[3].query, { limit: 30, priority: 'other', beforeInfoId: 500 })
  f.requests[3].resolve(overview([400], { pendingTotal: 200, priorityCounts: { focus: 80, other: 200 } }))
  await tick()
  f.requests[2].resolve(overview([999]))
  await tick()
  const latest = f.requests.at(-1)
  assert.equal(latest.key, 'mail')
  assert.equal(latest.generate, true)
  latest.resolve(overview([399]))
  await tick()
  assert.equal(f.commits.some((data) => data?.recommendations[0]?.id === 999), false)
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [399])
})

test('action bypasses a slow generation; stale reply cannot reintroduce handled cards', async () => {
  const f = fixture()
  await ready(f, [1, 2])
  f.session.generate()
  let called = false
  const mutation = deferred()
  const action = f.session.mutate(async (_key, query) => {
    called = true
    assert.equal(query.limit, PANEL_PAGE_SIZE)
    f.session.removeHandled(1)
    return mutation.promise
  })
  assert.equal(called, true)
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [2])
  f.requests[2].resolve(overview([1, 2]))
  await tick()
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [2])
  mutation.resolve(overview([2]))
  await action
  f.session.selectView('mail', 'focus')
  f.session.selectView(undefined)
  assert.equal(f.commits.at(-1).recommendations.some((r) => r.id === 1), false)
})

test('explicit refresh loading does not hold up card actions or page/source selection', async () => {
  const f = fixture()
  await ready(f, [1, 2])
  f.session.generate(true)
  assert.equal(f.loading.at(-1), true)
  let actionStarted = false
  await f.session.mutate(async () => { actionStarted = true; f.session.removeHandled(1); return overview([2]) })
  assert.equal(actionStarted, true)
  f.session.selectView('mail', 'other', 500)
  f.requests[2].resolve(overview([1, 2]))
  await tick()
  assert.equal(f.commits.some((data, i) => i > 2 && data?.recommendations.some((r) => r.id === 1)), false)
  assert.equal(f.requests.at(-1).query.beforeInfoId, 500)
})

test('mutations are exclusive and source changes reconcile only the latest view', async () => {
  const f = fixture()
  await ready(f)
  const pending = deferred()
  const action = f.session.mutate(() => pending.promise)
  let duplicate = false
  assert.equal(await f.session.mutate(async () => { duplicate = true }), false)
  assert.equal(duplicate, false)
  f.session.selectView('manual')
  pending.resolve(overview([100]))
  await action
  assert.equal(f.commits.some((data) => data?.recommendations[0]?.id === 100), false)
  assert.equal(f.requests.at(-1).key, 'manual')
  assert.equal(f.requests.at(-1).generate, false)
})

test('continue waits for generation but does not start while hidden after await', async () => {
  const f = fixture()
  await ready(f)
  f.session.generate()
  let continued = false
  const action = f.session.mutate(async () => { continued = true; return overview([3]) }, true)
  assert.equal(continued, false)
  f.session.setActive(false)
  f.requests[2].resolve(overview([2]))
  await action
  assert.equal(continued, false)
})

test('generation failure keeps cards; explicit refresh exposes error', async () => {
  const f = fixture()
  await ready(f)
  f.session.generate()
  f.requests[2].reject(new Error('quiet failure'))
  await tick()
  assert.equal(f.errors.includes('quiet failure'), false)
  assert.equal(f.commits.at(-1).recommendations.length, 1)
  f.session.generate(true)
  f.requests[3].reject(new Error('explicit failure'))
  await tick()
  assert.equal(f.errors.at(-1), 'explicit failure')
  assert.equal(f.loading.at(-1), false)
})

test('older reads cannot replace a newer generated snapshot', async () => {
  const f = fixture()
  f.session.setActive(true)
  // A focus event may arrive while startup's read is still in flight.
  f.session.generate()
  f.requests[1].resolve(overview([2]))
  await tick()
  f.requests[0].resolve(overview([1]))
  await tick()
  assert.equal(f.commits.some((data) => data?.recommendations[0]?.id === 1), false)
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [2])
  f.requests.at(-1).resolve(overview([2]))
  await tick()
})

test('StrictMode-style stop/start rejects pre-cleanup replies and loads the current query', async () => {
  const f = fixture()
  f.session.setActive(true)
  f.session.stop()
  f.session.start()
  f.session.setActive(true)
  f.session.selectView('manual', undefined, 100)
  f.requests[0].resolve(overview([999]))
  await tick()
  assert.equal(f.commits.some((data) => data?.recommendations[0]?.id === 999), false)
  const currentRead = f.requests.find((r) => r.key === 'manual' && !r.generate)
  assert.ok(currentRead)
  assert.equal(currentRead.query.beforeInfoId, 100)
  currentRead.resolve(overview([90]))
  await tick()
  f.requests.at(-1).resolve(overview([90]))
  await tick()
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [90])
})

test('action read failure cannot restore an already handled card from another cached view', async () => {
  const f = fixture()
  await ready(f, [1, 2])
  await assert.rejects(f.session.mutate(async () => {
    f.session.removeHandled(1)
    throw new Error('reconciliation read failed')
  }), /reconciliation read failed/)
  assert.deepEqual(f.commits.at(-1).recommendations.map((r) => r.id), [2])
  f.session.selectView('mail', 'focus')
  f.session.selectView(undefined)
  assert.equal(f.commits.at(-1), null)
})

test('memory cache is LRU bounded by views and total cards; no persistence required', () => {
  const cache = new PanelMemoryCache()
  for (let i = 0; i < 6; i++) cache.put(String(i), overview(Array.from({ length: 30 }, (_, n) => i * 30 + n)))
  cache.get('0')
  cache.put('6', overview([999]))
  assert.equal(cache.get('1'), undefined)
  assert.ok(cache.get('0'))
  cache.put('oversized', overview(Array.from({ length: 181 }, (_, n) => n)))
  assert.equal(cache.get('oversized'), undefined)
  cache.clear()
  assert.equal(cache.get('0'), undefined)
})

test('IPC structural sharing preserves unchanged cards only', () => {
  const previous = overview([1, 2])
  const result = sharePanelRows(previous, overview([1, 2, 3]))
  assert.equal(result.recommendations[0], previous.recommendations[0])
  assert.equal(result.recommendations[1], previous.recommendations[1])
  const changed = overview([1])
  changed.recommendations[0].title = 'changed'
  assert.notEqual(sharePanelRows(previous, changed).recommendations[0], previous.recommendations[0])
})

function resizeFixture() {
  const listeners = new Map(), frames = new Map(), widths = []
  let id = 0
  const host = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name) },
    requestAnimationFrame: (callback) => { frames.set(++id, callback); return id },
    cancelAnimationFrame: (key) => frames.delete(key)
  }
  const body = { style: { cursor: 'default', userSelect: 'text' } }
  const cleanup = beginSiderResize(host, body, 10, (value) => widths.push(value))
  const emit = (name, value = {}) => listeners.get(name)?.(value)
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()) }
  return { listeners, frames, widths, body, cleanup, emit, frame }
}

test('resize coalesces mousemoves to latest clamped width and flushes mouseup', () => {
  const f = resizeFixture()
  for (let i = 100; i < 500; i++) f.emit('mousemove', { clientX: i })
  assert.equal(f.widths.length, 0)
  assert.equal(f.frames.size, 1)
  f.frame()
  assert.deepEqual(f.widths, [320])
  f.emit('mousemove', { clientX: 5 })
  f.emit('mouseup')
  assert.deepEqual(f.widths, [320, 140])
  assert.equal(f.listeners.size, 0)
  assert.equal(f.frames.size, 0)
  assert.deepEqual(f.body.style, { cursor: 'default', userSelect: 'text' })
})

test('resize blur/unmount cleanup cancels frames, listeners and restores styles', () => {
  for (const blur of [true, false]) {
    const f = resizeFixture()
    f.emit('mousemove', { clientX: 200 })
    blur ? f.emit('blur') : f.cleanup()
    f.frame()
    f.cleanup()
    assert.equal(f.widths.length, 0)
    assert.equal(f.listeners.size, 0)
    assert.equal(f.frames.size, 0)
    assert.deepEqual(f.body.style, { cursor: 'default', userSelect: 'text' })
  }
})

test('renderer wiring keeps business views mounted, isolates badge, bounds query and drops persistent snapshot import', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../src/renderer/src/modules/panel.tsx'), 'utf8')
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/src/App.tsx'), 'utf8')
  assert.match(panel, /pathname === '\/panel' && sourceKey !== undefined && document\.visibilityState === 'visible'/)
  assert.match(panel, /sourceKey === undefined \? \(/)
  assert.match(panel, /<QqPanelBlock dateKey=\{todayKey\(\)\} range=\{qqDateRange\} onFeedback=\{loadQqKeywordProfile\} \/>/)
  assert.doesNotMatch(panel, /readPanelSnapshots|writePanelSnapshot|from '\.\/panelSnapshot'|requestQueue/)
  assert.match(panel, /onAct=\{act\}/)
  assert.doesNotMatch(panel, /disabled=\{[^}]*processing \|\| loading/)
  assert.match(panel, /overview\.nextBeforeInfoId/)
  assert.match(panel, /counts\[tab\.key\]/)
  assert.match(app, /const MailSyncBadge = memo/)
  assert.match(app, /<MailSyncBadge \/>/)
  assert.match(app, /hidden=\{location\.pathname !== m\.route\}/)
  assert.match(app, /<ModulePage module=\{m\} \/>/)
})
