// No boot at a property whose enforcement is paused (spec 2026-11-16 Part 3,
// plan Task 10). Pure half: index.ts lock() reads the pauses and the points.
//
// The check sits after lock() has resolved and access-checked the property,
// because the property is optional there (picked, or matched from GPS, or
// neither). It applies to every company's boots, not only LotLogic's: the
// manager paused the property and the tow company has been told.
//
// A pause holds only new enforcement (Gabe, 2026-11-17): what was already in
// motion before it still goes ahead, by property, by GPS, or with neither (the
// plate says where). In motion, for this plate at this property, is any of:
//
//   • a boot text (boot_sms) sent to LotLogic's drivers before starts_at that
//     is still open, or that the driver answered DONE (resolved as a boot)
//     within the last BOOT_REPLY_HOURS (dispatchedBeforePause). One stood
//     down, answered GONE, gone stale or never sent does not count, and
//     neither does a DONE from long ago: the same car booted weeks back and
//     parked again during the pause is new enforcement. Without this the
//     driver sent at 5:55 PM arrives at 6:10 PM, fits the boot and is refused.
//   • an office tow request (tow_requests, kind 'tow', status 'active', not
//     expired) on the plate, front or back, placed before the pause or during
//     it (officeRequested; Gabe, 2026-11-18). A photo request or a hold is not
//     a request to enforce, and a request that is no longer active (fulfilled,
//     declined, removed, expired) does not count.
//   • a camera flag whose tow email or boot text went out before starts_at and
//     no more than FLAG_STANDING_DAYS before it, still open (flaggedBeforePause;
//     Gabe, 2026-11-18). Open = the backend's FLAG_IN_MOTION_SQL: status
//     'dispatched', no action taken, not left before the tow, no tow
//     confirmed, and its visit not ended. A dismissed flag does not count.
//
// The last two mirror the backend's curb verdict under a pause
// (lotlogic-backend services/plate_verdict.py decide_for_property:
// placed_before_pause / during_pause / flagged_before_pause), so the boot app
// and the plate check agree. As there, they stand only on a car nothing else
// protects (_TOW_OVERRIDES_PAUSE): a live hold (tow_requests kind 'hold'), a
// live parking pass (an approved resident_plates row, one still pending
// inside PENDING_PROTECTION_HOURS, or an active visitor_passes row before its
// valid_until) keeps the plate check at DO NOT TOW, so the boot is refused
// whatever request or flag is open (protectedAt). A visitor_passes row past its
// valid_until does not protect. The boot text above is the older rule and is not narrowed by this:
// the sweep stands its drivers down when a pass covers the car
// (cron-sessions-sweep bootRegistrations). Every other boot at a paused
// property is refused.
//
// A refusal comes after the agent has opened and fitted the boot, so it says
// which cars can still be booted, that nothing was recorded, and that the boot
// has to come off (brainstorm 7.3).

import { endsLocal, type ActivePause, type PauseRead } from "../_shared/pause.ts";
import { matchProperty, type PropertyPoint } from "./payments.ts";

type Named = { id: string; name: string | null };
export type Refusal = { code: "enforcement_paused"; message: string };
/** A boot dispatch (alpr_violations, action_channel boot_sms). lock_pause.ts reads status dispatched and resolved. */
export type StandingDispatch = {
  property_id: string; plate_text: string | null; dispatched_at: string | null;
  /** Absent = boot_sms (lock_pause.ts reads only those for this rule). */
  action_channel?: string | null;
  /** Absent = open (dispatched). */
  status?: string | null; action_taken?: string | null;
  /** When the driver's reply closed it; absent, dispatched_at stands in. */
  resolved_at?: string | null;
};

/**
 * How long a DONE reply keeps a pre-pause dispatch standing for lock(): the
 * life of an open dispatch (the sweep's BOOT_STALE_HOURS_DEFAULT). A driver
 * records the lock minutes after the DONE, not hours.
 */
export const BOOT_REPLY_HOURS = 6;

/** An office tow request (tow_requests). lock_pause.ts reads kind 'tow', status 'active'. */
export type OfficeRequest = {
  property_id: string; kind?: string | null; status?: string | null;
  normalized_plate: string | null; normalized_back_plate?: string | null;
  created_at?: string | null; expires_at?: string | null;
};

/** A camera flag (alpr_violations, any action_channel: tow email or boot text). lock_pause.ts reads the open ones. */
export type CameraFlag = {
  property_id: string; plate_text: string | null; dispatched_at: string | null;
  status?: string | null; action_taken?: string | null; action_channel?: string | null;
  left_before_tow_at?: string | null; tow_confirmed_at?: string | null;
  /** Its plate_sessions visit has an exited_at (lock_pause.ts reads it). */
  visit_ended?: boolean;
};

/** A parking pass on file for a plate (lock_pause.ts reads both tables). */
export type ParkingPass = {
  property_id: string; table: "resident_plates" | "visitor_passes";
  plate_text: string | null; normalized_back_plate?: string | null;
  status?: string | null;
  /** resident_plates.active: a cancelled pending request clears it. */
  active?: boolean | null;
  /** When a resident_plates request was submitted (its pending protection runs from here). */
  created_at?: string | null;
  /** A visitor_passes row protects until then. */
  valid_until?: string | null;
};

/** How long an unreviewed resident_plates request protects the car (backend routers.apartment_passes.PENDING_PROTECTION_HOURS). */
export const PENDING_PROTECTION_HOURS = 72;

/**
 * How long before a pause began a tow email or boot text may have gone out
 * and still stand through it (backend enforcement_pause.FLAG_STANDING_DAYS).
 */
export const FLAG_STANDING_DAYS = 7;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const pausedMessage = (name: string | null, p: ActivePause) =>
  `Enforcement is paused at ${name || "this property"} until ${endsLocal(p.ends_at)}. Only a car the office asked to have towed, or one sent out to be towed or booted before the pause, can be booted until then.`;
/** Said when the car was asked for or sent out, but a hold or a parking pass now protects it. */
const PROTECTED = "This car has a hold or a parking pass on file, so it cannot be booted during the pause.";
const TAKE_IT_OFF = "Nothing was recorded. Take the boot off the wheel.";

/** Still open, or the driver answered DONE (resolved as a boot) within BOOT_REPLY_HOURS. Stood down, GONE, stale or never sent: no. */
function stillABoot(d: StandingDispatch, now: Date): boolean {
  if ((d.status ?? "dispatched") === "dispatched") return true;
  if (d.status !== "resolved" || d.action_taken !== "boot") return false;
  const replied = Date.parse(d.resolved_at ?? d.dispatched_at ?? "");
  return Number.isFinite(replied) && now.getTime() - replied < BOOT_REPLY_HOURS * 3_600_000;
}

/** The drivers were texted to boot this plate at this property before the pause started, and that dispatch still stands. */
export function dispatchedBeforePause(plate: string | null | undefined, propertyId: string, pause: ActivePause, standing: StandingDispatch[], now: Date = new Date()): boolean {
  const want = norm(plate);
  const start = Date.parse(pause.starts_at);
  if (!want || !Number.isFinite(start)) return false;
  return standing.some((d) => {
    const sent = d.dispatched_at ? Date.parse(d.dispatched_at) : NaN;
    const bootText = (d.action_channel ?? "boot_sms") === "boot_sms";
    return bootText && d.property_id === propertyId && norm(d.plate_text) === want && Number.isFinite(sent) && sent < start && stillABoot(d, now);
  });
}

/** An open office request of this kind (active, not expired) on this plate, front or back, at this property. */
function liveRequest(kind: string, plate: string | null | undefined, propertyId: string, requests: OfficeRequest[], now: Date): boolean {
  const want = norm(plate);
  if (!want) return false;
  return requests.some((r) => {
    if (r.property_id !== propertyId || r.kind !== kind || r.status !== "active") return false;
    if (norm(r.normalized_plate) !== want && norm(r.normalized_back_plate) !== want) return false;
    if (r.expires_at == null) return true;
    const exp = Date.parse(r.expires_at);
    return Number.isFinite(exp) && exp > now.getTime();
  });
}

/** The office has an open tow request (kind 'tow', active, not expired) on this plate, front or back, at this property: placed before the pause or during it. */
export function officeRequested(plate: string | null | undefined, propertyId: string, requests: OfficeRequest[], now: Date = new Date()): boolean {
  return liveRequest("tow", plate, propertyId, requests, now);
}

/** A pass the backend's verdict ranks above expired_guest (an approved or still-pending request, or a live short-term pass). */
function passProtects(p: ParkingPass, now: Date): boolean {
  if (p.table === "resident_plates") {
    if (p.status === "approved") return true;
    if (p.status !== "pending" || p.active !== true) return false;
    const at = Date.parse(p.created_at ?? "");
    return Number.isFinite(at) && now.getTime() - at < PENDING_PROTECTION_HOURS * 3_600_000;
  }
  if (p.status !== "active") return false;
  const until = Date.parse(p.valid_until ?? "");
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Something keeps this car at DO NOT TOW at this property whatever is in
 * motion (backend decide_for_property: a verdict outside _TOW_OVERRIDES_PAUSE):
 * a live office hold, or a live parking pass, on the plate front or back.
 */
export function protectedAt(plate: string | null | undefined, propertyId: string, requests: OfficeRequest[], passes: ParkingPass[], now: Date = new Date()): boolean {
  if (liveRequest("hold", plate, propertyId, requests, now)) return true;
  const want = norm(plate);
  if (!want) return false;
  return passes.some((p) => p.property_id === propertyId
    && (norm(p.plate_text) === want || norm(p.normalized_back_plate) === want) && passProtects(p, now));
}

/** A camera flag on this plate at this property whose tow email or boot text went out before the pause began (within FLAG_STANDING_DAYS of it) and is still open. */
export function flaggedBeforePause(plate: string | null | undefined, propertyId: string, pause: ActivePause, flags: CameraFlag[]): boolean {
  const want = norm(plate);
  const start = Date.parse(pause.starts_at);
  if (!want || !Number.isFinite(start)) return false;
  const floor = start - FLAG_STANDING_DAYS * 86_400_000;
  return flags.some((f) => {
    const sent = f.dispatched_at ? Date.parse(f.dispatched_at) : NaN;
    return f.property_id === propertyId && norm(f.plate_text) === want && Number.isFinite(sent) && floor <= sent && sent < start
      && (f.status ?? "dispatched") === "dispatched" && f.action_taken == null
      && f.left_before_tow_at == null && f.tow_confirmed_at == null && !f.visit_ended;
  });
}

export function lockPauseRefusal(i: {
  propertyId: string | null;
  myProperties: Named[];
  lat: number | null;
  lon: number | null;
  active: Map<string, ActivePause>;
  points: PropertyPoint[];
  plate?: string | null;
  standing?: StandingDispatch[];
  requests?: OfficeRequest[];
  flags?: CameraFlag[];
  /** Live parking passes on the plate at the paused properties (resident_plates, visitor_passes). */
  passes?: ParkingPass[];
  /** The holds or passes could not be read: no request or flag may stand (it can only refuse, never allow). */
  protectionsUnknown?: boolean;
  now?: Date;
}): Refusal | null {
  if (i.active.size === 0) return null;
  const now = i.now ?? new Date();
  const inMotion = (propertyId: string, p: ActivePause) =>
    officeRequested(i.plate, propertyId, i.requests ?? [], now) || flaggedBeforePause(i.plate, propertyId, p, i.flags ?? []);
  const isProtected = (propertyId: string) =>
    !!i.protectionsUnknown || protectedAt(i.plate, propertyId, i.requests ?? [], i.passes ?? [], now);
  const stands = (propertyId: string, p: ActivePause) =>
    dispatchedBeforePause(i.plate, propertyId, p, i.standing ?? [], now)
    || (inMotion(propertyId, p) && !isProtected(propertyId));
  // A request or flag held back only by a hold or pass says so; otherwise the general message.
  const refuse = (name: string | null, propertyId: string, p: ActivePause): Refusal => ({
    code: "enforcement_paused",
    message: `${pausedMessage(name, p)} ${inMotion(propertyId, p) && !i.protectionsUnknown ? `${PROTECTED} ` : ""}${TAKE_IT_OFF}`,
  });
  const nameOf = (id: string) => i.myProperties.find((p) => p.id === id)?.name ?? i.points.find((p) => p.id === id)?.name ?? null;
  if (i.propertyId) {
    const p = i.active.get(i.propertyId);
    if (!p || stands(i.propertyId, p)) return null;
    return refuse(nameOf(i.propertyId), i.propertyId, p);
  }
  const gps = finite(i.lat) && finite(i.lon) && !(i.lat === 0 && i.lon === 0);
  if (gps) {
    // Any paused property the phone is at, not only the agent's own.
    const m = matchProperty(i.lat, i.lon, i.points.filter((p) => i.active.has(p.id)));
    const p = m.at_property && m.property_id ? i.active.get(m.property_id) : undefined;
    if (!p || stands(m.property_id!, p)) return null;
    return refuse(m.property, m.property_id!, p);
  }
  // No property and no location: if any of the agent's properties is paused,
  // the agent has to say where they are, unless the plate is in motion (above)
  // at one of those paused properties.
  const pausedMine = i.myProperties.filter((p) => i.active.has(p.id));
  if (pausedMine.some((p) => stands(p.id, i.active.get(p.id)!))) return null;
  const mine = pausedMine[0];
  if (!mine) return null;
  return { code: "enforcement_paused", message: `${pausedMessage(mine.name, i.active.get(mine.id)!)} Nothing was recorded. Pick the property you are booting at.` };
}

/**
 * The pause read failed. A boot at a paused apartment cannot be undone, so
 * refuse, except at a property known not to be an apartment (pauses exist
 * only at apartments; this keeps one bad read from stopping every boot).
 */
export function unknownPauseBlocks(propertyType: string | null): boolean {
  return propertyType !== "truck_plaza";
}

/** GET /properties: each property's paused_until, so the screen can warn before the photo and signature. */
export function annotatePauses<T extends { id: string }>(res: { ok: boolean; properties: T[] }, read: PauseRead) {
  if (!read.ok) return { ...res, pauses_unknown: true };
  return { ...res, properties: res.properties.map((p) => ({ ...p, paused_until: read.active.get(p.id)?.ends_at ?? null })) };
}
