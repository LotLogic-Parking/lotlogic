// Tests for frontend/src/lib/adminTable.js - the platform admin's Properties table, pure half.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  joinOps, statusFor, filterChips, applyFilter, residentLink, sortRows, towPartnerOf, needsFor, needDetail, managerName, numberOrDash, DASH,
} from '../src/lib/adminTable.js';

const NOW = Date.parse('2026-11-16T19:30:00Z'); // Mon Nov 16, 2:30 PM in Charlotte
const HOUR = 3600_000;
const ago = (ms) => new Date(NOW - ms).toISOString();

const NMLD = '00000000-0000-4000-8001-000000000001';
const NSTYLE = '00000000-0000-4000-8001-000000000002';

function row(id, over = {}) {
  return {
    id, name: `Property ${id}`, address: `${id} Main St, Charlotte, NC`, property_type: 'apartment',
    partner_id: NSTYLE, partner_name: 'N Style Towing LLC', tow_company_id: NSTYLE, tow_company_name: 'N Style Towing LLC',
    active_pass_count: 10, qr_code_id: `qr-${id}`, go_live_date: '2026-10-01', units: 50, archived_at: null,
    owner_name: 'Owner', pending_registration_count: 0, oldest_pending_registration_at: null,
    tows_this_week: 0, boots_this_week: 0, unreached_request_count: 0,
    ...over,
  };
}

const OPS = {
  as_of: ago(0),
  needs: [
    { key: 'paid:b2', severity: 'red', title: 'Boot 02 paid but still locked', detail: 'KMD4821 at Mayfield paid.', at: ago(HOUR), action: { type: 'boot', id: 'b2' } },
    { key: 'camera:c4', severity: 'red', title: 'Gate South has gone quiet', detail: 'At Plaza.', at: ago(3 * HOUR), action: { type: 'property', id: 'plaza' } },
    { key: 'req:r1', severity: 'amber', title: 'Tow request not acknowledged', detail: 'SCX3108 at Fort Mill.', at: ago(3 * HOUR), action: { type: 'property', id: 'fm' } },
    { key: 'battery:b5', severity: 'amber', title: 'Boot 05 battery at 17%', detail: 'Charge it soon.', at: ago(0), action: { type: 'boot', id: 'b5' } },
  ],
  boots: [
    { id: 'b1', label: 'Boot 01', where: 'agent', car: null },
    { id: 'b2', label: 'Boot 02', where: 'car', car: { plate: 'KMD4821', property_id: 'mayfield', since: ago(2 * HOUR), paid: true } },
    { id: 'b5', label: 'Boot 05', where: 'agent', car: null },
  ],
  properties: [
    { id: 'mayfield', working: true, cameras: 2 },
    { id: 'plaza', working: false, cameras: 2 },
    { id: 'volaire', working: null, cameras: 0 },
  ],
};

test('joinOps counts a boot on a car at the property and attaches its boot need', () => {
  const [m] = joinOps([row('mayfield')], OPS);
  assert.equal(m.ops.boots_on_cars, 1);
  assert.equal(m.ops.working, true);
  assert.equal(m.ops.cameras, 2);
  assert.deepEqual(m.ops.needs.map(n => n.key), ['paid:b2']);
});

test('joinOps attaches property needs by action id, and a boot need that is on no car goes nowhere', () => {
  const rows = joinOps([row('plaza'), row('fm'), row('volaire')], OPS);
  assert.deepEqual(rows[0].ops.needs.map(n => n.key), ['camera:c4']);
  assert.deepEqual(rows[1].ops.needs.map(n => n.key), ['req:r1']);
  assert.deepEqual(rows[2].ops.needs, []);
  assert.equal(rows[2].ops.boots_on_cars, 0);
  // A property admin-ops does not list: no cameras, no verdict.
  assert.equal(rows[1].ops.working, null);
  assert.equal(rows[1].ops.cameras, 0);
});

test('joinOps(rows, null): every ops is null, and the rows are copies', () => {
  const src = [row('a'), row('b')];
  const out = joinOps(src, null);
  assert.deepEqual(out.map(r => r.ops), [null, null]);
  assert.notEqual(out[0], src[0]);
  assert.equal('ops' in src[0], false);
});

test('statusFor: each rule in order, the first match wins', () => {
  const joined = (r) => joinOps([r], OPS)[0];
  // Unreached beats a camera offline.
  assert.deepEqual(statusFor(joined(row('plaza', { unreached_request_count: 1 })), NOW), { key: 'unreached', label: 'Request not reached', tone: 'red' });
  // A red boot need: its own title, red.
  assert.deepEqual(statusFor(joined(row('mayfield')), NOW), { key: 'needs_red', label: 'Boot 02 paid but still locked', tone: 'red' });
  // Cameras silent: "Camera offline" (the camera's own need is that same fact, so it does not win).
  assert.deepEqual(statusFor(joined(row('plaza')), NOW), { key: 'camera_offline', label: 'Camera offline', tone: 'red' });
  // Registrations older than a day.
  assert.deepEqual(statusFor(joined(row('fm', { pending_registration_count: 3, oldest_pending_registration_at: ago(30 * HOUR) })), NOW), { key: 'waiting', label: '3 waiting over a day', tone: 'amber' });
  // An amber need: its title.
  assert.deepEqual(statusFor(joined(row('fm')), NOW), { key: 'needs_amber', label: 'Tow request not acknowledged', tone: 'amber' });
  // Go-live ahead.
  assert.deepEqual(statusFor(joined(row('volaire', { go_live_date: '2027-01-01' })), NOW), { key: 'starts', label: 'Starts Jan 1', tone: 'blue' });
  assert.deepEqual(statusFor(joined(row('volaire')), NOW), { key: 'ok', label: 'All good', tone: 'green' });
});

test('statusFor: no ops (admin-ops failed) never says Camera offline, nor All good; no cameras never says offline', () => {
  assert.deepEqual(statusFor({ ...row('plaza'), ops: null }, NOW), { key: 'unknown', label: 'Not checked', tone: 'neutral' });
  assert.equal(statusFor({ ...row('v'), ops: { working: false, cameras: 0, boots_on_cars: 0, needs: [] } }, NOW).key, 'ok');
});

test('statusFor: a row built from admin-ops alone (/admin/clients failed) is Not checked unless admin-ops says more', () => {
  const ops = { working: true, cameras: 2, boots_on_cars: 0, needs: [] };
  assert.equal(statusFor({ id: 'm', name: 'M', _partial: true, ops }, NOW).label, 'Not checked');
  assert.equal(statusFor({ id: 'p', name: 'P', _partial: true, ops: { ...ops, working: false } }, NOW).label, 'Camera offline');
});

test('statusFor: pending 2 h old is not "waiting"; over 24 h is', () => {
  const r = (h) => ({ ...row('x', { pending_registration_count: 2, oldest_pending_registration_at: ago(h * HOUR) }), ops: null });
  assert.equal(statusFor(r(2), NOW).key, 'unknown');
  assert.equal(statusFor(r(25), NOW).label, '2 waiting over a day');
});

test('statusFor: go-live tomorrow starts, today or yesterday is all good, none is all good', () => {
  const r = (d) => ({ ...row('x', { go_live_date: d }), ops: { working: null, cameras: 0, boots_on_cars: 0, needs: [] } });
  assert.equal(statusFor(r('2026-11-17'), NOW).label, 'Starts Nov 17');
  assert.equal(statusFor(r('2026-11-16'), NOW).label, 'All good');
  assert.equal(statusFor(r('2026-11-15'), NOW).label, 'All good');
  assert.equal(statusFor(r(null), NOW).label, 'All good');
});

test('statusFor: "Starts" is late in the evening in Charlotte, not by the UTC day', () => {
  // 11:30 PM Nov 16 in Charlotte is already Nov 17 in UTC; go-live Nov 17 is still ahead.
  const late = Date.parse('2026-11-17T04:30:00Z');
  assert.equal(statusFor({ ...row('x', { go_live_date: '2026-11-17' }), ops: null }, late).label, 'Starts Nov 17');
});

test('towPartnerOf: the tow company for an apartment, the account partner for a truck plaza', () => {
  assert.deepEqual(towPartnerOf(row('a')), { id: NSTYLE, name: 'N Style Towing' });
  assert.deepEqual(towPartnerOf(row('p', { property_type: 'truck_plaza', tow_company_id: null, tow_company_name: null, partner_id: NMLD, partner_name: 'NMLD Towing' })), { id: NMLD, name: 'NMLD Towing' });
  assert.deepEqual(towPartnerOf(row('n', { tow_company_id: null, tow_company_name: null, partner_id: null, partner_name: null })), { id: null, name: '' });
});

test('filterChips: All, Needs attention, one per tow partner (biggest first), Truck plaza when any', () => {
  const rows = joinOps([
    row('mayfield'),
    row('plaza', { property_type: 'truck_plaza', tow_company_id: null, tow_company_name: null, partner_id: NMLD, partner_name: 'NMLD Towing' }),
    row('volaire', { tow_company_id: NMLD, tow_company_name: 'NMLD Towing', partner_id: NMLD, partner_name: 'NMLD Towing', go_live_date: '2027-01-01' }),
    row('fm', { pending_registration_count: 4, oldest_pending_registration_at: ago(30 * HOUR) }),
    row('st'),
  ], OPS);
  assert.deepEqual(filterChips(rows, NOW), [
    { id: 'all', label: 'All', count: 5 },
    { id: 'attention', label: 'Needs attention', count: 3 },
    { id: `partner:${NSTYLE}`, label: 'N Style Towing', count: 3 },
    { id: `partner:${NMLD}`, label: 'NMLD Towing', count: 2 },
    { id: 'truck_plaza', label: 'Truck plaza', count: 1 },
  ]);
  assert.deepEqual(filterChips(joinOps([row('a')], null), NOW).map(c => c.id), ['all', 'attention', `partner:${NSTYLE}`]);
});

test('applyFilter: chips, then the query on name or address, case-insensitive', () => {
  const rows = joinOps([
    row('mayfield', { name: 'Mayfield Memorial Apartments' }),
    row('plaza', { name: 'Charlotte Travel Plaza', address: '3800 Statesville Ave', property_type: 'truck_plaza', partner_id: NMLD, tow_company_id: null }),
    row('volaire', { name: 'The Volaire', address: '3904 W Tyvola Rd', tow_company_id: NMLD }),
  ], OPS);
  assert.deepEqual(applyFilter(rows, 'attention', '', NOW).map(r => r.id), ['mayfield', 'plaza']);
  assert.deepEqual(applyFilter(rows, `partner:${NMLD}`, '', NOW).map(r => r.id), ['plaza', 'volaire']);
  assert.deepEqual(applyFilter(rows, 'truck_plaza', '', NOW).map(r => r.id), ['plaza']);
  assert.deepEqual(applyFilter(rows, 'all', 'tyVOLA', NOW).map(r => r.id), ['volaire']);
  assert.deepEqual(applyFilter(rows, 'all', '  volaire ', NOW).map(r => r.id), ['volaire']);
  assert.deepEqual(applyFilter(rows, 'attention', 'volaire', NOW), []);
  assert.deepEqual(applyFilter(rows, 'nope', '', NOW).map(r => r.id), ['mayfield', 'plaza', 'volaire']);
});

test('sortRows: red first, then waiting / amber, then starts, then all good; by name inside each', () => {
  const rows = joinOps([
    row('z', { name: 'Zeta' }),
    row('volaire', { name: 'The Volaire', go_live_date: '2027-01-01' }),
    row('fm', { name: 'Fort Mill', pending_registration_count: 4, oldest_pending_registration_at: ago(30 * HOUR) }),
    row('a', { name: 'Alpha' }),
    row('plaza', { name: 'Plaza' }),
    row('mayfield', { name: 'Mayfield', unreached_request_count: 1 }),
  ], OPS);
  assert.deepEqual(sortRows(rows, NOW).map(r => r.name), ['Mayfield', 'Plaza', 'Fort Mill', 'The Volaire', 'Alpha', 'Zeta']);
});

test('sortRows: inside red, statusFor\'s order beats the name (Request not reached before Camera offline)', () => {
  const rows = joinOps([
    row('plaza', { name: 'Alpha Plaza' }),
    row('fm', { name: 'Zed Townhomes', unreached_request_count: 1 }),
    row('x', { name: 'Not Checked' }),
  ], OPS);
  rows[2] = { ...rows[2], ops: null };
  assert.deepEqual(sortRows(rows, NOW).map(r => r.name), ['Zed Townhomes', 'Alpha Plaza', 'Not Checked']);
});

test('needDetail: the panel leaves out the property it is the panel of', () => {
  assert.equal(needDetail({ detail: 'At Charlotte Travel Plaza.' }, { name: 'Charlotte Travel Plaza' }), '');
  assert.equal(needDetail({ detail: 'SCX3108 at Fort Mill.' }, { name: 'Fort Mill' }), 'SCX3108 at Fort Mill');
  assert.equal(needDetail({ detail: 'At A (B). Then more.' }, { name: 'A (B)' }), 'Then more');
});

test('managerName: the contact person, never the property\'s own name again', () => {
  assert.equal(managerName({ name: 'The Volaire', owner_name: 'The Volaire' }), '');
  assert.equal(managerName({ name: 'The Volaire', owner_name: 'the volaire ' }), '');
  assert.equal(managerName({ name: 'The Volaire', owner_name: 'The Volaire', owner_contact_name: 'Justin Christian' }), 'Justin Christian');
  assert.equal(managerName({ name: 'Fort Mill Townhomes II', owner_name: 'Fort Mill Townhomes' }), 'Fort Mill Townhomes');
  assert.equal(managerName({ name: 'X', owner_name: null }), '');
});

test('needsFor: the row\'s needs, red first, without the 4-hour registration need', () => {
  const reg = { key: 'reg:mayfield', severity: 'amber', title: '1 registration waiting over 4 h', detail: '', at: ago(5 * HOUR), action: { type: 'property', id: 'mayfield' } };
  const [m] = joinOps([row('mayfield')], { ...OPS, needs: [OPS.needs[3], reg, OPS.needs[0]], boots: OPS.boots.map(b => (b.id === 'b5' ? { ...b, where: 'car', car: { property_id: 'mayfield' } } : b)) });
  assert.deepEqual(needsFor(m).map(n => n.key), ['paid:b2', 'battery:b5']);
  // ...and it never sets the status either: 5 h is not a day.
  assert.equal(statusFor({ ...m, ops: { ...m.ops, needs: [reg] } }, NOW).key, 'ok');
  assert.deepEqual(needsFor({ ...m, ops: null }), []);
});

test('residentLink: /apt/<qr>?role=resident for an apartment with a QR code, else null', () => {
  assert.equal(residentLink(row('v', { qr_code_id: 'the-volaire' }), 'https://lotlogic-beta.vercel.app'), 'https://lotlogic-beta.vercel.app/apt/the-volaire?role=resident');
  assert.equal(residentLink(row('v', { qr_code_id: 'a b' }), 'https://x.test/'), 'https://x.test/apt/a%20b?role=resident');
  assert.equal(residentLink(row('v', { qr_code_id: null }), 'https://x.test'), null);
  assert.equal(residentLink(row('v', { qr_code_id: '' }), 'https://x.test'), null);
  assert.equal(residentLink(row('p', { property_type: 'truck_plaza' }), 'https://x.test'), null);
});

test('numberOrDash: a number is grouped, anything else is a dash', () => {
  assert.equal(numberOrDash(1204), '1,204');
  assert.equal(numberOrDash(0), '0');
  assert.equal(numberOrDash(null), DASH);
  assert.equal(numberOrDash(undefined), DASH);
  assert.equal(numberOrDash('3'), '3');
});

// ── Part 3: a property whose enforcement is paused ───────────
const PAUSE = { id: 'p1', ends_at: '2026-11-17T23:00:00+00:00', ends_local: 'Tue Nov 17, 6:00 PM ET', reason: 'Pool party' };

test('statusFor: a pause reads "Paused until <time>" in blue, after the red and waiting keys, before Starts', () => {
  const joined = (r) => joinOps([r], OPS)[0];
  assert.deepEqual(statusFor(joined(row('volaire', { active_pause: PAUSE })), NOW), { key: 'paused', label: 'Paused until Tue 6:00 PM', tone: 'blue' });
  // Before go-live too: the pause is what is true right now.
  assert.equal(statusFor(joined(row('volaire', { active_pause: PAUSE, go_live_date: '2027-01-01' })), NOW).key, 'paused');
  // Red and the waiting / amber keys still come first.
  assert.equal(statusFor(joined(row('plaza', { active_pause: PAUSE, unreached_request_count: 1 })), NOW).key, 'unreached');
  assert.equal(statusFor(joined(row('plaza', { active_pause: PAUSE })), NOW).key, 'camera_offline');
  assert.equal(statusFor(joined(row('fm', { active_pause: PAUSE, pending_registration_count: 3, oldest_pending_registration_at: ago(30 * HOUR) })), NOW).key, 'waiting');
  assert.equal(statusFor(joined(row('fm', { active_pause: PAUSE })), NOW).key, 'needs_amber');
  // Without admin-ops the pause still shows (it comes from /admin/clients).
  assert.equal(statusFor({ ...row('v', { active_pause: PAUSE }), ops: null }, NOW).key, 'paused');
});

test('statusFor: a pause whose end has passed (the table was left open) is dropped', () => {
  const joined = (r) => joinOps([r], OPS)[0];
  const later = Date.parse(PAUSE.ends_at);
  assert.equal(statusFor(joined(row('volaire', { active_pause: PAUSE })), later).key, 'ok');
  assert.equal(statusFor(joined(row('volaire', { active_pause: null })), NOW).key, 'ok');
});

test('sortRows: a paused property sorts after the waiting ones and before Starts', () => {
  const rows = joinOps([
    row('volaire', { go_live_date: '2027-01-01' }),
    row('v2', { name: 'A paused one', active_pause: PAUSE }),
    row('fm2', { pending_registration_count: 2, oldest_pending_registration_at: ago(30 * HOUR) }),
  ], OPS);
  assert.deepEqual(sortRows(rows, NOW).map(r => r.id), ['fm2', 'v2', 'volaire']);
});

test('a paused property does not need attention (blue is not red or amber)', () => {
  const rows = joinOps([row('volaire', { active_pause: PAUSE })], OPS);
  assert.equal(filterChips(rows, NOW).find(c => c.id === 'attention').count, 0);
});
