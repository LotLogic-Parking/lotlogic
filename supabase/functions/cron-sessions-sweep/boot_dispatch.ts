// ── Grace dispatch: a LotLogic driver is texted to boot (apartments) ────
//
// Gabe, 2026-11-11: at an apartment a car the camera sees that is not a
// resident has 15 minutes (what the sign says) to register. At 4 minutes
// (Gabe, 2026-11-20; was 10), a clock only we see, if it has not registered
// and has not been seen leaving, a LotLogic driver is texted to come boot it.
// The driver still may not boot before the posted 15 minutes end
// (SIGN_WINDOW_MINUTES; the text says the exact time), so dispatching early
// only gets a driver there sooner; nothing the public sees changes.
//
// Violation alert (Gabe, 2026-11-20): at the same 4 minutes, at EVERY
// apartment (exit camera or not), the visit is flagged in the dashboard like
// any dispatch and an alert goes to VIOLATION_ALERT_PHONES (text) and
// VIOLATION_ALERT_EMAILS (email): Gabe and Victor. If the car is then seen
// leaving or registers, the same people get a cancellation and the dashboard
// shows it dismissed as left / registered. Drivers are still texted only
// where an exit camera exists (the guard below); without one, the alert says
// the car may have left unseen. Registration or an
// exit cancels the dispatch with a stand-down text. The office sees a red
// "Dispatched" mark on the car until then. Dispatches go to LotLogic's own
// drivers, never to the tow partner.
//
// How it sits in the sweep (index.ts, every minute):
//   registrationTransition → bootRegistrations → bootDispatch → graceExpiry …
//   … sweepPendingStandDowns (excludes these rows) → bootStandDowns → closeExpired
//
// Markers, so nothing else in the pipeline treats these as partner tows:
//   alpr_violations.action_channel = 'boot_sms'   (this is a boot dispatch)
//   dispatched_at + sms_sent_at set at insert     (dispatchPendingViolations
//                                                  never emails the partner)
//   left_before_tow_email_sent_at                 (the stand-down went out)
// No migration: every column already exists.
//
// Guards the review asked for (2026-11-11):
//   • Only a property with an active exit-facing camera dispatches. With an
//     entry camera alone, a car leaving inside the 15-minute dedup window is
//     re-read as "still here", so "not seen leaving" could never be true and
//     a driver would roll out to an empty space.
//   • The text carries the time before which the sign forbids a boot
//     (entered + 15 min) and tells the driver to re-check the car.
//   • A dispatch nobody resolves goes stale after BOOT_STALE_HOURS and is
//     dismissed, so the session closes instead of hanging open for days.
//   • Registration matching is the same fuzzy rule the entry uses
//     (plate_identity "registered"), over visitor passes AND resident plates.
//   • Driver roster: BOOT_DRIVER_PHONES (comma-separated). Empty = the
//     feature is off and nothing here runs, so no session is ever claimed
//     with nobody to text. The backend's inbound SMS webhook authorizes
//     DONE-<id> replies against the same list.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sameVehicle } from "../camera-snapshot/plate_identity.ts";
import { excludePaused, heldThroughPause, type PauseRead } from "../_shared/pause.ts";

export const GRACE_DISPATCH_MINUTES_DEFAULT = 4;
export const SIGN_WINDOW_MINUTES = 15;
export const BOOT_CHANNEL = "boot_sms";
export const BOOT_STALE_HOURS_DEFAULT = 6;
export const BOOT_MAX_PER_TICK = 10;

export type BootDeps = {
  db: SupabaseClient;
  phones: string[];
  twilio: { accountSid: string; authToken: string; from: string } | null;
  now?: Date;
  dispatchMinutes?: number;
  staleHours?: number;
  send?: (to: string, body: string, mediaUrls: string[]) => Promise<{ ok: boolean; status: number; error?: string }>;
  /** Violation alert recipients (Gabe, Victor): texted at every apartment, exit camera or not. */
  alertPhones?: string[];
  alertEmails?: string[];
  /** Resend key + from address for alertEmails; absent = no email. */
  email?: { apiKey: string; from: string } | null;
  sendEmail?: (to: string, subject: string, text: string) => Promise<{ ok: boolean; status: number; error?: string }>;
  /** The tick's enforcement-pause read (_shared/pause.ts). Absent = no pause filter. */
  pauses?: PauseRead;
};

/** "+1 (971) 295-7521", "9712957521" → "+19712957521"; junk → null. */
export function normalizePhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** BOOT_DRIVER_PHONES="+19712957521, 704-555-0100" → ["+19712957521", "+17045550100"]. */
export function parsePhoneList(env: string | undefined | null): string[] {
  const out: string[] = [];
  for (const part of String(env ?? "").split(",")) {
    const n = normalizePhone(part);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The reply id a driver types: the first 12 hex characters of the violation id, upper-case. */
export function shortId(violationId: string): string {
  return String(violationId).replace(/-/g, "").slice(0, 12).toUpperCase();
}

function clockET(iso: string | null | undefined): string {
  if (!iso) return "?";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  } catch {
    return "?";
  }
}

const dayET = (t: Date) => t.toLocaleDateString("en-US", { timeZone: "America/New_York" });

/** "7:00 PM" when `iso` falls on the same Eastern day as `now`, else "Fri 7:00 PM" (a car held by a pause can be days old). */
function clockETFrom(iso: string | null | undefined, now: Date): string {
  if (!iso) return "?";
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "?";
  if (dayET(t) === dayET(now)) return clockET(iso);
  const day = t.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  return `${day} ${clockET(iso)}`;
}

/** When the posted window ends: entered_at + 15 min. The driver may not boot before it. */
export function bootAllowedAfter(enteredAtIso: string): string {
  return new Date(new Date(enteredAtIso).getTime() + SIGN_WINDOW_MINUTES * 60_000).toISOString();
}

export type BootContext = {
  propertyName: string;
  address: string | null;
  plate: string;
  enteredAt: string;
  minutesHere: number;
  violationId: string;
  /**
   * Set when an enforcement pause held this dispatch: the pause's end. A pause
   * holds only what was not yet sent (Gabe, 2026-11-17); a car texted before
   * the pause was texted then, never again, so this line is only on texts the
   * pause held, which go out once, at its end.
   */
  pauseEndedAt?: string | null;
};

/** The dispatch text. Short, every line a fact the driver acts on. */
export function bootMessage(c: BootContext): string {
  const id = shortId(c.violationId);
  const now = new Date(new Date(c.enteredAt).getTime() + c.minutesHere * 60_000);
  return [
    `[BOOT] ${c.propertyName}`,
    `Plate ${c.plate}`,
    `In since ${clockETFrom(c.enteredAt, now)} (${c.minutesHere}m). No parking pass.`,
    ...(c.pauseEndedAt ? [`Held by an enforcement pause that ended at ${clockETFrom(c.pauseEndedAt, now)}. It may have left unseen.`] : []),
    ...(c.address ? [c.address] : []),
    `Do not boot before ${clockETFrom(bootAllowedAfter(c.enteredAt), now)}. Check it is still there and still unregistered.`,
    `Reply DONE-${id} when booted, GONE-${id} if it left.`,
  ].join("\n");
}

/** The stand-down text: the car registered, or it was seen leaving. */
export function standDownMessage(c: Omit<BootContext, "minutesHere" | "enteredAt"> & { reason: "registered" | "left"; at: string }): string {
  const id = shortId(c.violationId);
  const why = c.reason === "registered"
    ? `registered a parking pass at ${clockET(c.at)}`
    : `was seen leaving at ${clockET(c.at)}`;
  return [`[STAND DOWN] ${c.propertyName}`, `Plate ${c.plate} ${why}. Do not boot.`, `Ref ${id}`].join("\n");
}

/** The violation alert to Gabe / Victor: the facts, no reply codes (those are the drivers'). */
export function alertMessage(c: BootContext & { exitCamera: boolean; driversTexted: number }): { subject: string; text: string } {
  const now = new Date(new Date(c.enteredAt).getTime() + c.minutesHere * 60_000);
  const lines = [
    `[VIOLATION] ${c.propertyName}`,
    `Plate ${c.plate}`,
    `In since ${clockETFrom(c.enteredAt, now)} (${c.minutesHere}m). No parking pass.`,
    ...(c.pauseEndedAt ? [`Held by an enforcement pause that ended at ${clockETFrom(c.pauseEndedAt, now)}.`] : []),
    ...(c.address ? [c.address] : []),
    `Boot allowed after ${clockETFrom(bootAllowedAfter(c.enteredAt), now)} (posted ${SIGN_WINDOW_MINUTES}-minute window).`,
    c.exitCamera
      ? (c.driversTexted > 0 ? `Drivers texted: ${c.driversTexted}.` : "No drivers texted (none on the roster).")
      : "No exit camera here: it may have left unseen. Drivers not texted.",
    `Ref ${shortId(c.violationId)}`,
  ];
  return { subject: `Violation: ${c.plate} at ${c.propertyName} (no parking pass, ${c.minutesHere} min)`, text: lines.join("\n") };
}

/** The cancellation to Gabe / Victor when a flagged car leaves or registers. */
export function alertCancelMessage(c: { propertyName: string; plate: string; violationId: string; reason: "registered" | "left"; at: string }): { subject: string; text: string } {
  const why = c.reason === "registered" ? `registered a parking pass at ${clockET(c.at)}` : `was seen leaving at ${clockET(c.at)}`;
  return {
    subject: `Cancelled: ${c.plate} at ${c.propertyName} (${c.reason === "registered" ? "registered" : "left"})`,
    text: [`[CANCELLED] ${c.propertyName}`, `Plate ${c.plate} ${why}. Violation dismissed.`, `Ref ${shortId(c.violationId)}`].join("\n"),
  };
}

/** Anyone to tell? Drivers or alert recipients. Nothing configured = the feature is off. */
export function bootEnabled(deps: BootDeps): boolean {
  return deps.phones.length > 0 || (deps.alertPhones?.length ?? 0) > 0 || (deps.alertEmails?.length ?? 0) > 0;
}

/** True when the session has sat in grace for the dispatch window. */
export function pastDispatchWindow(enteredAtIso: string, now: Date, minutes: number): boolean {
  const t = new Date(enteredAtIso).getTime();
  return Number.isFinite(t) && now.getTime() - t >= minutes * 60_000;
}

const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The entry's own rule: exact, or anchored-similar (one confusable edit, same length). */
export function plateCovers(registered: unknown, sessionPlate: string): boolean {
  const a = norm(registered);
  return !!a && !!sessionPlate && sameVehicle(a, sessionPlate, { kind: "registered" }).same;
}

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export function makeTwilioSender(t: { accountSid: string; authToken: string; from: string }) {
  return async (to: string, body: string, mediaUrls: string[]) => {
    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", t.from);
    form.set("Body", body);
    for (const m of mediaUrls) form.append("MediaUrl", m);
    const res = await fetch(`${TWILIO_API_BASE}/Accounts/${t.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${t.accountSid}:${t.authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.status >= 200 && res.status < 300, status: res.status, error: res.ok ? undefined : text.slice(0, 200) };
  };
}

async function sendToAll(deps: BootDeps, body: string, mediaUrls: string[], phones: string[] = deps.phones): Promise<{ sent: number; error: string | null }> {
  if (phones.length === 0) return { sent: 0, error: null };
  const send = deps.send ?? (deps.twilio ? makeTwilioSender(deps.twilio) : null);
  if (!send) return { sent: 0, error: "no_twilio" };
  let sent = 0;
  let error: string | null = null;
  for (const to of phones) {
    try {
      const r = await send(to, body, mediaUrls);
      if (r.ok) sent++;
      else error = `${r.status} ${r.error ?? ""}`.trim();
    } catch (e) {
      error = String(e).slice(0, 200);
    }
  }
  return { sent, error: sent > 0 ? null : (error ?? "unknown") };
}

export function makeResendSender(e: { apiKey: string; from: string }) {
  return async (to: string, subject: string, text: string) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: e.from, to: [to], subject, text }),
    });
    const t = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : t.slice(0, 200) };
  };
}

async function emailAll(deps: BootDeps, subject: string, text: string): Promise<{ sent: number; error: string | null }> {
  const to = deps.alertEmails ?? [];
  if (to.length === 0) return { sent: 0, error: null };
  const send = deps.sendEmail ?? (deps.email ? makeResendSender(deps.email) : null);
  if (!send) return { sent: 0, error: "no_resend" };
  let sent = 0;
  let error: string | null = null;
  for (const addr of to) {
    try {
      const r = await send(addr, subject, text);
      if (r.ok) sent++;
      else error = `${r.status} ${r.error ?? ""}`.trim();
    } catch (e) {
      error = String(e).slice(0, 200);
    }
  }
  return { sent, error: sent > 0 ? null : (error ?? "unknown") };
}

/** Text + email the alert recipients; never throws. */
async function alertAll(deps: BootDeps, msg: { subject: string; text: string }, mediaUrls: string[]): Promise<{ texts: number; emails: number; error: string | null }> {
  const t = await sendToAll(deps, msg.text, mediaUrls, deps.alertPhones ?? []);
  const e = await emailAll(deps, msg.subject, msg.text + (mediaUrls[0] ? `\nPhoto: ${mediaUrls[0]}` : ""));
  return { texts: t.sent, emails: e.sent, error: t.error ?? e.error };
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** Properties that may dispatch: an active camera that sees cars leave. Cached per tick. */
export async function exitCameraProperties(db: SupabaseClient, propertyIds: string[]): Promise<Set<string>> {
  if (propertyIds.length === 0) return new Set();
  const { data, error } = await db
    .from("alpr_cameras")
    .select("property_id,orientation,exit_order")
    .eq("active", true)
    .in("property_id", propertyIds);
  if (error) throw error;
  const ok = new Set<string>();
  for (const c of (data ?? []) as Array<{ property_id: string; orientation: string | null; exit_order: number | null }>) {
    if (c.orientation === "exit" || c.exit_order === 2) ok.add(c.property_id);
  }
  return ok;
}

type GraceRow = {
  id: string; property_id: string; normalized_plate: string; plate_text: string; entered_at: string;
  entry_plate_event_id: string;
  properties: { property_type: string; name: string | null; address: string | null } | { property_type: string; name: string | null; address: string | null }[];
};

/**
 * Grace sessions at apartments past the dispatch window: claim them to
 * expired, record the violation as a boot dispatch, text the drivers.
 * A property under an enforcement pause is left out in the query itself,
 * before the limit, and its sessions stay untouched in grace; the first run
 * after the pause ends picks them up. An unknown pause state holds them all.
 */
export async function bootDispatch(deps: BootDeps): Promise<{ dispatched: number; failed: number; skipped_no_exit_camera: number }> {
  const out = { dispatched: 0, failed: 0, skipped_no_exit_camera: 0 };
  if (!bootEnabled(deps)) return out;
  const alerting = (deps.alertPhones?.length ?? 0) > 0 || (deps.alertEmails?.length ?? 0) > 0;
  const { db } = deps;
  const now = deps.now ?? new Date();
  const minutes = deps.dispatchMinutes ?? GRACE_DISPATCH_MINUTES_DEFAULT;
  const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
  let q = db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,entered_at,entry_plate_event_id,properties!inner(property_type,name,address)")
    .eq("state", "grace")
    .is("exited_at", null)
    .is("exit_hinted_at", null)
    .is("violation_id", null)
    .lt("entered_at", cutoff)
    .eq("properties.property_type", "apartment");
  if (deps.pauses) q = excludePaused(q, deps.pauses, "properties.property_type");
  const { data, error } = await q.limit(BOOT_MAX_PER_TICK);
  if (error) throw error;
  const rows = ((data ?? []) as GraceRow[]).filter(s => one(s.properties)?.property_type === "apartment");
  const canDispatch = await exitCameraProperties(db, [...new Set(rows.map(s => s.property_id))]);
  for (const s of rows) {
    const prop = one(s.properties)!;
    if (!pastDispatchWindow(s.entered_at, now, minutes)) continue;
    const exitCamera = canDispatch.has(s.property_id);
    // No exit camera: drivers are never sent (they could roll to an empty
    // space). Without alert recipients there is no one else to tell, so the
    // visit is left in grace exactly as before.
    if (!exitCamera) { out.skipped_no_exit_camera++; if (!alerting) continue; }
    // Claim first; another tick, the camera, or a registration may have moved it.
    const claim = await db.from("plate_sessions")
      .update({ state: "expired", updated_at: now.toISOString() })
      .eq("id", s.id).eq("state", "grace").is("exited_at", null).is("violation_id", null)
      .select("id");
    if (claim.error) throw claim.error;
    if (!claim.data || claim.data.length === 0) continue;

    const minutesHere = Math.max(0, Math.round((now.getTime() - new Date(s.entered_at).getTime()) / 60_000));
    const nowIso = now.toISOString();
    const vIns = await db.from("alpr_violations").insert({
      property_id: s.property_id,
      plate_event_id: s.entry_plate_event_id,
      plate_text: s.plate_text,
      status: "dispatched",
      violation_type: "unregistered",
      session_id: s.id,
      action_channel: BOOT_CHANNEL,
      dispatched_at: nowIso,
      sms_sent_at: nowIso,
      dispatch_attempts: 1,
      notes: `${exitCamera && deps.phones.length > 0 ? "Boot dispatch to LotLogic drivers" : "Violation alert"} at ${minutes} min with no parking pass${exitCamera ? "" : " (no exit camera: drivers not texted)"}. Sign window ${SIGN_WINDOW_MINUTES} min: boot allowed after ${bootAllowedAfter(s.entered_at)}. Entered ${s.entered_at}. cron-sessions-sweep.`,
    }).select("id").single();
    if (vIns.error) throw vIns.error;
    const violationId = vIns.data.id as string;
    const sUpd = await db.from("plate_sessions").update({ violation_id: violationId, updated_at: nowIso }).eq("id", s.id);
    if (sUpd.error) throw sUpd.error;

    const { data: ev } = await db.from("plate_events").select("image_url").eq("id", s.entry_plate_event_id).maybeSingle();
    const photo = (ev as { image_url?: string | null } | null)?.image_url ?? null;
    // Held by a pause: its dispatch minute fell before the pause ended.
    const dueAt = new Date(new Date(s.entered_at).getTime() + minutes * 60_000).toISOString();
    const pauseEndedAt = deps.pauses ? heldThroughPause(deps.pauses, s.property_id, dueAt) : null;
    const ctx = {
      propertyName: prop.name || "Property", address: prop.address ?? null, plate: s.plate_text,
      enteredAt: s.entered_at, minutesHere, violationId, pauseEndedAt,
    };
    const media = photo ? [photo] : [];
    const r = exitCamera ? await sendToAll(deps, bootMessage(ctx), media) : { sent: 0, error: null };
    const a = alerting ? await alertAll(deps, alertMessage({ ...ctx, exitCamera, driversTexted: r.sent }), media) : { texts: 0, emails: 0, error: null };
    if (r.sent > 0 || a.texts > 0 || a.emails > 0) {
      out.dispatched++;
      console.log(`boot_dispatch violation=${violationId} session=${s.id} drivers=${r.sent} alert_texts=${a.texts} alert_emails=${a.emails}${exitCamera ? "" : " no_exit_camera"}`);
    } else {
      out.failed++;
      const err = r.error ?? a.error ?? "nothing sent";
      await db.from("alpr_violations").update({ status: "dispatch_failed", last_dispatch_error: err }).eq("id", violationId);
      console.warn(`boot_dispatch send failed violation=${violationId} err=${err}`);
    }
  }
  return out;
}

type BootViolation = {
  id: string; session_id: string | null; property_id: string; plate_text: string; left_before_tow_at: string | null; dispatched_at: string | null;
  plate_sessions: { id: string; normalized_plate: string; exited_at: string | null; state: string } | { id: string; normalized_plate: string; exited_at: string | null; state: string }[] | null;
  properties: { name: string | null; address: string | null } | { name: string | null; address: string | null }[] | null;
};

async function openBootViolations(db: SupabaseClient): Promise<BootViolation[]> {
  const { data, error } = await db
    .from("alpr_violations")
    .select("id,session_id,property_id,plate_text,left_before_tow_at,dispatched_at,plate_sessions!alpr_violations_session_id_fkey(id,normalized_plate,exited_at,state),properties(name,address)")
    .eq("action_channel", BOOT_CHANNEL)
    .eq("status", "dispatched")
    .is("left_before_tow_email_sent_at", null)
    .limit(50);
  if (error) throw error;
  return (data ?? []) as BootViolation[];
}

async function standDown(deps: BootDeps, v: BootViolation, reason: "registered" | "left" | "stale", at: string, patch: Record<string, unknown>) {
  const prop = one(v.properties);
  const nowIso = (deps.now ?? new Date()).toISOString();
  // Claim the row before any text goes out: two ticks must not both stand down.
  const upd = await deps.db.from("alpr_violations")
    .update({ ...patch, left_before_tow_email_sent_at: nowIso })
    .eq("id", v.id).eq("status", "dispatched")
    .select("id");
  if (upd.error) throw upd.error;
  if (!upd.data || upd.data.length === 0) return false;
  if (reason === "stale") {
    console.log(`boot_stale violation=${v.id} dismissed after ${deps.staleHours ?? BOOT_STALE_HOURS_DEFAULT}h with no reply`);
    return true;
  }
  const body = standDownMessage({ propertyName: prop?.name || "Property", address: prop?.address ?? null, plate: v.plate_text, violationId: v.id, reason, at });
  const r = await sendToAll(deps, body, []);
  const a = await alertAll(deps, alertCancelMessage({ propertyName: prop?.name || "Property", plate: v.plate_text, violationId: v.id, reason, at }), []);
  console.log(`boot_stand_down violation=${v.id} reason=${reason} drivers=${r.sent} alert_texts=${a.texts} alert_emails=${a.emails}${r.error ?? a.error ? ` err=${r.error ?? a.error}` : ""}`);
  return true;
}

/**
 * A live visitor pass or approved resident plate at the property that covers
 * the plate, by the entry's fuzzy rule, over the front and back plate.
 */
export async function findCoveringPass(db: SupabaseClient, propertyId: string, plate: string, now: Date): Promise<{ kind: "pass" | "resident"; id: string } | null> {
  const { data: passes } = await db.from("visitor_passes")
    .select("id,plate_text,back_plate,valid_from,valid_until,cancelled_at,status")
    .eq("property_id", propertyId).is("cancelled_at", null).in("status", ["active", "approved"]);
  const pass = (passes ?? []).find((p: { plate_text?: string; back_plate?: string | null; valid_from?: string; valid_until?: string }) => {
    if (!plateCovers(p.plate_text, plate) && !plateCovers(p.back_plate, plate)) return false;
    if (p.valid_from && new Date(p.valid_from) > now) return false;
    return !!p.valid_until && new Date(p.valid_until) > now;
  });
  if (pass) return { kind: "pass", id: pass.id };
  const { data: res } = await db.from("resident_plates").select("id,plate_text,back_plate,status,active")
    .eq("property_id", propertyId).eq("active", true);
  const resident = (res ?? []).find((r: { plate_text?: string; back_plate?: string | null; status?: string }) =>
    (r.status ?? "approved") === "approved"
    && (plateCovers(r.plate_text, plate) || plateCovers(r.back_plate, plate)));
  return resident ? { kind: "resident", id: resident.id } : null;
}

/**
 * A dispatched car that now holds a pass: back to registered / resident,
 * the violation dismissed, the drivers stood down. Same fuzzy plate rule
 * as the entry, over visitor passes and resident plates.
 */
export async function bootRegistrations(deps: BootDeps): Promise<number> {
  if (!bootEnabled(deps)) return 0;
  const { db } = deps;
  const now = deps.now ?? new Date();
  let count = 0;
  for (const v of await openBootViolations(db)) {
    const sess = one(v.plate_sessions);
    if (!sess || sess.exited_at || sess.state !== "expired") continue;
    const cover = await findCoveringPass(db, v.property_id, sess.normalized_plate, now);
    if (!cover) continue;
    const nowIso = now.toISOString();
    const flip = await db.from("plate_sessions").update({
      state: cover.kind === "pass" ? "registered" : "resident",
      ...(cover.kind === "pass" ? { visitor_pass_id: cover.id } : { resident_plate_id: cover.id }),
      updated_at: nowIso,
    }).eq("id", sess.id).eq("state", "expired").select("id");
    if (flip.error) throw flip.error;
    if (!flip.data || flip.data.length === 0) continue;
    if (await standDown(deps, v, "registered", nowIso, {
      status: "dismissed", action_taken: "no_tow", action_channel: BOOT_CHANNEL, action_at: nowIso, resolved_at: nowIso,
    })) count++;
  }
  return count;
}

/**
 * A dispatched car that was seen leaving (either exit path): the drivers
 * stood down, the violation dismissed. A dispatch nobody resolved within
 * BOOT_STALE_HOURS is dismissed without a text, so its session can close.
 */
export async function bootStandDowns(deps: BootDeps): Promise<{ stood_down: number; stale: number }> {
  const out = { stood_down: 0, stale: 0 };
  if (!bootEnabled(deps)) return out;
  const { db } = deps;
  const now = deps.now ?? new Date();
  const staleMs = (deps.staleHours ?? BOOT_STALE_HOURS_DEFAULT) * 3_600_000;
  for (const v of await openBootViolations(db)) {
    const sess = one(v.plate_sessions);
    const leftAt = v.left_before_tow_at ?? sess?.exited_at ?? null;
    const nowIso = now.toISOString();
    if (leftAt) {
      if (await standDown(deps, v, "left", leftAt, {
        status: "dismissed", action_taken: "no_tow", action_channel: BOOT_CHANNEL, action_at: nowIso, resolved_at: nowIso,
        left_before_tow_at: v.left_before_tow_at ?? leftAt,
      })) out.stood_down++;
      continue;
    }
    const dispatchedMs = v.dispatched_at ? new Date(v.dispatched_at).getTime() : NaN;
    if (Number.isFinite(dispatchedMs) && now.getTime() - dispatchedMs >= staleMs) {
      if (await standDown(deps, v, "stale", nowIso, {
        status: "dismissed", action_taken: "no_tow", action_channel: BOOT_CHANNEL, action_at: nowIso, resolved_at: nowIso,
        last_dispatch_error: "stale: no driver reply",
      })) out.stale++;
    }
  }
  return out;
}
