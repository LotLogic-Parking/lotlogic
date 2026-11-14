import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  countBurstProbes,
  findRecentlyClosedSession,
  frameScore,
  plateBoxHeight,
  readMatchesSession,
  repointIfBetter,
  resultScore,
  withinBurstWindow,
} from "./best_frame.ts";

// ── a tiny PostgREST-shaped fake: one table map, filters applied in order ──
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, log: string[] = []) {
  const jsonPath = (row: Row, col: string): unknown => {
    const m = col.match(/^(\w+)->>(\w+)$/);
    if (!m) return row[col];
    const obj = row[m[1]] as Record<string, unknown> | null | undefined;
    const v = obj?.[m[2]];
    return v === undefined || v === null ? null : String(v);
  };
  return {
    from(table: string) {
      const all = tables[table] ?? (tables[table] = []);
      let rows = [...all];
      let pending: { kind: "update"; patch: Row } | null = null;
      const b: Record<string, unknown> = {};
      const self = b as Record<string, (...a: unknown[]) => unknown>;
      const finish = () => {
        if (pending?.kind === "update") {
          const patch = pending.patch;
          for (const r of rows) Object.assign(r, patch);
          log.push(`update ${table} ${rows.length} row(s): ${JSON.stringify(patch)}`);
        }
        return { data: rows, error: null };
      };
      self.select = () => b;
      self.update = (patch: unknown) => { pending = { kind: "update", patch: patch as Row }; return b; };
      self.insert = (row: unknown) => { const r = { id: `ev${all.length + 1}`, ...(row as Row) }; all.push(r); rows = [r]; return b; };
      self.eq = (col: unknown, v: unknown) => { rows = rows.filter(r => jsonPath(r, col as string) === v); return b; };
      self.gte = (col: unknown, v: unknown) => { rows = rows.filter(r => String(r[col as string]) >= String(v)); return b; };
      self.not = (col: unknown, _op: unknown, _v: unknown) => { rows = rows.filter(r => r[col as string] !== null && r[col as string] !== undefined); return b; };
      self.order = () => b;
      self.limit = (n: unknown) => { rows = rows.slice(0, n as number); return Promise.resolve(finish()); };
      self.maybeSingle = () => { const out = finish(); return Promise.resolve({ data: out.data[0] ?? null, error: null }); };
      self.single = () => { const out = finish(); return Promise.resolve({ data: out.data[0] ?? null, error: null }); };
      // `.update(...).eq(...).select("id")` resolves through select when it is the last call.
      self.select = () => {
        const chain = b as unknown as Record<string, unknown>;
        const p = { then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej) };
        return Object.assign(Object.create(chain), p);
      };
      return b;
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

// ── scoring ──────────────────────────────────────────────────────────────

Deno.test("plateBoxHeight: ymax - ymin, 0 when the box is missing or malformed", () => {
  assertEquals(plateBoxHeight({ xmin: 10, ymin: 100, xmax: 90, ymax: 142 }), 42);
  assertEquals(plateBoxHeight(null), 0);
  assertEquals(plateBoxHeight({ ymin: "a", ymax: 3 }), 0);
  assertEquals(plateBoxHeight({ ymin: 50, ymax: 20 }), 0);
});

Deno.test("frameScore: box height wins, PR score breaks ties, no box falls back to score", () => {
  const big = frameScore({ confidence: 0.81, raw_data: { box: { ymin: 0, ymax: 60 } } });
  const small = frameScore({ confidence: 0.99, raw_data: { box: { ymin: 0, ymax: 30 } } });
  const tieA = frameScore({ confidence: 0.90, raw_data: { box: { ymin: 0, ymax: 30 } } });
  const noBox = frameScore({ confidence: 0.95, raw_data: {} });
  assertEquals(big > small, true);
  assertEquals(small > tieA, true);
  assertEquals(noBox < small, true);
  assertEquals(frameScore({ confidence: null, raw_data: null }), 0);
});

Deno.test("resultScore matches frameScore for the same read", () => {
  const r = { plate: "ABC123", score: 0.9, box: { xmin: 1, ymin: 10, xmax: 50, ymax: 35 } };
  assertEquals(resultScore(r), frameScore({ confidence: 0.9, raw_data: { box: r.box } }));
});

// ── window and plate gate ────────────────────────────────────────────────

Deno.test("withinBurstWindow: inside, at the edge, past, before, and off", () => {
  const now = new Date("2026-11-11T12:01:00Z");
  assertEquals(withinBurstWindow("2026-11-11T12:00:30Z", now, 90), true);
  assertEquals(withinBurstWindow("2026-11-11T11:59:30Z", now, 90), true);
  assertEquals(withinBurstWindow("2026-11-11T11:59:29Z", now, 90), false);
  assertEquals(withinBurstWindow("2026-11-11T12:02:00Z", now, 90), false);
  assertEquals(withinBurstWindow("2026-11-11T12:00:30Z", now, 0), false);
  assertEquals(withinBurstWindow(null, now, 90), false);
});

Deno.test("readMatchesSession: the burst rule of plate_identity", () => {
  assertEquals(readMatchesSession("ABC123", "ABC123"), true);
  assertEquals(readMatchesSession("ABC1Z3", "ABC123"), true);   // one confusable edit
  assertEquals(readMatchesSession("ABC12", "ABC123"), true);    // a dropped edge character is the same car in a burst
  assertEquals(readMatchesSession("XYZ789", "ABC123"), false);
  assertEquals(readMatchesSession("", "ABC123"), false);
});

// ── probes and the closed-session lookup ─────────────────────────────────

Deno.test("countBurstProbes counts only flagged rows on the session side", async () => {
  const db = fakeDb({
    plate_events: [
      { id: "e1", session_id: "s1", event_type: "entry", raw_data: { _burst: true } },
      { id: "e2", session_id: "s1", event_type: "entry", raw_data: { _burst: true } },
      { id: "e3", session_id: "s1", event_type: "entry", raw_data: {} },
      { id: "e4", session_id: "s1", event_type: "exit", raw_data: { _burst: true } },
      { id: "e5", session_id: "s2", event_type: "entry", raw_data: { _burst: true } },
    ],
  });
  assertEquals(await countBurstProbes(db, "s1", "entry"), 2);
  assertEquals(await countBurstProbes(db, "s1", "exit"), 1);
  assertEquals(await countBurstProbes(db, "s3", "entry"), 0);
});

Deno.test("findRecentlyClosedSession: same camera, inside the window, plate anchored-similar", async () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const rows = [
    { id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123", exited_at: "2026-11-11T11:59:40Z", exit_camera_id: "camD", exit_plate_event_id: "x1" },
    { id: "s2", property_id: "p1", normalized_plate: "QQQ999", plate_text: "QQQ999", exited_at: "2026-11-11T11:59:50Z", exit_camera_id: "camD", exit_plate_event_id: "x2" },
    { id: "s3", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123", exited_at: "2026-11-11T11:50:00Z", exit_camera_id: "camD", exit_plate_event_id: "x3" },
    { id: "s4", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123", exited_at: "2026-11-11T11:59:55Z", exit_camera_id: "camC", exit_plate_event_id: "x4" },
    { id: "s5", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123", exited_at: "2026-11-11T11:59:58Z", exit_camera_id: "camD", exit_plate_event_id: null },
  ];
  const db = fakeDb({ plate_sessions: rows });
  assertEquals((await findRecentlyClosedSession(db, "p1", "camD", "ABC1Z3", now, 90))?.id, "s1");
  assertEquals(await findRecentlyClosedSession(db, "p1", "camD", "ZZZ111", now, 90), null);
  assertEquals(await findRecentlyClosedSession(db, "p1", "camD", "ABC123", now, 0), null);
  // s3 is out of the window, s4 is another camera, s5 has no exit event: none of them answer for camC/old reads.
  assertEquals(await findRecentlyClosedSession(db, "p1", "camE", "ABC123", now, 90), null);
});

// ── repointIfBetter ──────────────────────────────────────────────────────

const sessionWith = (over: Row = {}) => ({
  id: "s1", entry_plate_event_id: "e1", exit_plate_event_id: "x1", violation_id: null, ...over,
});
const ev = (id: string, h: number, conf = 0.9) => ({ id, confidence: conf, raw_data: { box: { ymin: 0, ymax: h } } });

Deno.test("repointIfBetter: a sharper frame takes the entry photo", async () => {
  const log: string[] = [];
  const sessions = [sessionWith()];
  const db = fakeDb({ plate_sessions: sessions, plate_events: [ev("e1", 30), ev("e2", 45)] }, log);
  const out = await repointIfBetter(db, "s1", "entry", { id: "e2", score: frameScore(ev("e2", 45)) }, new Date("2026-11-11T12:00:00Z"));
  assertEquals(out, "repointed");
  assertEquals(sessions[0].entry_plate_event_id, "e2");
  assertEquals(log.length, 1);
});

Deno.test("repointIfBetter: a worse or equal frame is kept out", async () => {
  const sessions = [sessionWith()];
  const db = fakeDb({ plate_sessions: sessions, plate_events: [ev("e1", 30), ev("e2", 20)] });
  assertEquals(await repointIfBetter(db, "s1", "entry", { id: "e2", score: frameScore(ev("e2", 20)) }, new Date()), "kept");
  assertEquals(await repointIfBetter(db, "s1", "entry", { id: "e2", score: frameScore(ev("e1", 30)) }, new Date()), "kept");
  assertEquals(sessions[0].entry_plate_event_id, "e1");
});

Deno.test("repointIfBetter: the entry photo is frozen once a violation exists; the exit photo is not", async () => {
  const sessions = [sessionWith({ violation_id: "v1" })];
  const db = fakeDb({ plate_sessions: sessions, plate_events: [ev("e1", 30), ev("e2", 90), ev("x1", 30), ev("x2", 90)] });
  assertEquals(await repointIfBetter(db, "s1", "entry", { id: "e2", score: 90.9 }, new Date()), "frozen");
  assertEquals(sessions[0].entry_plate_event_id, "e1");
  assertEquals(await repointIfBetter(db, "s1", "exit", { id: "x2", score: 90.9 }, new Date()), "repointed");
  assertEquals(sessions[0].exit_plate_event_id, "x2");
});

Deno.test("repointIfBetter: no current pointer (session not closed yet) and a lost race", async () => {
  const sessions = [sessionWith({ exit_plate_event_id: null })];
  const db = fakeDb({ plate_sessions: sessions, plate_events: [ev("x2", 90)] });
  assertEquals(await repointIfBetter(db, "s1", "exit", { id: "x2", score: 90.9 }, new Date()), "no_current");

  // Another frame moved the pointer between our read and our write: the
  // compare-and-set finds no row and reports the race instead of clobbering.
  const racing = [sessionWith()];
  const log: string[] = [];
  const db2 = fakeDb({ plate_sessions: racing, plate_events: [ev("e1", 30), ev("e2", 45), ev("e3", 40)] }, log);
  const origFrom = db2.from.bind(db2);
  let reads = 0;
  db2.from = (table: string) => {
    if (table === "plate_events" && reads++ === 0) racing[0].entry_plate_event_id = "e2"; // slips in after we fetched the session
    return origFrom(table);
  };
  assertEquals(await repointIfBetter(db2, "s1", "entry", { id: "e3", score: frameScore(ev("e3", 40)) }, new Date()), "lost_race");
  assertEquals(racing[0].entry_plate_event_id, "e2");
});
