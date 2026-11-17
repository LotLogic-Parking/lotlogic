// ── Enforcement pause: the pure half ──────────────────────────
//
// Spec 2026-11-16 Part 3, plan Task 11. An office admin stops enforcement at
// their property for a while: no new tow, no new boot, nothing new sent.
// What was already in motion before the pause started (an office tow request,
// a tow notice or boot text already sent) still goes ahead (Gabe 2026-11-17).
// Decided by Gabe: at most 72 hours a pause, and when it ends enforcement resumes right away
// (no fresh grace). The server (lotlogic-backend routers/enforcement_pauses.py)
// enforces every rule; this module only says them first, in the office's
// words, and draws the presets. `scripts/pause.test.mjs` covers it.
//
// Times:
//   * Presets are wall-clock times in Charlotte (America/New_York), so
//     "Tonight" is 6 PM to 7 AM on either side of a DST change; the 72 hours
//     are real hours, as the server counts them.
//   * A start of "now" is sent as `starts_at: null`: the server uses its own
//     clock (contract C), so a slow phone clock never moves the start.
//   * Whether a pause is active, scheduled or over comes from the server's
//     `status`, never from this device's clock (a phone hours fast must not
//     hide a running pause). The pages re-read the pauses every minute, so
//     a pause that ended drops off at the next read.
//
// No fee or amount appears here (CLAUDE.md boot rules).

export const MAX_HOURS = 72;
export const REASON_MAX = 120;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The server accepts a start up to 5 minutes ago. */
const PAST_SLACK_MS = 5 * MIN;
/** …and at most 30 days ahead. */
const AHEAD_MS = 30 * DAY;
/** "Tonight" before 7 AM needs at least this much night left. */
const TONIGHT_MIN_MS = 30 * MIN;
/** Up to this many days after today, a time is named by its weekday alone ("Sat 6:00 PM"). */
const WEEKDAY_DAYS = 6;

const TZ = 'America/New_York';
const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', weekday: 'short',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The wall clock in Charlotte at `ms`: `{y, mo, d, h, mi, wd}` (wd 0 = Sunday). */
function etParts(ms) {
  const out = {};
  for (const p of PARTS.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: Number(out.year), mo: Number(out.month), d: Number(out.day),
    h: Number(out.hour) % 24, mi: Number(out.minute), wd: WEEKDAYS.indexOf(out.weekday),
  };
}

/** Charlotte's offset from UTC at `ms`, in ms (EST −5 h, EDT −4 h). */
function offsetAt(ms) {
  const p = etParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / MIN) * MIN;
}

/**
 * The instant a wall-clock time in Charlotte names. Day overflow is fine
 * (`d + 1` past the month's end rolls over).
 */
export function etWallToMs(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => (v === null || v === undefined || v === '' ? NaN : Date.parse(v));
const clock = (p) => {
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
};

/**
 * "Sat 6:00 PM" from today through the sixth day after it (in Charlotte), where
 * a weekday names one day only; "Fri Dec 4, 6:00 PM" before today or further
 * out. '' for nothing.
 */
export function fmtPauseTime(value, now = Date.now()) {
  const t = typeof value === 'number' ? value : ms(value);
  if (!Number.isFinite(t)) return '';
  const p = etParts(t);
  const n = etParts(now);
  const days = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(n.y, n.mo - 1, n.d)) / DAY);
  if (days >= 0 && days <= WEEKDAY_DAYS) return `${WEEKDAYS[p.wd]} ${clock(p)}`;
  return `${WEEKDAYS[p.wd]} ${MONTHS[p.mo - 1]} ${p.d}, ${clock(p)}`;
}

/** "Sat Nov 21, 7:00 AM": the full day, for a time that may be weeks out (a scheduled start, the resume line). */
export function fmtFull(value) {
  const t = typeof value === 'number' ? value : ms(value);
  if (!Number.isFinite(t)) return '';
  const p = etParts(t);
  return `${WEEKDAYS[p.wd]} ${MONTHS[p.mo - 1]} ${p.d}, ${clock(p)}`;
}

/** "13 hours", "1 hour 30 minutes", "45 minutes"; three hours and up round to the hour. */
export function durationText(span) {
  const mins = Math.max(0, Math.round(span / MIN));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (mins < 60) return plural(mins, 'minute');
  if (mins >= 180) return plural(Math.round(mins / 60), 'hour');
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

// ── The sheet ─────────────────────────────────────────────────

/**
 * The three quick windows, worked out in Charlotte at `now`:
 *   * Tonight: 6 PM to 7 AM. After 6 PM, or before 7 AM, it is the rest of
 *     the night still running (now to 7 AM); from 6:30 AM, this evening's.
 *   * Next 24 hours: now to now + 24 h.
 *   * This weekend: Friday 6 PM to Sunday 11:59 PM of this week; during the
 *     weekend it starts now. Gone from Sunday 6 PM (that evening is Tonight).
 * A window that starts now carries `startsNow` and sends `starts_at: null`.
 * @returns {Array<{id: 'tonight'|'24h'|'weekend', label: string, hint: string, starts_at: string, ends_at: string, startsNow: boolean}>}
 */
export function pausePresets(now = Date.now()) {
  const p = etParts(now);
  const at = (dayOffset, h, mi = 0) => etWallToMs(p.y, p.mo, p.d + dayOffset, h, mi);
  const out = [];

  let start;
  let end;
  // Before 7 AM it is the rest of this night, unless under half an hour of it
  // is left: a pause of a few minutes is no use, and could reach the server
  // after 7:00 and be refused. Then Tonight is this evening's.
  if (p.h < 7 && at(0, 7) - now >= TONIGHT_MIN_MS) { start = now; end = at(0, 7); }
  else if (p.h < 7) { start = at(0, 18); end = at(1, 7); }
  else if (p.h < 18) { start = at(0, 18); end = at(1, 7); }
  else { start = now; end = at(1, 7); }
  out.push(windowOf('tonight', 'Tonight', start, end, now, (s, e, nowStart) => `${nowStart ? 'Now' : clock(etParts(s))} – ${clock(etParts(e))}`));

  out.push(windowOf('24h', 'Next 24 hours', now, now + DAY, now, (s, e) => `Until ${fmtPauseTime(e, now)}`));

  const toFriday = p.wd === 0 ? -2 : p.wd === 6 ? -1 : 5 - p.wd;
  const friday = at(toFriday, 18);
  const sunday = at(toFriday + 2, 23, 59);
  const sundayEvening = p.wd === 0 && p.h >= 18;
  if (!sundayEvening && sunday > now) {
    const ws = Math.max(now, friday);
    if (sunday - ws <= MAX_HOURS * HOUR) {
      out.push(windowOf('weekend', 'This weekend', ws, sunday, now, (s, e, nowStart) => `${nowStart ? 'Now' : fmtPauseTime(s, now)} – ${fmtPauseTime(e, now)}`));
    }
  }
  return out;
}

function windowOf(id, label, start, end, now, hintOf) {
  const startsNow = start <= now;
  return { id, label, hint: hintOf(start, end, startsNow), starts_at: iso(start), ends_at: iso(end), startsNow };
}

/**
 * The first rule a window breaks, with the server's code, or null. `starts_at`
 * null (or a `startsNow` window) is now. Same order as the server checks; the
 * start is clamped to now first, as the server does.
 * @returns {null|'missing'|'ends_before_start'|'too_long'|'starts_in_past'|'too_far_ahead'}
 */
export function validatePause({ starts_at, ends_at, startsNow = false, now = Date.now() }) {
  const given = startsNow || starts_at === null || starts_at === undefined ? now : ms(starts_at);
  const end = ms(ends_at);
  if (!Number.isFinite(given) || !Number.isFinite(end)) return 'missing';
  const start = Math.max(given, now);
  if (end <= start) return 'ends_before_start';
  if (end - start > MAX_HOURS * HOUR) return 'too_long';
  if (given < now - PAST_SLACK_MS) return 'starts_in_past';
  if (given > now + AHEAD_MS) return 'too_far_ahead';
  return null;
}

/** The reason as the server stores it: spaces collapsed, trimmed. */
export function cleanReason(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** The POST body for a window and a reason. */
export function pauseBody(win, reason) {
  const r = cleanReason(reason);
  return { starts_at: win.startsNow ? null : win.starts_at, ends_at: win.ends_at, reason: r || null };
}

/**
 * What the sheet shows before Save: the window, how long it is, and when
 * enforcement comes back.
 */
export function pauseSummary(win, now = Date.now()) {
  const start = win.startsNow ? now : ms(win.starts_at);
  const end = ms(win.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    when: `${win.startsNow ? 'Now' : fmtPauseTime(start, now)} – ${fmtPauseTime(end, now)}`,
    length: durationText(end - Math.max(start, now)),
    resumes: `Enforcement resumes ${fmtFull(end)}`,
  };
}

const COPY = {
  missing: 'Pick a start and an end.',
  ends_before_start: 'The end has to be after the start.',
  too_long: `A pause can be at most ${MAX_HOURS} hours.`,
  starts_in_past: 'That start has already passed. Pick a time from now on.',
  too_far_ahead: 'A pause can start at most 30 days from now.',
  too_many_scheduled: 'There are already 3 pauses scheduled here. Cancel one to add another.',
  overlaps: 'There is already a pause then.',
  reason_too_long: `Keep the reason to ${REASON_MAX} characters.`,
  not_enabled: 'Pausing enforcement is not turned on yet. Ask LotLogic to turn it on.',
  not_apartment: 'Enforcement can only be paused at an apartment property.',
  not_started: 'This pause has not started yet. Cancel it instead.',
  already_started: 'This pause has already started. End it instead.',
  already_ended: 'This pause has already ended.',
  already_cancelled: 'This pause was already cancelled.',
  pause_not_found: 'This pause is no longer here. Refresh to see the latest.',
  forbidden: 'Only an admin of this property can pause enforcement.',
};

/**
 * The office's sentence for a refusal code (`extra` = the error body, for
 * `overlaps`). `earliest_start` is itself an allowed start, so "from", and
 * it is said with its date, as every pause time that may be days out is.
 */
export function pauseErrorText(code, extra = {}) {
  if (code === 'overlaps') {
    const from = fmtFull(extra?.earliest_start) || String(extra?.earliest_start_local || '').replace(/ ET$/, '');
    if (from) return `${COPY.overlaps} You can pause again from ${from}.`;
  }
  return COPY[code] || 'That did not go through. Try again.';
}

/** `{code, text}` for an apiFetch error from a pause route. */
export function pauseApiError(err) {
  let code = typeof err?.code === 'string' ? err.code : '';
  if (err?.status === 404 && code === 'Property not found') code = 'forbidden';
  if (err?.status === 403) code = 'forbidden';
  return { code, text: pauseErrorText(code, err?.body || {}) };
}

/** Typed into a `datetime-local` box, read as Charlotte time. NaN when empty. */
export function fromInputValue(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return NaN;
  return etWallToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * The window "Pick a time" describes. A start a moment ago (within the
 * server's 5 minutes) is "now" and is sent as null; one further back is kept
 * as typed, so validatePause says it has passed instead of quietly starting
 * the pause now.
 */
export function customWindow(startValue, endValue, now = Date.now()) {
  const s = fromInputValue(startValue);
  const e = fromInputValue(endValue);
  return {
    startsNow: Number.isFinite(s) && s <= now && s >= now - PAST_SLACK_MS,
    starts_at: Number.isFinite(s) ? iso(s) : '',
    ends_at: Number.isFinite(e) ? iso(e) : '',
  };
}

/** `t` rounded down to the quarter hour (Charlotte's offset is whole hours), for a picker's `min`. */
export function quarterFloor(t) {
  return Math.floor(t / (15 * MIN)) * 15 * MIN;
}

/** The `datetime-local` value for an instant, in Charlotte time. */
export function toInputValue(t) {
  const p = etParts(t);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.y}-${two(p.mo)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}

// ── Banners and lines ─────────────────────────────────────────

const LIVE = new Set(['active', 'scheduled']);

/**
 * Worth a banner: the server said active or scheduled when it was last read.
 * Not this device's clock, which may be hours off (brainstorm 2.10): the
 * pages re-read every minute, and the server drops a pause that is over.
 */
function showing(p) {
  return !!p && LIVE.has(p.status);
}

/**
 * A running pause says its end the short way ("until Wed 6:00 PM"); a
 * scheduled one always says its start with the date, since it can be weeks
 * out, and its end relative to that start (brainstorm 2.11).
 */
function titleOf(p, now) {
  return p.status === 'active'
    ? `Enforcement paused until ${fmtPauseTime(p.ends_at, now)}`
    : `Enforcement pause scheduled ${fmtFull(p.starts_at)} – ${fmtPauseTime(p.ends_at, ms(p.starts_at))}`;
}

/** One line for a pause: the title, then the reason when there is one. */
export function pauseLine(p, now = Date.now()) {
  if (!showing(p)) return '';
  const reason = cleanReason(p.reason);
  return reason ? `${titleOf(p, now)} · ${reason}` : titleOf(p, now);
}

/**
 * Every banner for a property: the running pause first, then the scheduled
 * ones by start. `action` is what its button does: `end` (End now) or
 * `cancel` (Cancel).
 * @returns {Array<{pauseId: string, kind: 'active'|'scheduled', title: string, reason: string, text: string, action: 'end'|'cancel'}>}
 */
export function pauseBanners(pauses, now = Date.now()) {
  return (Array.isArray(pauses) ? pauses : [])
    .filter(p => showing(p))
    .sort((a, b) => (a.status === b.status ? ms(a.starts_at) - ms(b.starts_at) : a.status === 'active' ? -1 : 1))
    .map(p => ({
      pauseId: p.id,
      kind: p.status,
      title: titleOf(p, now),
      reason: cleanReason(p.reason),
      text: pauseLine(p, now),
      action: p.status === 'active' ? 'end' : 'cancel',
    }));
}

/** The top banner (plan's interface): `{text, pauseId, canEnd}` or null. */
export function pauseBanner(pauses, now = Date.now()) {
  const [first] = pauseBanners(pauses, now);
  return first ? { text: first.text, pauseId: first.pauseId, canEnd: first.action === 'end' } : null;
}

/**
 * The line under a tow request in a paused property's group, so the card
 * never reads as an order the pause has taken back. Gabe 2026-11-17 (binding):
 * a pause holds only NEW enforcement, so every open tow request stands, and
 * the curb check (backend contract C) answers TOW REQUESTED for it: one placed
 * during the pause, and one placed before it, which was already in motion.
 * '' for anything but a tow request, or with no running pause.
 */
export const PLACED_BEFORE = 'Placed before the pause — still stands';
export const DURING_PAUSE = 'Requested by the office during the pause';

export function towPauseNote(item, pause) {
  if (item?.kind !== 'tow' || !pause || pause.status !== 'active') return '';
  const made = ms(item.created_at);
  const start = ms(pause.starts_at);
  if (!Number.isFinite(made) || !Number.isFinite(start)) return '';
  return made >= start ? DURING_PAUSE : PLACED_BEFORE;
}

/**
 * The pause sheet's line before Save (contract C `open_before_pause_count`
 * on GET …/pauses): open office tow requests, and camera tow notices or boot
 * texts already sent, at the property now. They were in motion before the
 * pause, so they still go ahead through it. '' when there are none.
 */
export function openBeforeText(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return '';
  return n === 1
    ? '1 open tow request or tow notice from before will still go ahead.'
    : `${n} open tow requests and tow notices from before will still go ahead.`;
}

/** Why a towable car is listed on the Lot status tab during a pause (contract C `towable[].pause_note`). */
export function lotPauseNote(note) {
  switch (note) {
    case 'placed_before_pause': return PLACED_BEFORE;
    case 'during_pause': return DURING_PAUSE;
    case 'flagged_before_pause': return 'Tow notice sent before the pause — still stands';
    default: return '';
  }
}

/**
 * The tow company's Requests tab: each property group gains `pauses` (its
 * banners, the running one first) and `notes` (request id → towPauseNote).
 * A property that is paused but has no open request still gets a group, at
 * the top, so the pause is never missed.
 */
export function withPauses(groups, pauses, now = Date.now()) {
  const list = Array.isArray(pauses) ? pauses : [];
  const byProperty = new Map();
  for (const p of list) {
    if (!showing(p)) continue;
    const id = p.property_id || '';
    if (!byProperty.has(id)) byProperty.set(id, []);
    byProperty.get(id).push(p);
  }
  const known = new Set((groups || []).map(g => g.propertyId));
  const extra = [...byProperty.entries()]
    .filter(([id]) => !known.has(id))
    .map(([id, ps]) => ({ propertyId: id, propertyName: ps[0].property_name || id, propertyVerified: true, count: 0, items: [] }))
    .sort((a, b) => a.propertyName.localeCompare(b.propertyName));
  return [...extra, ...(groups || [])].map(g => {
    const mine = byProperty.get(g.propertyId) || [];
    const running = mine.find(p => p.status === 'active') || null;
    const notes = {};
    for (const item of g.items || []) {
      const note = towPauseNote(item, running);
      if (note && item?.id != null) notes[item.id] = note;
    }
    return { ...g, pauses: pauseBanners(mine, now), notes };
  });
}

// ── The gap rule, before Save ─────────────────────────────────

/** Pauses at one property need a full day between them (the server's `overlaps`). */
export const GAP_HOURS = 24;

/**
 * The live pause a window would run into, or null: the server refuses a
 * window that starts within a day after a pause ends, or ends within a day
 * before one starts (its exclusion `[start, end + 24 h)` on both sides).
 * `pauses` are the property's pauses as last read.
 */
export function clashingPause(win, pauses, now = Date.now()) {
  if (!win) return null;
  const start = Math.max(win.startsNow ? now : ms(win.starts_at), now);
  const end = ms(win.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  for (const p of Array.isArray(pauses) ? pauses : []) {
    if (!showing(p)) continue;
    const ps = ms(p.starts_at);
    const pe = ms(p.ends_at);
    if (!Number.isFinite(ps) || !Number.isFinite(pe)) continue;
    if (start < pe + GAP_HOURS * HOUR && ps < end + GAP_HOURS * HOUR) return p;
  }
  return null;
}

/** The hint on a quick window that runs into another pause. */
export function clashText(p) {
  return p?.status === 'active' ? 'Too close to the pause running now' : `Too close to the pause on ${fmtFull(p?.starts_at).replace(/,.*$/, '')}`;
}

/**
 * After a refused or lost Save: is the pause in the way the one this Save
 * asked for? Same planned end (the window the office chose), so the pause
 * they wanted is there, whoever made it; the sheet closes onto its banner
 * instead of saying there is a pause in the way.
 */
export function isSamePause(conflict, body) {
  if (!conflict || !body) return false;
  const a = ms(conflict.planned_ends_at ?? conflict.ends_at);
  const b = ms(body.ends_at);
  return Number.isFinite(a) && a === b && (conflict.status === 'active' || conflict.status === 'scheduled');
}

// ── Lot status (contract C: `pause` on GET /apartment/passes/lot-status) ──

/**
 * The line at the top of the Lot status tab, and in place of the towable
 * list, while the property is paused: `{title, reason}` or null. While the
 * pause is on, `towable` lists only the cars something was already in motion
 * for (contract C), each with its `pause_note`.
 */
export function lotStatusPause(pause, now = Date.now()) {
  if (!pause) return null;
  const until = fmtPauseTime(pause.ends_at, now) || String(pause.ends_local || '').replace(/ ET$/, '');
  // Something already in motion before the pause still goes ahead (Gabe
  // 2026-11-17), and is then listed as towable: not a blanket DO NOT TOW.
  if (Number(pause.open_before_pause_count) > 0) {
    return {
      title: `Enforcement paused${until ? ` until ${until}` : ''} — requests placed before the pause still stand`,
      reason: cleanReason(pause.reason),
    };
  }
  return {
    title: until ? `DO NOT TOW — enforcement paused until ${until}` : 'DO NOT TOW — enforcement paused',
    reason: cleanReason(pause.reason),
  };
}
