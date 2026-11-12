// ── Passes: the manager's home screen, pure half ───────────────
//
// Gabe, 2026-11-11: "we need residents on site now, and active visitors on
// the right hand side with their information and a clean photo that can be
// expanded of when they entered." And the grace rule: a car the camera sees
// that is not a resident shows up at once with a 15-minute countdown to
// register; registration attaches the pass; at 10 minutes (a clock only we
// see) a LotLogic driver is dispatched to boot unless the car registers or
// leaves first. The office sees a red "Dispatched" mark while that stands.
//
// Input is the presence payload's `on_property` rows (`GET
// /apartment/passes/presence`): plate, pass {kind, status, minutes_left,
// unit, name}, minutes_here, entry_photo_url, state, vehicle.
// `scripts/passes.test.mjs` covers it.

import { fmtPassRemaining } from './time.js';
import { personName } from './presence.js';

/** What the sign and the office say: minutes a visitor has to register. */
export const REGISTER_WINDOW_MINUTES = 15;

export const PASSES_COPY = Object.freeze({
  residents: 'Residents on the property',
  visitors: 'Visitors here',
  no_residents: 'No residents on the property right now.',
  no_visitors: 'No visitors right now. The next car the camera sees appears here within a minute, with its photo.',
  // The office cannot register cameras (Victor, 2026-11-12): LotLogic installs them.
  no_camera: 'Once LotLogic installs a camera here, everyone who drives in appears on this screen within a minute.',
});

const isLongTerm = (row) => row?.pass?.kind === 'long_term' && row?.pass?.status !== 'pending';

/** Residents (an approved long-term pass) on the left, everyone else on the right. */
export function splitPresence(onProperty) {
  const rows = Array.isArray(onProperty) ? onProperty.filter(r => r && typeof r === 'object') : [];
  const residents = rows.filter(isLongTerm)
    .sort((a, b) => (personName(a) || a.plate || '').localeCompare(personName(b) || b.plate || ''));
  const visitors = rows.filter(r => !isLongTerm(r))
    .sort((a, b) => (Number(a.minutes_here) || 0) - (Number(b.minutes_here) || 0)); // newest arrival first
  return { residents, visitors };
}

/**
 * A LotLogic driver has been dispatched to this car and nothing has cancelled
 * it yet. The backend says so (`dispatched`, an open boot dispatch on the
 * session's violation). `state === 'expired'` alone is not it: cooldown and
 * overstay violations go to the tow partner and look the same on the session.
 */
export function isDispatched(row) {
  return !!row && typeof row === 'object' && row.dispatched === true;
}

/** Minutes the car still has to register, 0 when the window has passed. */
export function registerMinutesLeft(row) {
  const here = Number.isFinite(row?.minutes_here) ? row.minutes_here : 0;
  return Math.max(0, REGISTER_WINDOW_MINUTES - here);
}

/**
 * The one tag on a visitor row. Red is for the office to act on; green and
 * blue are information. The countdown is the 15 minutes the sign promises.
 */
export function visitorStatus(row) {
  if (isDispatched(row)) return { tone: 'red', text: 'Dispatched', flag: true };
  const pass = row?.pass;
  if (!pass || typeof pass !== 'object') {
    const left = registerMinutesLeft(row);
    if (left > 0) return { tone: 'info', text: `${left} m to register`, flag: false };
    return { tone: 'red', text: 'Not registered', flag: true };
  }
  if (pass.status === 'pending') return { tone: 'info', text: 'Under review', flag: false };
  if (pass.kind === 'long_term') return { tone: 'info', text: 'Long-term', flag: false };
  const left = Number.isFinite(pass.minutes_left) ? pass.minutes_left : null;
  if (left !== null && left <= 0) return { tone: 'red', text: 'Pass ended · still here', flag: true };
  if (left === null) return { tone: 'green', text: 'Short-term', flag: false };
  const phrase = fmtPassRemaining(left * 60000).replace(/ left$/, '');
  return { tone: left < 60 ? 'red' : 'green', text: `${phrase} left`, flag: false };
}

/** The resident row's tag: here, plain. */
export function residentStatus(row) {
  if (isDispatched(row)) return { tone: 'red', text: 'Dispatched', flag: true };
  return { tone: 'info', text: 'Resident', flag: false };
}

/** Counts for the head of the screen. */
export function passesSummary(split) {
  const residents = split?.residents?.length ?? 0;
  const visitors = split?.visitors ?? [];
  const flagged = visitors.filter(r => visitorStatus(r).flag).length;
  const registering = visitors.filter(r => !r?.pass && registerMinutesLeft(r) > 0 && !isDispatched(r)).length;
  return { residents, visitors: visitors.length, flagged, registering };
}
