import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  REENTRY_MINUTES_DEFAULT, isBurstNoise, isReentry, minutesFromEnv, pickLateExitMatch,
} from "./apartment_close.ts";

const at = (s: string) => new Date(`2026-11-13T${s}:00Z`);
const v = (id: string, plate: string, entered: string) => ({ id, normalized_plate: plate, entered_at: at(entered).toISOString() });

Deno.test("late exit: VS2330 leaving at 9:29 closes the VS233 visit that came in at 9:19", () => {
  const open = [v("a", "VS233", "14:19"), v("b", "LKH24", "19:46"), v("c", "PAZ5470", "17:17")];
  assertEquals(pickLateExitMatch("VS2330", open, at("14:29"))?.visit.id, "a");
  assertEquals(pickLateExitMatch("VS2330", open, at("14:29"))?.reason, "similar");
  assertEquals(pickLateExitMatch("LKH2416", open, at("20:36"))?.visit.id, "b");
  // a plain (non-lookalike) substitution is not enough at any age: D/8 is not a measured confusion
  assertEquals(pickLateExitMatch("T85911", [v("d", "TD5911", "18:01")], at("18:09")), null);
});

Deno.test("late exit: an exact plate wins, two look-alikes close nothing, a keypad-age visit never matches", () => {
  const open = [v("a", "VS233", "14:19"), v("b", "VS2330", "14:00")];
  assertEquals(pickLateExitMatch("VS2330", open, at("14:29"))?.reason, "exact");
  const twins = [v("a", "TAK983", "21:02"), v("b", "AK983", "21:03")];
  assertEquals(pickLateExitMatch("TAK9830", twins, at("22:00")), null);
  // 60 s after entry: the front plate at the keypad, not an exit.
  assertEquals(pickLateExitMatch("VS2330", [v("a", "VS233", "14:19")], new Date(at("14:19").getTime() + 60_000)), null);
  assertEquals(pickLateExitMatch("", open, at("14:29")), null);
  assertEquals(pickLateExitMatch("ZZZ9999", open, at("14:29")), null);
});

Deno.test("burst noise: a misread tail of a car that just left closes no other visit", () => {
  const closed = [{ normalized_plate: "69610W", exited_at: at("14:04").toISOString() }];
  assertEquals(isBurstNoise("69620W", closed, at("14:06")), true);
  assertEquals(isBurstNoise("69610W", closed, at("14:06")), true);
  assertEquals(isBurstNoise("69620W", closed, at("14:30")), false);
  assertEquals(isBurstNoise("LKH2416", closed, at("14:06")), false);
  assertEquals(isBurstNoise("69620W", [{ normalized_plate: "69610W", exited_at: null }], at("14:06")), false);
});

Deno.test("re-entry: an apartment plate last seen 10 min ago or more left and came back; a plaza never", () => {
  const now = at("16:00");
  const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  assertEquals(isReentry({ propertyType: "apartment", enteredAt: ago(120), lastDetectedAt: ago(11), now, minutes: 10 }), true);
  assertEquals(isReentry({ propertyType: "apartment", enteredAt: ago(120), lastDetectedAt: ago(5), now, minutes: 10 }), false);
  assertEquals(isReentry({ propertyType: "apartment", enteredAt: ago(12), lastDetectedAt: null, now, minutes: 10 }), true);
  // a last sighting older than the entry is ignored: the entry is the last sighting
  assertEquals(isReentry({ propertyType: "apartment", enteredAt: ago(12), lastDetectedAt: ago(30), now, minutes: 10 }), true);
  assertEquals(isReentry({ propertyType: "apartment", enteredAt: ago(8), lastDetectedAt: ago(30), now, minutes: 10 }), false);
  assertEquals(isReentry({ propertyType: "truck_plaza", enteredAt: ago(120), lastDetectedAt: ago(60), now, minutes: 10 }), false);
  assertEquals(isReentry({ propertyType: null, enteredAt: ago(120), lastDetectedAt: ago(60), now, minutes: 10 }), false);
});

Deno.test("knob: APARTMENT_REENTRY_MINUTES moves the gap; junk falls back", () => {
  assertEquals(minutesFromEnv("15", REENTRY_MINUTES_DEFAULT), 15);
  assertEquals(minutesFromEnv(undefined, REENTRY_MINUTES_DEFAULT), 10);
  assertEquals(minutesFromEnv("abc", REENTRY_MINUTES_DEFAULT), 10);
  assertEquals(minutesFromEnv("-3", REENTRY_MINUTES_DEFAULT), 10);
});
