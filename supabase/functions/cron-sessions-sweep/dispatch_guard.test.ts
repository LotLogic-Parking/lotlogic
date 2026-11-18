import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { leftSignal } from "./dispatch_guard.ts";

Deno.test("leftSignal: no signal at all means the car may still be there", () => {
  assertEquals(leftSignal({}), null);
  assertEquals(leftSignal({ violationLeftAt: null, sessionExitHintedAt: null, sessionExitedAt: null, passExitedAt: null }), null);
});

Deno.test("leftSignal: the existing two signals keep their names (session exit hint, linked pass exit)", () => {
  assertEquals(leftSignal({ sessionExitHintedAt: "2026-11-11T20:00:00Z" }), { signal: "session_exit", at: "2026-11-11T20:00:00Z" });
  assertEquals(leftSignal({ passExitedAt: "2026-11-11T20:01:00Z" }), { signal: "pass_exited", at: "2026-11-11T20:01:00Z" });
});

Deno.test("leftSignal: an apartment exit that only closed the visit or stamped the violation also counts (contrarian P1-3)", () => {
  // applyExitOutcome / closeLeftUnseen set plate_sessions.exited_at and alpr_violations.left_before_tow_at,
  // not exit_hinted_at. A violation held by a pause must not be dispatched and then stood down.
  assertEquals(leftSignal({ sessionExitedAt: "2026-11-11T20:02:00Z" }), { signal: "session_closed", at: "2026-11-11T20:02:00Z" });
  assertEquals(leftSignal({ violationLeftAt: "2026-11-11T20:03:00Z" }), { signal: "violation_left", at: "2026-11-11T20:03:00Z" });
  assertEquals(leftSignal({ sessionExitHintedAt: "2026-11-11T20:00:00Z", violationLeftAt: "2026-11-11T20:03:00Z" })?.signal, "session_exit");
});
