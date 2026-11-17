// lock()'s enforcement-pause check, with its reads (pause_gate.ts holds the
// pure decisions). Its own module so the wiring is under test: index.ts runs
// Deno.serve when loaded and cannot be imported by a test.
//
//   • Read the pauses now. A failed read refuses (503 pause_check_failed),
//     except at a property known to be a truck plaza (no pause exists there).
//   • No pause anywhere: done, nothing else is read.
//   • Otherwise the open boot dispatches at the paused properties are read: a
//     boot_sms dispatch texted before the pause started stands
//     (pause_gate.ts dispatchedBeforePause). A failed read of them counts as
//     none, so the boot is refused, not allowed.
//   • A refusal is 409 enforcement_paused with the pause_gate.ts message.

import { HttpError } from "../_shared/boot.ts";
import { readPauses, type PauseDb } from "../_shared/pause.ts";
import { lockPauseRefusal, unknownPauseBlocks, type StandingDispatch } from "./pause_gate.ts";
import type { PropertyPoint } from "./payments.ts";

type Named = { id: string; name: string | null };

export async function refuseIfPaused(db: PauseDb, i: {
  now: Date;
  propertyId: string | null;
  lat: number | null;
  lon: number | null;
  plate: string;
  /** The properties this agent can boot at (index.ts listProperties). Read only while a pause is active. */
  myProperties: () => Promise<Named[]>;
  /** Every property's location (index.ts propertyPoints). Read only while a pause is active. */
  points: () => Promise<PropertyPoint[]>;
}): Promise<void> {
  const pauses = await readPauses(db, i.now);
  if (!pauses.ok) {
    console.error(`lock pause_lookup_failed err=${pauses.error}`);
    let type: string | null = null;
    if (i.propertyId) {
      const { data } = await db.from("properties").select("property_type").eq("id", i.propertyId).maybeSingle();
      type = (data as { property_type?: string | null } | null)?.property_type ?? null;
    }
    if (unknownPauseBlocks(type)) throw new HttpError(503, "pause_check_failed", "Could not check for an enforcement pause. Try again.");
    return;
  }
  if (pauses.active.size === 0) return;
  const mine = await i.myProperties();
  // Open boot dispatches at the paused properties: one texted before the pause started stands.
  const { data: standing, error: sErr } = await db.from("alpr_violations")
    .select("property_id, plate_text, dispatched_at")
    .eq("action_channel", "boot_sms").eq("status", "dispatched")
    .in("property_id", [...pauses.active.keys()]);
  if (sErr) console.error(`lock standing_dispatch_lookup_failed err=${sErr.message}`);
  const refusal = lockPauseRefusal({
    propertyId: i.propertyId, myProperties: mine, lat: i.lat, lon: i.lon, active: pauses.active, points: await i.points(),
    plate: i.plate, standing: (standing ?? []) as StandingDispatch[],
  });
  if (refusal) throw new HttpError(409, refusal.code, refusal.message);
}
