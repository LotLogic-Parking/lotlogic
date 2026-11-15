// Boot payments, logged with where the boot was and which of our properties
// that is (Gabe, 2026-11-15: "make sure all boot payments are logged with their
// gps location cross referenced to each of our properties and make sure that
// each square payment is logged in our dashboard with all relevant
// information").
//
// Pure half: distance, nearest property, and joining Square's payment list to
// boot_deployments. The route in index.ts does the reads.

export const PROPERTY_MATCH_M = 500; // a placement within this of a property's address point is at that property

// Gabe, 2026-11-15: "FOR THE boot payments it should only go back to today". Everything before that day was
// testing (the two $1 payments on 2026-11-11), so the log starts at midnight Eastern on 2026-11-15 (EST, UTC-5).
export const PAYMENTS_LOG_START = "2026-11-15T05:00:00.000Z";

/** Where the payments log starts: the log start, or `days` back from now when that is later. */
export function logSince(nowMs: number, days: number | null, start = PAYMENTS_LOG_START): string {
  const startMs = Date.parse(start);
  return new Date(days == null ? startMs : Math.max(startMs, nowMs - days * 86400_000)).toISOString();
}

export type PropertyPoint = { id: string; name: string; lat: number | null; lng: number | null };
export type GeoMatch = {
  property_id: string | null; property: string | null; distance_m: number | null;
  nearest: string | null; nearest_m: number | null; at_property: boolean;
};

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The nearest property to a point, and whether it is close enough to count as "at" it. */
export function matchProperty(lat: unknown, lon: unknown, props: PropertyPoint[], maxM = PROPERTY_MATCH_M): GeoMatch {
  const none: GeoMatch = { property_id: null, property: null, distance_m: null, nearest: null, nearest_m: null, at_property: false };
  if (!finite(lat) || !finite(lon) || (lat === 0 && lon === 0)) return none;
  let best: { p: PropertyPoint; d: number } | null = null;
  for (const p of props) {
    if (!finite(p.lat) || !finite(p.lng)) continue;
    const d = haversineM(lat, lon, p.lat, p.lng);
    if (!best || d < best.d) best = { p, d };
  }
  if (!best) return none;
  const d = Math.round(best.d);
  const at = d <= maxM;
  return { property_id: at ? best.p.id : null, property: at ? best.p.name : null, distance_m: at ? d : null, nearest: best.p.name, nearest_m: d, at_property: at };
}

/** Where a placement was: the lock GPS from the driver's phone, else the emergency GPS, else nothing. */
export function placementPoint(dep: Record<string, unknown>): { lat: number; lon: number; source: "lock" | "emergency" } | null {
  if (finite(dep.lock_lat) && finite(dep.lock_lon)) return { lat: dep.lock_lat, lon: dep.lock_lon, source: "lock" };
  if (finite(dep.emergency_lat) && finite(dep.emergency_lon)) return { lat: dep.emergency_lat, lon: dep.emergency_lon, source: "emergency" };
  return null;
}

// ── Square ───────────────────────────────────────────────────

export type SquarePayment = {
  id: string; created_at?: string; status?: string; order_id?: string; note?: string; receipt_url?: string; receipt_number?: string;
  amount_money?: { amount?: number; currency?: string }; total_money?: { amount?: number };
  refunded_money?: { amount?: number };
  processing_fee?: Array<{ amount_money?: { amount?: number } }>;
  card_details?: { card?: { card_brand?: string; last_4?: string } };
  buyer_email_address?: string; source_type?: string;
};

export function squareFeeCents(p: SquarePayment | null | undefined): number | null {
  if (!p?.processing_fee?.length) return null;
  return p.processing_fee.reduce((a, f) => a + (f.amount_money?.amount ?? 0), 0);
}

/** The deployment id a Square payment belongs to: our payment_note is "boot_deployment:<uuid>". */
export function deploymentIdFromNote(note: unknown): string | null {
  const m = typeof note === "string" ? note.match(/boot_deployment:([0-9a-f-]{36})/i) : null;
  return m ? m[1].toLowerCase() : null;
}

export function squareDashboardUrl(paymentId: string | null | undefined): string | null {
  return paymentId ? `https://squareup.com/dashboard/sales/transactions/${encodeURIComponent(paymentId)}` : null;
}

type Dep = Record<string, unknown> & { id: string };

/**
 * Join Square's payments to deployments: by payment id, then order id, then the
 * note we put on every checkout. Returns the deployment for each Square payment
 * (or null) and the deployments marked paid that Square did not list.
 */
export function joinSquare(payments: SquarePayment[], deps: Dep[]) {
  const byPayment = new Map<string, Dep>(), byOrder = new Map<string, Dep>(), byId = new Map<string, Dep>();
  for (const d of deps) {
    byId.set(d.id, d);
    if (typeof d.square_payment_id === "string") byPayment.set(d.square_payment_id, d);
    if (typeof d.square_order_id === "string") byOrder.set(d.square_order_id, d);
  }
  const seen = new Set<string>();
  const pairs = payments.map((p) => {
    const d = byPayment.get(p.id) ?? (p.order_id ? byOrder.get(p.order_id) : undefined) ?? byId.get(deploymentIdFromNote(p.note) ?? "") ?? null;
    if (d) seen.add(d.id);
    return { square: p, deployment: d };
  });
  const paidNotInSquare = deps.filter((d) => d.paid_at && !seen.has(d.id));
  return { pairs, paidNotInSquare };
}
