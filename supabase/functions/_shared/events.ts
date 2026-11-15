// Device event ingestion, shared by the BLE path (app relays the boot's event log) and the LTE path
// (boot reports directly). Idempotent: the same device event arriving twice, by either path, is stored once.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { EVENT_ACTION } from "./boot.ts";

export type DeviceEvent = { seq: number; uptime_s: number; event: number; vbat_mv?: number; result?: number };

export function parseEvents(raw: unknown): DeviceEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceEvent[] = [];
  for (const e of raw.slice(0, 300)) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const seq = Number(r.seq), up = Number(r.uptime_s ?? r.ts_uptime), ev = Number(r.event);
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(ev) || ev < 0 || ev > 255) continue;
    out.push({
      seq, event: ev,
      uptime_s: Number.isFinite(up) ? up : 0,
      vbat_mv: Number.isFinite(Number(r.vbat_mv)) ? Number(r.vbat_mv) : undefined,
      result: Number.isFinite(Number(r.result)) ? Number(r.result) : 0,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Store device events, link each completed command to the server token behind it, and move the boot's
 * open deployment along (lock confirmed / unlocked). Returns the highest device seq now stored.
 */
export async function ingestDeviceEvents(
  db: SupabaseClient,
  bootId: string,
  events: DeviceEvent[],
  transport: "ble" | "lte",
  nowUptime: number | null,
  receivedAt = new Date(),
): Promise<number | null> {
  if (events.length) {
    const { data: open } = await db.from("boot_deployments").select("id")
      .eq("boot_id", bootId).in("status", ["locking", "active", "release_authorized"]).maybeSingle();
    const rows = events.map((e) => ({
      boot_id: bootId,
      deployment_id: open?.id ?? null,
      source: "device",
      transport,
      action: EVENT_ACTION[e.event] ?? `event_0x${e.event.toString(16).padStart(2, "0")}`,
      device_seq: e.seq,
      device_uptime_s: e.uptime_s,
      device_event: e.event,
      device_result: e.result ?? 0,
      device_ts_est: nowUptime != null && e.uptime_s <= nowUptime
        ? new Date(receivedAt.getTime() - (nowUptime - e.uptime_s) * 1000).toISOString()
        : null,
      vbat_mv: e.vbat_mv ?? null,
      cmd: [0x01, 0x02, 0x03, 0x10].includes(e.event) ? e.event : null,
    }));
    const { data: inserted, error } = await db.from("boot_events")
      .upsert(rows, { onConflict: "boot_id,source,device_seq", ignoreDuplicates: true })
      .select("id, device_seq, device_event, device_result, device_ts_est");
    if (error) throw error;

    for (const row of inserted ?? []) {
      await linkToToken(db, bootId, row.device_seq, row.device_event, row.device_result);
      if (row.device_result === 0) await advanceDeployment(db, bootId, row, transport);
    }
  }
  const { data: max } = await db.from("boot_events").select("device_seq")
    .eq("boot_id", bootId).eq("source", "device").order("device_seq", { ascending: false }).limit(1).maybeSingle();
  return max?.device_seq ?? null;
}

/** Attach a device command event to the most recent unmatched server token for the same command. */
async function linkToToken(db: SupabaseClient, bootId: string, seq: number, ev: number, result: number) {
  if (![0x01, 0x02, 0x03, 0x10, 0x20].includes(ev)) return;
  const { data: already } = await db.from("boot_events").select("id")
    .eq("boot_id", bootId).eq("source", "server").eq("device_seq", seq).maybeSingle();
  if (already) return;
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data: tok } = await db.from("boot_events").select("id")
    .eq("boot_id", bootId).eq("source", "server").eq("cmd", ev).is("device_seq", null)
    .gte("server_ts", since).order("server_ts", { ascending: false }).limit(1).maybeSingle();
  if (!tok) return; // no token: shows up in boot_unauthorized_moves
  await db.from("boot_events").update({ device_seq: seq, device_result: result }).eq("id", tok.id).is("device_seq", null);
}

async function advanceDeployment(
  db: SupabaseClient, bootId: string,
  row: { id: number; device_event: number; device_ts_est: string | null }, transport: "ble" | "lte",
) {
  const when = row.device_ts_est ?? new Date().toISOString();
  const { data: dep } = await db.from("boot_deployments").select("id, status")
    .eq("boot_id", bootId).in("status", ["locking", "active", "release_authorized"]).maybeSingle();
  if (!dep) return;
  if (row.device_event === 0x02 && dep.status === "locking") {
    await db.from("boot_deployments").update({ status: "active", lock_confirmed_at: when })
      .eq("id", dep.id).eq("status", "locking");
  } else if (row.device_event === 0x01) {
    const patch: Record<string, unknown> = { status: "unlocked", unlocked_at: when, unlock_transport: transport };
    if (dep.status !== "release_authorized") patch.notes = "unlocked before release was recorded: investigate";
    await db.from("boot_deployments").update(patch).eq("id", dep.id).eq("status", dep.status);
  }
}
