// Service worker: app werkt ook met slecht of geen bereik op het water.
// Alles van de eigen site: eerst netwerk (zo zie je updates meteen), zonder verbinding de bewaarde versie.
// Bibliotheken en lettertypes van CDN's: eerst de bewaarde versie.
const VERSION = "bh-v15";
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  // cache: "reload" haalt verse bestanden op en slaat de HTTP-cache van de browser over
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => { if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; };

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(
      // Navigatie (de pagina zelf) mag geen extra opties krijgen; overige bestanden altijd opnieuw controleren.
      (e.request.mode === "navigate" ? fetch(e.request) : fetch(e.request, { cache: "no-cache" }))
        .then((r) => put(e.request, r)).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  if (url.hostname.endsWith("cdnjs.cloudflare.com") || url.hostname.includes("fonts.g")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => put(e.request, r))));
  }
});
