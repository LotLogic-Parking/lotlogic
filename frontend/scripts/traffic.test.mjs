// Tests for frontend/src/lib/traffic.js - the pure half of the Traffic tab
// (manager-dashboard-build-plan F5 over the B2 payload).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_OPTIONS,
  DEFAULT_DAYS,
  WEEKDAYS,
  busiestLine,
  clampDays,
  counters,
  emptyLine,
  fmtMinutes,
  heatGrid,
  hourBars,
  hourLabel,
  hourTick,
  pickSeries,
  rangeLine,
  seriesLabel,
  sourceLine,
} from '../src/lib/traffic.js';

const hours = (over = {}) => { const a = new Array(24).fill(0); for (const [h, n] of Object.entries(over)) a[Number(h)] = n; return a; };

// A B2 payload written out by hand, for a property with a camera.
const CAMERA = {
  property_id: 'p1', as_of: '2026-11-07T16:00:00Z', days: 30, tz: 'America/New_York', source: 'camera',
  registrations: { by_hour: hours({ 9: 2, 17: 5 }), by_weekday: [1, 0, 2, 0, 4, 0, 0], total: 7, short_term: 5, long_term: 2, approved: 6, rejected: 1, pending: 0, median_minutes_to_decision: 125 },
  traffic: { by_hour: hours({ 8: 3, 17: 14, 18: 9 }), by_weekday: [2, 4, 6, 3, 8, 2, 1], entries_total: 26, unique_plates: 11, busiest_hour: 17, busiest_weekday: 4 },
};

// The same property without one: traffic is null and the source says so.
const NO_CAMERA = { ...CAMERA, source: 'registrations', traffic: null };

test('sourceLine and seriesLabel say in plain words what is counted', () => {
  assert.equal(sourceLine('camera'), 'From the camera');
  assert.equal(sourceLine('registrations'), 'From registrations (no camera yet)');
  assert.equal(sourceLine(undefined), 'From registrations (no camera yet)');
  assert.equal(seriesLabel('camera'), 'Cars seen entering');
  assert.equal(seriesLabel('registrations'), 'Parking passes filed');
});

test('hourLabel / hourTick', () => {
  assert.equal(hourLabel(0), '12 AM');
  assert.equal(hourLabel(9), '9 AM');
  assert.equal(hourLabel(12), '12 PM');
  assert.equal(hourLabel(17), '5 PM');
  assert.equal(hourLabel(24), '');
  assert.equal(hourTick(0), '12a');
  assert.equal(hourTick(17), '5p');
  assert.equal(hourTick(-1), '');
});

test('pickSeries charts the camera when there is one, else registrations', () => {
  const cam = pickSeries(CAMERA);
  assert.equal(cam.source, 'camera');
  assert.equal(cam.by_hour[17], 14);
  assert.deepEqual(cam.by_weekday, [2, 4, 6, 3, 8, 2, 1]);
  assert.equal(cam.by_weekday_hour, null);
  const reg = pickSeries(NO_CAMERA);
  assert.equal(reg.source, 'registrations');
  assert.equal(reg.by_hour[17], 5);
  assert.deepEqual(reg.by_weekday, [1, 0, 2, 0, 4, 0, 0]);
  // `source: camera` with traffic null (a camera that has not reported yet) still charts registrations.
  assert.equal(pickSeries({ ...CAMERA, traffic: null }).source, 'registrations');
  const none = pickSeries(null);
  assert.equal(none.by_hour.length, 24);
  assert.equal(none.by_weekday.length, 7);
  assert.equal(none.by_hour.reduce((a, b) => a + b, 0), 0);
});

test('hourBars: 24 bars scaled to the tallest, the busiest hour marked once, each labelled', () => {
  const bars = hourBars(CAMERA.traffic.by_hour);
  assert.equal(bars.length, 24);
  assert.deepEqual(bars.filter(b => b.busiest).map(b => b.hour), [17]);
  assert.equal(bars[17].pct, 100);
  assert.equal(bars[18].pct, 64);
  assert.equal(bars[8].pct, 21);
  assert.equal(bars[0].pct, 0);
  assert.equal(bars[17].label, '5 PM · 14 entries');
  assert.equal(bars[0].label, '12 AM · 0 entries');
  assert.equal(hourBars(hours({ 3: 1 }))[3].label, '3 AM · 1 entry');
  assert.deepEqual(hourBars(null).filter(b => b.busiest), []);
  // A tie goes to the earlier hour.
  assert.deepEqual(hourBars(hours({ 7: 4, 19: 4 })).filter(b => b.busiest).map(b => b.hour), [7]);
});

test('heatGrid: 7 × 24, levels 0..4 on the blue ramp, each cell names itself', () => {
  const grid = heatGrid(pickSeries(CAMERA));
  assert.equal(grid.rows.length, 7);
  assert.ok(grid.rows.every(r => r.length === 24));
  // With only the two totals the grid is the expected count, and says so.
  assert.equal(grid.estimated, true);
  const fri5 = grid.rows[4][17];
  assert.equal(fri5.count, 4);             // 8 × 14 / 26 ≈ 4.3
  assert.equal(fri5.level, 4);
  assert.equal(fri5.label, 'Fri 5 PM · about 4 entries');
  assert.equal(grid.rows[6][0].level, 0);
  assert.equal(grid.rows[6][0].label, 'Sun 12 AM · about 0 entries');
  assert.ok(grid.rows.flat().every(c => c.level >= 0 && c.level <= 4));
});

test('heatGrid: a real by_weekday_hour matrix is used as sent', () => {
  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  matrix[1][17] = 14;
  matrix[1][18] = 1;
  const grid = heatGrid({ by_hour: hours({ 17: 14, 18: 1 }), by_weekday: [0, 15, 0, 0, 0, 0, 0], by_weekday_hour: matrix });
  assert.equal(grid.estimated, false);
  assert.equal(grid.max, 14);
  assert.equal(grid.rows[1][17].label, 'Tue 5 PM · 14 entries');
  assert.equal(grid.rows[1][17].level, 4);
  assert.equal(grid.rows[1][18].label, 'Tue 6 PM · 1 entry');
  assert.equal(grid.rows[1][18].level, 1);
  assert.equal(grid.rows[0][17].level, 0);
});

test('heatGrid over nothing is all zero and never divides by zero', () => {
  const grid = heatGrid(pickSeries(null));
  assert.equal(grid.max, 0);
  assert.ok(grid.rows.flat().every(c => c.level === 0 && c.count === 0));
});

test('fmtMinutes', () => {
  assert.equal(fmtMinutes(14), '14 m');
  assert.equal(fmtMinutes(125), '2 h 05 m');
  assert.equal(fmtMinutes(60 * 24 * 3 + 240), '3 d 4 h');
  assert.equal(fmtMinutes(0), '0 m');
  assert.equal(fmtMinutes(null), '');
});

test('counters: every number has a label; camera counters only with a camera', () => {
  const withCam = counters(CAMERA);
  assert.deepEqual(withCam.map(c => c.key), ['entries', 'unique', 'registrations', 'kinds', 'decisions', 'median']);
  assert.deepEqual(withCam.map(c => c.value), ['26', '11', '7', '5 / 2', '6 / 1', '2 h 05 m']);
  assert.ok(withCam.every(c => typeof c.label === 'string' && c.label.length > 0));
  const without = counters(NO_CAMERA);
  assert.deepEqual(without.map(c => c.key), ['registrations', 'kinds', 'decisions', 'median']);
  assert.equal(counters({ registrations: { total: 0, median_minutes_to_decision: null } }).find(c => c.key === 'median').value, '—');
  assert.deepEqual(counters(null).map(c => c.value), ['0', '0 / 0', '0 / 0', '—']);
});

test('busiestLine names the weekday and the hour', () => {
  assert.equal(busiestLine(pickSeries(CAMERA)), 'Busiest: Fri, 5 PM');
  assert.equal(busiestLine(pickSeries(NO_CAMERA)), 'Busiest: Fri, 5 PM');
  assert.equal(busiestLine({ by_hour: hours({ 9: 1 }), by_weekday: [] }), 'Busiest: 9 AM');
  assert.equal(busiestLine(pickSeries(null)), '');
});

test('emptyLine and rangeLine', () => {
  assert.equal(emptyLine('camera', 7), 'No cars were seen entering in the last 7 days. The chart fills in as the camera records arrivals.');
  assert.equal(emptyLine('registrations', 30), 'No parking passes were filed in the last 30 days. The chart fills in as people register.');
  assert.equal(rangeLine(30), 'Last 30 days · hours in ET');
  assert.equal(rangeLine(1), 'Last 1 day · hours in ET');
});

test('the picker', () => {
  assert.deepEqual(DAY_OPTIONS, [7, 30, 90]);
  assert.equal(DEFAULT_DAYS, 30);
  assert.equal(clampDays(90), 90);
  assert.equal(clampDays(20), 30);
  assert.equal(clampDays(undefined), 30);
  assert.deepEqual(WEEKDAYS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});
