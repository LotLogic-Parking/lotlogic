// The two lot-status wrappers hit the contract's routes with the property id
// (and plate) as query parameters, encoded.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getLotStatus, getPassHistory, getPassMetrics, getPermits, getPlateTimeline, getPresence, requestsApi } from '../src/lib/requestsApi.js';

async function seenUrl(call) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try { await call(); } finally { globalThis.fetch = realFetch; }
  return seen[0];
}

test('getLotStatus asks for the property and nothing else', async () => {
  const url = await seenUrl(() => getLotStatus('p 1'));
  assert.ok(url.endsWith('/apartment/passes/lot-status?property_id=p+1'), url);
  assert.equal(requestsApi.getLotStatus, getLotStatus);
});

test('getPlateTimeline sends the plate as typed, encoded', async () => {
  const url = await seenUrl(() => getPlateTimeline('p1', 'AB&C 12'));
  assert.ok(url.endsWith('/apartment/passes/timeline?property_id=p1&plate=AB%26C+12'), url);
  assert.equal(requestsApi.getPlateTimeline, getPlateTimeline);
});

// ── The manager's activity reads (build plan B1–B4) ──────────

test('getPassHistory sends whichever of plate / unit / name is given, encoded', async () => {
  assert.ok((await seenUrl(() => getPassHistory('p1', { unit: '#214' }))).endsWith('/apartment/passes/history?property_id=p1&unit=%23214'));
  assert.ok((await seenUrl(() => getPassHistory('p1', { plate: 'AB C1' }))).endsWith('/apartment/passes/history?property_id=p1&plate=AB+C1'));
  assert.ok((await seenUrl(() => getPassHistory('p1', { name: 'Pat Example' }))).endsWith('/apartment/passes/history?property_id=p1&name=Pat+Example'));
  assert.equal(requestsApi.getPassHistory, getPassHistory);
});

test('getPresence asks for the property and nothing else', async () => {
  const url = await seenUrl(() => getPresence('p 1'));
  assert.ok(url.endsWith('/apartment/passes/presence?property_id=p+1'), url);
  assert.equal(requestsApi.getPresence, getPresence);
});

test('getPassMetrics carries the day window', async () => {
  assert.ok((await seenUrl(() => getPassMetrics('p1', 7))).endsWith('/apartment/passes/metrics?property_id=p1&days=7'));
  assert.ok((await seenUrl(() => getPassMetrics('p1'))).endsWith('/apartment/passes/metrics?property_id=p1'), 'no days: the server default');
  assert.equal(requestsApi.getPassMetrics, getPassMetrics);
});

test('getPermits reads the approval queue for one property', async () => {
  const url = await seenUrl(() => getPermits('p 1'));
  assert.ok(url.endsWith('/apartment/passes/permits?property_id=p+1'), url);
  assert.equal(requestsApi.getPermits, getPermits);
});
