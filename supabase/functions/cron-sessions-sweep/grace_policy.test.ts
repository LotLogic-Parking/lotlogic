import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { APARTMENT_GRACE_STALE_HOURS_DEFAULT, graceDecision } from "./grace_policy.ts";

const now = new Date("2026-11-12T17:00:00Z");
const min = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();

Deno.test("truck plaza: a grace visit is thrown away at the expiry minute, kept before it", () => {
  assertEquals(graceDecision({ propertyType: "truck_plaza", enteredAt: min(16), lastDetectedAt: min(1), now, expiryMinutes: 15 }), "close");
  assertEquals(graceDecision({ propertyType: "truck_plaza", enteredAt: min(14), lastDetectedAt: null, now, expiryMinutes: 15 }), "keep");
  assertEquals(graceDecision({ propertyType: null, enteredAt: min(16), lastDetectedAt: null, now, expiryMinutes: 15 }), "close");
});

Deno.test("apartment: a grace visit stays open past the expiry minute (Gabe, 2026-11-12: keep it on screen, red)", () => {
  assertEquals(graceDecision({ propertyType: "apartment", enteredAt: min(16), lastDetectedAt: min(16), now, expiryMinutes: 15 }), "keep");
  assertEquals(graceDecision({ propertyType: "apartment", enteredAt: min(600), lastDetectedAt: min(600), now, expiryMinutes: 15 }), "keep");
});

Deno.test("apartment: closed only once nobody has seen it for the stale window", () => {
  assertEquals(APARTMENT_GRACE_STALE_HOURS_DEFAULT, 24);
  assertEquals(graceDecision({ propertyType: "apartment", enteredAt: min(25 * 60), lastDetectedAt: min(25 * 60), now, expiryMinutes: 15 }), "close");
  assertEquals(graceDecision({ propertyType: "apartment", enteredAt: min(25 * 60), lastDetectedAt: min(5), now, expiryMinutes: 15 }), "keep");
  assertEquals(graceDecision({ propertyType: "apartment", enteredAt: min(25 * 60), lastDetectedAt: null, now, expiryMinutes: 15, staleHours: 30 }), "keep");
  assertEquals(graceDecision({ propertyType: "apartment", enteredAt: "junk", lastDetectedAt: null, now, expiryMinutes: 15 }), "keep");
});
