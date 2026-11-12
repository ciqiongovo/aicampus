'use strict'
// 规则引擎安全/正确性单测（纯 node:test，无网络）。覆盖：条件 AND、强制冲突显式报错、
// require_deadline 不编造日期、scope/enforcement/enabled 语义、操作符。
const test = require('node:test')
const assert = require('node:assert/strict')
const { ruleMatches, ruleDecisions, RuleConflict } = require('../.test-out/main/services/jarvis/ruleEngine.js')

const rule = (over = {}) => ({
  id: 1, scope: 'global', name: 'r', description: '', conditions: [],
  action: { type: 'notify', params: {} }, enforcement: 'mandatory', enabled: true,
  revision: 1, modifiedBy: '', createdAt: '', updatedAt: '',
  ...over
})

test('规则条件 AND 组合：所有条件同时满足才命中', () => {
  const r = rule({ conditions: [
    { field: 'category', op: 'eq', value: '需行动' },
    { field: 'from', op: 'contains', value: 'bank' }
  ] })
  assert.equal(ruleMatches(r, { category: '需行动', from: 'no-reply@bank.com' }), true)
  assert.equal(ruleMatches(r, { category: '需行动', from: 'friend@x.com' }), false)
  assert.equal(ruleMatches(r, { category: '一般信息', from: 'no-reply@bank.com' }), false)
})

test('不支持的字段抛 RuleConflict，而不是静默忽略', () => {
  const r = rule({ conditions: [{ field: 'hacked', op: 'eq', value: 'x' }] })
  assert.throws(() => ruleMatches(r, {}), RuleConflict)
})

test('条件操作符 eq/neq/contains/missing/present', () => {
  const ctx = { category: '需行动', from: 'no-reply@bank.com', body: '请缴费', deadline: undefined }
  const mk = (cond) => rule({ conditions: [cond] })
  assert.equal(ruleMatches(mk({ field: 'category', op: 'eq', value: '需行动' }), ctx), true)
  assert.equal(ruleMatches(mk({ field: 'category', op: 'eq', value: '一般信息' }), ctx), false)
  assert.equal(ruleMatches(mk({ field: 'category', op: 'neq', value: '一般信息' }), ctx), true)
  assert.equal(ruleMatches(mk({ field: 'from', op: 'contains', value: 'bank' }), ctx), true)
  assert.equal(ruleMatches(mk({ field: 'from', op: 'contains', value: 'gmail' }), ctx), false)
  assert.equal(ruleMatches(mk({ field: 'deadline', op: 'missing' }), ctx), true)
  assert.equal(ruleMatches(mk({ field: 'deadline', op: 'present' }), ctx), false)
})

test('has_deadline 布尔字段 eq/present', () => {
  assert.equal(ruleMatches(rule({ conditions: [{ field: 'has_deadline', op: 'eq', value: 'true' }] }), { has_deadline: true }), true)
  assert.equal(ruleMatches(rule({ conditions: [{ field: 'has_deadline', op: 'eq', value: 'false' }] }), { has_deadline: false }), true)
  assert.equal(ruleMatches(rule({ conditions: [{ field: 'has_deadline', op: 'present' }] }), { has_deadline: true }), true)
  assert.equal(ruleMatches(rule({ conditions: [{ field: 'has_deadline', op: 'present' }] }), { has_deadline: false }), false)
  assert.equal(ruleMatches(rule({ conditions: [{ field: 'has_deadline', op: 'missing' }] }), { has_deadline: false }), true)
})

test('单一强制分流规则给出唯一 destination', () => {
  const d = ruleDecisions([rule({ id: 7, action: { type: 'route_info', params: { destination: 'keep' } } })], 'info', {})
  assert.equal(d.destination, 'keep')
  assert.deepEqual(d.matched, [7])
})

test('两个强制分流到不同去向：显式抛 RuleConflict，绝不按顺序静默裁决', () => {
  const r1 = rule({ id: 1, name: 'A', action: { type: 'route_info', params: { destination: 'keep' } } })
  const r2 = rule({ id: 2, name: 'B', action: { type: 'route_info', params: { destination: 'archive' } } })
  assert.throws(
    () => ruleDecisions([r1, r2], 'info', {}),
    (e) => e instanceof RuleConflict && e.name === 'RuleConflict' && /冲突/.test(e.message)
  )
})

test('两个强制分类冲突：显式抛 RuleConflict', () => {
  const r1 = rule({ id: 1, name: 'A', action: { type: 'set_category', params: { category: '需行动' } } })
  const r2 = rule({ id: 2, name: 'B', action: { type: 'set_category', params: { category: '一般信息' } } })
  assert.throws(() => ruleDecisions([r1, r2], 'info', {}), RuleConflict)
})

test('preference 规则不参与强制裁决，不引发冲突', () => {
  const mand = rule({ id: 1, name: 'M', action: { type: 'route_info', params: { destination: 'keep' } } })
  const pref = rule({ id: 2, name: 'P', enforcement: 'preference', action: { type: 'route_info', params: { destination: 'archive' } } })
  const d = ruleDecisions([mand, pref], 'info', {})
  assert.equal(d.destination, 'keep')
})

test('require_deadline 只置标志，不编造 deadline', () => {
  const d = ruleDecisions([rule({ action: { type: 'require_deadline', params: {} } })], 'item', {})
  assert.equal(d.requireDeadline, true)
  assert.equal(d.destination, undefined)
  assert.equal(d.category, undefined)
})

test('scope 过滤：global 恒生效，特定 scope 仅命中自身', () => {
  assert.equal(ruleDecisions([rule({ id: 1, scope: 'global' })], 'info', {}).matched.length, 1)
  assert.equal(ruleDecisions([rule({ id: 2, scope: 'mail' })], 'info', {}).matched.length, 0)
  assert.equal(ruleDecisions([rule({ id: 2, scope: 'mail' })], 'mail', {}).matched.length, 1)
})

test('disabled 规则被忽略', () => {
  const d = ruleDecisions([rule({ id: 1, enabled: false, action: { type: 'route_info', params: { destination: 'keep' } } })], 'info', {})
  assert.equal(d.destination, undefined)
})

test('强制规则 destination/category 非法时抛 RuleConflict', () => {
  assert.throws(() => ruleDecisions([rule({ action: { type: 'route_info', params: { destination: 'bogus' } } })], 'info', {}), RuleConflict)
  assert.throws(() => ruleDecisions([rule({ action: { type: 'set_category', params: { category: '不存在的分类' } } })], 'info', {}), RuleConflict)
})

test('notify 收集通知文案', () => {
  const d = ruleDecisions([rule({ id: 3, name: '提醒我', description: '注意截止', action: { type: 'notify', params: {} } })], 'info', {})
  assert.deepEqual(d.notifications, ['注意截止'])
})
