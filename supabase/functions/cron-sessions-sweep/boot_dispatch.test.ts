import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { excludePaused, pausesFromRows, type PauseRead } from "../_shared/pause.ts";
import {
  bootDispatch, bootMessage, bootRegistrations, bootStandDowns, findCoveringPass, normalizePhone, parsePhoneList, pastDispatchWindow, shortId, standDownMessage,
} from "./boot_dispatch.ts";

Deno.test("phones: normalised to E.164, de-duplicated, junk dropped", () => {
  assertEquals(normalizePhone("(971) 295-7521"), "+19712957521");
  assertEquals(normalizePhone("19712957521"), "+19712957521");
  assertEquals(normalizePhone("+19712957521"), "+19712957521");
  assertEquals(normalizePhone("12345"), null);
  assertEquals(parsePhoneList(" +19712957521, 971-295-7521 ,704-555-0100,,x"), ["+19712957521", "+17045550100"]);
  assertEquals(parsePhoneList(undefined), []);
});

Deno.test("shortId is the 12-hex reply id the backend webhook matches", () => {
  assertEquals(shortId("3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b"), "3F2A9C1E8B7D");
});

Deno.test("messages: boot text carries property, plate, time, address and both reply codes; stand-down names the reason", () => {
  const b = bootMessage({ propertyName: "Mayfield Memorial Apartments", address: "4912 Daybreak Dr", plate: "ABC1234",
    enteredAt: "2026-11-11T20:12:00Z", minutesHere: 11, violationId: "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b" });
  assertMatch(b, /^\[BOOT\] Mayfield Memorial Apartments\n/);
  assertMatch(b, /Plate ABC1234\n/);
  assertMatch(b, /In since 3:12 PM \(11m\)\. No parking pass\./);
  assertMatch(b, /4912 Daybreak Dr/);
  assertMatch(b, /Do not boot before 3:27 PM\. Check it is still there and still unregistered\./);
  assertMatch(b, /Reply DONE-3F2A9C1E8B7D when booted, GONE-3F2A9C1E8B7D if it left\./);
  const s = standDownMessage({ propertyName: "Mayfield", address: null, plate: "ABC1234", violationId: "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b", reason: "left", at: "2026-11-11T20:30:00Z" });
  assertMatch(s, /^\[STAND DOWN\] Mayfield\nPlate ABC1234 was seen leaving at 3:30 PM\. Do not boot\.\nRef 3F2A9C1E8B7D$/);
  const r = standDownMessage({ propertyName: "Mayfield", address: null, plate: "ABC1234", violationId: "x", reason: "registered", at: "2026-11-11T20:24:00Z" });
  assertMatch(r, /registered a parking pass at 3:24 PM/);
});

Deno.test("pastDispatchWindow", () => {
  const now = new Date("2026-11-11T20:22:00Z");
  assertEquals(pastDispatchWindow("2026-11-11T20:12:00Z", now, 10), true);
  assertEquals(pastDispatchWindow("2026-11-11T20:12:01Z", now, 10), false);
  assertEquals(pastDispatchWindow("bad", now, 10), false);
});

import { fakeDb, type Row } from "./fake_db.ts";

const NOW = new Date("2026-11-11T20:23:00Z");
const APT = { property_type: "apartment", name: "Mayfield Memorial Apartments", address: "4912 Daybreak Dr" };

Deno.test("bootDispatch: a grace session past 10 min at an apartment is claimed, recorded as a boot dispatch, and texted with the photo", async () => {
  const sessions = [
    { id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:12:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT },
    { id: "s2", property_id: "p1", normalized_plate: "NEW111", plate_text: "NEW111", entered_at: "2026-11-11T20:20:00Z", entry_plate_event_id: "e2", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT },
    { id: "s3", property_id: "pz", normalized_plate: "TRK999", plate_text: "TRK999", entered_at: "2026-11-11T19:00:00Z", entry_plate_event_id: "e3", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: { property_type: "truck_plaza", name: "Plaza", address: null } },
  ];
  const cams = [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }, { property_id: "pz", active: true, orientation: "entry", exit_order: null }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [{ id: "e1", image_url: "https://r2/x.jpg" }], alpr_cameras: cams };
  const sent: Array<{ to: string; body: string; media: string[] }> = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521", "+17045550100"], twilio: null, now: NOW,
    send: async (to, body, media) => { sent.push({ to, body, media }); return { ok: true, status: 201 }; } });
  assertEquals(out, { dispatched: 1, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sessions[0].state, "expired");
  assertEquals(sessions[1].state, "grace");
  assertEquals(sessions[2].state, "grace");
  assertEquals(tables.alpr_violations.length, 1);
  const v = tables.alpr_violations[0];
  assertEquals([v.status, v.violation_type, v.action_channel, v.session_id], ["dispatched", "unregistered", "boot_sms", "s1"]);
  assertEquals(typeof v.dispatched_at, "string");
  assertEquals(sessions[0].violation_id, v.id);
  assertEquals(sent.length, 2);
  assertEquals(sent[0].media, ["https://r2/x.jpg"]);
  assertMatch(sent[0].body, /\[BOOT\] Mayfield Memorial Apartments\nPlate ABC1234/);
});

Deno.test("bootDispatch: no phones configured means nothing happens; a failed text marks dispatch_failed, never the partner path", async () => {
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:00:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const off = await bootDispatch({ db: fakeDb({ plate_sessions: sessions, alpr_violations: [], plate_events: [], alpr_cameras: [] }), phones: [], twilio: null, now: NOW });
  assertEquals(off, { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sessions[0].state, "grace");
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: null }] };
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: NOW, send: async () => ({ ok: false, status: 401, error: "auth" }) });
  assertEquals(out, { dispatched: 0, failed: 1, skipped_no_exit_camera: 0 });
  assertEquals(tables.alpr_violations[0].status, "dispatch_failed");
  assertEquals(typeof tables.alpr_violations[0].dispatched_at, "string"); // still never NULL: dispatchPendingViolations skips it
});

Deno.test("bootRegistrations: a dispatched car that now holds a pass goes back to registered and the drivers are stood down", async () => {
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", exited_at: null, state: "expired" }];
  const violations = [{ id: "v1", session_id: "s1", property_id: "p1", plate_text: "ABC1234", status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: null, plate_sessions: sessions[0], properties: { name: "Mayfield", address: null } }];
  const passes = [{ id: "pass1", property_id: "p1", plate_text: "abc-1234", valid_from: "2026-11-11T20:00:00Z", valid_until: "2026-11-12T20:00:00Z", cancelled_at: null, status: "active" }];
  const sent: string[] = [];
  const n = await bootRegistrations({ db: fakeDb({ plate_sessions: sessions, alpr_violations: violations, visitor_passes: passes, resident_plates: [] }), phones: ["+19712957521"], twilio: null, now: NOW,
    send: async (_to, body) => { sent.push(body); return { ok: true, status: 201 }; } });
  assertEquals(n, 1);
  assertEquals(sessions[0].state, "registered");
  assertEquals((sessions[0] as Row).visitor_pass_id, "pass1");
  assertEquals([violations[0].status, (violations[0] as Row).action_taken], ["dismissed", "no_tow"]);
  assertEquals(typeof violations[0].left_before_tow_email_sent_at, "string");
  assertMatch(sent[0], /\[STAND DOWN\] Mayfield\nPlate ABC1234 registered a parking pass/);
});

Deno.test("bootStandDowns: a dispatched car seen leaving (either exit path) gets one stand-down and is dismissed", async () => {
  const left = { id: "s1", normalized_plate: "ABC1234", exited_at: null, state: "closed_post_violation" };
  const repass = { id: "s2", normalized_plate: "XYZ789", exited_at: "2026-11-11T20:21:00Z", state: "expired" };
  const still = { id: "s3", normalized_plate: "QQQ111", exited_at: null, state: "expired" };
  const violations = [
    { id: "v1", session_id: "s1", property_id: "p1", plate_text: "ABC1234", status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: "2026-11-11T20:20:00Z", dispatched_at: "2026-11-11T20:10:00Z", plate_sessions: left, properties: { name: "Mayfield", address: null } },
    { id: "v2", session_id: "s2", property_id: "p1", plate_text: "XYZ789", status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: null, plate_sessions: repass, properties: { name: "Mayfield", address: null } },
    { id: "v3", session_id: "s3", property_id: "p1", plate_text: "QQQ111", status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: null, plate_sessions: still, properties: { name: "Mayfield", address: null } },
  ];
  const sent: string[] = [];
  const n = await bootStandDowns({ db: fakeDb({ alpr_violations: violations }), phones: ["+19712957521"], twilio: null, now: NOW,
    send: async (_to, body) => { sent.push(body); return { ok: true, status: 201 }; } });
  assertEquals(n, { stood_down: 2, stale: 0 });
  assertEquals(violations.map(v => v.status), ["dismissed", "dismissed", "dispatched"]);
  assertEquals(sent.length, 2);
  assertMatch(sent[0], /ABC1234 was seen leaving at 3:20 PM/);
  assertMatch(sent[1], /XYZ789 was seen leaving at 3:21 PM/);
});

Deno.test("bootDispatch: a property with no exit-facing camera never dispatches (the car could leave unseen)", async () => {
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:00:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const out = await bootDispatch({ db: fakeDb({ plate_sessions: sessions, alpr_violations: [], plate_events: [], alpr_cameras: [{ property_id: "p1", active: true, orientation: "entry", exit_order: null }] }), phones: ["+19712957521"], twilio: null, now: NOW, send: async () => ({ ok: true, status: 201 }) });
  assertEquals(out, { dispatched: 0, failed: 0, skipped_no_exit_camera: 1 });
  assertEquals(sessions[0].state, "grace");
});

Deno.test("bootStandDowns: a dispatch with no reply goes stale after the window and is dismissed without a text", async () => {
  const violations = [{ id: "v1", session_id: "s1", property_id: "p1", plate_text: "ABC1234", status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: null, dispatched_at: "2026-11-11T13:00:00Z", plate_sessions: { id: "s1", normalized_plate: "ABC1234", exited_at: null, state: "expired" }, properties: { name: "Mayfield", address: null } }];
  const sent: string[] = [];
  const n = await bootStandDowns({ db: fakeDb({ alpr_violations: violations }), phones: ["+19712957521"], twilio: null, now: NOW, staleHours: 6,
    send: async (_to, body) => { sent.push(body); return { ok: true, status: 201 }; } });
  assertEquals(n, { stood_down: 0, stale: 1 });
  assertEquals(violations[0].status, "dismissed");
  assertEquals(sent.length, 0);
});

Deno.test("bootRegistrations: a resident plate one confusable character off still cancels the dispatch", async () => {
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1Z3", exited_at: null, state: "expired" }];
  const violations = [{ id: "v1", session_id: "s1", property_id: "p1", plate_text: "ABC1Z3", status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: null, dispatched_at: "2026-11-11T20:13:00Z", plate_sessions: sessions[0], properties: { name: "Mayfield", address: null } }];
  const n = await bootRegistrations({ db: fakeDb({ plate_sessions: sessions, alpr_violations: violations, visitor_passes: [], resident_plates: [{ id: "r1", property_id: "p1", plate_text: "ABC-123", back_plate: null, status: "approved", active: true }] }), phones: ["+19712957521"], twilio: null, now: NOW, send: async () => ({ ok: true, status: 201 }) });
  assertEquals(n, 1);
  assertEquals(sessions[0].state, "resident");
  assertEquals((sessions[0] as Row).resident_plate_id, "r1");
});

// ── enforcement pause ────────────────────────────────────────────────────
const pausedAt = (now: Date, rows: Array<{ property_id: string; starts_at: string; ends_at: string }>): PauseRead =>
  ({ ok: true, missing: false, ...pausesFromRows(rows.map((r, i) => ({ id: `pz${i}`, ended_early_at: null, cancelled_at: null, reason: null, ...r })), now, 24) });
const PAUSE_P1 = { property_id: "p1", starts_at: "2026-11-11T18:00:00Z", ends_at: "2026-11-11T21:00:00Z" };

Deno.test("bootDispatch during a pause: the paused property is left out in SQL (before the limit), others still dispatch", async () => {
  const grace = (id: string, property_id: string) => ({ id, property_id, normalized_plate: id.toUpperCase(), plate_text: id.toUpperCase(), entered_at: "2026-11-11T20:00:00Z", entry_plate_event_id: "e", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT });
  // Twelve waiting cars at the paused property would fill BOOT_MAX_PER_TICK (10) if filtered after the select.
  const sessions = [...Array.from({ length: 12 }, (_, i) => grace(`held${i}`, "p1")), grace("due1", "p2")];
  const cams = [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }, { property_id: "p2", active: true, orientation: "exit", exit_order: 2 }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: cams };
  const sent: string[] = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: NOW, pauses: pausedAt(NOW, [PAUSE_P1]),
    send: async (_to, body) => { sent.push(body); return { ok: true, status: 201 }; } });
  assertEquals(out, { dispatched: 1, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sessions.filter(s => s.state === "expired").map(s => s.id), ["due1"]);
  assertEquals(sessions.filter(s => s.property_id === "p1").every(s => s.state === "grace" && s.violation_id === null), true);
  assertEquals(tables.alpr_violations.length, 1);
  assertMatch(sent[0], /Plate DUE1/);
});

Deno.test("bootDispatch after a pause: the held car is picked up on the first run after ends_at, once", async () => {
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T19:00:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }] };
  const sent: string[] = [];
  const send = async (_to: string, body: string) => { sent.push(body); return { ok: true, status: 201 }; };
  const during = new Date("2026-11-11T20:59:59Z");
  assertEquals(await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: during, pauses: pausedAt(during, [PAUSE_P1]), send }), { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sessions[0].state, "grace");
  const after = new Date("2026-11-11T21:00:00Z"); // at == ends_at: enforcement is back
  assertEquals(await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: after, pauses: pausedAt(after, [PAUSE_P1]), send }), { dispatched: 1, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: after, pauses: pausedAt(after, [PAUSE_P1]), send }), { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sent.length, 1);
  assertEquals(tables.alpr_violations.length, 1);
});

Deno.test("bootDispatch with an unknown pause state: nothing is claimed or sent this tick", async () => {
  const sessions = [{ id: "s1", property_id: "p2", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:00:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p2", active: true, orientation: "exit", exit_order: 2 }] };
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: NOW, pauses: { ok: false, error: "timeout" }, send: async () => ({ ok: true, status: 201 }) });
  assertEquals(out, { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sessions[0].state, "grace");
  assertEquals(tables.alpr_violations.length, 0);
});

Deno.test("findCoveringPass: a live pass or approved resident plate at the property, by the entry's fuzzy rule", async () => {
  const passes = [
    { id: "old", property_id: "p1", plate_text: "ABC1234", valid_from: "2026-11-10T00:00:00Z", valid_until: "2026-11-11T00:00:00Z", cancelled_at: null, status: "active" },
    { id: "new", property_id: "p1", plate_text: "abc-1234", valid_from: "2026-11-11T00:00:00Z", valid_until: "2026-11-12T00:00:00Z", cancelled_at: null, status: "active" },
  ];
  assertEquals(await findCoveringPass(fakeDb({ visitor_passes: passes, resident_plates: [] }), "p1", "ABC1234", NOW), { kind: "pass", id: "new" });
  assertEquals(await findCoveringPass(fakeDb({ visitor_passes: [passes[0]], resident_plates: [] }), "p1", "ABC1234", NOW), null);
  assertEquals(await findCoveringPass(fakeDb({ visitor_passes: [], resident_plates: [{ id: "r1", property_id: "p1", plate_text: "ABC1234", back_plate: null, status: "approved", active: true }] }), "p1", "ABC1234", NOW), { kind: "resident", id: "r1" });
  assertEquals(await findCoveringPass(fakeDb({ visitor_passes: [], resident_plates: [{ id: "r1", property_id: "p1", plate_text: "ABC1234", back_plate: null, status: "pending", active: true }] }), "p1", "ABC1234", NOW), null);
});

Deno.test("pending-dispatch candidates (index.ts query shape): a paused property's held rows never fill the 50-row window, and come back after the pause", async () => {
  const v = (id: string, property_id: string) => ({ id, property_id, dispatched_at: null, status: "pending", dispatch_attempts: 0, created_at: "2026-11-11T18:00:00Z" });
  const violations = [...Array.from({ length: 60 }, (_, i) => v(`held${i}`, "p1")), v("due", "p2")];
  const candidates = async (at: Date) => {
    const db = fakeDb({ alpr_violations: violations });
    const q = db.from("alpr_violations").select("id, property_id").is("dispatched_at", null).neq("status", "dispatch_failed").neq("status", "dismissed")
      .lt("dispatch_attempts", 3).lt("created_at", "2026-11-11T20:00:00Z");
    const { data } = await excludePaused(q, pausedAt(at, [PAUSE_P1]), "properties.property_type").limit(50);
    return (data as Row[]).map(r => r.id as string);
  };
  assertEquals(await candidates(new Date("2026-11-11T20:30:00Z")), ["due"]);
  const after = await candidates(new Date("2026-11-11T21:00:00Z"));
  assertEquals(after.length, 50);
  assertEquals(after[0], "held0");
  assertEquals(violations.every(r => r.dispatch_attempts === 0 && r.status === "pending"), true); // nothing burned while held
});
