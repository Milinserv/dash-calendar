// Офлайн-режим: оболочка приложения хранится на телефоне.
// При новой версии на GitHub поменяй VERSION — телефон подтянет обновление.
const VERSION = "dd-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "config.js", "vendor/supabase.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !fonts) return;            // Supabase и прочее — напрямую в сеть
  // stale-while-revalidate: сразу из кэша, параллельно обновляем
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(e.request, {ignoreSearch: sameOrigin});
    const net = fetch(e.request).then(res => { if (res && (res.ok || res.type === "opaque")) cache.put(e.request, res.clone()); return res; })
      .catch(() => cached || (e.request.mode === "navigate" ? cache.match("index.html") : undefined));
    return cached || net;
  }));
});
