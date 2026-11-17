import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// What a pause may touch (Gabe, 2026-11-17): a pause holds only NEW
// enforcement. A tow notice or boot text that went out before the pause goes
// ahead during it, and so does everything that follows from it: the partner's
// stand-down email, the boot drivers' stand-down texts, a registration that
// cancels a boot, tow-confirm closing a tow the partner made, and the closes.
//
// index.ts runs Deno.serve when loaded and cannot be imported by a test, and
// tow-confirm / tow-dispatch-email are separate functions. What keeps those
// paths working during a pause is that nothing they run reads a pause; this
// reads the sources and checks exactly that. The behaviour of the four steps
// that do read it is under test in pause_hold.test.ts and boot_dispatch.test.ts.

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const SWEEP = await read("./index.ts");
const BOOT = await read("./boot_dispatch.ts");
const PAUSE_REF = /\b(pauses|readPauses|excludePaused|heldThroughPause|PauseRead|enforcement_pauses)\b/;

/** Each top-level function, name -> body. */
function functions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)];
  starts.forEach((m, i) => out.set(m[1], src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : src.length)));
  return out;
}

Deno.test("sweep: only the four steps that start new enforcement read the pause", () => {
  const fns = functions(SWEEP);
  const reading = [...fns].filter(([, body]) => PAUSE_REF.test(body)).map(([name]) => name).sort();
  assertEquals(reading, ["dispatchPendingViolations", "graceExpiry", "overstayExpiry"]);
  // In the tick itself: bootDispatch gets the read; the stand-down and registration steps do not.
  const tick = SWEEP.slice(SWEEP.indexOf("Deno.serve("), SWEEP.indexOf("await heartbeat(db,"));
  assertEquals(/bootDispatch\(\{ \.\.\.bootDeps\(\), now: tickAt, pauses \}\)/.test(tick), true);
  for (const call of ["bootRegistrations(bootDeps())", "bootStandDowns(bootDeps())", "sweepPendingStandDowns(fanoutBudget)", "closeRegistered()", "closeResident()", "closeExpired()"]) {
    assertEquals(tick.includes(call), true, call);
  }
});

Deno.test("boot dispatch: the stand-down and registration paths for a boot already texted never read the pause", () => {
  const fns = functions(BOOT);
  for (const name of ["bootRegistrations", "bootStandDowns", "standDown", "openBootViolations", "findCoveringPass"]) {
    assertEquals(fns.has(name), true, name);
    assertEquals(PAUSE_REF.test(fns.get(name)!), false, `${name} reads a pause`);
  }
});

Deno.test("tow-confirm and tow-dispatch-email (notices and stand-downs already sent) never read the pause", async () => {
  for (const rel of ["../tow-confirm/index.ts", "../tow-dispatch-email/index.ts"]) {
    const src = await read(rel);
    assertEquals(/_shared\/pause|enforcement_pauses|readPauses/.test(src), false, rel);
  }
});
