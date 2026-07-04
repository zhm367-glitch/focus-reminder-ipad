const CACHE_NAME = "focus-reminder-v8";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icon.svg",
  "./vendor/tasks-vision/vision_bundle.mjs",
  "./vendor/tasks-vision/wasm/vision_wasm_internal.js",
  "./vendor/tasks-vision/wasm/vision_wasm_internal.wasm",
  "./vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm",
  "./models/face_landmarker.task",
  "./models/efficientdet_lite2_int8.tflite",
  "./models/efficientdet_lite0_uint8.tflite"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.allSettled(ASSETS.map((asset) => cache.add(asset)))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    const fresh = fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
