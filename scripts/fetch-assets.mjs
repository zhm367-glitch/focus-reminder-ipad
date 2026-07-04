import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(root, "vendor", "tasks-vision");
const wasm = resolve(runtime, "wasm");
const models = resolve(root, "models");
mkdirSync(wasm, { recursive: true });
mkdirSync(models, { recursive: true });

async function download(url, destination) {
  if (existsSync(destination) && statSync(destination).size > 0) {
    console.log(`Keeping existing ${destination}: ${statSync(destination).size} bytes`);
    return;
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes);
  console.log(`${destination}: ${bytes.length} bytes`);
}

const version = "0.10.35";
const cdn = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}`;
await download(`${cdn}/vision_bundle.mjs`, resolve(runtime, "vision_bundle.mjs"));
for (const name of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  await download(`${cdn}/wasm/${name}`, resolve(wasm, name));
}
await download(
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
  resolve(models, "face_landmarker.task"),
);
await download(
  "https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite",
  resolve(models, "efficientdet_lite0_uint8.tflite"),
);
await download(
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/int8/1/efficientdet_lite2.tflite",
  resolve(models, "efficientdet_lite2_int8.tflite"),
);

writeFileSync(
  resolve(root, "vendor", "versions.json"),
  JSON.stringify({
    tasksVision: version,
    downloadedAt: new Date().toISOString(),
    sources: {
      package: cdn,
      face: "Google MediaPipe Face Landmarker float16/latest",
      object: "Google MediaPipe EfficientDet Lite2 int8 (with Lite0 fallback)",
    },
  }, null, 2),
);
