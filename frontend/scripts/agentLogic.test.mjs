// Tests for frontend/src/agent/logic.js: the Enforcement Agent screen's rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ago, attestation, bootActions, bootCounts, bootNotices, bootStatus, bootSubline, commandOutcome, editPlacement,
  emergencyReady, esc, freeBoots, initials, lockBody, needsPickup, newPlacement, normPlate, outcomeMessage,
  bootPauseNotice, placementNotes, signPlacement, stepMissing,
} from '../src/agent/logic.js';

const NOW = Date.parse('2026-11-16T15:00:00Z');
const PNG = 'data:image/png;base64,AAAA';

// ── status wording ─────────────────────────────────────────────────────────
test('bootStatus: placement first, then a command on its way, then fault and battery', () => {
  assert.deepEqual(bootStatus({ deployment_status: 'locking' }), { tone: 'wait', text: 'Locking' });
  assert.deepEqual(bootStatus({ deployment_status: 'active', battery_pct: 10 }), { tone: 'on', text: 'On a car' });
  assert.deepEqual(bootStatus({ deployment_status: 'release_authorized' }), { tone: 'done', text: 'Releasing' });
  assert.deepEqual(bootStatus({ state: 0, pending_status: 'queued', pending_purpose: 'fit' }), { tone: 'wait', text: 'Opening' });
  assert.deepEqual(bootStatus({ state: 1, pending_status: 'delivered', pending_purpose: 'store' }), { tone: 'wait', text: 'Closing' });
  assert.deepEqual(bootStatus({ state: 3 }), { tone: 'ready', text: 'Fault' });
  assert.deepEqual(bootStatus({ state: 0, battery_pct: 21 }), { tone: 'ready', text: 'Battery low' });
  assert.deepEqual(bootStatus({ state: 0, battery_pct: 80 }), { tone: 'grey', text: 'Closed' });
  assert.deepEqual(bootStatus({ state: 2, battery_pct: 80 }), { tone: 'grey', text: 'Open' });
  // a finished command is not "waiting"
  assert.deepEqual(bootStatus({ state: 0, battery_pct: 80, pending_status: 'done', pending_purpose: 'fit' }), { tone: 'grey', text: 'Closed' });
});

test('bootSubline: what it is doing, and when it last checked in', () => {
  assert.equal(bootSubline({ deployment_status: 'active', plate_text: 'KMD4821', last_report_at: '2026-11-16T14:57:00Z' }, NOW), 'On KMD4821 · checked in 3 min ago');
  assert.equal(bootSubline({ state: 0, stored_at: '2026-11-16T10:00:00Z', last_report_at: null }, NOW), 'In storage · checked in never');
  assert.equal(bootSubline({ state: 1, battery_pct: 12, last_report_at: '2026-11-16T12:00:00Z' }, NOW), 'Charge before use · checked in 3 h ago');
});

test('bootCounts and freeBoots', () => {
  const boots = [
    { id: 'a', label: 'Boot 10', state: 0, battery_pct: 90, online: true },
    { id: 'b', label: 'Boot 2', state: 0, deployment_status: 'active', online: true },
    { id: 'c', label: 'Boot 1', state: 3, online: false },
  ];
  assert.deepEqual(bootCounts(boots), { free: 2, onCars: 1, attention: 1 });
  assert.deepEqual(freeBoots(boots).map((b) => b.label), ['Boot 1', 'Boot 10']);
});

// ── the boot page ──────────────────────────────────────────────────────────
const closed = { boot: { state: 0, battery_pct: 80 }, deployment: null, commands: [] };

test('bootNotices: waiting for payment, paid and opening, pick up, fault, battery', () => {
  const waiting = bootNotices({ boot: { state: 0 }, deployment: { status: 'active', fee_cents: 25000 }, commands: [] });
  assert.deepEqual(waiting.map((n) => n.title), ['Waiting for payment']);
  assert.match(waiting[0].text, /\$250\.00 fee/);

  const paid = bootNotices({
    boot: { state: 0 },
    deployment: { status: 'release_authorized', paid_at: '2026-11-16T14:40:00Z', paid_amount_cents: 25000, property: 'Mayfield' },
    commands: [{ id: 'c1', cmd: 1, status: 'queued', purpose: 'release', created_at: '2026-11-16T14:40:05Z' }],
  });
  assert.equal(paid[0].spin, true);
  assert.match(paid[0].title, /^Releasing sent at /);
  assert.match(paid[0].text, /switches it on/);
  assert.match(paid[1].title, /^Paid \$250\.00 at /);

  assert.equal(bootNotices({ boot: { state: 0 }, deployment: { status: 'release_authorized', release_reason: 'waived' }, commands: [] })[0].title, 'Fee waived');

  const pickup = { boot: { state: 1, stored_at: null }, deployment: { status: 'unlocked', unlocked_at: '2026-11-16T14:50:00Z', property: 'Mayfield' }, commands: [] };
  assert.equal(needsPickup(pickup), true);
  assert.equal(bootNotices(pickup)[0].title, 'Pick up this boot');
  // closed for storage after it came off: nothing to pick up
  assert.equal(needsPickup({ ...pickup, boot: { state: 1, stored_at: '2026-11-16T14:55:00Z' } }), false);

  assert.deepEqual(bootNotices({ boot: { state: 3 }, commands: [] }).map((n) => n.title), ['Boot fault']);
  assert.deepEqual(bootNotices({ boot: { state: 0, battery_pct: 20 }, commands: [] }).map((n) => n.title), ['Battery too low (20%)']);
  assert.deepEqual(bootNotices(closed), []);
});

test('bootActions: what each state offers', () => {
  const acts = (d) => bootActions(d).map((a) => a.act);
  assert.deepEqual(acts(closed), ['place', 'open', 'emergency']);
  assert.deepEqual(acts({ ...closed, boot: { state: 1, battery_pct: 80 } }), ['place', 'store']);
  assert.equal(bootActions({ ...closed, boot: { state: 0, battery_pct: 10 } })[0].disabled, true);
  assert.deepEqual(acts({ boot: { state: 0 }, deployment: { status: 'active' }, commands: [] }), ['waive', 'emergency']);
  assert.deepEqual(acts({ boot: { state: 0 }, deployment: { status: 'release_authorized' }, commands: [] }), ['release', 'emergency']);
  assert.deepEqual(acts({ boot: { state: 1 }, deployment: { status: 'locking' }, commands: [{ cmd: 2, status: 'queued', purpose: 'place' }] }), ['cancel', 'emergency']);
  // a lock the boot already picked up cannot be cancelled
  assert.deepEqual(acts({ boot: { state: 1 }, deployment: { status: 'locking' }, commands: [{ cmd: 2, status: 'delivered', purpose: 'place' }] }), ['emergency']);
  // a released boot left open: close it first
  assert.deepEqual(acts({ boot: { state: 1 }, deployment: { status: 'unlocked', unlocked_at: '2026-11-16T14:50:00Z' }, commands: [] }), ['store', 'place']);
});

// ── waiting for a command ─────────────────────────────────────────────────
test('commandOutcome and outcomeMessage', () => {
  const d = (status, extra = {}) => ({ commands: [{ id: 'c1', status, ...extra }] });
  assert.deepEqual(commandOutcome(d('queued'), 'c1'), { state: 'waiting', delivered: false });
  assert.deepEqual(commandOutcome(d('delivered'), 'c1'), { state: 'waiting', delivered: true });
  assert.equal(commandOutcome(d('done'), 'c1').state, 'done');
  assert.equal(commandOutcome(d('expired'), 'c1').state, 'expired');
  assert.equal(commandOutcome({ commands: [] }, 'c1').state, 'done');
  assert.equal(outcomeMessage('place', { state: 'done' }).text, 'Locked.');
  assert.equal(outcomeMessage('fit', { state: 'done' }).text, 'Opened.');
  assert.match(outcomeMessage('store', { state: 'expired' }).text, /expired/);
  assert.match(outcomeMessage('fit', { state: 'failed' }).text, /problem/);
});

// ── place a boot ──────────────────────────────────────────────────────────
test('stepMissing: each step names what is still needed', () => {
  const f = newPlacement();
  assert.deepEqual(stepMissing(f, 1, { properties: [] }), ['a property assigned to you (ask LotLogic)']);
  assert.deepEqual(stepMissing(f, 1, { properties: [{ id: 'p1' }] }), ['property']);
  assert.deepEqual(stepMissing({ ...f, property_id: 'p1' }, 1, { properties: [{ id: 'p1' }] }), []);

  assert.deepEqual(stepMissing({ ...f, plate_state: '' }, 2), ['plate', 'plate state']);
  assert.deepEqual(stepMissing({ ...f, plate: 'kmd-4821', plate_state: 'nc' }, 2), []);

  assert.deepEqual(stepMissing(f, 3, {}), ['boot', 'photo of the boot']);
  const g = { ...f, boot_id: 'b1' };
  assert.deepEqual(stepMissing(g, 3, { boot: { state: 0, battery_pct: 80 } }), ['open the boot', 'photo of the boot']);
  assert.deepEqual(stepMissing(g, 3, { boot: { state: 0, battery_pct: 80 }, opening: true }), ['wait for the boot to open', 'photo of the boot']);
  assert.deepEqual(stepMissing(g, 3, { boot: { state: 1, battery_pct: 20 } }), ['a boot with more battery', 'photo of the boot']);
  assert.deepEqual(stepMissing({ ...g, photo_path: 'boot-photos/x/b1/lock-1.jpg' }, 3, { boot: { state: 1, battery_pct: 80 } }), []);

  assert.deepEqual(stepMissing(f, 4), ['your full name', 'signature']);
  assert.deepEqual(stepMissing(signPlacement({ ...f, signed_name: 'Dana Reyes' }, PNG), 4), []);
});

// ── an enforcement pause (boot-portal GET /properties: paused_until per property, pauses_unknown) ──
const PAUSED = { id: 'p1', name: 'Mayfield Memorial Apartments', paused_until: '2026-11-21T23:00:00+00:00' };

test('stepMissing: a paused property cannot be booted at, so step 1 does not go on', () => {
  const f = { ...newPlacement(), property_id: 'p1' };
  assert.deepEqual(stepMissing(f, 1, { properties: [PAUSED] }), ['a property that is not paused']);
  // A list re-read after step 1 found the pause: no step goes on, Lock boot included.
  const signed = signPlacement({ ...f, signed_name: 'Dana Reyes' }, PNG);
  assert.deepEqual(stepMissing(signed, 4, { properties: [PAUSED] }), ['a property that is not paused']);
  assert.deepEqual(stepMissing(signed, 4, { properties: [{ ...PAUSED, paused_until: null }] }), []);
  assert.deepEqual(stepMissing(f, 1, { properties: [{ ...PAUSED, paused_until: null }] }), []);
  // The pauses could not be read: the server decides at Lock boot, so the agent may go on.
  assert.deepEqual(stepMissing(f, 1, { properties: [{ id: 'p1' }], pausesUnknown: true }), []);
  // Another property's pause does not stop this one.
  assert.deepEqual(stepMissing({ ...f, property_id: 'p2' }, 1, { properties: [PAUSED, { id: 'p2', paused_until: null }] }), []);
});

test('bootPauseNotice: blue "do not boot" for a paused property, a neutral line when unknown, nothing otherwise', () => {
  assert.deepEqual(bootPauseNotice(PAUSED, false, NOW), { kind: 'paused', text: 'Enforcement is paused here until Sat 6:00 PM — do not boot' });
  assert.deepEqual(bootPauseNotice({ id: 'p1' }, true, NOW), { kind: 'unknown', text: 'Could not check for a pause' });
  assert.equal(bootPauseNotice({ ...PAUSED, paused_until: null }, false, NOW), null);
  assert.equal(bootPauseNotice({ id: 'p1' }, false, NOW), null);   // a server before the pause: no field, no line
  assert.equal(bootPauseNotice(null, true, NOW), null);             // nothing picked yet
  // A pause further out than the week names its date.
  assert.equal(bootPauseNotice({ id: 'p1', paused_until: '2026-11-24T23:00:00+00:00' }, false, NOW).text,
    'Enforcement is paused here until Tue Nov 24, 6:00 PM — do not boot');
});

test('signature: any edit after signing clears it; an unchanged value or the step does not', () => {
  const signed = signPlacement({ ...newPlacement('b1'), plate: 'KMD4821', signed_name: 'Dana Reyes' }, PNG, '2026-11-16T15:00:00Z');
  assert.equal(signed.signature, PNG);
  for (const [k, v] of [['plate', 'KMD4822'], ['plate_state', 'SC'], ['color', 'Red'], ['spot', 'Row 2'], ['notes', 'x'],
    ['property_id', 'p2'], ['boot_id', 'b2'], ['photo_path', 'boot-photos/new.jpg'], ['signed_name', 'Dana R']]) {
    const e = editPlacement(signed, k, v);
    assert.equal(e.signature, null, `${k} should clear the signature`);
    assert.equal(e.resign, true);
  }
  assert.equal(editPlacement(signed, 'plate', 'KMD4821').signature, PNG);   // same value
  assert.equal(editPlacement(signed, 'step', 3).signature, PNG);            // moving between steps
  // a new boot needs a new photo of that boot
  const moved = editPlacement({ ...signed, photo_path: 'p.jpg', photo_preview: 'blob:x' }, 'boot_id', 'b2');
  assert.equal(moved.photo_path, '');
  assert.equal(moved.photo_preview, '');
  // signing again clears the "sign again" hint
  assert.equal(signPlacement(editPlacement(signed, 'plate', 'X1'), PNG).resign, false);
});

test('attestation: the sentence boot-portal writes, Charlotte time', () => {
  assert.equal(
    attestation('Dana Reyes', 'Boot 02', 'kmd 4821', 'nc', '2026-11-16T15:04:05Z'),
    'I, Dana Reyes, placed boot “Boot 02” on the vehicle with plate KMD4821 (NC) on 11/16/2026, 10:04:05 AM. The plate, photo and location I submitted are accurate.',
  );
  assert.match(attestation('', '', '', ''), /^I, \[your name\], placed boot “\[boot\]” on the vehicle with plate \[plate\] on /);
});

test('lockBody: the POST /lock fields, location carried in notes', () => {
  const f = { ...newPlacement('b1'), property_id: 'p1', plate: 'kmd-4821', plate_state: 'nc', make: 'Nissan', model: 'Altima', color: '',
    spot: 'Building C, row 2', notes: 'Hazards on', photo_path: 'boot-photos/x/b1/lock-1.jpg', signed_name: ' Dana Reyes ' };
  assert.deepEqual(lockBody(f, 'boot-photos/x/b1/sig-1.png', { lat: 35.2, lon: -80.8, accuracy_m: 12 }), {
    boot_id: 'b1', plate_text: 'KMD4821', plate_state: 'NC', property_id: 'p1', photo_path: 'boot-photos/x/b1/lock-1.jpg',
    signature_path: 'boot-photos/x/b1/sig-1.png', signed_name: 'Dana Reyes', vehicle_make: 'Nissan', vehicle_model: 'Altima',
    vehicle_color: undefined, notes: 'Location: Building C, row 2\nHazards on', lat: 35.2, lon: -80.8, accuracy_m: 12,
  });
  assert.equal(placementNotes({ spot: ' ', notes: '' }), undefined);
});

test('small helpers', () => {
  assert.equal(normPlate(' abc-123 '), 'ABC123');
  assert.equal(esc('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  assert.equal(initials('Dana Reyes'), 'DR');
  assert.equal(initials(''), '?');
  assert.equal(ago(null, NOW), 'never');
  assert.equal(emergencyReady({ reason: 'medical', explanation: 'x'.repeat(19) }), false);
  assert.equal(emergencyReady({ reason: 'medical', explanation: 'x'.repeat(20) }), true);
});
