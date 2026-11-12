'use strict'
// 日程 / 待办服务单元测试：v14 迁移、清单 CRUD、条目 CRUD 与完成时刻同步、视图计数、快速添加解析
// 先编译：node node_modules/typescript/bin/tsc -p tsconfig.test.json
// 再运行：node --test tests/todo.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { openDatabase } = require('../.test-out/main/db/database.js')
const todo = require('../.test-out/main/services/todo/service.js')
const { parseQuickAdd, dueLabel, clockRange } = require('../.test-out/shared/todo.js')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'infoagent-todo-'))
  const db = openDatabase(join(dir, 'todo.db'))
  t.after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return db
}

function iso(d) {
  return d.toISOString()
}
function daysFrom(now, days, hour = 9, minute = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute, 0, 0)
  return d
}

test('v14 迁移新增 todo_lists 与 items 的待办列', (t) => {
  const db = fixture(t)
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name)
  for (const col of ['list_id', 'completed_at', 'priority', 'event_end_at', 'all_day']) assert.ok(cols.includes(col), `items 缺列 ${col}`)
  const listCols = db.prepare('PRAGMA table_info(todo_lists)').all().map((c) => c.name)
  for (const col of ['id', 'name', 'color', 'sort_order', 'created_at']) assert.ok(listCols.includes(col), `todo_lists 缺列 ${col}`)
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 29)
})

test('清单：创建/重名拒绝/重命名/删除后条目回到收集箱', (t) => {
  const db = fixture(t)
  const created = todo.createTodoList(db, '  课表  ')
  assert.equal(created.ok, true)
  assert.equal(created.list.name, '课表')
  assert.match(created.list.color, /^#[0-9A-F]{6}$/i)
  assert.equal(todo.createTodoList(db, '课表').ok, false)
  assert.equal(todo.createTodoList(db, '   ').error, '清单名称不能为空')

  const item = todo.createTodoItem(db, { title: '线性代数', listId: created.list.id })
  assert.equal(item.item.listId, created.list.id)
  assert.equal(item.item.listName, '课表')

  const renamed = todo.updateTodoList(db, created.list.id, { name: '课程' })
  assert.equal(renamed.ok, true)
  assert.equal(todo.getTodoItem(db, item.item.id).listName, '课程')

  assert.equal(todo.deleteTodoList(db, created.list.id).ok, true)
  assert.equal(todo.getTodoItem(db, item.item.id).listId, null)
  assert.equal(todo.listTodoLists(db).length, 0)
})

test('条目：创建时间字段、更新补丁、完成时刻与状态同步、删除', (t) => {
  const db = fixture(t)
  const now = new Date()
  const start = daysFrom(now, 1, 8, 15)
  const end = daysFrom(now, 1, 9, 55)
  const created = todo.createTodoItem(db, {
    title: '  信息技术导论  ',
    notes: '教学中心 201',
    priority: 2,
    deadlineAt: iso(start),
    eventStartAt: iso(start),
    eventEndAt: iso(end)
  })
  assert.equal(created.ok, true)
  const item = created.item
  assert.equal(item.title, '信息技术导论')
  assert.equal(item.priority, 2)
  assert.equal(item.eventStartAt, iso(start))
  assert.equal(item.eventEndAt, iso(end))
  assert.equal(item.allDay, false)
  assert.equal(item.status, '待处理')
  assert.equal(item.completedAt, null)

  // 结束早于开始时丢弃结束时间，避免日程格子里出现负高度
  const bad = todo.createTodoItem(db, { title: '倒序时间', eventStartAt: iso(end), eventEndAt: iso(start) })
  assert.equal(bad.item.eventEndAt, null)

  const patched = todo.updateTodoItem(db, item.id, { title: '信息技术导论（实验）', priority: 3, allDay: true, notes: '' })
  assert.equal(patched.item.title, '信息技术导论（实验）')
  assert.equal(patched.item.priority, 3)
  assert.equal(patched.item.allDay, true)
  assert.equal(patched.item.notes, '')
  assert.equal(todo.updateTodoItem(db, item.id, { title: '   ' }).error, '标题不能为空')
  assert.equal(todo.updateTodoItem(db, 9999, { title: 'x' }).error, '条目不存在')

  // 直接改 status 也要把 completed_at 一起写，否则「已完成」分组排序错位
  const done = todo.updateTodoItem(db, item.id, { status: '已完成' })
  assert.ok(done.item.completedAt)
  const reopened = todo.updateTodoItem(db, item.id, { status: '待处理' })
  assert.equal(reopened.item.completedAt, null)

  const toggled = todo.toggleTodoItem(db, item.id, true)
  assert.equal(toggled.item.status, '已完成')
  assert.ok(toggled.item.completedAt)
  const untoggled = todo.toggleTodoItem(db, item.id, false)
  assert.equal(untoggled.item.status, '待处理')
  assert.equal(untoggled.item.completedAt, null)

  assert.equal(todo.deleteTodoItem(db, item.id).ok, true)
  assert.equal(todo.getTodoItem(db, item.id), null)
  assert.equal(todo.deleteTodoItem(db, item.id).error, '条目不存在')
})

test('视图计数：今天含过期、最近 7 天、收集箱、无日期与已完成分开算', (t) => {
  const db = fixture(t)
  const now = new Date()
  const list = todo.createTodoList(db, '课表').list
  todo.createTodoItem(db, { title: '过期作业', deadlineAt: iso(daysFrom(now, -2, 23, 59)) })
  todo.createTodoItem(db, { title: '今天上课', deadlineAt: iso(daysFrom(now, 0, 18, 0)) })
  todo.createTodoItem(db, { title: '三天后', deadlineAt: iso(daysFrom(now, 3, 10, 0)), listId: list.id })
  todo.createTodoItem(db, { title: '十天后', deadlineAt: iso(daysFrom(now, 10, 10, 0)) })
  const undated = todo.createTodoItem(db, { title: '没时间的想法' })
  todo.toggleTodoItem(db, undated.item.id, true)

  const snapshot = todo.getTodoSnapshot(db, now)
  assert.equal(snapshot.items.length, 5)
  assert.equal(snapshot.counts.overdue, 1)
  assert.equal(snapshot.counts.today, 2) // 过期 + 今天
  assert.equal(snapshot.counts.next7, 3) // 过期 + 今天 + 三天后
  assert.equal(snapshot.counts.inbox, 3) // 过期作业 + 今天上课 + 十天后（都没挂清单）
  assert.equal(snapshot.counts.completed, 1)
  assert.equal(snapshot.counts.open, 4)
  assert.equal(snapshot.counts.undated, 0) // 无日期那条已变成已完成，不再计入 open
  assert.equal(snapshot.lists[0].openCount, 1)
  assert.equal(snapshot.now, now.toISOString())

  // 只有上课时间、没有截止时间的课程也必须计入今天，否则左栏计数会和右栏列表对不上
  todo.createTodoItem(db, { title: '只有上课时间', eventStartAt: iso(daysFrom(now, 0, 9, 0)), eventEndAt: iso(daysFrom(now, 0, 10, 0)) })
  const withEvent = todo.getTodoSnapshot(db, now)
  assert.equal(withEvent.counts.today, 3)
  assert.equal(withEvent.counts.next7, 4)
  assert.equal(withEvent.counts.overdue, 1)
  assert.equal(withEvent.counts.inbox, 4)
  assert.equal(withEvent.counts.open, 5)
})

test('快速添加：相对日 / 周几 / 月日 / 纯时刻，以及标题清洗', () => {
  const now = new Date(2026, 9, 17, 10, 0, 0) // 2026-10-17 周六 10:00
  const tm = parseQuickAdd('明天 15:00 交作业', now)
  assert.equal(tm.title, '交作业')
  assert.equal(new Date(tm.deadlineAt).getTime(), new Date(2026, 9, 18, 15, 0).getTime())
  assert.equal(tm.hasDate && tm.hasTime, true)

  const noTime = parseQuickAdd('后天 报名', now)
  assert.equal(noTime.title, '报名')
  assert.equal(new Date(noTime.deadlineAt).getTime(), new Date(2026, 9, 19, 23, 59).getTime())

  const nextWeek = parseQuickAdd('下周二 组会', now)
  assert.equal(nextWeek.title, '组会')
  assert.equal(new Date(nextWeek.deadlineAt).getTime(), new Date(2026, 9, 20, 23, 59).getTime())

  const monthDay = parseQuickAdd('10月20日 报名截止', now)
  assert.equal(monthDay.title, '报名截止')
  assert.equal(new Date(monthDay.deadlineAt).getTime(), new Date(2026, 9, 20, 23, 59).getTime())

  const clock = parseQuickAdd('20:30 跑步', now)
  assert.equal(clock.title, '跑步')
  assert.equal(clock.hasDate, false)
  assert.equal(new Date(clock.deadlineAt).getTime(), new Date(2026, 9, 17, 20, 30).getTime())

  const afternoon = parseQuickAdd('下午3点 开会', now)
  assert.equal(afternoon.title, '开会')
  assert.equal(new Date(afternoon.deadlineAt).getTime(), new Date(2026, 9, 17, 15, 0).getTime())

  const plain = parseQuickAdd('整理笔记', now)
  assert.deepEqual(plain, { title: '整理笔记', deadlineAt: null, hasDate: false, hasTime: false })

  // 标题里的「1-2」不是日期：必须行首或空格开头才算
  assert.equal(parseQuickAdd('项目1-2 排期', now).deadlineAt, null)
})

test('标签与时间区间格式：今天/明天/周几/过期/跨年', () => {
  const now = new Date(2026, 9, 17, 10, 0, 0)
  assert.equal(dueLabel(new Date(2026, 9, 17, 15, 30).toISOString(), now).text, '今天 15:30')
  assert.equal(dueLabel(new Date(2026, 9, 17, 23, 59).toISOString(), now).text, '今天')
  assert.equal(dueLabel(new Date(2026, 9, 18, 23, 59).toISOString(), now).text, '明天')
  assert.equal(dueLabel(new Date(2026, 9, 19, 8, 0).toISOString(), now).text, '后天 08:00')
  assert.equal(dueLabel(new Date(2026, 9, 21, 23, 59).toISOString(), now).text, '周三')
  assert.deepEqual(dueLabel(new Date(2026, 9, 15, 23, 59).toISOString(), now), { text: '已过期 2 天', tone: 'overdue' })
  assert.equal(dueLabel(new Date(2026, 11, 5, 9, 0).toISOString(), now).text, '12月5日 09:00')
  assert.equal(dueLabel(new Date(2027, 0, 5, 9, 0).toISOString(), now).text, '2027年1月5日 09:00')
  assert.deepEqual(dueLabel(null, now), { text: '无日期', tone: 'none' })
  // 第三参 withTime=false：全天条目、右侧已带时刻条的条目只给日期粒度
  assert.equal(dueLabel(new Date(2026, 9, 17, 8, 15).toISOString(), now, false).text, '今天')
  assert.equal(dueLabel(new Date(2026, 9, 18, 23, 59).toISOString(), now, false).text, '明天')

  const start = new Date(2026, 9, 17, 8, 15)
  const end = new Date(2026, 9, 17, 9, 55)
  assert.equal(clockRange(start.toISOString(), end.toISOString()), '08:15 - 09:55')
  assert.equal(clockRange(start.toISOString(), null), '08:15')
  assert.equal(clockRange(start.toISOString(), end.toISOString(), true), '全天')
})
