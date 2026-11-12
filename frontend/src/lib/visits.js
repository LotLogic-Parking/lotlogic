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

/** Local calendar day (ET is what the office thinks in; the server's day buckets agree). */
function dayKey(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * The Traffic tab's numbers, from the visits themselves (Gabe, 2026-11-11:
 * visits per day, busiest hours, average dwell; not the registration
 * counters). `avgStayMinutes` and `medianStayMinutes` count closed visits
 * only; a car still here has no stay yet. Null when there is nothing to
 * average.
 */
export function visitMetrics(sessions, now = Date.now()) {
  const list = Array.isArray(sessions) ? sessions.filter(s => s && s.entered_at) : [];
  const stays = list
    .filter(s => s.exited_at)
    .map(s => (ms(s.exited_at) - ms(s.entered_at)) / 60000)
    .filter(m => Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b);
  const perDayMap = new Map();
  for (const s of list) {
    const k = dayKey(s.entered_at);
    if (k) perDayMap.set(k, (perDayMap.get(k) || 0) + 1);
  }
  const perDay = [...perDayMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, count]) => ({ day, count }));
  const todayKey = dayKey(new Date(now).toISOString());
  const mid = stays.length ? (stays.length % 2 ? stays[(stays.length - 1) / 2] : (stays[stays.length / 2 - 1] + stays[stays.length / 2]) / 2) : null;
  return {
    total: list.length,
    today: perDayMap.get(todayKey) || 0,
    stillHere: list.filter(s => !s.exited_at).length,
    closed: stays.length,
    avgStayMinutes: stays.length ? stays.reduce((a, b) => a + b, 0) / stays.length : null,
    medianStayMinutes: mid,
    perDay,
  };
}

/** "12 visits · 3 still here" for the card head. */
export function visitsSummary(rows) {
  const n = rows.length;
  const here = rows.filter(r => r.status === 'here').length;
  if (n === 0) return '';
  const visits = `${n} visit${n === 1 ? '' : 's'}`;
  return here ? `${visits} · ${here} still here` : visits;
}
