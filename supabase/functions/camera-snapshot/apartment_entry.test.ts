import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { likeSimilar, pickOlderTwin, pickOpenVisitForRead, twinSimilar } from "./apartment_entry.ts";

const at = (s: string) => new Date(`2026-11-14T${s}:00Z`);
const v = (id: string, plate: string, entered: string, state = "grace") =>
  ({ id, normalized_plate: plate, state: state as "grace", entered_at: at(entered).toISOString() });

Deno.test("twin: the pairs from Mayfield's screen are twins; two real cars are not", () => {
  for (const [a, b] of [["TAK983", "AK983"], ["LKL39", "LKL3974"], ["JHN6706", "JHV6706"], ["TMH5263", "IMH5269"], ["TD5911", "MTB5911"], ["M6CNC90V", "MCKNC90V"]]) {
    assertEquals(twinSimilar(a, b), true, `${a} ~ ${b}`);
  }
  assertEquals(twinSimilar("HJT9308", "0J15300"), false);
  assertEquals(twinSimilar("ABC1234", "XYZ9876"), false);
  assertEquals(twinSimilar("", "AK983"), false);
});

Deno.test("like: a truncation hours later is the same car; two edits are not", () => {
  assertEquals(likeSimilar("SVL41", "SVL414"), true);
  assertEquals(likeSimilar("VS233", "VS2330"), true);
  assertEquals(likeSimilar("TMH5263", "IMH5269"), false);
});

Deno.test("pick: a twin inside the window wins, the earliest of several; a single like visit of any age; registered visits never", () => {
  const now = at("21:03");
  const open = [v("a", "TAK983", "21:02"), v("b", "SVL41", "04:02"), v("r", "AK9830", "21:02", "resident")];
  assertEquals(pickOpenVisitForRead("AK983", open, now)?.visit.id, "a");
  assertEquals(pickOpenVisitForRead("AK983", open, now)?.how, "twin");
  assertEquals(pickOpenVisitForRead("SVL414", open, now)?.visit.id, "b");
  assertEquals(pickOpenVisitForRead("SVL414", open, now)?.how, "like");
  assertEquals(pickOpenVisitForRead("TAK983", open, now), null); // exact: not this path
  assertEquals(pickOpenVisitForRead("ZZZ9999", open, now), null);
  // two like visits of any age: ambiguous
  assertEquals(pickOpenVisitForRead("SVL414", [v("b", "SVL41", "04:02"), v("c", "SVL4140", "05:00")], now), null);
  // a twin 10 minutes old is outside the window; it is then a like visit
  assertEquals(pickOpenVisitForRead("AK983", [v("a", "TAK983", "20:50")], now)?.how, "like");
});

Deno.test("older twin: the visit that opened first keeps the car; the first by id on a tie", () => {
  const open = [v("a", "TAK983", "21:02"), v("b", "AK983", "21:03")];
  assertEquals(pickOlderTwin({ id: "b", normalized_plate: "AK983", entered_at: at("21:03").toISOString() }, open)?.id, "a");
  assertEquals(pickOlderTwin({ id: "a", normalized_plate: "TAK983", entered_at: at("21:02").toISOString() }, open), null);
  const same = [v("x", "JHN6706", "10:38"), v("y", "JHV6706", "10:38")];
  assertEquals(pickOlderTwin({ id: "y", normalized_plate: "JHV6706", entered_at: at("10:38").toISOString() }, same)?.id, "x");
  assertEquals(pickOlderTwin({ id: "x", normalized_plate: "JHN6706", entered_at: at("10:38").toISOString() }, same), null);
});
