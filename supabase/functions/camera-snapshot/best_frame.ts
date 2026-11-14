// ── Best frame per session side (apartments) ─────────────────────────
//
// An SC211 posts a burst of frames as one car passes. Before this module
// only the first readable frame paid for a Plate Recognizer call and kept
// a photo; the rest inherited onto the session with no image. So the
// session's entry photo was always frame 1, and the exit photo was always
// the frame that happened to trip the exit. Gabe, 2026-11-11: each visit
// should carry the cleanest photo of the plate coming in and the cleanest
// photo of the plate leaving.
//
// What this module does, and deliberately does not do:
//   • Scores a Plate Recognizer read by how big the plate is in the frame
//     (box height in px; a closer plate is a sharper plate), with PR's
//     score as the tie-break. See frameScore.
//   • Repoints plate_sessions.entry_plate_event_id / exit_plate_event_id to
//     a better-scoring frame with a compare-and-set, so two concurrent
//     frames never leave the session pointing at the worse one.
//   • Never rewrites plate_text / normalized_plate: holds, cooldown,
//     registrationTransition, inferDirection and findOpenSession all key
//     on the session's normalized_plate. Burst rows are inserted with the
//     SESSION's plate and carry their own read in raw_data._burst_read, so
//     the pass-photo trigger and the plate-pair learner never see a
//     drifted read as a new identity.
//   • Only accepts a frame whose read is anchored-similar to the session
//     plate (plateSimilar(..., true)): same length, at most one
//     non-confusable edit. Image-hash similarity alone is never enough.
//   • Freezes the entry photo once a violation exists on the session: the
//     violation and the tow email already carry that frame.
//   • Attaches exit-burst frames to a session closed seconds ago on the
//     same camera instead of opening a phantom session (the re-pass exit
//     bug: frame 1 closed the session, frame 2 opened a new one).

import type { SupabaseClient } from "@supabase/supabase-js";
import { sameVehicle } from "./plate_identity.ts";

export const BURST_WINDOW_SECONDS_DEFAULT = 90;
export const BURST_PR_CAP_DEFAULT = 3;

export type Side = "entry" | "exit";

type PrBox = { xmin?: number; ymin?: number; xmax?: number; ymax?: number };

/** Plate box height in pixels from a Plate Recognizer result or a stored raw_data; 0 when absent. */
export function plateBoxHeight(box: unknown): number {
  const b = box as PrBox | null | undefined;
  if (!b || typeof b !== "object") return 0;
  const { ymin, ymax } = b;
  if (typeof ymin !== "number" || typeof ymax !== "number") return 0;
  const h = ymax - ymin;
  return Number.isFinite(h) && h > 0 ? h : 0;
}

/**
 * How legible a frame's plate is: box height in px (integer) plus PR's
 * score (0..1) as the tie-break. A frame with no box only wins against
 * another frame with no box.
 */
export function frameScore(ev: { confidence?: number | null; raw_data?: unknown }): number {
  const rd = (ev.raw_data ?? null) as { box?: unknown } | null;
  const conf = typeof ev.confidence === "number" && Number.isFinite(ev.confidence) ? ev.confidence : 0;
  return plateBoxHeight(rd?.box) + Math.max(0, Math.min(1, conf));
}

/** Same score shape, straight from a Plate Recognizer result. */
export function resultScore(result: { score?: number; box?: unknown }): number {
  return frameScore({ confidence: result.score ?? 0, raw_data: { box: result.box } });
}

/** True while `now` is within `seconds` after `anchorIso` (entered_at or exited_at). */
export function withinBurstWindow(anchorIso: string | null | undefined, now: Date, seconds: number): boolean {
  if (!anchorIso || seconds <= 0) return false;
  const t = new Date(anchorIso).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age <= seconds * 1000;
}

/** A burst frame may stand in for the session only when its read is the same plate, anchored. */
export function readMatchesSession(normalizedRead: string, sessionNormalizedPlate: string): boolean {
  if (!normalizedRead || !sessionNormalizedPlate) return false;
  return sameVehicle(normalizedRead, sessionNormalizedPlate, { kind: "burst" }).same;
}

/** How many burst probes (PR-called frames flagged raw_data._burst) this session side already has. */
export async function countBurstProbes(
  db: SupabaseClient,
  sessionId: string,
  side: Side,
): Promise<number> {
  const { data, error } = await db
    .from("plate_events")
    .select("id")
    .eq("session_id", sessionId)
    .eq("event_type", side)
    .eq("raw_data->>_burst", "true")
    .limit(50);
  if (error) throw error;
  return (data ?? []).length;
}

export type ClosedSessionRow = {
  id: string;
  property_id: string;
  normalized_plate: string;
  plate_text: string;
  exited_at: string;
  exit_camera_id: string | null;
  exit_plate_event_id: string | null;
};

/**
 * The session this camera closed within `withinSeconds` whose plate is the
 * incoming read (exact or anchored-similar). Frames of an exit burst after
 * the one that closed the session land here instead of opening a new one.
 */
export async function findRecentlyClosedSession(
  db: SupabaseClient,
  propertyId: string,
  cameraId: string,
  normalizedPlate: string,
  now: Date,
  withinSeconds: number,
): Promise<ClosedSessionRow | null> {
  if (!normalizedPlate || withinSeconds <= 0) return null;
  const cutoffIso = new Date(now.getTime() - withinSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,exited_at,exit_camera_id,exit_plate_event_id")
    .eq("property_id", propertyId)
    .eq("exit_camera_id", cameraId)
    .gte("exited_at", cutoffIso)
    .not("exit_plate_event_id", "is", null)
    .order("exited_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  for (const row of (data ?? []) as ClosedSessionRow[]) {
    if (readMatchesSession(normalizedPlate, row.normalized_plate)) return row;
  }
  return null;
}

export type RepointOutcome = "repointed" | "kept" | "lost_race" | "no_current" | "frozen";

/**
 * Point the session's entry or exit photo at `candidate` when it scores
 * higher than the frame it points at now. Compare-and-set on the current
 * event id: a concurrent frame that already moved the pointer makes this
 * one lose the race rather than overwrite. The entry side is frozen once
 * the session has a violation.
 */
export async function repointIfBetter(
  db: SupabaseClient,
  sessionId: string,
  side: Side,
  candidate: { id: string; score: number },
  now: Date,
): Promise<RepointOutcome> {
  const col = side === "entry" ? "entry_plate_event_id" : "exit_plate_event_id";
  const { data: s, error: sErr } = await db
    .from("plate_sessions")
    .select(`id,${col},violation_id`)
    .eq("id", sessionId)
    .maybeSingle();
  if (sErr) throw sErr;
  const currentId = (s as Record<string, string | null> | null)?.[col] ?? null;
  if (!currentId) return "no_current";
  if (side === "entry" && (s as { violation_id?: string | null }).violation_id) return "frozen";

  const { data: cur, error: eErr } = await db
    .from("plate_events")
    .select("id,confidence,raw_data")
    .eq("id", currentId)
    .maybeSingle();
  if (eErr) throw eErr;
  const currentScore = cur ? frameScore(cur as { confidence?: number | null; raw_data?: unknown }) : 0;
  if (candidate.score <= currentScore) return "kept";

  const upd = await db
    .from("plate_sessions")
    .update({ [col]: candidate.id, updated_at: now.toISOString() })
    .eq("id", sessionId)
    .eq(col, currentId)
    .select("id");
  if (upd.error) throw upd.error;
  return ((upd.data ?? []) as unknown[]).length > 0 ? "repointed" : "lost_race";
}
