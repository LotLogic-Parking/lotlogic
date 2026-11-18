// Tests for frontend/src/lib/enforcement.js - the Smart Boot fleet page's pure half.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressMapUrl, ago, batteryTone, bootFlags, canSeeEnforcement, commandLabel, dataUrlToBlob, deploymentLabel,
  fleetSummary, isEnforcementAdmin, isLotLogicAgent, isOnCar, mapUrl, money, stateLabel,
} from '../src/lib/enforcement.js';

const NOW = new Date('2026-11-15T15:00:00Z').getTime();

test('canSeeEnforcement: exactly the two LotLogic emails, any case; never while viewing as a partner', () => {
  assert.equal(canSeeEnforcement({ email: 'gabriel@lotlogicparking.com' }), true);
  assert.equal(canSeeEnforcement({ email: 'Victor@LotLogicParking.com ' }), true);
  assert.equal(canSeeEnforcement({ email: 'victorsimmons2002@gmail.com', is_platform_admin: true }), false);
  assert.equal(canSeeEnforcement({ email: 'manager@property.com' }), false);
  assert.equal(canSeeEnforcement({ email: 'gabriel@lotlogicparking.com' }, { id: 'p1' }), false);
  assert.equal(canSeeEnforcement(null), false);
});

test('canSeeEnforcement: LotLogic agents too, signed in as themselves; no other company', () => {
  const agent = { _role: 'partner', email: 'dana@example.com', company_name: 'LotLogic', member_id: 'm1', member_role: 'driver' };
  assert.equal(isLotLogicAgent(agent), true);
  assert.equal(canSeeEnforcement(agent), true);
  assert.equal(canSeeEnforcement({ ...agent, member_role: 'dispatcher' }), true);
  assert.equal(isEnforcementAdmin(agent), false);
  // another tow company's team, and LotLogic's company login that names no person
  assert.equal(canSeeEnforcement({ ...agent, company_name: 'N Style Towing' }), false);
  assert.equal(canSeeEnforcement({ ...agent, member_id: null }), false);
  // before /auth/me has said which company it is
  assert.equal(canSeeEnforcement({ ...agent, company_name: undefined }), false);
  assert.equal(canSeeEnforcement(agent, { id: 'p1' }), false);
  // an admin's email on a partner session is not the admin
  assert.equal(isEnforcementAdmin({ _role: 'partner', email: 'gabriel@lotlogicparking.com' }), false);
  assert.equal(isEnforcementAdmin({ _role: 'owner', email: 'gabriel@lotlogicparking.com' }), true);
});

test('addressMapUrl and dataUrlToBlob', () => {
  assert.equal(addressMapUrl('4912 Daybreak Dr, Charlotte, NC'), 'https://www.google.com/maps/search/?api=1&query=4912%20Daybreak%20Dr%2C%20Charlotte%2C%20NC');
  assert.equal(addressMapUrl('  '), null);
  assert.equal(addressMapUrl(null), null);
  const b = dataUrlToBlob('data:image/png;base64,iVBORw==');
  assert.equal(b.type, 'image/png');
  assert.equal(b.size, 4);
});

test('stateLabel and commandLabel', () => {
  assert.deepEqual([0, 1, 2, 3, null].map(stateLabel), ['Locked', 'Open', 'Open', 'Stuck', 'Unknown']);
  assert.equal(commandLabel(2), 'Lock');
  assert.equal(commandLabel(80), 'Setup Wi-Fi');
  assert.equal(commandLabel(99), 'Command 99');
  assert.equal(commandLabel(null), '');
});

test('ago: short relative times, "never" without one', () => {
  assert.equal(ago('2026-11-15T14:59:40Z', NOW), 'just now');
  assert.equal(ago('2026-11-15T14:56:00Z', NOW), '4 m ago');
  assert.equal(ago('2026-11-15T12:00:00Z', NOW), '3 h ago');
  assert.equal(ago('2026-11-11T13:00:00Z', NOW), '4 d ago');
  assert.equal(ago(null, NOW), 'never');
});

test('bootFlags: worst first; Boot 02 as it reports today', () => {
  const boot02 = { battery_pct: 17, low_battery: true, tamper: true, fault: false, online: false };
  assert.deepEqual(bootFlags(boot02).map(f => f.key), ['tamper', 'battery', 'offline']);
  assert.deepEqual(bootFlags({ online: true }), []);
  assert.deepEqual(bootFlags({ fault: true, online: true }).map(f => f.tone), ['bad']);
});

test('batteryTone, money, mapUrl, deploymentLabel, isOnCar', () => {
  assert.deepEqual([17, 40, 93, null].map(batteryTone), ['bad', 'warn', 'ok', 'muted']);
  assert.equal(money(27500), '$275');
  assert.equal(money(150), '$1.50');
  assert.equal(money(null), '—');
  assert.equal(mapUrl(35.37, -80.8), 'https://www.google.com/maps?q=35.37,-80.8');
  assert.equal(mapUrl(null, 1), null);
  assert.equal(deploymentLabel('release_authorized'), 'Paid, releasing');
  assert.equal(isOnCar({ status: 'active' }), true);
  assert.equal(isOnCar({ status: 'unlocked' }), false);
  assert.equal(isOnCar(null), false);
});

test('fleetSummary: totals, on a car, needing attention, online', () => {
  const s = fleetSummary([
    { deployment_status: 'active', online: true },
    { low_battery: true, tamper: true, online: false },
    { fault: true, online: false },
  ]);
  assert.deepEqual(s, { total: 3, onCar: 1, attention: 2, online: 1 });
  assert.deepEqual(fleetSummary(null), { total: 0, onCar: 0, attention: 0, online: 0 });
});

import { meters, paymentFlags, paymentsSummary, placeLine } from '../src/lib/enforcement.js';

const AT = { gps: { lat: 35.2831, lon: -80.8105, source: 'lock' }, geo: { at_property: true, property: 'Mayfield Memorial Apartments', distance_m: 85, nearest: 'Mayfield Memorial Apartments', nearest_m: 85 }, paid_amount_cents: 25000 };
const OFF = { gps: { lat: 35.37, lon: -80.80, source: 'lock' }, geo: { at_property: false, property: null, distance_m: null, nearest: 'Charlotte Travel Plaza', nearest_m: 8300 } };

test('meters and placeLine: at a property, off property, no GPS', () => {
  assert.deepEqual([85, 1234, 12345, null].map(meters), ['85 m', '1.2 km', '12 km', '']);
  assert.equal(placeLine(AT), 'Mayfield Memorial Apartments · 85 m from the address');
  assert.equal(placeLine(OFF), 'Not at a LotLogic property · nearest Charlotte Travel Plaza, 8.3 km');
  assert.equal(placeLine({ gps: null }), 'No GPS recorded');
});

test('paymentFlags: what needs a look on a payment', () => {
  assert.deepEqual(paymentFlags({ kind: 'boot', square: { fee_cents: 755, refunded_cents: 0 }, placement: AT }), []);
  assert.deepEqual(paymentFlags({ kind: 'boot', square: { fee_cents: null, refunded_cents: 0 }, placement: OFF }).map(f => f.key), ['off', 'nofee']);
  assert.deepEqual(paymentFlags({ kind: 'boot', square: null, placement: { gps: null }, not_in_square: true }).map(f => f.key), ['nosquare', 'nogps']);
  assert.deepEqual(paymentFlags({ kind: 'other', square: { fee_cents: 3, refunded_cents: 0 }, placement: null }).map(f => f.key), ['other']);
});

test('paymentsSummary: boot payments only, Square numbers first', () => {
  const s = paymentsSummary([
    { kind: 'boot', square: { amount_cents: 25000, fee_cents: 755, refunded_cents: 0, net_cents: 24245 }, placement: AT },
    { kind: 'boot', square: { amount_cents: 25000, fee_cents: 755, refunded_cents: 25000, net_cents: -755 }, placement: OFF },
    { kind: 'boot', square: null, not_in_square: true, placement: { ...AT, square_fee_cents: 0 } },
    { kind: 'other', square: { amount_cents: 999, fee_cents: 30, net_cents: 969 }, placement: null },
  ]);
  assert.deepEqual(s, { count: 3, gross: 75000, fees: 1510, refunded: 25000, net: 48490, atProperty: 2, offProperty: 1, other: 1 });
});

test('paymentsSummary: a declined card is listed but not counted; a placement Square did not list nets its own numbers', () => {
  const s = paymentsSummary([
    { kind: 'boot', square: { status: 'FAILED', amount_cents: 25000, fee_cents: null, net_cents: 25000, refunded_cents: 0 }, placement: { geo: { at_property: true } } },
    { kind: 'boot', square: { status: 'COMPLETED', amount_cents: 25000, fee_cents: 755, net_cents: 24245, refunded_cents: 0 }, placement: { geo: { at_property: true } } },
    { kind: 'boot', square: null, not_in_square: true, placement: { paid_amount_cents: 25000, square_fee_cents: 700, refunded_amount_cents: 5000, geo: null } },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.gross, 50000);
  assert.equal(s.fees, 1455);
  assert.equal(s.refunded, 5000);
  assert.equal(s.net, 24245 + 19300);
  assert.equal(s.other, 0);
});

// ── Agents panel (lib/enforcement.js agent helpers) ──
import { agentBody, agentCoverage, agentRoleLabel, agentStatus } from '../src/lib/enforcement.js';

test('agentBody: a valid driver with a property becomes the agent-add body', () => {
  assert.deepEqual(
    agentBody({ name: ' Dana Reyes ', email: ' Dana@Example.com ', phone: '', role: 'driver', property_ids: ['p1', 'p1', ''] }),
    { body: { name: 'Dana Reyes', email: 'dana@example.com', phone: undefined, role: 'driver', property_ids: ['p1'] } },
  );
  assert.equal(agentBody({ name: 'Al', email: 'a@b.co', role: 'dispatcher', property_ids: [] }).body.role, 'dispatcher');
});

test('agentBody: what to fix, first problem first', () => {
  assert.equal(agentBody({}).error, "Enter the agent's name.");
  assert.equal(agentBody({ name: 'Al', email: 'nope', role: 'driver' }).error, 'Enter a valid email address.');
  assert.equal(agentBody({ name: 'Al', email: 'a@b.co', role: 'admin' }).error, 'Pick driver or dispatcher.');
  assert.equal(agentBody({ name: 'Al', email: 'a@b.co', role: 'driver', property_ids: [] }).error, 'Pick at least one property this driver covers.');
});

test('agentStatus and agentCoverage', () => {
  assert.equal(agentStatus({ has_password: false }).label, 'Invited · no password yet');
  assert.equal(agentStatus({ has_password: true, last_login_at: null }).label, 'Password set · never signed in');
  assert.equal(agentStatus({ has_password: true, last_login_at: '2026-11-15T12:00:00Z' }, NOW).label, 'Signed in 3 h ago');
  assert.equal(agentCoverage({ role: 'dispatcher', properties: [] }), 'Every property');
  assert.equal(agentCoverage({ role: 'driver', properties: [{ name: 'A' }, { name: 'B' }] }), 'A, B');
  assert.equal(agentCoverage({ role: 'driver', properties: [] }), 'No properties: cannot boot anywhere');
  assert.equal(agentRoleLabel('dispatcher'), 'Dispatcher');
});
