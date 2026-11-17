// Tests for frontend/src/lib/pause.js - the enforcement pause, pure half
// (spec 2026-11-16 Part 3, plan Task 11). Every time here is read in
// Charlotte (America/New_York), whatever zone the machine running the tests
// is in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HOURS, REASON_MAX, etWallToMs, fromInputValue, toInputValue, pausePresets, validatePause, cleanReason,
  pauseBody, pauseErrorText, pauseSummary, pauseBanner, pauseBanners, pauseLine, fmtPauseTime, durationText, withPauses,
  towPauseNote, clashingPause, clashText, isSamePause, lotStatusPause, customWindow, quarterFloor, fmtFull,
  openBeforeText, lotPauseNote,
} from '../src/lib/pause.js';

const HOUR = 3600_000;
const MIN = 60_000;
const at = (iso) => Date.parse(iso);

// Fri Nov 20 2026, 2:00 PM in Charlotte (EST, UTC-5).
const FRI_2PM = at('2026-11-20T19:00:00Z');
// Sun Nov 22 2026, 11:00 PM in Charlotte.
const SUN_11PM = at('2026-11-23T04:00:00Z');

const byId = (list) => Object.fromEntries(list.map(p => [p.id, p]));

test('etWallToMs reads a wall-clock time in Charlotte, either side of a DST change', () => {
  assert.equal(new Date(etWallToMs(2026, 11, 20, 18, 0)).toISOString(), '2026-11-20T23:00:00.000Z');   // EST
  assert.equal(new Date(etWallToMs(2026, 10, 31, 18, 0)).toISOString(), '2026-10-31T22:00:00.000Z');   // EDT
  assert.equal(new Date(etWallToMs(2026, 11, 1, 7, 0)).toISOString(), '2026-11-01T12:00:00.000Z');     // EST again
  assert.equal(new Date(etWallToMs(2027, 3, 14, 7, 0)).toISOString(), '2027-03-14T11:00:00.000Z');     // EDT again
});

test('presets on a Friday at 2 PM: Tonight, Next 24 hours, This weekend, with exact times', () => {
  const list = pausePresets(FRI_2PM);
  assert.deepEqual(list.map(p => p.id), ['tonight', '24h', 'weekend']);
  assert.deepEqual(list.map(p => p.label), ['Tonight', 'Next 24 hours', 'This weekend']);
  const p = byId(list);
  assert.equal(p.tonight.starts_at, '2026-11-20T23:00:00.000Z');   // Fri 6:00 PM
  assert.equal(p.tonight.ends_at, '2026-11-21T12:00:00.000Z');     // Sat 7:00 AM
  assert.equal(p.tonight.startsNow, false);
  assert.equal(p['24h'].starts_at, '2026-11-20T19:00:00.000Z');
  assert.equal(p['24h'].ends_at, '2026-11-21T19:00:00.000Z');
  assert.equal(p['24h'].startsNow, true);
  assert.equal(p.weekend.starts_at, '2026-11-20T23:00:00.000Z');   // Fri 6:00 PM
  assert.equal(p.weekend.ends_at, '2026-11-23T04:59:00.000Z');     // Sun 11:59 PM
  assert.equal(p.weekend.startsNow, false);
  // Each says its window in a few words.
  assert.equal(p.tonight.hint, '6:00 PM – 7:00 AM');
  assert.equal(p['24h'].hint, 'Until Sat 2:00 PM');
  assert.equal(p.weekend.hint, 'Fri 6:00 PM – Sun 11:59 PM');
});

test('on a Monday the weekend preset is the coming Friday to Sunday', () => {
  const p = byId(pausePresets(at('2026-11-16T19:30:00Z')));       // Mon 2:30 PM
  assert.equal(p.weekend.starts_at, '2026-11-20T23:00:00.000Z');
  assert.equal(p.weekend.ends_at, '2026-11-23T04:59:00.000Z');
  assert.equal(p.tonight.starts_at, '2026-11-16T23:00:00.000Z');
  assert.equal(p.tonight.ends_at, '2026-11-17T12:00:00.000Z');
});

test('during the weekend it starts now; on a Sunday at 11 PM it is gone, and Tonight starts now', () => {
  const sat = byId(pausePresets(at('2026-11-21T17:00:00Z')));     // Sat noon
  assert.equal(sat.weekend.startsNow, true);
  assert.equal(sat.weekend.starts_at, '2026-11-21T17:00:00.000Z');
  assert.equal(sat.weekend.ends_at, '2026-11-23T04:59:00.000Z');
  assert.equal(sat.weekend.hint, 'Now – Sun 11:59 PM');

  const list = pausePresets(SUN_11PM);
  assert.deepEqual(list.map(p => p.id), ['tonight', '24h']);
  const p = byId(list);
  assert.equal(p.tonight.startsNow, true);
  assert.equal(p.tonight.ends_at, '2026-11-23T12:00:00.000Z');     // Mon 7:00 AM
  assert.equal(p.tonight.hint, 'Now – 7:00 AM');
});

test('after midnight, Tonight is the rest of this night (now to 7 AM)', () => {
  const p = byId(pausePresets(at('2026-11-18T07:30:00Z')));       // Wed 2:30 AM
  assert.equal(p.tonight.startsNow, true);
  assert.equal(p.tonight.ends_at, '2026-11-18T12:00:00.000Z');
});

test('presets across the DST change still give 6 PM and 7 AM in Charlotte', () => {
  // Sat Oct 31 2026 2 PM EDT; the clocks go back at 2 AM Sunday.
  const fall = byId(pausePresets(at('2026-10-31T18:00:00Z')));
  assert.equal(fall.tonight.starts_at, '2026-10-31T22:00:00.000Z'); // 6 PM EDT
  assert.equal(fall.tonight.ends_at, '2026-11-01T12:00:00.000Z');   // 7 AM EST: 14 real hours
  // Fri Oct 30 2 PM EDT: Fri 6 PM EDT to Sun 11:59 PM EST is 55 real hours, under 72.
  const fri = byId(pausePresets(at('2026-10-30T18:00:00Z')));
  assert.equal(fri.weekend.starts_at, '2026-10-30T22:00:00.000Z');
  assert.equal(fri.weekend.ends_at, '2026-11-02T04:59:00.000Z');
  assert.equal(validatePause({ starts_at: fri.weekend.starts_at, ends_at: fri.weekend.ends_at, now: at('2026-10-30T18:00:00Z') }), null);
  // Sat Mar 13 2027 2 PM EST; the clocks go forward at 2 AM Sunday.
  const spring = byId(pausePresets(at('2027-03-13T19:00:00Z')));
  assert.equal(spring.tonight.starts_at, '2027-03-13T23:00:00.000Z'); // 6 PM EST
  assert.equal(spring.tonight.ends_at, '2027-03-14T11:00:00.000Z');   // 7 AM EDT: 12 real hours
});

test('validatePause: 72 hours is fine, 72 hours and a minute is too long', () => {
  const s = FRI_2PM + HOUR;
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(MAX_HOURS, 72);
  assert.equal(validatePause({ starts_at: iso(s), ends_at: iso(s + 72 * HOUR), now: FRI_2PM }), null);
  assert.equal(validatePause({ starts_at: iso(s), ends_at: iso(s + 72 * HOUR + MIN), now: FRI_2PM }), 'too_long');
  assert.equal(validatePause({ starts_at: iso(s), ends_at: iso(s), now: FRI_2PM }), 'ends_before_start');
  assert.equal(validatePause({ starts_at: iso(s), ends_at: iso(s - MIN), now: FRI_2PM }), 'ends_before_start');
  assert.equal(validatePause({ starts_at: iso(FRI_2PM - 6 * MIN), ends_at: iso(s), now: FRI_2PM }), 'starts_in_past');
  assert.equal(validatePause({ starts_at: iso(FRI_2PM - 4 * MIN), ends_at: iso(s), now: FRI_2PM }), null);
  assert.equal(validatePause({ starts_at: iso(FRI_2PM + 31 * 24 * HOUR), ends_at: iso(FRI_2PM + 32 * 24 * HOUR), now: FRI_2PM }), 'too_far_ahead');
  // "Now" (null) is measured from now.
  assert.equal(validatePause({ starts_at: null, ends_at: iso(FRI_2PM + 72 * HOUR), now: FRI_2PM }), null);
  assert.equal(validatePause({ starts_at: null, ends_at: iso(FRI_2PM + 73 * HOUR), now: FRI_2PM }), 'too_long');
  assert.equal(validatePause({ starts_at: iso(s), ends_at: '', now: FRI_2PM }), 'missing');
});

test('the office copy for each refusal; 72 hours stated plainly', () => {
  assert.equal(pauseErrorText('too_long'), 'A pause can be at most 72 hours.');
  assert.equal(pauseErrorText('ends_before_start'), 'The end has to be after the start.');
  // earliest_start is itself allowed (contract C), so "from"; said with its date, without " ET", like every pause time.
  assert.equal(pauseErrorText('overlaps', { earliest_start: '2026-11-23T23:00:00+00:00', earliest_start_local: 'Mon Nov 23, 6:00 PM ET' }),
    'There is already a pause then. You can pause again from Mon Nov 23, 6:00 PM.');
  assert.equal(pauseErrorText('overlaps', { earliest_start_local: 'Mon Nov 23, 6:00 PM ET' }),
    'There is already a pause then. You can pause again from Mon Nov 23, 6:00 PM.');
  assert.equal(pauseErrorText('overlaps', {}), 'There is already a pause then.');
  assert.match(pauseErrorText('too_many_scheduled'), /3 pauses/);
  assert.match(pauseErrorText('reason_too_long'), /120/);
  assert.match(pauseErrorText('not_enabled'), /LotLogic/);
  assert.match(pauseErrorText('pause_not_found'), /refresh/i);
  assert.ok(pauseErrorText('something_new'));
});

test('cleanReason collapses spaces; pauseBody sends null for a start of "now" and for no reason', () => {
  assert.equal(REASON_MAX, 120);
  assert.equal(cleanReason('  Pool   party \n'), 'Pool party');
  assert.equal(cleanReason('   '), '');
  const p = byId(pausePresets(FRI_2PM));
  assert.deepEqual(pauseBody(p['24h'], ''), { starts_at: null, ends_at: '2026-11-21T19:00:00.000Z', reason: null });
  assert.deepEqual(pauseBody(p.tonight, ' Pool party '), { starts_at: '2026-11-20T23:00:00.000Z', ends_at: '2026-11-21T12:00:00.000Z', reason: 'Pool party' });
});

test('custom times are typed in Charlotte time', () => {
  assert.equal(toInputValue(at('2026-11-20T23:00:00Z')), '2026-11-20T18:00');
  assert.equal(new Date(fromInputValue('2026-11-20T18:00')).toISOString(), '2026-11-20T23:00:00.000Z');
  assert.equal(new Date(fromInputValue('2026-07-04T21:30')).toISOString(), '2026-07-05T01:30:00.000Z');
  assert.ok(Number.isNaN(fromInputValue('')));
});

test('fmtPauseTime: a weekday within the week, the date further out', () => {
  assert.equal(fmtPauseTime('2026-11-21T23:00:00+00:00', FRI_2PM), 'Sat 6:00 PM');
  assert.equal(fmtPauseTime('2026-11-23T04:59:00+00:00', FRI_2PM), 'Sun 11:59 PM');
  assert.equal(fmtPauseTime('2026-12-04T23:00:00+00:00', FRI_2PM), 'Fri Dec 4, 6:00 PM');
  assert.equal(fmtPauseTime('', FRI_2PM), '');
  // Monday afternoon to the coming Sunday night: still one week, so the weekday.
  assert.equal(fmtPauseTime('2026-11-23T04:59:00+00:00', at('2026-11-16T19:30:00Z')), 'Sun 11:59 PM');
  assert.equal(fmtPauseTime('2026-11-23T23:00:00+00:00', at('2026-11-16T19:30:00Z')), 'Mon Nov 23, 6:00 PM');
  // Earlier than today: the date, never a weekday that could be next week's.
  assert.equal(fmtPauseTime('2026-11-19T23:00:00+00:00', FRI_2PM), 'Thu Nov 19, 6:00 PM');
});

test('durationText', () => {
  assert.equal(durationText(13 * HOUR), '13 hours');
  assert.equal(durationText(HOUR), '1 hour');
  assert.equal(durationText(53 * HOUR + 59 * MIN), '54 hours');
  assert.equal(durationText(90 * MIN), '1 hour 30 minutes');
  assert.equal(durationText(45 * MIN), '45 minutes');
});

test('pauseSummary says when it starts and when enforcement resumes', () => {
  const p = byId(pausePresets(FRI_2PM));
  assert.deepEqual(pauseSummary(p.tonight, FRI_2PM), {
    when: 'Fri 6:00 PM – Sat 7:00 AM',
    length: '13 hours',
    resumes: 'Enforcement resumes Sat Nov 21, 7:00 AM',
  });
  assert.equal(pauseSummary(p['24h'], FRI_2PM).when, 'Now – Sat 2:00 PM');
  assert.equal(pauseSummary(p['24h'], FRI_2PM).length, '24 hours');
});

const ACTIVE = {
  id: 'p1', property_id: 'v', property_name: 'The Volaire', status: 'active',
  starts_at: '2026-11-20T18:00:00+00:00', ends_at: '2026-11-21T23:00:00+00:00', planned_ends_at: '2026-11-21T23:00:00+00:00',
  starts_local: 'Fri Nov 20, 1:00 PM ET', ends_local: 'Sat Nov 21, 6:00 PM ET', reason: 'Pool party',
};
const SCHEDULED = {
  id: 'p2', property_id: 'v', property_name: 'The Volaire', status: 'scheduled',
  starts_at: '2026-11-27T23:00:00+00:00', ends_at: '2026-11-30T04:59:00+00:00', planned_ends_at: '2026-11-30T04:59:00+00:00',
  starts_local: 'Fri Nov 27, 6:00 PM ET', ends_local: 'Sun Nov 29, 11:59 PM ET', reason: null,
};

test('pauseBanner: active reads "paused until" with the reason, and can be ended', () => {
  assert.deepEqual(pauseBanner([ACTIVE], FRI_2PM), {
    text: 'Enforcement paused until Sat 6:00 PM · Pool party', pauseId: 'p1', canEnd: true,
  });
  assert.equal(pauseBanner([{ ...ACTIVE, reason: null }], FRI_2PM).text, 'Enforcement paused until Sat 6:00 PM');
  assert.equal(pauseBanner([], FRI_2PM), null);
  assert.equal(pauseBanner(null, FRI_2PM), null);
});

test('pauseBanner: scheduled reads the window, and can be cancelled', () => {
  const now = at('2026-11-24T19:00:00Z');                           // Tue
  assert.deepEqual(pauseBanner([SCHEDULED], now), {
    // A scheduled start always has its date (brainstorm 2.11); the end is said from that start.
    text: 'Enforcement pause scheduled Fri Nov 27, 6:00 PM – Sun 11:59 PM', pauseId: 'p2', canEnd: false,
  });
});

test('pauseBanners: the active one first, then the scheduled; status comes from the server, an ended one is dropped', () => {
  const list = pauseBanners([SCHEDULED, ACTIVE], FRI_2PM);
  assert.deepEqual(list.map(b => [b.pauseId, b.kind, b.action]), [['p1', 'active', 'end'], ['p2', 'scheduled', 'cancel']]);
  assert.equal(list[0].title, 'Enforcement paused until Sat 6:00 PM');
  assert.equal(list[0].reason, 'Pool party');
  assert.equal(list[1].title, 'Enforcement pause scheduled Fri Nov 27, 6:00 PM – Sun 11:59 PM');
  // Not this device's clock: a phone hours fast still shows the pause the server says is running
  // (the page re-reads every minute, and the server drops a pause that is over).
  assert.deepEqual(pauseBanners([ACTIVE], at('2026-11-21T23:00:00Z')).map(b => b.kind), ['active']);
  // Ended and cancelled rows never make a banner.
  assert.deepEqual(pauseBanners([{ ...ACTIVE, status: 'ended' }, { ...SCHEDULED, status: 'cancelled' }], FRI_2PM), []);
});

test('pauseLine: the tow company\'s one line for a property', () => {
  assert.equal(pauseLine(ACTIVE, FRI_2PM), 'Enforcement paused until Sat 6:00 PM · Pool party');
  assert.equal(pauseLine(SCHEDULED, at('2026-11-24T19:00:00Z')), 'Enforcement pause scheduled Fri Nov 27, 6:00 PM – Sun 11:59 PM');
});

test('no word for the pass but "parking pass", and no money', () => {
  const BANNED = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b|\$/i;
  const texts = [
    ...['too_long', 'ends_before_start', 'starts_in_past', 'too_far_ahead', 'too_many_scheduled', 'overlaps', 'not_enabled',
      'not_apartment', 'reason_too_long', 'not_started', 'already_ended', 'already_cancelled', 'already_started', 'pause_not_found', 'missing']
      .map(c => pauseErrorText(c)),
    ...pausePresets(FRI_2PM).flatMap(p => [p.label, p.hint]),
    towPauseNote({ kind: 'tow', created_at: '2026-11-20T18:30:00Z' }, ACTIVE),
    towPauseNote({ kind: 'tow', created_at: '2026-11-20T17:00:00Z' }, ACTIVE),
    clashText(SCHEDULED), clashText(ACTIVE),
    lotStatusPause(ACTIVE, FRI_2PM).title,
    lotStatusPause({ ...ACTIVE, open_before_pause_count: 2 }, FRI_2PM).title,
    openBeforeText(1), openBeforeText(2),
    lotPauseNote('placed_before_pause'), lotPauseNote('during_pause'), lotPauseNote('flagged_before_pause'),
  ];
  for (const t of texts) assert.doesNotMatch(t, BANNED, t);
});

test('withPauses: each property\'s pause lines go on its group; a paused property with no request gets its own group first', () => {
  const groups = [
    { propertyId: 'm', propertyName: 'Mayfield', propertyVerified: true, count: 1, items: [{ id: 'r1' }] },
    { propertyId: 'v', propertyName: 'The Volaire', propertyVerified: true, count: 2, items: [{ id: 'r2' }, { id: 'r3' }] },
  ];
  const fort = { ...SCHEDULED, id: 'p3', property_id: 'f', property_name: 'Fort Mill Townhomes II', starts_at: '2026-11-21T23:00:00+00:00', ends_at: '2026-11-22T12:00:00+00:00' };
  const out = withPauses(groups, [SCHEDULED, ACTIVE, fort, { ...ACTIVE, id: 'gone', status: 'ended' }], FRI_2PM);
  assert.deepEqual(out.map(g => g.propertyId), ['f', 'm', 'v']);
  assert.deepEqual(out[0].items, []);
  assert.equal(out[0].count, 0);
  assert.deepEqual(out[0].pauses.map(p => p.text), ['Enforcement pause scheduled Sat Nov 21, 6:00 PM – Sun 7:00 AM']);
  assert.deepEqual(out[1].pauses, []);
  assert.deepEqual(out[2].pauses.map(p => p.kind), ['active', 'scheduled']);
  // No pauses: the groups as they were, each with an empty list.
  assert.deepEqual(withPauses(groups, null, FRI_2PM).map(g => g.pauses.length), [0, 0]);
});

test('withPauses: a tow request in a paused property\'s group says whether it stands', () => {
  // ACTIVE started Fri 1:00 PM (18:00Z).
  const items = [
    { id: 'during', kind: 'tow', created_at: '2026-11-20T18:30:00+00:00' },
    { id: 'before', kind: 'tow', created_at: '2026-11-20T17:00:00+00:00' },
    { id: 'hold', kind: 'hold', created_at: '2026-11-20T18:30:00+00:00' },
  ];
  const groups = [{ propertyId: 'v', propertyName: 'The Volaire', propertyVerified: true, count: 3, items }];
  const [g] = withPauses(groups, [ACTIVE], FRI_2PM);
  assert.deepEqual(g.notes, {
    during: 'Requested by the office during the pause',
    // Gabe 2026-11-17: a pause holds only new enforcement. A request placed before it still goes ahead.
    before: 'Placed before the pause — still stands',
  });
  for (const t of Object.values(g.notes)) assert.doesNotMatch(t, /wait until/i, t);
  // Only a running pause: a scheduled one changes nothing yet.
  assert.deepEqual(withPauses(groups, [SCHEDULED], FRI_2PM)[0].notes, {});
  assert.deepEqual(withPauses(groups, null, FRI_2PM)[0].notes, {});
  assert.equal(towPauseNote({ kind: 'photo', created_at: '2026-11-20T18:30:00+00:00' }, ACTIVE), '');
});

test('Tonight in the last half hour before 7 AM is this evening\'s, not a few minutes', () => {
  // Tue Nov 17 2026, 6:59:40 AM in Charlotte.
  const late = byId(pausePresets(at('2026-11-17T11:59:40Z')));
  assert.equal(late.tonight.startsNow, false);
  assert.equal(late.tonight.starts_at, '2026-11-17T23:00:00.000Z');
  assert.equal(late.tonight.ends_at, '2026-11-18T12:00:00.000Z');
  assert.equal(late.tonight.hint, '6:00 PM – 7:00 AM');
  // 6:20 AM: still the rest of this night.
  const early = byId(pausePresets(at('2026-11-17T11:20:00Z')));
  assert.equal(early.tonight.startsNow, true);
  assert.equal(early.tonight.ends_at, '2026-11-17T12:00:00.000Z');
});

test('customWindow: a start a moment ago is now; one further back is said to have passed', () => {
  const now = at('2026-11-17T19:07:00Z');                      // Tue 2:07 PM
  const justNow = customWindow('2026-11-17T14:05', '2026-11-17T20:00', now);
  assert.equal(justNow.startsNow, true);
  assert.equal(validatePause({ ...justNow, now }), null);
  const passed = customWindow('2026-11-17T13:00', '2026-11-17T20:00', now);
  assert.equal(passed.startsNow, false);
  assert.equal(validatePause({ ...passed, now }), 'starts_in_past');
  const yesterday = customWindow('2026-11-16T20:00', '2026-11-17T20:00', now);
  assert.equal(validatePause({ ...yesterday, now }), 'starts_in_past');
  assert.equal(customWindow('', '', now).starts_at, '');
});

test('quarterFloor keeps the picker\'s step on :00, :15, :30 and :45', () => {
  assert.equal(toInputValue(quarterFloor(at('2026-11-17T19:07:30Z'))), '2026-11-17T14:00');
  assert.equal(toInputValue(quarterFloor(at('2026-11-17T19:22:00Z'))), '2026-11-17T14:15');
});

test('clashingPause: a window within a day of another pause, either side, before Save', () => {
  const now = at('2026-11-16T19:30:00Z');                      // Mon 2:30 PM
  const weekend = { id: 'w', status: 'scheduled', starts_at: '2026-11-20T23:00:00+00:00', ends_at: '2026-11-23T04:59:00+00:00' };
  const p = byId(pausePresets(now));
  assert.equal(clashingPause(p.weekend, [weekend], now), weekend);
  assert.equal(clashingPause(p.tonight, [weekend], now), null);          // Mon night ends Tue 7 AM, days before Fri
  // Ends 23 h before the weekend starts: refused; 24 h before: fine.
  const before = (h) => ({ startsNow: false, starts_at: '2026-11-18T23:00:00.000Z', ends_at: new Date(Date.parse(weekend.starts_at) - h * 3600_000).toISOString() });
  assert.equal(clashingPause(before(23), [weekend], now), weekend);
  assert.equal(clashingPause(before(24), [weekend], now), null);
  // Starts 24 h after it ends: fine; a minute sooner: refused.
  const after = (m) => ({ startsNow: false, starts_at: new Date(Date.parse(weekend.ends_at) + 24 * 3600_000 - m * 60_000).toISOString(), ends_at: '2026-11-25T12:00:00.000Z' });
  assert.equal(clashingPause(after(0), [weekend], now), null);
  assert.equal(clashingPause(after(1), [weekend], now), weekend);
  // Ended and cancelled pauses are not in the way.
  assert.equal(clashingPause(p.weekend, [{ ...weekend, status: 'cancelled' }], now), null);
  assert.equal(clashText(weekend), 'Too close to the pause on Fri Nov 20');
  assert.equal(clashText({ ...ACTIVE }), 'Too close to the pause running now');
});

test('isSamePause: a refused or lost Save whose pause is the one asked for', () => {
  const body = { starts_at: null, ends_at: '2026-11-17T19:30:00.000Z', reason: null };
  const mine = { ...ACTIVE, status: 'active', ends_at: '2026-11-17T19:30:00+00:00', planned_ends_at: '2026-11-17T19:30:00+00:00' };
  assert.equal(isSamePause(mine, body), true);
  assert.equal(isSamePause({ ...mine, planned_ends_at: '2026-11-17T20:30:00+00:00' }, body), false);
  assert.equal(isSamePause(null, body), false);
});

test('lotStatusPause: the Lot status tab\'s DO NOT TOW line', () => {
  const pause = { id: 'p', starts_at: '2026-11-20T18:00:00+00:00', ends_at: '2026-11-21T23:00:00+00:00', ends_local: 'Sat Nov 21, 6:00 PM ET', reason: ' Pool  party ' };
  assert.deepEqual(lotStatusPause(pause, FRI_2PM), { title: 'DO NOT TOW — enforcement paused until Sat 6:00 PM', reason: 'Pool party' });
  assert.equal(lotStatusPause({ ...pause, ends_at: null, reason: null }, FRI_2PM).title, 'DO NOT TOW — enforcement paused until Sat Nov 21, 6:00 PM');
  assert.equal(lotStatusPause(null, FRI_2PM), null);
  // Something was already in motion before the pause (contract C `open_before_pause_count`): that still goes ahead.
  assert.deepEqual(lotStatusPause({ ...pause, open_before_pause_count: 2 }, FRI_2PM),
    { title: 'Enforcement paused until Sat 6:00 PM — requests placed before the pause still stand', reason: 'Pool party' });
  assert.equal(lotStatusPause({ ...pause, open_before_pause_count: 0 }, FRI_2PM).title, 'DO NOT TOW — enforcement paused until Sat 6:00 PM');
});

test('lotPauseNote: why a towable car is listed during a pause', () => {
  assert.equal(lotPauseNote('placed_before_pause'), 'Placed before the pause — still stands');
  assert.equal(lotPauseNote('during_pause'), 'Requested by the office during the pause');
  assert.equal(lotPauseNote('flagged_before_pause'), 'Tow notice sent before the pause — still stands');
  assert.equal(lotPauseNote(null), '');
  assert.equal(lotPauseNote('something_new'), '');
});

test('openBeforeText: the pause sheet says what already in motion still goes ahead', () => {
  assert.equal(openBeforeText(0), '');
  assert.equal(openBeforeText(null), '');
  assert.equal(openBeforeText(undefined), '');
  assert.equal(openBeforeText(-1), '');
  assert.equal(openBeforeText(1), '1 open tow request or tow notice from before will still go ahead.');
  assert.equal(openBeforeText(2), '2 open tow requests and tow notices from before will still go ahead.');
});

test('fmtFull: the date, always', () => {
  assert.equal(fmtFull('2026-11-21T23:00:00+00:00'), 'Sat Nov 21, 6:00 PM');
  assert.equal(fmtFull(''), '');
});
