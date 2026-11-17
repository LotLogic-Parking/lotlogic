// The boot agent's rules, used by the dashboard's Enforcement tab
// (pages/EnforcementPage.jsx: the boot page and the four-step placement), with
// no DOM and no network, so `scripts/agentLogic.test.mjs` can cover them. They
// came from Victor's /agent screen, which now redirects to /app. Phase 1 talks only to the
// boot-portal edge function as it runs today (supabase/functions/boot-portal):
// every rule here is a mirror of what that function enforces, used to decide
// what to show. The server checks every one again and its message wins.
//
// Design: the "LotLogic Enforcement Agent (mockup)" artifact. Sentence case,
// 12-hour times.

import { fmtPauseTime } from '../lib/pause.js';

export const OPEN_DEPLOYMENT = ['locking', 'active', 'release_authorized'];
export const IN_FLIGHT = ['queued', 'delivered'];          // boot_commands.status still on its way
export const LOW_BATTERY_PCT = 25;                          // boot-portal lock(): under 25 % refuses
export const CMD = { UNLOCK: 1, LOCK: 2 };
export const EMERGENCY_MIN_CHARS = 20;                      // boot-portal EMERGENCY_MIN_CHARS
export const POLL_MS = 5000;

// ── formatting ─────────────────────────────────────────────────────────────
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** "3:05 PM". */
export function timeOf(iso) {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}

/** "3:05 PM" today, else "Tue 3:05 PM". */
export function dayTime(iso, now = Date.now()) {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  return t.getTime() >= d0.getTime() ? timeOf(iso) : `${t.toLocaleDateString('en-US', { weekday: 'short' })} ${timeOf(iso)}`;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago", "never". */
export function ago(iso, now = Date.now()) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'never';
  const m = Math.round(Math.max(0, now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export function money(cents) {
  return typeof cents === 'number' && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : '';
}

/** What boot-portal stores as the plate: upper case, letters and digits, 12 at most. */
export function normPlate(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

// ── a boot's state ─────────────────────────────────────────────────────────
const isOpenState = (s) => s === 1 || s === 2;          // boot-report: 0 locked, 1 and 2 open, 3 stuck
export const lowBattery = (b) => typeof b?.battery_pct === 'number' && b.battery_pct < LOW_BATTERY_PCT;
export const hasFault = (b) => b?.state === 3 || !!b?.fault;
export const onCar = (status) => OPEN_DEPLOYMENT.includes(status);

const PENDING_WORD = { fit: 'Opening', place: 'Locking', release: 'Releasing', store: 'Closing', emergency: 'Unlocking' };

/** The status pill for a row of GET /boots. */
export function bootStatus(b) {
  if (b?.deployment_status === 'locking') return { tone: 'wait', text: 'Locking' };
  if (b?.deployment_status === 'active') return { tone: 'on', text: 'On a car' };
  if (b?.deployment_status === 'release_authorized') return { tone: 'done', text: 'Releasing' };
  if (IN_FLIGHT.includes(b?.pending_status)) return { tone: 'wait', text: PENDING_WORD[b.pending_purpose] || 'Waiting' };
  if (hasFault(b)) return { tone: 'ready', text: 'Fault' };
  if (lowBattery(b) || b?.low_battery) return { tone: 'ready', text: 'Battery low' };
  return { tone: 'grey', text: isOpenState(b?.state) ? 'Open' : 'Closed' };
}

/** The second line of a boot row. */
export function bootSubline(b, now = Date.now()) {
  const where = onCar(b?.deployment_status) && b?.plate_text ? `On ${b.plate_text}`
    : hasFault(b) ? 'Last move interrupted'
      : lowBattery(b) || b?.low_battery ? 'Charge before use'
        : b?.stored_at && b?.state === 0 ? 'In storage' : 'Ready';
  return `${where} · checked in ${ago(b?.last_report_at, now)}`;
}

/** Free / on cars / need attention, for the counters over the list. */
export function bootCounts(boots) {
  const list = Array.isArray(boots) ? boots : [];
  return {
    free: list.filter((b) => !onCar(b.deployment_status)).length,
    onCars: list.filter((b) => onCar(b.deployment_status)).length,
    attention: list.filter((b) => hasFault(b) || lowBattery(b) || b.low_battery || b.tamper || b.online === false).length,
  };
}

/** Boots a new placement can use: not on a car. Sorted by label. */
export function freeBoots(boots) {
  return (Array.isArray(boots) ? boots : []).filter((b) => !onCar(b.deployment_status))
    .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
}

// ── one boot (GET /boot?id=) ───────────────────────────────────────────────
/** The command still on its way to the boot, if any. */
export function pendingCommand(detail) {
  return (detail?.commands || []).find((c) => IN_FLIGHT.includes(c.status)) || null;
}

/** The latest placement, only while it is still on the car. */
export function openDeployment(detail) {
  const d = detail?.deployment;
  return d && onCar(d.status) ? d : null;
}

/** A released boot left open by the car: someone has to collect it and close it. */
export function needsPickup(detail) {
  const d = detail?.deployment; const b = detail?.boot;
  if (!d || d.status !== 'unlocked' || !b || !isOpenState(b.state)) return false;
  return !b.stored_at || new Date(b.stored_at) < new Date(d.unlocked_at || d.released_at || 0);
}

const RELEASE_WORD = { waived: 'Fee waived', emergency: 'Emergency unlock' };

/** The notices at the top of the boot page, most urgent first: {tone, title, text}. */
export function bootNotices(detail) {
  const out = [];
  const b = detail?.boot || {}; const d = openDeployment(detail); const pend = pendingCommand(detail);
  if (pend) {
    const what = PENDING_WORD[pend.purpose] || 'Command';
    out.push({
      tone: 'wait', spin: true, title: `${what} sent at ${timeOf(pend.created_at)}`,
      text: d?.status === 'release_authorized'
        ? 'Boots are switched off while on a car. It opens once the driver switches it on, which the pay page tells them to do.'
        : 'The boot picks this up when it next checks in, usually within a minute.',
    });
  }
  if (d?.status === 'active') {
    out.push({ tone: 'on', title: 'Waiting for payment', text: `${money(d.fee_cents)} fee. The driver pays by scanning the QR code on the boot.` });
  }
  if (d?.status === 'release_authorized') {
    const title = RELEASE_WORD[d.release_reason] || (d.paid_at ? `Paid ${money(d.paid_amount_cents ?? d.fee_cents)} at ${timeOf(d.paid_at)}` : 'Cleared to release');
    out.push({ tone: 'done', title, text: `The boot can come off. Pick it up${d.property ? ` at ${d.property}` : ''} once it opens.` });
  }
  if (!d && needsPickup(detail)) {
    const dep = detail.deployment;
    out.push({
      tone: 'ready', title: 'Pick up this boot',
      text: `It opened at ${timeOf(dep.unlocked_at || dep.released_at)}${dep.property ? ` at ${dep.property}` : ''}. Close it for storage once you have it.`,
    });
  }
  if (hasFault(b)) {
    out.push({ tone: 'ready', title: 'Boot fault', text: "Its last move was interrupted. Opening or closing it again usually clears this. If it doesn't, use another boot." });
  }
  if (!d && lowBattery(b)) {
    out.push({ tone: 'ready', title: `Battery too low (${b.battery_pct}%)`, text: "A boot under 25% won't lock. Charge it first." });
  }
  return out;
}

/**
 * The buttons on the boot page, in order. Each is {act, label, kind, disabled?}.
 * place, open, store, cancel, release (send release again), waive, emergency.
 */
export function bootActions(detail) {
  const b = detail?.boot || {}; const d = openDeployment(detail); const pend = pendingCommand(detail);
  const a = [];
  if (!d && !pend) {
    const pickup = needsPickup(detail);
    if (pickup) a.push({ act: 'store', label: 'Close for storage', kind: 'primary' });
    a.push({ act: 'place', label: 'Place on a car', kind: pickup ? 'secondary' : 'primary', disabled: lowBattery(b) || hasFault(b) });
    if (b.state === 0 || hasFault(b)) a.push({ act: 'open', label: 'Open boot', kind: 'secondary' });
    if (isOpenState(b.state) && !pickup) a.push({ act: 'store', label: 'Close for storage', kind: 'secondary' });
  }
  if (pend && pend.cmd === CMD.LOCK && pend.status === 'queued') a.push({ act: 'cancel', label: 'Cancel lock', kind: 'secondary' });
  if (d?.status === 'active') a.push({ act: 'waive', label: 'Release without payment', kind: 'secondary' });
  if (d?.status === 'release_authorized' && !pend) a.push({ act: 'release', label: 'Send release again', kind: 'primary' });
  if (d || b.state === 0) a.push({ act: 'emergency', label: 'Emergency unlock', kind: 'danger-ghost' });
  return a;
}

// ── waiting for a command ──────────────────────────────────────────────────
/**
 * Where a command we sent stands, from a fresh GET /boot: 'waiting' while it is
 * queued or delivered, else its end state. A command no longer listed (the
 * boot shows its 8 latest) counts as done.
 */
export function commandOutcome(detail, commandId) {
  const c = (detail?.commands || []).find((x) => x.id === commandId);
  if (!c) return { state: 'done' };
  if (IN_FLIGHT.includes(c.status)) return { state: 'waiting', delivered: c.status === 'delivered' };
  return { state: c.status, result: c.device_result ?? null, note: c.note ?? null };
}

const DONE_WORD = { fit: 'Opened', place: 'Locked', release: 'Released', store: 'Closed for storage', emergency: 'Unlocked' };

/** What to tell the agent when a command finishes. */
export function outcomeMessage(purpose, outcome) {
  if (outcome.state === 'done') return { tone: 'done', text: `${DONE_WORD[purpose] || 'Done'}.` };
  if (outcome.state === 'expired') return { tone: 'ready', text: "The boot didn't check in in time, so the command expired. Try again when it's online." };
  if (outcome.state === 'cancelled') return { tone: 'grey', text: 'The command was cancelled.' };
  return { tone: 'ready', text: 'The boot reported a problem with that command. Try again, or use another boot.' };
}

// ── place a boot: 4 steps ──────────────────────────────────────────────────
export const STEP_NAMES = ['Where', 'Vehicle', 'Boot', 'Sign'];

export function newPlacement(bootId = '') {
  return {
    step: 1, property_id: '', plate: '', plate_state: 'NC', make: '', model: '', color: '', spot: '', notes: '',
    boot_id: bootId, photo_path: '', photo_preview: '', signed_name: '', signature: null, signed_at: null, resign: false,
  };
}

/** The fields a signature vouches for. Changing any of them after signing clears the signature. */
export const SIGNED_FIELDS = ['property_id', 'plate', 'plate_state', 'make', 'model', 'color', 'spot', 'notes', 'boot_id', 'photo_path', 'signed_name'];

/** The placement with one field changed. A changed signed field clears the signature, and the page asks again. */
export function editPlacement(f, key, value) {
  const next = { ...f, [key]: value };
  if (key === 'boot_id' && value !== f.boot_id) Object.assign(next, { photo_path: '', photo_preview: '' }); // the photo belongs to the boot
  if (f.signature && SIGNED_FIELDS.includes(key) && value !== f[key]) Object.assign(next, { signature: null, signed_at: null, resign: true });
  return next;
}

export function signPlacement(f, pngDataUrl, at = new Date().toISOString()) {
  return pngDataUrl ? { ...f, signature: pngDataUrl, signed_at: at, resign: false } : { ...f, signature: null, signed_at: null };
}

/**
 * What still stops a step from going on, in words for "Still needed: …".
 * ctx: {properties, pausesUnknown, boot (a GET /boots row or detail.boot), pending (a command), opening}
 */
export function stepMissing(f, step, ctx = {}) {
  const m = [];
  // A paused property stops every step, Lock boot included: the list may be
  // re-read after step 1 (the server refuses the lock anyway).
  const picked = f.property_id ? (ctx.properties || []).find(p => p.id === f.property_id) : null;
  if (bootPauseNotice(picked, ctx.pausesUnknown)?.kind === 'paused') return ['a property that is not paused'];
  if (step === 1) {
    if (!(ctx.properties || []).length) m.push('a property assigned to you (ask LotLogic)');
    else if (!f.property_id) m.push('property');
  }
  if (step === 2) {
    if (normPlate(f.plate).length < 2) m.push('plate');
    if (!/^[A-Z]{2}$/.test(String(f.plate_state || '').trim().toUpperCase())) m.push('plate state');
  }
  if (step === 3) {
    const b = ctx.boot;
    if (!f.boot_id || !b) m.push('boot');
    else {
      if (lowBattery(b)) m.push('a boot with more battery');
      if (hasFault(b)) m.push('a boot without a fault');
      if (ctx.pending && ctx.pending.purpose !== 'fit') m.push('wait for the boot to finish');
      if (!isOpenState(b.state)) m.push(ctx.opening ? 'wait for the boot to open' : 'open the boot');
    }
    if (!f.photo_path) m.push('photo of the boot');
  }
  if (step === 4) {
    if (String(f.signed_name || '').trim().length < 2) m.push('your full name');
    if (!f.signature) m.push('signature');
  }
  return m;
}

/**
 * The enforcement pause at the property picked in step 1, said before the
 * photo and the signature (spec 2026-11-16 Part 3). boot-portal GET
 * /properties gives each property `paused_until` (the running pause's end,
 * ISO, or null), or, when it could not read the pauses, no field and a
 * top-level `pauses_unknown: true`. The server refuses a lock at a paused
 * property either way; this only says so first. The end is the server's, as
 * it was when the list was read, never this device's clock.
 * @returns {null | {kind: 'paused' | 'unknown', text: string}}
 */
export function bootPauseNotice(property, pausesUnknown = false, now = Date.now()) {
  if (!property) return null;
  if (property.paused_until) {
    const until = fmtPauseTime(property.paused_until, now);
    return { kind: 'paused', text: `Enforcement is paused here${until ? ` until ${until}` : ''} — do not boot` };
  }
  if (pausesUnknown) return { kind: 'unknown', text: 'Could not check for a pause' };
  return null;
}

/**
 * The attestation boot-portal writes when the boot is locked (its attestation()),
 * shown before signing. The server stamps its own time; this shows the time of signing.
 */
export function attestation(name, bootLabel, plate, state, at = new Date()) {
  const when = new Date(at).toLocaleString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
  const st = String(state || '').trim().toUpperCase();
  return `I, ${name || '[your name]'}, placed boot “${bootLabel || '[boot]'}” on the vehicle with plate ${normPlate(plate) || '[plate]'}${st ? ` (${st})` : ''} on ${when}. ` +
    'The plate, photo and location I submitted are accurate.';
}

/** The notes boot-portal stores: where on the property, then anything else. */
export function placementNotes(f) {
  return [String(f.spot || '').trim() && `Location: ${String(f.spot).trim()}`, String(f.notes || '').trim()].filter(Boolean).join('\n') || undefined;
}

/** The POST /lock body. */
export function lockBody(f, signaturePath, pos = {}) {
  const t = (v, n) => (String(v || '').trim() ? String(v).trim().slice(0, n) : undefined);
  return {
    boot_id: f.boot_id,
    plate_text: normPlate(f.plate),
    plate_state: String(f.plate_state || '').trim().toUpperCase().slice(0, 4) || undefined,
    property_id: f.property_id || undefined,
    photo_path: f.photo_path,
    signature_path: signaturePath,
    signed_name: String(f.signed_name || '').trim(),
    vehicle_make: t(f.make, 40), vehicle_model: t(f.model, 40), vehicle_color: t(f.color, 30),
    notes: placementNotes(f),
    lat: pos.lat ?? undefined, lon: pos.lon ?? undefined, accuracy_m: pos.accuracy_m ?? undefined,
  };
}

/** The emergency sheet can be sent: a reason and at least 20 characters of explanation. */
export function emergencyReady(e) {
  return !!e?.reason && String(e?.explanation || '').trim().length >= EMERGENCY_MIN_CHARS;
}
