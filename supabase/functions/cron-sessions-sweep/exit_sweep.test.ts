import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pickStrayExits, sweepStrayApartmentExits, type StrayExitRow } from "./exit_sweep.ts";
import type { OpenSessionRow } from "../camera-snapshot/sessions.ts";

const row = (id: string, plate: string, conf: number, t: string, prop = "p1"): StrayExitRow => ({
  id, camera_id: "cam-d", property_id: prop, normalized_plate: plate, plate_text: plate, confidence: conf,
  created_at: `2026-11-13T${t}:00Z`,
});

Deno.test("pickStrayExits: one read per property and plate, oldest first, weak reads dropped", () => {
  const rows = [row("1", "VS2330", 1, "14:29"), row("2", "VS2330", 0.9, "14:29"), row("3", "69620W", 0.75, "14:06"),
    row("4", "LKH2416", 1, "20:36"), row("5", "LKH2416", 1, "20:36", "p2"), row("6", null as unknown as string, 1, "20:37")];
  assertEquals(pickStrayExits(rows, 0.8).map((r) => r.id), ["1", "4", "5"]);
});

// A thenable chain standing in for the supabase-js query builder.
function fakeDb(events: StrayExitRow[], log: string[]) {
  const chain = (table: string, op: string) => {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of ["select", "is", "eq", "gte", "order", "limit", "update"]) c[m] = self;
    c.then = (res: (v: unknown) => void) => {
      log.push(`${table}.${op}`);
      res(table === "plate_events" && op === "select" ? { data: events, error: null } : { data: null, error: null });
    };
    return c;
  };
  return {
    from: (table: string) => ({
      select: () => chain(table, "select"),
      update: () => chain(table, "update"),
    }),
  } as unknown as Parameters<typeof sweepStrayApartmentExits>[0]["db"];
}

Deno.test("sweep: a stray exit read closes the one open visit it belongs to and is linked to it", async () => {
  const log: string[] = [];
  const visit = { id: "s1", property_id: "p1", normalized_plate: "VS233", plate_text: "VS233", state: "grace", entered_at: "2026-11-13T14:19:00Z", visitor_pass_id: null, resident_plate_id: null, violation_id: null } as OpenSessionRow;
  const closed: string[] = [];
  const out = await sweepStrayApartmentExits({
    db: fakeDb([row("e1", "VS2330", 1, "14:29"), row("e2", "ZZZ999", 1, "14:30")], log),
    now: new Date("2026-11-13T14:40:00Z"),
    find: (_db, _prop, plate, _at) => Promise.resolve(plate === "VS2330" ? { visit, reason: "similar" as const } : null),
    close: (_db, s, cam, ev, at) => { closed.push(`${s.id}:${cam}:${ev}:${at.toISOString()}`); return Promise.resolve("closed_clean" as const); },
  });
  assertEquals(out, { examined: 2, closed: 1 });
  assertEquals(closed, ["s1:cam-d:e1:2026-11-13T14:29:00.000Z"]);
  assertEquals(log, ["plate_events.select", "plate_events.update"]);
});

Deno.test("sweep: a failing close does not stop the rest of the tick", async () => {
  const log: string[] = [];
  const visit = { id: "s1", property_id: "p1", normalized_plate: "A", plate_text: "A", state: "grace", entered_at: "2026-11-13T14:00:00Z", visitor_pass_id: null, resident_plate_id: null, violation_id: null } as OpenSessionRow;
  let calls = 0;
  const out = await sweepStrayApartmentExits({
    db: fakeDb([row("e1", "AB1234", 1, "14:29"), row("e2", "CD5678", 1, "14:30")], log),
    find: () => Promise.resolve({ visit, reason: "exact" as const }),
    close: () => { calls++; return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("closed_clean" as const); },
  });
  assertEquals(out, { examined: 2, closed: 1 });
});
