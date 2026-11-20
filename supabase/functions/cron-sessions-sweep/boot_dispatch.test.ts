import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { excludePaused, pausesFromRows, type PauseRead } from "../_shared/pause.ts";
import {
  bootDispatch, bootMessage, bootRegistrations, bootStandDowns, findCoveringPass, GRACE_DISPATCH_MINUTES_DEFAULT, normalizePhone, parsePhoneList, pastDispatchWindow, shortId,
  SIGN_WINDOW_MINUTES, standDownMessage,
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

Deno.test("dispatch window is 4 minutes (Gabe, 2026-11-20); the boot itself still waits for the posted 15", async () => {
  assertEquals(GRACE_DISPATCH_MINUTES_DEFAULT, 4);
  assertEquals(SIGN_WINDOW_MINUTES, 15);
  const now = new Date("2026-11-11T20:23:00Z");
  assertEquals(pastDispatchWindow("2026-11-11T20:19:00Z", now, GRACE_DISPATCH_MINUTES_DEFAULT), true);   // 4:00 here
  assertEquals(pastDispatchWindow("2026-11-11T20:19:01Z", now, GRACE_DISPATCH_MINUTES_DEFAULT), false);  // 3:59 here
  // With no override, a car 4.5 minutes in is dispatched (the sweep runs every minute) and a car 3 minutes in is not.
  const sessions = [
    { id: "s4", property_id: "p1", normalized_plate: "FOUR444", plate_text: "FOUR444", entered_at: "2026-11-11T20:18:30Z", entry_plate_event_id: "e4", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT },
    { id: "s3", property_id: "p1", normalized_plate: "THREE33", plate_text: "THREE33", entered_at: "2026-11-11T20:20:00Z", entry_plate_event_id: "e5", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT },
  ];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }] };
  const sent: string[] = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now,
    send: async (_to, body) => { sent.push(body); return { ok: true, status: 201 }; } });
  assertEquals(out, { dispatched: 1, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals([sessions[0].state, sessions[1].state], ["expired", "grace"]);
  // The text tells the driver the posted-window end: entered 20:18:30Z + 15 min = 20:33:30Z = 3:33 PM ET.
  assertMatch(sent[0], /Do not boot before 3:33 PM\./);
});

const NOW = new Date("2026-11-11T20:23:00Z");
const APT = { property_type: "apartment", name: "Mayfield Memorial Apartments", address: "4912 Daybreak Dr" };

Deno.test("bootDispatch: a grace session past the dispatch window at an apartment is claimed, recorded as a boot dispatch, and texted with the photo", async () => {
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

Deno.test("boot text after a pause: a car from another day shows the day, and says it waited for the pause to end", () => {
  // In Fri Nov 13, 7:00 PM ET; texted Mon Nov 16, 7:01 AM ET when the pause ended at 7:00 AM.
  const b = bootMessage({ propertyName: "Mayfield", address: null, plate: "ABC1234", enteredAt: "2026-11-14T00:00:00Z",
    minutesHere: 3601, violationId: "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b", pauseEndedAt: "2026-11-16T12:00:00Z" });
  assertMatch(b, /In since Fri 7:00 PM \(3601m\)\. No parking pass\.\nHeld by an enforcement pause that ended at 7:00 AM\. It may have left unseen\.\n/);
  assertMatch(b, /Do not boot before Fri 7:15 PM\./);
  // Same-day texts are unchanged.
  const today = bootMessage({ propertyName: "Mayfield", address: null, plate: "ABC1234", enteredAt: "2026-11-11T20:12:00Z", minutesHere: 11, violationId: "x" });
  assertMatch(today, /In since 3:12 PM \(11m\)\. No parking pass\.\nDo not boot before 3:27 PM\./);
});

Deno.test("bootDispatch after a pause: the text says the pause held it; a car that came after the pause does not", async () => {
  const s = (id: string, entered_at: string) => ({ id, property_id: "p1", normalized_plate: id.toUpperCase(), plate_text: id.toUpperCase(), entered_at, entry_plate_event_id: "e", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT });
  const sessions = [s("held1", "2026-11-11T19:00:00Z"), s("new1", "2026-11-11T21:01:00Z")];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }] };
  const sent: string[] = [];
  const at = new Date("2026-11-11T21:12:00Z");
  await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: at, pauses: pausedAt(at, [PAUSE_P1]),
    send: async (_to, body) => { sent.push(body); return { ok: true, status: 201 }; } });
  assertEquals(sent.length, 2);
  // Newest first since 2026-11-20, so find each text by plate.
  assertMatch(sent.find(t => /Plate HELD1/.test(t))!, /Plate HELD1\n.*\nHeld by an enforcement pause that ended at 4:00 PM\./);
  assertEquals(/pause/.test(sent.find(t => /Plate NEW1/.test(t))!), false);
});

// ── a boot dispatch texted before the pause (Gabe, 2026-11-17) ─────────────
// It goes ahead during the pause: never held, never texted again, and its
// stand-downs (the car registered or left, or no reply) still go out.

Deno.test("boot texted before the pause: never texted again during or after it; its stand-downs still run during it", async () => {
  // Texted 5:50 PM ET-equivalent, before the pause started at 18:00 UTC; p1 is paused 18:00 -> 21:00.
  const dispatchedAt = "2026-11-11T17:50:00Z";
  const sessions = [
    { id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T17:30:00Z", entry_plate_event_id: "e1", state: "expired", exited_at: null, exit_hinted_at: null, violation_id: "v1", properties: APT },
    { id: "s2", property_id: "p1", normalized_plate: "XYZ789", plate_text: "XYZ789", entered_at: "2026-11-11T17:31:00Z", entry_plate_event_id: "e2", state: "expired", exited_at: "2026-11-11T19:10:00Z", exit_hinted_at: null, violation_id: "v2", properties: APT },
  ];
  const bootV = (id: string, s: typeof sessions[number]) => ({ id, session_id: s.id, property_id: "p1", plate_text: s.plate_text, status: "dispatched", action_channel: "boot_sms", left_before_tow_email_sent_at: null, left_before_tow_at: null, dispatched_at: dispatchedAt, plate_sessions: s, properties: { name: "Mayfield", address: null } });
  const violations = [bootV("v1", sessions[0]), bootV("v2", sessions[1])];
  const passes = [{ id: "pass1", property_id: "p1", plate_text: "ABC1234", valid_from: "2026-11-11T19:00:00Z", valid_until: "2026-11-12T19:00:00Z", cancelled_at: null, status: "active" }];
  const tables = { plate_sessions: sessions, alpr_violations: violations as Row[], plate_events: [] as Row[], visitor_passes: passes, resident_plates: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }] };
  const sent: string[] = [];
  const send = async (_to: string, body: string) => { sent.push(body); return { ok: true, status: 201 }; };
  const during = new Date("2026-11-11T19:30:00Z");
  const deps = (at: Date) => ({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now: at, pauses: pausedAt(at, [PAUSE_P1]), send });
  // During the pause: nothing re-dispatched; the car that registered and the car that left are stood down.
  assertEquals(await bootDispatch(deps(during)), { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(await bootRegistrations(deps(during)), 1);
  assertEquals(await bootStandDowns(deps(during)), { stood_down: 1, stale: 0 });
  assertEquals(sent.length, 2);
  assertMatch(sent[0], /\[STAND DOWN\] Mayfield\nPlate ABC1234 registered a parking pass/);
  assertMatch(sent[1], /\[STAND DOWN\] Mayfield\nPlate XYZ789 was seen leaving/);
  // After the pause: still never texted again.
  const after = new Date("2026-11-11T21:01:00Z");
  assertEquals(await bootDispatch(deps(after)), { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sent.length, 2);
  assertEquals(violations.length, 2);
});

// ── Violation alert to Gabe + Victor (2026-11-20) ─────────────────────────
Deno.test("alert: no drivers and no exit camera, the visit is still flagged and Gabe + Victor get a text and an email", async () => {
  const now = new Date("2026-11-11T20:23:00Z");
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:17:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [{ id: "e1", image_url: "https://r2/x.jpg" }], alpr_cameras: [{ property_id: "p1", active: true, orientation: "entry", exit_order: null }] };
  const texts: Array<{ to: string; body: string; media: string[] }> = [];
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: [], twilio: null, now,
    alertPhones: ["+17045550111", "+17045550122"], alertEmails: ["gabe@example.com", "victor@example.com"],
    send: async (to, body, media) => { texts.push({ to, body, media }); return { ok: true, status: 201 }; },
    sendEmail: async (to, subject, text) => { mails.push({ to, subject, text }); return { ok: true, status: 200 }; } });
  assertEquals(out, { dispatched: 1, failed: 0, skipped_no_exit_camera: 1 });
  assertEquals(sessions[0].state, "expired");
  assertEquals(tables.alpr_violations.length, 1);
  assertEquals([tables.alpr_violations[0].status, tables.alpr_violations[0].action_channel], ["dispatched", "boot_sms"]);
  assertEquals(texts.map(t => t.to), ["+17045550111", "+17045550122"]);
  assertMatch(texts[0].body, /^\[VIOLATION\] Mayfield Memorial Apartments\nPlate ABC1234/);
  assertMatch(texts[0].body, /No exit camera here: it may have left unseen\. Drivers not texted\./);
  assertEquals(/Boot allowed/.test(texts[0].body), false);
  assertEquals(/Reply DONE/.test(texts[0].body), false);
  assertEquals(texts[0].media, ["https://r2/x.jpg"]);
  assertEquals(mails.map(m => m.to), ["gabe@example.com", "victor@example.com"]);
  assertMatch(mails[0].subject, /^Violation: ABC1234 at Mayfield Memorial Apartments/);
  assertMatch(mails[0].text, /Photo: https:\/\/r2\/x\.jpg/);
});

Deno.test("alert: with an exit camera the drivers get the boot text and Gabe + Victor get the alert", async () => {
  const now = new Date("2026-11-11T20:23:00Z");
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:17:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }] };
  const texts: Array<{ to: string; body: string }> = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now, alertPhones: ["+17045550111"], alertEmails: [],
    send: async (to, body) => { texts.push({ to, body }); return { ok: true, status: 201 }; } });
  assertEquals(out, { dispatched: 1, failed: 0, skipped_no_exit_camera: 0 });
  assertMatch(texts.find(t => t.to === "+19712957521")!.body, /^\[BOOT\]/);
  const alert = texts.find(t => t.to === "+17045550111")!.body;
  assertMatch(alert, /^\[VIOLATION\]/);
  assertMatch(alert, /Drivers texted: 1\./);
});

Deno.test("alert: nothing configured anywhere means the feature stays off", async () => {
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:00:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const out = await bootDispatch({ db: fakeDb({ plate_sessions: sessions, alpr_violations: [], plate_events: [], alpr_cameras: [] }), phones: [], twilio: null, now: NOW, alertPhones: [], alertEmails: [] });
  assertEquals(out, { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 });
  assertEquals(sessions[0].state, "grace");
});

Deno.test("alert: a flagged car seen leaving is dismissed and Gabe + Victor get the cancellation", async () => {
  const violations: Row[] = [{ id: "v1", session_id: "s1", property_id: "p1", plate_text: "ABC1234", status: "dispatched", action_channel: "boot_sms", left_before_tow_at: null, left_before_tow_email_sent_at: null, dispatched_at: "2026-11-11T20:21:00Z",
    plate_sessions: { id: "s1", normalized_plate: "ABC1234", exited_at: "2026-11-11T20:22:00Z", state: "expired" }, properties: { name: "Mayfield Memorial Apartments", address: null } }];
  const texts: Array<{ to: string; body: string }> = [];
  const mails: Array<{ to: string; subject: string }> = [];
  const n = await bootStandDowns({ db: fakeDb({ alpr_violations: violations }), phones: [], twilio: null, now: NOW,
    alertPhones: ["+17045550111"], alertEmails: ["gabe@example.com"],
    send: async (to, body) => { texts.push({ to, body }); return { ok: true, status: 201 }; },
    sendEmail: async (to, subject) => { mails.push({ to, subject }); return { ok: true, status: 200 }; } });
  assertEquals(n, { stood_down: 1, stale: 0 });
  assertEquals(violations[0].status, "dismissed");
  assertEquals(typeof violations[0].left_before_tow_email_sent_at, "string");
  assertEquals(texts.length, 1);
  assertMatch(texts[0].body, /^\[CANCELLED\] Mayfield Memorial Apartments\nPlate ABC1234 was seen leaving at/);
  assertEquals(mails.map(m => m.subject), ["Cancelled: ABC1234 at Mayfield Memorial Apartments (left)"]);
});

Deno.test("alert: an alert-only visit that sat in grace for hours is not alerted (no backlog burst)", async () => {
  const now = new Date("2026-11-11T20:23:00Z");
  const sessions = [
    { id: "old", property_id: "p1", normalized_plate: "OLD1111", plate_text: "OLD1111", entered_at: "2026-11-11T15:00:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT },
    { id: "new", property_id: "p1", normalized_plate: "NEW2222", plate_text: "NEW2222", entered_at: "2026-11-11T20:17:00Z", entry_plate_event_id: "e2", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT },
  ];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [] as Row[] };
  const texts: string[] = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: [], twilio: null, now, alertPhones: ["+17045550111"], alertEmails: [],
    send: async (_to, body) => { texts.push(body); return { ok: true, status: 201 }; } });
  assertEquals(out.dispatched, 1);
  assertEquals([sessions[0].state, sessions[1].state], ["grace", "expired"]);
  assertEquals(texts.length, 1);
  assertMatch(texts[0], /Plate NEW2222/);
  assertEquals(tables.alpr_violations[0].sms_sent_at, null);   // alert-only: not a driver text
});

Deno.test("alert: drivers configured but every driver text fails, the alert says so and the row is not marked as a driver text", async () => {
  const now = new Date("2026-11-11T20:23:00Z");
  const sessions = [{ id: "s1", property_id: "p1", normalized_plate: "ABC1234", plate_text: "ABC1234", entered_at: "2026-11-11T20:17:00Z", entry_plate_event_id: "e1", state: "grace", exited_at: null, exit_hinted_at: null, violation_id: null, properties: APT }];
  const tables = { plate_sessions: sessions, alpr_violations: [] as Row[], plate_events: [] as Row[], alpr_cameras: [{ property_id: "p1", active: true, orientation: "exit", exit_order: 2 }] };
  const texts: Array<{ to: string; body: string }> = [];
  const out = await bootDispatch({ db: fakeDb(tables), phones: ["+19712957521"], twilio: null, now, alertPhones: ["+17045550111"], alertEmails: [],
    send: async (to, body) => { texts.push({ to, body }); return to === "+19712957521" ? { ok: false, status: 401, error: "auth" } : { ok: true, status: 201 }; } });
  assertEquals(out, { dispatched: 1, failed: 0, skipped_no_exit_camera: 0 });
  const v = tables.alpr_violations[0];
  assertEquals(v.status, "dispatched");
  assertEquals(v.sms_sent_at, null);
  assertMatch(String(v.last_dispatch_error), /^drivers: 401 auth/);
  assertMatch(texts.find(t => t.to === "+17045550111")!.body, /Driver text FAILED: 401 auth\. No driver is coming\./);
});
