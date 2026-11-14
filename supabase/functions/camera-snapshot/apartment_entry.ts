// One car, one tile (Gabe, 2026-11-14: "we still have plates that are close
// to each other reading as separate visits"). Apartments only, unregistered
// reads only: a read that matches a resident or a live pass is that car.
//
//  Twin. Two frames of one car at the gate read a plate two ways (TAK983
//     and AK983 eleven seconds apart). findSimilarOpenSession misses them
//     when the first visit is already "anchored" (three reads at 0.9+ make
//     it match same-length plates only) or when the two frames are being
//     ingested at the same moment and neither sees the other's visit. A
//     read within TWIN_WINDOW_SECONDS of an open visit whose plate is close
//     joins that visit; a visit that opened anyway merges into the older
//     twin right after opening.
//
//  Like. The same car hours later read a little differently (SVL41 at 11 PM,
//     SVL414 at 3:40 AM). The exact lookup misses it and the fuzzy lookup
//     only looks two minutes back, so a second tile opens. A read that is
//     plateSimilar to exactly one open unregistered visit of any age is that
//     visit, and the re-entry rule (apartment_close.ts) decides whether it
//     is the same stay or a new one.
//
//  Better plate. When a read joins a visit under a different plate, the
//     visit takes the better read: a clearly higher score, or the longer
//     plate at a similar score (the short one is the truncation).

import type { SupabaseClient } from "@supabase/supabase-js";
import { plateSimilar, type OpenSessionRow } from "./sessions.ts";

export const TWIN_WINDOW_SECONDS = 120;
export const BETTER_SCORE_MARGIN = 0.05;

const SESSION_COLUMNS = "id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id";

function levenshteinBounded(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Two reads of one car within the twin window. plateSimilar, or two edits
 *  apart on plates of five or more characters. */
export function twinSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (plateSimilar(a, b, false)) return true;
  return Math.max(a.length, b.length) >= 5 && levenshteinBounded(a, b, 2) <= 2;
}

/** The same car read a little differently, any time apart. plateSimilar only. */
export function likeSimilar(a: string, b: string): boolean {
  return !!a && !!b && plateSimilar(a, b, false);
}

/** Should the visit take the new read's plate? */
export function betterPlate(current: { plate: string; score: number }, read: { plate: string; score: number }): boolean {
  if (!read.plate || read.plate === current.plate) return false;
  if (read.score >= current.score + BETTER_SCORE_MARGIN) return true;
  if (read.score + BETTER_SCORE_MARGIN < current.score) return false;
  return read.plate.length > current.plate.length;
}

type Lite = Pick<OpenSessionRow, "id" | "normalized_plate" | "state" | "entered_at">;

/** The open unregistered visit this read joins, or null: an earliest twin
 *  inside the window, else a single like visit of any age. */
export function pickOpenVisitForRead<T extends Lite>(
  read: string,
  open: T[],
  now: Date,
  windowSeconds: number = TWIN_WINDOW_SECONDS,
): { visit: T; how: "twin" | "like" } | null {
  if (!read) return null;
  const grace = open.filter((v) => v.state === "grace" && v.normalized_plate !== read);
  const twins = grace
    .filter((v) => {
      const t = Date.parse(v.entered_at);
      return Number.isFinite(t) && now.getTime() - t <= windowSeconds * 1000 && now.getTime() - t >= -windowSeconds * 1000 && twinSimilar(v.normalized_plate, read);
    })
    .sort((x, y) => Date.parse(x.entered_at) - Date.parse(y.entered_at));
  if (twins.length > 0) return { visit: twins[0], how: "twin" };
  const like = grace.filter((v) => likeSimilar(v.normalized_plate, read));
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
    .filter((v) => v.id !== mine.id && v.state === "grace" && twinSimilar(v.normalized_plate, mine.normalized_plate))
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

export async function findOpenVisitForRead(
  db: SupabaseClient, propertyId: string, normalizedPlate: string, now: Date,
): Promise<{ visit: OpenSessionRow; how: "twin" | "like" } | null> {
  return pickOpenVisitForRead(normalizedPlate, await openVisits(db, propertyId), now);
}

/** The visit takes the read's plate when the read is better. Returns the
 *  plate the visit now carries. A clash with another open visit on the new
 *  plate (one open visit per plate) leaves the visit as it was. */
export async function adoptBetterPlate(
  db: SupabaseClient, session: OpenSessionRow, read: { plateText: string; normalized: string; score: number }, now: Date,
): Promise<string> {
  const cur = await db.from("plate_events")
    .select("confidence")
    .eq("session_id", session.id)
    .eq("normalized_plate", session.normalized_plate)
    .order("confidence", { ascending: false })
    .limit(1);
  if (cur.error) throw cur.error;
  const curScore = typeof cur.data?.[0]?.confidence === "number" ? cur.data[0].confidence : 0;
  if (!betterPlate({ plate: session.normalized_plate, score: curScore }, { plate: read.normalized, score: read.score })) {
    return session.normalized_plate;
  }
  const upd = await db.from("plate_sessions")
    .update({ plate_text: read.plateText, normalized_plate: read.normalized, updated_at: now.toISOString() })
    .eq("id", session.id)
    .is("exited_at", null);
  if (upd.error) {
    if (String(upd.error.code) === "23505") return session.normalized_plate;
    throw upd.error;
  }
  console.log(`better plate: session=${session.id} ${session.normalized_plate} (${curScore}) -> ${read.normalized} (${read.score})`);
  return read.normalized;
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
    // Something already points at the new row: close it instead of deleting.
    console.warn(`twin merge: could not delete ${mine.id} (${del.error.message}); closing it`);
    const close = await db.from("plate_sessions")
      .update({ state: "closed_clean", exited_at: mine.entered_at, updated_at: now.toISOString() })
      .eq("id", mine.id);
    if (close.error) throw close.error;
  }
  const bump = await db.from("plate_sessions").update({ last_detected_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", twin.id);
  if (bump.error) throw bump.error;
  await adoptBetterPlate(db, twin, { plateText: mine.plate_text, normalized: mine.normalized_plate, score: mine.score }, now);
  console.log(`twin merge: visit ${mine.id} (${mine.normalized_plate}) folded into ${twin.id} (${twin.normalized_plate})`);
  return twin;
}
