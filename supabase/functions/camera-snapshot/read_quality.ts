// Is this read a licence plate, and is it good enough to open a visit on its
// own? (Gabe, 2026-11-14: "make sure its airtight so we can get the right
// plate and the right read and i don't want to have it misreading names or
// words and thinking its a plate".)
//
// What the photos behind Mayfield's stray tiles showed (2026-11-14):
//  - a decorative front plate ("GOD IS") on a car driving OUT past the entry
//    camera, which opened a visit;
//  - lettering on a van ("SIGNAL") read as a plate, once, at night;
//  - real plates cut off by the edge of the frame, read as five characters
//    at full confidence;
//  - a distant car and a trailer with no plate in view, read at 0.7-0.9.
// And what the numbers showed over 14 days (1,598 agreed reads vs 42 lone
// unrepeated reads): PR's detection score (dscore) is below 0.5 on 31% of
// the lone reads and 4% of the agreed ones; eight or more candidates on
// 60% vs 8%; a five-character string on 21% vs 1%.
//
// Three grades:
//   reject     not a plate region: dscore < 0.5, a box more than 3.2× wider
//              than tall, or shorter than 20 px. Logged, never matched.
//   tentative  a plate, but the string may be wrong: cut by the frame edge,
//              not a plate format we see at our properties, eight or more
//              candidates, or a score under the opening floor. May join an
//              open visit; opens a new visit only with a second agreeing read.
//   solid      opens a visit on its own.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sameVehicle } from "./plate_identity.ts";

export type Box = { xmin?: number; ymin?: number; xmax?: number; ymax?: number } | null | undefined;

export type ReadSignals = {
  plate: string;            // normalized
  score: number;
  dscore?: number | null;
  box?: Box;
  imageWidth?: number | null;
  imageHeight?: number | null;
  candidateCount?: number | null;
};

export type QualityConfig = {
  dscoreMin: number;
  aspectMax: number;
  boxHeightMin: number;
  edgePx: number;
  candidatesMax: number;
  openScore: number;
  agreeSeconds: number;
  agreeScore: number;
};

export const QUALITY_DEFAULTS: QualityConfig = {
  dscoreMin: 0.5,
  aspectMax: 3.2,
  boxHeightMin: 20,
  edgePx: 4,
  candidatesMax: 8,
  openScore: 0.8,
  agreeSeconds: 120,
  agreeScore: 0.9,
};

export function qualityFromEnv(raw: string | undefined | null): QualityConfig {
  if (!raw) return QUALITY_DEFAULTS;
  try {
    const o = JSON.parse(raw) as Partial<QualityConfig>;
    const out = { ...QUALITY_DEFAULTS };
    for (const k of Object.keys(QUALITY_DEFAULTS) as Array<keyof QualityConfig>) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return QUALITY_DEFAULTS;
  }
}

// Plate formats seen 20 or more times at full confidence at our apartments
// (A = letter, 9 = digit): NC/SC passenger, NC commercial, older NC, and
// two dealer/temporary shapes.
export const KNOWN_FORMATS = new Set(["AAA9999", "99999A", "AA9999", "AAA999", "AA99AA", "9AA999"]);

export function plateFormat(plate: string): string {
  return plate.replace(/[A-Z]/g, "A").replace(/\d/g, "9");
}

export function isKnownFormat(plate: string): boolean {
  return KNOWN_FORMATS.has(plateFormat(plate));
}

export type Grade = "solid" | "tentative" | "reject";
export type Assessment = { grade: Grade; reasons: string[]; edgeCut: boolean; format: string };

export function assessRead(s: ReadSignals, cfg: QualityConfig = QUALITY_DEFAULTS): Assessment {
  const reasons: string[] = [];
  const format = plateFormat(s.plate);
  const b = s.box ?? {};
  const w = (b.xmax ?? 0) - (b.xmin ?? 0);
  const h = (b.ymax ?? 0) - (b.ymin ?? 0);
  const hasBox = w > 0 && h > 0;

  if (typeof s.dscore === "number" && s.dscore < cfg.dscoreMin) reasons.push(`dscore ${s.dscore.toFixed(2)} < ${cfg.dscoreMin}`);
  if (hasBox && w / h > cfg.aspectMax) reasons.push(`box ${w}×${h} too wide for a plate`);
  if (hasBox && h < cfg.boxHeightMin) reasons.push(`box ${h} px tall`);
  if (reasons.length > 0) return { grade: "reject", reasons, edgeCut: false, format };

  let edgeCut = false;
  if (hasBox && typeof s.imageWidth === "number" && s.imageWidth > 0) {
    if ((b.xmin ?? 0) <= cfg.edgePx || (b.xmax ?? 0) >= s.imageWidth - cfg.edgePx) edgeCut = true;
  }
  if (hasBox && typeof s.imageHeight === "number" && s.imageHeight > 0) {
    if ((b.ymin ?? 0) <= cfg.edgePx || (b.ymax ?? 0) >= s.imageHeight - cfg.edgePx) edgeCut = true;
  }
  if (edgeCut) reasons.push("plate cut by the frame edge");
  if (!isKnownFormat(s.plate)) reasons.push(`format ${format} not seen at our properties`);
  if (typeof s.candidateCount === "number" && s.candidateCount >= cfg.candidatesMax) reasons.push(`${s.candidateCount} candidates`);
  if (s.score < cfg.openScore) reasons.push(`score ${s.score.toFixed(2)} < ${cfg.openScore}`);
  return { grade: reasons.length > 0 ? "tentative" : "solid", reasons, edgeCut, format };
}

/** A second read of the same car on this camera in the last window, scored
 *  at or above agreeScore: a tentative read then opens a visit. */
export async function recentAgreeingRead(
  db: SupabaseClient, cameraId: string, normalized: string, now: Date, cfg: QualityConfig = QUALITY_DEFAULTS,
): Promise<{ plate: string; confidence: number } | null> {
  const since = new Date(now.getTime() - cfg.agreeSeconds * 1000).toISOString();
  const r = await db.from("plate_events")
    .select("normalized_plate,confidence,inh:raw_data->>_inherited_from_session")
    .eq("camera_id", cameraId)
    .gte("created_at", since)
    .gte("confidence", cfg.agreeScore)
    .not("normalized_plate", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (r.error) throw r.error;
  for (const e of (r.data ?? []) as Array<{ normalized_plate: string | null; confidence: number | null; inh: string | null }>) {
    if (!e.normalized_plate || e.inh) continue;
    if (sameVehicle(e.normalized_plate, normalized, { kind: "burst" }).same) return { plate: e.normalized_plate, confidence: e.confidence ?? 0 };
  }
  return null;
}
