import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_CONFIG, configFromEnv, consensusPlate, digitsOnlyDiffer, isTruncationOf, plateDistance, sameVehicle } from "./plate_identity.ts";

// Every pair below is from Mayfield or Charlotte production reads.

const SAME_IN_BURST: Array<[string, string]> = [
  ["TAK983", "AK983"], ["LKL39", "LKL3974"], ["JHN6706", "JHV6706"], ["TMH5263", "IMH5269"], ["TD5911", "MTB5911"],
  ["M6CNC90V", "MCKNC90V"], ["ZT4946", "2T4946"], ["LMJ7223", "LMJ7273"], ["VL8397", "VL0397"], ["RES7682", "RES7602"],
  ["KMH3028", "KMH3020"], ["3NB144", "3N8144"], ["69605W", "69605N"], ["JS56AY", "JS56AV"], ["JS56AV", "JS56DV"],
  ["SVL414", "SWL414"], ["LEE3684", "LEF3684"], ["VS233", "VS2330"], ["PAZ5470", "PIZ5470"], ["PAZ5470", "AZ5470"],
  ["KDB1018", "KDU1018"], ["LKH2416", "LKM2416"], ["PDN2053", "PUN2053"],
];
const TWO_CARS_IN_BURST: Array<[string, string]> = [
  ["HJT9308", "0J15300"], ["HTMH52", "TMH5269"], ["ABC1234", "XYZ9876"], ["LCA4836", "113Z0D"],
];
// Different vehicles seen hours or days apart, all read at full confidence.
const TWO_CARS_ANY_AGE: Array<[string, string]> = [
  ["69664W", "69665W"], ["69610W", "69614W"], ["69665W", "69605W"], ["JJW378", "XCW378"], ["LHV8988", "LHV8986"],
];
// The same car, hours apart, read a little differently.
const SAME_ANY_AGE: Array<[string, string]> = [
  ["SVL41", "SVL414"], ["VS233", "VS2330"], ["LKH24", "LKH2416"], ["LEE3684", "LEF3684"],
];

Deno.test("burst: every one-car pair from the office screen is the same vehicle; every two-car burst is not", () => {
  for (const [a, b] of SAME_IN_BURST) assert(sameVehicle(a, b, { kind: "burst" }).same, `${a} ~ ${b} should be one car (cost ${plateDistance(a, b)})`);
  for (const [a, b] of TWO_CARS_IN_BURST) assert(!sameVehicle(a, b, { kind: "burst" }).same, `${a} / ${b} should be two cars (cost ${plateDistance(a, b)})`);
});

Deno.test("visit (any age): fleet neighbours and other real pairs stay apart; truncations and lookalikes join", () => {
  for (const [a, b] of TWO_CARS_ANY_AGE) assert(!sameVehicle(a, b, { kind: "visit", scoreA: 1, scoreB: 1 }).same, `${a} / ${b} should stay apart (cost ${plateDistance(a, b)})`);
  for (const [a, b] of SAME_ANY_AGE) assert(sameVehicle(a, b, { kind: "visit", scoreA: 0.99, scoreB: 0.9 }).same, `${a} ~ ${b} should join (cost ${plateDistance(a, b)})`);
  // the digit guard: two confident reads that disagree on a confusable digit are two plates;
  // the same strings with one weak read are one plate
  assertEquals(sameVehicle("KMH3028", "KMH3020", { kind: "visit", scoreA: 1, scoreB: 0.99 }).same, false);
  assertEquals(sameVehicle("KMH3028", "KMH3020", { kind: "visit", scoreA: 1, scoreB: 0.88 }).same, true);
  assertEquals(digitsOnlyDiffer("KMH3028", "KMH3020"), true);
  assertEquals(digitsOnlyDiffer("LEE3684", "LEF3684"), false);
});

Deno.test("registered: one plain edit or two lookalikes against a typed plate, never on short plates", () => {
  assertEquals(sameVehicle("MBD8497", "WBD3427", { kind: "registered" }).same, false); // the Charlotte false close
  assertEquals(sameVehicle("2R028", "24023", { kind: "registered" }).same, false);
  assertEquals(sameVehicle("VK5131", "VK5137", { kind: "registered" }).same, true);
  assertEquals(sameVehicle("VK5131", "VK513", { kind: "registered" }).same, false);
  assertEquals(sameVehicle("DC41892", "DC41B92", { kind: "registered" }).same, true);
});

Deno.test("distance: costs are what the comments say", () => {
  assertEquals(plateDistance("LEE3684", "LEF3684"), 0.5);     // one lookalike
  assertEquals(plateDistance("69664W", "69665W"), 1);         // one plain digit
  assertEquals(plateDistance("SVL41", "SVL414"), 0.3);        // one char off the end
  assertEquals(plateDistance("LKL39", "LKL3974"), 0.6);       // two off the end
  assertEquals(plateDistance("AK983", "TAK983"), 0.3);        // one off the front
  assertEquals(plateDistance("TD5911", "MTB5911"), 1.3);      // one off the front + one plain
  assertEquals(plateDistance("", "A"), Infinity);
  assertEquals(isTruncationOf("SVL41", "SVL414"), true);
  assertEquals(isTruncationOf("VL414", "SVL414"), true);
  assertEquals(isTruncationOf("SV414", "SVL414"), false);
});

Deno.test("consensus: the visit carries the most-supported full plate, never a truncation; confirmed after two agreeing reads", () => {
  const c = consensusPlate([{ plate: "AK983", score: 1 }, { plate: "TAK983", score: 1 }, { plate: "TAK983", score: 0.97 }]);
  assertEquals(c?.plate, "TAK983"); assertEquals(c?.confirmed, true);
  const t = consensusPlate([{ plate: "LKL39", score: 0.998 }, { plate: "LKL3974", score: 0.95 }]);
  assertEquals(t?.plate, "LKL3974"); assertEquals(t?.confirmed, false);
  const w = consensusPlate([{ plate: "LEF3684", score: 1 }, { plate: "LEF3684", score: 1 }, { plate: "LEE3684", score: 1 }]);
  assertEquals(w?.plate, "LEF3684"); assertEquals(w?.support, 2);
  const g = consensusPlate([{ plate: "HJT9308", score: 0.997 }, { plate: "0J15300", score: 0.751 }]);
  assertEquals(g?.plate, "HJT9308"); assertEquals(g?.members.length, 1);
  assertEquals(consensusPlate([]), null);
  const one = consensusPlate([{ plate: "SVL41", score: 0.986 }]);
  assertEquals(one?.confirmed, false);
});

Deno.test("config: PLATE_IDENTITY_CONFIG overrides numbers and ignores junk", () => {
  assertEquals(configFromEnv(undefined), DEFAULT_CONFIG);
  assertEquals(configFromEnv('{"visitMax": 0.9, "burstMax": "x"}').visitMax, 0.9);
  assertEquals(configFromEnv('{"visitMax": 0.9}').burstMax, 2.0);
  assertEquals(configFromEnv("not json"), DEFAULT_CONFIG);
});
