// admin-ops: the data behind Admin › Today on the main dashboard. Platform admins only.
//
//   GET  /admin-ops                         -> {as_of, needs, boots, officers, cameras, properties} (ops.ts decides)
//   POST /admin-ops/boots/{id}/assign       {officer_id}  -> give or move the boot to an agent of its own company
//   POST /admin-ops/boots/{id}/unassign                   -> take it back (refused while it is on a car)
//
// Auth: the caller sends the main-dashboard session (the backend's JWT). Like boot-portal, this function does not
// trust the token's claims: it asks the backend who the token is (GET /auth/me), then requires
// lot_owners.is_platform_admin for that email. Reads and writes use the service role.
// Deploy with verify_jwt = false (the gateway can't verify the backend's token); CI deploys it on merge to main.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { admin, CORS, HttpError, json } from "../_shared/boot.ts";
import { buildOps, T, type BootRow, type CameraRow, type DeploymentRow, type MemberRow, type PropertyRow } from "./ops.ts";

const DASHBOARD_API = (Deno.env.get("LOTLOGIC_API_URL") ?? "https://lotlogic-backend-production.up.railway.app").replace(/\/+$/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_DEPLOYMENT = ["locking", "active", "release_authorized"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const db = admin();
  // .../admin-ops[/boots/{id}/{assign|unassign}]
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const rest = parts.slice(parts.indexOf("admin-ops") + 1);
  try {
    const email = await requireAdmin(db, req);
    if (req.method === "GET" && rest.length === 0) return json(await overview(db));
    if (req.method === "POST" && rest[0] === "boots" && rest.length === 3) {
      const body = await req.json().catch(() => ({}));
      if (rest[2] === "assign") return json(await assign(db, email, rest[1], body?.officer_id));
      if (rest[2] === "unassign") return json(await assign(db, email, rest[1], null));
    }
    return json({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.code, message: e.message }, e.status);
    console.error("admin-ops", e);
    return json({ ok: false, error: "server_error", message: "Something went wrong. Try again." }, 500);
  }
});

async function requireAdmin(db: SupabaseClient, req: Request): Promise<string> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new HttpError(401, "signed_out", "Please sign in.");
  let r: Response;
  try {
    r = await fetch(`${DASHBOARD_API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new HttpError(503, "auth_unavailable", "Couldn't check your sign-in. Try again.");
  }
  if (r.status === 401 || r.status === 403) throw new HttpError(401, "signed_out", "Please sign in again.");
  if (!r.ok) throw new HttpError(503, "auth_unavailable", "Couldn't check your sign-in. Try again.");
  const me = await r.json().catch(() => null) as { email?: unknown } | null;
  const email = typeof me?.email === "string" ? me.email.trim().toLowerCase() : "";
  if (!email) throw new HttpError(403, "not_allowed", "Today is for platform admins.");
  const { data } = await db.from("lot_owners").select("email, is_platform_admin").eq("is_platform_admin", true);
  if (!(data ?? []).some((o) => String(o.email ?? "").trim().toLowerCase() === email)) {
    throw new HttpError(403, "not_allowed", "Today is for platform admins.");
  }
  return email;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const H = 3_600_000;

function countBy(rows: { property_id: string | null }[] | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) if (r.property_id) out[r.property_id] = (out[r.property_id] ?? 0) + 1;
  return out;
}

async function overview(db: SupabaseClient) {
  const must = <D>(res: { data: D | null; error: { message: string } | null }, what: string): D => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return (res.data ?? []) as D;
  };
  const [bootsR, depsR, camsR, propsR, sessR, vpR, rpR, pendVpR, pendRpR, textsR, reqR, emR] = await Promise.all([
    db.from("boot_health").select("*").order("label"),
    db.from("boot_deployments").select("id, boot_id, property_id, status, plate_text, applied_at, lock_confirmed_at, paid_at, lock_lat, lock_lon").in("status", OPEN_DEPLOYMENT),
    db.from("alpr_cameras").select("id, name, property_id, last_seen_at").eq("active", true),
    db.from("properties").select("id, name, property_type, lat, lng, active").is("archived_at", null).order("name"),
    db.from("plate_sessions").select("property_id").is("exited_at", null).gte("last_detected_at", iso(24 * H)),
    db.from("visitor_passes").select("property_id").eq("status", "active"),
    db.from("resident_plates").select("property_id").eq("status", "approved"),
    db.from("visitor_passes").select("property_id, created_at").eq("status", "pending"),
    db.from("resident_plates").select("property_id, created_at").eq("status", "pending"),
    db.from("alpr_violations").select("id, property_id, plate_text, dispatched_at").eq("action_channel", "boot_sms").eq("status", "dispatched").not("sms_sent_at", "is", null).is("action_taken", null).gte("dispatched_at", iso(T.BOOT_TEXT_MAX_H * H)),
    db.from("tow_requests").select("id, property_id, kind, plate_text, created_at, partner_ack_at").eq("status", "active").in("kind", ["tow", "photo"]),
    db.from("boot_events").select("boot_id, server_ts, details").eq("action", "emergency_unlock").gte("server_ts", iso(T.EMERGENCY_H * H)),
  ]);
  const boots = must(bootsR, "boot_health") as BootRow[];
  const cams = must(camsR, "alpr_cameras") as Omit<CameraRow, "last_read_at">[];
  const properties = (must(propsR, "properties") as (PropertyRow & { active: boolean | null })[]).filter((p) => p.active !== false);

  // The latest plate read per camera, last 7 days: one indexed lookup each (a handful of cameras).
  const since = iso(7 * 24 * H);
  const reads = await Promise.all(cams.map((c) =>
    db.from("plate_events").select("created_at").eq("camera_id", c.id).gte("created_at", since).order("created_at", { ascending: false }).limit(1)
  ));
  const cameras: CameraRow[] = cams.map((c, i) => ({ ...c, last_read_at: (reads[i].data?.[0]?.created_at as string | undefined) ?? null }));

  // Agents: the members of every company that owns a boot.
  const partnerIds = [...new Set(boots.map((b) => b.partner_id))];
  const [membersR, partnersR] = partnerIds.length
    ? await Promise.all([
      db.from("partner_members").select("id, partner_id, name, email, role, last_login_at").in("partner_id", partnerIds).is("removed_at", null).order("name"),
      db.from("enforcement_partners").select("id, company_name").in("id", partnerIds),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const partners: Record<string, string> = {};
  for (const p of must(partnersR, "enforcement_partners") as { id: string; company_name: string }[]) partners[p.id] = p.company_name;

  return buildOps({
    now: Date.now(),
    boots,
    deployments: must(depsR, "boot_deployments") as DeploymentRow[],
    members: must(membersR, "partner_members") as MemberRow[],
    partners,
    cameras,
    properties,
    onSite: countBy(must(sessR, "plate_sessions")),
    passes: (() => {
      const a = countBy(must(vpR, "visitor_passes")), b = countBy(must(rpR, "resident_plates"));
      for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
      return a;
    })(),
    bootTexts: must(textsR, "alpr_violations"),
    registrations: [...must(pendVpR, "visitor_passes"), ...must(pendRpR, "resident_plates")].filter((r: { property_id: string | null }) => r.property_id),
    requests: must(reqR, "tow_requests"),
    emergencies: (must(emR, "boot_events") as { boot_id: string; server_ts: string; details: { reason?: string } | null }[])
      .map((e) => ({ boot_id: e.boot_id, server_ts: e.server_ts, reason: e.details?.reason ?? null })),
  });
}

/** Give, move or take back a boot. Same company only; never while the boot is on a car. Logged in boot_events. */
async function assign(db: SupabaseClient, email: string, bootId: string, officerId: unknown) {
  if (!UUID.test(bootId)) throw new HttpError(400, "boot_required");
  const { data: b } = await db.from("boots").select("id, label, partner_id, active, assigned_member_id").eq("id", bootId).maybeSingle();
  if (!b || !b.active) throw new HttpError(404, "unknown_boot", "That boot isn't in service.");
  const { data: dep } = await db.from("boot_deployments").select("id").eq("boot_id", b.id).in("status", OPEN_DEPLOYMENT).limit(1).maybeSingle();
  if (dep) throw new HttpError(409, "on_a_car", `${b.label} is on a car. Release it before giving it to someone else.`);

  let to: { id: string; name: string | null } | null = null;
  if (officerId !== null) {
    if (typeof officerId !== "string" || !UUID.test(officerId)) throw new HttpError(400, "officer_required", "Pick an agent.");
    const { data: m } = await db.from("partner_members").select("id, name, partner_id, removed_at").eq("id", officerId).maybeSingle();
    if (!m || m.removed_at) throw new HttpError(404, "unknown_officer", "That agent isn't active.");
    if (m.partner_id !== b.partner_id) throw new HttpError(409, "wrong_company", "That agent works for a different company than the boot.");
    to = { id: m.id, name: m.name };
  }
  const from = b.assigned_member_id as string | null;
  if ((to?.id ?? null) === from) return { ok: true, unchanged: true };

  const { error } = await db.from("boots").update({ assigned_member_id: to?.id ?? null }).eq("id", b.id);
  if (error) throw new Error(`assign: ${error.message}`);
  await db.from("boot_events").insert({
    boot_id: b.id, source: "server", transport: "web", action: to ? "assigned" : "unassigned",
    details: { from_member_id: from, to_member_id: to?.id ?? null, admin_email: email },
  });
  return { ok: true, boot_id: b.id, assigned_member_id: to?.id ?? null };
}
