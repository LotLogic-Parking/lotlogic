// lock()'s enforcement-pause check, with its reads (pause_gate.ts holds the
// pure decisions). Its own module so the wiring is under test: index.ts runs
// Deno.serve when loaded and cannot be imported by a test.
//
//   • Read the pauses now. A failed read refuses (503 pause_check_failed),
//     except at a property known to be a truck plaza (no pause exists there).
//   • No pause anywhere: done, nothing else is read.
//   • Otherwise the boot dispatches at the paused properties are read, open
//     or answered DONE: one texted before the pause started still goes ahead
//     (pause_gate.ts dispatchedBeforePause). A failed read of them counts as
//     none, so the boot is refused, not allowed. The read covers the last
//     STANDING_LOOKBACK_DAYS only: a dispatch that can still stand is hours
//     old, and years of old ones must not fill PostgREST's row cap first.
//   • Also read at the paused properties (Gabe, 2026-11-18; the backend's
//     enforcement_pause.in_motion): the office's open tow requests (kind
//     'tow', status 'active'), which go ahead whenever they were placed, and
//     the open camera flags (alpr_violations of any channel, status
//     'dispatched', no action taken, not left, no tow confirmed) sent from
//     FLAG_STANDING_DAYS before the earliest pause start up to the latest one,
//     with their visits' plate_sessions.exited_at (an ended visit does not
//     stand). pause_gate.ts officeRequested / flaggedBeforePause decide.
//     Each failed read counts as none, so it can only refuse, never allow.
//   • And what keeps a car at DO NOT TOW whatever is in motion (the backend's
//     _TOW_OVERRIDES_PAUSE): the office's live holds (tow_requests kind 'hold',
//     read with the tow requests) and the live parking passes on the plate
//     (resident_plates approved or pending; visitor_passes active, before
//     valid_until). Either one stops a request or flag from standing
//     (pause_gate.ts protectedAt). A failed read of them is protectionsUnknown:
//     no request or flag stands.
//   • A refusal is 409 enforcement_paused with the pause_gate.ts message.

import { HttpError } from "../_shared/boot.ts";
import { readPauses, type PauseDb } from "../_shared/pause.ts";
import { FLAG_STANDING_DAYS, lockPauseRefusal, unknownPauseBlocks, type CameraFlag, type OfficeRequest, type ParkingPass, type StandingDispatch } from "./pause_gate.ts";
import type { PropertyPoint } from "./payments.ts";

type Named = { id: string; name: string | null };

/** Far wider than any dispatch that can still stand (open: BOOT_STALE_HOURS; DONE: BOOT_REPLY_HOURS). */
export const STANDING_LOOKBACK_DAYS = 7;

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
  const paused = [...pauses.active.keys()];
  const starts = [...pauses.active.values()].map((p) => Date.parse(p.starts_at)).filter(Number.isFinite);
  // Boot dispatches at the paused properties, open or answered DONE: one texted before the pause started goes ahead.
  const standingRead = db.from("alpr_violations")
    .select("property_id, plate_text, dispatched_at, status, action_taken, resolved_at")
    .eq("action_channel", "boot_sms").in("status", ["dispatched", "resolved"])
    .in("property_id", paused)
    .gte("dispatched_at", new Date(i.now.getTime() - STANDING_LOOKBACK_DAYS * 86_400_000).toISOString());
  // The office's open tow requests at the paused properties (placed before the pause or during it, they go
  // ahead), and its holds (a live one keeps the car at DO NOT TOW).
  const requestRead = db.from("tow_requests")
    .select("property_id, kind, status, normalized_plate, normalized_back_plate, created_at, expires_at")
    .eq("status", "active").in("kind", ["tow", "hold"]).in("property_id", paused);
  // Parking passes on this plate at the paused properties: a live one keeps the car at DO NOT TOW. The
  // front plate is stored as typed, so the read keeps any whose letters and digits appear in order
  // (never misses one) and pause_gate.ts compares them normalized; the back plate is stored normalized.
  const want = i.plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const plateMatch = `plate_text.ilike.*${want.split("").join("*")}*,normalized_back_plate.eq.${want}`;
  const longTermRead = db.from("resident_plates")
    .select("property_id, plate_text, normalized_back_plate, status, active, created_at")
    .in("property_id", paused).in("status", ["approved", "pending"]).or(plateMatch);
  const shortTermRead = db.from("visitor_passes")
    .select("property_id, plate_text, normalized_back_plate, status, valid_until")
    .in("property_id", paused).eq("status", "active").gt("valid_until", i.now.toISOString()).or(plateMatch);
  // Open camera flags (tow email or boot text) sent before a pause began: they go ahead.
  const flagRead = starts.length === 0 ? Promise.resolve({ data: [], error: null }) : db.from("alpr_violations")
    .select("id, property_id, plate_text, dispatched_at, status, action_taken, action_channel, left_before_tow_at, tow_confirmed_at, session_id")
    .eq("status", "dispatched").is("action_taken", null).is("left_before_tow_at", null).is("tow_confirmed_at", null)
    .in("property_id", paused)
    .gte("dispatched_at", new Date(Math.min(...starts) - FLAG_STANDING_DAYS * 86_400_000).toISOString())
    .lt("dispatched_at", new Date(Math.max(...starts)).toISOString());
  const [{ data: standing, error: sErr }, { data: requests, error: rErr }, { data: flagRows, error: fErr }, { data: longTerm, error: resErr }, { data: shortTerm, error: gErr }] =
    await Promise.all([standingRead, requestRead, flagRead, longTermRead, shortTermRead]);
  if (sErr) console.error(`lock standing_dispatch_lookup_failed err=${sErr.message}`);
  if (rErr) console.error(`lock tow_request_lookup_failed err=${rErr.message}`);
  if (fErr) console.error(`lock camera_flag_lookup_failed err=${fErr.message}`);
  if (resErr) console.error(`lock resident_plates_lookup_failed err=${resErr.message}`);
  if (gErr) console.error(`lock visitor_passes_lookup_failed err=${gErr.message}`);
  const flags = await withVisits(db, (flagRows ?? []) as (CameraFlag & { session_id?: string | null })[]);
  const passes: ParkingPass[] = [
    ...((longTerm ?? []) as Omit<ParkingPass, "table">[]).map((r) => ({ ...r, table: "resident_plates" as const })),
    ...((shortTerm ?? []) as Omit<ParkingPass, "table">[]).map((g) => ({ ...g, table: "visitor_passes" as const })),
  ];
  const refusal = lockPauseRefusal({
    propertyId: i.propertyId, myProperties: mine, lat: i.lat, lon: i.lon, active: pauses.active, points: await i.points(),
    plate: i.plate, standing: (standing ?? []) as StandingDispatch[], requests: (requests ?? []) as OfficeRequest[], flags,
    passes, protectionsUnknown: !!(rErr || resErr || gErr), now: i.now,
  });
  if (refusal) throw new HttpError(409, refusal.code, refusal.message);
}

/**
 * Marks each flag whose visit has ended (plate_sessions.exited_at set): the
 * car left, so the one at the curb now is new enforcement. A failed read
 * keeps no flag (it can only refuse, never allow).
 */
async function withVisits(db: PauseDb, rows: (CameraFlag & { session_id?: string | null })[]): Promise<CameraFlag[]> {
  const ids = [...new Set(rows.map((r) => r.session_id).filter((s): s is string => !!s))];
  if (ids.length === 0) return rows;
  const { data, error } = await db.from("plate_sessions").select("id, exited_at").in("id", ids);
  if (error) {
    console.error(`lock camera_flag_visit_lookup_failed err=${error.message}`);
    return [];
  }
  const ended = new Set(((data ?? []) as { id: string; exited_at: string | null }[]).filter((s) => s.exited_at != null).map((s) => s.id));
  return rows.map((r) => ({ ...r, visit_ended: !!r.session_id && ended.has(r.session_id) }));
}
