// Backstop for apartment_close.ts rule A. camera-snapshot matches an exit
// read against every open visit at the property as it arrives; this sweep
// re-checks exit reads that still belong to no visit (a stray at the time, an
// ingest error, a read logged before that code shipped) for the last
// EXIT_SWEEP_LOOKBACK_MINUTES, so an exit read is never left behind.
// Apartments only; reads below EXIT_SWEEP_MIN_SCORE are not evidence.

import type { SupabaseClient } from "@supabase/supabase-js";
import { closeVisitOnExit, findLateExitVisit } from "../camera-snapshot/apartment_close.ts";

export const EXIT_SWEEP_LOOKBACK_MINUTES_DEFAULT = 15;
export const EXIT_SWEEP_MIN_SCORE_DEFAULT = 0.8;
export const EXIT_SWEEP_MAX_PER_TICK = 50;

export type StrayExitRow = {
  id: string;
  camera_id: string;
  property_id: string;
  normalized_plate: string | null;
  plate_text: string | null;
  confidence: number | null;
  created_at: string;
};

export type ExitSweepDeps = {
  db: SupabaseClient;
  now?: Date;
  lookbackMinutes?: number;
  minScore?: number;
  find?: typeof findLateExitVisit;
  close?: typeof closeVisitOnExit;
};

/** The stray exit reads worth a second look: one per property and plate,
 *  oldest first, scored at or above the floor. */
export function pickStrayExits(rows: StrayExitRow[], minScore: number): StrayExitRow[] {
  const seen = new Set<string>();
  const out: StrayExitRow[] = [];
  for (const r of rows) {
    if (!r.normalized_plate || typeof r.confidence !== "number" || r.confidence < minScore) continue;
    const key = `${r.property_id}:${r.normalized_plate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.slice(0, EXIT_SWEEP_MAX_PER_TICK);
}

export async function sweepStrayApartmentExits(deps: ExitSweepDeps): Promise<{ examined: number; closed: number }> {
  const now = deps.now ?? new Date();
  const lookback = deps.lookbackMinutes ?? EXIT_SWEEP_LOOKBACK_MINUTES_DEFAULT;
  const minScore = deps.minScore ?? EXIT_SWEEP_MIN_SCORE_DEFAULT;
  const find = deps.find ?? findLateExitVisit;
  const close = deps.close ?? closeVisitOnExit;
  const since = new Date(now.getTime() - lookback * 60_000).toISOString();

  const q = await deps.db.from("plate_events")
    .select("id,camera_id,property_id,normalized_plate,plate_text,confidence,created_at,properties!inner(property_type)")
    .is("session_id", null)
    .eq("event_type", "exit")
    .eq("properties.property_type", "apartment")
    .gte("created_at", since)
    .gte("confidence", minScore)
    .order("created_at", { ascending: true })
    .limit(200);
  if (q.error) throw q.error;
  const rows = pickStrayExits((q.data ?? []) as unknown as StrayExitRow[], minScore);

  let closed = 0;
  for (const r of rows) {
    try {
      const readAt = new Date(r.created_at);
      const late = await find(deps.db, r.property_id, r.normalized_plate!, readAt, r.confidence);
      if (!late) continue;
      const kind = await close(deps.db, late.visit, r.camera_id, r.id, readAt);
      const upd = await deps.db.from("plate_events")
        .update({
          session_id: late.visit.id,
          match_reason: `exit sweep (${late.reason}): read "${r.plate_text}" closes visit ${late.visit.plate_text}`,
          matched_at: now.toISOString(),
        })
        .eq("id", r.id);
      if (upd.error) throw upd.error;
      closed++;
      console.log(`exit sweep (${late.reason}): session=${late.visit.id} visit_plate=${late.visit.normalized_plate} read=${r.normalized_plate} at ${r.created_at} -> ${kind}`);
    } catch (err) {
      console.warn(`exit sweep: event ${r.id} failed: ${String(err)}`);
    }
  }
  return { examined: rows.length, closed };
}
