// One formula for "are these two plate reads the same vehicle?"
//
// Measured on 14 days of Mayfield and Charlotte reads (2026-11-14, see
// docs/superpowers/specs/2026-11-14-plate-identity-formula.md):
//  - Plate Recognizer disagrees with itself inside a third of gate passes.
//    The commonest error is a dropped edge character at full confidence
//    (403 of 1,220 reads at 0.95+ were six characters, mostly a
//    seven-character plate missing its first or last character).
//  - Score is a weak truth signal: inside a burst a read at 0.90-0.95 agrees
//    with the other frames only half the time; at 0.95+, 86%.
//  - The confusions PR actually makes are mostly digit for digit (8/0, 4/9,
//    8/9, 3/8, 2/4, 5/6), not the letter-for-digit lookalikes the old
//    table was built on.
//  - Inside a two-minute window on one camera every pair of plates one or
//    two edits apart was one car; every pair four or more apart was two
//    cars; nothing fell between.
//  - Across hours, one-edit neighbours are real different vehicles (a
//    fleet of vans with sequential plates), so any-age matching must be
//    much tighter than burst matching.
//
// The formula: a weighted edit distance where a confusable substitution
// costs 0.5, any other substitution 1.0, a dropped or added character at
// either end 0.3 each (truncation), and an interior insertion or deletion
// 1.0. The threshold depends on what is being compared:
//   burst       ≤ 2.0   two reads of one gate pass (≤ 120 s apart)
//   visit       ≤ 0.6   a read against an open visit's plate, any age
//   registered  ≤ 1.0   a read against a plate a person typed (pass,
//                       resident, tow list), both at least 6 characters
// Plus one guard for the visit case: when the only differences are digits
// and both reads scored 0.95 or better, they are two plates.
//
// A visit's plate is the consensus of its reads, not the first read: the
// string with the most reads at 0.9+, never a truncation of a longer read
// in the same cluster. A visit is "confirmed" once two reads at 0.9+ agree.

export type CompareKind = "burst" | "visit" | "registered";

export type IdentityConfig = {
  burstSeconds: number;
  burstMax: number;
  visitMax: number;
  registeredMax: number;
  registeredMinLen: number;
  confusableCost: number;
  edgeCost: number;
  maxEdgeDrop: number;
  digitGuardScore: number;
};

export const DEFAULT_CONFIG: IdentityConfig = {
  burstSeconds: 120,
  burstMax: 2.0,
  visitMax: 0.6,
  registeredMax: 1.0,
  registeredMinLen: 6,
  confusableCost: 0.5,
  edgeCost: 0.3,
  maxEdgeDrop: 3,
  digitGuardScore: 0.95,
};

/** Optional override from PLATE_IDENTITY_CONFIG (JSON with any subset of keys). */
export function configFromEnv(raw: string | undefined | null): IdentityConfig {
  if (!raw) return DEFAULT_CONFIG;
  try {
    const o = JSON.parse(raw) as Partial<IdentityConfig>;
    const out = { ...DEFAULT_CONFIG };
    for (const k of Object.keys(DEFAULT_CONFIG) as Array<keyof IdentityConfig>) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return DEFAULT_CONFIG;
  }
}

// Confusable pairs: the hand-written lookalike table (kept) plus every pair
// seen at least three times inside one burst at Mayfield in the 14 days to
// 2026-11-14, where the burst's consensus read one character and a frame
// read the other.
const CONFUSABLE_PAIRS: Array<[string, string]> = [
  // lookalikes (existing table)
  ["O", "0"], ["D", "0"], ["Q", "0"], ["I", "1"], ["L", "1"], ["Z", "2"], ["S", "5"], ["G", "6"],
  ["T", "7"], ["Y", "7"], ["B", "8"], ["G", "9"], ["Q", "9"], ["I", "L"], ["D", "Q"], ["T", "Y"],
  ["U", "V"], ["M", "N"], ["M", "W"], ["B", "R"], ["F", "P"], ["C", "G"], ["O", "Q"], ["E", "F"],
  // measured at Mayfield (count in a burst): 8/0 14, 4/9 10, 8/9 8, M/L 6, 3/8 6, 2/4 6, H/N 6,
  // 5/6 5, C/M 5, 0/4 5, 6/3 5, C/X 4, 0/3 4, O/D 4, L/P 4, 1/5 4, Z/X 3, C/K 3, 0/1 3, K/9 3,
  // S/6 3; plus the mined 4/6.
  ["8", "0"], ["4", "9"], ["8", "9"], ["M", "L"], ["3", "8"], ["2", "4"], ["H", "N"], ["5", "6"],
  ["C", "M"], ["0", "4"], ["6", "3"], ["C", "X"], ["0", "3"], ["O", "D"], ["L", "P"], ["1", "5"],
  ["Z", "X"], ["C", "K"], ["0", "1"], ["K", "9"], ["S", "6"], ["4", "6"],
  // Charlotte (onboard + PR): 5/9, 8/6, 1/A, 8/2, 7/0, 1/7
  ["5", "9"], ["8", "6"], ["1", "A"], ["8", "2"], ["7", "0"], ["1", "7"],
];
const CONFUSABLE = new Set(CONFUSABLE_PAIRS.map(([a, b]) => [a, b].sort().join("")));

export function confusable(a: string, b: string): boolean {
  return a === b || CONFUSABLE.has([a, b].sort().join(""));
}

const isDigit = (c: string) => c >= "0" && c <= "9";

function hamming(a: string, b: string, cfg: IdentityConfig): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) c += confusable(a[i], b[i]) ? cfg.confusableCost : 1;
  return c;
}

function weightedLevenshtein(a: string, b: string, cfg: IdentityConfig): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : confusable(a[i - 1], b[j - 1]) ? cfg.confusableCost : 1);
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, sub));
    }
    prev = cur;
  }
  return prev[n];
}

/** The weighted edit distance between two normalized plates. */
export function plateDistance(a: string, b: string, cfg: IdentityConfig = DEFAULT_CONFIG): number {
  if (a === b) return 0;
  if (!a || !b) return Infinity;
  let best = weightedLevenshtein(a, b, cfg);
  // Truncation: drop d characters off the ends of the longer string, in any
  // prefix/suffix split, then compare position by position.
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const d = l.length - s.length;
  if (d > 0 && d <= cfg.maxEdgeDrop) {
    for (let p = 0; p <= d; p++) {
      const core = l.slice(p, l.length - (d - p));
      best = Math.min(best, d * cfg.edgeCost + hamming(core, s, cfg));
    }
  }
  return best;
}

/** True when a and b have the same length and differ only in digit positions. */
export function digitsOnlyDiffer(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(isDigit(a[i]) && isDigit(b[i]))) return false;
  }
  return true;
}

export type Compare = {
  kind: CompareKind;
  /** scores of the two reads, when known (visit guard) */
  scoreA?: number | null;
  scoreB?: number | null;
};

export type Verdict = { same: boolean; cost: number; why: string };

/** The formula. a and b are normalized plates. */
export function sameVehicle(a: string, b: string, cmp: Compare, cfg: IdentityConfig = DEFAULT_CONFIG): Verdict {
  if (!a || !b) return { same: false, cost: Infinity, why: "empty" };
  if (a === b) return { same: true, cost: 0, why: "exact" };
  const cost = plateDistance(a, b, cfg);
  switch (cmp.kind) {
    case "burst":
      return { same: cost <= cfg.burstMax, cost, why: `burst ${cost.toFixed(1)} ${cost <= cfg.burstMax ? "≤" : ">"} ${cfg.burstMax}` };
    case "visit": {
      if (cost > cfg.visitMax) return { same: false, cost, why: `visit ${cost.toFixed(1)} > ${cfg.visitMax}` };
      const sa = cmp.scoreA ?? 0, sb = cmp.scoreB ?? 0;
      if (digitsOnlyDiffer(a, b) && sa >= cfg.digitGuardScore && sb >= cfg.digitGuardScore) {
        return { same: false, cost, why: "two confident reads disagree on a digit" };
      }
      return { same: true, cost, why: `visit ${cost.toFixed(1)} ≤ ${cfg.visitMax}` };
    }
    case "registered": {
      if (Math.min(a.length, b.length) < cfg.registeredMinLen) return { same: false, cost, why: "too short to fuzzy-match a registration" };
      return { same: cost <= cfg.registeredMax, cost, why: `registered ${cost.toFixed(1)} ${cost <= cfg.registeredMax ? "≤" : ">"} ${cfg.registeredMax}` };
    }
  }
}

/** Is `short` a prefix or suffix truncation of `long` (1..maxEdgeDrop chars dropped)? */
export function isTruncationOf(short: string, long: string, cfg: IdentityConfig = DEFAULT_CONFIG): boolean {
  const d = long.length - short.length;
  return d >= 1 && d <= cfg.maxEdgeDrop && (long.startsWith(short) || long.endsWith(short));
}

export type ReadLite = { plate: string; score: number | null | undefined };
export type Consensus = { plate: string; support: number; confirmed: boolean; members: string[] };

/** The plate a visit should carry, given every read attributed to it. */
export function consensusPlate(reads: ReadLite[], cfg: IdentityConfig = DEFAULT_CONFIG): Consensus | null {
  const rs = reads.filter((r) => r.plate).map((r) => ({ plate: r.plate, score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0 }));
  if (rs.length === 0) return null;
  // anchor: the best-scoring read, longer on ties
  const anchor = rs.reduce((x, y) => (y.score > x.score || (y.score === x.score && y.plate.length > x.plate.length) ? y : x));
  const members = rs.filter((r) => plateDistance(anchor.plate, r.plate, cfg) <= cfg.burstMax);
  const byPlate = new Map<string, { support: number; sum: number; n: number }>();
  for (const r of members) {
    const b = byPlate.get(r.plate) ?? { support: 0, sum: 0, n: 0 };
    b.n++; b.sum += r.score; if (r.score >= 0.9) b.support++;
    byPlate.set(r.plate, b);
  }
  const plates = [...byPlate.keys()];
  const truncated = (p: string) => plates.some((o) => o !== p && isTruncationOf(p, o, cfg));
  const ranked = plates.sort((p, q) => {
    const tp = truncated(p) ? 1 : 0, tq = truncated(q) ? 1 : 0;
    if (tp !== tq) return tp - tq;
    const bp = byPlate.get(p)!, bq = byPlate.get(q)!;
    if (bq.support !== bp.support) return bq.support - bp.support;
    if (bq.sum !== bp.sum) return bq.sum - bp.sum;
    return q.length - p.length;
  });
  const win = ranked[0];
  const b = byPlate.get(win)!;
  return { plate: win, support: b.support, confirmed: b.support >= 2 && !truncated(win), members: plates };
}
