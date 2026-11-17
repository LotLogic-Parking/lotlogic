import { assertEquals } from "jsr:@std/assert@1";
import { bootDot, bootSilent, bootWhere, buildOps, propertyStatus, type BootRow, type OpsInput } from "./ops.ts";

const NOW = Date.parse("2026-11-16T18:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const boot = (o: Partial<BootRow> = {}): BootRow => ({
  id: "b1", label: "Boot 01", qr_code: "AAAA1111", partner_id: "ll", state: 1, flags: 0, battery_pct: 90, csq: 20,
  lat: 35.3, lon: -80.8, fix_at: ago(30), last_report_at: ago(30), deployment_id: null, deployment_status: null, plate_text: null,
  fault: false, tamper: false, report_overdue: false, release_stuck: false, assigned_member_id: null,
  pending_cmd: null, pending_status: null, pending_since: null, stored_at: null, ...o,
});
const input = (o: Partial<OpsInput> = {}): OpsInput => ({
  now: NOW, boots: [], deployments: [], members: [], partners: { ll: "LotLogic" }, cameras: [], properties: [],
  onSite: {}, passes: {}, bootTexts: [], registrations: [], requests: [], emergencies: [], ...o,
});
const keys = (o: OpsInput) => buildOps(o).needs.map((n) => n.key);

Deno.test("where a boot is: car beats storage beats holder", () => {
  assertEquals(bootWhere(boot({ deployment_id: "d", deployment_status: "active", stored_at: ago(5), assigned_member_id: "m" })), "car");
  assertEquals(bootWhere(boot({ stored_at: ago(5), assigned_member_id: "m" })), "storage");
  assertEquals(bootWhere(boot({ assigned_member_id: "m" })), "agent");
  assertEquals(bootWhere(boot()), "unassigned");
});

Deno.test("silence on a car or in storage is normal (firmware 0x96); a free boot past its overdue mark is silent", () => {
  assertEquals(bootSilent(boot({ report_overdue: true, deployment_id: "d", deployment_status: "active" })), false);
  assertEquals(bootSilent(boot({ report_overdue: true, stored_at: ago(60) })), false);
  assertEquals(bootSilent(boot({ report_overdue: true })), true);
  assertEquals(bootSilent(boot()), false);
});

Deno.test("dot colours", () => {
  assertEquals(bootDot(boot({ fault: true })), "red");
  assertEquals(bootDot(boot({ report_overdue: true })), "red");
  assertEquals(bootDot(boot({ tamper: true })), "amber");
  assertEquals(bootDot(boot({ battery_pct: 17 })), "amber");
  assertEquals(bootDot(boot({ stored_at: ago(9) })), "grey");
  assertEquals(bootDot(boot({ deployment_id: "d", deployment_status: "locking" })), "grey");
  assertEquals(bootDot(boot()), "green");
});

Deno.test("today's two boots: Boot 01 in fault, Boot 02 stored at 17% raises nothing", () => {
  const o = input({
    boots: [
      boot({ id: "b1", label: "Boot 01 bench", state: 3, fault: true, last_report_at: ago(9 * 1440), report_overdue: true }),
      boot({ id: "b2", label: "Boot 02", battery_pct: 17, stored_at: ago(5 * 1440), last_report_at: ago(40 * 60), report_overdue: true }),
    ],
  });
  assertEquals(keys(o), ["fault:b1", "silent:b1"]);
  assertEquals(buildOps(o).needs[1].title, "Boot 01 bench hasn't checked in for 9 days");
});

Deno.test("boot rules: paid still locked, unpaid over a day, slow pickup, battery, tamper", () => {
  const o = input({
    boots: [
      boot({ id: "paid", label: "P", deployment_id: "d1", deployment_status: "active", state: 0 }),
      boot({ id: "old", label: "O", deployment_id: "d2", deployment_status: "active", state: 0 }),
      boot({ id: "cmd", label: "C", pending_cmd: 2, pending_status: "queued", pending_since: ago(6) }),
      boot({ id: "cmdnew", label: "N", pending_cmd: 1, pending_status: "queued", pending_since: ago(2) }),
      boot({ id: "low", label: "L", battery_pct: 17 }),
      boot({ id: "lowstale", label: "S", battery_pct: 10, last_report_at: ago(30 * 60), report_overdue: false }),
      boot({ id: "tamp", label: "T", tamper: true }),
    ],
    deployments: [
      { id: "d1", boot_id: "paid", property_id: null, status: "active", plate_text: "ABC", applied_at: ago(120), lock_confirmed_at: ago(118), paid_at: ago(15), lock_lat: 1, lock_lon: 2 },
      { id: "d2", boot_id: "old", property_id: null, status: "active", plate_text: "XYZ", applied_at: ago(25 * 60), lock_confirmed_at: ago(25 * 60), paid_at: null, lock_lat: null, lock_lon: null },
    ],
  });
  const out = buildOps(o);
  assertEquals(out.needs.map((n) => n.key).sort(), ["battery:low", "cmd:cmd", "paid:paid", "tamper:tamp", "unpaid:old"]);
  assertEquals(out.needs.find((n) => n.key === "battery:low")?.detail, "Too low to lock. Charge it.");
  assertEquals(out.needs[0].severity, "red");
  const paid = out.boots.find((b) => b.id === "paid")!;
  assertEquals([paid.where, paid.car?.paid, paid.position?.source], ["car", true, "lock"]);
});

Deno.test("boot texts unanswered between 10 min and 6 h", () => {
  const o = input({
    properties: [{ id: "p", name: "Mayfield", property_type: "apartment", lat: null, lng: null }],
    bootTexts: [
      { id: "new", property_id: "p", plate_text: "A", dispatched_at: ago(5) },
      { id: "due", property_id: "p", plate_text: "B", dispatched_at: ago(15) },
      { id: "old", property_id: "p", plate_text: "C", dispatched_at: ago(7 * 60) },
    ],
  });
  const out = buildOps(o);
  assertEquals(out.needs.map((n) => n.key), ["text:due"]);
  assertEquals(out.needs[0].title, "Boot text unanswered: B at Mayfield");
});

Deno.test("cameras and property status", () => {
  const cams = [
    { id: "c1", name: "Gate", property_id: "p", last_seen_at: ago(5), last_read_at: ago(90) },
    { id: "c2", name: "Exit", property_id: "p", last_seen_at: ago(45), last_read_at: ago(40) },
  ];
  assertEquals(propertyStatus([], NOW).status, "No camera");
  assertEquals(propertyStatus([cams[0]], NOW).status, "Working");
  assertEquals(propertyStatus(cams, NOW).status, "1 camera silent");
  assertEquals(propertyStatus([cams[1]], NOW).status, "Cameras silent");
  const out = buildOps(input({ cameras: cams, properties: [{ id: "p", name: "Mayfield", property_type: null, lat: null, lng: null }], onSite: { p: 4 } }));
  assertEquals(out.needs.map((n) => n.key), ["camera:c2"]);
  assertEquals([out.properties[0].on_site, out.properties[0].last_read_at], [4, ago(40)]);
});

Deno.test("registrations over 4 h, one line per property; requests over 1 h without acknowledgement", () => {
  const o = input({
    properties: [{ id: "p", name: "Mayfield", property_type: null, lat: null, lng: null }],
    registrations: [{ property_id: "p", created_at: ago(300) }, { property_id: "p", created_at: ago(500) }, { property_id: "p", created_at: ago(10) }],
    requests: [
      { id: "r1", property_id: "p", kind: "tow", plate_text: "T1", created_at: ago(90), partner_ack_at: null },
      { id: "r2", property_id: "p", kind: "tow", plate_text: "T2", created_at: ago(90), partner_ack_at: ago(80) },
      { id: "r3", property_id: "p", kind: "photo", plate_text: "T3", created_at: ago(20), partner_ack_at: null },
    ],
  });
  const out = buildOps(o);
  assertEquals(out.needs.map((n) => n.key).sort(), ["reg:p", "req:r1"]);
  assertEquals(out.needs.find((n) => n.key === "reg:p")?.title, "2 registrations waiting over 4 h");
  assertEquals([out.properties[0].to_review, out.properties[0].requests], [3, 2]);
});

Deno.test("emergency unlocks in the last day; agents count the boots they hold", () => {
  const o = input({
    boots: [
      boot({ id: "b1", assigned_member_id: "m1" }),
      boot({ id: "b2", assigned_member_id: "m1", deployment_id: "d", deployment_status: "active" }),
    ],
    members: [{ id: "m1", partner_id: "ll", name: "Sam", email: "s@x.com", role: "driver", last_login_at: null }],
    emergencies: [{ boot_id: "b1", server_ts: ago(60), reason: "medical" }, { boot_id: "b1", server_ts: ago(30 * 60), reason: "old" }],
  });
  const out = buildOps(o);
  assertEquals(out.needs.map((n) => n.title), ["Emergency unlock on Boot 01"]);
  assertEquals([out.officers[0].boots_held, out.officers[0].on_cars, out.officers[0].company], [2, 1, "LotLogic"]);
});
