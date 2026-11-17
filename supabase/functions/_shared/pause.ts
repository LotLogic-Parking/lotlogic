// ── Enforcement pause: "is enforcement paused at property P at time T" ──
//
// A property manager can pause enforcement at an apartment for at most 72 h
// (spec 2026-11-16 Part 3; table `enforcement_pauses`, backend migration). A
// pause covers `at` when it is not cancelled and starts_at <= at < effective
// end, where effective end = ended_early_at ?? ends_at. When it ends,
// enforcement resumes at once with no new grace (Gabe, 2026-11-16).
//
// Used by cron-sessions-sweep (bootDispatch, overstayExpiry, the pending
// dispatch loop, graceExpiry's stale clock) and boot-portal lock(). One query
// per tick, not per row: the table is tiny.
//
// A failed read is never "not paused". It comes back { ok: false } and each
// caller decides what to hold (see cron-sessions-sweep/index.ts). A missing
// table is the one error that is safe to read as "no pauses": the migration
// has not been applied, so no pause can exist yet.

export const PAUSE_TABLE = "enforcement_pauses";
export const PAUSE_TZ = "America/New_York";

export type PauseRow = {
  id: string;
  property_id: string;
  starts_at: string;
  ends_at: string;
  ended_early_at: string | null;
  cancelled_at: string | null;
  reason: string | null;
};

/** A pause in force now. `ends_at` is the effective end (ended early, else scheduled). */
export type ActivePause = { id: string; property_id: string; starts_at: string; ends_at: string; reason: string | null };

export type PauseRead =
  | { ok: true; missing: boolean; active: Map<string, ActivePause>; recentlyEnded: Map<string, string> }
  | { ok: false; error: string };

// Structural, so the jsr (sweep) and npm (boot-portal) supabase clients both fit.
// deno-lint-ignore no-explicit-any
export type PauseDb = { from(table: string): any };

const ms = (iso: string | null | undefined) => (iso ? Date.parse(String(iso).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")) : NaN);

export function effectiveEnd(p: Pick<PauseRow, "ends_at" | "ended_early_at">): string {
  return p.ended_early_at ?? p.ends_at;
}

export function coversAt(p: PauseRow, at: Date): boolean {
  if (p.cancelled_at) return false;
  const t = at.getTime();
  const s = ms(p.starts_at), e = ms(effectiveEnd(p));
  return Number.isFinite(s) && Number.isFinite(e) && s <= t && t < e;
}

/** Pure half of readPauses: which properties are paused at `at`, and which came out of a pause within `recentHours`. */
export function pausesFromRows(rows: PauseRow[], at: Date, recentHours = 0) {
  const active = new Map<string, ActivePause>();
  const recentlyEnded = new Map<string, string>();
  const t = at.getTime();
  for (const p of rows) {
    if (p.cancelled_at) continue;
    if (coversAt(p, at)) {
      active.set(p.property_id, { id: p.id, property_id: p.property_id, starts_at: p.starts_at, ends_at: effectiveEnd(p), reason: p.reason ?? null });
      continue;
    }
    const end = effectiveEnd(p), e = ms(end), s = ms(p.starts_at);
    if (!Number.isFinite(e) || !Number.isFinite(s) || s > t || e > t) continue; // not started, or junk
    if (t - e >= recentHours * 3_600_000) continue;
    const prev = recentlyEnded.get(p.property_id);
    if (!prev || ms(prev) < e) recentlyEnded.set(p.property_id, end);
  }
  return { active, recentlyEnded };
}

function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { code?: string; message?: string };
    return [o.code, o.message].filter(Boolean).join(" ").slice(0, 200) || "unknown";
  }
  return String(e).slice(0, 200);
}

export function isMissingTable(e: unknown): boolean {
  const code = (e && typeof e === "object" ? (e as { code?: string }).code : null) ?? "";
  return code === "PGRST205" || code === "42P01";
}

/**
 * Every pause that covers `at`, plus every pause that ended within `recentHours`
 * before it. One query; one retry on error.
 */
export async function readPauses(db: PauseDb, at: Date, opts: { recentHours?: number } = {}): Promise<PauseRead> {
  const recentHours = opts.recentHours ?? 0;
  const atIso = at.toISOString();
  const sinceIso = new Date(at.getTime() - recentHours * 3_600_000).toISOString();
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await db.from(PAUSE_TABLE)
        .select("id,property_id,starts_at,ends_at,ended_early_at,cancelled_at,reason")
        .is("cancelled_at", null)
        .lte("starts_at", atIso)
        .gt("ends_at", sinceIso);
      if (error) {
        if (isMissingTable(error)) return { ok: true, missing: true, active: new Map(), recentlyEnded: new Map() };
        last = error;
        continue;
      }
      return { ok: true, missing: false, ...pausesFromRows((data ?? []) as PauseRow[], at, recentHours) };
    } catch (e) {
      last = e;
    }
  }
  return { ok: false, error: errText(last) };
}

/** "(a,b)" for PostgREST's not.in / in filters. Ids are uuids, so no quoting is needed. */
export function inList(ids: Iterable<string>): string {
  return `(${[...ids].join(",")})`;
}

/**
 * Filter a candidate query by the pause state, in SQL and before any limit
 * (a paused property must never fill the per-tick window and starve the rest).
 * Known: leave out the paused properties. Unknown (the read failed): hold
 * every apartment for this tick. Pauses exist only at apartments, so truck
 * plazas keep going; the query must embed properties!inner(property_type)
 * under `typeColumn` for that case.
 */
export function excludePaused<Q extends { not(c: string, op: string, v: string): Q; neq(c: string, v: string): Q }>(q: Q, read: PauseRead, typeColumn: string): Q {
  if (!read.ok) return q.neq(typeColumn, "apartment");
  if (read.active.size === 0) return q;
  return q.not("property_id", "in", inList(read.active.keys()));
}

/** "Sat 6:00 PM" in Eastern time. */
export function endsLocal(iso: string): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t)
    .toLocaleString("en-US", { timeZone: PAUSE_TZ, weekday: "short", hour: "numeric", minute: "2-digit" })
    .replace(/ /g, " ")
    .replace(",", "");
}
