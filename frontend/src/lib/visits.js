// ── Visits: one row per car per pass, pure half ───────────────
//
// A visit is a `plate_sessions` row: the camera saw a plate enter, and later
// saw it leave. The Traffic tab lists them newest first, each with the one
// entry photo and the one exit photo the pipeline chose for it (the sharpest
// frame of each burst, see camera-snapshot/best_frame.ts), the plate, when it
// came in, when it left or that it is still here, and how long it stayed.
// Gabe, 2026-11-11: "one vehicle per snap, so a car entered, seen it, one
// picture and evidence row for it, and then the exit, this should be in the
// traffic." `scripts/visits.test.mjs` covers it.

import { fmtETStamp } from './holdTime.js';
import { spanPhrase } from './presence.js';

export const VISITS_EMPTY = 'No visits yet. The next car the camera sees entering appears here with its photo, and again when it leaves.';

const ms = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The embedded event PostgREST returns as an object or a one-element array. */
function one(v) {
  if (Array.isArray(v)) return v[0] ?? null;
  return v && typeof v === 'object' ? v : null;
}

/** Plain words for the session state the office cares about. */
export function visitStatus(session) {
  if (session?.exited_at) return 'left';
  return 'here';
}

/**
 * One list row per session. `in` is always present; `out` is null while the
 * car is still on the property. Photos are URLs or null; the row shows the
 * plate badge where a photo is missing.
 */
export function visitRow(session, now = Date.now()) {
  const entry = one(session?.entry);
  const exit = one(session?.exit);
  const inAt = session?.entered_at ?? null;
  const outAt = session?.exited_at ?? null;
  const end = ms(outAt) ?? ms(now);
  const start = ms(inAt);
  const minutes = start !== null && end !== null ? Math.max(0, Math.round((end - start) / 60000)) : null;
  const status = visitStatus(session);
  const span = minutes === null ? '' : spanPhrase(minutes);
  return {
    id: session?.id ?? '',
    plate: session?.plate_text || session?.normalized_plate || '',
    status,
    stay: span ? (status === 'left' ? `stayed ${span}` : `here ${span}`) : '',
    in: { at: inAt, label: inAt ? `In ${fmtETStamp(inAt)}` : '', photo: entry?.image_url || null },
    out: outAt ? { at: outAt, label: `Out ${fmtETStamp(outAt)}`, photo: exit?.image_url || null } : null,
    covered: !!(session?.visitor_pass_id || session?.resident_plate_id),
  };
}

/** Newest first; a car still here sorts by when it came in like any other. */
export function visitRows(sessions, now = Date.now()) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list
    .map(s => visitRow(s, now))
    .filter(r => r.id)
    .sort((a, b) => (ms(b.in.at) ?? 0) - (ms(a.in.at) ?? 0));
}

/** "12 visits · 3 still here" for the card head. */
export function visitsSummary(rows) {
  const n = rows.length;
  const here = rows.filter(r => r.status === 'here').length;
  if (n === 0) return '';
  const visits = `${n} visit${n === 1 ? '' : 's'}`;
  return here ? `${visits} · ${here} still here` : visits;
}
