import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assessRead, isKnownFormat, plateFormat, qualityFromEnv, QUALITY_DEFAULTS } from "./read_quality.ts";
import { candidatePlates, sameVehicle } from "./plate_identity.ts";

const W = 1280, HGT = 960;
const box = (xmin: number, ymin: number, w: number, h: number) => ({ xmin, ymin, xmax: xmin + w, ymax: ymin + h });

Deno.test("the stray tiles from Mayfield's screen, graded from their own PR signals", () => {
  // a distant car with no plate in view: dscore 0.125, box 107×27
  assertEquals(assessRead({ plate: "0WCC0A", score: 0.728, dscore: 0.125, box: box(500, 60, 107, 27), imageWidth: W, imageHeight: HGT, candidateCount: 4 }).grade, "reject");
  // a trailer, no plate: dscore 0.17
  assertEquals(assessRead({ plate: "LL444", score: 0.881, dscore: 0.17, box: box(600, 70, 94, 50), imageWidth: W, imageHeight: HGT, candidateCount: 2 }).grade, "reject");
  // lettering on a van at night: good dscore, unknown format, six candidates
  const sig = assessRead({ plate: "SIGNA1", score: 0.83, dscore: 0.848, box: box(1100, 200, 90, 72), imageWidth: W, imageHeight: HGT, candidateCount: 6 });
  assertEquals(sig.grade, "tentative");
  // a decorative front plate: solid dscore, unknown format
  assertEquals(assessRead({ plate: "GOD1S", score: 0.924, dscore: 0.89, box: box(780, 180, 66, 44), imageWidth: W, imageHeight: HGT, candidateCount: 4 }).grade, "tentative");
  // a real plate cut off by the right edge of the frame
  const cut = assessRead({ plate: "HFZ35", score: 0.998, dscore: 0.821, box: box(1226, 100, 54, 53), imageWidth: W, imageHeight: HGT, candidateCount: 1 });
  assertEquals(cut.grade, "tentative"); assertEquals(cut.edgeCut, true);
  // an ordinary NC plate, well inside the frame
  assertEquals(assessRead({ plate: "LKL3974", score: 0.998, dscore: 0.86, box: box(600, 300, 70, 40), imageWidth: W, imageHeight: HGT, candidateCount: 2 }).grade, "solid");
  // a fleet van plate
  assertEquals(assessRead({ plate: "69665W", score: 1, dscore: 0.9, box: box(600, 300, 70, 40), imageWidth: W, imageHeight: HGT, candidateCount: 1 }).grade, "solid");
  // a good plate under the opening floor
  assertEquals(assessRead({ plate: "LKL3974", score: 0.74, dscore: 0.86, box: box(600, 300, 70, 40), imageWidth: W, imageHeight: HGT, candidateCount: 2 }).grade, "tentative");
  // no box or dscore at all (older rows, onboard readers): format and score decide
  assertEquals(assessRead({ plate: "LKL3974", score: 0.95 }).grade, "solid");
  assertEquals(assessRead({ plate: "GOD1S", score: 0.95 }).grade, "tentative");
});

Deno.test("formats", () => {
  assertEquals(plateFormat("LKL3974"), "AAA9999");
  assertEquals(isKnownFormat("69665W"), true);
  assertEquals(isKnownFormat("GOD1S"), false);
  assertEquals(isKnownFormat("SIGNA1"), false);
  assertEquals(isKnownFormat("JS56AV"), true);
});

Deno.test("candidates: PR's own alternative makes the read the same car", () => {
  const result = { plate: "swl414", candidates: [{ plate: "swl414", score: 0.9 }, { plate: "svl414", score: 0.84 }, { plate: "svl4i4", score: 0.7 }] };
  assertEquals(candidatePlates(result, "SWL414"), ["SVL414", "SVL4I4"]);
  assertEquals(candidatePlates({}, "X"), []);
  const v = sameVehicle("TD5911", "MTB5911", { kind: "visit", candidates: ["MTB5911"] });
  assertEquals(v.same, true); assertEquals(v.cost, 0.3);
  // the digit guard still holds even when PR offered the other digit
  assertEquals(sameVehicle("69664W", "69665W", { kind: "visit", scoreA: 1, scoreB: 1, candidates: ["69665W"] }).same, false);
  assertEquals(sameVehicle("VK5131", "VK5137", { kind: "registered", candidates: ["VK5137"] }).why.startsWith("PR candidate"), true);
});

Deno.test("knob", () => {
  assertEquals(qualityFromEnv('{"dscoreMin": 0.4}').dscoreMin, 0.4);
  assertEquals(qualityFromEnv("junk"), QUALITY_DEFAULTS);
});
