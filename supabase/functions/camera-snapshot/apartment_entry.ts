// One car, one tile (Gabe, 2026-11-14: "we still have plates that are close
// to each other reading as separate visits"; "there needs to be something
// that catches the similarity of the plates"). Apartments only, unregistered
// reads only: a read that matches a resident or a live pass is that car.
//
// All comparisons use plate_identity.ts (the one formula):
//  Twin.  A read within TWIN_WINDOW_SECONDS of an open visit whose plate is
//         the same car under the burst rule joins that visit; a visit that
//         opened anyway (two frames ingested at the same moment) merges into
//         the older twin right after opening.
//  Like.  A read that is the same car as exactly one open unregistered visit
//         of any age under the visit rule is that visit; the re-entry rule
//         (apartment_close.ts) decides whether it is the same stay or a new one.
//  Plate. A visit carries the consensus of its reads (consensusPlate), so a
//         truncated or one-off read never names the tile.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OpenSessionRow } from "./sessions.ts";
import { consensusPlate, sameVehicle, type ReadLite } from "./plate_identity.ts";

export const TWIN_WINDOW_SECONDS = 120;

const SESSION_COLUMNS = "id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id";

export function twinSimilar(a: string, b: string): boolean {
  return sameVehicle(a, b, { kind: "burst" }).same;
}

export function likeSimilar(a: string, b: string, scoreA?: number | null, scoreB?: number | null): boolean {
  return sameVehicle(a, b, { kind: "visit", scoreA, scoreB }).same;
}

type Lite = Pick<OpenSessionRow, "id" | "normalized_plate" | "state" | "entered_at">;

/** The open unregistered visit this read joins, or null: the closest twin
 *  inside the window, else a single like visit of any age. `visitScores`
 *  is each visit's best score for its own plate (the digit guard). */
export function pickOpenVisitForRead<T extends Lite>(
  read: string,
  open: T[],
  now: Date,
  windowSeconds: number = TWIN_WINDOW_SECONDS,
  readScore: number | null = null,
  visitScores: Map<string, number> = new Map(),
): { visit: T; how: "twin" | "like" } | null {
  if (!read) return null;
  const grace = open.filter((v) => v.state === "grace" && v.normalized_plate !== read);
  const twins = grace
    .map((v) => ({ v, t: Date.parse(v.entered_at), r: sameVehicle(v.normalized_plate, read, { kind: "burst" }) }))
    .filter(({ t, r }) => Number.isFinite(t) && Math.abs(now.getTime() - t) <= windowSeconds * 1000 && r.same)
    .sort((x, y) => x.r.cost - y.r.cost || x.t - y.t);
  if (twins.length > 0) return { visit: twins[0].v, how: "twin" };
  const like = grace.filter((v) => sameVehicle(v.normalized_plate, read, { kind: "visit", scoreA: visitScores.get(v.id) ?? null, scoreB: readScore }).same);
  if (like.length === 1) return { visit: like[0], how: "like" };
  return null;
}

/** The older twin a just-opened visit should merge into, or null. */
export function pickOlderTwin<T extends Lite>(
  mine: { id: string; normalized_plate: string; entered_at: string },
  open: T[],
  windowSeconds: number = TWIN_WINDOW_SECONDS,
): T | null {
  const t0 = Date.parse(mine.entered_at);
  const older = open
    .filter((v) => v.id !== mine.id && v.state === "grace" && sameVehicle(v.normalized_plate, mine.normalized_plate, { kind: "burst" }).same)
    .filter((v) => {
      const t = Date.parse(v.entered_at);
      return Number.isFinite(t) && t0 - t >= 0 && t0 - t <= windowSeconds * 1000 && (t < t0 || v.id < mine.id);
    })
    .sort((x, y) => Date.parse(x.entered_at) - Date.parse(y.entered_at) || (x.id < y.id ? -1 : 1));
  return older[0] ?? null;
}

async function openVisits(db: SupabaseClient, propertyId: string): Promise<OpenSessionRow[]> {
  const r = await db.from("plate_sessions").select(SESSION_COLUMNS).eq("property_id", propertyId).is("exited_at", null).limit(500);
  if (r.error) throw r.error;
  return (r.data ?? []) as OpenSessionRow[];
}

/** Each visit's best score for its own plate. */
export async function visitPlateScores(db: SupabaseClient, visits: OpenSessionRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (visits.length === 0) return out;
  const plateOf = new Map(visits.map((v) => [v.id, v.normalized_plate]));
  const r = await db.from("plate_events")
    .select("session_id,normalized_plate,confidence")
    .in("session_id", visits.map((v) => v.id))
    .gte("confidence", 0.8)
    .limit(3000);
  if (r.error) throw r.error;
  for (const e of (r.data ?? []) as Array<{ session_id: string; normalized_plate: string | null; confidence: number | null }>) {
    if (!e.session_id || e.normalized_plate !== plateOf.get(e.session_id) || typeof e.confidence !== "number") continue;
    if ((out.get(e.session_id) ?? 0) < e.confidence) out.set(e.session_id, e.confidence);
  }
  return out;
}

export async function findOpenVisitForRead(
  db: SupabaseClient, propertyId: string, normalizedPlate: string, now: Date, readScore: number | null = null,
): Promise<{ visit: OpenSessionRow; how: "twin" | "like" } | null> {
  const open = await openVisits(db, propertyId);
  const scores = await visitPlateScores(db, open.filter((v) => v.state === "grace"));
  return pickOpenVisitForRead(normalizedPlate, open, now, TWIN_WINDOW_SECONDS, readScore, scores);
}

/** The reads attributed to a visit (its own PR reads, not inherited frames). */
async function visitReads(db: SupabaseClient, sessionId: string): Promise<ReadLite[]> {
  const r = await db.from("plate_events")
    .select("normalized_plate,confidence,inh:raw_data->>_inherited_from_session")
    .eq("session_id", sessionId)
    .not("normalized_plate", "is", null)
    .limit(500);
  if (r.error) throw r.error;
  return ((r.data ?? []) as Array<{ normalized_plate: string | null; confidence: number | null; inh: string | null }>)
    .filter((e) => e.normalized_plate && !e.inh)
    .map((e) => ({ plate: e.normalized_plate as string, score: e.confidence }));
}

/** The visit takes the consensus of its reads plus this one. Returns the
 *  plate the visit now carries. A clash with another open visit on the new
 *  plate (one open visit per plate) leaves the visit as it was. */
export async function adoptConsensusPlate(
  db: SupabaseClient, session: OpenSessionRow, read: { plateText: string; normalized: string; score: number }, now: Date,
): Promise<string> {
  const reads = await visitReads(db, session.id);
  reads.push({ plate: read.normalized, score: read.score });
  const c = consensusPlate(reads);
  if (!c || c.plate === session.normalized_plate) return session.normalized_plate;
  const upd = await db.from("plate_sessions")
    .update({ plate_text: c.plate, normalized_plate: c.plate, updated_at: now.toISOString() })
    .eq("id", session.id)
    .is("exited_at", null);
  if (upd.error) {
    if (String(upd.error.code) === "23505") return session.normalized_plate;
    throw upd.error;
  }
  console.log(`consensus plate: session=${session.id} ${session.normalized_plate} -> ${c.plate} (support ${c.support}${c.confirmed ? ", confirmed" : ""})`);
  return c.plate;
}

/** After a visit opened: if an older twin is open, move this visit's reads
 *  to it and remove this visit. Returns the twin, or null. */
export async function mergeIntoOlderTwin(
  db: SupabaseClient,
  mine: { id: string; property_id: string; normalized_plate: string; plate_text: string; entered_at: string; score: number },
  now: Date,
): Promise<OpenSessionRow | null> {
  const twin = pickOlderTwin(mine, await openVisits(db, mine.property_id));
  if (!twin) return null;
  const move = await db.from("plate_events").update({ session_id: twin.id }).eq("session_id", mine.id);
  if (move.error) throw move.error;
  const del = await db.from("plate_sessions").delete().eq("id", mine.id).is("exited_at", null);
  if (del.error) {
    console.warn(`twin merge: could not delete ${mine.id} (${del.error.message}); closing it`);
    const close = await db.from("plate_sessions")
      .update({ state: "closed_clean", exited_at: mine.entered_at, updated_at: now.toISOString() })
      .eq("id", mine.id);
    if (close.error) throw close.error;
  }
  const bump = await db.from("plate_sessions").update({ last_detected_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", twin.id);
  if (bump.error) throw bump.error;
  await adoptConsensusPlate(db, twin, { plateText: mine.plate_text, normalized: mine.normalized_plate, score: mine.score }, now);
  console.log(`twin merge: visit ${mine.id} (${mine.normalized_plate}) folded into ${twin.id} (${twin.normalized_plate})`);
  return twin;
}
