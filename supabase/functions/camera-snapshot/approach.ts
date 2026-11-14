// A plate getting closer to an apartment's entry camera is a car driving
// out, not in. (Gabe, 2026-11-14: the "GOD IS" decorative front plate
// opened a tile twice; the make-model add-on would tell front from rear
// but is blind at night, and the frames already tell the direction.)
//
// Measured over 14 days at Mayfield (approach.py): in all 34 bursts of a
// car that certainly entered (the exit camera later read it leaving) the
// plate box shrank and moved UP the frame as the car drove into the lot,
// by 32 to 217 px. In the one burst of a car certainly leaving past the
// entry camera the box grew 18 px and moved DOWN 230 px. Nothing between.
//
// The rule needs two frames of the same car on the same camera; 74 of 237
// bursts in that window had one frame and get no verdict.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sameVehicle } from "./plate_identity.ts";

export type PlateBox = { xmin?: number; ymin?: number; xmax?: number; ymax?: number } | null | undefined;

export const APPROACH_DOWN_PX = 40;   // box top moved down the frame by more than this
export const APPROACH_GROW_PX = 8;    // or the box grew by more than this while moving down
export const APPROACH_WINDOW_SECONDS = 60;

export function isApproaching(prev: PlateBox, cur: PlateBox, downPx = APPROACH_DOWN_PX, growPx = APPROACH_GROW_PX): boolean {
  if (!prev || !cur) return false;
  const py = prev.ymin ?? NaN, cy = cur.ymin ?? NaN;
  const ph = (prev.ymax ?? NaN) - (prev.ymin ?? NaN), ch = (cur.ymax ?? NaN) - (cur.ymin ?? NaN);
  if (![py, cy, ph, ch].every(Number.isFinite)) return false;
  const dy = cy - py, dh = ch - ph;
  return dy > downPx || (dh > growPx && dy > 0);
}

/** The plate box of the most recent read of this car on this camera within
 *  the window, or null. */
export async function recentBoxForPlate(
  db: SupabaseClient, cameraId: string, normalized: string, now: Date, windowSeconds = APPROACH_WINDOW_SECONDS,
): Promise<{ box: PlateBox; plate: string; at: string } | null> {
  const since = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const r = await db.from("plate_events")
    .select("normalized_plate,created_at,box:raw_data->_pr_response->results->0->box,inh:raw_data->>_inherited_from_session")
    .eq("camera_id", cameraId)
    .gte("created_at", since)
    .not("normalized_plate", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (r.error) throw r.error;
  for (const e of (r.data ?? []) as Array<{ normalized_plate: string | null; created_at: string; box: PlateBox; inh: string | null }>) {
    if (!e.normalized_plate || e.inh || !e.box) continue;
    if (sameVehicle(e.normalized_plate, normalized, { kind: "burst" }).same) return { box: e.box, plate: e.normalized_plate, at: e.created_at };
  }
  return null;
}
