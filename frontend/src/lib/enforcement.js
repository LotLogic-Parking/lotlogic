// ── Enforcement: the Smart Boot fleet on the main dashboard ───────
//
// Gabe, 2026-11-15: "move the enforcement dashboard and scope it for only
// victor and i at the emails of victor@lotlogicparking.com and
// gabriel@lotlogicparking.com, it needs to be on the main dashboard".
//
// The page talks to the boot-portal edge function with the dashboard session
// token. The function asks the backend who that token is and refuses anyone
// not on its own BOOT_ADMIN_EMAILS list, so the email check below only decides
// whether the tab shows; it is not the security boundary.
// `scripts/enforcement.test.mjs` covers the pure half.

import { getSessionToken } from './api.js';
import { SUPABASE_URL } from './supabase.js';

export const ENFORCEMENT_EMAILS = ['gabriel@lotlogicparking.com', 'victor@lotlogicparking.com'];
export const BOOT_PORTAL_URL = `${SUPABASE_URL}/functions/v1/boot-portal`;

/** The tab shows for exactly the two LotLogic emails, never while viewing as a partner. */
export function canSeeEnforcement(owner, viewAs = null) {
  if (viewAs) return false;
  const email = typeof owner?.email === 'string' ? owner.email.trim().toLowerCase() : '';
  return ENFORCEMENT_EMAILS.includes(email);
}

// What the boot reports (boot-report: 0 locked, 1 and 2 open, 3 stuck).
export function stateLabel(state) {
  if (state === 0) return 'Locked';
  if (state === 1 || state === 2) return 'Open';
  if (state === 3) return 'Stuck';
  return 'Unknown';
}

const CMD_LABEL = { 1: 'Unlock', 2: 'Lock', 3: 'Pulse test', 16: 'Clear tamper', 32: 'Test mode', 80: 'Setup Wi-Fi' };
export function commandLabel(cmd) {
  return CMD_LABEL[cmd] || (cmd == null ? '' : `Command ${cmd}`);
}

/** "just now", "4 m ago", "3 h ago", "2 d ago"; "never" without a time. */
export function ago(iso, now = Date.now()) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Chips for what needs a person, worst first. */
export function bootFlags(b) {
  const out = [];
  if (b?.fault) out.push({ key: 'fault', label: 'Fault', tone: 'bad' });
  if (b?.tamper) out.push({ key: 'tamper', label: 'Tamper', tone: 'bad' });
  if (b?.lock_refused_battery) out.push({ key: 'refused', label: 'Lock refused: battery', tone: 'bad' });
  if (b?.low_battery) out.push({ key: 'battery', label: 'Low battery', tone: 'warn' });
  if (b && b.online === false) out.push({ key: 'offline', label: 'Offline', tone: 'warn' });
  return out;
}

export function batteryTone(pct) {
  if (typeof pct !== 'number') return 'muted';
  if (pct < 25) return 'bad';
  if (pct < 50) return 'warn';
  return 'ok';
}

export function money(cents) {
  return typeof cents === 'number' && Number.isFinite(cents) ? `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}` : '—';
}

export function mapUrl(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' ? `https://www.google.com/maps?q=${lat},${lon}` : null;
}

const OPEN_DEPLOYMENT = ['locking', 'active', 'release_authorized'];
const DEP_LABEL = {
  locking: 'Locking', active: 'On a car', release_authorized: 'Paid, releasing',
  unlocked: 'Released', cancelled: 'Cancelled',
};
export function deploymentLabel(status) {
  return DEP_LABEL[status] || status || '';
}
export function isOnCar(dep) {
  return !!dep && OPEN_DEPLOYMENT.includes(dep.status);
}

/** Summary tiles over the fleet list. */
export function fleetSummary(boots) {
  const list = Array.isArray(boots) ? boots : [];
  return {
    total: list.length,
    onCar: list.filter(b => OPEN_DEPLOYMENT.includes(b.deployment_status)).length,
    attention: list.filter(b => bootFlags(b).some(f => f.tone === 'bad' || f.key === 'battery')).length,
    online: list.filter(b => b.online).length,
  };
}

/**
 * Which actions make sense for this boot right now. The server enforces every
 * rule again; this only decides which buttons show.
 */
export function actionsFor(boot, deployment, commands = []) {
  const onCar = isOnCar(deployment);
  const pending = (commands || []).find(c => c.status === 'queued' || c.status === 'delivered');
  const queuedLock = pending && pending.cmd === 2 && pending.status === 'queued';
  const state = boot?.state;
  const a = [];
  if (onCar) {
    if (deployment.status === 'release_authorized') a.push('release');
    else a.push('waive');
    if (queuedLock) a.push('cancel');
    a.push('emergency');
    return a;
  }
  if (queuedLock) a.push('cancel');
  if (state === 1 || state === 2) a.push('place', 'store');
  else a.push('open');
  a.push('wifi', 'emergency');
  return a;
}

export const ACTION_LABEL = {
  open: 'Open to fit', place: 'Place on a car', store: 'Close for storage', release: 'Send release',
  waive: 'Waive fee and release', cancel: 'Cancel lock', emergency: 'Emergency unlock', wifi: 'Setup Wi-Fi',
};

// ── API ──────────────────────────────────────────────────────

export class PortalError extends Error {
  constructor(status, code, message) { super(message || code || `Error ${status}`); this.status = status; this.code = code; }
}

export async function portal(route, { method = 'GET', body, query } = {}) {
  const token = getSessionToken();
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const res = await fetch(`${BOOT_PORTAL_URL}/${route}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token || ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new PortalError(res.status, data?.error, data?.message);
  return data;
}

/** Upload a photo or signature for a boot; returns the stored path the lock/emergency call wants. */
export async function uploadBootFile(bootId, blob, kind) {
  const contentType = blob.type || (kind === 'signature' ? 'image/png' : 'image/jpeg');
  const { upload_url, photo_path } = await portal('photo-url', { method: 'POST', body: { boot_id: bootId, content_type: contentType, kind } });
  const res = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': contentType, 'x-upsert': 'false' }, body: blob });
  if (!res.ok) throw new PortalError(res.status, 'upload_failed', 'The photo did not upload. Try again.');
  return photo_path;
}

// ── Payments log (GET /boot-portal/payments) ─────────────────

/** "85 m", "1.2 km", "12 km". */
export function meters(m) {
  if (typeof m !== 'number' || !Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return m < 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

/** Where a boot was, in words: the property it was at, or how far from the nearest one. */
export function placeLine(p) {
  if (!p?.gps) return 'No GPS recorded';
  const g = p.geo;
  if (g?.at_property) return `${g.property} · ${meters(g.distance_m)} from the address`;
  if (g?.nearest) return `Not at a LotLogic property · nearest ${g.nearest}, ${meters(g.nearest_m)}`;
  return 'GPS recorded, no property to compare';
}

/** Flags a person should look at on one payment row. */
export function paymentFlags(row) {
  const f = [];
  const p = row?.placement;
  if (row?.not_in_square) f.push({ key: 'nosquare', label: 'Marked paid, not found in Square', tone: 'bad' });
  if (row?.kind === 'other') f.push({ key: 'other', label: 'Not a boot payment', tone: 'muted' });
  if (p && !p.gps) f.push({ key: 'nogps', label: 'No GPS', tone: 'warn' });
  if (p?.gps && p.geo && !p.geo.at_property) f.push({ key: 'off', label: 'Off property', tone: 'warn' });
  if (p?.property_mismatch) f.push({ key: 'mismatch', label: "GPS differs from the driver's property", tone: 'warn' });
  if (row?.square && row.square.fee_cents == null) f.push({ key: 'nofee', label: 'Square fee not reported yet', tone: 'muted' });
  if (row?.square?.refunded_cents > 0) f.push({ key: 'refund', label: 'Refunded', tone: 'warn' });
  return f;
}

/** Square statuses that are money that never arrived; they are listed but never counted. */
export const UNCOLLECTED = new Set(['FAILED', 'CANCELED']);

/** Totals over the payment rows: collected boot payments only, Square's numbers where Square has them. */
export function paymentsSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const boot = list.filter(r => r.kind === 'boot' && !UNCOLLECTED.has(r.square?.status));
  const sum = (xs, f) => xs.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const placementNet = (p) => (Number(p?.paid_amount_cents) || 0) - (Number(p?.square_fee_cents) || 0) - (Number(p?.refunded_amount_cents) || 0);
  return {
    count: boot.length,
    gross: sum(boot, r => r.square?.amount_cents ?? r.placement?.paid_amount_cents),
    fees: sum(boot, r => r.square?.fee_cents ?? r.placement?.square_fee_cents),
    refunded: sum(boot, r => r.square ? r.square.refunded_cents : r.placement?.refunded_amount_cents),
    net: sum(boot, r => r.square?.net_cents ?? placementNet(r.placement)),
    atProperty: boot.filter(r => r.placement?.geo?.at_property).length,
    offProperty: boot.filter(r => r.placement && !r.placement.geo?.at_property).length,
    other: list.filter(r => r.kind === 'other').length,
  };
}

// ── Agents (GET /boot-portal/agents, POST agent-add|agent-resend|agent-remove) ──
// LotLogic's boot agents: partner_members of the "LotLogic" company who sign in
// to the boot portal. The server (boot-portal agents.ts) checks every rule
// again; these only shape the form and the list.

export const AGENT_ROLES = ['driver', 'dispatcher'];
export const AGENT_ROLE_LABEL = { driver: 'Driver', dispatcher: 'Dispatcher', admin: 'Admin' };
export function agentRoleLabel(role) {
  return AGENT_ROLE_LABEL[role] || role || '';
}

/** The add form as the agent-add body, or the first thing to fix. */
export function agentBody(form) {
  const f = form || {};
  const name = String(f.name || '').trim();
  const email = String(f.email || '').trim().toLowerCase();
  const phone = String(f.phone || '').trim();
  const role = f.role;
  const property_ids = [...new Set((Array.isArray(f.property_ids) ? f.property_ids : []).filter(Boolean))];
  if (name.length < 2) return { error: "Enter the agent's name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
  if (!AGENT_ROLES.includes(role)) return { error: 'Pick driver or dispatcher.' };
  if (role === 'driver' && property_ids.length === 0) return { error: 'Pick at least one property this driver covers.' };
  return { body: { name, email, phone: phone || undefined, role, property_ids } };
}

/** Where the agent's sign-in stands, in words. */
export function agentStatus(a, now = Date.now()) {
  if (!a?.has_password) return { label: 'Invited · no password yet', tone: 'warn' };
  if (!a.last_login_at) return { label: 'Password set · never signed in', tone: 'muted' };
  return { label: `Signed in ${ago(a.last_login_at, now)}`, tone: 'ok' };
}

/** "Every property" for a dispatcher, the names for a driver. */
export function agentCoverage(a) {
  if (a?.role === 'dispatcher' || a?.role === 'admin') return 'Every property';
  const names = (a?.properties || []).map(p => p.name);
  return names.length ? names.join(', ') : 'No properties: cannot boot anywhere';
}
