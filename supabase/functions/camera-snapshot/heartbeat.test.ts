import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { HEARTBEAT_HEADER, isHeartbeat, stampHeartbeat } from "./heartbeat.ts";

function req(headers: Record<string, string>): Request {
  return new Request("https://x.supabase.co/functions/v1/camera-snapshot/k/s", { method: "POST", headers });
}

Deno.test("isHeartbeat: only the exact header value 1 counts", () => {
  assertEquals(isHeartbeat(req({ [HEARTBEAT_HEADER]: "1" })), true);
  assertEquals(isHeartbeat(req({})), false);
  assertEquals(isHeartbeat(req({ [HEARTBEAT_HEADER]: "0" })), false);
  assertEquals(isHeartbeat(req({ [HEARTBEAT_HEADER]: "yes" })), false);
});

// Minimal alpr_cameras mock: update(...).eq(...).eq(...).select(...) resolves with the matched rows.
function fakeDb(rows: Array<{ id: string; api_key: string; active: boolean; last_seen_at: string | null }>) {
  const calls: { patch?: Record<string, unknown>; filters: Array<[string, unknown]> } = { filters: [] };
  const db = {
    from(table: string) {
      if (table !== "alpr_cameras") throw new Error(`unexpected table ${table}`);
      const b: any = {
        update(patch: Record<string, unknown>) { calls.patch = patch; return b; },
        eq(c: string, v: unknown) { calls.filters.push([c, v]); return b; },
        select() {
          const hit = rows.filter((r) => calls.filters.every(([c, v]) => (r as any)[c] === v));
          for (const r of hit) Object.assign(r, calls.patch);
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        },
      };
      return b;
    },
  } as any;
  return { db, calls };
}

Deno.test("stampHeartbeat: stamps last_seen_at on the active camera with that api_key", async () => {
  const rows = [
    { id: "c1", api_key: "ef0000000c081ef8", active: true, last_seen_at: null },
    { id: "c2", api_key: "other", active: true, last_seen_at: null },
  ];
  const { db } = fakeDb(rows);
  const now = new Date("2026-11-23T03:00:00Z");
  const r = await stampHeartbeat(db, "ef0000000c081ef8", now);
  assertEquals(r, { ok: true, heartbeat: true, camera_id: "c1" });
  assertEquals(rows[0].last_seen_at, "2026-11-23T03:00:00.000Z");
  assertEquals(rows[1].last_seen_at, null);
});

Deno.test("stampHeartbeat: unknown or inactive camera stamps nothing", async () => {
  const rows = [{ id: "c1", api_key: "k", active: false, last_seen_at: null }];
  const { db } = fakeDb(rows);
  assertEquals(await stampHeartbeat(db, "k", new Date()), { ok: false, heartbeat: true, reason: "unknown_camera" });
  assertEquals(rows[0].last_seen_at, null);
  assertEquals(await stampHeartbeat(db, "nope", new Date()), { ok: false, heartbeat: true, reason: "unknown_camera" });
});

Deno.test("stampHeartbeat: needs the api_key in the path", async () => {
  const { db, calls } = fakeDb([]);
  assertEquals(await stampHeartbeat(db, null, new Date()), { ok: false, heartbeat: true, reason: "no_camera_identity" });
  assertEquals(calls.patch, undefined);
});
