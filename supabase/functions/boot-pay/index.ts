// boot-pay: the motorist side. Public (verify_jwt = false).
//   GET  /boot-pay?code=XXXX                      what the pay page shows: plate, property, fee, release progress.
//                                                 XXXX = the placement's 4-character pay code (boot_deployments.pay_code),
//                                                 written on the boot sticker by the agent; every sticker's QR goes to
//                                                 boot-release.vercel.app (repo boot-release/). An 8-character code is a
//                                                 boot's own qr_code (the older per-boot stickers) and still works.
//   GET  /boot-pay?plate=ABC123                   "lost the code?": the open placements on that plate -> [{pay_code, ...}]
//   POST /boot-pay  {code, action:"checkout", phone?, email?}   -> {checkout_url} (Square payment link)
//   POST /boot-pay/square-webhook                 Square payment.* and refund.* webhooks (signature checked)
//   POST /boot-pay  {code, action:"dev_pay"}      test-only fake payment; refused on production
// Paying moves the deployment to release_authorized; the boot picks the unlock up on its next LTE report.
// Processing: the webhook is the main path. If a webhook is late or lost, the page's status poll asks Square for the
// order directly (at most every 15 s per deployment), so a paid motorist is never stuck waiting on a webhook.
// Refunds are issued in the Square dashboard; the refund.* webhooks record them. A refund never re-locks a boot.
//
// Edge secrets:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV (production|sandbox, default sandbox)
//   SQUARE_WEBHOOK_SIGNATURE_KEY
//   SQUARE_WEBHOOK_URL  the exact notification URL registered in Square (default: <SUPABASE_URL>/functions/v1/boot-pay/square-webhook)
//   BOOT_PAY_PAGE_URL   where Square sends the payer back for a boot qr_code checkout, e.g. https://pay.lotlogic.example/boot
//   BOOT_PAY_LANDING_URL  where Square sends the payer back for a pay-code checkout (default https://boot-release.vercel.app)
import { admin, CORS, hmac, HttpError, json } from "../_shared/boot.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const PROD_REF = "nzdkoouoaedbbccraoti";
const SQUARE_VERSION = "2025-01-23";
const isProd = () => (Deno.env.get("SUPABASE_URL") ?? "").includes(PROD_REF);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const db = admin();
  const url = new URL(req.url);
  try {
    if (url.pathname.endsWith("/square-webhook")) return await squareWebhook(db, req);
    if (req.method === "GET") {
      if (url.searchParams.has("plate")) return json(await byPlate(db, url.searchParams.get("plate")));
      return json(await view(db, url.searchParams.get("code")));
    }
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await req.json().catch(() => ({}));
    if (body.action === "checkout") return json(await checkout(db, body));
    if (body.action === "dev_pay") return json(await devPay(db, body));
    throw new HttpError(400, "bad_action");
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ ok: false, error: "internal" }, 500);
  }
});

const BOOT_COLS = "id, label, qr_code, partner_id, state, last_report_at, poll_s, return_instructions, active";
/** A placement's pay code: the site-code alphabet (no 0/O, 1/I/L), 4 characters. */
const PAY_CODE = /^[A-HJKMNP-Z2-9]{4}$/;
const OPEN = ["locking", "active", "release_authorized"];

/**
 * A 4-character pay code names one placement (and so its boot); an 8-character code is a boot's qr_code, which
 * shows that boot's open placement, else its latest. byPayCode is true for the first: the page and the Square
 * return link then carry the pay code.
 */
async function findByCode(db: SupabaseClient, code: unknown) {
  const c = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (PAY_CODE.test(c)) {
    const { data: dep } = await db.from("boot_deployments").select("*").eq("pay_code", c).maybeSingle();
    if (!dep || dep.status === "cancelled") throw new HttpError(404, "unknown_code");
    const { data: boot } = await db.from("boots").select(BOOT_COLS).eq("id", dep.boot_id).maybeSingle();
    if (!boot) throw new HttpError(404, "unknown_code");
    return { boot, dep, byPayCode: true };
  }
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(c)) throw new HttpError(404, "unknown_boot");
  const { data: boot } = await db.from("boots").select(BOOT_COLS).eq("qr_code", c).maybeSingle();
  if (!boot || !boot.active) throw new HttpError(404, "unknown_boot");
  // The open deployment, else the most recent one (so the page still shows "released" after the unlock).
  const { data: deps } = await db.from("boot_deployments").select("*").eq("boot_id", boot.id)
    .order("created_at", { ascending: false }).limit(1);
  return { boot, dep: deps?.[0] ?? null, byPayCode: false };
}

/**
 * "Lost the code?": the motorist types their plate and gets the pay code of each open placement on it (normally
 * one). Exact plate only, open placements only, and nothing beyond what the pay page would show for that code.
 */
async function byPlate(db: SupabaseClient, raw: string | null) {
  const plate = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (plate.length < 2) throw new HttpError(400, "plate_required", "Enter your plate.");
  const { data, error } = await db.from("boot_deployments")
    .select("pay_code, plate_text, plate_state, vehicle_color, vehicle_make, vehicle_model, property_id, applied_at")
    .eq("plate_text", plate).in("status", OPEN).order("applied_at", { ascending: false }).limit(3);
  if (error) { console.error("byPlate", error); throw new HttpError(503, "lookup_unavailable"); }
  const ids = [...new Set((data ?? []).map((d) => d.property_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: props } = await db.from("properties").select("id, name").in("id", ids);
    for (const p of props ?? []) names.set(p.id, p.name);
  }
  return {
    ok: true,
    matches: (data ?? []).filter((d) => d.pay_code).map((d) => ({
      pay_code: d.pay_code, plate: maskPlate(d.plate_text), plate_state: d.plate_state,
      vehicle: [d.vehicle_color, d.vehicle_make, d.vehicle_model].filter(Boolean).join(" ") || null,
      property: d.property_id ? names.get(d.property_id) ?? null : null, applied_at: d.applied_at,
    })),
  };
}

function maskPlate(p: string) {
  return p.length <= 3 ? p : p.slice(0, 2) + "•".repeat(p.length - 4) + p.slice(-2);
}

async function view(db: SupabaseClient, code: string | null) {
  const found = await findByCode(db, code);
  const { boot } = found;
  let { dep } = found;
  if (dep && dep.square_order_id && !dep.paid_at && ["locking", "active"].includes(dep.status)) {
    dep = (await syncPayment(db, dep)) ?? dep;
  }
  const { data: p } = await db.from("enforcement_partners").select("company_name, phone").eq("id", boot.partner_id).single();
  // A pay code comes from the unbranded boot-release page: it gets the phone only, never the company name.
  const partner = found.byPayCode ? { phone: p?.phone ?? null } : p;
  const staleClosed = dep && ["unlocked", "cancelled"].includes(dep.status)
    && Date.now() - new Date(dep.updated_at).getTime() > 6 * 3600 * 1000;
  if (!dep || staleClosed || dep.status === "cancelled") {
    return { ok: true, status: "not_deployed", boot: { label: boot.label }, company: partner };
  }
  let property: { name: string } | null = null;
  if (dep.property_id) {
    property = (await db.from("properties").select("name").eq("id", dep.property_id).maybeSingle()).data;
  }
  const lastReport = boot.last_report_at ? new Date(boot.last_report_at).getTime() : null;
  return {
    ok: true,
    status: dep.status,                          // locking | active | release_authorized | unlocked
    pay_code: dep.pay_code ?? null,
    paid: !!dep.paid_at,
    release_reason: dep.release_reason,
    plate: maskPlate(dep.plate_text),
    vehicle: [dep.vehicle_color, dep.vehicle_make, dep.vehicle_model].filter(Boolean).join(" ") || null,
    property: property?.name ?? null,
    company: partner,                            // {company_name, phone}; {phone} for a pay code
    fee_cents: dep.fee_cents,
    currency: dep.currency,
    applied_at: dep.applied_at,
    released_at: dep.released_at,
    unlocked_at: dep.unlocked_at,
    // Worst-case wait for the boot to hear about the release on its next LTE check-in (every poll_s, default 60 s).
    release_eta_s: dep.status === "release_authorized" && lastReport
      ? Math.max(0, Math.round((lastReport + boot.poll_s * 1000 - Date.now()) / 1000))
      : boot.poll_s,
    return_instructions: dep.status === "unlocked" || dep.status === "release_authorized" ? boot.return_instructions : null,
  };
}

function squareBase() {
  return (Deno.env.get("SQUARE_ENV") ?? "sandbox") === "production"
    ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
}

async function square(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = Deno.env.get("SQUARE_ACCESS_TOKEN");
  if (!token) throw new HttpError(503, "payments_not_configured");
  const res = await fetch(`${squareBase()}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) console.error("square", init.method ?? "GET", path, res.status, JSON.stringify(out.errors ?? out));
  return { ok: res.ok, status: res.status, out };
}

/** Square's processing fee in cents, once Square has computed it (it can arrive on a later payment.updated). */
function processingFee(payment: any): number | null {
  const fees = payment?.processing_fee;
  if (!Array.isArray(fees) || !fees.length) return null;
  return fees.reduce((n: number, f: any) => n + Number(f?.amount_money?.amount ?? 0), 0);
}

async function markPaid(db: SupabaseClient, payment: any) {
  return db.rpc("boot_mark_paid", {
    p_order_id: payment.order_id, p_payment_id: payment.id,
    p_amount_cents: Number(payment.amount_money?.amount ?? 0), p_fee_cents: processingFee(payment),
  });
}

/** Fallback when a webhook is late: ask Square whether this deployment's order has been paid. */
async function syncPayment(db: SupabaseClient, dep: Record<string, any>) {
  if (dep.last_payment_check_at && Date.now() - new Date(dep.last_payment_check_at).getTime() < 15_000) return null;
  if (!Deno.env.get("SQUARE_ACCESS_TOKEN") || String(dep.square_order_id).startsWith("dev-")) return null;
  await db.from("boot_deployments").update({ last_payment_check_at: new Date().toISOString() }).eq("id", dep.id);
  const o = await square(`/v2/orders/${encodeURIComponent(dep.square_order_id)}`);
  const tenders: any[] = o.out?.order?.tenders ?? [];
  for (const t of tenders) {
    if (!t.payment_id) continue;
    const p = await square(`/v2/payments/${encodeURIComponent(t.payment_id)}`);
    const payment = p.out?.payment;
    if (payment?.status === "COMPLETED" && payment.order_id === dep.square_order_id) {
      const { data, error } = await markPaid(db, payment);
      if (error) { console.error("boot_mark_paid (sync)", error); return null; }
      console.log("payment found by sync, not webhook", dep.id);
      return data;
    }
  }
  return null;
}

async function checkout(db: SupabaseClient, body: Record<string, unknown>) {
  const { boot, dep, byPayCode } = await findByCode(db, body.code);
  if (!dep || !["locking", "active"].includes(dep.status)) throw new HttpError(409, "nothing_to_pay");
  if (dep.paid_at) throw new HttpError(409, "already_paid");
  if (dep.square_checkout_url) return { ok: true, checkout_url: dep.square_checkout_url };

  const location = Deno.env.get("SQUARE_LOCATION_ID");
  if (!Deno.env.get("SQUARE_ACCESS_TOKEN") || !location) throw new HttpError(503, "payments_not_configured");
  const phone = typeof body.phone === "string" ? body.phone.replace(/[^\d+]/g, "").slice(0, 16) : null;
  const email = typeof body.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) ? body.email.slice(0, 120) : null;
  const pageUrl = Deno.env.get("BOOT_PAY_PAGE_URL");
  const landingUrl = (Deno.env.get("BOOT_PAY_LANDING_URL") ?? "https://boot-release.vercel.app").replace(/\/+$/, "");
  const returnUrl = byPayCode ? `${landingUrl}/?c=${dep.pay_code}&paid=1`
    : pageUrl ? `${pageUrl}?code=${boot.qr_code}&paid=1` : undefined;

  const res = await square("/v2/online-checkout/payment-links", {
    method: "POST",
    body: {
      idempotency_key: `boot-${dep.id}`,
      quick_pay: {
        name: `Boot release ${boot.label} (${maskPlate(dep.plate_text)})`,
        price_money: { amount: dep.fee_cents, currency: dep.currency },
        location_id: location,
      },
      checkout_options: {
        redirect_url: returnUrl,
        accepted_payment_methods: { apple_pay: true, google_pay: true },
        allow_tipping: false,
        ask_for_shipping_address: false,
      },
      pre_populated_data: { buyer_phone_number: phone ?? undefined, buyer_email: email ?? undefined },
      payment_note: `boot_deployment:${dep.id}`,
    },
  });
  if (!res.ok || !res.out.payment_link) throw new HttpError(502, "payment_provider_error");
  const link = res.out.payment_link;
  await db.from("boot_deployments").update({
    square_payment_link_id: link.id, square_order_id: link.order_id, square_checkout_url: link.url,
    payer_phone: phone, payer_email: email,
  }).eq("id", dep.id);
  await db.from("boot_events").insert({
    boot_id: boot.id, deployment_id: dep.id, source: "web", transport: "web", action: "checkout_started",
    details: { square_order_id: link.order_id },
  });
  return { ok: true, checkout_url: link.url };
}

async function squareWebhook(db: SupabaseClient, req: Request) {
  const raw = await req.text();
  const key = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY");
  const notifUrl = Deno.env.get("SQUARE_WEBHOOK_URL") ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/boot-pay/square-webhook`;
  if (!key) return json({ ok: false, error: "webhook_not_configured" }, 503);
  const given = req.headers.get("x-square-hmacsha256-signature") ?? "";
  const expect = btoa(String.fromCharCode(...await hmac(new TextEncoder().encode(key), new TextEncoder().encode(notifUrl + raw))));
  if (!timingSafe(given, expect)) return json({ ok: false, error: "bad_signature" }, 401);

  const evt = JSON.parse(raw);
  const type: string = evt?.type ?? "";
  const obj = evt?.data?.object ?? {};

  if (type.startsWith("payment.")) {
    const payment = obj.payment;
    if (!payment?.order_id || payment.status !== "COMPLETED") return json({ ok: true, ignored: payment?.status ?? true });
    const { data: dep } = await db.from("boot_deployments").select("id").eq("square_order_id", payment.order_id).maybeSingle();
    if (!dep) return json({ ok: true, ignored: "not_a_boot_order" });   // e.g. a plaza payment on the same Square account
    const { error } = await markPaid(db, payment);
    if (error) { console.error("boot_mark_paid", error); return json({ ok: false, error: "mark_paid_failed" }, 500); }
    return json({ ok: true });
  }

  if (type.startsWith("refund.")) {
    const r = obj.refund;
    if (!r?.id || !r?.payment_id) return json({ ok: true, ignored: true });
    const { data, error } = await db.rpc("boot_record_refund", {
      p_refund_id: r.id, p_payment_id: r.payment_id, p_amount_cents: Number(r.amount_money?.amount ?? 0),
      p_status: String(r.status ?? "PENDING"), p_reason: r.reason ?? null,
    });
    if (error) { console.error("boot_record_refund", error); return json({ ok: false, error: "refund_failed" }, 500); }
    return json({ ok: true, ignored: data ? undefined : "not_a_boot_payment" });
  }

  return json({ ok: true, ignored: type });
}

function timingSafe(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function devPay(db: SupabaseClient, body: Record<string, unknown>) {
  if (isProd() || Deno.env.get("BOOT_DEV_PAY") !== "1") throw new HttpError(403, "not_available");
  const { dep } = await findByCode(db, body.code);
  if (!dep || !["locking", "active"].includes(dep.status)) throw new HttpError(409, "nothing_to_pay");
  const order = `dev-${dep.id}`;
  await db.from("boot_deployments").update({ square_order_id: order }).eq("id", dep.id);
  const { error } = await db.rpc("boot_mark_paid", {
    p_order_id: order, p_payment_id: `dev-pay-${dep.id}`, p_amount_cents: dep.fee_cents, p_fee_cents: null,
  });
  if (error) throw error;
  return { ok: true, dev: true };
}
