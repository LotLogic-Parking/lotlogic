import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitHistory, durationText, isHumanRef, cameraOf, etDay, etTime } from '../src/lib/visitHistory.js';

const UUID_A = '8fc27664-66fa-46df-b7ea-6ac7176d7725';
const UUID_B = '2b77e3ef-e280-4f31-b831-c5577b933b8f';
const UUID_C = '0c1d2e3f-0000-4000-8000-000000000003';
// Mon Nov 16 2026: 9:56 AM ET = 14:56Z, 11:17 AM ET = 16:17Z
const NOW = Date.parse('2026-11-16T23:18:00Z');

const events = [
  { at: '2026-11-16T16:17:00Z', kind: 'entered', detail: 'seen entering · Mayfield gate — entry (C)', ref: UUID_A, photo_url: 'a.jpg' },
  { at: '2026-11-16T15:30:00Z', kind: 'hold_opened', detail: 'hold H-0012 opened by Office', ref: 'H-0012' },
  { at: '2026-11-16T14:56:00Z', kind: 'exited', detail: 'seen leaving · camera', ref: UUID_B },
  { at: '2026-11-16T13:35:00Z', kind: 'entered', detail: 'seen entering · Mayfield gate — entry (C)', ref: UUID_B, photo_url: 'b.jpg' },
  { at: '2026-11-15T20:00:00Z', kind: 'entered', detail: 'seen entering · Mayfield gate — entry (C)', ref: UUID_C },
  { at: '2026-11-15T12:00:00Z', kind: 'check', detail: 'ELIGIBLE TO TOW — no parking pass', ref: 'T-1843' },
  { at: '2026-11-14T12:00:00Z', kind: 'pass_filed', detail: 'short-term parking pass requested', ref: null },
];

test('one line per visit: entered + exited joined by the session id', () => {
  const out = visitHistory(events, NOW);
  const visits = out.filter(e => e.kind === 'visit');
  assert.equal(visits.length, 3);
  const closed = visits.find(v => v.title.includes('8:35 AM'));
  assert.equal(closed.title, 'Mon Nov 16 · 8:35 AM – 9:56 AM');
  assert.equal(closed.sub, '1 h 21 m · Mayfield gate — entry (C)');
  assert.equal(closed.photo_url, 'b.jpg');
});

test('the newest visit with no exit is still here; an older one says the exit was not seen', () => {
  const out = visitHistory(events, NOW);
  assert.equal(out[0].label, 'Here now');
  assert.equal(out[0].title, 'Mon Nov 16 · 11:17 AM – now');
  assert.equal(out[0].sub, 'here 7 h 1 m · Mayfield gate — entry (C)');
  const unseen = out.find(e => e.title.startsWith('Sun Nov 15'));
  assert.equal(unseen.title, 'Sun Nov 15 · 3:00 PM – exit not seen');
});

test('no session id ever reaches a line', () => {
  const text = JSON.stringify(visitHistory(events, NOW));
  for (const id of [UUID_A, UUID_B, UUID_C]) assert.ok(!text.includes(id));
});

test('other events read once; a human number shows only when the line lacks it', () => {
  const out = visitHistory(events, NOW);
  const hold = out.find(e => e.label === 'Hold placed');
  assert.equal(hold.title, 'Hold H-0012 opened by Office');
  assert.equal(hold.ref, null);
  const check = out.find(e => e.label === 'Plate check');
  assert.equal(check.ref, 'T-1843');
  assert.equal(out[out.length - 1].title, 'Short-term parking pass requested');
});

test('an exit whose entry was cut off stands alone; newest first overall', () => {
  const out = visitHistory([{ at: '2026-11-16T14:56:00Z', kind: 'exited', detail: 'seen leaving · Gate', ref: UUID_B }], NOW);
  assert.deepEqual(out.map(e => [e.title, e.sub]), [['Mon Nov 16 · left 9:56 AM', 'Gate']]);
  const ts = visitHistory(events, NOW).map(e => Date.parse(e.at));
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
});

test('helpers', () => {
  assert.equal(durationText(0.5), 'under 1 m');
  assert.equal(durationText(45), '45 m');
  assert.equal(durationText(120), '2 h');
  assert.equal(durationText(1500), '1 d 1 h');
  assert.equal(durationText(null), '');
  assert.equal(isHumanRef('H-0012'), true);
  assert.equal(isHumanRef(UUID_A), false);
  assert.equal(cameraOf('seen leaving · camera'), '');
  assert.equal(etDay('2026-11-16T16:17:00Z'), 'Mon Nov 16');
  assert.equal(etTime('2026-11-16T16:17:00Z'), '11:17 AM');
  assert.deepEqual(visitHistory(null), []);
});
