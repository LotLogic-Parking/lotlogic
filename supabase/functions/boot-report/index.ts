// boot-report: the boot's LTE check-in, and (since 5 Nov 2026) the ONLY way commands reach a boot: there is no Bluetooth.
//   POST /boot-report
//   X-Boot-Id:  <boot uuid>
//   X-Boot-Sig: hex(HMAC-SHA256(secret, raw request body))
// Reply: {"sig":"<64 hex>","reply":<reply JSON>}, sig = HMAC(secret, exact bytes of <reply JSON>), echoing the request
// nonce, so the boot can trust ack_seq / next_report_s / cmd even if the modem does not verify TLS certificates.
// Commands (LOCK / UNLOCK / PULSE_TEST / CLEAR_TAMPER) are queued in boot_commands by the driver portal, a payment or a
// waiver. The reply carries the pending one, signed over THIS report's nonce: mac = HMAC(secret, boot_id||nonce||cmd).
// Long-poll: a report with "wait_s" (1..25) is held open until a command is queued or the time runs out.
// Deploy with verify_jwt = false (the boot has no Supabase key; the HMAC is the auth).
import {
  admin, batteryPct, bytesToBytea, bytesToHex, checkInS, CMD, CMD_ACTION, commandMac, ctEqual, hexToBytes, hmac, HttpError, json,
  loadSecret, sendSms,
} from "../_shared/boot.ts";
import { ingestDeviceEvents, parseEvents } from "../_shared/events.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const MAX_BODY = 16 * 1024;
const MAX_WAIT_S = 25;
const MAX_ATTEMPTS = 3;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// CORS only so the bench/simulator page can talk to it; the HMAC is the auth, not the origin.
const BOOT_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-boot-id, x-boot-sig",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-server-sig",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: BOOT_CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, BOOT_CORS);
  const db = admin();
  try {
    const bootId = (req.headers.get("x-boot-id") ?? "").trim().toLowerCase();
    const sigHex = (req.headers.get("x-boot-sig") ?? "").trim();
    if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(bootId)) throw new HttpError(401, "bad_boot_id");
    if (!/^[0-9a-fA-F]{64}$/.test(sigHex)) throw new HttpError(401, "bad_sig");
    const id = bootId.includes("-") ? bootId
      : `${bootId.slice(0, 8)}-${bootId.slice(8, 12)}-${bootId.slice(12, 16)}-${bootId.slice(16, 20)}-${bootId.slice(20)}`;

    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.length > MAX_BODY) throw new HttpError(413, "too_large");

    const secret = await loadSecret(db, id);
    if (!secret) throw new HttpError(401, "bad_sig"); // same answer as a bad signature: don't reveal which boots exist
    if (!ctEqual(await hmac(secret, raw), hexToBytes(sigHex))) throw new HttpError(401, "bad_sig");

    let body: Record<string, any>;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new HttpError(400, "bad_json"); }

    const reportSeq = Number(body.report_seq);
    if (!Number.isSafeInteger(reportSeq) || reportSeq < 1) throw new HttpError(400, "report_seq_required");
    if (typeof body.nonce !== "string" || !/^[0-9a-fA-F]{32}$/.test(body.nonce)) throw new HttpError(400, "nonce_required");
    const nonce = hexToBytes(body.nonce);
    const bodyHash = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));

    // The SIM70x0's HTTP stack can't read response headers, so the signature travels in the body:
    //   {"sig":"<64 hex>","reply":<reply JSON>}   sig = HMAC(secret, exact bytes of <reply JSON>)
    // Fixed layout: the boot takes bytes [82, len-1) as the reply text. X-Server-Sig carries the same value.
    const signed = async (reply: Record<string, unknown>, status = 200) => {
      const text = JSON.stringify(reply);
      const sig = bytesToHex(await hmac(secret, enc.encode(text)));
      return new Response(`{"sig":"${sig}","reply":${text}}`, {
        status, headers: { "Content-Type": "application/json", "X-Server-Sig": sig, ...BOOT_CORS },
      });
    };

    // Replay guard: report_seq must go up. An identical retry of the last report gets its stored reply back.
    const { data: claimed, error: claimErr } = await db.from("boots")
      .update({ last_report_seq: reportSeq }).eq("id", id).lt("last_report_seq", reportSeq).select("*").maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) {
      const { data: prev } = await db.from("boot_reports").select("body_sha256, reply")
        .eq("boot_id", id).eq("report_seq", reportSeq).maybeSingle();
      if (prev?.reply && prev.body_sha256 === bodyHash) return signed(prev.reply);
      const { data: b } = await db.from("boots").select("last_report_seq").eq("id", id).single();
      return signed({ ok: false, error: "replay", nonce: body.nonce, last_report_seq: b?.last_report_seq ?? null }, 409);
    }
    const boot = claimed;
    if (!boot.active) return signed({ ok: false, error: "retired", nonce: body.nonce }, 410);

    const now = new Date();
    const uptime = Number.isFinite(Number(body.uptime_s)) ? Number(body.uptime_s) : null;
    const vbat = Number.isFinite(Number(body.vbat_mv)) ? Number(body.vbat_mv) : null;
    const gps = body.gps && typeof body.gps === "object" ? body.gps : null;
    const lat = Number(gps?.lat), lon = Number(gps?.lon), age = Number(gps?.age_s ?? 0);
    const hasFix = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    const state: number | null = [0, 1, 2, 3].includes(Number(body.state)) ? Number(body.state) : boot.state;

    const patch: Record<string, unknown> = {
      last_report_at: now.toISOString(),
      state,
      flags: Number.isInteger(Number(body.flags)) ? Number(body.flags) : boot.flags,
      fw: Number.isInteger(Number(body.fw)) ? Number(body.fw) : boot.fw,
      csq: Number.isInteger(Number(body.csq)) ? Number(body.csq) : boot.csq,
      rsrp_dbm: Number.isInteger(Number(body.rsrp_dbm)) ? Number(body.rsrp_dbm) : boot.rsrp_dbm,
    };
    if (vbat != null) {
      patch.vbat_mv = vbat;
      patch.battery_pct = Number.isInteger(Number(body.pct)) ? Number(body.pct) : batteryPct(vbat);
    }
    if (hasFix) {
      patch.lat = lat; patch.lon = lon;
      patch.fix_at = new Date(now.getTime() - (Number.isFinite(age) ? age : 0) * 1000).toISOString();
    }
    await db.from("boots").update(patch).eq("id", id);
    const { data: reportRow } = await db.from("boot_reports")
      .insert({ boot_id: id, report_seq: reportSeq, body, body_sha256: bodyHash }).select("id").single();

    const events = parseEvents(body.events);
    const ackSeq = await ingestDeviceEvents(db, id, events, "lte", uptime, now);

    // 1. Settle the command the boot was last given, from the state it reports now.
    await settleDelivered(db, id, state, events, now);

    // 2. Safety net: paid/waived but still locked and nothing pending -> queue the unlock.
    const { data: dep } = await db.from("boot_deployments").select("id, status")
      .eq("boot_id", id).in("status", ["locking", "active", "release_authorized"]).maybeSingle();
    if (dep?.status === "release_authorized" && (state === 0 || state === 3)) {
      const { data: pending } = await db.from("boot_commands").select("id")
        .eq("boot_id", id).in("status", ["queued", "delivered"]).maybeSingle();
      if (!pending) {
        await db.rpc("boot_queue_command", {
          p_boot_id: id, p_deployment_id: dep.id, p_cmd: CMD.UNLOCK, p_source: "system", p_member: null,
          p_ttl_s: null, p_note: "release authorized, boot still locked",
        });
      }
    }

    // 3. Deliver the pending command (long-poll for one if the boot asked to wait).
    const waitS = Math.max(0, Math.min(MAX_WAIT_S, Number(body.wait_s) || 0));
    const deadline = Date.now() + waitS * 1000;
    let cmd = await deliver(db, id, state, nonce, secret, reportSeq);
    while (!cmd && Date.now() < deadline) {
      await sleep(1000);
      cmd = await deliver(db, id, state, nonce, secret, reportSeq);
    }

    const reply = {
      ok: true,
      nonce: body.nonce,                 // binds this reply to this request
      report_seq: reportSeq,
      ack_seq: ackSeq,                   // highest device event seq the server has; the boot may drop events <= this
      // After a command: report the result right away. On a car: less often, to save the battery (checkInS).
      next_report_s: cmd ? 5 : checkInS(boot, dep?.status),
      server_time: Math.floor(Date.now() / 1000),
      cmd,
    };
    if (reportRow) await db.from("boot_reports").update({ reply }).eq("id", reportRow.id);
    return signed(reply);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.code }, e.status, BOOT_CORS);
    console.error(e);
    return json({ ok: false, error: "internal" }, 500, BOOT_CORS);
  }
});

/** Mark the delivered command done / failed from the boot's reported state and any refusal events in this report. */
async function settleDelivered(db: SupabaseClient, bootId: string, state: number | null, events: { event: number; result?: number }[], now: Date) {
  const { data: c } = await db.from("boot_commands").select("*").eq("boot_id", bootId).eq("status", "delivered").maybeSingle();
  if (!c) return;
  const refused = events.find((e) => e.event === 0x11 || e.event === 0x41);
  let done = false;
  if (c.cmd === CMD.LOCK) done = state === 0;
  else if (c.cmd === CMD.UNLOCK) done = state === 1 || state === 2;
  else done = events.some((e) => e.event === c.cmd && (e.result ?? 0) === 0);

  if (done) {
    await markDone(db, c, now, ["delivered"]);
  } else if (refused) {
    const code = refused.event === 0x41 ? 0x02 : (refused.result ?? 0);
    await db.from("boot_commands").update({ status: "failed", completed_at: now.toISOString(), device_result: code })
      .eq("id", c.id).eq("status", "delivered");
    // A refused lock means no car is booted: close the deployment so the driver can start again.
    if (c.cmd === CMD.LOCK && c.deployment_id) {
      await db.from("boot_deployments").update({
        status: "cancelled", cancelled_at: now.toISOString(),
        notes: `lock refused by boot, result 0x${code.toString(16).padStart(2, "0")}`,
      }).eq("id", c.deployment_id).eq("status", "locking");
    }
  }
}

/** Expire stale commands, then hand the pending one to the boot, signed over this report's nonce. */
async function deliver(db: SupabaseClient, bootId: string, state: number | null, nonce: Uint8Array, secret: Uint8Array, reportSeq: number) {
  const nowIso = new Date().toISOString();
  const { data: c } = await db.from("boot_commands").select("*").eq("boot_id", bootId)
    .in("status", ["queued", "delivered"]).maybeSingle();
  if (!c) return null;

  if (c.status === "queued" && c.expires_at && c.expires_at < nowIso) {
    await db.from("boot_commands").update({ status: "expired", completed_at: nowIso, note: "boot did not check in in time" })
      .eq("id", c.id).eq("status", "queued");
    if (c.cmd === CMD.LOCK && c.deployment_id) {
      await db.from("boot_deployments").update({ status: "cancelled", cancelled_at: nowIso, notes: "lock expired: boot offline" })
        .eq("id", c.deployment_id).eq("status", "locking");
    }
    return null;
  }
  // Already where the command wants it (e.g. unlock queued but the boot is already open): nothing to send, settle it now
  // so the deployment moves on instead of waiting for a command that will never be delivered.
  if ((c.cmd === CMD.LOCK && state === 0) || (c.cmd === CMD.UNLOCK && (state === 1 || state === 2))) {
    await markDone(db, c, new Date(), ["queued", "delivered"], "boot already in that state");
    return null;
  }
  if (c.attempts >= MAX_ATTEMPTS) {
    await db.from("boot_commands").update({ status: "failed", completed_at: nowIso, note: "no result after 3 deliveries" })
      .eq("id", c.id).in("status", ["queued", "delivered"]);
    return null;
  }

  const { data: claimed } = await db.from("boot_commands")
    .update({ status: "delivered", delivered_at: nowIso, delivered_report_seq: reportSeq, attempts: c.attempts + 1 })
    .eq("id", c.id).eq("attempts", c.attempts).select("id").maybeSingle();
  if (!claimed) return null; // raced with another report

  const mac = await commandMac(secret, bootId, nonce, c.cmd);
  await db.from("boot_events").insert({
    boot_id: bootId, deployment_id: c.deployment_id, source: "server", transport: "lte", action: CMD_ACTION[c.cmd],
    cmd: c.cmd, actor_member_id: c.requested_by, nonce: bytesToBytea(nonce),
    details: { command_id: c.id, attempt: c.attempts + 1, source: c.source, report_seq: reportSeq },
  });
  return { cmd: c.cmd, mac: bytesToHex(mac), command_id: c.id };
}

/** Command finished: close it and move its deployment on (LOCK -> active, UNLOCK -> unlocked). */
async function markDone(db: SupabaseClient, c: Record<string, any>, now: Date, from: string[], note?: string) {
  const patch: Record<string, unknown> = { status: "done", completed_at: now.toISOString() };
  if (note) patch.note = note;
  const { data: closed } = await db.from("boot_commands").update(patch).eq("id", c.id).in("status", from).select("id").maybeSingle();
  if (!closed) return;
  // "Close for storage" confirmed: stamp the boot so the portal shows it as stored and ready for the next car.
  if (c.cmd === CMD.LOCK && c.purpose === "store") {
    await db.from("boots").update({ stored_at: now.toISOString() }).eq("id", c.boot_id);
  }
  if (!c.deployment_id) return;
  if (c.cmd === CMD.LOCK) {
    await db.from("boot_deployments").update({ status: "active", lock_confirmed_at: now.toISOString() })
      .eq("id", c.deployment_id).eq("status", "locking");
  } else if (c.cmd === CMD.UNLOCK) {
    const { data: dep } = await db.from("boot_deployments")
      .update({ status: "unlocked", unlocked_at: now.toISOString(), unlock_transport: "lte" })
      .eq("id", c.deployment_id).in("status", ["release_authorized", "active", "locking"])
      .select("id, boot_id, plate_text, property_id, applied_by").maybeSingle();
    if (dep) await pickupAlert(db, dep);
  }
}

/** The boot opened off a car: text the agent who placed it to come and collect it (once, when it opens). */
async function pickupAlert(db: SupabaseClient, dep: Record<string, any>) {
  if (!dep.applied_by) return;
  const [{ data: m }, { data: b }, { data: p }] = await Promise.all([
    db.from("partner_members").select("phone, removed_at").eq("id", dep.applied_by).maybeSingle(),
    db.from("boots").select("label").eq("id", dep.boot_id).maybeSingle(),
    dep.property_id ? db.from("properties").select("name").eq("id", dep.property_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!m?.phone || m.removed_at) return;
  const at = p?.name ? ` at ${p.name}` : "";
  const r = await sendSms(m.phone, `LotLogic: ${b?.label ?? "Your boot"} is open and off ${dep.plate_text}${at}. Pick it up and close it for storage.`);
  await db.from("boot_events").insert({
    boot_id: dep.boot_id, deployment_id: dep.id, source: "server", action: "pickup_alert", actor_member_id: null,
    details: { to_member: dep.applied_by, sent: r.sent, reason: r.reason ?? null },
  });
}
