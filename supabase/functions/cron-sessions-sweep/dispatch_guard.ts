// ── "The car already left": the last check before a pending tow dispatch ──
//
// dispatchPendingViolations used to look at two signals only: the session's
// exit_hinted_at and the linked visitor pass's exited_at. An apartment exit
// (applyExitOutcome / closeLeftUnseen in camera-snapshot) closes the visit
// with plate_sessions.exited_at and stamps alpr_violations.left_before_tow_at
// instead. Inside the 5-minute hold that gap is rare; an enforcement pause
// holds a violation for up to 72 h, so without these two signals the end of
// a pause would email a tow for a car that is gone and then, a tick later, a
// stand-down for it: two messages for nothing (contrarian P1-3).

export type LeftSignal = { signal: "session_exit" | "pass_exited" | "session_closed" | "violation_left"; at: string };

export function leftSignal(x: {
  sessionExitHintedAt?: string | null;
  passExitedAt?: string | null;
  sessionExitedAt?: string | null;
  violationLeftAt?: string | null;
}): LeftSignal | null {
  if (x.sessionExitHintedAt) return { signal: "session_exit", at: x.sessionExitHintedAt };
  if (x.passExitedAt) return { signal: "pass_exited", at: x.passExitedAt };
  if (x.sessionExitedAt) return { signal: "session_closed", at: x.sessionExitedAt };
  if (x.violationLeftAt) return { signal: "violation_left", at: x.violationLeftAt };
  return null;
}
