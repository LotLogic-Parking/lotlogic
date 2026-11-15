// Tests for frontend/src/lib/visits.js - one row per car per pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VISITS_EMPTY, busiestHour, groupVisitRows, passesMetrics, visitLine, visitMetrics, visitRow, visitRows, visitsSummary } from '../src/lib/visits.js';

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

test('visitMetrics: visits per day in ET, today, average and median stay over closed visits only', () => {
  const m = visitMetrics([
    HERE,
    LEFT,
    { ...LEFT, id: 's3', entered_at: '2026-11-10T22:00:00Z', exited_at: '2026-11-10T22:30:00Z' }, // Nov 10 5 PM ET, 30 m
    { ...LEFT, id: 's4', entered_at: '2026-11-11T03:00:00Z', exited_at: '2026-11-11T05:00:00Z' }, // Nov 10 10 PM ET, 120 m
  ], NOW);
  assert.equal(m.total, 4);
  assert.equal(m.today, 2);
  assert.equal(m.stillHere, 1);
  assert.equal(m.closed, 3);
  assert.equal(Math.round(m.avgStayMinutes), Math.round((83 + 30 + 120) / 3));
  assert.equal(m.medianStayMinutes, 83);
  assert.deepEqual(m.perDay, [{ day: '2026-11-10', count: 2 }, { day: '2026-11-11', count: 2 }]);
  assert.deepEqual(visitMetrics(null, NOW), { total: 0, today: 0, stillHere: 0, closed: 0, avgStayMinutes: null, medianStayMinutes: null, perDay: [] });
});

test('busiestHour: the ET hour most visits began in; the earlier hour on a tie; null with none', () => {
  const at = (iso) => ({ id: iso, entered_at: iso });
  // 20:12Z and 20:40Z are 3 PM ET; 13:05Z is 8 AM ET.
  assert.equal(busiestHour([at('2026-11-11T20:12:00Z'), at('2026-11-11T20:40:00Z'), at('2026-11-11T13:05:00Z')]), 15);
  assert.equal(busiestHour([at('2026-11-11T20:12:00Z'), at('2026-11-11T13:05:00Z')]), 8);
  assert.equal(busiestHour([]), null);
  assert.equal(busiestHour(null), null);
  assert.equal(busiestHour([{ entered_at: 'junk' }]), null);
});

test('passesMetrics: visits today, busiest hour, average stay; dashes before any visit', () => {
  const left = { id: 'l', entered_at: '2026-11-10T20:00:00Z', exited_at: '2026-11-10T21:00:00Z', exit: { image_url: null } };
  assert.deepEqual(passesMetrics([HERE, left], NOW), [
    { key: 'today', label: 'Visits today', value: '1' },
    { key: 'busiest', label: 'Busiest hour', value: '3 PM' },
    { key: 'stay', label: 'Average stay', value: '1 h 00 m' },
  ]);
  assert.deepEqual(passesMetrics([], NOW).map(t => t.value), ['0', '—', '—']);
});

// A visit the exit camera never saw leave: closed at its last sighting by the
// re-entry rule or the stale sweep, so exited_at is not an exit time.
const UNSEEN = {
  id: 's5', plate_text: 'SVL414', normalized_plate: 'SVL414', entered_at: '2026-11-11T04:02:00Z', exited_at: '2026-11-11T04:04:00Z',
  state: 'closed_clean', visitor_pass_id: null, resident_plate_id: null,
  entry: { image_url: 'https://r2/x/svl.jpg' }, exit: null,
};

test('visitRow: a visit closed without an exit read says so; no fake Out time, no stay', () => {
  const r = visitRow(UNSEEN, NOW);
  assert.equal(r.status, 'left');
  assert.equal(r.out.label, 'Exit not seen');
  assert.equal(r.out.sub, 'last seen Tue Nov 10, 11:04 PM');
  assert.equal(r.out.unseen, true);
  assert.equal(r.out.photo, null);
  assert.equal(r.stay, '');
  // a real exit is unchanged
  assert.equal(visitRow(LEFT, NOW).out.unseen, false);
});

test('visitMetrics: the average stay counts only visits closed on an exit read', () => {
  const m = visitMetrics([LEFT, UNSEEN], NOW);
  assert.equal(m.closed, 1);
  assert.equal(Math.round(m.avgStayMinutes), 83);
});

test('groupVisitRows: one row per car per ET day, newest activity first, every visit kept', () => {
  const at = (id, plate, inAt, outAt, exit) => ({ id, plate_text: plate, entered_at: inAt, exited_at: outAt, exit, entry: null });
  const rows = visitRows([
    at('a', 'JHV6706', '2026-11-15T03:23:00Z', '2026-11-15T03:23:30Z', null),     // Sat 10:23 PM ET, exit not seen
    at('b', 'JHV6706', '2026-11-15T03:56:00Z', '2026-11-15T03:56:20Z', null),     // Sat 10:56 PM ET, exit not seen
    at('c', 'JHV6706', '2026-11-15T04:51:00Z', null, null),                        // Sat 11:51 PM ET, still here
    at('d', 'JHV6706', '2026-11-14T01:14:00Z', '2026-11-14T01:17:00Z', { image_url: null }), // Fri 8:14 PM ET, real exit
    at('e', 'LKL3974', '2026-11-15T02:11:00Z', null, null),                        // Sat 9:11 PM ET
  ], NOW);
  const g = groupVisitRows(rows);
  assert.deepEqual(g.map(r => [r.plate, r.count]), [['JHV6706', 3], ['LKL3974', 1], ['JHV6706', 1]]);
  const sat = g[0];
  assert.equal(sat.status, 'here');
  assert.equal(sat.in.label, 'In Sat Nov 14, 10:23 PM');
  assert.equal(sat.out, null);
  assert.deepEqual(sat.visits.map(v => v.id), ['c', 'b', 'a']);
  assert.equal(visitLine(sat.visits[1]), 'In Sat Nov 14, 10:56 PM · exit not seen');
  assert.equal(visitLine(sat.visits[0]).startsWith('In Sat Nov 14, 11:51 PM · still here'), true);
  assert.equal(visitsSummary(g), '5 visits · 2 still here');
  // a day of visits that all left keeps the latest exit and shows no single stay
  const left = groupVisitRows(visitRows([at('x', 'PEM2588', '2026-11-14T15:18:00Z', '2026-11-14T15:18:10Z', null), at('y', 'PEM2588', '2026-11-14T05:17:00Z', '2026-11-14T05:17:10Z', null)], NOW));
  assert.equal(left.length, 1);
  assert.equal(left[0].status, 'left');
  assert.equal(left[0].stay, '');
  assert.equal(left[0].out.label, 'Exit not seen');
  assert.deepEqual(groupVisitRows(null), []);
});
