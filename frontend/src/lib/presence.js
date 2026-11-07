// ── Who is on the property now, pure half (build plan F3) ─────
//
// What the Live tab decides without a DOM: the four count tiles, the "here
// 1 h 12 m" phrase, the pass chip a row carries, the who-line an office
// session sees, the people list (by name, the cars with no pass on file
// last), the search over name / unit / plate, the detail panel's labelled
// groups, and the empty states. The payload is `GET
// /apartment/passes/presence` (build plan B3): `has_cameras`, `counts`,
// `on_property` (longest here first) and `recent_exits` (last 24 h). A
// tow-partner session gets the same rows without `pass.name` / `pass.unit`,
// and nothing here invents them: such a session lists by plate.
// `scripts/presence.test.mjs` covers it.

import { fmtPassRemaining } from './time.js';
import { fmtET, normalizePlate } from './holdTime.js';
import { agoPhrase } from './lotStatus.js';
import { evidenceCards, isLongTerm, queueRows, vehicleLine } from './permitsQueue.js';

/** Copy the tab shows when a list is empty, verbatim. */
export const EMPTY_COPY = Object.freeze({
  no_camera: 'No camera is registered at this property yet.',
  no_camera_body: 'Once a camera is registered under Cameras, everyone who drives in appears here within a minute, with their entry photo and the parking pass that covers them.',
  on_property: 'Nobody is on the property right now. The next person to drive in appears here within a minute.',
  recent_exits: 'Nobody has left in the last 24 hours. Departures show here for a day.',
  search: 'Nobody matches',
});

/** The two lists: the people here now, and the ones who left in the last 24 h (collapsed below). */
export const LIST_SEGMENTS = Object.freeze([
  { id: 'on_property', label: 'On the property' },
  { id: 'recent_exits', label: 'Left in the last 24 hours' },
]);

/** The divider above the cars with no pass on file. */
export const NO_PASS_DIVIDER = 'No pass on file';

/** Below this many minutes left, a short-term pass chip turns from green to red. */
export const ENDING_SOON_MINUTES = 60;

const num = (v) => (Number.isFinite(v) ? v : 0);

/** The four count tiles, in order. A missing count reads 0. */
export function presenceTiles(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  return [
    { key: 'on_property', label: 'On the property', value: num(c.on_property) },
    { key: 'covered', label: 'Covered by a pass', value: num(c.covered) },
    { key: 'uncovered', label: 'No pass', value: num(c.uncovered) },
    { key: 'expiring_soon', label: 'Pass ends in 4 h', value: num(c.expiring_soon) },
  ];
}

/** "1 h 12 m" / "12 m" / "under a minute" / "2 d 3 h" from a count of minutes. */
export function spanPhrase(minutes) {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : null;
  if (m === null) return '';
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} m`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** "here 1 h 12 m" — how long the car has been on the property. */
export function hereLine(minutes) {
  const span = spanPhrase(minutes);
  return span ? `here ${span}` : '';
}

/** "stayed 2 h 05 m" — for a car that has left. */
export function stayedLine(minutes) {
  const span = spanPhrase(minutes);
  return span ? `stayed ${span}` : '';
}

/**
 * The pass chip on a row. Text always carries the meaning; the tone is a
 * second cue: green while covered, red when uncovered or about to be, blue
 * for a long-term pass, amber never (the lot's accent is blue).
 */
export function passChip(pass) {
  if (!pass || typeof pass !== 'object') return { tone: 'red', text: 'No pass' };
  if (pass.status === 'pending') return { tone: 'info', text: 'Under review' };
  if (pass.kind === 'long_term') return { tone: 'info', text: 'Long-term' };
  const left = Number.isFinite(pass.minutes_left) ? pass.minutes_left : null;
  if (left === null) return { tone: 'green', text: 'Short-term' };
  if (left <= 0) return { tone: 'red', text: 'Short-term · ended' };
  const phrase = fmtPassRemaining(left * 60000).replace(/ left$/, '');
  return { tone: left < ENDING_SOON_MINUTES ? 'red' : 'green', text: `Short-term · ${phrase} left` };
}

/** "Unit 214 · Pat Example" for an office session; '' when the payload carries neither (a partner). */
export function whoLine(pass) {
  if (!pass || typeof pass !== 'object') return '';
  const unit = String(pass.unit ?? '').trim();
  const name = String(pass.name ?? '').trim();
  return [unit ? `Unit ${unit}` : null, name || null].filter(Boolean).join(' · ');
}

/** The row's sentence: "here 1 h 12 m · Short-term · 2h 10m left". */
export function rowSentence(row, list = 'on_property') {
  const when = list === 'recent_exits' ? stayedLine(row?.minutes_stayed) : hereLine(row?.minutes_here);
  return [when || null, passChip(row?.pass).text].filter(Boolean).join(' · ');
}

/** Case- and punctuation-insensitive "contains" on the plate; an empty query keeps everything. */
export function filterByPlate(rows, q) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = normalizePlate(q);
  if (!needle) return list;
  return list.filter(r => normalizePlate(r?.plate).includes(needle));
}

/** A stable key for a row. */
export function rowKey(row, list) {
  return `${list}:${row?.session_id ?? ''}:${row?.plate ?? ''}`;
}

/** What "Request tow" hands the page: the shape `requestTow(row)` already reads (`plate_text`). */
export function towRow(row) {
  return { plate_text: String(row?.plate ?? '').trim(), vehicle: row?.vehicle ?? null };
}

/** The office (admin / manager) places tow requests; a viewer or the tow company does not. */
export function canRequestTow(role) {
  return role === 'admin' || role === 'manager';
}

// ── The people list ───────────────────────────────────────────

/** The person's name from the linked pass, or '' (no pass, or a partner payload). */
export function personName(row) {
  return String(row?.pass?.name ?? '').trim();
}

/** What heads a row: the name when the payload has one, else the plate. */
export function rowTitle(row) {
  return personName(row) || String(row?.plate ?? '').trim() || '—';
}

const byName = (a, b) => {
  const na = personName(a).toLowerCase();
  const nb = personName(b).toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  return String(a?.plate ?? '').localeCompare(String(b?.plate ?? ''));
};
const byPlate = (a, b) => String(a?.plate ?? '').localeCompare(String(b?.plate ?? ''));

/**
 * The list as people: everyone with a pass on file, alphabetically by name
 * (a partner payload has no names, so those rows sort by plate after the
 * named ones), then under a divider the cars with no pass on file, by plate.
 */
export function peopleRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const withPass = list.filter(r => r.pass && typeof r.pass === 'object');
  const named = withPass.filter(r => personName(r)).sort(byName);
  const unnamed = withPass.filter(r => !personName(r)).sort(byPlate);
  const noPass = list.filter(r => !(r.pass && typeof r.pass === 'object')).sort(byPlate);
  return { people: [...named, ...unnamed], noPass };
}

/**
 * Name, unit or plate. The name matches as typed (case-insensitive); the unit
 * and plate as one run of letters and digits. A search that normalises to
 * nothing keeps every row.
 */
export function matchesSearch(row, q) {
  const raw = String(q ?? '').trim();
  if (!raw) return true;
  const needle = normalizePlate(raw);
  const name = personName(row).toLowerCase();
  if (name && name.includes(raw.toLowerCase())) return true;
  if (!needle) return false;
  return normalizePlate(row?.plate).includes(needle) || normalizePlate(row?.pass?.unit).includes(needle);
}

export function filterPeople(rows, q) {
  return (Array.isArray(rows) ? rows : []).filter(r => matchesSearch(r, q));
}

/** The one-line sentence under the name: "Unit 214 · ABC1234 · white Honda Civic · here 1 h 12 m". */
export function rowSummary(row, list = 'on_property') {
  const unit = String(row?.pass?.unit ?? '').trim();
  const plate = String(row?.plate ?? '').trim();
  const when = list === 'recent_exits' ? stayedLine(row?.minutes_stayed) : hereLine(row?.minutes_here);
  const parts = [unit ? `Unit ${unit}` : null, personName(row) ? plate : null, String(row?.vehicle ?? '').trim() || null, when || null];
  return parts.filter(Boolean).join(' · ');
}

/**
 * The permits-queue row this presence row's pass is (same id, same kind) in
 * the `/apartment/passes/permits` payload, or null. That row carries the
 * documents, the decision and the contact the presence payload does not.
 */
export function findPermitsRow(permitsPayload, pass) {
  if (!pass || pass.id === null || pass.id === undefined) return null;
  const key = `${pass.kind === 'long_term' ? 'resident' : 'guest'}:${pass.id}`;
  return queueRows(permitsPayload).find(r => r.key === key) || null;
}

const PASS_STATUS_WORDS = {
  pending: 'Under review', approved: 'Approved', active: 'Approved', rejected: 'Denied', void: 'Voided',
  expired: 'Ended', cancelled: 'Cancelled', revoked: 'Revoked', towed: 'Towed',
};

/** Time left on the pass, ticking from `until` when the payload has it, else the server's minutes. */
export function timeLeftText(pass, now = Date.now()) {
  if (!pass || pass.kind === 'long_term') return '';
  const until = Date.parse(pass.until ?? '');
  if (Number.isFinite(until)) return fmtPassRemaining(until - now);
  return Number.isFinite(pass.minutes_left) ? fmtPassRemaining(pass.minutes_left * 60000) : '';
}

const str = (v) => String(v ?? '').trim();
const when = (iso, now) => {
  const stamp = fmtET(iso);
  if (!stamp) return '';
  const ago = agoPhrase(iso, now);
  return ago ? `${stamp} (${ago})` : stamp;
};

/**
 * Everything known about one person, as labelled groups for the expanded
 * row. Each group is `{key, label, items: [{label, value}]}`; an item whose
 * value is empty is left out, and a group with no items is left out, so a
 * partner payload (no name, unit, phone, email) simply shows fewer lines.
 * `permitsRow` is the matching approval-queue row when the page has it.
 */
export function detailSections(row, { permitsRow = null, list = 'on_property', now = Date.now(), requireLease = true } = {}) {
  const pass = row?.pass && typeof row.pass === 'object' ? row.pass : null;
  const pr = permitsRow || {};
  const group = (key, label, items) => {
    const kept = items.filter(i => i && str(i.value));
    return kept.length ? { key, label, items: kept } : null;
  };

  const contact = group('contact', 'Contact', [
    { label: 'Name', value: str(pass?.name) || str(pr.holder_name) || str(pr.visitor_name) },
    { label: 'Unit', value: str(pass?.unit) || str(pr.unit_number) || str(pr.host_unit) },
    { label: 'Phone', value: str(pass?.phone) || str(pr.phone) },
    { label: 'Email', value: str(pass?.email) || str(pr.email) },
  ]);

  const vehicle = group('vehicle', 'Vehicle', [
    { label: 'Plate', value: str(row?.plate) },
    { label: 'Make / model / colour', value: str(row?.vehicle) || (permitsRow ? vehicleLine(permitsRow) : '') },
    { label: 'Back plate', value: str(pr.back_plate) },
  ]);

  const passGroup = pass ? group('pass', 'Pass', [
    { label: 'Kind', value: pass.kind === 'long_term' ? 'Long-term' : 'Short-term' },
    { label: 'Status', value: PASS_STATUS_WORDS[str(pass.status)] || str(pass.status) },
    { label: 'Valid', value: [fmtET(pr.valid_from), fmtET(pass.until ?? pr.valid_until)].filter(Boolean).join(' → ') },
    { label: 'Time left', value: timeLeftText(pass, now) },
    { label: 'Filed', value: fmtET(pr.created_at) },
    { label: 'Approved', value: [fmtET(pr.reviewed_at), str(pr.reviewed_by)].filter(Boolean).join(' by ') },
  ]) : group('pass', 'Pass', [{ label: 'Status', value: 'No pass on file' }]);

  const exits = list === 'recent_exits';
  const presence = group('presence', exits ? 'Visit' : 'On the property', [
    { label: 'Entered', value: when(row?.entered_at, now) },
    { label: 'Camera', value: str(row?.camera_name ?? row?.camera) },
    { label: 'Here', value: exits ? '' : spanPhrase(row?.minutes_here) },
    { label: 'Left', value: exits ? when(row?.exited_at, now) : '' },
    { label: 'Stayed', value: exits ? spanPhrase(row?.minutes_stayed) : '' },
  ]);

  const documents = permitsRow ? group('documents', 'Documents', evidenceCards(permitsRow, { requireLease }).map(c => ({
    label: c.title, value: c.present ? 'Provided' : c.notRequired ? 'Not required' : 'Not provided',
  }))) : null;

  return [contact, vehicle, passGroup, presence, documents].filter(Boolean);
}

/** Whether the matching permits row is a long-term pass (its document set differs). */
export function permitsIsLongTerm(permitsRow) {
  return !!permitsRow && isLongTerm(permitsRow);
}
