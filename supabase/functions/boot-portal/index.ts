// boot-portal: the driver / dispatch boot portal API (LTE-only boots, no Bluetooth). Public endpoint, own auth.
// Drivers sign in with their LotLogic email + password (partner_members.password_hash, bcrypt). Sessions are random
// bearer tokens stored hashed in boot_portal_sessions (12 h).
//
//   POST /boot-portal/login        {email, password}            -> {token, me}
//   POST /boot-portal/logout
//   GET  /boot-portal/me
//   GET  /boot-portal/boots                                     -> boots I can use, with live status
//   GET  /boot-portal/boot?id=                                  -> one boot: status, open deployment, recent commands/events
//   GET  /boot-portal/properties                                -> properties I can boot at
//   POST /boot-portal/photo-url    {boot_id, content_type, kind?} -> signed upload URL (kind: lock | signature | emergency)
//   POST /boot-portal/open         {boot_id}                    -> placing step 1: open a free boot to fit it (UNLOCK, purpose fit)
//   POST /boot-portal/lock         {boot_id, plate_text, plate_state?, property_id?, photo_path, signature_path, signed_name,
//                                   vehicle_*?, lat?, lon?, accuracy_m?, notes?}  -> placing step 2 (LOCK, purpose place).
//                                   Refused unless the boot reports open.
//   POST /boot-portal/unlock       {boot_id, waive?, note?}     -> release a paid boot; waive = admin/dispatch releases without payment
//   POST /boot-portal/store        {boot_id}                    -> removing step 2: close an empty boot for storage (LOCK, purpose store)
//   POST /boot-portal/emergency    {boot_id, reason, explanation, photo_path?, lat?, lon?, accuracy_m?}
//                                   -> any signed-in user: unlock now, paid or not; logged permanently for review
//   POST /boot-portal/cancel       {boot_id}                    -> cancel a lock the boot has not picked up yet
//   POST /boot-portal/setup-wifi   {boot_id}                    -> admin/dispatch: open the boot's setup Wi-Fi (free boot only)
//   GET  /boot-portal/payments     LotLogic admins: every Square payment since PAYMENTS_LOG_START (2026-11-15) joined
//                                   to its boot placement, with the placement GPS matched to the nearest property
//                                   (payments.ts); ?days= narrows it to the last n days
//   GET  /boot-portal/agents       LotLogic admins: LotLogic's boot agents (agents.ts), with the properties to pick from
//   POST /boot-portal/agent-add    {name, email, phone?, role: driver|dispatcher, property_ids}  -> set-password email
//   POST /boot-portal/agent-resend {member_id}                  -> a new set-password email
//   POST /boot-portal/agent-remove {member_id}                  -> removed_at, and their portal sessions ended
// A LotLogic agent (a portal member of the "LotLogic" company) boots at the properties assigned to them if a driver,
// at any live property if a dispatcher: LotLogic owns no property, it boots at its customers'.
// LotLogic admins (BOOT_ADMIN_EMAILS, default gabriel@ and victor@lotlogicparking.com) can call every route with
// their main-dashboard session instead of a portal token: the backend's /auth/me says who it is (admin.ts). An admin
// sees and acts on every partner's boots, as role admin. A team member signed in to the main dashboard (a LotLogic
// agent in the Enforcement tab) is the same member a portal /login gives, with the same scope.
// Deploy with verify_jwt = false.
import bcrypt from "npm:bcryptjs@2.4.3";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { admin, bytesToHex, CMD, CORS, HttpError, json, loadSecret, wifiPassword, wifiSsid } from "../_shared/boot.ts";
import { adminEmails, adminFromAuthMe, DEFAULT_DASHBOARD_API, looksLikeJwt, memberFromAuthMe } from "./admin.ts";
import { addAgent, isLotLogicAgent, listAgents, removeAgent, resendAgent, supabaseStore, type TeamCall } from "./agents.ts";
import { joinSquare, logSince, matchProperty, placementPoint, squareDashboardUrl, squareFeeCents, type PropertyPoint, type SquarePayment } from "./payments.ts";
import { annotatePauses } from "./pause_gate.ts";
import { refuseIfPaused } from "./lock_pause.ts";
import { readPauses } from "../_shared/pause.ts";

const SESSION_H = 12;
const LOCK_TTL_S = 600;
const PHOTO_BUCKET = "boot-photos";
// bcrypt of a random string: compared against when the email is unknown, so timing doesn't reveal accounts.
const DUMMY_HASH = "$2a$10$laXPKNaVcX4xyuw2SthIfeOzusR3T4Wj6YYIEqzQxb/.8KDv9KD.2";

type Me = {
  member_id: string | null; partner_id: string | null; role: "admin" | "dispatcher" | "driver"; name: string; email: string; company: string;
  lotlogic?: boolean; // a LotLogic admin on a dashboard session: every partner's boots, no partner_members row
};
const ADMIN_EMAILS = adminEmails(Deno.env.get("BOOT_ADMIN_EMAILS"));
const DASHBOARD_API = (Deno.env.get("LOTLOGIC_API_URL") ?? DEFAULT_DASHBOARD_API).replace(/\/+$/, "");
/** Who did it, for the audit details: the admin's email when there is no member id to point at. */
const by = (me: Me) => (me.lotlogic ? { admin_email: me.email } : {});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const db = admin();
  const url = new URL(req.url);
  const route = url.pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "login" && req.method === "POST") return json(await login(db, req));
    const { me, tokenHash, dashToken } = await requireSession(db, req);
    if (req.method === "GET") {
      if (route === "me") return json({ ok: true, me });
      if (route === "agents") return json(await listAgents(supabaseStore(db), me));
      if (route === "boots") return json(await listBoots(db, me));
      if (route === "boot") return json(await bootDetail(db, me, url.searchParams.get("id")));
      if (route === "properties") return json(annotatePauses(await listProperties(db, me), await readPauses(db, new Date())));
      if (route === "payments") return json(await payments(db, me, url));
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (route === "logout") {
        if (tokenHash) await db.from("boot_portal_sessions").update({ revoked_at: new Date().toISOString() }).eq("token_hash", tokenHash);
        return json({ ok: true });
      }
      if (route === "photo-url") return json(await photoUrl(db, me, body));
      if (route === "open") return json(await openBoot(db, me, body));
      if (route === "lock") return json(await lock(db, me, body));
      if (route === "unlock") return json(await unlock(db, me, body));
      if (route === "store") return json(await store(db, me, body));
      if (route === "emergency") return json(await emergency(db, me, body, req));
      if (route === "cancel") return json(await cancel(db, me, body));
      if (route === "setup-wifi") return json(await setupWifi(db, me, body));
      if (route === "agent-add") return json(await addAgent(supabaseStore(db), teamCall(dashToken), me, body));
      if (route === "agent-resend") return json(await resendAgent(supabaseStore(db), teamCall(dashToken), me, body));
      if (route === "agent-remove") return json(await removeAgent(supabaseStore(db), teamCall(dashToken), me, body));
    }
    throw new HttpError(404, "not_found");
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ ok: false, error: "internal", message: "Something went wrong. Try again." }, 500);
  }
});

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha256Hex(s: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

// ---------------------------------------------------------------- auth
async function login(db: SupabaseClient, req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = str(body.email, 200)?.toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) throw new HttpError(400, "email_and_password_required", "Enter your email and password.");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await db.from("boot_portal_login_attempts").select("id", { count: "exact", head: true })
    .eq("email", email).eq("ok", false).gte("created_at", since);
  if ((count ?? 0) >= 8) throw new HttpError(429, "too_many_attempts", "Too many tries. Wait 15 minutes and try again.");

  const { data: rows } = await db.from("partner_members")
    .select("id, partner_id, role, name, email, password_hash").is("removed_at", null).ilike("email", email.replace(/[\\%_]/g, "\\$&"));
  const m = (rows ?? []).find((r) => r.email.toLowerCase() === email);
  const ok = bcrypt.compareSync(password, m?.password_hash || DUMMY_HASH) && !!m?.password_hash;
  await db.from("boot_portal_login_attempts").insert({ email, ok, ip });
  if (!ok || !m) throw new HttpError(401, "bad_login", "That email and password don't match. Use your LotLogic login.");

  const { data: partner } = await db.from("enforcement_partners").select("company_name, active").eq("id", m.partner_id).single();
  if (!partner?.active) throw new HttpError(403, "company_inactive", "Your company's account is not active.");

  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = bytesToHex(raw);
  await db.from("boot_portal_sessions").insert({
    token_hash: await sha256Hex(token), member_id: m.id, partner_id: m.partner_id,
    expires_at: new Date(Date.now() + SESSION_H * 3600_000).toISOString(),
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  });
  const me: Me = { member_id: m.id, partner_id: m.partner_id, role: m.role, name: m.name, email: m.email, company: partner.company_name };
  return { ok: true, token, expires_in_s: SESSION_H * 3600, me };
}

/** A main-dashboard session: a LotLogic admin (every boot), or a team member (their company's, as /login gives). */
async function dashboardSession(db: SupabaseClient, token: string): Promise<{ me: Me; dashToken: string }> {
  let r: Response;
  try {
    r = await fetch(`${DASHBOARD_API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new HttpError(503, "auth_unavailable", "Couldn't check your sign-in. Try again.");
  }
  if (r.status === 401 || r.status === 403) throw new HttpError(401, "signed_out", "Please sign in again.");
  if (!r.ok) throw new HttpError(503, "auth_unavailable", "Couldn't check your sign-in. Try again.");
  const body = await r.json().catch(() => null);
  const adminMe = adminFromAuthMe(body, ADMIN_EMAILS);
  if (adminMe) return { me: adminMe, dashToken: token };
  const member = memberFromAuthMe(body);
  if (!member) throw new HttpError(403, "not_allowed", "Enforcement is for LotLogic admins and agents.");
  return { me: await memberMe(db, member.member_id, member.partner_id), dashToken: "" };
}

/** The signed-in team member, or 401 when they were removed or moved company; 403 when the company is off. */
async function memberMe(db: SupabaseClient, memberId: string, partnerId: string): Promise<Me> {
  const { data: m } = await db.from("partner_members").select("id, partner_id, role, name, email, removed_at")
    .eq("id", memberId).maybeSingle();
  if (!m || m.removed_at || m.partner_id !== partnerId) throw new HttpError(401, "signed_out", "Please sign in again.");
  const { data: p } = await db.from("enforcement_partners").select("company_name, active").eq("id", m.partner_id).single();
  if (!p?.active) throw new HttpError(403, "company_inactive", "Your company's account is not active.");
  return { member_id: m.id, partner_id: m.partner_id, role: m.role, name: m.name, email: m.email, company: p.company_name };
}

/** The backend's team routes, called as the signed-in LotLogic admin (agents.ts). No dashboard session, no call. */
function teamCall(dashToken: string): TeamCall {
  return async (method, path, body) => {
    if (!dashToken) throw new HttpError(403, "not_allowed", "Managing agents is for LotLogic admins.");
    const r = await fetch(`${DASHBOARD_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${dashToken}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

async function requireSession(db: SupabaseClient, req: Request): Promise<{ me: Me; tokenHash: string; dashToken: string }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (looksLikeJwt(token)) return { ...(await dashboardSession(db, token)), tokenHash: "" };
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, "signed_out", "Please sign in.");
  const tokenHash = await sha256Hex(token);
  const { data: s } = await db.from("boot_portal_sessions").select("member_id, partner_id, expires_at, revoked_at, last_seen_at")
    .eq("token_hash", tokenHash).maybeSingle();
  if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) throw new HttpError(401, "signed_out", "Please sign in again.");
  const me = await memberMe(db, s.member_id, s.partner_id);
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) {
    await db.from("boot_portal_sessions").update({ last_seen_at: new Date().toISOString() }).eq("token_hash", tokenHash);
  }
  return { me, tokenHash, dashToken: "" };
}

const canManage = (me: Me) => me.role === "admin" || me.role === "dispatcher";

// ---------------------------------------------------------------- boots
async function myBoot(db: SupabaseClient, me: Me, bootId: unknown) {
  if (typeof bootId !== "string" || !UUID.test(bootId)) throw new HttpError(400, "boot_required");
  const { data: b } = await db.from("boots").select("*").eq("id", bootId).maybeSingle();
  if (!b || !b.active) throw new HttpError(404, "unknown_boot", "That boot isn't in your company.");
  if (me.lotlogic) return b;
  if (b.partner_id !== me.partner_id) throw new HttpError(404, "unknown_boot", "That boot isn't in your company.");
  if (me.role === "driver" && b.assigned_member_id && b.assigned_member_id !== me.member_id) {
    throw new HttpError(403, "not_your_boot", "That boot is assigned to someone else.");
  }
  return b;
}

const isOnline = (b: { last_report_at: string | null; poll_s: number }) =>
  !!b.last_report_at && Date.now() - new Date(b.last_report_at).getTime() < (3 * b.poll_s + 60) * 1000;

async function listBoots(db: SupabaseClient, me: Me) {
  let bq = db.from("boot_health").select("*").order("label");
  if (!me.lotlogic) bq = bq.eq("partner_id", me.partner_id);
  const { data, error } = await bq;
  if (error) throw error;
  const rows = (data ?? []).filter((r) => me.role !== "driver" || !r.assigned_member_id || r.assigned_member_id === me.member_id);
  return {
    ok: true, me,
    boots: rows.map((r) => ({
      id: r.id, label: r.label, qr_code: r.qr_code, partner_id: r.partner_id,
      state: r.state, battery_pct: r.battery_pct, low_battery: r.low_battery, lock_refused_battery: r.lock_refused_battery,
      online: r.online, last_report_at: r.last_report_at, fault: r.fault, tamper: r.tamper,
      lat: r.lat, lon: r.lon, fix_at: r.fix_at,
      deployment_id: r.deployment_id, deployment_status: r.deployment_status, plate_text: r.plate_text,
      pending_cmd: r.pending_cmd, pending_status: r.pending_status, pending_since: r.pending_since,
      pending_purpose: r.pending_purpose, stored_at: r.stored_at,
    })),
  };
}

async function bootDetail(db: SupabaseClient, me: Me, id: string | null) {
  const b = await myBoot(db, me, id);
  const { data: dep } = await db.from("boot_deployments").select("*").eq("boot_id", b.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: cmds } = await db.from("boot_commands")
    .select("id, cmd, status, source, purpose, created_at, delivered_at, completed_at, device_result, attempts, note")
    .eq("boot_id", b.id).order("created_at", { ascending: false }).limit(8);
  const photo_url = await signedRead(db, dep?.lock_photo_url);
  const signature_url = await signedRead(db, dep?.driver_signature_path);
  let property: string | null = null;
  if (dep?.property_id) property = (await db.from("properties").select("name").eq("id", dep.property_id).maybeSingle()).data?.name ?? null;
  const point = dep ? placementPoint(dep) : null;
  const geo = point ? matchProperty(point.lat, point.lon, await propertyPoints(db)) : null;
  return {
    ok: true, me,
    boot: {
      id: b.id, label: b.label, qr_code: b.qr_code, state: b.state, flags: b.flags, battery_pct: b.battery_pct, vbat_mv: b.vbat_mv,
      online: isOnline(b), last_report_at: b.last_report_at, poll_s: b.poll_s, lat: b.lat, lon: b.lon, fix_at: b.fix_at, csq: b.csq,
      stored_at: b.stored_at,
    },
    deployment: dep ? {
      id: dep.id, status: dep.status, plate_text: dep.plate_text, plate_state: dep.plate_state, property,
      vehicle: [dep.vehicle_color, dep.vehicle_make, dep.vehicle_model].filter(Boolean).join(" ") || null,
      fee_cents: dep.fee_cents, applied_at: dep.applied_at, lock_confirmed_at: dep.lock_confirmed_at,
      paid_at: dep.paid_at, paid_amount_cents: dep.paid_amount_cents, release_reason: dep.release_reason,
      released_at: dep.released_at, unlocked_at: dep.unlocked_at, cancelled_at: dep.cancelled_at, notes: dep.notes, photo_url,
      driver_signed_name: dep.driver_signed_name, driver_signed_at: dep.driver_signed_at, driver_attestation: dep.driver_attestation,
      signature_url,
      emergency_unlocked_at: dep.emergency_unlocked_at, emergency_reason: dep.emergency_reason,
      emergency_reason_label: dep.emergency_reason ? EMERGENCY_REASONS[dep.emergency_reason] ?? dep.emergency_reason : null,
      emergency_explanation: dep.emergency_explanation,
      gps: point ? { ...point, accuracy_m: dep.lock_accuracy_m ?? null } : null,
      geo,
    } : null,
    commands: cmds ?? [],
    emergency_reasons: EMERGENCY_REASONS,
  };
}

async function signedRead(db: SupabaseClient, path: string | null | undefined) {
  if (!path?.startsWith(`${PHOTO_BUCKET}/`)) return null;
  const { data: s } = await db.storage.from(PHOTO_BUCKET).createSignedUrl(path.slice(PHOTO_BUCKET.length + 1), 3600);
  return s?.signedUrl ?? null;
}

async function listProperties(db: SupabaseClient, me: Me) {
  if (me.lotlogic) {
    const { data, error } = await db.from("properties").select("id, name, address").is("archived_at", null).order("name");
    if (error) throw error;
    return { ok: true, properties: data ?? [] };
  }
  if (isLotLogicAgent(me)) {
    // LotLogic owns no property: a dispatcher works at any live one, a driver only at the ones assigned to them.
    let q = db.from("properties").select("id, name, address").is("archived_at", null).order("name");
    if (me.role === "driver") {
      const { data: mine } = await db.from("partner_member_properties").select("property_id").eq("member_id", me.member_id);
      const assigned = (mine ?? []).map((r) => r.property_id);
      if (!assigned.length) return { ok: true, properties: [] };
      q = q.in("id", assigned);
    }
    const { data, error } = await q;
    if (error) throw error;
    return { ok: true, properties: data ?? [] };
  }
  let ids: string[] | null = null;
  if (me.role === "driver") {
    const { data } = await db.from("partner_member_properties").select("property_id").eq("member_id", me.member_id);
    ids = (data ?? []).map((r) => r.property_id);
  }
  let q = db.from("properties").select("id, name, address").or(`partner_id.eq.${me.partner_id},tow_company_id.eq.${me.partner_id}`)
    .is("archived_at", null).order("name");
  if (ids && ids.length) q = q.in("id", ids);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, properties: data ?? [] };
}

// ---------------------------------------------------------------- photo
async function photoUrl(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  const b = await myBoot(db, me, body.boot_id);
  const type = str(body.content_type, 40) ?? "image/jpeg";
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" } as Record<string, string>)[type];
  if (!ext) throw new HttpError(400, "bad_photo_type", "Use a JPEG, PNG, WebP or HEIC photo.");
  const kind = body.kind === "signature" ? "sig" : body.kind === "emergency" ? "emergency" : "lock";
  if (kind === "sig" && type !== "image/png") throw new HttpError(400, "bad_signature_type", "The signature must be a PNG.");
  const path = `${b.partner_id}/${b.id}/${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { data, error } = await db.storage.from(PHOTO_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(500, "photo_upload_unavailable", "Couldn't start the photo upload. Try again.");
  return { ok: true, upload_url: data.signedUrl, photo_path: `${PHOTO_BUCKET}/${path}` };
}

// ---------------------------------------------------------------- shared checks
const OPEN_STATES = [1, 2];          // the boot reports unlocked / open
const ATTEST_TZ = "America/New_York"; // Charlotte

async function openDeployment(db: SupabaseClient, bootId: string) {
  const { data } = await db.from("boot_deployments").select("*").eq("boot_id", bootId)
    .in("status", ["locking", "active", "release_authorized"]).maybeSingle();
  return data;
}
async function pendingCommand(db: SupabaseClient, bootId: string) {
  const { data } = await db.from("boot_commands").select("id, cmd, status, purpose, deployment_id").eq("boot_id", bootId)
    .in("status", ["queued", "delivered"]).maybeSingle();
  return data;
}
/** The uploaded file exists and belongs to this boot, with the expected kind prefix. */
async function checkUpload(db: SupabaseClient, partnerId: string, bootId: string, path: string | null, kind: "lock" | "sig" | "emergency") {
  const prefix = `${PHOTO_BUCKET}/${partnerId}/${bootId}/`;
  if (!path || !path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  if (!name.startsWith(`${kind}-`) || name.includes("/")) return false;
  const { data: objs } = await db.storage.from(PHOTO_BUCKET).list(`${partnerId}/${bootId}`, { search: name });
  return !!objs?.some((o) => o.name === name);
}
function attestation(name: string, bootLabel: string, plate: string, state: string | null, at: Date) {
  const when = at.toLocaleString("en-US", {
    timeZone: ATTEST_TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
  return `I, ${name}, placed boot “${bootLabel}” on the vehicle with plate ${plate}${state ? ` (${state})` : ""} on ${when}. ` +
    "The plate, photo and location I submitted are accurate.";
}

// ---------------------------------------------------------------- placing 1: open a free boot so it can be fitted
async function openBoot(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  const b = await myBoot(db, me, body.boot_id);
  const open = await openDeployment(db, b.id);
  if (open) throw new HttpError(409, "boot_in_use", `This boot is on ${open.plate_text}. Use Release or Emergency unlock.`);
  const pending = await pendingCommand(db, b.id);
  if (pending?.deployment_id) throw new HttpError(409, "command_pending", "This boot has a command for a car waiting. Try again once it's done.");
  const { data: cmdId, error } = await db.rpc("boot_queue_command", {
    p_boot_id: b.id, p_deployment_id: null, p_cmd: CMD.UNLOCK, p_source: "portal", p_member: me.member_id,
    p_ttl_s: null, p_note: "open to fit", p_purpose: "fit",
  });
  if (error) throw error;
  return {
    ok: true, command_id: cmdId, online: isOnline(b),
    message: isOnline(b) ? "Opening. The boot picks it up on its next check-in (usually under a minute)."
      : "Open queued, but this boot hasn't checked in recently. It opens when it next connects.",
  };
}

// ---------------------------------------------------------------- placing 2: sign & lock on a car
async function lock(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  const b = await myBoot(db, me, body.boot_id);
  const plate = str(body.plate_text, 12)?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const plateState = str(body.plate_state, 4)?.toUpperCase() ?? null;
  const photo = str(body.photo_path, 300);
  const sig = str(body.signature_path, 300);
  const signedName = str(body.signed_name, 80);
  if (!plate) throw new HttpError(400, "plate_required", "Enter the plate.");
  if (!signedName || signedName.length < 2) throw new HttpError(400, "name_required", "Type your name to sign.");
  if (!await checkUpload(db, b.partner_id, b.id, photo, "lock")) {
    throw new HttpError(400, "photo_required", "Take a photo of the boot on the wheel first (or it didn't finish uploading).");
  }
  if (!await checkUpload(db, b.partner_id, b.id, sig, "sig")) throw new HttpError(400, "signature_required", "Sign in the box first.");
  // Battery % comes from the boot (pack chemistry differs between builds), so gate on % not volts.
  if (b.battery_pct != null && b.battery_pct < 25) {
    throw new HttpError(409, "low_battery", "This boot's battery is too low to lock (under 25 %). Charge it or use another boot.");
  }
  const open = await openDeployment(db, b.id);
  if (open) throw new HttpError(409, "boot_in_use", `This boot is already on ${open.plate_text}.`);
  if (!OPEN_STATES.includes(b.state)) {
    throw new HttpError(409, "boot_not_open", "The boot doesn't report open yet. Open it first, fit it on the wheel, then lock it.");
  }
  const pending = await pendingCommand(db, b.id);
  if (pending) throw new HttpError(409, "command_pending", "The boot has another command waiting. Try again once it's done.");

  let propertyId = str(body.property_id, 36);
  let geoNote: string | null = null;
  if (!propertyId && num(body.lat) != null && num(body.lon) != null) {
    // No property picked: take the one the phone's GPS puts the car at, if any (payments.ts).
    const { properties: mine } = await listProperties(db, me);
    const ids = new Set(mine.map((p: { id: string }) => p.id));
    const m = matchProperty(num(body.lat), num(body.lon), (await propertyPoints(db)).filter((p) => ids.has(p.id)));
    if (m.at_property && m.property_id) {
      propertyId = m.property_id;
      geoNote = `property set from GPS: ${m.property} (${m.distance_m} m)`;
    }
  }
  if (propertyId) {
    if (!UUID.test(propertyId)) throw new HttpError(400, "bad_property");
    const { properties } = await listProperties(db, me);
    if (!properties.some((p: { id: string }) => p.id === propertyId)) throw new HttpError(403, "property_not_yours", "You can't boot at that property.");
  }
  // Enforcement pause (lock_pause.ts): no boot at a paused property. The agent's draft is kept by the screen.
  await refuseIfPaused(db, {
    now: new Date(), propertyId, lat: num(body.lat), lon: num(body.lon), plate,
    myProperties: async () => (await listProperties(db, me)).properties, points: () => propertyPoints(db),
  });
  const { data: partner } = await db.from("enforcement_partners").select("boot_fee_cents").eq("id", b.partner_id).single();
  const fee = partner?.boot_fee_cents ?? 0;
  if (fee <= 0) throw new HttpError(409, "no_boot_fee", "Your company has no boot fee set, so the motorist couldn't pay. Ask LotLogic to set it.");

  const signedAt = new Date();
  const attest = attestation(signedName, b.label, plate, plateState, signedAt);
  const { data: dep, error } = await db.from("boot_deployments").insert({
    boot_id: b.id, partner_id: b.partner_id, property_id: propertyId, plate_text: plate, plate_state: plateState,
    vehicle_make: str(body.vehicle_make, 40), vehicle_model: str(body.vehicle_model, 40), vehicle_color: str(body.vehicle_color, 30),
    lock_photo_url: photo, lock_lat: num(body.lat), lock_lon: num(body.lon), lock_accuracy_m: num(body.accuracy_m),
    applied_by: me.member_id, fee_cents: fee, notes: [str(body.notes, 1000), geoNote].filter(Boolean).join("\n") || null,
    driver_signature_path: sig, driver_signed_name: signedName, driver_signed_at: signedAt.toISOString(), driver_attestation: attest,
  }).select("id").single();
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "boot_in_use", "This boot is already on a car.");
    throw error;
  }
  await db.from("boot_events").insert({
    boot_id: b.id, deployment_id: dep.id, source: "server", transport: "web", action: "driver_signed", actor_member_id: me.member_id,
    lat: num(body.lat), lon: num(body.lon), gps_accuracy_m: num(body.accuracy_m), photo_url: photo,
    details: { signed_name: signedName, attestation: attest, signature_path: sig, ...by(me) },
  });
  const { data: cmdId, error: qErr } = await db.rpc("boot_queue_command", {
    p_boot_id: b.id, p_deployment_id: dep.id, p_cmd: CMD.LOCK, p_source: "portal", p_member: me.member_id,
    p_ttl_s: LOCK_TTL_S, p_note: `lock ${plate}`, p_purpose: "place",
  });
  if (qErr) throw qErr;
  return {
    ok: true, deployment_id: dep.id, command_id: cmdId, online: isOnline(b), attestation: attest,
    message: isOnline(b)
      ? "Signed. Lock sent: the boot picks it up on its next check-in (usually under a minute)."
      : "Signed. Lock queued, but this boot hasn't checked in recently. It locks when it next connects (within 10 minutes) or the lock is cancelled.",
  };
}

// ---------------------------------------------------------------- removing 1: release (paid, or waived by dispatch)
async function unlock(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  const b = await myBoot(db, me, body.boot_id);
  const dep = await openDeployment(db, b.id);
  if (!dep) return openBoot(db, me, body);   // no car: same as "Open boot"
  let source: "portal" | "waiver" = "portal";
  if (dep.status !== "release_authorized") {
    if (!body.waive) {
      throw new HttpError(402, "not_paid", "This boot hasn't been paid. The motorist pays by scanning the QR code, or dispatch can waive the fee.");
    }
    if (!canManage(me)) throw new HttpError(403, "dispatch_only", "Only dispatch or an admin can waive the fee.");
    const note = str(body.note, 500);
    if (!note) throw new HttpError(400, "reason_required", "Say why you're waiving the fee.");
    const { error } = await db.from("boot_deployments").update({
      status: "release_authorized", release_reason: "waived", released_at: new Date().toISOString(), released_by: me.member_id,
      notes: [dep.notes, `waived: ${note}`].filter(Boolean).join("\n"),
    }).eq("id", dep.id).in("status", ["locking", "active"]);
    if (error) throw error;
    await db.from("boot_events").insert({
      boot_id: b.id, deployment_id: dep.id, source: "server", action: "released", actor_member_id: me.member_id,
      details: { reason: "waived", note, role: me.role, ...by(me) },
    });
    source = "waiver";
  }
  const { data: cmdId, error } = await db.rpc("boot_queue_command", {
    p_boot_id: b.id, p_deployment_id: dep.id, p_cmd: CMD.UNLOCK, p_source: source, p_member: me.member_id,
    p_ttl_s: null, p_note: source === "waiver" ? "fee waived" : "release", p_purpose: "release",
  });
  if (error) throw error;
  return { ok: true, command_id: cmdId, online: isOnline(b), message: "Release sent. The boot opens on its next check-in." };
}

// ---------------------------------------------------------------- removing 2: close an empty boot for storage
async function store(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  const b = await myBoot(db, me, body.boot_id);
  const open = await openDeployment(db, b.id);
  if (open) throw new HttpError(409, "boot_in_use", `This boot is still on ${open.plate_text}. Release it first.`);
  if (b.state === 0) throw new HttpError(409, "already_closed", "The boot already reports closed.");
  const pending = await pendingCommand(db, b.id);
  if (pending?.deployment_id) throw new HttpError(409, "command_pending", "This boot has a command for a car waiting. Try again once it's done.");
  const { data: cmdId, error } = await db.rpc("boot_queue_command", {
    p_boot_id: b.id, p_deployment_id: null, p_cmd: CMD.LOCK, p_source: "portal", p_member: me.member_id,
    p_ttl_s: LOCK_TTL_S, p_note: "close for storage", p_purpose: "store",
  });
  if (error) throw error;
  return {
    ok: true, command_id: cmdId, online: isOnline(b),
    message: isOnline(b) ? "Closing for storage. Keep hands clear of the jaws." : "Close queued; it runs when the boot next connects (within 10 minutes).",
  };
}

// ---------------------------------------------------------------- emergency unlock (any signed-in user, always logged)
// Open decision (9 Nov): drivers can use this today; it could be limited to dispatch/admin with canManage(me).
const EMERGENCY_REASONS: Record<string, string> = {
  police_fire_ems: "Police, fire or EMS ordered the car moved",
  medical: "Medical emergency",
  safety: "Safety risk (crowd, threat, traffic)",
  wrong_vehicle: "Wrong vehicle booted",
  boot_fault: "Boot malfunction or stuck",
  other: "Other",
};
const EMERGENCY_MIN_CHARS = 20;

async function emergency(db: SupabaseClient, me: Me, body: Record<string, unknown>, req: Request) {
  const b = await myBoot(db, me, body.boot_id);
  const reason = typeof body.reason === "string" && EMERGENCY_REASONS[body.reason] ? body.reason : null;
  const explanation = str(body.explanation, 2000);
  if (!reason) throw new HttpError(400, "reason_required", "Pick a reason.");
  if (!explanation || explanation.length < EMERGENCY_MIN_CHARS) {
    throw new HttpError(400, "explanation_required", `Explain what happened, who asked and why it couldn't wait (at least ${EMERGENCY_MIN_CHARS} characters).`);
  }
  const photo = str(body.photo_path, 300);
  if (photo && !await checkUpload(db, b.partner_id, b.id, photo, "emergency")) throw new HttpError(400, "photo_missing", "The photo didn't finish uploading. Take it again or leave it out.");
  const lat = num(body.lat), lon = num(body.lon), acc = num(body.accuracy_m);
  const now = new Date().toISOString();
  const dep = await openDeployment(db, b.id);

  if (dep) {
    const patch: Record<string, unknown> = {
      emergency_unlocked_at: now, emergency_unlocked_by: me.member_id, emergency_reason: reason,
      emergency_explanation: explanation, emergency_photo_path: photo, emergency_lat: lat, emergency_lon: lon,
    };
    if (dep.status !== "release_authorized") {
      Object.assign(patch, { status: "release_authorized", release_reason: "emergency", released_at: now, released_by: me.member_id });
    }
    const { error } = await db.from("boot_deployments").update(patch).eq("id", dep.id);
    if (error) throw error;
  }
  const { data: cmdId, error } = await db.rpc("boot_queue_command", {
    p_boot_id: b.id, p_deployment_id: dep?.id ?? null, p_cmd: CMD.UNLOCK, p_source: "portal", p_member: me.member_id,
    p_ttl_s: null, p_note: `emergency: ${reason}`, p_purpose: "emergency",
  });
  if (error) throw error;
  await db.from("boot_events").insert({
    boot_id: b.id, deployment_id: dep?.id ?? null, source: "server", transport: "web", action: "emergency_unlock",
    actor_member_id: me.member_id, lat, lon, gps_accuracy_m: acc, photo_url: photo,
    details: {
      command_id: cmdId, reason, reason_label: EMERGENCY_REASONS[reason], explanation, role: me.role, name: me.name,
      plate: dep?.plate_text ?? null, paid: !!dep?.paid_at,
      ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300), ...by(me),
    },
  });
  console.warn("boot emergency unlock", b.id, me.member_id, reason);
  return {
    ok: true, command_id: cmdId, online: isOnline(b),
    message: "Emergency unlock sent and recorded. The boot opens on its next check-in.",
  };
}

// ---------------------------------------------------------------- cancel a lock that hasn't reached the boot
async function cancel(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  const b = await myBoot(db, me, body.boot_id);
  const { data: c } = await db.from("boot_commands").select("id, cmd, status, deployment_id, requested_by")
    .eq("boot_id", b.id).in("status", ["queued", "delivered"]).maybeSingle();
  if (!c || c.cmd !== CMD.LOCK) throw new HttpError(409, "nothing_to_cancel", "There's no lock waiting for this boot.");
  if (c.status !== "queued") throw new HttpError(409, "already_sent", "The boot already received the lock. Use Unlock (dispatch can waive).");
  if (me.role === "driver" && c.requested_by !== me.member_id) throw new HttpError(403, "not_yours", "Only the driver who sent it can cancel.");
  const now = new Date().toISOString();
  await db.from("boot_commands").update({ status: "cancelled", completed_at: now, note: "cancelled in portal" }).eq("id", c.id).eq("status", "queued");
  if (c.deployment_id) {
    await db.from("boot_deployments").update({ status: "cancelled", cancelled_at: now, notes: "lock cancelled before it reached the boot" })
      .eq("id", c.deployment_id).eq("status", "locking");
  }
  await db.from("boot_events").insert({
    boot_id: b.id, deployment_id: c.deployment_id, source: "server", action: "lock_cancelled", actor_member_id: me.member_id,
    details: { command_id: c.id, ...by(me) },
  });
  return { ok: true };
}

// ---------------------------------------------------------------- setup Wi-Fi (assign / re-assign at the boot)
// Queues command 0x50: at its next check-in the boot opens its setup access point (10 min after the last use, 1 h max).
// Only on a free boot: no open deployment, not reporting LOCKED, nothing else pending (queuing would supersede it).
async function setupWifi(db: SupabaseClient, me: Me, body: Record<string, unknown>) {
  if (!canManage(me)) throw new HttpError(403, "dispatch_only", "Only dispatch or an admin can open a boot's setup Wi-Fi.");
  const b = await myBoot(db, me, body.boot_id);
  const { data: open } = await db.from("boot_deployments").select("id, plate_text").eq("boot_id", b.id)
    .in("status", ["locking", "active", "release_authorized"]).maybeSingle();
  if (open) throw new HttpError(409, "boot_in_use", `This boot is on ${open.plate_text}. Setup Wi-Fi only opens on a free boot.`);
  if (b.state === 0) throw new HttpError(409, "boot_locked", "The boot reports LOCKED. Unlock it first: setup Wi-Fi never opens on a locked boot.");
  const { data: pending } = await db.from("boot_commands").select("id, cmd").eq("boot_id", b.id)
    .in("status", ["queued", "delivered"]).maybeSingle();
  if (pending && pending.cmd !== CMD.SETUP_WIFI) {
    throw new HttpError(409, "command_pending", "The boot has another command waiting. Try again once it's done.");
  }
  const secret = await loadSecret(db, b.id);
  if (!secret) throw new HttpError(409, "no_identity", "This boot has no identity on the server. Provision it first.");
  const { data: cmdId, error } = await db.rpc("boot_queue_command", {
    p_boot_id: b.id, p_deployment_id: null, p_cmd: CMD.SETUP_WIFI, p_source: "portal", p_member: me.member_id,
    p_ttl_s: 600, p_note: "setup wifi", p_purpose: "test",
  });
  if (error) throw error;
  return {
    ok: true, command_id: cmdId, online: isOnline(b),
    ssid: wifiSsid(b.id), password: await wifiPassword(secret), url: "http://192.168.4.1",
    message: isOnline(b)
      ? "Setup Wi-Fi requested. It opens at the boot's next check-in (about a minute)."
      : "Setup Wi-Fi queued, but this boot hasn't checked in recently. It opens when the boot next connects (within 10 minutes).",
  };
}

// ---------------------------------------------------------------- payments log (LotLogic admins)
async function propertyPoints(db: SupabaseClient): Promise<PropertyPoint[]> {
  const { data, error } = await db.from("properties").select("id, name, lat, lng").is("archived_at", null);
  if (error) throw error;
  return (data ?? []) as PropertyPoint[];
}

async function listSquarePayments(sinceIso: string): Promise<{ ok: boolean; error?: string; payments: SquarePayment[] }> {
  const token = Deno.env.get("SQUARE_ACCESS_TOKEN");
  const location = Deno.env.get("SQUARE_LOCATION_ID");
  if (!token || !location) return { ok: false, error: "square_not_configured", payments: [] };
  const base = (Deno.env.get("SQUARE_ENV") ?? "sandbox") === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const out: SquarePayment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ location_id: location, begin_time: sinceIso, sort_order: "DESC", limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    let r: Response;
    try {
      r = await fetch(`${base}/v2/payments?${qs}`, { headers: { Authorization: `Bearer ${token}`, "Square-Version": "2025-01-23" } });
    } catch {
      return { ok: false, error: "square_unreachable", payments: out };
    }
    const j = await r.json().catch(() => null) as { payments?: SquarePayment[]; cursor?: string } | null;
    if (!r.ok) return { ok: false, error: `square_${r.status}`, payments: out };
    out.push(...(j?.payments ?? []));
    cursor = j?.cursor;
    if (!cursor) break;
  }
  return { ok: true, payments: out };
}

async function payments(db: SupabaseClient, me: Me, url: URL) {
  if (!me.lotlogic) throw new HttpError(403, "not_allowed", "The payments log is for LotLogic admins.");
  const asked = Number(url.searchParams.get("days"));
  const days = asked > 0 ? Math.min(730, asked) : null;
  const since = logSince(Date.now(), days); // never before the log start: earlier payments were tests
  const [deps, props, boots, partners, refunds, square] = await Promise.all([
    db.from("boot_deployments").select("*").gte("created_at", new Date(Date.parse(since) - 30 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).limit(2000),
    propertyPoints(db),
    db.from("boots").select("id, label, qr_code"),
    db.from("enforcement_partners").select("id, company_name"),
    db.from("boot_refunds").select("deployment_id, square_refund_id, amount_cents, status, reason, created_at"),
    listSquarePayments(since),
  ]);
  if (deps.error) throw deps.error;
  const bootBy = new Map((boots.data ?? []).map((b) => [b.id, b]));
  const partnerBy = new Map((partners.data ?? []).map((p) => [p.id, p.company_name]));
  const propBy = new Map(props.map((p) => [p.id, p.name]));
  const refundsBy = new Map<string, unknown[]>();
  for (const r of refunds.data ?? []) refundsBy.set(r.deployment_id, [...(refundsBy.get(r.deployment_id) ?? []), r]);

  const placement = (d: Record<string, unknown>) => {
    const point = placementPoint(d);
    const geo = point ? matchProperty(point.lat, point.lon, props) : null;
    const declared = typeof d.property_id === "string" ? propBy.get(d.property_id) ?? null : null;
    const b = bootBy.get(d.boot_id as string);
    return {
      id: d.id, status: d.status, boot: b?.label ?? null, boot_qr: b?.qr_code ?? null, company: partnerBy.get(d.partner_id as string) ?? null,
      plate: d.plate_text, plate_state: d.plate_state,
      vehicle: [d.vehicle_color, d.vehicle_make, d.vehicle_model].filter(Boolean).join(" ") || null,
      property: declared, gps: point ? { ...point, accuracy_m: d.lock_accuracy_m ?? null } : null, geo,
      property_mismatch: !!(declared && geo?.at_property && geo.property_id !== d.property_id),
      applied_at: d.applied_at, driver: d.driver_signed_name, paid_at: d.paid_at, released_at: d.released_at,
      release_reason: d.release_reason, unlocked_at: d.unlocked_at, cancelled_at: d.cancelled_at,
      fee_cents: d.fee_cents, paid_amount_cents: d.paid_amount_cents, square_fee_cents: d.square_fee_cents,
      lotlogic_share_cents: d.lotlogic_share_cents, partner_share_cents: d.partner_share_cents,
      refunded_amount_cents: d.refunded_amount_cents, refunds: refundsBy.get(d.id as string) ?? [],
      payer_phone: d.payer_phone, payer_email: d.payer_email, partner_paid_out_at: d.partner_paid_out_at,
      square_payment_id: d.square_payment_id, square_order_id: d.square_order_id,
    };
  };

  const { pairs, paidNotInSquare } = joinSquare(square.payments, (deps.data ?? []) as Array<Record<string, unknown> & { id: string }>);
  const rows = [];
  for (const { square: p, deployment: d } of pairs) {
    const fee = squareFeeCents(p);
    // Keep the deployment's record of Square in step: the payment id, and the processing fee, which the
    // payment webhook does not carry when it first fires (both paid tests on 2026-11-11 recorded 0).
    // Only a completed payment is written back: a declined card that was retried must not claim the placement.
    if (d && p.status === "COMPLETED" && ((fee != null && fee > 0 && !d.square_fee_cents) || !d.square_payment_id)) {
      const patch: Record<string, unknown> = {};
      if (fee != null && fee > 0 && !d.square_fee_cents) { patch.square_fee_cents = fee; d.square_fee_cents = fee; }
      if (!d.square_payment_id) { patch.square_payment_id = p.id; d.square_payment_id = p.id; }
      await db.from("boot_deployments").update(patch).eq("id", d.id);
    }
    const amount = p.amount_money?.amount ?? null;
    rows.push({
      kind: d ? "boot" : "other",
      square: {
        id: p.id, created_at: p.created_at, status: p.status, amount_cents: amount, currency: p.amount_money?.currency ?? "USD",
        fee_cents: fee, net_cents: amount != null ? amount - (fee ?? 0) - (p.refunded_money?.amount ?? 0) : null,
        refunded_cents: p.refunded_money?.amount ?? 0, card_brand: p.card_details?.card?.card_brand ?? null,
        card_last4: p.card_details?.card?.last_4 ?? null, receipt_url: p.receipt_url ?? null, receipt_number: p.receipt_number ?? null,
        buyer_email: p.buyer_email_address ?? null, source: p.source_type ?? null, note: p.note ?? null,
        dashboard_url: squareDashboardUrl(p.id),
      },
      placement: d ? placement(d) : null,
    });
  }
  // Placements marked paid in this period that Square did not list. Only a claim when Square answered;
  // deployments are read 30 days further back than Square so a late payment still joins.
  for (const d of paidNotInSquare) {
    if (typeof d.paid_at === "string" && d.paid_at >= since) rows.push({ kind: "boot", square: null, placement: placement(d), not_in_square: square.ok });
  }
  return { ok: true, days, since, square_ok: square.ok, square_error: square.error ?? null, rows };
}
