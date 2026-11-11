// Tests for frontend/src/lib/passes.js - the manager's home screen, pure half.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTER_WINDOW_MINUTES, isDispatched, passesSummary, registerMinutesLeft, residentStatus, splitPresence, visitorStatus,
} from '../src/lib/passes.js';

const resident = (over = {}) => ({ plate: 'RES111', minutes_here: 120, state: 'resident', entry_photo_url: 'https://r2/a.jpg',
  pass: { kind: 'long_term', status: 'approved', unit: '12', name: 'Pat Example' }, ...over });
const visitorPass = (over = {}) => ({ plate: 'VIS222', minutes_here: 30, state: 'registered',
  pass: { kind: 'short_term', status: 'active', unit: '7', name: 'Sam Guest', minutes_left: 130 }, ...over });
const unknown = (over = {}) => ({ plate: 'UNK333', minutes_here: 4, state: 'grace', pass: null, ...over });

test('splitPresence: approved long-term passes left, everyone else right, newest arrival first on the right', () => {
  const { residents, visitors } = splitPresence([unknown({ minutes_here: 9 }), resident(), visitorPass(), unknown(), resident({ plate: 'RES000', pass: { kind: 'long_term', status: 'approved', name: 'Al' } })]);
  assert.deepEqual(residents.map(r => r.plate), ['RES000', 'RES111']);
  assert.deepEqual(visitors.map(r => r.plate), ['UNK333', 'UNK333', 'VIS222']);
  assert.deepEqual(visitors.map(r => r.minutes_here), [4, 9, 30]);
  assert.deepEqual(splitPresence(null), { residents: [], visitors: [] });
});

test('a pending long-term registration is a visitor, not a resident', () => {
  const { residents, visitors } = splitPresence([resident({ pass: { kind: 'long_term', status: 'pending', name: 'New' } })]);
  assert.equal(residents.length, 0);
  assert.equal(visitors.length, 1);
  assert.deepEqual(visitorStatus(visitors[0]), { tone: 'info', text: 'Under review', flag: false });
});

test('visitorStatus: the 15-minute countdown, then Not registered', () => {
  assert.equal(REGISTER_WINDOW_MINUTES, 15);
  assert.deepEqual(visitorStatus(unknown({ minutes_here: 4 })), { tone: 'info', text: '11 m to register', flag: false });
  assert.ok(registerMinutesLeft(unknown({ minutes_here: 14.4 })) > 0);
  assert.equal(registerMinutesLeft(unknown({ minutes_here: 40 })), 0);
  assert.deepEqual(visitorStatus(unknown({ minutes_here: 15 })), { tone: 'red', text: 'Not registered', flag: true });
  assert.deepEqual(visitorStatus(unknown({ minutes_here: 40 })), { tone: 'red', text: 'Not registered', flag: true });
});

test('visitorStatus: a short-term pass shows time left, red inside the last hour, red when ended', () => {
  assert.deepEqual(visitorStatus(visitorPass()), { tone: 'green', text: '2h 10m left', flag: false });
  assert.deepEqual(visitorStatus(visitorPass({ pass: { kind: 'short_term', status: 'active', minutes_left: 20 } })), { tone: 'red', text: '20m left', flag: false });
  assert.deepEqual(visitorStatus(visitorPass({ pass: { kind: 'short_term', status: 'active', minutes_left: 0 } })), { tone: 'red', text: 'Pass ended · still here', flag: true });
  assert.deepEqual(visitorStatus(visitorPass({ pass: { kind: 'short_term', status: 'active' } })), { tone: 'green', text: 'Short-term', flag: false });
});

test('Dispatched wins over everything, on either side', () => {
  assert.equal(isDispatched(unknown({ state: 'expired' })), true);
  assert.equal(isDispatched(unknown({ violation_id: 'v1' })), true);
  assert.equal(isDispatched(unknown({ dispatched: true })), true);
  assert.equal(isDispatched(unknown()), false);
  assert.deepEqual(visitorStatus(unknown({ state: 'expired' })), { tone: 'red', text: 'Dispatched', flag: true });
  assert.deepEqual(residentStatus(resident({ violation_id: 'v2' })), { tone: 'red', text: 'Dispatched', flag: true });
  assert.deepEqual(residentStatus(resident()), { tone: 'info', text: 'Resident', flag: false });
});

test('passesSummary counts residents, visitors, flagged and registering', () => {
  const split = splitPresence([resident(), visitorPass(), unknown({ minutes_here: 3 }), unknown({ minutes_here: 20 }), unknown({ state: 'expired', minutes_here: 2 })]);
  assert.deepEqual(passesSummary(split), { residents: 1, visitors: 4, flagged: 2, registering: 1 });
  assert.deepEqual(passesSummary(null), { residents: 0, visitors: 0, flagged: 0, registering: 0 });
});
