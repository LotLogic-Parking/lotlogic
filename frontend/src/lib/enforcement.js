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
