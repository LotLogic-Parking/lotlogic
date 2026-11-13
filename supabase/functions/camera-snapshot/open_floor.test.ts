import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mayOpenVisit, openFloorFromEnv, PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT } from "./open_floor.ts";

Deno.test("apartment: the Amazon-van reads (0.742, 0.684, 0.677) cannot open a visit; real reads can", () => {
  const floor = openFloorFromEnv(undefined);
  assertEquals(floor, PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT);
  for (const score of [0.742, 0.684, 0.677]) {
    assertEquals(mayOpenVisit({ propertyType: "apartment", score, floor }), false);
  }
  for (const score of [0.80, 0.906, 0.944, 1]) {
    assertEquals(mayOpenVisit({ propertyType: "apartment", score, floor }), true);
  }
  assertEquals(mayOpenVisit({ propertyType: "apartment", score: null, floor }), false);
});

Deno.test("truck plaza and unknown property types are unchanged", () => {
  const floor = openFloorFromEnv(undefined);
  assertEquals(mayOpenVisit({ propertyType: "truck_plaza", score: 0.5, floor }), true);
  assertEquals(mayOpenVisit({ propertyType: null, score: 0.5, floor }), true);
});

Deno.test("PR_MIN_OPEN_SCORE_APARTMENT moves the floor; junk values fall back to the default", () => {
  assertEquals(openFloorFromEnv("0.72"), 0.72);
  assertEquals(mayOpenVisit({ propertyType: "apartment", score: 0.742, floor: openFloorFromEnv("0.72") }), true);
  assertEquals(openFloorFromEnv("abc"), PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT);
  assertEquals(openFloorFromEnv("1.5"), PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT);
  assertEquals(openFloorFromEnv(""), PR_MIN_OPEN_SCORE_APARTMENT_DEFAULT);
});
