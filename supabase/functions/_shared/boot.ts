// Shared helpers for the Smart Boot edge functions.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const CMD = { UNLOCK: 0x01, LOCK: 0x02, PULSE_TEST: 0x03, CLEAR_TAMPER: 0x10, TEST_MODE: 0x20, SETUP_WIFI: 0x50 } as const;
export const CMD_ACTION: Record<number, string> = {
  0x01: "unlock", 0x02: "lock", 0x03: "pulse_test", 0x10: "clear_tamper", 0x20: "test_mode", 0x50: "setup_wifi",
};
// Device event codes (FIRMWARE_AND_BACKEND.md 5.6). Unknown codes are stored as "event_0xNN".
export const EVENT_ACTION: Record<number, string> = {
  0x01: "unlock", 0x02: "lock", 0x03: "pulse_test", 0x10: "clear_tamper", 0x11: "rejected",
  0x20: "power_on", 0x21: "fault_interrupted", 0x30: "lte_ok", 0x31: "lte_fail",
  0x22: "move_stats", 0x40: "low_batt", 0x41: "lock_refused_batt",
  0x50: "wifi_setup_open", 0x51: "jog", 0x52: "config",
};

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

// ---------------------------------------------------------------- bytes
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^\\x/, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2) throw new HttpError(400, "bad_hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function b64ToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "===".slice((norm.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new HttpError(400, "bad_boot_id");
  return hexToBytes(hex);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Constant-time comparison. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function hmac(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}

/** mac = HMAC-SHA256(secret, boot_id[16] || nonce[16] || cmd[1]) — identical for BLE and LTE commands. */
export async function commandMac(secret: Uint8Array, bootId: string, nonce: Uint8Array, cmd: number) {
  if (nonce.length !== 16) throw new HttpError(400, "bad_nonce", "nonce must be 16 bytes");
  return hmac(secret, concat(uuidToBytes(bootId), nonce, new Uint8Array([cmd & 0xff])));
}

/** Postgres bytea comes back from PostgREST as "\\x…" hex. */
export function byteaToBytes(v: string): Uint8Array {
  return hexToBytes(v.startsWith("\\x") ? v.slice(2) : v);
}
export function bytesToBytea(b: Uint8Array): string {
  return "\\x" + bytesToHex(b);
}

/** Setup Wi-Fi on the boot (firmware 0x91+): SSID from the boot id, WPA2 password = first 16 hex of
 *  HMAC-SHA256(secret, "lotlogic-wifi-ap"). Must match firmware config.h WIFI_SSID_PREFIX / WIFI_PASS_LABEL. */
export function wifiSsid(bootId: string): string {
  return "LL-Boot-" + bootId.replace(/-/g, "").slice(-6).toUpperCase();
}
export async function wifiPassword(secret: Uint8Array): Promise<string> {
  return bytesToHex(await hmac(secret, new TextEncoder().encode("lotlogic-wifi-ap"))).slice(0, 16);
}

// ---------------------------------------------------------------- check-in interval
// A boot stays switched on while it is on a car (Victor, 27 Nov: no more "switch it off after locking"). To save
// its one 18650, the server tells it to check in less often while a placement is open. The trade-off is the
// release: a paid boot hears about it on its next check-in, so up to this long after payment.
const ON_CAR_POLL_DEFAULT_S = 180;
export function onCarPollS(): number {
  const v = Number(Deno.env.get("BOOT_ON_CAR_POLL_S"));
  return Number.isInteger(v) && v >= 30 && v <= 900 ? v : ON_CAR_POLL_DEFAULT_S;
}
/** How often this boot is told to check in: the on-car interval while a placement is open, else its poll_s. */
export function checkInS(boot: { poll_s: number }, depStatus: string | null | undefined): number {
  return depStatus && ["locking", "active", "release_authorized"].includes(depStatus) ? onCarPollS() : boot.poll_s;
}

// ---------------------------------------------------------------- phone numbers and SMS
/** A US number as E.164 (+1XXXXXXXXXX), an already-E.164 number as is, anything else null. Square refuses bare digits. */
export function e164(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

/**
 * Text one number through Twilio. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and BOOT_SMS_FROM (the boot line,
 * +19809904401) as edge secrets; without them it does nothing and says so. Never throws: an alert must not break
 * the request that triggered it.
 */
export async function sendSms(to: string, body: string): Promise<{ sent: boolean; reason?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), token = Deno.env.get("TWILIO_AUTH_TOKEN"), from = Deno.env.get("BOOT_SMS_FROM");
  if (!sid || !token || !from) return { sent: false, reason: "sms_not_configured" };
  const num = e164(to);
  if (!num) return { sent: false, reason: "bad_number" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: num, From: from, Body: body }),
    });
    if (!res.ok) { console.error("twilio", res.status, await res.text().catch(() => "")); return { sent: false, reason: `twilio_${res.status}` }; }
    return { sent: true };
  } catch (e) {
    console.error("twilio", e);
    return { sent: false, reason: "twilio_unreachable" };
  }
}

export async function loadSecret(db: SupabaseClient, bootId: string): Promise<Uint8Array | null> {
  const { data, error } = await db.from("boot_secrets").select("secret").eq("boot_id", bootId).maybeSingle();
  if (error) throw error;
  return data ? byteaToBytes(data.secret as string) : null;
}

// ---------------------------------------------------------------- battery %, one Li-ion cell at rest (rev 8: T-SIM7000G, one 18650;
// same table as firmware battery.cpp). The rev 6 3S table was 12600..9900.
const PCT_TABLE: [number, number][] = [
  [4200, 100], [4100, 90], [4000, 80], [3920, 70], [3850, 60], [3780, 50],
  [3720, 40], [3660, 30], [3600, 20], [3500, 10], [3300, 0],
];
export function batteryPct(mv: number | null | undefined): number | null {
  if (mv == null || !Number.isFinite(mv)) return null;
  if (mv >= PCT_TABLE[0][0]) return 100;
  for (let i = 1; i < PCT_TABLE.length; i++) {
    const [hiMv, hiP] = PCT_TABLE[i - 1], [loMv, loP] = PCT_TABLE[i];
    if (mv >= loMv) return Math.round(loP + ((mv - loMv) * (hiP - loP)) / (hiMv - loMv));
  }
  return 0;
}
