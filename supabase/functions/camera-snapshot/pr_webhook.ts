// ── Plate Recognizer cloud webhook as a camera source ───────────────────
//
// The Mayfield SC211s upload their ANPR captures (the frame where the camera
// saw a plate) straight to Plate Recognizer's Snapshot Cloud, and send us
// only their periodic "4GSolarCam/Snapshot" frames, which are pavement.
// Plate Recognizer reads the ANPR frames fine and then they stop there. A
// PR Cloud Webhook "with image" pointed at camera-snapshot brings those
// frames into this pipeline: multipart with a `json` field (PR's result,
// `data.camera_id` = what the camera sent, our alpr_cameras.api_key) and an
// `upload` field (the JPEG). extract.ts reads the identity from that json.
//
// Loop guard: PR fires the webhook for EVERY call on the account, including
// this function's own plate-reader calls. Those are sent with camera_id
// `<api_key>:lotlogic` and filename snap.jpg, so a webhook that carries
// either is our own call echoed back and is dropped before any work.
//
// SKIP_SNAPSHOT_TOPIC_MACS: cameras whose periodic Snapshot posts should be
// dropped once their ANPR frames arrive through the webhook; those posts
// never read a plate and each one paid for a PR call and a ParkPow call.

export const OWN_CALL_SUFFIX = ":lotlogic";
export const OWN_FILENAMES: ReadonlySet<string> = new Set(["snap.jpg", "snapshot.jpg"]);
export const SNAPSHOT_TOPIC = "4GSolarCam/Snapshot";

export type PrWebhook = {
  cameraId: string | null;   // lower-cased; alpr_cameras.api_key is lower-case
  filename: string | null;
  timestamp: string | null;
  top: { plate: string; score: number } | null;  // PR's own best read, for forensics
};

/** PR's webhook `json` field → the few things we keep. Null when it is not a PR webhook. */
export function parsePrWebhookJson(text: unknown): PrWebhook | null {
  if (typeof text !== "string" || !text) return null;
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  const data = (obj as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const cam = data.camera_id;
  const results = Array.isArray(data.results) ? data.results as Array<{ plate?: unknown; score?: unknown }> : [];
  const first = results[0];
  return {
    cameraId: typeof cam === "string" && cam.trim() ? cam.trim().toLowerCase() : null,
    filename: typeof data.filename === "string" ? data.filename : null,
    timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
    top: first && typeof first.plate === "string"
      ? { plate: first.plate.toUpperCase(), score: typeof first.score === "number" ? first.score : 0 }
      : null,
  };
}

/** The camera_id this function sends to PR, so its own calls are recognisable when they echo back. */
export function tagOwnCall(apiKey: string): string {
  return apiKey.endsWith(OWN_CALL_SUFFIX) ? apiKey : `${apiKey}${OWN_CALL_SUFFIX}`;
}

/** A webhook post that is one of our own PR calls coming back. */
export function isOwnCall(hook: PrWebhook): boolean {
  if (hook.cameraId && hook.cameraId.endsWith(OWN_CALL_SUFFIX)) return true;
  if (hook.filename && OWN_FILENAMES.has(hook.filename.toLowerCase())) return true;
  return false;
}

/** SKIP_SNAPSHOT_TOPIC_MACS="1cc31660025c, 1CC3166003D8" → lower-cased set. */
export function snapshotTopicSkipList(env: string | undefined | null): Set<string> {
  return new Set((env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** True for a Milesight JSON post on the periodic Snapshot topic. */
export function isSnapshotTopicPost(rawMeta: Record<string, unknown> | null | undefined): boolean {
  const ms = rawMeta?.milesight as { topic?: unknown } | undefined;
  return ms?.topic === SNAPSHOT_TOPIC;
}
