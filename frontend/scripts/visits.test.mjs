// Tests for frontend/src/lib/visits.js - one row per car per pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VISITS_EMPTY, visitRow, visitRows, visitsSummary } from '../src/lib/visits.js';

const NOW = new Date('2026-11-11T20:30:00Z').getTime(); // 3:30 PM ET

const HERE = {
  id: 's1', plate_text: 'HES5817', normalized_plate: 'HES5817', entered_at: '2026-11-11T20:12:00Z', exited_at: null,
  state: 'grace', visitor_pass_id: null, resident_plate_id: null,
  entry: { image_url: 'https://r2/x/entry.jpg', confidence: 1 }, exit: null,
};
const LEFT = {
  id: 's2', plate_text: 'VK5131', normalized_plate: 'VK5131', entered_at: '2026-11-11T18:00:00Z', exited_at: '2026-11-11T19:23:00Z',
  state: 'closed_clean', visitor_pass_id: 'p1', resident_plate_id: null,
  entry: [{ image_url: 'https://r2/x/in.jpg' }], exit: [{ image_url: 'https://r2/x/out.jpg' }],
};

test('visitRow: a car still here has an In line, no Out line, and a running stay', () => {
  const r = visitRow(HERE, NOW);
  assert.equal(r.plate, 'HES5817');
  assert.equal(r.status, 'here');
  assert.equal(r.in.label, 'In Wed Nov 11, 3:12 PM');
  assert.equal(r.in.photo, 'https://r2/x/entry.jpg');
  assert.equal(r.out, null);
  assert.equal(r.stay, 'here 18 m');
  assert.equal(r.covered, false);
});

test('visitRow: a car that left has both photos, both times, and the stay', () => {
  const r = visitRow(LEFT, NOW);
  assert.equal(r.status, 'left');
  assert.equal(r.in.photo, 'https://r2/x/in.jpg');
  assert.equal(r.out.label, 'Out Wed Nov 11, 2:23 PM');
  assert.equal(r.out.photo, 'https://r2/x/out.jpg');
  assert.equal(r.stay, 'stayed 1 h 23 m');
  assert.equal(r.covered, true);
});

test('visitRow: missing photos leave null, never a broken URL; missing id drops the row', () => {
  const r = visitRow({ ...HERE, entry: null }, NOW);
  assert.equal(r.in.photo, null);
  assert.deepEqual(visitRows([{ ...HERE, id: '' }], NOW), []);
  assert.deepEqual(visitRows(null, NOW), []);
});

test('visitRows: newest entry first', () => {
  const rows = visitRows([LEFT, HERE], NOW);
  assert.deepEqual(rows.map(r => r.id), ['s1', 's2']);
});

test('visitsSummary counts visits and the ones still here', () => {
  assert.equal(visitsSummary(visitRows([LEFT, HERE], NOW)), '2 visits · 1 still here');
  assert.equal(visitsSummary(visitRows([LEFT], NOW)), '1 visit');
  assert.equal(visitsSummary([]), '');
  assert.ok(VISITS_EMPTY.length > 0);
});
