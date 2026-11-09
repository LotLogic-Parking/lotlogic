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
  assert.match(EMPTY_COPY.on_property, /^Nobody is on the property right now\./);
  assert.match(EMPTY_COPY.recent_exits, /last 24 hours/);
  assert.equal(NO_PASS_DIVIDER, 'No pass on file');
});

// ── The people list (Gabe, 2026-11-07: "a list of everyone by name") ──
import {
  NO_PASS_DIVIDER,
  detailSections,
  filterPeople,
  findPermitsRow,
  matchesSearch,
  peopleRows,
  personName,
  photoSource,
  rowSummary,
  rowTitle,
  timeLeftText,
} from '../src/lib/presence.js';

const NOW = Date.parse('2026-11-07T16:00:00Z');

test('photoSource: the backend\'s own photo needs the session, a storage URL does not', () => {
  assert.equal(photoSource('/apartment/requests/T-1/photo', 'https://api.example'), 'api');
  assert.equal(photoSource('https://api.example/apartment/requests/T-1/photo', 'https://api.example'), 'api');
  assert.equal(photoSource('https://cdn.example/c3.jpg', 'https://api.example'), 'direct');
  assert.equal(photoSource(null), 'none');
  assert.equal(photoSource('  '), 'none');
});
const PEOPLE = [
  { session_id: 'a', plate: 'ZED001', vehicle: 'blue Kia Soul', minutes_here: 5, pass: { kind: 'long_term', id: 'r2', status: 'approved', name: 'Zoe Adams', unit: '101' } },
  { session_id: 'b', plate: 'ABC1234', vehicle: 'white Honda Civic', minutes_here: 72, entered_at: '2026-11-07T14:48:00Z', camera_name: 'Front gate',
    pass: { kind: 'short_term', id: 'v1', status: 'active', until: '2026-11-07T18:10:00Z', minutes_left: 130, name: 'Pat Example', unit: '214', phone: '555-0199', email: 'pat@example.test' } },
  { session_id: 'c', plate: 'NOPASS1', vehicle: 'grey Ford F-150', minutes_here: 2, pass: null },
  { session_id: 'd', plate: 'MMM222', vehicle: '', minutes_here: 30, pass: { kind: 'short_term', id: 'v2', status: 'active', minutes_left: 40 } }, // partner-shaped: no name
  { session_id: 'e', plate: 'AAA111', vehicle: '', minutes_here: 9, pass: null },
  { session_id: 'f', plate: 'BBB333', vehicle: 'red Tesla', minutes_here: 400, pass: { kind: 'long_term', id: 'r3', status: 'approved', name: 'amy Baker', unit: '7B' } },
];

test('peopleRows: by name, case-insensitively; nameless rows with a pass by plate after them; no pass on file last', () => {
  const { people, noPass } = peopleRows(PEOPLE);
  assert.deepEqual(people.map(r => r.session_id), ['f', 'b', 'a', 'd']);
  assert.deepEqual(noPass.map(r => r.plate), ['AAA111', 'NOPASS1']);
  assert.deepEqual(peopleRows(null), { people: [], noPass: [] });
  assert.deepEqual(peopleRows([null, PEOPLE[2]]).noPass.length, 1);
});

test('a partner payload (no names anywhere) lists by plate', () => {
  const partner = PEOPLE.map(r => (r.pass ? { ...r, pass: { kind: r.pass.kind, id: r.pass.id, status: r.pass.status, minutes_left: r.pass.minutes_left ?? null } } : r));
  assert.deepEqual(peopleRows(partner).people.map(r => r.plate), ['ABC1234', 'BBB333', 'MMM222', 'ZED001']);
  assert.equal(rowTitle(partner[1]), 'ABC1234');
});

test('rowTitle and personName', () => {
  assert.equal(personName(PEOPLE[1]), 'Pat Example');
  assert.equal(personName(PEOPLE[2]), '');
  assert.equal(rowTitle(PEOPLE[1]), 'Pat Example');
  assert.equal(rowTitle(PEOPLE[2]), 'NOPASS1');
  assert.equal(rowTitle({}), '—');
});

test('rowSummary: unit · plate · car · how long', () => {
  assert.equal(rowSummary(PEOPLE[1]), 'Unit 214 · ABC1234 · white Honda Civic · here 1 h 12 m');
  assert.equal(rowSummary(PEOPLE[2]), 'grey Ford F-150 · here 2 m', 'a plate-headed row does not repeat its plate');
  assert.equal(rowSummary({ ...PEOPLE[1], minutes_stayed: 95 }, 'recent_exits'), 'Unit 214 · ABC1234 · white Honda Civic · stayed 1 h 35 m');
});

test('matchesSearch / filterPeople: name as typed, unit and plate as letters and digits', () => {
  assert.equal(matchesSearch(PEOPLE[1], 'pat'), true);
  assert.equal(matchesSearch(PEOPLE[1], 'EXAMPLE'), true);
  assert.equal(matchesSearch(PEOPLE[1], '#214'), true);
  assert.equal(matchesSearch(PEOPLE[1], 'abc-12'), true);
  assert.equal(matchesSearch(PEOPLE[1], 'zoe'), false);
  assert.equal(matchesSearch(PEOPLE[2], 'nopass'), true, 'no pass: still found by plate');
  assert.equal(matchesSearch(PEOPLE[2], '214'), false);
  assert.equal(matchesSearch(PEOPLE[1], '   '), true);
  assert.equal(matchesSearch(PEOPLE[1], '!!'), false, 'a search that normalises to nothing and is not a name matches nothing');
  assert.deepEqual(filterPeople(PEOPLE, 'a').map(r => r.session_id), ['a', 'b', 'c', 'e', 'f'], 'name or plate contains an A');
  assert.deepEqual(filterPeople(PEOPLE, '7b').map(r => r.session_id), ['f']);
  assert.deepEqual(filterPeople(null, 'x'), []);
});

test('timeLeftText ticks from `until`, falls back to the server minutes, is blank for long-term', () => {
  assert.equal(timeLeftText(PEOPLE[1].pass, NOW), '2h 10m left');
  assert.equal(timeLeftText(PEOPLE[1].pass, NOW + 2 * 3600000), '10m left');
  assert.equal(timeLeftText(PEOPLE[3].pass, NOW), '40m left');
  assert.equal(timeLeftText(PEOPLE[0].pass, NOW), '');
  assert.equal(timeLeftText(null, NOW), '');
});

const PERMITS = { residents: [{ id: 'r2', plate_text: 'ZED001', holder_name: 'Zoe Adams', unit_number: '101', status: 'approved', has_id: true, has_plate: true, has_lease: false, has_vehicle_photo: true, has_registration: false, created_at: '2026-10-01T12:00:00Z', reviewed_at: '2026-10-02T12:00:00Z', reviewed_by: 'Breanna', back_plate: 'ZED001B', vehicle_color: 'Blue', vehicle_make: 'Kia', vehicle_model: 'Soul' }],
  guests: [{ id: 'v1', plate_text: 'ABC1234', visitor_name: 'Pat Example', host_unit: '214', status: 'active', has_id: true, has_plate: false, valid_from: '2026-11-07T14:00:00Z', valid_until: '2026-11-07T18:10:00Z', created_at: '2026-11-07T13:55:00Z', reviewed_at: '2026-11-07T13:56:00Z' }] };

test('findPermitsRow joins on the pass id and kind', () => {
  assert.equal(findPermitsRow(PERMITS, PEOPLE[1].pass)?.key, 'guest:v1');
  assert.equal(findPermitsRow(PERMITS, PEOPLE[0].pass)?.key, 'resident:r2');
  assert.equal(findPermitsRow(PERMITS, { kind: 'short_term', id: 'r2' }), null, 'a long-term id is not a short-term pass');
  assert.equal(findPermitsRow(PERMITS, null), null);
  assert.equal(findPermitsRow(null, PEOPLE[1].pass), null);
});

test('detailSections: labelled groups, empty values and empty groups left out', () => {
  const groups = detailSections(PEOPLE[1], { permitsRow: findPermitsRow(PERMITS, PEOPLE[1].pass), now: NOW });
  assert.deepEqual(groups.map(g => g.key), ['contact', 'vehicle', 'pass', 'presence', 'documents']);
  const by = Object.fromEntries(groups.map(g => [g.key, Object.fromEntries(g.items.map(i => [i.label, i.value]))]));
  assert.deepEqual(by.contact, { Name: 'Pat Example', Unit: '214', Phone: '555-0199', Email: 'pat@example.test' });
  assert.deepEqual(by.vehicle, { Plate: 'ABC1234', 'Make / model / colour': 'white Honda Civic' });
  assert.deepEqual(by.pass, {
    Kind: 'Short-term', Status: 'Approved',
    Valid: 'Sat Nov 7, 9:00 AM ET → Sat Nov 7, 1:10 PM ET',
    'Time left': '2h 10m left',
    Filed: 'Sat Nov 7, 8:55 AM ET',
    Approved: 'Sat Nov 7, 8:56 AM ET',
  });
  assert.deepEqual(by.presence, { Entered: 'Sat Nov 7, 9:48 AM ET (1h ago)', Camera: 'Front gate', Here: '1 h 12 m' });
  assert.deepEqual(by.documents, { 'Plate photo': 'Not provided', 'Photo ID': 'Provided' });
  assert.ok(groups.every(g => g.label && g.items.every(i => i.label && i.value)));
});

test('detailSections: a long-term pass carries the back plate, who approved, and the long-term documents, never the lease', () => {
  const groups = detailSections(PEOPLE[0], { permitsRow: findPermitsRow(PERMITS, PEOPLE[0].pass), now: NOW });
  const by = Object.fromEntries(groups.map(g => [g.key, Object.fromEntries(g.items.map(i => [i.label, i.value]))]));
  assert.equal(by.vehicle['Back plate'], 'ZED001B');
  assert.equal(by.pass.Kind, 'Long-term');
  assert.equal(by.pass.Approved, 'Fri Oct 2, 8:00 AM ET by Breanna');
  assert.equal(by.pass['Time left'], undefined, 'a long-term pass has no time left');
  assert.deepEqual(by.documents, { 'Plate photo': 'Provided', 'Vehicle photo': 'Provided', Registration: 'Not provided', 'Photo ID': 'Provided' });
  assert.ok(!('Lease' in by.documents), 'the lease is not shown on the Live panel');
});

test('detailSections: no pass on file, no permits row, a partner payload - fewer lines, never a blank one', () => {
  const groups = detailSections(PEOPLE[2], { now: NOW });
  assert.deepEqual(groups.map(g => g.key), ['vehicle', 'pass', 'presence']);
  assert.deepEqual(groups[1].items, [{ label: 'Status', value: 'No pass on file' }]);
  const partner = detailSections(PEOPLE[3], { now: NOW });
  assert.deepEqual(partner.map(g => g.key), ['vehicle', 'pass', 'presence']);
  assert.deepEqual(partner[1].items.map(i => i.label), ['Kind', 'Status', 'Time left']);
  const gone = detailSections({ ...PEOPLE[1], exited_at: '2026-11-07T15:30:00Z', minutes_stayed: 42 }, { list: 'recent_exits', now: NOW });
  const presence = gone.find(g => g.key === 'presence');
  assert.equal(presence.label, 'Visit');
  assert.deepEqual(presence.items.map(i => i.label), ['Entered', 'Camera', 'Left', 'Stayed']);
  assert.equal(presence.items[3].value, '42 m');
});
