// Tests for frontend/src/lib/violations.js - the pure half of the Violations
// tab (manager-dashboard-build-plan F4 over the B4 payload).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_OPTIONS,
  DEFAULT_DAYS,
  KIND_SEGMENTS,
  canRequestTow,
  clampDays,
  emptyLine,
  filterViolations,
  kindCounts,
  originTag,
  photoSource,
  rowKey,
  statusTag,
  towRow,
  whenLine,
  whoLine,
} from '../src/lib/violations.js';

const NOW = '2026-11-07T16:00:00Z';

// A B4 payload written out by hand: the three origins, newest first; the
// expired pass is partner-shaped (no name / unit).
const ITEMS = [
  { kind: 'tow_request', id: 'T-1', plate: 'ABC1234', vehicle: 'white Honda Civic', at: '2026-11-07T15:00:00Z', status: 'active', detail: 'Blocking the dumpster', photo_url: '/tow-requests/T-1/photo', name: 'Pat Example', unit: '214' },
  { kind: 'expired_pass', id: 'v9', plate: 'XYZ789', vehicle: '', at: '2026-11-07T12:00:00Z', status: 'expired', detail: 'pass ended 4h ago, not seen leaving', photo_url: null },
  { kind: 'camera', id: 'c3', plate: 'NOPASS1', vehicle: 'grey Ford F-150', at: '2026-11-06T22:00:00Z', status: 'open', detail: 'no_registration', photo_url: 'https://cdn.example/c3.jpg', name: null, unit: null },
];

test('originTag names the three origins as words', () => {
  assert.deepEqual(originTag('tow_request'), { label: 'Tow request', tone: 'info' });
  assert.deepEqual(originTag('expired_pass'), { label: 'Pass ended', tone: 'red' });
  assert.deepEqual(originTag('camera'), { label: 'Camera', tone: 'neutral' });
  assert.deepEqual(originTag('something_else'), { label: 'Violation', tone: 'neutral' });
});

test('statusTag reads each origin\'s statuses; unknown ones read as spelled', () => {
  assert.deepEqual(statusTag(ITEMS[0]), { tone: 'info', text: 'Open' });
  assert.deepEqual(statusTag({ kind: 'tow_request', status: 'fulfilled' }), { tone: 'green', text: 'Done' });
  assert.deepEqual(statusTag({ kind: 'tow_request', status: 'declined' }), { tone: 'neutral', text: 'Declined' });
  assert.deepEqual(statusTag({ kind: 'tow_request', status: 'removed' }), { tone: 'neutral', text: 'Withdrawn' });
  assert.deepEqual(statusTag({ kind: 'tow_request', status: 'on_hold_x' }), { tone: 'neutral', text: 'On hold x' });
  assert.deepEqual(statusTag(ITEMS[1]), { tone: 'red', text: 'Still on the property' });
  assert.deepEqual(statusTag(ITEMS[2]), { tone: 'info', text: 'Open' });
  assert.deepEqual(statusTag({ kind: 'camera', status: 'resolved' }), { tone: 'green', text: 'Resolved' });
  assert.deepEqual(statusTag({ kind: 'camera', status: '' }), { tone: 'neutral', text: 'Unknown' });
});

test('canRequestTow: only a pass that ended (a tow request already is one)', () => {
  assert.equal(canRequestTow(ITEMS[1]), true);
  assert.equal(canRequestTow(ITEMS[0]), false);
  assert.equal(canRequestTow(ITEMS[2]), false);
  assert.equal(canRequestTow(null), false);
});

test('whenLine: how long ago, then the ET stamp', () => {
  assert.equal(whenLine('2026-11-07T15:00:00Z', NOW), '1h ago · Sat Nov 7, 10:00 AM ET');
  assert.equal(whenLine('2026-11-07T15:59:50Z', NOW), 'just now · Sat Nov 7, 10:59 AM ET');
  assert.equal(whenLine(null, NOW), '');
  assert.equal(whenLine('nope', NOW), '');
});

test('whoLine: unit and name for the office, nothing for a partner payload', () => {
  assert.equal(whoLine(ITEMS[0]), 'Unit 214 · Pat Example');
  assert.equal(whoLine(ITEMS[1]), '');
  assert.equal(whoLine(ITEMS[2]), '');
});

test('kindCounts and filterViolations agree, and the search is on the plate', () => {
  assert.deepEqual(kindCounts(ITEMS), { all: 3, tow_request: 1, expired_pass: 1, camera: 1 });
  assert.deepEqual(kindCounts(null), { all: 0, tow_request: 0, expired_pass: 0, camera: 0 });
  assert.deepEqual(filterViolations(ITEMS).map(i => i.id), ['T-1', 'v9', 'c3']);
  assert.deepEqual(filterViolations(ITEMS, { kind: 'camera' }).map(i => i.id), ['c3']);
  assert.deepEqual(filterViolations(ITEMS, { q: 'xyz' }).map(i => i.id), ['v9']);
  assert.deepEqual(filterViolations(ITEMS, { kind: 'tow_request', q: 'xyz' }), []);
  assert.deepEqual(filterViolations([null, ...ITEMS], { kind: 'all' }).length, 3);
});

test('emptyLine says what will appear and over which window', () => {
  assert.equal(emptyLine('all', 30), 'No violations in the last 30 days. Tow requests, passes that ended with the car still here, and camera violations appear here as they happen.');
  assert.match(emptyLine('tow_request', 7), /^No tow requests in the last 7 days\./);
  assert.match(emptyLine('expired_pass', 90), /in the last 90 days\.$/);
  assert.match(emptyLine('camera', 1), /in the last 1 day\./);
});

test('clampDays snaps to the picker', () => {
  assert.deepEqual(DAY_OPTIONS, [7, 30, 90]);
  assert.equal(DEFAULT_DAYS, 30);
  assert.equal(clampDays(7), 7);
  assert.equal(clampDays(10), 7);
  assert.equal(clampDays(45), 30);
  assert.equal(clampDays(400), 90);
  assert.equal(clampDays('x'), 30);
});

test('photoSource: the backend\'s own photo needs the session, a storage URL does not', () => {
  assert.equal(photoSource('/tow-requests/T-1/photo', 'https://api.example'), 'api');
  assert.equal(photoSource('https://api.example/tow-requests/T-1/photo', 'https://api.example'), 'api');
  assert.equal(photoSource('https://cdn.example/c3.jpg', 'https://api.example'), 'direct');
  assert.equal(photoSource(null), 'none');
  assert.equal(photoSource('  '), 'none');
});

test('towRow and rowKey', () => {
  assert.deepEqual(towRow(ITEMS[1]), { plate_text: 'XYZ789', vehicle: '' });
  assert.equal(rowKey(ITEMS[0]), 'tow_request:T-1:ABC1234');
});

test('the segmented control, in order', () => {
  assert.deepEqual(KIND_SEGMENTS.map(s => s.id), ['all', 'tow_request', 'expired_pass', 'camera']);
  assert.deepEqual(KIND_SEGMENTS.map(s => s.label), ['All', 'Tow requests', 'Passes ended', 'Camera']);
});
