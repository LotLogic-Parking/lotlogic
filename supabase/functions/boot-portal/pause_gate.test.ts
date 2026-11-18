import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { annotatePauses, dispatchedBeforePause, flaggedBeforePause, lockPauseRefusal, officeRequested, protectedAt, unknownPauseBlocks, type ParkingPass } from "./pause_gate.ts";
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
    code: "enforcement_paused", message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then. Nothing was recorded. Take the boot off the wheel.",
  });
});

Deno.test("lock at an unpaused property: no refusal, even while another property is paused", () => {
  assertEquals(lockPauseRefusal({ propertyId: "1825", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS }), null);
  assertEquals(lockPauseRefusal({ propertyId: "1825", myProperties: MINE, lat: null, lon: null, active: new Map(), points: POINTS }), null);
});

Deno.test("lock with no property picked: GPS inside a paused property refuses, even one that is not the agent's", () => {
  // In Mayfield's lot; the agent here only has The Villas at 1825.
  assertEquals(lockPauseRefusal({ propertyId: null, myProperties: [MINE[0]], lat: 35.2831, lon: -80.8105, active: active("mayfield"), points: POINTS }), {
    code: "enforcement_paused", message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then. Nothing was recorded. Take the boot off the wheel.",
  });
  // GPS clearly somewhere else: the boot goes ahead.
  assertEquals(lockPauseRefusal({ propertyId: null, myProperties: MINE, lat: 34.9776, lon: -80.9979, active: active("mayfield"), points: POINTS }), null);
});

Deno.test("lock with no property and no GPS while one of the agent's properties is paused: pick the property first", () => {
  const r = lockPauseRefusal({ propertyId: null, myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS });
  assertEquals(r, { code: "enforcement_paused", message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then. Nothing was recorded. Pick the property you are booting at." });
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

Deno.test("lock with no property and no GPS: a car sent to the agent before the pause still goes ahead; any other car is told to pick the property", () => {
  // Gabe 2026-11-17: a boot dispatch texted before the pause goes ahead during it. Without a property or a
  // location, the plate itself says where: it was sent to be booted at one of the agent's paused properties.
  const before = [{ property_id: "mayfield", plate_text: "ABC1234", dispatched_at: "2026-11-20T22:55:00Z" }];
  const base = { propertyId: null, myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS };
  assertEquals(lockPauseRefusal({ ...base, plate: "abc 1234", standing: before }), null);
  // Sent after the pause started, or another plate: refused, as before.
  assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", standing: [{ ...before[0], dispatched_at: "2026-11-20T23:05:00Z" }] })?.code, "enforcement_paused");
  assertEquals(lockPauseRefusal({ ...base, plate: "XYZ789", standing: before })?.code, "enforcement_paused");
});

Deno.test("lock during a pause: a dispatch answered DONE stands only while the reply is recent (BOOT_REPLY_HOURS)", () => {
  const now = new Date("2026-11-21T01:00:00Z");
  const sent = { property_id: "mayfield", plate_text: "ABC1234", dispatched_at: "2026-11-20T22:55:00Z", status: "resolved", action_taken: "boot" };
  assertEquals(dispatchedBeforePause("ABC1234", "mayfield", pause("mayfield"), [{ ...sent, resolved_at: "2026-11-20T23:10:00Z" }], now), true);
  // The same car booted weeks ago and back during the pause: refused, it is new enforcement.
  const old = { ...sent, dispatched_at: "2026-10-30T15:00:00Z", resolved_at: "2026-10-30T15:20:00Z" };
  assertEquals(dispatchedBeforePause("ABC1234", "mayfield", pause("mayfield"), [old], now), false);
  assertEquals(lockPauseRefusal({ propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS, plate: "ABC1234", standing: [old], now })?.code, "enforcement_paused");
  // An open dispatch is not windowed here: the sweep dismisses a stale one (BOOT_STALE_HOURS), which then refuses.
  assertEquals(dispatchedBeforePause("ABC1234", "mayfield", pause("mayfield"), [{ ...sent, status: "dispatched", action_taken: null }], now), true);
});

Deno.test("lock during a pause: an open office tow request on the plate stands, placed before the pause or during it (Gabe 2026-11-18)", () => {
  const now = new Date("2026-11-21T01:00:00Z");
  const req = { property_id: "mayfield", kind: "tow", status: "active", normalized_plate: "ABC1234", normalized_back_plate: null, created_at: "2026-11-20T21:00:00Z", expires_at: null };
  const base = { propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS, now };
  assertEquals(lockPauseRefusal({ ...base, plate: "abc-1234", requests: [req] }), null);
  assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", requests: [{ ...req, created_at: "2026-11-21T00:30:00Z" }] }), null);
  // By GPS, and with neither property nor GPS (the plate says where).
  assertEquals(lockPauseRefusal({ ...base, propertyId: null, lat: 35.2831, lon: -80.8105, plate: "ABC1234", requests: [req] }), null);
  assertEquals(lockPauseRefusal({ ...base, propertyId: null, plate: "ABC1234", requests: [req] }), null);
  // Back plate matches; expiry is read against now.
  assertEquals(officeRequested("ABC1234", "mayfield", [{ ...req, normalized_plate: "ZZZ0000", normalized_back_plate: "ABC1234" }], now), true);
  assertEquals(officeRequested("ABC1234", "mayfield", [{ ...req, expires_at: "2026-11-21T02:00:00Z" }], now), true);
  assertEquals(officeRequested("ABC1234", "mayfield", [{ ...req, expires_at: "2026-11-21T00:59:00Z" }], now), false);
  // Not open, photo-only, a hold, another plate, another property: refused.
  for (const bad of [{ status: "removed" }, { status: "fulfilled" }, { kind: "photo" }, { kind: "hold" }, { normalized_plate: "XYZ789" }, { property_id: "1825" }]) {
    assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", requests: [{ ...req, ...bad }] })?.code, "enforcement_paused", JSON.stringify(bad));
  }
  assertEquals(officeRequested("", "mayfield", [req], now), false);
});

Deno.test("lock during a pause: an open camera flag (tow email or boot text) sent before the pause stands; one sent after, closed or too old does not", () => {
  // Pause starts Fri Nov 20, 6:00 PM ET (23:00 UTC).
  const flag = { property_id: "mayfield", plate_text: "ABC 1234", dispatched_at: "2026-11-20T20:00:00Z", status: "dispatched", action_taken: null, action_channel: "email", left_before_tow_at: null, tow_confirmed_at: null };
  const base = { propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS };
  assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", flags: [flag] }), null);
  assertEquals(lockPauseRefusal({ ...base, propertyId: null, plate: "ABC1234", flags: [flag] }), null);
  assertEquals(flaggedBeforePause("ABC1234", "mayfield", pause("mayfield"), [{ ...flag, action_channel: "boot_sms" }]), true);
  // Exactly 7 days before the start still stands; a minute more does not.
  assertEquals(flaggedBeforePause("ABC1234", "mayfield", pause("mayfield"), [{ ...flag, dispatched_at: "2026-11-13T23:00:00Z" }]), true);
  assertEquals(flaggedBeforePause("ABC1234", "mayfield", pause("mayfield"), [{ ...flag, dispatched_at: "2026-11-13T22:59:00Z" }]), false);
  for (const bad of [
    { dispatched_at: "2026-11-20T23:00:00Z" }, { dispatched_at: "2026-11-21T00:00:00Z" }, { dispatched_at: null },
    { status: "dismissed", action_taken: "no_tow" }, { status: "resolved" }, { action_taken: "tow" },
    { left_before_tow_at: "2026-11-20T21:00:00Z" }, { tow_confirmed_at: "2026-11-20T21:00:00Z" }, { visit_ended: true },
    { plate_text: "XYZ789" }, { property_id: "1825" },
  ]) {
    assertEquals(lockPauseRefusal({ ...base, plate: "ABC1234", flags: [{ ...flag, ...bad }] })?.code, "enforcement_paused", JSON.stringify(bad));
  }
});

Deno.test("lock with no pause: requests and flags change nothing", () => {
  const req = { property_id: "mayfield", kind: "photo", status: "active", normalized_plate: "ABC1234" };
  const flag = { property_id: "mayfield", plate_text: "ABC1234", dispatched_at: "2026-11-21T00:00:00Z", status: "dismissed" };
  assertEquals(lockPauseRefusal({ propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: new Map(), points: POINTS, plate: "ABC1234", requests: [req], flags: [flag] }), null);
});

Deno.test("lock during a pause: a live hold or parking pass keeps the car at DO NOT TOW, whatever request or flag is open (backend _TOW_OVERRIDES_PAUSE)", () => {
  const now = new Date("2026-11-21T01:00:00Z");
  const tow = { property_id: "mayfield", kind: "tow", status: "active", normalized_plate: "ABC1234", normalized_back_plate: null, created_at: "2026-11-20T21:00:00Z", expires_at: null };
  const hold = { ...tow, kind: "hold" };
  const flag = { property_id: "mayfield", plate_text: "ABC1234", dispatched_at: "2026-11-18T20:00:00Z", status: "dispatched", action_taken: null, action_channel: "email", left_before_tow_at: null, tow_confirmed_at: null };
  const longTerm: ParkingPass = { property_id: "mayfield", table: "resident_plates", plate_text: "abc-1234", normalized_back_plate: null, status: "approved", active: true, created_at: "2026-01-01T00:00:00Z" };
  const shortTerm: ParkingPass = { property_id: "mayfield", table: "visitor_passes", plate_text: "ABC 1234", normalized_back_plate: null, status: "active", valid_until: "2026-11-21T05:00:00Z" };
  const base = { propertyId: "mayfield", myProperties: MINE, lat: null, lon: null, active: active("mayfield"), points: POINTS, plate: "ABC1234", now };
  const said = "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then. This car has a hold or a parking pass on file, so it cannot be booted during the pause. Nothing was recorded. Take the boot off the wheel.";

  // (1) An open tow request and a live hold on the same plate: the plate check says DO NOT TOW, so refused.
  assertEquals(lockPauseRefusal({ ...base, requests: [tow, hold] }), { code: "enforcement_paused", message: said });
  // (2) A tow email sent two days before the pause, then a parking pass registered: refused.
  assertEquals(lockPauseRefusal({ ...base, flags: [flag], passes: [shortTerm] }), { code: "enforcement_paused", message: said });
  assertEquals(lockPauseRefusal({ ...base, flags: [flag], passes: [longTerm] })?.code, "enforcement_paused");
  assertEquals(lockPauseRefusal({ ...base, requests: [tow], passes: [longTerm] })?.code, "enforcement_paused");
  // By GPS and with neither property nor GPS, too.
  assertEquals(lockPauseRefusal({ ...base, propertyId: null, lat: 35.2831, lon: -80.8105, requests: [tow, hold] })?.message, said);
  assertEquals(lockPauseRefusal({ ...base, propertyId: null, flags: [flag], passes: [shortTerm] })?.code, "enforcement_paused");

  // What does not protect: a hold that is over or expired, a pass that ended, a pending request past its window
  // or withdrawn, a rejected one, or one on another plate or at another property. The request or flag stands.
  for (const req of [{ ...hold, status: "removed" }, { ...hold, expires_at: "2026-11-21T00:59:00Z" }, { ...hold, normalized_plate: "XYZ789" }, { ...hold, property_id: "1825" }]) {
    assertEquals(lockPauseRefusal({ ...base, requests: [tow, req] }), null, JSON.stringify(req));
  }
  for (const pass of [
    { ...shortTerm, valid_until: "2026-11-21T00:59:00Z" }, { ...shortTerm, status: "expired" }, { ...shortTerm, status: "cancelled" },
    { ...longTerm, status: "pending", created_at: "2026-11-17T00:59:00Z" }, { ...longTerm, status: "pending", active: false, created_at: "2026-11-20T12:00:00Z" },
    { ...longTerm, status: "rejected" }, { ...longTerm, plate_text: "XYZ789" }, { ...longTerm, property_id: "1825" },
  ] as ParkingPass[]) {
    assertEquals(lockPauseRefusal({ ...base, flags: [flag], passes: [pass] }), null, JSON.stringify(pass));
  }
  // A pending request inside its 72 hours protects; matched on the back plate too.
  assertEquals(protectedAt("ABC1234", "mayfield", [], [{ ...longTerm, status: "pending", created_at: "2026-11-18T01:01:00Z" }], now), true);
  assertEquals(protectedAt("ABC1234", "mayfield", [], [{ ...shortTerm, plate_text: "ZZZ0000", normalized_back_plate: "ABC1234" }], now), true);
  assertEquals(protectedAt("ABC1234", "mayfield", [{ ...hold, normalized_plate: "ZZZ0000", normalized_back_plate: "ABC1234" }], [], now), true);
  assertEquals(protectedAt("", "mayfield", [hold], [longTerm], now), false);

  // The holds or passes could not be read: no request or flag stands, and the message stays general.
  assertEquals(lockPauseRefusal({ ...base, requests: [tow], flags: [flag], protectionsUnknown: true })?.message,
    "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then. Nothing was recorded. Take the boot off the wheel.");
  // A hold alone (no request, no flag): the general message.
  assertEquals(lockPauseRefusal({ ...base, requests: [hold] })?.message.includes("hold or a parking pass"), false);

  // The older rule is not narrowed: a boot text sent before the pause still stands.
  const texted = [{ property_id: "mayfield", plate_text: "ABC1234", dispatched_at: "2026-11-20T22:55:00Z" }];
  assertEquals(lockPauseRefusal({ ...base, standing: texted, requests: [hold], passes: [longTerm] }), null);
  // With no pause, a hold or pass changes nothing.
  assertEquals(lockPauseRefusal({ ...base, active: new Map(), requests: [tow, hold], passes: [longTerm] }), null);
});
