import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deploymentIdFromNote, haversineM, joinSquare, matchProperty, placementPoint, squareDashboardUrl, squareFeeCents } from "./payments.ts";

// Property points as stored in production on 2026-11-15.
const PROPS = [
  { id: "mayfield", name: "Mayfield Memorial Apartments", lat: 35.282624, lng: -80.811167 },
  { id: "1825", name: "The Villas at 1825", lat: 34.977589, lng: -80.997895 },
  { id: "riverview", name: "The Villas at Riverview", lat: 34.978935, lng: -80.994601 },
  { id: "plaza", name: "Charlotte Travel Plaza", lat: 35.307668, lng: -80.850471 },
  { id: "nogeo", name: "No coordinates", lat: null, lng: null },
];

Deno.test("haversineM: about 111 km per degree of latitude", () => {
  const d = haversineM(35, -80.8, 36, -80.8);
  assertEquals(Math.round(d / 1000), 111);
});

Deno.test("matchProperty: a boot placed in Mayfield's lot is at Mayfield", () => {
  const m = matchProperty(35.2831, -80.8105, PROPS);
  assertEquals(m.at_property, true);
  assertEquals(m.property, "Mayfield Memorial Apartments");
  assertEquals((m.distance_m ?? 0) < 120, true);
});

Deno.test("matchProperty: two neighbouring properties pick the nearer", () => {
  assertEquals(matchProperty(34.9788, -80.9950, PROPS).property, "The Villas at Riverview");
  assertEquals(matchProperty(34.9775, -80.9980, PROPS).property, "The Villas at 1825");
});

Deno.test("matchProperty: far from every property says so, and still names the nearest", () => {
  // the boots' bench in north Charlotte: about 8 km from the travel plaza, the nearest property
  const m = matchProperty(35.371169, -80.802213, PROPS);
  assertEquals(m.at_property, false);
  assertEquals(m.property, null);
  assertEquals(m.nearest, "Charlotte Travel Plaza");
  assertEquals((m.nearest_m ?? 0) > 7000, true);
});

Deno.test("matchProperty: no point, a 0,0 point, or no property coordinates is no match", () => {
  assertEquals(matchProperty(null, null, PROPS).nearest, null);
  assertEquals(matchProperty(0, 0, PROPS).nearest, null);
  assertEquals(matchProperty(35.28, -80.81, [{ id: "x", name: "x", lat: null, lng: null }]).nearest, null);
});

Deno.test("placementPoint: lock GPS first, then emergency GPS", () => {
  assertEquals(placementPoint({ lock_lat: 35.1, lock_lon: -80.1, emergency_lat: 1, emergency_lon: 1 }), { lat: 35.1, lon: -80.1, source: "lock" });
  assertEquals(placementPoint({ lock_lat: null, emergency_lat: 35.2, emergency_lon: -80.2 }), { lat: 35.2, lon: -80.2, source: "emergency" });
  assertEquals(placementPoint({}), null);
});

Deno.test("Square helpers: fee sum, note → deployment, dashboard link", () => {
  assertEquals(squareFeeCents({ id: "p", processing_fee: [{ amount_money: { amount: 33 } }, { amount_money: { amount: 2 } }] }), 35);
  assertEquals(squareFeeCents({ id: "p" }), null);
  assertEquals(deploymentIdFromNote("boot_deployment:0B6A4C1E-1111-2222-3333-444455556666"), "0b6a4c1e-1111-2222-3333-444455556666");
  assertEquals(deploymentIdFromNote("lunch"), null);
  assertEquals(squareDashboardUrl("abc"), "https://squareup.com/dashboard/sales/transactions/abc");
  assertEquals(squareDashboardUrl(null), null);
});

Deno.test("joinSquare: by payment id, order id or note; paid deployments Square did not list are reported", () => {
  const deps = [
    { id: "11111111-1111-1111-1111-111111111111", square_payment_id: "PAY1", paid_at: "2026-11-11T13:16:17Z" },
    { id: "22222222-2222-2222-2222-222222222222", square_order_id: "ORD2", paid_at: "2026-11-11T16:55:21Z" },
    { id: "33333333-3333-3333-3333-333333333333", paid_at: null },
    { id: "44444444-4444-4444-4444-444444444444", square_payment_id: "PAY4", paid_at: "2026-11-12T10:00:00Z" },
  ];
  const { pairs, paidNotInSquare } = joinSquare([
    { id: "PAY1" },
    { id: "PAY2", order_id: "ORD2" },
    { id: "PAY3", note: "boot_deployment:33333333-3333-3333-3333-333333333333" },
    { id: "PAY9", note: "something else" },
  ], deps);
  assertEquals(pairs.map((p) => p.deployment?.id.slice(0, 1) ?? null), ["1", "2", "3", null]);
  assertEquals(paidNotInSquare.map((d) => d.id.slice(0, 1)), ["4"]);
});
