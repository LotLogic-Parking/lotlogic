// Tests for frontend/src/lib/presence.js - the pure half of the Live tab
// (manager-dashboard-build-plan F3 over the B3 payload).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_COPY,
  ENDING_SOON_MINUTES,
  LIST_SEGMENTS,
  canRequestTow,
  filterByPlate,
  hereLine,
  passChip,
  presenceTiles,
  rowKey,
  rowSentence,
  spanPhrase,
  stayedLine,
  towRow,
  whoLine,
} from '../src/lib/presence.js';

// A B3 payload written out by hand: one office row with name and unit, one
// partner-shaped row without them, one uncovered car.
const ROWS = [
  { session_id: 's1', plate: 'ABC1234', vehicle: 'white Honda Civic', entered_at: '2026-11-07T14:00:00Z', minutes_here: 72, state: 'open', entry_photo_url: 'https://cdn.example/1.jpg',
    pass: { kind: 'short_term', id: 'v1', status: 'active', until: '2026-11-07T17:10:00Z', minutes_left: 130, name: 'Pat Example', unit: '214' } },
  { session_id: 's2', plate: 'XYZ789', vehicle: '', entered_at: '2026-11-07T15:00:00Z', minutes_here: 12, state: 'open', entry_photo_url: null,
    pass: { kind: 'long_term', id: 'r1', status: 'approved', until: null, minutes_left: null } },
  { session_id: 's3', plate: 'NOPASS1', vehicle: 'grey Ford F-150', entered_at: '2026-11-07T15:10:00Z', minutes_here: 2, state: 'open', entry_photo_url: null, pass: null },
];

test('presenceTiles: the four counts in order, a missing count reads 0', () => {
  const t = presenceTiles({ on_property: 3, covered: 2, uncovered: 1, expiring_soon: 1 });
  assert.deepEqual(t.map(x => x.key), ['on_property', 'covered', 'uncovered', 'expiring_soon']);
  assert.deepEqual(t.map(x => x.label), ['On the property', 'Covered by a pass', 'No pass', 'Pass ends in 4 h']);
  assert.deepEqual(t.map(x => x.value), [3, 2, 1, 1]);
  assert.deepEqual(presenceTiles(null).map(x => x.value), [0, 0, 0, 0]);
  assert.deepEqual(presenceTiles({ on_property: 'x' }).map(x => x.value), [0, 0, 0, 0]);
});

test('spanPhrase / hereLine / stayedLine read as a sentence', () => {
  assert.equal(spanPhrase(72), '1 h 12 m');
  assert.equal(spanPhrase(12), '12 m');
  assert.equal(spanPhrase(0.4), 'under a minute');
  assert.equal(spanPhrase(60 * 26 + 5), '1 d 2 h');
  assert.equal(spanPhrase(null), '');
  assert.equal(hereLine(72), 'here 1 h 12 m');
  assert.equal(hereLine(undefined), '');
  assert.equal(stayedLine(125), 'stayed 2 h 5 m');
});

test('passChip: long-term is blue, short-term shows the time left, no pass is red', () => {
  assert.deepEqual(passChip(ROWS[1].pass), { tone: 'info', text: 'Long-term' });
  assert.deepEqual(passChip(ROWS[0].pass), { tone: 'green', text: 'Short-term · 2h 10m left' });
  assert.deepEqual(passChip({ kind: 'short_term', minutes_left: ENDING_SOON_MINUTES - 1 }), { tone: 'red', text: 'Short-term · 59m left' });
  assert.deepEqual(passChip({ kind: 'short_term', minutes_left: 0 }), { tone: 'red', text: 'Short-term · ended' });
  assert.deepEqual(passChip({ kind: 'short_term', minutes_left: null }), { tone: 'green', text: 'Short-term' });
  assert.deepEqual(passChip({ kind: 'short_term', status: 'pending', minutes_left: 30 }), { tone: 'info', text: 'Under review' });
  assert.deepEqual(passChip(null), { tone: 'red', text: 'No pass' });
  assert.deepEqual(passChip(undefined), { tone: 'red', text: 'No pass' });
});

test('whoLine: unit and name for the office, nothing for a partner payload', () => {
  assert.equal(whoLine(ROWS[0].pass), 'Unit 214 · Pat Example');
  assert.equal(whoLine({ unit: '214' }), 'Unit 214');
  assert.equal(whoLine({ name: 'Pat Example' }), 'Pat Example');
  assert.equal(whoLine(ROWS[1].pass), '');
  assert.equal(whoLine(null), '');
});

test('rowSentence: "here 1 h 12 m · Short-term · 2h 10m left"', () => {
  assert.equal(rowSentence(ROWS[0]), 'here 1 h 12 m · Short-term · 2h 10m left');
  assert.equal(rowSentence(ROWS[2]), 'here 2 m · No pass');
  assert.equal(rowSentence({ ...ROWS[0], minutes_stayed: 90, exited_at: '2026-11-07T15:30:00Z' }, 'recent_exits'), 'stayed 1 h 30 m · Short-term · 2h 10m left');
});

test('filterByPlate: normalised substring, empty keeps everything', () => {
  assert.deepEqual(filterByPlate(ROWS, 'abc').map(r => r.plate), ['ABC1234']);
  assert.deepEqual(filterByPlate(ROWS, ' no-pass ').map(r => r.plate), ['NOPASS1']);
  assert.equal(filterByPlate(ROWS, '').length, 3);
  assert.deepEqual(filterByPlate(null, 'a'), []);
});

test('towRow hands the page the plate in the shape requestTow() reads', () => {
  assert.deepEqual(towRow(ROWS[2]), { plate_text: 'NOPASS1', vehicle: 'grey Ford F-150' });
  assert.deepEqual(towRow({ plate: ' AB 12 ' }), { plate_text: 'AB 12', vehicle: null });
});

test('canRequestTow: the office only', () => {
  assert.equal(canRequestTow('admin'), true);
  assert.equal(canRequestTow('manager'), true);
  assert.equal(canRequestTow('viewer'), false);
  assert.equal(canRequestTow('partner'), false);
  assert.equal(canRequestTow(undefined), false);
});

test('rowKey is stable per list and session', () => {
  assert.equal(rowKey(ROWS[0], 'on_property'), 'on_property:s1:ABC1234');
  assert.notEqual(rowKey(ROWS[0], 'on_property'), rowKey(ROWS[0], 'recent_exits'));
});

test('segments and the empty-state copy, verbatim', () => {
  assert.deepEqual(LIST_SEGMENTS.map(s => s.id), ['on_property', 'recent_exits']);
  assert.equal(EMPTY_COPY.no_camera, 'No camera is registered at this property yet.');
  assert.match(EMPTY_COPY.on_property, /^No cars on the property right now\./);
  assert.match(EMPTY_COPY.recent_exits, /last 24 hours/);
});
