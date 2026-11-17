// The rules behind the admin "Today" panel: which boots, cameras and requests need Victor or Gabe now.
// Pure: index.ts loads the rows, this file decides. ops.test.ts holds every rule.

export const T = {
  CAMERA_SILENT_MIN: 30,      // an active camera with no heartbeat and no plate read for this long has gone quiet
  BOOT_TEXT_MIN: 10,          // a boot dispatch text with no DONE/GONE reply after this long...
  BOOT_TEXT_MAX_H: 6,         // ...until this old (cron-sessions-sweep closes it out after that)
  CMD_PICKUP_MIN: 5,          // a lock/unlock the boot hasn't picked up
  PAID_STILL_LOCKED_MIN: 10,  // paid, deployment never moved on
  UNPAID_H: 24,               // on a car this long without payment
  REG_WAIT_H: 4,              // pending registrations
  REQUEST_ACK_H: 1,           // tow / photo request with no contractor acknowledgement
  EMERGENCY_H: 24,            // emergency unlocks to review
  BATTERY_PCT: 20,            // free boot battery alert
  BATTERY_LOCK_PCT: 25,       // under this the boot refuses to lock
  BATTERY_FRESH_H: 24,        // only trust a battery reading this recent
} as const;

const OPEN_DEPLOYMENT = ["locking", "active", "release_authorized"];

export type BootRow = {
  id: string; label: string; qr_code: string | null; partner_id: string; state: number | null; flags: number | null;
  battery_pct: number | null; csq: number | null; lat: number | null; lon: number | null; fix_at: string | null;
  last_report_at: string | null; deployment_id: string | null; deployment_status: string | null; plate_text: string | null;
  fault: boolean; tamper: boolean; report_overdue: boolean; release_stuck: boolean; assigned_member_id: string | null;
  pending_cmd: number | null; pending_status: string | null; pending_since: string | null; stored_at: string | null;
};
export type DeploymentRow = {
  id: string; boot_id: string; property_id: string | null; status: string; plate_text: string | null;
  applied_at: string | null; lock_confirmed_at: string | null; paid_at: string | null; lock_lat: number | null; lock_lon: number | null;
};
export type MemberRow = { id: string; partner_id: string; name: string | null; email: string | null; role: string; last_login_at: string | null };
export type CameraRow = { id: string; name: string | null; property_id: string | null; last_seen_at: string | null; last_read_at: string | null };
export type PropertyRow = { id: string; name: string; property_type: string | null; lat: number | null; lng: number | null };
export type BootText = { id: string; property_id: string | null; plate_text: string | null; dispatched_at: string | null };
export type Registration = { property_id: string; created_at: string };
export type RequestRow = { id: string; property_id: string; kind: string; plate_text: string | null; created_at: string; partner_ack_at: string | null };
export type Emergency = { boot_id: string; server_ts: string; reason: string | null };

export type OpsInput = {
  now: number;
  boots: BootRow[]; deployments: DeploymentRow[]; members: MemberRow[]; partners: Record<string, string>;
  cameras: CameraRow[]; properties: PropertyRow[];
  onSite: Record<string, number>; passes: Record<string, number>;
  bootTexts: BootText[]; registrations: Registration[]; requests: RequestRow[]; emergencies: Emergency[];
};

export type Need = {
  key: string; severity: "red" | "amber"; title: string; detail: string; at: string | null;
  action: { type: "boot" | "property"; id: string } | null;
};

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const olderThan = (iso: string | null | undefined, minutes: number, now: number) => {
  const t = ms(iso);
  return !Number.isFinite(t) || now - t > minutes * 60_000;
};
const latest = (...isos: (string | null | undefined)[]) =>
  isos.filter((s): s is string => !!s).sort((a, b) => ms(b) - ms(a))[0] ?? null;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * Where a boot is. A boot on a car or closed for storage is switched off (firmware 0x96), so its silence is normal;
 * only a free boot that stops reporting is "silent". "Free" means no open deployment and not in storage.
 */
export function bootWhere(b: BootRow): "car" | "storage" | "agent" | "unassigned" {
  if (b.deployment_id && OPEN_DEPLOYMENT.includes(b.deployment_status ?? "")) return "car";
  if (b.stored_at) return "storage";
  return b.assigned_member_id ? "agent" : "unassigned";
}

/** Silent = a free boot past its own overdue mark (boot_health.report_overdue: twice its report interval). One rule for tile, dot and Needs you. */
export function bootSilent(b: BootRow): boolean {
  const w = bootWhere(b);
  return (w === "agent" || w === "unassigned") && !!b.report_overdue;
}

export function bootDot(b: BootRow): "red" | "amber" | "grey" | "green" {
  if (b.fault || bootSilent(b)) return "red";
  if (b.tamper || (b.battery_pct != null && b.battery_pct < T.BATTERY_PCT)) return "amber";
  const w = bootWhere(b);
  if (w === "car" || w === "storage") return "grey";
  return "green";
}

export function cameraLast(c: CameraRow): string | null {
  return latest(c.last_seen_at, c.last_read_at);
}
export function cameraSilent(c: CameraRow, now: number): boolean {
  return olderThan(cameraLast(c), T.CAMERA_SILENT_MIN, now);
}

/** "Working", "1 camera silent", "Cameras silent" or "No camera". */
export function propertyStatus(cams: CameraRow[], now: number): { status: string; working: boolean | null } {
  if (!cams.length) return { status: "No camera", working: null };
  const silent = cams.filter((c) => cameraSilent(c, now)).length;
  if (!silent) return { status: "Working", working: true };
  if (silent === cams.length) return { status: "Cameras silent", working: false };
  return { status: `${plural(silent, "camera")} silent`, working: false };
}

function paidStillLocked(b: BootRow, d: DeploymentRow | undefined, now: number): boolean {
  if (b.release_stuck) return true;
  return !!d?.paid_at && d.status === "active" && olderThan(d.paid_at, T.PAID_STILL_LOCKED_MIN, now);
}

export function buildOps(inp: OpsInput) {
  const { now } = inp;
  const propName = new Map(inp.properties.map((p) => [p.id, p.name]));
  const memberById = new Map(inp.members.map((m) => [m.id, m]));
  const depByBoot = new Map(inp.deployments.filter((d) => OPEN_DEPLOYMENT.includes(d.status)).map((d) => [d.boot_id, d]));
  const needs: Need[] = [];
  const at = (p: string | null) => (p ? propName.get(p) ?? "a property" : "a property");

  // ── boots
  const boots = inp.boots.map((b) => {
    const d = depByBoot.get(b.id);
    const where = bootWhere(b);
    const holder = b.assigned_member_id ? memberById.get(b.assigned_member_id) : undefined;
    const onCarSince = d ? d.lock_confirmed_at ?? d.applied_at : null;
    const position = where === "car" && d?.lock_lat != null && d?.lock_lon != null
      ? { lat: d.lock_lat, lon: d.lock_lon, source: "lock", at: onCarSince }
      : b.lat != null && b.lon != null ? { lat: b.lat, lon: b.lon, source: "gps", at: b.fix_at } : null;
    const act = { type: "boot" as const, id: b.id };

    if (b.fault) needs.push({ key: `fault:${b.id}`, severity: "red", title: `${b.label} reports a fault`, detail: "A lock or unlock move was interrupted.", at: b.last_report_at, action: act });
    if (paidStillLocked(b, d, now)) needs.push({ key: `paid:${b.id}`, severity: "red", title: `${b.label} paid but still locked`, detail: `${d?.plate_text ?? b.plate_text ?? "The car"} at ${at(d?.property_id ?? null)} paid; the boot hasn't released.`, at: d?.paid_at ?? null, action: act });
    if (b.tamper) needs.push({ key: `tamper:${b.id}`, severity: "amber", title: `${b.label} tamper flag is set`, detail: "Check the boot and clear the flag.", at: b.last_report_at, action: act });
    if (b.pending_since && (b.pending_status === "queued" || b.pending_status === "delivered") && olderThan(b.pending_since, T.CMD_PICKUP_MIN, now)) {
      const what = b.pending_cmd === 2 ? "lock" : b.pending_cmd === 1 ? "unlock" : "command";
      needs.push({ key: `cmd:${b.id}`, severity: "amber", title: `${b.label} hasn't picked up its ${what}`, detail: `Queued ${Math.round((now - ms(b.pending_since)) / 60_000)} min ago.`, at: b.pending_since, action: act });
    }
    if (d && !d.paid_at && onCarSince && olderThan(onCarSince, T.UNPAID_H * 60, now)) {
      needs.push({ key: `unpaid:${b.id}`, severity: "amber", title: `${b.label} on ${d.plate_text ?? "a car"} for over a day`, detail: `At ${at(d.property_id)}, not paid.`, at: onCarSince, action: act });
    }
    if (bootSilent(b)) {
      const h = Number.isFinite(ms(b.last_report_at)) ? Math.floor((now - ms(b.last_report_at)) / 3_600_000) : null;
      const span = h == null ? "" : h < 48 ? `${h} h` : plural(Math.floor(h / 24), "day");
      needs.push({ key: `silent:${b.id}`, severity: "amber", title: h == null ? `${b.label} has never checked in` : `${b.label} hasn't checked in for ${span}`, detail: "A free boot should report on schedule. Charge it or power-cycle it.", at: b.last_report_at, action: act });
    }
    if ((where === "agent" || where === "unassigned") && b.battery_pct != null && b.battery_pct < T.BATTERY_PCT && !olderThan(b.last_report_at, T.BATTERY_FRESH_H * 60, now)) {
      needs.push({ key: `battery:${b.id}`, severity: "amber", title: `${b.label} battery at ${b.battery_pct}%`, detail: b.battery_pct < T.BATTERY_LOCK_PCT ? "Too low to lock. Charge it." : "Charge it soon.", at: b.last_report_at, action: act });
    }

    return {
      id: b.id, label: b.label, qr_code: b.qr_code, company: inp.partners[b.partner_id] ?? null,
      state: b.state, battery_pct: b.battery_pct, csq: b.csq, last_report_at: b.last_report_at,
      fault: b.fault, tamper: b.tamper, silent: bootSilent(b), where, dot: bootDot(b),
      holder: holder ? { id: holder.id, name: holder.name ?? holder.email } : null,
      car: d ? { plate: d.plate_text, property_id: d.property_id, property: d.property_id ? propName.get(d.property_id) ?? null : null, since: onCarSince, paid: !!d.paid_at } : null,
      position,
      pending: b.pending_since ? { cmd: b.pending_cmd, status: b.pending_status, since: b.pending_since } : null,
      partner_id: b.partner_id,
    };
  });

  for (const e of inp.emergencies) {
    if (olderThan(e.server_ts, T.EMERGENCY_H * 60, now)) continue;
    const b = inp.boots.find((x) => x.id === e.boot_id);
    needs.push({ key: `emergency:${e.boot_id}:${e.server_ts}`, severity: "amber", title: `Emergency unlock on ${b?.label ?? "a boot"}`, detail: e.reason ? `Reason: ${e.reason}. Review it.` : "Review it.", at: e.server_ts, action: { type: "boot", id: e.boot_id } });
  }

  // ── boot texts
  for (const v of inp.bootTexts) {
    if (!v.dispatched_at) continue;
    const age = now - ms(v.dispatched_at);
    if (age < T.BOOT_TEXT_MIN * 60_000 || age > T.BOOT_TEXT_MAX_H * 3_600_000) continue;
    needs.push({ key: `text:${v.id}`, severity: "red", title: `Boot text unanswered: ${v.plate_text ?? "a car"} at ${at(v.property_id)}`, detail: `No DONE or GONE reply for ${Math.round(age / 60_000)} min.`, at: v.dispatched_at, action: v.property_id ? { type: "property", id: v.property_id } : null });
  }

  // ── cameras and properties
  const cameras = inp.cameras.map((c) => ({ id: c.id, name: c.name, property_id: c.property_id, property: c.property_id ? propName.get(c.property_id) ?? null : null, last_at: cameraLast(c), silent: cameraSilent(c, now) }));
  for (const c of cameras) {
    if (c.silent) needs.push({ key: `camera:${c.id}`, severity: "red", title: `${c.name ?? "A camera"} has gone quiet`, detail: `At ${c.property ?? "an unknown property"}. ${c.last_at ? "" : "It has never reported."}`.trim(), at: c.last_at, action: c.property_id ? { type: "property", id: c.property_id } : null });
  }

  const pendingByProp = new Map<string, number>();
  const oldPendingByProp = new Map<string, { n: number; oldest: string }>();
  for (const r of inp.registrations) {
    pendingByProp.set(r.property_id, (pendingByProp.get(r.property_id) ?? 0) + 1);
    if (olderThan(r.created_at, T.REG_WAIT_H * 60, now)) {
      const cur = oldPendingByProp.get(r.property_id);
      oldPendingByProp.set(r.property_id, { n: (cur?.n ?? 0) + 1, oldest: cur && ms(cur.oldest) < ms(r.created_at) ? cur.oldest : r.created_at });
    }
  }
  for (const [pid, { n, oldest }] of oldPendingByProp) {
    needs.push({ key: `reg:${pid}`, severity: "amber", title: `${plural(n, "registration")} waiting over ${T.REG_WAIT_H} h`, detail: `At ${at(pid)}.`, at: oldest, action: { type: "property", id: pid } });
  }

  const towsByProp = new Map<string, number>();
  for (const r of inp.requests) {
    if (r.kind === "tow") towsByProp.set(r.property_id, (towsByProp.get(r.property_id) ?? 0) + 1);
    if ((r.kind === "tow" || r.kind === "photo") && !r.partner_ack_at && olderThan(r.created_at, T.REQUEST_ACK_H * 60, now)) {
      needs.push({ key: `req:${r.id}`, severity: "amber", title: `${r.kind === "tow" ? "Tow" : "Photo"} request not acknowledged`, detail: `${r.plate_text ?? "A car"} at ${at(r.property_id)}.`, at: r.created_at, action: { type: "property", id: r.property_id } });
    }
  }

  const camsByProp = new Map<string, CameraRow[]>();
  for (const c of inp.cameras) if (c.property_id) camsByProp.set(c.property_id, [...(camsByProp.get(c.property_id) ?? []), c]);
  const properties = inp.properties.map((p) => {
    const cams = camsByProp.get(p.id) ?? [];
    const st = propertyStatus(cams, now);
    return {
      id: p.id, name: p.name, property_type: p.property_type, lat: p.lat, lng: p.lng,
      status: st.status, working: st.working, cameras: cams.length,
      last_read_at: latest(...cams.map((c) => c.last_read_at)),
      on_site: cams.length ? inp.onSite[p.id] ?? 0 : null,
      passes: inp.passes[p.id] ?? 0,
      requests: towsByProp.get(p.id) ?? 0,
      to_review: pendingByProp.get(p.id) ?? 0,
    };
  });

  // ── agents
  const officers = inp.members.map((m) => {
    const held = boots.filter((b) => b.holder?.id === m.id);
    return { id: m.id, name: m.name ?? m.email, email: m.email, role: m.role, partner_id: m.partner_id, company: inp.partners[m.partner_id] ?? null, last_login_at: m.last_login_at, boots_held: held.length, on_cars: held.filter((b) => b.where === "car").length, on_shift: null };
  });

  // Red first, then amber; newest first inside each.
  needs.sort((a, b) => (a.severity === b.severity ? (ms(b.at) || 0) - (ms(a.at) || 0) : a.severity === "red" ? -1 : 1));

  return { as_of: new Date(now).toISOString(), needs, boots, officers, cameras, properties };
}
