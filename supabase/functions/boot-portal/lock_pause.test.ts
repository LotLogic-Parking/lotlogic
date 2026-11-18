import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { HttpError } from "../_shared/boot.ts";
import { fakeDb, type Row } from "../cron-sessions-sweep/fake_db.ts";
import { refuseIfPaused } from "./lock_pause.ts";

// lock()'s pause wiring (lock_pause.ts) against a fake PostgREST: the pause
// read, the property-type lookup on a failed read, and the standing boot
// dispatch query. The pure decisions are in pause_gate.test.ts.

// Mayfield (an apartment) is paused Fri 6:00 PM -> Sat 6:00 PM Eastern; the plaza never is.
const PAUSE = { id: "pz1", property_id: "mayfield", starts_at: "2026-11-20T23:00:00.000Z", ends_at: "2026-11-21T23:00:00.000Z", ended_early_at: null, cancelled_at: null, reason: "Pool party" };
const NOW = new Date("2026-11-21T02:00:00.000Z");
const PROPS = [{ id: "mayfield", property_type: "apartment" }, { id: "plaza", property_type: "truck_plaza" }];
const MINE = [{ id: "mayfield", name: "Mayfield Memorial Apartments" }, { id: "plaza", name: "Plaza Truck Stop" }];
const POINTS = [{ id: "mayfield", name: "Mayfield Memorial Apartments", lat: 35.282624, lng: -80.811167 }];
const bootSms = (o: Partial<Row>): Row => ({ property_id: "mayfield", plate_text: "ABC1234", action_channel: "boot_sms", status: "dispatched", dispatched_at: "2026-11-20T22:55:00.000Z", ...o });

function run(db: ReturnType<typeof fakeDb>, propertyId: string | null, plate = "ABC1234") {
  const calls = { mine: 0, points: 0 };
  const p = refuseIfPaused(db, {
    now: NOW, propertyId, lat: null, lon: null, plate,
    myProperties: async () => { calls.mine++; return MINE; },
    points: async () => { calls.points++; return POINTS; },
  });
  return { p, calls };
}
async function refusal(p: Promise<void>) {
  const e = await assertRejects(() => p, HttpError);
  return { status: e.status, code: e.code, message: e.message };
}

Deno.test("lock wiring: a paused property refuses 409 enforcement_paused; an unpaused one goes ahead", async () => {
  const db = () => fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [] });
  assertEquals(await refusal(run(db(), "mayfield").p), {
    status: 409, code: "enforcement_paused",
    message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then. Nothing was recorded. Take the boot off the wheel.",
  });
  await run(db(), "plaza").p;
});

Deno.test("lock wiring: no pause anywhere reads nothing else (no property list, no points, no dispatch query)", async () => {
  const r = run(fakeDb({ enforcement_pauses: [], properties: PROPS }, { failReads: ["alpr_violations", "tow_requests", "plate_sessions"] }), "mayfield");
  await r.p;
  assertEquals(r.calls, { mine: 0, points: 0 });
});

Deno.test("lock wiring: a failed pause read refuses 503 pause_check_failed at an apartment, and with no property", async () => {
  const db = () => fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS }, { failReads: ["enforcement_pauses"] });
  const want = { status: 503, code: "pause_check_failed", message: "Could not check for an enforcement pause. Try again." };
  assertEquals(await refusal(run(db(), "mayfield").p), want);
  assertEquals(await refusal(run(db(), null).p), want);
  // An apartment the type lookup cannot read is treated as an apartment.
  assertEquals(await refusal(run(fakeDb({ properties: PROPS }, { failReads: ["enforcement_pauses", "properties"] }), "plaza").p), want);
  assertEquals(await refusal(run(fakeDb({ properties: PROPS }, { failReads: ["enforcement_pauses"] }), "gone").p), want);
});

Deno.test("lock wiring: a failed pause read never stops a boot at a truck plaza (looked up by property type)", async () => {
  const r = run(fakeDb({ properties: PROPS }, { failReads: ["enforcement_pauses"] }), "plaza");
  await r.p;
  assertEquals(r.calls, { mine: 0, points: 0 });
});

Deno.test("lock wiring: a boot_sms dispatch texted before the pause started, still open, lets the boot go ahead", async () => {
  await run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [bootSms({})] }), "mayfield", "abc-1234").p;
});

Deno.test("lock wiring: a dispatch texted before the pause that the driver already answered DONE still lets the boot be recorded", async () => {
  // The DONE reply (backend BOOT_REPLY_OUTCOMES "booted") resolves the row; the boot is still the one sent before the pause.
  await run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [bootSms({ status: "resolved", action_taken: "boot" })] }), "mayfield").p;
});

Deno.test("lock wiring: an old dispatch of the same plate answered DONE long ago does not let a new boot through during the pause", async () => {
  // Same car, same property, booted three weeks ago (resolved as a boot). It is back during the pause: that is
  // new enforcement, so the pause holds it. Only a DONE within the last BOOT_REPLY_HOURS counts.
  const old = bootSms({ status: "resolved", action_taken: "boot", dispatched_at: "2026-10-30T15:00:00.000Z", resolved_at: "2026-10-30T15:20:00.000Z" });
  assertEquals((await refusal(run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [old] }), "mayfield").p)).code, "enforcement_paused");
  // Answered DONE 10 minutes after the pause began, for a text sent 5 minutes before it: stands.
  const recent = bootSms({ status: "resolved", action_taken: "boot", resolved_at: "2026-11-20T23:10:00.000Z" });
  await run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [recent] }), "mayfield").p;
});

Deno.test("lock wiring: a pre-pause dispatch is found even with a long history of old boot dispatches at the property", async () => {
  // PostgREST caps a read (max-rows); the standing read is bounded by time so old rows cannot crowd out the one that matters.
  const history = Array.from({ length: 1200 }, (_, i) => bootSms({ plate_text: `OLD${i}`, status: "resolved", action_taken: "boot", dispatched_at: "2026-09-01T12:00:00.000Z", resolved_at: "2026-09-01T12:30:00.000Z" }));
  const db = fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [...history, bootSms({})] }, { maxRows: 1000 });
  await run(db, "mayfield").p;
});

Deno.test("lock wiring: the dispatch does not stand if sent after the start, closed, another plate or another property", async () => {
  const refused = async (v: Row) =>
    (await refusal(run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [v] }), "mayfield").p)).code;
  assertEquals(await refused(bootSms({ dispatched_at: "2026-11-20T23:05:00.000Z" })), "enforcement_paused");
  assertEquals(await refused(bootSms({ status: "dismissed", action_taken: "no_tow" })), "enforcement_paused"); // stood down, GONE, or stale
  assertEquals(await refused(bootSms({ status: "dispatch_failed" })), "enforcement_paused"); // the text never went out
  // A tow email sent before the pause now stands too (Gabe 2026-11-18): see the camera-flag tests below.
  assertEquals(await refused(bootSms({ action_channel: "email", status: "dismissed", action_taken: "no_tow" })), "enforcement_paused");
  assertEquals(await refused(bootSms({ plate_text: "XYZ9876" })), "enforcement_paused");
  assertEquals(await refused(bootSms({ property_id: "plaza" })), "enforcement_paused");
});

Deno.test("lock wiring: a failed standing-dispatch read still refuses at a paused property", async () => {
  const db = fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [bootSms({})] }, { failReads: ["alpr_violations"] });
  assertEquals((await refusal(run(db, "mayfield").p)).code, "enforcement_paused");
});

// ── In motion before the pause (Gabe, 2026-11-18) ───────────────────────────
// Besides a boot text sent before the pause, the backend's curb verdict lets
// these through a pause (plate_verdict.decide_for_property): an open office
// tow request, placed before the pause or during it, and an open camera flag
// whose tow email or boot text went out before the pause began.

const towRequest = (o: Partial<Row>): Row => ({
  id: "tr1", property_id: "mayfield", kind: "tow", status: "active", normalized_plate: "ABC1234", normalized_back_plate: null,
  created_at: "2026-11-20T21:00:00.000Z", expires_at: "2026-11-22T21:00:00.000Z", ...o,
});
const towEmail = (o: Partial<Row>): Row => ({
  id: "av1", property_id: "mayfield", plate_text: "ABC-1234", action_channel: "email", status: "dispatched", action_taken: null,
  dispatched_at: "2026-11-20T20:00:00.000Z", left_before_tow_at: null, tow_confirmed_at: null, session_id: "s1", ...o,
});
const VISIT = { id: "s1", exited_at: null };
/** A fake that records which tables were read. */
function tracked(tables: Record<string, Row[]>, opts: Parameters<typeof fakeDb>[1] = {}) {
  const db = fakeDb(tables, opts);
  const reads: string[] = [];
  return { reads, db: { from: (t: string) => { reads.push(t); return db.from(t); } } };
}
const at = (tables: Record<string, Row[]>, plate = "ABC1234", opts: Parameters<typeof fakeDb>[1] = {}) =>
  run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [], plate_sessions: [VISIT], ...tables }, opts), "mayfield", plate).p;
const codeOf = async (p: Promise<void>) => (await refusal(p)).code;

Deno.test("lock wiring: an office tow request placed before the pause, still open, lets the boot go ahead", async () => {
  await at({ tow_requests: [towRequest({})] }, "abc 1234");
  // On the back plate too, as the backend matches it.
  await at({ tow_requests: [towRequest({ normalized_plate: "ZZZ0000", normalized_back_plate: "ABC1234" })] });
});

Deno.test("lock wiring: an office tow request placed during the pause lets the boot go ahead", async () => {
  await at({ tow_requests: [towRequest({ created_at: "2026-11-21T01:00:00.000Z" })] });
});

Deno.test("lock wiring: a tow request that is no longer open (fulfilled, declined, removed, expired, or past expires_at) is refused", async () => {
  for (const status of ["fulfilled", "declined", "removed", "expired"]) {
    assertEquals(await codeOf(at({ tow_requests: [towRequest({ status })] })), "enforcement_paused", status);
  }
  assertEquals(await codeOf(at({ tow_requests: [towRequest({ expires_at: "2026-11-21T01:00:00.000Z" })] })), "enforcement_paused");
});

Deno.test("lock wiring: a photo-only request (or a hold) is not a request to enforce: refused", async () => {
  assertEquals(await codeOf(at({ tow_requests: [towRequest({ kind: "photo" })] })), "enforcement_paused");
  assertEquals(await codeOf(at({ tow_requests: [towRequest({ kind: "hold" })] })), "enforcement_paused");
});

Deno.test("lock wiring: a tow email sent before the pause began, still open, lets the boot go ahead", async () => {
  await at({ alpr_violations: [towEmail({})] });
  // A visit with no session row read still stands; the plate's separators do not matter.
  await at({ alpr_violations: [towEmail({ session_id: null, plate_text: "abc1234" })] });
});

Deno.test("lock wiring: a tow email sent after the pause began is refused (the pause held it)", async () => {
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({ dispatched_at: "2026-11-20T23:00:00.000Z" })] })), "enforcement_paused");
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({ dispatched_at: "2026-11-21T01:00:00.000Z" })] })), "enforcement_paused");
});

Deno.test("lock wiring: a dismissed or closed camera flag is refused", async () => {
  const refused = async (o: Partial<Row>) => await codeOf(at({ alpr_violations: [towEmail(o)] }));
  assertEquals(await refused({ status: "dismissed", action_taken: "no_tow" }), "enforcement_paused");
  assertEquals(await refused({ status: "resolved", action_taken: "tow" }), "enforcement_paused");
  assertEquals(await refused({ action_taken: "tow" }), "enforcement_paused");
  assertEquals(await refused({ left_before_tow_at: "2026-11-20T21:00:00.000Z" }), "enforcement_paused");
  assertEquals(await refused({ tow_confirmed_at: "2026-11-20T22:00:00.000Z" }), "enforcement_paused");
  assertEquals(await refused({ status: "dispatch_failed" }), "enforcement_paused");
  // Sent more than FLAG_STANDING_DAYS before the pause: the car at the curb now is new enforcement.
  assertEquals(await refused({ dispatched_at: "2026-11-13T22:59:00.000Z" }), "enforcement_paused");
  // Its visit ended (the car left and came back).
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({})], plate_sessions: [{ id: "s1", exited_at: "2026-11-20T21:30:00.000Z" }] })), "enforcement_paused");
});

Deno.test("lock wiring: the existing case still stands: a boot text sent before the pause", async () => {
  await at({ alpr_violations: [bootSms({})], tow_requests: [] });
});

Deno.test("lock wiring: a request or a flag on another plate, or at another property, does not let this plate through", async () => {
  const other = { tow_requests: [towRequest({ normalized_plate: "XYZ9876" })], alpr_violations: [towEmail({ plate_text: "XYZ9876" }), bootSms({ plate_text: "XYZ9876" })] };
  assertEquals(await codeOf(at(other)), "enforcement_paused");
  const elsewhere = { tow_requests: [towRequest({ property_id: "plaza" })], alpr_violations: [towEmail({ property_id: "plaza" })] };
  assertEquals(await codeOf(at(elsewhere)), "enforcement_paused");
});

Deno.test("lock wiring: failed reads of tow requests, flags or visits refuse; they never allow", async () => {
  assertEquals(await codeOf(at({ tow_requests: [towRequest({})] }, "ABC1234", { failReads: ["tow_requests"] })), "enforcement_paused");
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({})] }, "ABC1234", { failReads: ["alpr_violations"] })), "enforcement_paused");
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({})] }, "ABC1234", { failReads: ["plate_sessions"] })), "enforcement_paused");
});

Deno.test("lock wiring: with no pause, nothing changes: requests and flags are not read and the boot goes ahead", async () => {
  const t = tracked({ enforcement_pauses: [], properties: PROPS, alpr_violations: [towEmail({})], tow_requests: [towRequest({})], plate_sessions: [VISIT] });
  const r = run(t.db as ReturnType<typeof fakeDb>, "mayfield");
  await r.p;
  assertEquals(t.reads, ["enforcement_pauses"]);
  assertEquals(r.calls, { mine: 0, points: 0 });
  // A pause elsewhere: this property's boot goes ahead with no request or flag at all.
  await run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [] }), "plaza", "XYZ9876").p;
});

// ── A hold or a parking pass keeps DO NOT TOW (backend _TOW_OVERRIDES_PAUSE) ──

const longTerm = (o: Partial<Row>): Row => ({ property_id: "mayfield", plate_text: "abc-1234", normalized_back_plate: null, status: "approved", active: true, created_at: "2026-01-01T00:00:00.000Z", ...o });
const shortTerm = (o: Partial<Row>): Row => ({ property_id: "mayfield", plate_text: "ABC 1234", normalized_back_plate: null, status: "active", valid_until: "2026-11-21T05:00:00.000Z", ...o });

Deno.test("lock wiring: an open tow request with a live hold on the same plate is refused", async () => {
  const r = await refusal(at({ tow_requests: [towRequest({}), towRequest({ id: "tr2", kind: "hold" })] }));
  assertEquals(r.code, "enforcement_paused");
  assertEquals(r.message.includes("This car has a hold or a parking pass on file"), true);
  // A hold that has expired does not protect.
  await at({ tow_requests: [towRequest({}), towRequest({ id: "tr2", kind: "hold", expires_at: "2026-11-21T01:00:00.000Z" })] });
});

Deno.test("lock wiring: a tow email sent before the pause, then a parking pass registered, is refused", async () => {
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({})], visitor_passes: [shortTerm({})] })), "enforcement_paused");
  assertEquals(await codeOf(at({ alpr_violations: [towEmail({})], resident_plates: [longTerm({})] })), "enforcement_paused");
  assertEquals(await codeOf(at({ tow_requests: [towRequest({})], resident_plates: [longTerm({ plate_text: "ZZZ0000", normalized_back_plate: "ABC1234" })] })), "enforcement_paused");
  // A pending request inside its protection window protects too.
  assertEquals(await codeOf(at({ tow_requests: [towRequest({})], resident_plates: [longTerm({ status: "pending", created_at: "2026-11-20T12:00:00.000Z" })] })), "enforcement_paused");
});

Deno.test("lock wiring: a pass that no longer protects (ended, pending too long, withdrawn, another plate or property) leaves the request or flag standing", async () => {
  await at({ alpr_violations: [towEmail({})], visitor_passes: [shortTerm({ valid_until: "2026-11-21T01:00:00.000Z" })] });
  await at({ alpr_violations: [towEmail({})], visitor_passes: [shortTerm({ status: "expired" })] });
  await at({ tow_requests: [towRequest({})], resident_plates: [longTerm({ status: "pending", created_at: "2026-11-17T12:00:00.000Z" })] });
  await at({ tow_requests: [towRequest({})], resident_plates: [longTerm({ status: "pending", active: false, created_at: "2026-11-20T12:00:00.000Z" })] });
  await at({ tow_requests: [towRequest({})], resident_plates: [longTerm({ status: "rejected" })] });
  await at({ tow_requests: [towRequest({})], resident_plates: [longTerm({ plate_text: "ABC12345" }), longTerm({ property_id: "plaza" })] });
});

Deno.test("lock wiring: a failed read of passes refuses a request or flag; a boot text sent before the pause still stands", async () => {
  for (const t of ["resident_plates", "visitor_passes"]) {
    assertEquals(await codeOf(at({ tow_requests: [towRequest({})], alpr_violations: [towEmail({})] }, "ABC1234", { failReads: [t] })), "enforcement_paused", t);
  }
  await at({ alpr_violations: [bootSms({})] }, "ABC1234", { failReads: ["resident_plates", "visitor_passes"] });
  await at({ alpr_violations: [bootSms({})], resident_plates: [longTerm({})], tow_requests: [towRequest({ kind: "hold" })] });
});

// ── release, open, cancel: untouched by a pause ─────────────────────────────
// index.ts runs Deno.serve when loaded, so it cannot be imported here. What
// keeps release, open and cancel working during a pause is that nothing they
// run reads a pause; this reads index.ts and checks exactly that.

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
/** Each top-level function in index.ts, name -> body. */
function functions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^(?:async )?function (\w+)\(/gm;
  const starts = [...src.matchAll(re)];
  starts.forEach((m, i) => out.set(m[1], src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : src.length)));
  return out;
}
const PAUSE_CALL = /\b(refuseIfPaused|readPauses|lockPauseRefusal|unknownPauseBlocks|annotatePauses)\b/;

Deno.test("routes: open, unlock (release), cancel, store and emergency call the functions they did, and only lock() checks a pause", () => {
  for (const [route, fn] of [["open", "openBoot"], ["unlock", "unlock"], ["cancel", "cancel"], ["store", "store"], ["emergency", "emergency"], ["lock", "lock"]]) {
    assertEquals(new RegExp(`route === "${route}"\\) return json\\(await ${fn}\\(`).test(SRC), true, `route ${route} -> ${fn}`);
  }
  const fns = functions(SRC);
  for (const name of ["openBoot", "unlock", "cancel", "store", "emergency"]) {
    assertEquals(fns.has(name), true, name);
    assertEquals(PAUSE_CALL.test(fns.get(name)!), false, `${name} reads a pause`);
  }
  const checking = [...fns].filter(([, body]) => PAUSE_CALL.test(body)).map(([name]) => name);
  assertEquals(checking, ["lock"]);
  // Outside the functions, the router reads pauses only to annotate GET /properties.
  const router = SRC.slice(SRC.indexOf("Deno.serve("), SRC.indexOf("\n});\n", SRC.indexOf("Deno.serve(")));
  assertEquals(router.split("\n").filter((l) => PAUSE_CALL.test(l)).map((l) => l.trim().split(")")[0]), ['if (route === "properties"']);
});
