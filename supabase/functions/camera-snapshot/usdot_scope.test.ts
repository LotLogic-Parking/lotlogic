import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { usdotFallbackApplies } from "./usdot-ocr.ts";

Deno.test("usdotFallbackApplies: never at apartments (cars carry no USDOT number)", () => {
  assertEquals(usdotFallbackApplies("apartment"), false);
});

Deno.test("usdotFallbackApplies: other property types keep the fallback", () => {
  assertEquals(usdotFallbackApplies("truck_plaza"), true);
  assertEquals(usdotFallbackApplies(null), true);
});
