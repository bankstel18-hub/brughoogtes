// Service worker: app werkt ook met slecht of geen bereik op het water.
// Alles van de eigen site: eerst netwerk (zo zie je updates meteen), zonder verbinding de bewaarde versie.
// Bibliotheken en lettertypes staan sinds v19 op de eigen site (geen CDN of Google meer).
// Na een wijziging aan de app: VERSION verhogen, dan halen alle toestellen de nieuwe versie op.
const VERSION = "bh-v19";
const JS = ["main", "config", "core", "state", "water", "map", "popups", "chart", "panel", "profiles", "route", "routeui", "locate"].map((m) => `js/${m}.js`);
const FONTS = ["barlow-semi-condensed-latin-400-normal", "barlow-semi-condensed-latin-500-normal", "barlow-semi-condensed-latin-600-normal", "barlow-semi-condensed-latin-700-normal", "jetbrains-mono-latin-500-normal", "jetbrains-mono-latin-700-normal"].map((f) => `vendor/fonts/${f}.woff2`);
const SHELL = ["./", "index.html", "app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/fonts/fonts.css", ...FONTS, ...JS];

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
});
