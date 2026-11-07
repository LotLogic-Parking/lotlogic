// ── Who is on the property now, pure half (build plan F3) ─────
//
// What the Live tab decides without a DOM: the four count tiles, the "here
// 1 h 12 m" phrase, the pass chip a row carries, the who-line an office
// session sees, and the empty states. The payload is `GET
// /apartment/passes/presence` (build plan B3): `has_cameras`, `counts`,
// `on_property` (longest here first) and `recent_exits` (last 24 h). A
// tow-partner session gets the same rows without `pass.name` / `pass.unit`,
// and nothing here invents them. `scripts/presence.test.mjs` covers it.

import { fmtPassRemaining } from './time.js';
import { normalizePlate } from './holdTime.js';

/** Copy the tab shows when a list is empty, verbatim. */
export const EMPTY_COPY = Object.freeze({
  no_camera: 'No camera is registered at this property yet.',
  no_camera_body: 'Once a camera is registered under Cameras, every car that drives in appears here within a minute, with its entry photo and the parking pass that covers it.',
  on_property: 'No cars on the property right now. The next one to drive in appears here within a minute.',
  recent_exits: 'No car has left in the last 24 hours. Departures show here for a day.',
  search: 'No plates match',
});

/** The segmented control, in order. "On the property" is the default. */
export const LIST_SEGMENTS = Object.freeze([
  { id: 'on_property', label: 'On the property' },
  { id: 'recent_exits', label: 'Left today' },
]);

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
