// ── What the sweep does to a `grace` visit that never registered ────────
//
// Truck plaza: at GRACE_EXPIRY_MINUTES the visit is thrown away
// (closed_clean, no violation) — the plaza's own rule since 2026-04.
//
// Apartment (Gabe, 2026-11-12: "keep it on screen, red"): the visit stays
// open so the office sees the car under Visitors here as "Not registered"
// until the exit camera reads it leaving, or, once BOOT_DRIVER_PHONES is
// set, until bootDispatch moves it to `expired` at the dispatch minute.
// Only a visit nobody has seen for STALE_HOURS is closed, so a car the exit
// camera missed does not sit on the screen for ever.

export const APARTMENT_GRACE_STALE_HOURS_DEFAULT = 24;

export type GraceDecision = "close" | "keep";

export function graceDecision(input: {
  propertyType: string | null | undefined;
  enteredAt: string;
  lastDetectedAt: string | null | undefined;
  now: Date;
  expiryMinutes: number;
  staleHours?: number;
}): GraceDecision {
  const nowMs = input.now.getTime();
  const entered = Date.parse(input.enteredAt);
  if (!Number.isFinite(entered)) return "keep";
  if (input.propertyType !== "apartment") {
    return nowMs - entered >= input.expiryMinutes * 60_000 ? "close" : "keep";
  }
  const last = input.lastDetectedAt ? Date.parse(input.lastDetectedAt) : NaN;
  const seen = Number.isFinite(last) ? Math.max(last, entered) : entered;
  const staleMs = (input.staleHours ?? APARTMENT_GRACE_STALE_HOURS_DEFAULT) * 3_600_000;
  return nowMs - seen >= staleMs ? "close" : "keep";
}
