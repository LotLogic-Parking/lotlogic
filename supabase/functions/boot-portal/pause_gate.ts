// No boot at a property whose enforcement is paused (spec 2026-11-16 Part 3,
// plan Task 10). Pure half: index.ts lock() reads the pauses and the points.
//
// The check sits after lock() has resolved and access-checked the property,
// because the property is optional there (picked, or matched from GPS, or
// neither). It applies to every company's boots, not only LotLogic's: the
// manager paused the property and the tow company has been told.
//
// A pause holds only new enforcement (Gabe, 2026-11-17): a car LotLogic's
// drivers were texted to boot before the pause started may still be booted
// during it, by property, by GPS, or with neither (the plate says where).
// "Texted before" = a boot_sms dispatch sent before starts_at that is still
// open, or that the driver answered DONE (resolved as a boot) within the last
// BOOT_REPLY_HOURS. One stood down, answered GONE, gone stale or never sent
// does not count, and neither does a DONE from long ago: the same car booted
// weeks back and parked again during the pause is new enforcement. Without
// this the driver sent at 5:55 PM arrives at 6:10 PM, fits the boot and is
// refused. Every other boot at a paused property is refused.
//
// A refusal comes after the agent has opened and fitted the boot, so it says
// that only a car sent before the pause can be booted, that nothing was
// recorded, and that the boot has to come off (brainstorm 7.3).

import { endsLocal, type ActivePause, type PauseRead } from "../_shared/pause.ts";
import { matchProperty, type PropertyPoint } from "./payments.ts";

type Named = { id: string; name: string | null };
export type Refusal = { code: "enforcement_paused"; message: string };
/** A boot dispatch (alpr_violations, action_channel boot_sms). lock_pause.ts reads status dispatched and resolved. */
export type StandingDispatch = {
  property_id: string; plate_text: string | null; dispatched_at: string | null;
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

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const pausedMessage = (name: string | null, p: ActivePause) =>
  `Enforcement is paused at ${name || "this property"} until ${endsLocal(p.ends_at)}. Only a car sent to you to boot before the pause can be booted until then.`;
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
    return d.property_id === propertyId && norm(d.plate_text) === want && Number.isFinite(sent) && sent < start && stillABoot(d, now);
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
  now?: Date;
}): Refusal | null {
  if (i.active.size === 0) return null;
  const stands = (propertyId: string, p: ActivePause) => dispatchedBeforePause(i.plate, propertyId, p, i.standing ?? [], i.now ?? new Date());
  const nameOf = (id: string) => i.myProperties.find((p) => p.id === id)?.name ?? i.points.find((p) => p.id === id)?.name ?? null;
  if (i.propertyId) {
    const p = i.active.get(i.propertyId);
    if (!p || stands(i.propertyId, p)) return null;
    return { code: "enforcement_paused", message: `${pausedMessage(nameOf(i.propertyId), p)} ${TAKE_IT_OFF}` };
  }
  const gps = finite(i.lat) && finite(i.lon) && !(i.lat === 0 && i.lon === 0);
  if (gps) {
    // Any paused property the phone is at, not only the agent's own.
    const m = matchProperty(i.lat, i.lon, i.points.filter((p) => i.active.has(p.id)));
    const p = m.at_property && m.property_id ? i.active.get(m.property_id) : undefined;
    if (!p || stands(m.property_id!, p)) return null;
    return { code: "enforcement_paused", message: `${pausedMessage(m.property, p)} ${TAKE_IT_OFF}` };
  }
  // No property and no location: if any of the agent's properties is paused,
  // the agent has to say where they are, unless the plate was sent to them to
  // boot at one of those paused properties before its pause.
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
