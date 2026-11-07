// ── Violations at a property, pure half (build plan F4) ──────
//
// `GET /apartment/passes/violations?property_id=&days=` (build plan B4) is
// one list, newest first, of three origins: a tow request the office filed
// (`tow_request`), a short-term pass that ended with the car not seen leaving
// (`expired_pass`), and a camera violation (`camera`). This module names each
// origin, reads each status, decides which rows offer "Request tow" (only a
// pass that ended: a tow request already is one, a camera violation has its
// own flow), and filters. `name` / `unit` are absent for a partner session and
// nothing here adds them. `scripts/violations.test.mjs` covers it.

import { fmtET, normalizePlate } from './holdTime.js';
import { agoPhrase } from './lotStatus.js';

export const DAY_OPTIONS = Object.freeze([7, 30, 90]);
export const DEFAULT_DAYS = 30;

/** The segmented control, in order. "All" is the default. */
export const KIND_SEGMENTS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'tow_request', label: 'Tow requests' },
  { id: 'expired_pass', label: 'Passes ended' },
  { id: 'camera', label: 'Camera' },
]);

const ORIGINS = {
  tow_request: { label: 'Tow request', tone: 'info' },
  expired_pass: { label: 'Pass ended', tone: 'red' },
  camera: { label: 'Camera', tone: 'neutral' },
};

/** The origin tag: where the row came from, as a word, never a colour alone. */
export function originTag(kind) {
  return ORIGINS[kind] || { label: 'Violation', tone: 'neutral' };
}

const humanize = (s) => {
  const text = String(s ?? '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};

const TOW_STATUS = {
  active: { tone: 'info', text: 'Open' },
  acknowledged: { tone: 'info', text: 'Truck on the way' },
  fulfilled: { tone: 'green', text: 'Done' },
  declined: { tone: 'neutral', text: 'Declined' },
  removed: { tone: 'neutral', text: 'Withdrawn' },
  expired: { tone: 'neutral', text: 'Expired' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
};

const CAMERA_STATUS = {
  open: { tone: 'info', text: 'Open' },
  pending: { tone: 'info', text: 'Open' },
  resolved: { tone: 'green', text: 'Resolved' },
  dismissed: { tone: 'neutral', text: 'Dismissed' },
  towed: { tone: 'green', text: 'Towed' },
};

/** The status tag for a row, by origin. Unknown statuses read as the server spells them. */
export function statusTag(item) {
  const status = String(item?.status ?? '').toLowerCase();
  if (item?.kind === 'tow_request') return TOW_STATUS[status] || { tone: 'neutral', text: humanize(status) || 'Unknown' };
  if (item?.kind === 'expired_pass') return { tone: 'red', text: 'Still on the property' };
  if (item?.kind === 'camera') return CAMERA_STATUS[status] || { tone: 'neutral', text: humanize(status) || 'Unknown' };
  return { tone: 'neutral', text: humanize(status) || 'Unknown' };
}

/** "Request tow" only where no request exists yet: a pass that ended with the car still here. */
export function canRequestTow(item) {
  return item?.kind === 'expired_pass';
}

/** "2h ago · Thu Oct 15, 3:00 PM ET". */
export function whenLine(at, now = Date.now()) {
  const stamp = fmtET(at);
  if (!stamp) return '';
  const ago = agoPhrase(at, now);
  return ago ? `${ago} · ${stamp}` : stamp;
}

/** "Unit 214 · Pat Example" for an office session; '' when the payload carries neither. */
export function whoLine(item) {
  const unit = String(item?.unit ?? '').trim();
  const name = String(item?.name ?? '').trim();
  return [unit ? `Unit ${unit}` : null, name || null].filter(Boolean).join(' · ');
}

/** Rows per origin, plus `all` — what the segmented control shows. */
export function kindCounts(items) {
  const counts = { all: 0, tow_request: 0, expired_pass: 0, camera: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    counts.all += 1;
    if (counts[item.kind] !== undefined) counts[item.kind] += 1;
  }
  return counts;
}

/** The rows for one segment after a plate search; newest first as the server sent them. */
export function filterViolations(items, { kind = 'all', q = '' } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const needle = normalizePlate(q);
  return list.filter(item =>
    (kind === 'all' || item.kind === kind) &&
    (!needle || normalizePlate(item.plate).includes(needle)));
}

/** The one-line empty state for a segment over `days` days. */
export function emptyLine(kind, days) {
  const window = `in the last ${days} day${days === 1 ? '' : 's'}`;
  switch (kind) {
    case 'tow_request': return `No tow requests ${window}. One appears here the moment the office files it.`;
    case 'expired_pass': return `No short-term pass ended with the car still here ${window}.`;
    case 'camera': return `No camera violations ${window}. They appear here as the camera records them.`;
    default: return `No violations ${window}. Tow requests, passes that ended with the car still here, and camera violations appear here as they happen.`;
  }
}

/** The number of days, clamped to the picker's choices (nearest wins). */
export function clampDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return DAY_OPTIONS.reduce((best, d) => (Math.abs(d - n) < Math.abs(best - n) ? d : best), DAY_OPTIONS[0]);
}

/**
 * How a photo URL is loaded. The tow-request photo is the backend's own
 * `/tow-requests/{id}/photo`, which needs the session's Bearer header (an
 * `<img src>` cannot carry one); a camera frame is a public storage URL.
 * @returns {'none'|'api'|'direct'}
 */
export function photoSource(url, api = '') {
  const u = String(url ?? '').trim();
  if (!u) return 'none';
  if (u.startsWith('/')) return 'api';
  if (api && u.startsWith(api)) return 'api';
  return 'direct';
}

/** What "Request tow" hands the page: the shape `requestTow(row)` already reads (`plate_text`). */
export function towRow(item) {
  return { plate_text: String(item?.plate ?? '').trim(), vehicle: item?.vehicle ?? null };
}

/** A stable key for a row. */
export function rowKey(item) {
  return `${item?.kind ?? ''}:${item?.id ?? ''}:${item?.plate ?? ''}`;
}
