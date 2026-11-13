// ── Apartment visit-opening floor ────────────────────────────────────────
//
// At an apartment, a lone plate read opens a visit on the office screen
// (Gabe, 2026-11-12: "a plate read from C starts a visit"). That makes the
// read's confidence the only thing standing between a decal, a fleet number
// or a grille badge and a red "Not registered" tile. Mayfield 2026-11-12
// 3:21 PM: the front of one Amazon van, which has no plate, opened three
// visits in 17 seconds (scores 0.742, 0.684, 0.677). Every real opening read
// that day scored 0.80 or higher; the only reads under 0.80 were those three
// and three one-character misreads of plates already read at 0.95+.
//
// So a NEW apartment visit needs the read to score at least
// PR_MIN_OPEN_SCORE_APARTMENT (default 0.80). This is separate from the
// read-acceptance floor (PR_MIN_SCORE / PR_MIN_SCORE_APARTMENT /
// PR_MIN_SCORE_OVERRIDES): a weaker read is still accepted, still logged,
// and still extends or closes a visit that is already open under a similar
// plate; it just cannot start one. Truck plazas are unchanged.

export const PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT = 0.80;

export function openFloorFromEnv(raw: string | undefined | null): number {
  const n = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(n) && n >= 0 && n <= 1
    ? n
    : PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT;
}

/** May this lone read open a new visit? */
export function mayOpenVisit(opts: { propertyType: string | null; score: number | null | undefined; floor: number }): boolean {
  if (opts.propertyType !== "apartment") return true;
  const s = typeof opts.score === "number" && Number.isFinite(opts.score) ? opts.score : 0;
  return s >= opts.floor;
}
