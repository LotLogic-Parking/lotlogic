// Liveness ping for cameras that only post on events (Norman Lofts JideTech units upload a
// snapshot by FTP when they detect a car; the VPN-server relay forwards it here). Between cars
// nothing arrives, so last_seen_at would go stale and the dashboard would call a working camera
// offline. The relay checks the camera answers on the VPN and then POSTs to the same URL
// (`/camera-snapshot/<api_key>/<secret>`) with this header and no body. We stamp last_seen_at
// and stop: no image, no Plate Recognizer call, no ParkPow call.
// deno-lint-ignore-file no-explicit-any

export const HEARTBEAT_HEADER = "x-lotlogic-heartbeat";

export function isHeartbeat(req: Request): boolean {
  return req.headers.get(HEARTBEAT_HEADER) === "1";
}

export type HeartbeatResult =
  | { ok: true; heartbeat: true; camera_id: string }
  | { ok: false; heartbeat: true; reason: "no_camera_identity" | "unknown_camera" };

export async function stampHeartbeat(db: any, apiKey: string | null, now: Date): Promise<HeartbeatResult> {
  if (!apiKey) return { ok: false, heartbeat: true, reason: "no_camera_identity" };
  const { data, error } = await db
    .from("alpr_cameras")
    .update({ last_seen_at: now.toISOString() })
    .eq("api_key", apiKey)
    .eq("active", true)
    .select("id");
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? { ok: true, heartbeat: true, camera_id: row.id } : { ok: false, heartbeat: true, reason: "unknown_camera" };
}
