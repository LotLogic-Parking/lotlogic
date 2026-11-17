import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pausesFromRows, readPauses, type PauseRead } from "../_shared/pause.ts";
import { fakeDb, type Row } from "./fake_db.ts";
import {
  closeCoveredViolation, coverCloseHealth, heldOverstayCover, overstayCandidates, pendingDecision, pendingDispatchCandidates, repointSession,
  type OverstaySession, type PendingViolation,
} from "./pause_hold.ts";

// p1 is paused Wed 18:00 → 21:00 UTC; p2 never is.
const PAUSE = { id: "pz1", property_id: "p1", starts_at: "2026-11-11T18:00:00Z", ends_at: "2026-11-11T21:00:00Z", ended_early_at: null, cancelled_at: null, reason: null };
const DURING = new Date("2026-11-11T20:30:00Z");
const AFTER = new Date("2026-11-11T21:01:00Z");
const readAt = (at: Date): PauseRead => ({ ok: true, missing: false, ...pausesFromRows([PAUSE], at, 24) });
const MAX_ATTEMPTS = 3;
const pendingAt = (db: ReturnType<typeof fakeDb>, now: Date) =>
  pendingDispatchCandidates(db, { now, cutoffIso: new Date(now.getTime() - 5 * 60_000).toISOString(), maxAttempts: MAX_ATTEMPTS, limit: 50, recentHours: 24 });

// ── overstay path ──────────────────────────────────────────────────────────
const regSession = (id: string, property_id: string, plate: string, pass: string): Row => ({
  id, property_id, plate_text: plate, normalized_plate: plate, entry_plate_event_id: `e-${id}`, visitor_pass_id: pass,
  exit_hinted_at: null, state: "registered", exited_at: null,
});

Deno.test("overstay: held at a paused property during the pause, selected on the first tick after, then never again", async () => {
  const sessions = [regSession("s1", "p1", "ABC1234", "old1"), regSession("s2", "p2", "XYZ789", "old2")];
  const ids = async (at: Date) => (await overstayCandidates(fakeDb({ plate_sessions: sessions }), readAt(at))).map(s => s.id);
  assertEquals(await ids(DURING), ["s2"]);
  assertEquals(await ids(AFTER), ["s1", "s2"]);
  // The pass ran out during the pause and nothing covers the car: the overstay fires.
  const s1 = sessions[0] as unknown as OverstaySession;
  const db = fakeDb({ plate_sessions: sessions, visitor_passes: [], resident_plates: [] });
  assertEquals(await heldOverstayCover(db, readAt(AFTER), s1, "2026-11-11T19:00:00Z", AFTER), null);
  sessions[0].state = "expired"; // createViolationAndDispatch's claim
  assertEquals(await ids(AFTER), ["s2"]);
});

Deno.test("overstay: a car that renewed during the pause is re-pointed at its new parking pass, not towed", async () => {
  const sessions = [regSession("s1", "p1", "ABC1234", "old1")];
  const passes = [{ id: "new1", property_id: "p1", plate_text: "ABC-1234", back_plate: null, valid_from: "2026-11-11T19:30:00Z", valid_until: "2026-11-12T19:30:00Z", cancelled_at: null, status: "active" }];
  const db = fakeDb({ plate_sessions: sessions, visitor_passes: passes, resident_plates: [] });
  const cover = await heldOverstayCover(db, readAt(AFTER), sessions[0] as unknown as OverstaySession, "2026-11-11T19:00:00Z", AFTER);
  assertEquals(cover, { kind: "pass", id: "new1" });
  assertEquals(await repointSession(db, "s1", "registered", cover!, AFTER), true);
  assertEquals([sessions[0].state, sessions[0].visitor_pass_id], ["registered", "new1"]);
});

Deno.test("overstay outside a pause is unchanged: another car's live pass one character off never suppresses it", async () => {
  // p2 was never paused; a different car holds a pass whose plate is one confusable character away.
  const sessions = [regSession("s2", "p2", "ABC1234", "old2")];
  const passes = [{ id: "other", property_id: "p2", plate_text: "ABC1Z34", back_plate: null, valid_from: "2026-11-11T00:00:00Z", valid_until: "2026-11-12T00:00:00Z", cancelled_at: null, status: "active" }];
  const db = fakeDb({ plate_sessions: sessions, visitor_passes: passes, resident_plates: [] });
  assertEquals(await heldOverstayCover(db, readAt(AFTER), sessions[0] as unknown as OverstaySession, "2026-11-11T20:50:00Z", AFTER), null);
  // At p1, a pass that ran out after the pause ended was not held by it either.
  const p1 = { ...sessions[0], id: "s3", property_id: "p1" } as unknown as OverstaySession;
  assertEquals(await heldOverstayCover(fakeDb({ visitor_passes: [{ ...passes[0], property_id: "p1" }], resident_plates: [] }), readAt(new Date("2026-11-11T21:20:00Z")), p1, "2026-11-11T21:10:00Z", new Date("2026-11-11T21:20:00Z")), null);
});

// ── tow-email path (dispatchPendingViolations) ─────────────────────────────
const violation = (id: string, property_id: string, session_id: string | null, created_at: string): Row => ({
  id, property_id, session_id, violation_type: "overstay", created_at, dispatch_attempts: 0, left_before_tow_at: null,
  dispatched_at: null, status: "pending",
});

Deno.test("tow email: held during the pause (nothing burned), sent once at the end", async () => {
  const violations = [violation("v1", "p1", "s1", "2026-11-11T19:00:00Z"), violation("v2", "p2", null, "2026-11-11T19:00:00Z")];
  const sessions = [{ id: "s1", property_id: "p1", state: "expired", exit_hinted_at: null, exited_at: null, normalized_plate: "ABC1234", plate_text: "ABC1234" }];
  const tables = () => ({ alpr_violations: violations, plate_sessions: sessions, visitor_passes: [] as Row[], resident_plates: [] as Row[], enforcement_pauses: [PAUSE as Row] });
  const during = await pendingAt(fakeDb(tables()), DURING);
  assertEquals(during.rows.map(r => r.id), ["v2"]);
  assertEquals(violations[0].dispatch_attempts, 0);
  const after = await pendingAt(fakeDb(tables()), AFTER);
  assertEquals(after.rows.map(r => r.id), ["v1", "v2"]);
  assertEquals(await pendingDecision(fakeDb(tables()), after.rows[0], after.pauses, AFTER), { kind: "send" });
  violations[0].dispatched_at = AFTER.toISOString(); // tow-dispatch-email's send claim
  assertEquals((await pendingAt(fakeDb(tables()), new Date("2026-11-11T21:02:00Z"))).rows.map(r => r.id), ["v2"]);
});

Deno.test("tow email: a pause that starts after the tick began still holds the send (the candidates read the pause table themselves)", async () => {
  const tickStart = new Date("2026-11-11T17:59:50Z");
  const late = { ...PAUSE, starts_at: "2026-11-11T18:00:00Z" };
  const tables = { alpr_violations: [violation("v1", "p1", null, "2026-11-11T17:40:00Z")], enforcement_pauses: [late as Row] };
  // The tick's own read, at its start, saw no pause.
  const atStart = await readPauses(fakeDb(tables), tickStart, { recentHours: 24 });
  assertEquals(atStart.ok && atStart.active.size, 0);
  // Forty seconds later the dispatch step picks its rows: p1 is paused by then.
  const picked = await pendingAt(fakeDb(tables), new Date("2026-11-11T18:00:40Z"));
  assertEquals(picked.rows, []);
  assertEquals(picked.pauses.ok && picked.pauses.active.has("p1"), true);
});

Deno.test("tow email: a held car that got a parking pass during the pause is closed with no tow and its session goes back to registered", async () => {
  const violations = [violation("v1", "p1", "s1", "2026-11-11T19:00:00Z")];
  const sessions = [{ id: "s1", property_id: "p1", state: "expired", exit_hinted_at: null, exited_at: null, normalized_plate: "ABC1234", plate_text: "ABC1234" }];
  const passes = [{ id: "new1", property_id: "p1", plate_text: "ABC1234", back_plate: null, valid_from: "2026-11-11T20:00:00Z", valid_until: "2026-11-12T20:00:00Z", cancelled_at: null, status: "active" }];
  const db = fakeDb({ alpr_violations: violations, plate_sessions: sessions, visitor_passes: passes, resident_plates: [], enforcement_pauses: [PAUSE as Row] });
  const { rows, pauses } = await pendingAt(db, AFTER);
  const d = await pendingDecision(db, rows[0], pauses, AFTER);
  assertEquals(d, { kind: "covered", cover: { kind: "pass", id: "new1" }, sessionId: "s1" });
  if (d.kind !== "covered") throw new Error("unreachable");
  assertEquals(await closeCoveredViolation(db, rows[0], d, AFTER), "closed");
  assertEquals([violations[0].status, violations[0].action_taken, violations[0].action_channel, violations[0].dispatched_at], ["dismissed", "no_tow", "auto_registered", null]);
  assertEquals([sessions[0].state, (sessions[0] as Row).visitor_pass_id], ["registered", "new1"]);
  assertEquals((await pendingAt(db, AFTER)).rows, []);
});

Deno.test("tow email: a held car whose visit an exit closed is not towed; the same row outside a pause keeps today's rules", async () => {
  const sessions = [{ id: "s1", property_id: "p1", state: "expired", exit_hinted_at: null, exited_at: "2026-11-11T19:30:00Z", normalized_plate: "ABC1234", plate_text: "ABC1234" }];
  const held = violation("v1", "p1", "s1", "2026-11-11T19:00:00Z") as unknown as PendingViolation;
  const db = fakeDb({ plate_sessions: sessions, visitor_passes: [], resident_plates: [] });
  assertEquals(await pendingDecision(db, held, readAt(AFTER), AFTER), { kind: "left", left: { signal: "session_closed", at: "2026-11-11T19:30:00Z" } });
  const stamped = { ...held, id: "v2", session_id: null, left_before_tow_at: "2026-11-11T19:40:00Z" };
  assertEquals(await pendingDecision(db, stamped, readAt(AFTER), AFTER), { kind: "left", left: { signal: "violation_left", at: "2026-11-11T19:40:00Z" } });
  // p2 was never paused: the session-closed and left_before_tow_at signals are not part of its rules.
  const p2 = { ...held, property_id: "p2" };
  assertEquals(await pendingDecision(fakeDb({ plate_sessions: [{ ...sessions[0], property_id: "p2" }], visitor_passes: [], resident_plates: [] }), p2, readAt(AFTER), AFTER), { kind: "send" });
  // An exit hint still stops any row, paused or not.
  const hinted = fakeDb({ plate_sessions: [{ ...sessions[0], exit_hinted_at: "2026-11-11T20:58:00Z", exited_at: null }], visitor_passes: [] });
  assertEquals(await pendingDecision(hinted, p2, readAt(AFTER), AFTER), { kind: "left", left: { signal: "session_exit", at: "2026-11-11T20:58:00Z" } });
});

Deno.test("tow email: a held car with a parking pass whose dismiss fails is left as it was (no re-point), retried next tick, never sent", async () => {
  const violations = [violation("v1", "p1", "s1", "2026-11-11T19:00:00Z")];
  const sessions = [{ id: "s1", property_id: "p1", state: "expired", visitor_pass_id: "old1", exit_hinted_at: null, exited_at: null, normalized_plate: "ABC1234", plate_text: "ABC1234" }];
  const passes = [{ id: "new1", property_id: "p1", plate_text: "ABC1234", back_plate: null, valid_from: "2026-11-11T20:00:00Z", valid_until: "2026-11-12T20:00:00Z", cancelled_at: null, status: "active" }];
  const tables = { alpr_violations: violations, plate_sessions: sessions, visitor_passes: passes, resident_plates: [] as Row[], enforcement_pauses: [PAUSE as Row] };
  const broken = fakeDb(tables, { failUpdates: ["alpr_violations"] });
  const { rows, pauses } = await pendingAt(broken, AFTER);
  const d = await pendingDecision(broken, rows[0], pauses, AFTER);
  if (d.kind !== "covered") throw new Error(`expected covered, got ${d.kind}`);
  assertEquals(await closeCoveredViolation(broken, rows[0], d, AFTER), "failed");
  // Nothing moved: the session is still the expired one the violation hangs off.
  assertEquals([sessions[0].state, sessions[0].visitor_pass_id], ["expired", "old1"]);
  assertEquals([violations[0].status, violations[0].dispatched_at], ["pending", null]);
  // The next tick decides "covered" again, never "send".
  const next = await pendingAt(fakeDb(tables), new Date("2026-11-11T21:04:00Z"));
  assertEquals(await pendingDecision(fakeDb(tables), next.rows[0], next.pauses, new Date("2026-11-11T21:04:00Z")),
    { kind: "covered", cover: { kind: "pass", id: "new1" }, sessionId: "s1" });
});

Deno.test("tow email: a covered row already dispatched elsewhere is not re-pointed and is not a failure", async () => {
  const violations = [{ ...violation("v1", "p1", "s1", "2026-11-11T19:00:00Z"), dispatched_at: "2026-11-11T21:00:30Z" }];
  const sessions = [{ id: "s1", property_id: "p1", state: "expired", visitor_pass_id: "old1" }];
  const db = fakeDb({ alpr_violations: violations, plate_sessions: sessions });
  const r = await closeCoveredViolation(db, violations[0] as unknown as PendingViolation, { cover: { kind: "pass", id: "new1" }, sessionId: "s1" }, AFTER);
  assertEquals(r, "not_pending");
  assertEquals([sessions[0].state, sessions[0].visitor_pass_id], ["expired", "old1"]);
});

Deno.test("coverCloseHealth: a failed dismiss of a covered car fails the heartbeat; none passes", () => {
  assertEquals(coverCloseHealth(0), null);
  assertEquals(coverCloseHealth(2), "covered_close_failed: 2 held violations with a parking pass could not be closed; retrying next tick");
});
