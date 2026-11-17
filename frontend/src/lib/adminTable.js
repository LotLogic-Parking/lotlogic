// ── Admin › Properties: the portfolio table, pure half ───────
//
// Spec 2026-11-16 Part 2 ("One portfolio table"): every property in one table,
// one status word per row, the most urgent that applies. The table joins two
// answers:
//   * `GET /admin/clients` (backend): the portfolio facts and the week counts.
//   * admin-ops (`opsFetch()`, lib/ops.js): cameras, boots and "needs you".
// Either can fail alone; the other's columns keep working. Everything here is
// decided without a DOM; `scripts/adminTable.test.mjs` covers it.
//
// Rules (plan "Review Focus"):
//   * A property with no cameras, or no admin-ops answer, never says "Camera offline".
//   * go-live null or past: no "Starts …".
//   * A number that did not load is a dash, never 0.
//   * A row a source did not answer for is "Not checked", never "All good".

import { displayPartnerName } from './towPartner.js';
import { goLiveLabel, startsLater } from './officeToday.js';
import { registrationLink } from './permitsQueue.js';

export const DASH = '—';
/** A registration is late after a day without an answer (plan Global Constraints). */
export const LATE_MS = 24 * 3600_000;

const list = (x) => (Array.isArray(x) ? x : []);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** `1204` → `"1,204"`; anything that is not a number → `"—"`. */
export function numberOrDash(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isFinite(n) ? n.toLocaleString('en-US') : DASH;
}

/**
 * The company that tows at the property: `tow_company_id` for an apartment;
 * a truck plaza carries none, so its account partner.
 * @returns {{id: string|null, name: string}}
 */
export function towPartnerOf(row) {
  if (row?.tow_company_id) return { id: row.tow_company_id, name: displayPartnerName(row.tow_company_name || row.partner_name) };
  if (row?.partner_id) return { id: row.partner_id, name: displayPartnerName(row.partner_name) };
  return { id: null, name: '' };
}

/**
 * Each client row gains `ops` = `{working, cameras, boots_on_cars, needs}`, or
 * `null` for every row when admin-ops did not answer.
 */
export function joinOps(clientRows, ops) {
  const rows = list(clientRows);
  if (!ops) return rows.map(r => ({ ...r, ops: null }));
  const boots = list(ops.boots);
  const bootProperty = new Map(boots.map(b => [b.id, b.car?.property_id ?? null]));
  const props = new Map(list(ops.properties).map(p => [p.id, p]));
  return rows.map(r => {
    const p = props.get(r.id);
    const needs = list(ops.needs).filter(n => (
      (n.action?.type === 'property' && n.action.id === r.id)
      || (n.action?.type === 'boot' && bootProperty.get(n.action.id) === r.id)
    ));
    return {
      ...r,
      ops: {
        working: p ? (p.working ?? null) : null,
        cameras: Number(p?.cameras) || 0,
        boots_on_cars: boots.filter(b => b.car?.property_id === r.id).length,
        needs,
      },
    };
  });
}

// A silent camera and waiting registrations are needs in admin-ops too; the
// table says them with its own words ("Camera offline", "3 waiting"), so the
// need does not take the pill first.
const OWN_WORDS = /^(camera|reg):/;
// admin-ops calls a registration late after 4 hours; the table's rule is a day
// (plan Global Constraints), and the Waiting column shows the count. Its need
// is left out of the panel so the panel never contradicts the row's status.
const LEFT_OUT = /^reg:/;

/** The row's admin-ops needs, red first (empty when admin-ops did not answer). */
export function needsFor(row) {
  return list(row?.ops?.needs).filter(n => !LEFT_OUT.test(String(n.key || '')))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A need's detail line inside its own property's panel: without the property's
 * name, which is the panel's title ("At Charlotte Travel Plaza." → "").
 */
export function needDetail(need, row) {
  let d = String(need?.detail || '').trim();
  const name = String(row?.name || '').trim();
  if (name) d = d.replace(new RegExp(`^At ${escapeRe(name)}\\.?\\s*`, 'i'), '');
  return d.replace(/\.\s*$/, '');
}

/**
 * The person who runs the property, or '' when all we know is the property's
 * own name again (`/admin/clients` sends `owner_name` = the owner's business
 * name, which for most apartments is the property).
 */
export function managerName(row) {
  const n = String(row?.owner_contact_name || row?.owner_name || '').trim();
  return n && n.toLowerCase() !== String(row?.name || '').trim().toLowerCase() ? n : '';
}

function startsShort(date) {
  // "Jan 1, 2027" → "Jan 1"
  return goLiveLabel(date).replace(/, \d{4}$/, '');
}

/**
 * One status per row, the most urgent that applies:
 * Request not reached · a red need · Camera offline · N waiting over a day · an amber need · Starts <date> ·
 * Not checked (admin-ops or /admin/clients did not answer for the row) · All good.
 * @returns {{key: 'unreached'|'needs_red'|'camera_offline'|'waiting'|'needs_amber'|'starts'|'unknown'|'ok', label: string, tone: 'red'|'amber'|'blue'|'neutral'|'green'}}
 */
export function statusFor(row, now = Date.now()) {
  if (Number(row?.unreached_request_count) > 0) return { key: 'unreached', label: 'Request not reached', tone: 'red' };
  const needs = list(row?.ops?.needs).filter(n => !OWN_WORDS.test(String(n.key || '')));
  const red = needs.find(n => n.severity === 'red');
  if (red) return { key: 'needs_red', label: red.title, tone: 'red' };
  if (row?.ops && row.ops.cameras > 0 && row.ops.working === false) return { key: 'camera_offline', label: 'Camera offline', tone: 'red' };
  if (waitingLate(row, now)) {
    return { key: 'waiting', label: `${Number(row.pending_registration_count)} waiting over a day`, tone: 'amber' };
  }
  const amber = needs.find(n => n.severity === 'amber');
  if (amber) return { key: 'needs_amber', label: amber.title, tone: 'amber' };
  if (startsLater(row?.go_live_date, now)) return { key: 'starts', label: `Starts ${startsShort(row.go_live_date)}`, tone: 'blue' };
  // No health claim without the data behind it.
  if (row?.ops == null || row?._partial) return { key: 'unknown', label: 'Not checked', tone: 'neutral' };
  return { key: 'ok', label: 'All good', tone: 'green' };
}

/** True when the oldest waiting registration has waited more than a day. */
export function waitingLate(row, now = Date.now()) {
  const oldest = ms(row?.oldest_pending_registration_at);
  return Number(row?.pending_registration_count) > 0 && Number.isFinite(oldest) && now - oldest > LATE_MS;
}

const needsAttention = (row, now) => {
  const tone = statusFor(row, now).tone;
  return tone === 'red' || tone === 'amber';
};

// The order statusFor checks its rules in: an office waiting on us first.
const RANK = { unreached: 0, needs_red: 1, camera_offline: 2, waiting: 3, needs_amber: 4, starts: 5, unknown: 6, ok: 7 };

/** Most urgent first (statusFor's order), then by name. */
export function sortRows(rows, now = Date.now()) {
  return list(rows)
    .map(r => ({ r, rank: RANK[statusFor(r, now).key] ?? 9 }))
    .sort((a, b) => a.rank - b.rank || String(a.r.name || '').localeCompare(String(b.r.name || '')))
    .map(x => x.r);
}

/**
 * The filter chips, with how many rows each keeps: All, Needs attention, one
 * per tow partner (most properties first), Truck plaza when there is one.
 * @returns {Array<{id: string, label: string, count: number}>}
 */
export function filterChips(rows, now = Date.now()) {
  const all = list(rows);
  const partners = new Map();
  for (const r of all) {
    const p = towPartnerOf(r);
    if (!p.id) continue;
    const cur = partners.get(p.id) || { id: `partner:${p.id}`, label: p.name || 'Tow partner', count: 0 };
    cur.count += 1;
    partners.set(p.id, cur);
  }
  const plazas = all.filter(r => r.property_type === 'truck_plaza').length;
  return [
    { id: 'all', label: 'All', count: all.length },
    { id: 'attention', label: 'Needs attention', count: all.filter(r => needsAttention(r, now)).length },
    ...[...partners.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    ...(plazas ? [{ id: 'truck_plaza', label: 'Truck plaza', count: plazas }] : []),
  ];
}

/** The rows a chip and a search keep, in their order. An unknown chip keeps every row. */
export function applyFilter(rows, chipId, query, now = Date.now()) {
  const q = String(query || '').trim().toLowerCase();
  return list(rows).filter(r => {
    if (chipId === 'attention' && !needsAttention(r, now)) return false;
    if (chipId === 'truck_plaza' && r.property_type !== 'truck_plaza') return false;
    if (typeof chipId === 'string' && chipId.startsWith('partner:') && `partner:${towPartnerOf(r).id}` !== chipId) return false;
    if (!q) return true;
    return [r.name, r.address].some(s => String(s || '').toLowerCase().includes(q));
  });
}

/** The resident registration link for an apartment with a QR code, else null. */
export function residentLink(row, origin) {
  return row?.property_type === 'truck_plaza' ? null : registrationLink(String(origin || '').replace(/\/+$/, ''), row?.qr_code_id);
}
