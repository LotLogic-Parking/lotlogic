// Tests for frontend/src/lib/officeToday.js - the office's Today screen, pure half.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DASH, etDateKey, findPlate, goLiveLabel, plateVerdict, todayTiles } from '../src/lib/officeToday.js';
import { queueRows } from '../src/lib/permitsQueue.js';

const NOW = Date.parse('2026-11-16T19:30:00Z'); // Mon 2:30 PM in Charlotte

const resident = (n, over = {}) => ({ plate: `RES${n}`, minutes_here: 30, pass: { kind: 'long_term', status: 'approved', name: `R${n}` }, ...over });
const visitor = (n) => ({ plate: `VIS${n}`, minutes_here: 10, pass: { kind: 'short_term', status: 'active', minutes_left: 300 } });
const presence = (residents, visitors, hasCameras = true) => ({
  has_cameras: hasCameras,
  on_property: [...Array.from({ length: residents }, (_, i) => resident(i)), ...Array.from({ length: visitors }, (_, i) => visitor(i))],
});

const rows = queueRows({
  residents: [
    { id: 'r1', plate_text: 'ABC1234', unit_number: '214', holder_name: 'Jane Smith', status: 'approved', vehicle: '2019 Honda Civic, gray' },
    { id: 'r2', plate_text: 'PLK5521', unit_number: '108', holder_name: 'Marcus Webb', status: 'pending', vehicle: 'white Toyota RAV4' },
    { id: 'r3', plate_text: 'OLD0001', unit_number: '5', holder_name: 'Gone', status: 'rejected' },
  ],
  guests: [
    { id: 'g1', plate_text: 'GST7120', host_unit: '205', visitor_name: 'Rahul Nair', status: 'active', valid_until: '2026-11-18T23:30:00Z' },
    { id: 'g2', plate_text: 'GST9008', host_unit: '310', visitor_name: 'Ben Kim', status: 'active', valid_until: '2026-11-14T19:30:00Z' },
  ],
});
const counts = { pending: 3, approved: 27, denied: 0, history: 0 };
const summary = { tows_this_week: 1, boots_this_week: 2, pending_registration_count: 3, go_live_date: null };
const tile = (tiles, id) => tiles.find(t => t.id === id);

test('a property with no camera counts registered vehicles, never cars on the property', () => {
  const tiles = todayTiles({ presence: presence(0, 0, false), counts, summary, now: NOW });
  assert.deepEqual(tiles.map(t => t.id), ['onsite', 'waiting', 'enforced']);
  assert.deepEqual(tile(tiles, 'onsite'), { id: 'onsite', label: 'Registered vehicles', value: '27', sub: 'with an approved parking pass', tone: 'plain' });
});

test('the camera flag from the property decides the label while presence is still loading', () => {
  const t = tile(todayTiles({ presence: null, counts, summary, now: NOW, cameras: false }), 'onsite');
  assert.equal(t.label, 'Registered vehicles');
  assert.equal(t.value, '27');
  const cam = tile(todayTiles({ presence: null, counts, summary, now: NOW, cameras: true }), 'onsite');
  assert.equal(cam.label, 'Cars on the property now');
  assert.equal(cam.value, DASH);
});

test('a camera property counts the cars here now, residents and visitors', () => {
  const t = tile(todayTiles({ presence: presence(36, 5), counts, summary, now: NOW }), 'onsite');
  assert.equal(t.label, 'Cars on the property now');
  assert.equal(t.value, '41');
  assert.equal(t.sub, '36 residents · 5 visitors');
  assert.equal(tile(todayTiles({ presence: presence(1, 1), counts, summary, now: NOW }), 'onsite').sub, '1 resident · 1 visitor');
});

test('a value that failed to load is a dash, never 0', () => {
  const tiles = todayTiles({ presence: null, counts: null, summary: null, now: NOW });
  assert.deepEqual(tiles.map(t => t.value), [DASH, DASH, DASH]);
  assert.equal(tile(tiles, 'waiting').tone, 'plain');
  assert.equal(tile(tiles, 'enforced').sub, '');
  // Rows given instead of counts work the same way.
  assert.equal(tile(todayTiles({ presence: presence(0, 0, false), permitsRows: rows, summary, now: NOW }), 'onsite').value, '2');
});

test('waiting: the queue count wins over the summary, and asks for attention above 0', () => {
  assert.deepEqual(tile(todayTiles({ presence: null, counts, summary, now: NOW }), 'waiting'),
    { id: 'waiting', label: 'Waiting for you', value: '3', sub: 'registrations to approve', tone: 'attention' });
  const none = tile(todayTiles({ presence: null, counts: { ...counts, pending: 0 }, summary, now: NOW }), 'waiting');
  assert.equal(none.value, '0');
  assert.equal(none.tone, 'plain');
  assert.equal(none.sub, 'nothing to approve');
  const one = tile(todayTiles({ presence: null, counts: { ...counts, pending: 1 }, summary, now: NOW }), 'waiting');
  assert.equal(one.sub, 'registration to approve');
  // Before the queue loads, the summary's count stands in.
  assert.equal(tile(todayTiles({ presence: null, counts: null, summary: { ...summary, pending_registration_count: 2 }, now: NOW }), 'waiting').value, '2');
});

test('enforced: tows plus boots this week; a future go-live says when enforcement starts', () => {
  const t = tile(todayTiles({ presence: null, counts, summary, now: NOW }), 'enforced');
  assert.equal(t.label, 'Towed or booted this week');
  assert.equal(t.value, '3');
  assert.equal(t.sub, 'since Monday');
  const future = tile(todayTiles({ presence: null, counts, summary: { ...summary, tows_this_week: 0, boots_this_week: 0, go_live_date: '2027-01-01' }, now: NOW }), 'enforced');
  assert.equal(future.value, '0');
  assert.equal(future.sub, 'Enforcement starts Jan 1, 2027');
  const past = tile(todayTiles({ presence: null, counts, summary: { ...summary, go_live_date: '2026-11-03' }, now: NOW }), 'enforced');
  assert.equal(past.sub, 'since Monday');
  // Go-live today is not "starts": enforcement is on.
  assert.equal(tile(todayTiles({ presence: null, counts, summary: { ...summary, go_live_date: '2026-11-16' }, now: NOW }), 'enforced').sub, 'since Monday');
});

test('enforced: the summary failed, the property\'s own go-live still says when enforcement starts', () => {
  const t = tile(todayTiles({ presence: null, counts, summary: null, goLiveDate: '2027-01-01', now: NOW }), 'enforced');
  assert.equal(t.value, DASH);
  assert.equal(t.sub, 'Enforcement starts Jan 1, 2027');
  assert.equal(tile(todayTiles({ presence: null, counts, summary: null, goLiveDate: '2026-11-03', now: NOW }), 'enforced').sub, '');
});

test('go-live dates are calendar days in Charlotte', () => {
  assert.equal(goLiveLabel('2027-01-01'), 'Jan 1, 2027');
  assert.equal(goLiveLabel('nope'), '');
  assert.equal(goLiveLabel(null), '');
  // 11 PM on the 16th in Charlotte is already the 17th in UTC.
  assert.equal(etDateKey(Date.parse('2026-11-17T04:00:00Z')), '2026-11-16');
});

test('findPlate: plates match on letters and digits only', () => {
  const out = findPlate('abc-1234', { permitsRows: rows, now: NOW });
  assert.equal(out.verdict, 'resident');
  assert.equal(out.row.id, 'r1');
  assert.equal(findPlate(' gst 7120 ', { permitsRows: rows, now: NOW }).verdict, 'visitor');
  assert.equal(findPlate('PLK 5521', { permitsRows: rows, now: NOW }).verdict, 'pending');
  assert.equal(findPlate('', { permitsRows: rows, now: NOW }), null);
});

test('findPlate: an ended or denied pass is not registered; an active hold covers the car', () => {
  assert.equal(findPlate('GST9008', { permitsRows: rows, now: NOW }).verdict, 'not_registered');
  assert.equal(findPlate('OLD0001', { permitsRows: rows, now: NOW }).verdict, 'not_registered');
  const holds = [{ id: 'h1', kind: 'hold', status: 'active', plate: 'XYZ9999', expires_at: '2026-11-18T19:30:00Z' }, { id: 't1', kind: 'tow', status: 'active', plate: 'TOW1111' }];
  const held = findPlate('xyz 9999', { permitsRows: rows, holds, now: NOW });
  assert.equal(held.verdict, 'hold');
  assert.equal(held.hold.id, 'h1');
  // A tow request is not a hold.
  assert.equal(findPlate('TOW1111', { permitsRows: rows, holds, now: NOW }).verdict, 'not_registered');
  assert.equal(findPlate('NOPE123', { permitsRows: rows, holds, now: NOW }).verdict, 'not_registered');
});

test('findPlate: a car on the property now is noted', () => {
  const out = findPlate('VIS0', { permitsRows: rows, onProperty: presence(0, 1).on_property, now: NOW });
  assert.equal(out.verdict, 'not_registered');
  assert.equal(out.here.plate, 'VIS0');
});

test('plateVerdict: every verdict has a word, and a tone that is never colour alone', () => {
  const words = ['resident', 'visitor', 'pending', 'hold', 'not_registered'].map(v => plateVerdict({ verdict: v, row: null }, 'The Volaire'));
  assert.deepEqual(words.map(w => w.word), ['Registered', 'Visitor pass', 'Waiting for approval', 'On hold', 'Not registered']);
  assert.deepEqual(words.map(w => w.tone), ['green', 'green', 'info', 'info', 'red']);
  assert.equal(plateVerdict(findPlate('ABC1234', { permitsRows: rows, now: NOW }), 'The Volaire').detail, 'Unit 214 · 2019 Honda Civic, gray');
  assert.equal(plateVerdict(findPlate('NOPE', { permitsRows: rows, now: NOW }), 'The Volaire').detail, 'No parking pass at The Volaire.');
  assert.match(plateVerdict(findPlate('GST7120', { permitsRows: rows, now: NOW }), 'X').detail, /^Visiting unit 205 · until Wed Nov 18, 6:30 PM$/);
  assert.equal(plateVerdict(null, 'X'), null);
});
