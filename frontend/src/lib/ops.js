// ── Admin › Today: the owners' home ───────────────────────────────
// Talks to the admin-ops edge function with the dashboard session token. The
// function asks the backend who the token is and requires is_platform_admin, so
// the tab gate in App.jsx is not the security boundary. Every rule about what
// "needs you" lives server-side in supabase/functions/admin-ops/ops.ts; this file
// only shapes the answer for the screen. `scripts/ops.test.mjs` covers it.

import { getSessionToken } from './api.js';
import { SUPABASE_URL } from './supabase.js';

export const ADMIN_OPS_URL = `${SUPABASE_URL}/functions/v1/admin-ops`;
export const REFRESH_MS = 60_000;

export async function opsFetch(path = '', { method = 'GET', body } = {}) {
  const res = await fetch(ADMIN_OPS_URL + path, {
    method,
    headers: { Authorization: `Bearer ${getSessionToken() || ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `Couldn't load (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const list = (x) => (Array.isArray(x) ? x : []);

/** The four tiles at the top. */
export function tiles(data) {
  const props = list(data?.properties).filter((p) => p.working !== null && p.working !== undefined);
  const cams = list(data?.cameras);
  const boots = list(data?.boots);
  const officers = list(data?.officers);
  const working = props.filter((p) => p.working).length;
  const reporting = cams.filter((c) => !c.silent).length;
  const onCars = boots.filter((b) => b.where === 'car').length;
  const silent = boots.filter((b) => b.silent).length;
  return [
    { key: 'properties', label: 'Properties working', value: `${working} / ${props.length}`, tone: props.length && working === props.length ? 'good' : props.length ? 'bad' : 'neutral' },
    { key: 'cameras', label: 'Cameras reporting', value: `${reporting} / ${cams.length}`, tone: cams.length && reporting === cams.length ? 'good' : cams.length ? 'bad' : 'neutral' },
    {
      key: 'boots', label: 'Boots on cars', value: String(onCars), tone: silent ? 'warn' : 'neutral',
      sub: `${boots.filter((b) => b.where === 'agent').length} with agents · ${boots.filter((b) => b.where === 'unassigned').length} unassigned · ${silent} not checking in`,
    },
    { key: 'agents', label: 'Agents', value: String(officers.length), tone: 'neutral', sub: `${officers.filter((o) => o.boots_held > 0).length} holding boots` },
  ];
}

export const WHERE_LABEL = { car: 'On a car', agent: 'With agent', unassigned: 'Unassigned', storage: 'In storage' };

/** One line under a boot's label saying where it is. */
export function bootLine(b) {
  if (b?.where === 'car' && b.car) return `On ${b.car.plate || 'a car'}${b.car.property ? ` at ${b.car.property}` : ''}${b.car.paid ? ' · paid' : ''}`;
  if (b?.where === 'storage') return 'Closed for storage, switched off';
  if (b?.where === 'agent') return `With ${b.holder?.name || 'an agent'}`;
  return 'Nobody holds it';
}

export const LOCK_LABEL = { 0: 'Locked', 1: 'Open', 2: 'Open', 3: 'Fault' };

/** Agents a boot can go to: same company, not the current holder. */
export function assignable(boot, officers) {
  return list(officers).filter((o) => o.partner_id === boot?.partner_id && o.id !== boot?.holder?.id);
}

/** Cameras with the silent ones first. */
export function camerasSilentFirst(cameras) {
  return [...list(cameras)].sort((a, b) => (a.silent === b.silent ? String(a.name || '').localeCompare(String(b.name || '')) : a.silent ? -1 : 1));
}

/**
 * Schematic map: properties with coordinates as squares, boots with a position as dots, fitted to a w×h box.
 * Not a real map: no tiles, just relative placement.
 */
export function mapLayout(data, w = 400, h = 260, pad = 24) {
  const props = list(data?.properties).filter((p) => p.lat != null && p.lng != null).map((p) => ({ kind: 'property', id: p.id, name: p.name, lat: +p.lat, lon: +p.lng }));
  const boots = list(data?.boots).filter((b) => b.position).map((b) => ({ kind: 'boot', id: b.id, name: b.label, lat: +b.position.lat, lon: +b.position.lon, where: b.where }));
  const pts = [...props, ...boots];
  if (!pts.length) return { points: [], missing: list(data?.properties).length - props.length };
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const spanLat = Math.max(maxLat - minLat, 0.002), spanLon = Math.max(maxLon - minLon, 0.002);
  const scale = Math.min((w - 2 * pad) / spanLon, (h - 2 * pad) / spanLat);
  const cx = (minLon + maxLon) / 2, cy = (minLat + maxLat) / 2;
  return {
    points: pts.map((p) => ({ ...p, x: Math.round(w / 2 + (p.lon - cx) * scale), y: Math.round(h / 2 - (p.lat - cy) * scale) })),
    missing: list(data?.properties).length - props.length,
  };
}
