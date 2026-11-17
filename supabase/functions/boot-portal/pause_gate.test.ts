import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { annotatePauses, dispatchedBeforePause, lockPauseRefusal, unknownPauseBlocks } from "./pause_gate.ts";
import type { ActivePause, PauseRead } from "../_shared/pause.ts";

// Property points as stored in production on 2026-11-15 (payments.test.ts).
const POINTS = [
  { id: "mayfield", name: "Mayfield Memorial Apartments", lat: 35.282624, lng: -80.811167 },
  { id: "1825", name: "The Villas at 1825", lat: 34.977589, lng: -80.997895 },
  { id: "riverview", name: "The Villas at Riverview", lat: 34.978935, lng: -80.994601 },
];
const MINE = [{ id: "1825", name: "The Villas at 1825" }, { id: "mayfield", name: "Mayfield Memorial Apartments" }];
// Sat Nov 21 2026, 6:00 PM Eastern (EST).
const pause = (property_id: string): ActivePause => ({ id: `p-${property_id}`, property_id, starts_at: "2026-11-20T23:00:00Z", ends_at: "2026-11-21T23:00:00Z", reason: "Pool party" });
const active = (...ids: string[]) => new Map(ids.map((id) => [id, pause(id)]));

Deno.test("lock at a paused property: 409 enforcement_paused with the property and the Eastern end time", () => {
  assertEquals(lockPauseRefusal({ propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS }), {
    code: "enforcement_paused", message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Nothing was recorded. Take the boot off the wheel.",
  });
});

Deno.test("lock at an unpaused property: no refusal, even while another property is paused", () => {
  assertEquals(lockPauseRefusal({ propertyId: "1825", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS }), null);
  assertEquals(lockPauseRefusal({ propertyId: "1825", myProperties: MINE, lat: null, lon: null, active: new Map(), points: POINTS }), null);
});

Deno.test("lock with no property picked: GPS inside a paused property refuses, even one that is not the agent's", () => {
  // In Mayfield's lot; the agent here only has The Villas at 1825.
  assertEquals(lockPauseRefusal({ propertyId: null, myProperties: [MINE[0]], lat: 35.2831, lon: -80.8105, active: active("mayfield"), points: POINTS }), {
    code: "enforcement_paused", message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Nothing was recorded. Take the boot off the wheel.",
  });
  // GPS clearly somewhere else: the boot goes ahead.
  assertEquals(lockPauseRefusal({ propertyId: null, myProperties: MINE, lat: 34.9776, lon: -80.9979, active: active("mayfield"), points: POINTS }), null);
});

Deno.test("lock with no property and no GPS while one of the agent's properties is paused: pick the property first", () => {
  const r = lockPauseRefusal({ propertyId: null, myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS });
  assertEquals(r, { code: "enforcement_paused", message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Nothing was recorded. Pick the property you are booting at." });
  assertEquals(lockPauseRefusal({ propertyId: null, myProperties: MINE, lat: 0, lon: 0, active: active("mayfield"), points: POINTS })?.code, "enforcement_paused");
  assertEquals(lockPauseRefusal({ propertyId: null, myProperties: [MINE[0]], lat: null, lon: null, active: active("mayfield"), points: POINTS }), null);
});

Deno.test("unknown pause state: refuse unless the picked property is known not to be an apartment", () => {
  assertEquals(unknownPauseBlocks("apartment"), true);
  assertEquals(unknownPauseBlocks(null), true);         // no property picked, or type unknown
  assertEquals(unknownPauseBlocks("truck_plaza"), false); // pauses exist only at apartments
});

Deno.test("GET /properties: each property carries paused_until (the effective end) or null", () => {
  const read: PauseRead = { ok: true, missing: false, active: active("mayfield"), recentlyEnded: new Map() };
  assertEquals(annotatePauses({ ok: true, properties: MINE }, read), {
    ok: true,
    properties: [{ id: "1825", name: "The Villas at 1825", paused_until: null }, { id: "mayfield", name: "Mayfield Memorial Apartments", paused_until: "2026-11-21T23:00:00Z" }],
  });
  // A failed read says so instead of claiming nothing is paused; lock() still checks.
  assertEquals(annotatePauses({ ok: true, properties: MINE }, { ok: false, error: "x" }), { ok: true, properties: MINE, pauses_unknown: true });
});

Deno.test("lock during a pause: a car the drivers were texted to boot before the pause started still stands", () => {
  // Pause starts Fri Nov 20, 6:00 PM ET (23:00 UTC).
  const before = [{ property_id: "mayfield", plate_text: "ABC1234", dispatched_at: "2026-11-20T22:55:00Z" }];
  const base = { propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS };
  assertEquals(lockPauseRefusal({ ...base, plate: "abc-1234", standing: before }), null);
  // By GPS, too.
  assertEquals(lockPauseRefusal({ ...base, propertyId: null, lat: 35.2831, lon: -80.8105, plate: "ABC1234", standing: before }), null);
  // Another plate, a dispatch sent after the start, or one at another property: refused.
  assertEquals(lockPauseRefusal({ ...base, plate: "XYZ789", standing: before })?.code, "enforcement_paused");
  assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", standing: [{ ...before[0], dispatched_at: "2026-11-20T23:05:00Z" }] })?.code, "enforcement_paused");
  assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", standing: [{ ...before[0], property_id: "1825" }] })?.code, "enforcement_paused");
  assertEquals(dispatchedBeforePause("", "mayfield", pause("mayfield"), before), false);
});
