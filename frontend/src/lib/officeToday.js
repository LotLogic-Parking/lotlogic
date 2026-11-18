// ── Today: the leasing office's home screen, pure half ───────
//
// Spec 2026-11-16 Part 1 ("Today at a glance"): three tiles that say what is
// happening and what needs the office, the registrations to approve, and a
// plate check. Everything here is decided without a DOM;
// `scripts/officeToday.test.mjs` covers it.
//
// Rules the tiles keep (spec "Anti-goals", plan "Review Focus"):
//   * A number that could not be loaded is a dash, never 0.
//   * A property with no camera never claims to count the cars on it: the
//     first tile becomes "Registered vehicles".
//   * "This week" is Monday 00:00 in Charlotte to now (the backend counts it).
//   * The office never sees a fee or an amount: the third tile is a count.
//
// Copy follows the Passes screen (Resident / Visitor, Gabe 2026-11-11), as the
// spec's Wording section says; if the parking-pass-only rule wins, both change.

import { passesSummary, splitPresence } from './passes.js';
import { fmtETStamp } from './holdTime.js';
import { isLongTerm, normalizePlate, segmentCounts, segmentOf, unitText, vehicleLine } from './permitsQueue.js';

/** What a tile shows when its number did not load. */
export const DASH = '—';

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD`: the calendar day in Charlotte at `nowMs`. */
export function etDateKey(nowMs = Date.now()) {
  return ET_DAY.format(new Date(nowMs));
}

/** `"2027-01-01"` → `"Jan 1, 2027"`. Read as text, so no time zone can move the day. */
export function goLiveLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** True when the property's go-live day is still ahead (in Charlotte). */
export function startsLater(goLiveDate, nowMs = Date.now()) {
  const label = goLiveLabel(goLiveDate);
  return !!label && String(goLiveDate) > etDateKey(nowMs);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * The three tiles, in order: on the property (or registered), waiting for the
 * office, towed or booted this week.
 *
 * @param {object} p
 * @param {object|null} p.presence  `GET /apartment/passes/presence`, null while loading or after a failure
 * @param {object|null} [p.counts]  `segmentCounts(rows)` from the approval queue, null until it loads
 * @param {Array|null} [p.permitsRows] queue rows, when the caller holds them instead of counts
 * @param {object|null} p.summary   `GET /apartment/properties/{id}/summary`, null while loading or after a failure
 * @param {boolean} [p.cameras]     the property's `features.cameras`, for the label before presence lands
 * @param {string|null} [p.goLiveDate] the property's own `go_live_date` (`/auth/me`), so "Enforcement starts"
 *                                  still shows when the summary failed
 * @param {number} [p.now]
 * @returns {Array<{id: 'onsite'|'waiting'|'enforced', label: string, value: string, sub: string, tone: 'plain'|'attention'}>}
 */
export function todayTiles({ presence, counts = null, permitsRows = null, summary, cameras, goLiveDate = null, now = Date.now() }) {
  const queue = counts || (Array.isArray(permitsRows) ? segmentCounts(permitsRows, '', now) : null);

  const hasCameras = typeof presence?.has_cameras === 'boolean' ? presence.has_cameras : cameras !== false;
  let onsite;
  if (!hasCameras) {
    const n = num(queue?.approved);
    onsite = { id: 'onsite', label: 'Registered vehicles', value: n === null ? DASH : String(n), sub: n === null ? '' : 'with an approved parking pass', tone: 'plain' };
  } else if (!presence) {
    onsite = { id: 'onsite', label: 'Cars on the property now', value: DASH, sub: '', tone: 'plain' };
  } else {
    const s = passesSummary(splitPresence(presence.on_property));
    onsite = {
      id: 'onsite', label: 'Cars on the property now', value: String(s.residents + s.visitors),
      sub: `${plural(s.residents, 'resident', 'residents')} · ${plural(s.visitors, 'visitor', 'visitors')}`, tone: 'plain',
    };
  }

  const pending = num(queue?.pending) ?? num(summary?.pending_registration_count);
  const waiting = {
    id: 'waiting', label: 'Waiting for you', value: pending === null ? DASH : String(pending),
    sub: pending === null ? '' : pending === 0 ? 'nothing to approve' : pending === 1 ? 'registration to approve' : 'registrations to approve',
    tone: pending > 0 ? 'attention' : 'plain',
  };

  const tows = num(summary?.tows_this_week);
  const boots = num(summary?.boots_this_week);
  const known = summary && tows !== null && boots !== null;
  const goLive = summary?.go_live_date ?? goLiveDate;
  const enforced = {
    id: 'enforced', label: 'Towed or booted this week', value: known ? String(tows + boots) : DASH,
    sub: startsLater(goLive, now) ? `Enforcement starts ${goLiveLabel(goLive)}` : !summary ? '' : 'since Monday',
    tone: 'plain',
  };

  return [onsite, waiting, enforced];
}

// ── Check a plate ─────────────────────────────────────────────

const samePlate = (q, ...plates) => plates.some(p => p && normalizePlate(p) === q);

/**
 * The property's own answer for one plate, from what the office already has:
 * the approval queue's rows, the open hold requests and the cars the camera
 * sees now.
 *
 * Order: an approved long-term pass, a live short-term pass, an active hold,
 * a registration waiting for approval, else not registered.
 *
 * @returns {{verdict: 'resident'|'visitor'|'pending'|'hold'|'not_registered', row: object|null, hold: object|null, here: object|null}|null}
 *   null when the plate is empty.
 */
export function findPlate(plate, { permitsRows = [], onProperty = [], holds = [], now = Date.now() } = {}) {
  const q = normalizePlate(plate);
  if (!q) return null;
  const mine = (permitsRows || []).filter(r => samePlate(q, r?.plate_text, r?.back_plate));
  const here = (onProperty || []).find(r => samePlate(q, r?.plate)) || null;
  const hold = (holds || []).find(r => r?.kind === 'hold' && r?.status === 'active' && samePlate(q, r?.plate, r?.plate_text)) || null;
  const approved = mine.filter(r => segmentOf(r, now) === 'approved');
  const res = approved.find(isLongTerm);
  if (res) return { verdict: 'resident', row: res, hold, here };
  const vis = approved.find(r => !isLongTerm(r));
  if (vis) return { verdict: 'visitor', row: vis, hold, here };
  if (hold) return { verdict: 'hold', row: null, hold, here };
  const waiting = mine.find(r => segmentOf(r, now) === 'pending');
  if (waiting) return { verdict: 'pending', row: waiting, hold, here };
  return { verdict: 'not_registered', row: null, hold: null, here };
}

/**
 * The one result line: a word (the tag), its tone and the detail beside it.
 * Every verdict has a word; red only for the one the office may act on.
 */
export function plateVerdict(found, propertyName = '') {
  if (!found) return null;
  const { verdict, row, hold, here } = found;
  const unit = row ? unitText(row) : '';
  const car = row ? vehicleLine(row) : '';
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  const onNow = here ? 'On the property now' : '';
  switch (verdict) {
    case 'resident':
      // "Registered" already says it is a resident's long-term pass.
      return { tone: 'green', word: 'Registered', detail: join(unit && `Unit ${unit}`, car, onNow) };
    case 'visitor': {
      const until = row?.valid_until ? fmtETStamp(row.valid_until) : '';
      return { tone: 'green', word: 'Visitor pass', detail: join(unit && `Visiting unit ${unit}`, until && `until ${until}`, onNow) };
    }
    case 'hold': {
      const until = hold?.expires_at ? fmtETStamp(hold.expires_at) : '';
      return { tone: 'info', word: 'On hold', detail: join(hold?.ref && `Hold ${hold.ref}`, until && `until ${until}`, onNow) };
    }
    case 'pending':
      return { tone: 'info', word: 'Waiting for approval', detail: join(unit && `Unit ${unit}`, car, 'approve or deny it above', onNow) };
    default:
      return { tone: 'red', word: 'Not registered', detail: join(`No parking pass at ${propertyName || 'this property'}.`, onNow) };
  }
}
