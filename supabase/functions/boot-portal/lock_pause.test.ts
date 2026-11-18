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
    message: "Enforcement is paused at Mayfield Memorial Apartments until Sat 6:00 PM. Only a car sent to you to boot before the pause can be booted until then. Nothing was recorded. Take the boot off the wheel.",
  });
  await run(db(), "plaza").p;
});

Deno.test("lock wiring: no pause anywhere reads nothing else (no property list, no points, no dispatch query)", async () => {
  const r = run(fakeDb({ enforcement_pauses: [], properties: PROPS }, { failReads: ["alpr_violations"] }), "mayfield");
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

Deno.test("lock wiring: the dispatch does not stand if sent after the start, closed, another channel, another plate or another property", async () => {
  const refused = async (v: Row) =>
    (await refusal(run(fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [v] }), "mayfield").p)).code;
  assertEquals(await refused(bootSms({ dispatched_at: "2026-11-20T23:05:00.000Z" })), "enforcement_paused");
  assertEquals(await refused(bootSms({ status: "dismissed", action_taken: "no_tow" })), "enforcement_paused"); // stood down, GONE, or stale
  assertEquals(await refused(bootSms({ status: "dispatch_failed" })), "enforcement_paused"); // the text never went out
  assertEquals(await refused(bootSms({ action_channel: "email" })), "enforcement_paused");
  assertEquals(await refused(bootSms({ plate_text: "XYZ9876" })), "enforcement_paused");
  assertEquals(await refused(bootSms({ property_id: "plaza" })), "enforcement_paused");
});

Deno.test("lock wiring: a failed standing-dispatch read still refuses at a paused property", async () => {
  const db = fakeDb({ enforcement_pauses: [PAUSE], properties: PROPS, alpr_violations: [bootSms({})] }, { failReads: ["alpr_violations"] });
  assertEquals((await refusal(run(db, "mayfield").p)).code, "enforcement_paused");
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
