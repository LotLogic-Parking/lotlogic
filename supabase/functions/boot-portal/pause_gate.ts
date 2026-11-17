// No boot at a property whose enforcement is paused (spec 2026-11-16 Part 3,
// plan Task 10). Pure half: index.ts lock() reads the pauses and the points.
//
// The check sits after lock() has resolved and access-checked the property,
// because the property is optional there (picked, or matched from GPS, or
// neither). It applies to every company's boots, not only LotLogic's: the
// manager paused the property and the tow company has been told.

import { endsLocal, type ActivePause, type PauseRead } from "../_shared/pause.ts";
import { matchProperty, type PropertyPoint } from "./payments.ts";

type Named = { id: string; name: string | null };
export type Refusal = { code: "enforcement_paused"; message: string };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const pausedMessage = (name: string | null, p: ActivePause) =>
  `Enforcement is paused at ${name || "this property"} until ${endsLocal(p.ends_at)}.`;

export function lockPauseRefusal(i: {
  propertyId: string | null;
  myProperties: Named[];
  lat: number | null;
  lon: number | null;
  active: Map<string, ActivePause>;
  points: PropertyPoint[];
}): Refusal | null {
  if (i.active.size === 0) return null;
  const nameOf = (id: string) => i.myProperties.find((p) => p.id === id)?.name ?? i.points.find((p) => p.id === id)?.name ?? null;
  if (i.propertyId) {
    const p = i.active.get(i.propertyId);
    return p ? { code: "enforcement_paused", message: pausedMessage(nameOf(i.propertyId), p) } : null;
  }
  const gps = finite(i.lat) && finite(i.lon) && !(i.lat === 0 && i.lon === 0);
  if (gps) {
    // Any paused property the phone is at, not only the agent's own.
    const m = matchProperty(i.lat, i.lon, i.points.filter((p) => i.active.has(p.id)));
    const p = m.at_property && m.property_id ? i.active.get(m.property_id) : undefined;
    return p ? { code: "enforcement_paused", message: pausedMessage(m.property, p) } : null;
  }
  // No property and no location: if any of the agent's properties is paused,
  // the agent has to say where they are.
  const mine = i.myProperties.find((p) => i.active.has(p.id));
  if (!mine) return null;
  return { code: "enforcement_paused", message: `${pausedMessage(mine.name, i.active.get(mine.id)!)} Pick the property you are booting at.` };
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
