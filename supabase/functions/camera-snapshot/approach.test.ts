import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isApproaching } from "./approach.ts";

const box = (ymin: number, h: number) => ({ xmin: 600, ymin, xmax: 680, ymax: ymin + h });

Deno.test("the measured bursts: every entering car is not approaching, the leaving car is", () => {
  // entering (Δheight / Δy from approach.py): box shrinks and moves up
  for (const [dh, dy] of [[-17, -85], [-10, -96], [0, -32], [-2, -38], [-28, -184], [-15, -217], [-3, -51]]) {
    assertEquals(isApproaching(box(300, 60), box(300 + dy, 60 + dh)), false, `${dh}/${dy}`);
  }
  // the decorative front plate leaving past the entry camera: +18 px, +230 px down
  assertEquals(isApproaching(box(350, 60), box(580, 78)), true);
  // moving down a little while growing: approaching; moving down a little without growing: not enough
  assertEquals(isApproaching(box(300, 40), box(310, 52)), true);
  assertEquals(isApproaching(box(300, 40), box(330, 40)), false);
  assertEquals(isApproaching(box(300, 40), box(345, 40)), true);
});

Deno.test("missing boxes never fire", () => {
  assertEquals(isApproaching(null, box(1, 2)), false);
  assertEquals(isApproaching(box(1, 2), undefined), false);
  assertEquals(isApproaching({ xmin: 1 }, box(1, 2)), false);
});
