/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';
// Run: node --test bkm-web/test/*.test.js   (make test-web)
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../js/q-model.js');

const load = (items) => m.qLoadItems(items, 0, { max: 0 });
const roundTrip = (items) => m.qBuildItems(load(items));

test('round trip preserves enableWhen, extensions and initial values', () => {
  const src = [
    { linkId: 'q1', text: 'Fever?', type: 'boolean' },
    { linkId: 'q2', text: 'Days', type: 'integer', required: true,
      enableWhen: [{ question: 'q1', operator: '=', answerBoolean: true }], enableBehavior: 'all',
      extension: [{ url: 'http://x/y', valueString: 'z' }], initial: [{ valueInteger: 1 }] },
  ];
  assert.deepEqual(roundTrip(src), src);
});

test('coded answer options keep code and system', () => {
  const src = [{ linkId: 'q1', text: 'Sex', type: 'choice',
    answerOption: [{ valueCoding: { system: 's', code: 'M', display: 'Male' } }] }];
  assert.deepEqual(roundTrip(src), src);
  const items = load(src);
  items[0].answerOption[0] = m.qSetOptionLabel(items[0].answerOption[0], 'Man');
  assert.deepEqual(m.qBuildItems(items)[0].answerOption[0].valueCoding, { system: 's', code: 'M', display: 'Man' });
});

test('groups keep nested items and grandchildren are not dropped', () => {
  const src = [{ linkId: 'g1', text: 'Sec', type: 'group', item: [
    { linkId: 'g1-2', text: 'Sub', type: 'group', item: [{ linkId: 'g1-3', text: 'Deep', type: 'string' }] },
  ] }];
  assert.deepEqual(roundTrip(src), src);
});

test('blank items dropped, display items kept, whitespace trimmed', () => {
  const out = m.qBuildItems([
    { ...m.qNewItem(1), text: '  ' },
    { ...m.qNewItem(2), type: 'display', text: '' },
    { ...m.qNewItem(3), text: ' Name ' },
  ]);
  assert.deepEqual(out.map((i) => i.linkId), ['q2', 'q3']);
  assert.equal(out[1].text, 'Name');
});

test('changing type away from choice/required drops stale fields', () => {
  const [it] = load([{ linkId: 'q1', text: 'A', type: 'choice', required: true, answerOption: [{ valueString: 'x' }] }]);
  it.type = 'display';
  const out = m.qBuildItems([it])[0];
  assert.equal(out.answerOption, undefined);
  assert.equal(out.required, undefined);
});

test('new linkIds never collide with loaded ones', () => {
  const seen = { max: 0 };
  m.qLoadItems([{ linkId: 'q7', text: 'a', type: 'string' }, { linkId: 'g3', text: 'b', type: 'group', item: [{ linkId: 'g3-12', text: 'c', type: 'string' }] }], 0, seen);
  assert.equal(seen.max, 12);
});

test('validate: title, empty form, choice without options, duplicate ids', () => {
  assert.ok(m.qValidate('', load([{ linkId: 'q1', text: 'a', type: 'string' }])).some((p) => p.path === 'title'));
  assert.ok(m.qValidate('T', []).some((p) => p.path === 'items'));
  const c = load([{ linkId: 'q1', text: 'a', type: 'choice', answerOption: [{ valueString: ' ' }] }]);
  assert.ok(m.qValidate('T', c).some((p) => p.level === 'error' && /no options/.test(p.msg)));
  const d = load([{ linkId: 'q1', text: 'a', type: 'string' }, { linkId: 'q1', text: 'b', type: 'string' }]);
  assert.ok(m.qValidate('T', d).some((p) => /more than once/.test(p.msg)));
  const ok = load([{ linkId: 'q1', text: 'a', type: 'choice', answerOption: [{ valueString: 'x' }, { valueString: 'X' }] }]);
  const res = m.qValidate('T', ok);
  assert.equal(res.filter((p) => p.level === 'error').length, 0);
  assert.ok(res.some((p) => p.level === 'warn' && /twice/.test(p.msg)));
});

test('move stays in bounds', () => {
  const a = [1, 2, 3];
  assert.equal(m.qMove(a, 0, -1), false);
  assert.equal(m.qMove(a, 2, 1), false);
  assert.equal(m.qMove(a, 0, 1), true);
  assert.deepEqual(a, [2, 1, 3]);
});

test('duplicate gets fresh ids and does not inherit a skip rule', () => {
  let n = 10;
  const [g] = load([{ linkId: 'g1', text: 'Sec', type: 'group', enableWhen: [{ question: 'q0', operator: '=', answerBoolean: true }],
    item: [{ linkId: 'g1-2', text: 'Sub', type: 'string' }] }]);
  const copy = m.qDuplicate(g, () => ++n);
  assert.equal(copy.linkId, 'q11');
  assert.equal(copy.children[0].linkId, 'q11-12');
  assert.equal(copy.raw.enableWhen, undefined);
  assert.ok(g.raw.enableWhen, 'original untouched');
});

test('dependents finds items whose skip rule targets a linkId', () => {
  const items = load([{ linkId: 'q1', text: 'a', type: 'boolean' },
    { linkId: 'q2', text: 'b', type: 'string', enableWhen: [{ question: 'q1', operator: '=', answerBoolean: true }] }]);
  assert.deepEqual(m.qDependents(items, 'q1'), ['q2']);
  assert.deepEqual(m.qDependents(items, 'q2'), []);
});

test('choice backed by a value set is valid without inline options and survives save', () => {
  const src = [{ linkId: 'q1', text: 'Drug', type: 'choice', answerValueSet: 'http://x/ValueSet/drugs' }];
  const items = load(src);
  assert.equal(m.qValidate('T', items).filter((p) => p.level === 'error').length, 0);
  assert.deepEqual(m.qBuildItems(items), src);
  items[0].type = 'string';
  assert.equal(m.qBuildItems(items)[0].answerValueSet, undefined);
});
