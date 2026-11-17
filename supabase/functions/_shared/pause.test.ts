import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { coversAt, effectiveEnd, endsLocal, excludePaused, inList, pausesFromRows, readPauses, type PauseRow } from "./pause.ts";

const P = (o: Partial<PauseRow>): PauseRow => ({
  id: "x", property_id: "p1", starts_at: "2026-11-20T23:00:00Z", ends_at: "2026-11-21T23:00:00Z",
  ended_early_at: null, cancelled_at: null, reason: null, ...o,
});
const at = (iso: string) => new Date(iso);

Deno.test("effectiveEnd: ended early wins over the scheduled end", () => {
  assertEquals(effectiveEnd(P({})), "2026-11-21T23:00:00Z");
  assertEquals(effectiveEnd(P({ ended_early_at: "2026-11-21T01:00:00Z" })), "2026-11-21T01:00:00Z");
});

Deno.test("coversAt: starts_at <= at < effective end, never when cancelled", () => {
  const p = P({});
  assertEquals(coversAt(p, at("2026-11-20T22:59:59Z")), false);
  assertEquals(coversAt(p, at("2026-11-20T23:00:00Z")), true);
  assertEquals(coversAt(p, at("2026-11-21T22:59:59Z")), true);
  assertEquals(coversAt(p, at("2026-11-21T23:00:00Z")), false); // at == ends_at: enforcement is back
  assertEquals(coversAt(P({ ended_early_at: "2026-11-21T01:00:00Z" }), at("2026-11-21T01:00:00Z")), false);
  assertEquals(coversAt(P({ ended_early_at: "2026-11-21T01:00:00Z" }), at("2026-11-21T00:59:59Z")), true);
  assertEquals(coversAt(P({ cancelled_at: "2026-11-19T00:00:00Z" }), at("2026-11-21T00:00:00Z")), false);
  // Postgres hands back "+00:00" offsets, not "Z".
  assertEquals(coversAt(P({ starts_at: "2026-11-20 23:00:00+00", ends_at: "2026-11-21T23:00:00+00:00" }), at("2026-11-21T00:00:00Z")), true);
});

Deno.test("pausesFromRows: active map holds the effective end; recently ended within the window; the rest dropped", () => {
  const rows = [
    P({ id: "a", property_id: "p1", reason: "Pool party" }),                                                   // active
    P({ id: "b", property_id: "p2", starts_at: "2026-11-19T00:00:00Z", ends_at: "2026-11-21T00:00:00Z",
      ended_early_at: "2026-11-20T10:00:00Z" }),                                                               // ended early 14 h ago
    P({ id: "c", property_id: "p3", starts_at: "2026-11-18T00:00:00Z", ends_at: "2026-11-19T00:00:00Z" }),   // ended 48 h ago
    P({ id: "d", property_id: "p4", starts_at: "2026-11-22T00:00:00Z", ends_at: "2026-11-23T00:00:00Z" }),   // scheduled, not started
    P({ id: "e", property_id: "p5", cancelled_at: "2026-11-20T00:00:00Z" }),                                  // cancelled
  ];
  const r = pausesFromRows(rows, at("2026-11-21T00:00:00Z"), 24);
  assertEquals([...r.active.keys()], ["p1"]);
  assertEquals(r.active.get("p1"), { id: "a", property_id: "p1", starts_at: "2026-11-20T23:00:00Z", ends_at: "2026-11-21T23:00:00Z", reason: "Pool party" });
  assertEquals([...r.recentlyEnded.entries()], [["p2", "2026-11-20T10:00:00Z"]]);
});

Deno.test("endsLocal: Eastern weekday and clock, whatever the server zone, both sides of the DST change", () => {
  assertEquals(endsLocal("2026-11-21T23:00:00Z"), "Sat 6:00 PM");   // EST
  assertEquals(endsLocal("2026-10-31T22:00:00Z"), "Sat 6:00 PM");   // EDT
  assertEquals(endsLocal("2027-03-14T11:00:00Z"), "Sun 7:00 AM");   // first morning of EDT
  assertEquals(endsLocal("junk"), "");
});

Deno.test("inList: a PostgREST in() list", () => {
  assertEquals(inList(["a", "b"]), "(a,b)");
});

// ── a recording query fake ───────────────────────────────────────────────
function recorder() {
  const calls: unknown[][] = [];
  const q = {
    not: (...a: unknown[]) => { calls.push(["not", ...a]); return q; },
    neq: (...a: unknown[]) => { calls.push(["neq", ...a]); return q; },
  };
  return { q, calls };
}

Deno.test("excludePaused: known pauses filter in SQL before any limit; none paused adds nothing", () => {
  const known = { ok: true as const, missing: false, active: new Map([["p1", { id: "a", property_id: "p1", starts_at: "", ends_at: "", reason: null }]]), recentlyEnded: new Map() };
  let r = recorder();
  excludePaused(r.q, known, "properties.property_type");
  assertEquals(r.calls, [["not", "property_id", "in", "(p1)"]]);
  r = recorder();
  excludePaused(r.q, { ...known, active: new Map() }, "properties.property_type");
  assertEquals(r.calls, []);
});

Deno.test("excludePaused: an unknown pause state holds apartments only; truck plazas keep going", () => {
  const r = recorder();
  excludePaused(r.q, { ok: false, error: "boom" }, "properties.property_type");
  assertEquals(r.calls, [["neq", "properties.property_type", "apartment"]]);
});

// ── readPauses against a fake client ─────────────────────────────────────
function fakeClient(results: Array<{ data: unknown; error: unknown }>) {
  const seen: unknown[][] = [];
  let n = 0;
  const client = {
    from(table: string) {
      seen.push(["from", table]);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "is", "lte", "gt"]) b[m] = (...a: unknown[]) => { seen.push([m, ...a]); return b; };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(results[Math.min(n++, results.length - 1)]).then(res, rej);
      return b;
    },
  };
  return { client, seen, calls: () => n };
}

Deno.test("readPauses: one query bounded by `at` and the recent window", async () => {
  const f = fakeClient([{ data: [P({ id: "a" })], error: null }]);
  const r = await readPauses(f.client, at("2026-11-21T00:00:00Z"), { recentHours: 24 });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals([...r.active.keys()], ["p1"]);
  assertEquals(f.calls(), 1);
  assertEquals(f.seen.slice(0, 1), [["from", "enforcement_pauses"]]);
  assertEquals(f.seen.filter((c) => c[0] !== "from" && c[0] !== "select"), [
    ["is", "cancelled_at", null],
    ["lte", "starts_at", "2026-11-21T00:00:00.000Z"],
    ["gt", "ends_at", "2026-11-20T00:00:00.000Z"],
  ]);
});

Deno.test("readPauses: a missing table (migration not applied yet) means no pauses exist", async () => {
  for (const code of ["PGRST205", "42P01"]) {
    const f = fakeClient([{ data: null, error: { code, message: "relation does not exist" } }]);
    const r = await readPauses(f.client, at("2026-11-21T00:00:00Z"));
    assertEquals(r.ok, true);
    if (r.ok) { assertEquals(r.missing, true); assertEquals(r.active.size, 0); }
  }
});

Deno.test("readPauses: any other error is retried once, then reported as unknown (never as 'not paused')", async () => {
  const flaky = fakeClient([{ data: null, error: { code: "57014", message: "timeout" } }, { data: [P({})], error: null }]);
  const ok = await readPauses(flaky.client, at("2026-11-21T00:00:00Z"));
  assertEquals(ok.ok, true);
  assertEquals(flaky.calls(), 2);
  const down = fakeClient([{ data: null, error: { code: "42501", message: "permission denied" } }]);
  const bad = await readPauses(down.client, at("2026-11-21T00:00:00Z"));
  assertEquals(bad.ok, false);
  assertEquals(down.calls(), 2);
  const thrown = await readPauses({ from() { throw new Error("network"); } }, at("2026-11-21T00:00:00Z"));
  assertEquals(thrown.ok, false);
});
