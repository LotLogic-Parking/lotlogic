import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isOwnCall, isSnapshotTopicPost, parsePrWebhookJson, snapshotTopicSkipList, tagOwnCall,
} from "./pr_webhook.ts";
import { extractFromRequest } from "./extract.ts";

const HOOK = JSON.stringify({
  hook: { target: "https://x/functions/v1/camera-snapshot/s", id: "1", event: "recognition" },
  data: {
    camera_id: "1CC3166003D8", filename: "20261111112300121C.jpg", timestamp: "2026-11-11T19:23:00Z",
    results: [{ plate: "vk5131", score: 0.996, box: { xmin: 1, ymin: 2, xmax: 60, ymax: 30 } }],
  },
});

Deno.test("parsePrWebhookJson: camera id lower-cased, top read kept, junk rejected", () => {
  const h = parsePrWebhookJson(HOOK)!;
  assertEquals(h.cameraId, "1cc3166003d8");
  assertEquals(h.filename, "20261111112300121C.jpg");
  assertEquals(h.top, { plate: "VK5131", score: 0.996 });
  assertEquals(parsePrWebhookJson("not json"), null);
  assertEquals(parsePrWebhookJson(JSON.stringify({ foo: 1 })), null);
  assertEquals(parsePrWebhookJson(null), null);
  assertEquals(parsePrWebhookJson(JSON.stringify({ data: { camera_id: null, results: [] } }))!.cameraId, null);
});

Deno.test("own calls echo back with the tag or our filename and are recognised", () => {
  assertEquals(tagOwnCall("1cc31660025c"), "1cc31660025c:lotlogic");
  assertEquals(tagOwnCall("1cc31660025c:lotlogic"), "1cc31660025c:lotlogic");
  assertEquals(isOwnCall(parsePrWebhookJson(HOOK)!), false);
  const own = JSON.stringify({ data: { camera_id: "1cc31660025c:lotlogic", filename: "x.jpg", results: [] } });
  assertEquals(isOwnCall(parsePrWebhookJson(own)!), true);
  const byName = JSON.stringify({ data: { camera_id: "1cc31660025c", filename: "snap.jpg", results: [] } });
  assertEquals(isOwnCall(parsePrWebhookJson(byName)!), true);
  const plaza = JSON.stringify({ data: { camera_id: null, filename: "snapshot.jpg", results: [] } });
  assertEquals(isOwnCall(parsePrWebhookJson(plaza)!), true);
});

Deno.test("snapshot-topic skip list and topic detection", () => {
  const set = snapshotTopicSkipList(" 1cc31660025c, 1CC3166003D8 ,");
  assertEquals([...set], ["1cc31660025c", "1cc3166003d8"]);
  assertEquals(snapshotTopicSkipList(undefined).size, 0);
  assertEquals(isSnapshotTopicPost({ milesight: { topic: "4GSolarCam/Snapshot" } }), true);
  assertEquals(isSnapshotTopicPost({ milesight: { topic: "4GSolarCam/ANPR" } }), false);
  assertEquals(isSnapshotTopicPost(null), false);
});

Deno.test("extractFromRequest: a PR webhook multipart yields the image and the camera identity", async () => {
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00]);
  const fd = new FormData();
  fd.append("json", HOOK);
  fd.append("upload", new Blob([jpeg], { type: "image/jpeg" }), "20261111112300121C.jpg");
  const req = new Request("https://x/functions/v1/camera-snapshot/secret", { method: "POST", body: fd });
  const out = await extractFromRequest(req);
  assertEquals(out?.source, "multipart");
  assertEquals(out?.cameraHint, "1cc3166003d8");
  assertEquals(out?.bytes.byteLength, jpeg.byteLength);
  const hook = (out?.rawMeta as { _pr_webhook?: { top?: { plate: string } } })._pr_webhook;
  assertEquals(hook?.top?.plate, "VK5131");
});

Deno.test("extractFromRequest: a plain multipart upload still has no identity", async () => {
  const fd = new FormData();
  fd.append("image", new Blob([new Uint8Array([0xFF, 0xD8, 0xFF])], { type: "image/jpeg" }), "a.jpg");
  const req = new Request("https://x/functions/v1/camera-snapshot/secret", { method: "POST", body: fd });
  const out = await extractFromRequest(req);
  assertEquals(out?.source, "multipart");
  assertEquals(out?.cameraHint, null);
  assertEquals(out?.rawMeta, null);
});
