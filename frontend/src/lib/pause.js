// ── Enforcement pause: the pure half ──────────────────────────
//
// Spec 2026-11-16 Part 3, plan Task 11. An office admin stops enforcement at
// their property for a while: no tow, no boot, nothing sent. Decided by Gabe:
// at most 72 hours a pause, and when it ends enforcement resumes right away
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
//   * Whether a pause is active or scheduled comes from the server's
//     `status`, never from this device's clock. The one local check is that
//     a pause whose `ends_at` has passed is no longer shown as running.
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

/** "Sat Nov 21, 7:00 AM": the full day, for the one line that says when enforcement resumes. */
function fmtFull(t) {
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
 *     the night still running (now to 7 AM).
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
  if (p.h < 7) { start = now; end = at(0, 7); }
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

/** The office's sentence for a refusal code (`extra` = the error body, for `overlaps`). */
export function pauseErrorText(code, extra = {}) {
  if (code === 'overlaps' && extra?.earliest_start_local) {
    return `${COPY.overlaps} You can pause again after ${extra.earliest_start_local}.`;
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

/** The `datetime-local` value for an instant, in Charlotte time. */
export function toInputValue(t) {
  const p = etParts(t);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.y}-${two(p.mo)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}

// ── Banners and lines ─────────────────────────────────────────

const LIVE = new Set(['active', 'scheduled']);

/** Still worth a banner: the server says active or scheduled, and its end is ahead. */
function showing(p, now) {
  return p && LIVE.has(p.status) && !(ms(p.ends_at) <= now);
}

function titleOf(p, now) {
  return p.status === 'active'
    ? `Enforcement paused until ${fmtPauseTime(p.ends_at, now)}`
    : `Enforcement pause scheduled ${fmtPauseTime(p.starts_at, now)} – ${fmtPauseTime(p.ends_at, now)}`;
}

/** One line for a pause: the title, then the reason when there is one. */
export function pauseLine(p, now = Date.now()) {
  if (!showing(p, now)) return '';
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
    .filter(p => showing(p, now))
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
 * The tow company's Requests tab: each property group gains `pauses` (its
 * banners, the running one first). A property that is paused but has no open
 * request still gets a group, at the top, so the pause is never missed.
 */
export function withPauses(groups, pauses, now = Date.now()) {
  const list = Array.isArray(pauses) ? pauses : [];
  const byProperty = new Map();
  for (const p of list) {
    if (!showing(p, now)) continue;
    const id = p.property_id || '';
    if (!byProperty.has(id)) byProperty.set(id, []);
    byProperty.get(id).push(p);
  }
  const known = new Set((groups || []).map(g => g.propertyId));
  const extra = [...byProperty.entries()]
    .filter(([id]) => !known.has(id))
    .map(([id, ps]) => ({ propertyId: id, propertyName: ps[0].property_name || id, propertyVerified: true, count: 0, items: [] }))
    .sort((a, b) => a.propertyName.localeCompare(b.propertyName));
  return [...extra, ...(groups || [])].map(g => ({ ...g, pauses: pauseBanners(byProperty.get(g.propertyId) || [], now) }));
}
