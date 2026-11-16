// Tests for frontend/src/lib/ops.js - Admin › Today's pure half. The rules themselves are in admin-ops/ops.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assignable, bootLine, camerasSilentFirst, mapLayout, tiles } from '../src/lib/ops.js';

const data = {
  properties: [
    { id: 'p1', name: 'Mayfield', working: true, lat: 35.30, lng: -80.80 },
    { id: 'p2', name: 'Trinity', working: false, lat: null, lng: null },
    { id: 'p3', name: 'No cams', working: null, lat: null, lng: null },
  ],
  cameras: [{ id: 'c1', name: 'Gate', silent: false }, { id: 'c2', name: 'Exit', silent: true }],
  boots: [
    { id: 'b1', label: 'Boot 01', where: 'car', silent: false, partner_id: 'll', holder: { id: 'm1', name: 'Sam' }, car: { plate: 'ABC123', property: 'Mayfield', paid: false }, position: { lat: 35.31, lon: -80.81 } },
    { id: 'b2', label: 'Boot 02', where: 'unassigned', silent: true, partner_id: 'll', holder: null, position: null },
    { id: 'b3', label: 'Boot 03', where: 'agent', silent: false, partner_id: 'll', holder: { id: 'm1', name: 'Sam' }, position: null },
  ],
  officers: [
    { id: 'm1', name: 'Sam', partner_id: 'll', boots_held: 2 },
    { id: 'm2', name: 'Ana', partner_id: 'll', boots_held: 0 },
    { id: 'm3', name: 'Other', partner_id: 'x', boots_held: 0 },
  ],
};

test('tiles: properties count only those with cameras; boots line splits by where', () => {
  const t = Object.fromEntries(tiles(data).map(x => [x.key, x]));
  assert.equal(t.properties.value, '1 / 2');
  assert.equal(t.properties.tone, 'bad');
  assert.equal(t.cameras.value, '1 / 2');
  assert.equal(t.boots.value, '1');
  assert.equal(t.boots.sub, '1 with agents · 1 unassigned · 1 not checking in');
  assert.equal(t.boots.tone, 'warn');
  assert.equal(t.agents.sub, '1 holding boots');
  assert.equal(tiles({}).find(x => x.key === 'cameras').tone, 'neutral');
});

test('bootLine says where the boot is', () => {
  assert.equal(bootLine(data.boots[0]), 'On ABC123 at Mayfield');
  assert.equal(bootLine(data.boots[1]), 'Nobody holds it');
  assert.equal(bootLine(data.boots[2]), 'With Sam');
  assert.equal(bootLine({ where: 'storage' }), 'Closed for storage, switched off');
});

test('assignable: same company, not the current holder', () => {
  assert.deepEqual(assignable(data.boots[2], data.officers).map(o => o.id), ['m2']);
  assert.deepEqual(assignable(data.boots[1], data.officers).map(o => o.id), ['m1', 'm2']);
});

test('cameras: silent first', () => {
  assert.deepEqual(camerasSilentFirst(data.cameras).map(c => c.id), ['c2', 'c1']);
});

test('mapLayout: places what has coordinates inside the box and counts the rest', () => {
  const { points, missing } = mapLayout(data, 400, 240, 24);
  assert.equal(missing, 2);
  assert.deepEqual(points.map(p => p.id).sort(), ['b1', 'p1']);
  for (const p of points) {
    assert.ok(p.x >= 24 && p.x <= 376, `x ${p.x}`);
    assert.ok(p.y >= 24 && p.y <= 216, `y ${p.y}`);
  }
  assert.deepEqual(mapLayout({ properties: [{ id: 'a' }] }), { points: [], missing: 1 });
});
