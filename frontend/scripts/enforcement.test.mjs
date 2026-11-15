// Tests for frontend/src/lib/enforcement.js - the Smart Boot fleet page's pure half.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_LABEL, actionsFor, ago, batteryTone, bootFlags, canSeeEnforcement, commandLabel, deploymentLabel,
  fleetSummary, isOnCar, mapUrl, money, stateLabel,
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

test('actionsFor: the buttons that make sense for the boot right now', () => {
  // free, closed boot: open it to fit, or set up Wi-Fi; emergency is always there
  assert.deepEqual(actionsFor({ state: 0 }, null), ['open', 'wifi', 'emergency']);
  // free, open boot: place it on a car or close it for storage
  assert.deepEqual(actionsFor({ state: 1 }, { status: 'unlocked' }), ['place', 'store', 'wifi', 'emergency']);
  // on a car, unpaid: waive (admin) or emergency; a queued lock can still be cancelled
  assert.deepEqual(actionsFor({ state: 0 }, { status: 'locking' }, [{ cmd: 2, status: 'queued' }]), ['waive', 'cancel', 'emergency']);
  // paid: send the release
  assert.deepEqual(actionsFor({ state: 0 }, { status: 'release_authorized' }), ['release', 'emergency']);
  for (const k of ['open', 'place', 'store', 'release', 'waive', 'cancel', 'emergency', 'wifi']) assert.ok(ACTION_LABEL[k]);
});
