// ── Enforcement pause: the two tow-path steps' candidate queries and checks ──
//
// overstayExpiry and dispatchPendingViolations (index.ts) take their
// candidates and per-row checks from here, so the pause filter is under test
// (index.ts creates a Supabase client at module scope and cannot be imported
// by a test). The state machine and its order stay in index.ts, unchanged.
//
// Rules (spec 2026-11-16 Part 3, plan Task 9):
//   • At a paused property the queries leave the rows out, in SQL and before
//     any limit, so they stay exactly as they were. An unknown pause state
//     leaves out every apartment for that read (excludePaused).
//   • The pending-dispatch candidates read the pause table themselves, at the
//     moment they are picked, not at the start of the tick: the tick reaches
//     this step a minute or more after it began, and a pause that starts in
//     between must stop the tow email.
//   • A row the pause held (heldThroughPause) is re-checked at the first tick
//     after the pause, because it may have waited up to 72 h: "go out at the
//     pause end if the car is still in violation then". A car now covered by
//     a live parking pass or resident plate is not towed, and a car an exit
//     already closed out is not towed. Rows the pause never held keep today's
//     rules exactly; these checks are a pause filter, not a new policy.

import type { SupabaseClient } from "@supabase/supabase-js";
import { excludePaused, heldThroughPause, readPauses, type PauseRead } from "../_shared/pause.ts";
import { findCoveringPass } from "./boot_dispatch.ts";
import { leftSignal, type LeftSignal } from "./dispatch_guard.ts";

export type Cover = { kind: "pass" | "resident"; id: string };

const normPlate = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── overstayExpiry ─────────────────────────────────────────────────────────

export type OverstaySession = {
  id: string; property_id: string; plate_text: string; normalized_plate: string | null;
  entry_plate_event_id: string; visitor_pass_id: string | null; exit_hinted_at: string | null;
};

/** Registered, open sessions, less any at a paused property (all apartments when the pause state is unknown). */
export async function overstayCandidates(db: SupabaseClient, pauses: PauseRead): Promise<OverstaySession[]> {
  const sel = "id, property_id, plate_text, normalized_plate, entry_plate_event_id, visitor_pass_id, exit_hinted_at";
  // An unknown pause state needs the property type to hold apartments only (excludePaused).
  const select: string = pauses.ok ? sel : `${sel}, properties!inner(property_type)`;
  const { data, error } = await excludePaused(
    db.from("plate_sessions").select(select).eq("state", "registered").is("exited_at", null),
    pauses, "properties.property_type");
  if (error) throw error;
  return (data ?? []) as unknown as OverstaySession[];
}

/**
 * A pass that ran out during a pause, on a car that renewed (or became a
 * resident plate) before the pause ended: the cover to re-point the session
 * at, instead of firing the overstay. Null for every pass the pause did not
 * hold, so overstays outside a pause fire exactly as before.
 */
export async function heldOverstayCover(db: SupabaseClient, pauses: PauseRead, s: OverstaySession, passValidUntil: string, now: Date): Promise<Cover | null> {
  if (!heldThroughPause(pauses, s.property_id, passValidUntil)) return null;
  return await findCoveringPass(db, s.property_id, s.normalized_plate || normPlate(s.plate_text), now);
}

/**
 * Point a session at its cover: a pass keeps it (or puts it back) in
 * `registered`; a resident plate makes it `resident`. Conditional on the
 * state it was read in, so a concurrent step that moved it wins.
 */
export async function repointSession(db: SupabaseClient, sessionId: string, fromState: "registered" | "expired", cover: Cover, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const { data, error } = await db.from("plate_sessions")
    .update(cover.kind === "pass"
      ? { state: "registered", visitor_pass_id: cover.id, updated_at: nowIso }
      : { state: "resident", resident_plate_id: cover.id, updated_at: nowIso })
    .eq("id", sessionId)
    .eq("state", fromState)
    .select("id");
  if (error) { console.warn(`pause_repoint failed session=${sessionId}: ${error.message}`); return false; }
  return !!data && data.length > 0;
}

// ── dispatchPendingViolations ──────────────────────────────────────────────

export type PendingViolation = {
  id: string; session_id: string | null; property_id: string; violation_type: string; created_at: string;
  dispatch_attempts: number | null; left_before_tow_at: string | null;
};

/**
 * Un-dispatched violations past the hold, less any at a property paused
 * right now. Reads the pause table itself, at `now`; returns that read too,
 * so the per-row checks and the heartbeat use the same one.
 */
export async function pendingDispatchCandidates(db: SupabaseClient, o: {
  now: Date; cutoffIso: string; maxAttempts: number; limit: number; recentHours: number;
}): Promise<{ rows: PendingViolation[]; pauses: PauseRead }> {
  const pauses = await readPauses(db, o.now, { recentHours: o.recentHours });
  if (!pauses.ok) console.error(`pause_lookup_failed (dispatch) err=${pauses.error} holding apartment tow emails this tick`);
  const sel = "id, session_id, property_id, violation_type, created_at, dispatch_attempts, left_before_tow_at";
  const select: string = pauses.ok ? sel : `${sel}, properties!inner(property_type)`;
  const { data, error } = await excludePaused(
    db.from("alpr_violations")
      .select(select)
      .is("dispatched_at", null)
      .neq("status", "dispatch_failed")
      .neq("status", "dismissed")
      .lt("dispatch_attempts", o.maxAttempts)
      .lt("created_at", o.cutoffIso),
    pauses, "properties.property_type")
    .limit(o.limit);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as PendingViolation[], pauses };
}

export type PendingDecision =
  | { kind: "skip"; reason: string }
  | { kind: "left"; left: LeftSignal }
  | { kind: "covered"; cover: Cover; sessionId: string }
  | { kind: "send" };

/**
 * What to do with one pending violation. "Already left" signals, as before:
 * the session's exit hint, and the linked truck-plaza pass's exit. For a row
 * the pause held (created before the pause ended), also: the session closed
 * by an exit, the violation stamped left_before_tow_at by an apartment exit,
 * and a live parking pass or resident plate that now covers the car.
 */
export async function pendingDecision(db: SupabaseClient, v: PendingViolation, pauses: PauseRead, now: Date): Promise<PendingDecision> {
  const held = !!heldThroughPause(pauses, v.property_id, v.created_at);
  let sess: { exit_hinted_at: string | null; exited_at: string | null; normalized_plate: string | null; plate_text: string | null; state: string | null } | null = null;
  if (v.session_id) {
    const { data, error } = await db.from("plate_sessions")
      .select("exit_hinted_at, exited_at, normalized_plate, plate_text, state")
      .eq("id", v.session_id)
      .maybeSingle();
    if (error) { console.warn("dispatchPending session fetch failed:", error.message); return { kind: "skip", reason: "session_fetch_failed" }; }
    sess = data ?? null;
  }
  const sessionExitHinted = sess?.exit_hinted_at ?? null;
  let passExitedAt: string | null = null;
  if (!sessionExitHinted) {
    const { data: linkedPass } = await db.from("visitor_passes")
      .select("exited_at")
      .eq("overstay_violation_id", v.id)
      .maybeSingle();
    passExitedAt = (linkedPass as { exited_at?: string | null } | null)?.exited_at ?? null;
  }
  const left = leftSignal({
    sessionExitHintedAt: sessionExitHinted,
    passExitedAt,
    sessionExitedAt: held ? sess?.exited_at ?? null : null,
    violationLeftAt: held ? v.left_before_tow_at ?? null : null,
  });
  if (left) return { kind: "left", left };
  if (held && v.session_id && sess && sess.state === "expired") {
    const cover = await findCoveringPass(db, v.property_id, sess.normalized_plate || normPlate(sess.plate_text), now);
    if (cover) return { kind: "covered", cover, sessionId: v.session_id };
  }
  return { kind: "send" };
}

/**
 * A held violation whose car is now covered: the violation is closed with no
 * tow and nothing sent (it was never dispatched, so there is nothing to stand
 * down), and only then does the session go back to registered / resident.
 *
 * The order matters. The "covered" decision reads the session in `expired`;
 * a session re-pointed first, under a violation whose dismiss then failed,
 * would read `registered` on the next tick, the decision would be "send", and
 * the tow email would go out for a car with a parking pass. So a failed
 * dismiss leaves everything as it was ("failed", counted into the heartbeat)
 * and the next tick decides "covered" again. "not_pending": the row was
 * dispatched by someone else in between; it is left alone, and so is the
 * session.
 */
export type CloseResult = "closed" | "not_pending" | "failed";

export async function closeCoveredViolation(db: SupabaseClient, v: PendingViolation, d: { cover: Cover; sessionId: string }, now: Date): Promise<CloseResult> {
  const nowIso = now.toISOString();
  const upd = await db.from("alpr_violations")
    .update({
      status: "dismissed",
      action_taken: "no_tow",
      action_channel: "auto_registered",
      action_at: nowIso,
      resolved_at: nowIso,
      sms_sent_at: nowIso, // legacy sentinel, as the auto-no-tow path sets it
      left_before_tow_email_sent_at: nowIso, // pre-claims the stand-down slot: nothing to stand down
      notes: `Held by an enforcement pause; covered by a ${d.cover.kind === "pass" ? "parking pass" : "resident plate"} when it ended. cron-sessions-sweep.`,
    })
    .eq("id", v.id)
    .is("dispatched_at", null)
    .select("id");
  if (upd.error) { console.error(`covered_close_failed violation=${v.id}: ${upd.error.message} (left as is; retried next tick)`); return "failed"; }
  if (!upd.data || upd.data.length === 0) return "not_pending";
  // The violation is closed, so no tow can follow whatever happens here. A
  // failed re-point leaves the session expired under a dismissed violation,
  // which closeExpired closes like any other.
  await repointSession(db, d.sessionId, "expired", d.cover, now);
  console.log(`auto_registered violation=${v.id} session=${d.sessionId} cover=${d.cover.kind} id=${d.cover.id}`);
  return "closed";
}

/** Heartbeat error for the covered-car closes this tick: null when none failed. */
export function coverCloseHealth(failed: number): string | null {
  return failed > 0 ? `covered_close_failed: ${failed} held violations with a parking pass could not be closed; retrying next tick` : null;
}
