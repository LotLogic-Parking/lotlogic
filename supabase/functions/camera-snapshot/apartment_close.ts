// Closing an apartment visit on a plate read that is not an exact exit read
// (Gabe, 2026-11-13: "are we closing passes ... do a sweep to ensure that we
// are closing all passes"). Apartments only; a truck plaza keeps its rules.
//
//  A. Late exit match. An exit-camera read that matches no open visit exactly
//     is compared against EVERY open visit at the property with the
//     plate_identity "visit" rule,
//     however old the visit. findSimilarOpenSession only considers visits
//     with plate activity in the last two minutes, so an entry read of VS233
//     at 9:19 never met the exit read VS2330 at 9:29 and the visit sat open.
//     Exactly one candidate closes; two or more is ambiguous and nothing
//     closes. A read that looks like a visit closed in the last
//     BURST_NOISE_MINUTES is the tail of that car's exit burst, not another
//     car, and closes nothing.
//
//  B. Re-entry. The entry camera reading a plate whose open visit was last
//     seen REENTRY_MINUTES ago or more means the car left while the exit
//     camera was asleep and has come back. The old visit closes at its last
//     sighting (never "now") and the read opens a new visit as usual.
//
// Both honour the rule that only a plate read opens or closes a visit.

import type { SupabaseClient } from "@supabase/supabase-js";
import { applyExitOutcome, decideExitOutcome, type ExitOutcome, type OpenSessionRow } from "./sessions.ts";
import { sameVehicle } from "./plate_identity.ts";
import { visitPlateScores } from "./apartment_entry.ts";

export const REENTRY_MINUTES_DEFAULT = 10;
// The keypad buffer: an exit-camera read inside this many seconds of entry is
// the front plate of a car stopped at the keypad on its way in, not an exit
// (PARKING_BUFFER_MINUTES at an apartment is 1.5 min).
export const LATE_EXIT_MIN_AGE_SECONDS = 90;
export const BURST_NOISE_MINUTES = 10;
export const EXIT_HOLD_HOURS = 24;

const SESSION_COLUMNS = "id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id";

export function minutesFromEnv(raw: string | undefined | null, fallback: number): number {
  const n = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type OpenVisitLite = { id: string; normalized_plate: string; entered_at: string };
export type ClosedVisitLite = { normalized_plate: string; exited_at: string | null };

/** True when the read looks like a visit that closed within the window: the
 *  misread tail of that car's exit burst, which must not close another visit. */
export function isBurstNoise(
  readPlate: string,
  recentlyClosed: ClosedVisitLite[],
  readAt: Date,
  windowMinutes: number = BURST_NOISE_MINUTES,
): boolean {
  const windowMs = windowMinutes * 60_000;
  for (const c of recentlyClosed) {
    if (!c.exited_at) continue;
    const t = Date.parse(c.exited_at);
    if (!Number.isFinite(t) || Math.abs(readAt.getTime() - t) > windowMs) continue;
    if (sameVehicle(c.normalized_plate, readPlate, { kind: "burst" }).same) return true;
  }
  return false;
}

/** The one open visit an exit read belongs to, or null. Exact plate first;
 *  otherwise a single visit the formula calls the same car. Visits younger than
 *  minAgeSeconds are the keypad case and never match. */
export function pickLateExitMatch<T extends OpenVisitLite>(
  readPlate: string,
  open: T[],
  readAt: Date,
  minAgeSeconds: number = LATE_EXIT_MIN_AGE_SECONDS,
  readScore: number | null = null,
  visitScores: Map<string, number> = new Map(),
): { visit: T; reason: "exact" | "similar" } | null {
  if (!readPlate) return null;
  const aged = open.filter((v) => {
    const t = Date.parse(v.entered_at);
    return Number.isFinite(t) && readAt.getTime() - t >= minAgeSeconds * 1000;
  });
  const exact = aged.find((v) => v.normalized_plate === readPlate);
  if (exact) return { visit: exact, reason: "exact" };
  const similar = aged.filter((v) => sameVehicle(v.normalized_plate, readPlate, { kind: "visit", scoreA: visitScores.get(v.id) ?? null, scoreB: readScore }).same);
  if (similar.length === 1) return { visit: similar[0], reason: "similar" };
  return null;
}

/** An entry-camera read of an open visit's plate is a re-entry when the visit
 *  was last seen `minutes` ago or more. Apartments only. */
export function isReentry(opts: {
  propertyType: string | null | undefined;
  enteredAt: string;
  lastDetectedAt: string | null | undefined;
  now: Date;
  minutes: number;
}): boolean {
  if (opts.propertyType !== "apartment") return false;
  const entered = Date.parse(opts.enteredAt);
  if (!Number.isFinite(entered)) return false;
  const last = opts.lastDetectedAt ? Date.parse(opts.lastDetectedAt) : NaN;
  const seen = Number.isFinite(last) ? Math.max(last, entered) : entered;
  return opts.now.getTime() - seen >= opts.minutes * 60_000;
}

/** Close `session` on the exit read `exitPlateEventId`, with the same
 *  outcome rules as an exact exit read (closed_early cancels a still-valid
 *  pass, an expired visit becomes closed_post_violation). */
export async function closeVisitOnExit(
  db: SupabaseClient,
  session: OpenSessionRow,
  exitCameraId: string,
  exitPlateEventId: string,
  exitedAt: Date,
): Promise<ExitOutcome["kind"]> {
  let passValidUntil: Date | null = null;
  if (session.state === "registered" && session.visitor_pass_id) {
    const p = await db.from("visitor_passes").select("valid_until").eq("id", session.visitor_pass_id).single();
    if (p.error) throw p.error;
    passValidUntil = p.data?.valid_until ? new Date(p.data.valid_until) : null;
  }
  const outcome = decideExitOutcome(session, passValidUntil, exitedAt, EXIT_HOLD_HOURS);
  await applyExitOutcome(db, {
    session, exitCameraId, exitPlateEventId, exitedAt, holdDurationHours: EXIT_HOLD_HOURS,
  }, outcome);
  return outcome.kind;
}

/** Rule A lookup: the open visit at `propertyId` that the exit read
 *  `normalizedPlate` at `readAt` belongs to, or null. */
export async function findLateExitVisit(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  readAt: Date,
  readScore: number | null = null,
): Promise<{ visit: OpenSessionRow; reason: "exact" | "similar" } | null> {
  const since = new Date(readAt.getTime() - BURST_NOISE_MINUTES * 60_000).toISOString();
  const closed = await db.from("plate_sessions")
    .select("normalized_plate,exited_at")
    .eq("property_id", propertyId)
    .gte("exited_at", since)
    .limit(200);
  if (closed.error) throw closed.error;
  if (isBurstNoise(normalizedPlate, (closed.data ?? []) as ClosedVisitLite[], readAt)) return null;
  const open = await db.from("plate_sessions")
    .select(SESSION_COLUMNS)
    .eq("property_id", propertyId)
    .is("exited_at", null)
    .limit(500);
  if (open.error) throw open.error;
  const visits = (open.data ?? []) as OpenSessionRow[];
  const scores = await visitPlateScores(db, visits);
  return pickLateExitMatch(normalizedPlate, visits, readAt, LATE_EXIT_MIN_AGE_SECONDS, readScore, scores);
}

/** Rule B close: the car left while the exit camera was asleep. exited_at is
 *  the last sighting, never the re-entry time. Mirrors the plaza re-pass
 *  close (no exit event, no pass cancellation, no hold). */
export async function closeLeftUnseen(db: SupabaseClient, session: OpenSessionRow, now: Date): Promise<string> {
  const exitedAt = session.last_detected_at ?? session.entered_at;
  const upd = await db.from("plate_sessions")
    .update({
      exited_at: exitedAt,
      state: session.state === "expired" ? "expired" : "closed_clean",
      updated_at: now.toISOString(),
    })
    .eq("id", session.id)
    .is("exited_at", null);
  if (upd.error) throw upd.error;
  return exitedAt;
}
