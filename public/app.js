(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const STATION_RADIUS_KM = 10;   // meetpunt geldt voor bruggen binnen deze afstand
const WATER_MAX_AGE_H = 3;      // oudere metingen gebruiken we niet voor de correctie

/* ---------- kaart ---------- */
const map = L.map("map", { preferCanvas: true }).setView([52.15, 5.3], 8);
const base = {
  "Grijs (PDOK BRT)": L.tileLayer("https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© Kadaster / PDOK" }),
  "Kaart (OSM)": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }),
  "Luchtfoto (PDOK)": L.tileLayer("https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg", { maxZoom: 19, attribution: "© Beeldmateriaal NL / PDOK" }),
};
base["Grijs (PDOK BRT)"].addTo(map);
const seamark = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenSeaMap" });
L.control.layers(base, { "Vaarwegmarkeringen (OpenSeaMap)": seamark }, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const renderer = L.canvas({ padding: 0.3 });
const bridgeLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);

/* ---------- state ---------- */
let bridges = [], stations = [], forecast = {}, meta = { bridgesAt: null, waterAt: null, forecastAt: null };
let typeFilter = "all", drawn = [];
const saved = ls.get("bh-settings") || {};
if (saved.boat) { $("boatH").value = saved.boat; $("boatR").value = saved.boat; }
if (saved.margin != null) $("margin").value = saved.margin;
if (saved.useWater === false) $("useWater").checked = false;
if (saved.showStations === false) $("showStations").checked = false;

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const need = () => (parseFloat($("boatH").value) || 0) + (parseFloat($("margin").value) || 0);
const fmt = (v) => (v == null ? "?" : v >= 90 ? "∞" : v.toFixed(2));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (iso) => {
  if (!iso) return "onbekend";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "zojuist"; if (m < 60) return `${m} min geleden`;
  const h = Math.round(m / 60); if (h < 48) return `${h} uur geleden`;
  return new Date(iso).toLocaleDateString("nl-NL");
};
const timeNL = (iso) => new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

/* ---------- waterstand per brug ---------- */
const offsetH = () => +$("when").value || 0;
const targetMs = () => Date.now() + offsetH() * 3600e3;
function interp(pts, tSec) {
  if (!pts || !pts.length || tSec < pts[0][0] - 3600 || tSec > pts[pts.length - 1][0] + 3600) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [t1, v1] = pts[i], [t2, v2] = pts[i + 1];
    if (tSec >= t1 && tSec <= t2) return Math.round(v1 + ((v2 - v1) * (tSec - t1)) / (t2 - t1));
  }
  return tSec < pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
}
// Waterstand (cm NAP) op het gekozen vaartijdstip: meting voor "nu", anders de RWS-verwachting.
function levelAt(s, h = offsetH()) {
  const fc = forecast[s.code];
  if (h === 0 && s.cm != null && s.t && (Date.now() - Date.parse(s.t)) / 3600e3 <= WATER_MAX_AGE_H) return { cm: s.cm, t: s.t, kind: "meting" };
  if (fc) {
    const tMs = Date.now() + h * 3600e3, v = interp(fc.pts, tMs / 1000);
    if (v != null) return { cm: v, t: new Date(tMs).toISOString(), kind: fc.kind };
  }
  return null;
}
function km(a, b, c, d) {
  const R = 6371, r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R;
}
function linkStations() {
  const fresh = [];
  for (const s of stations) { s.lvl = levelAt(s); if (s.lvl) fresh.push(s); }
  // raster van 0.2° voor snel zoeken
  const grid = new Map();
  const key = (lat, lng) => `${Math.floor(lat / 0.2)}|${Math.floor(lng / 0.2)}`;
  for (const s of fresh) { const k = key(s.lat, s.lng); (grid.get(k) || grid.set(k, []).get(k)).push(s); }
  for (const b of bridges) {
    b.st = null; b.stKm = null;
    const gy = Math.floor(b.lat / 0.2), gx = Math.floor(b.lng / 0.2);
    let best = null, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const s of grid.get(`${gy + dy}|${gx + dx}`) || []) {
        const d = km(b.lat, b.lng, s.lat, s.lng);
        if (d < bd) { bd = d; best = s; }
      }
    }
    if (best && bd <= STATION_RADIUS_KM) { b.st = best; b.stKm = bd; }
    b.cur = currentClearance(b);
  }
}
// Actuele doorvaarthoogte: alleen als de brug een NAP-referentie heeft.
function currentClearance(b) {
  if (!b.st || !b.st.lvl) return null;
  return clearanceFor(b, b.st.lvl.cm);
}
function clearanceFor(b, cm) {
  const w = cm / 100;
  if (b.underNAP != null) return +(b.underNAP - w).toFixed(2);
  if (b.closed != null && b.refNAP != null) return +(b.closed - (w - b.refNAP)).toFixed(2);
  return null;
}
const effClosed = (b) => ($("useWater").checked && b.cur != null ? b.cur : b.closed);
const effOpen = (b) => (b.open == null ? null : $("useWater").checked && b.cur != null && b.closed != null ? +(b.open + (b.cur - b.closed)).toFixed(2) : b.open);

function state(b) {
  const n = need(), c = effClosed(b), o = effOpen(b);
  if (c == null && o == null) return "unk";
  if (c != null && c >= n) return "ok";
  if (b.movable) return o == null || o >= n ? "wait" : "bad";
  return c == null ? "unk" : "bad";
}
const colorOf = (s) => css({ ok: "--ok", wait: "--wait", bad: "--bad", unk: "--unk" }[s]);

/* ---------- data laden ---------- */
async function getData(path) {
  const r = await fetch(path, { cache: "no-cache" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function loadBridges() {
  const d = await getData("data/bridges.json");
  bridges = d.bridges || [];
  meta.bridgesAt = d.generatedAt;
}
async function loadWater() {
  try {
    const d = await getData("data/water.json");
    stations = (d.stations || []).filter((s) => s.lat != null);
    meta.waterAt = d.generatedAt;
  } catch (e) { meta.waterErr = e.message; }
}
async function loadForecast() {
  try {
    const d = await getData("data/forecast.json");
    forecast = d.series || {};
    meta.forecastAt = d.generatedAt;
  } catch (e) { meta.forecastErr = e.message; }
}
async function init() {
  try {
    await Promise.all([loadBridges(), loadWater(), loadForecast()]);
    linkStations(); draw(); fresh();
  } catch (e) {
    setStatus(`Brugdata niet beschikbaar: ${e.message}`, true);
    $("freshness").textContent = "Gegevens worden voorbereid. Probeer het over een paar minuten opnieuw.";
  }
  setInterval(async () => { await Promise.all([loadWater(), loadForecast()]); linkStations(); draw(); fresh(); }, 5 * 60e3);
}
function fresh() {
  const parts = [];
  if (meta.waterAt) parts.push(`Waterstanden ${ago(meta.waterAt)}`);
  else parts.push("Geen actuele waterstanden");
  if (meta.forecastAt) parts.push(`verwachting ${ago(meta.forecastAt)}`);
  if (meta.bridgesAt) parts.push(`bruggen ${ago(meta.bridgesAt)}`);
  $("freshness").textContent = parts.join(" · ");
  const corrected = bridges.filter((b) => b.cur != null).length;
  setStatus(`${bridges.length.toLocaleString("nl-NL")} bruggen, ${stations.filter((s) => s.cm != null).length} meetpunten met actuele waterstand, ${Object.keys(forecast).length} met verwachting, ${corrected.toLocaleString("nl-NL")} bruggen gecorrigeerd voor waterstand.`);
}
function setStatus(t, err) { const s = $("status"); s.textContent = t; s.classList.toggle("err", !!err); }

/* ---------- tekenen ---------- */
function passes(b, s) {
  if (typeFilter === "fixed" && b.movable) return false;
  if (typeFilter === "movable" && !b.movable) return false;
  if ($("onlyLow").checked && !(s === "bad" || s === "wait")) return false;
  const q = $("search").value.trim().toLowerCase();
  if (q && !(b.name.toLowerCase().includes(q) || (b.waterway || "").toLowerCase().includes(q))) return false;
  return true;
}
const kindTxt = (k) => ({ meting: "gemeten", verwachting: "verwacht", astronomisch: "astronomisch getij" }[k] || "");
const signed = (cm) => `${cm > 0 ? "+" : ""}${cm}`;
const whenTxt = () => (offsetH() === 0 ? "nu" : `om ${timeNL(new Date(targetMs()).toISOString())}`);

// Laagste doorvaarthoogte volgens de verwachting in de komende 48 uur.
function minAhead(b) {
  if (!b.st) return null;
  const fc = forecast[b.st.code];
  if (!fc) return null;
  const now = Date.now() / 1000;
  let best = null;
  for (const [t, cm] of fc.pts) {
    if (t < now || t > now + 48 * 3600) continue;
    const c = clearanceFor(b, cm);
    if (c != null && (!best || c < best.c)) best = { c, t };
  }
  return best;
}

function sparkline(s, b) {
  const fc = forecast[s.code];
  const now = Date.now() / 1000, t0 = now - 2 * 3600, t1 = now + 48 * 3600;
  const pts = (fc?.pts || []).filter(([t]) => t >= t0 && t <= t1);
  const meas = s.cm != null && s.t ? [Date.parse(s.t) / 1000, s.cm] : null;
  if (!pts.length && !meas) return "";
  const vals = pts.map((p) => p[1]).concat(meas ? [meas[1]] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
  const W = 280, H = 96, L = 34, R = 6, T = 8, B = 18;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const water = css("--water");
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const tSel = targetMs() / 1000;
  const ticks = [0, 12, 24, 36, 48].map((h) => {
    const t = now + h * 3600, d = new Date(t * 1000);
    return `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke="#d5e0e8" stroke-width="1"/><text x="${x(t)}" y="${H - 5}" text-anchor="${h === 48 ? "end" : "middle"}">${h === 0 ? "nu" : d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}</text>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Waterstand en verwachting komende 48 uur">
    ${ticks}
    <text x="${L - 4}" y="${y(hi) + 3}" text-anchor="end">${signed(Math.round(hi))}</text>
    <text x="${L - 4}" y="${y(lo) + 3}" text-anchor="end">${signed(Math.round(lo))}</text>
    ${path ? `<path d="${path}" fill="none" stroke="${water}" stroke-width="2" stroke-dasharray="${fc?.kind === "astronomisch" ? "4 3" : "0"}"/>` : ""}
    ${meas ? `<circle cx="${x(Math.max(t0, meas[0]))}" cy="${y(meas[1])}" r="3.5" fill="#0f2a3d"/>` : ""}
    <line x1="${x(tSel)}" x2="${x(tSel)}" y1="${T}" y2="${H - B}" stroke="${css("--wait")}" stroke-width="2"/>
  </svg>
  <div class="note">Lijn: ${fc ? (fc.kind === "astronomisch" ? "astronomisch getij (zonder wind en afvoer)" : "verwachting Rijkswaterstaat") : "geen verwachting beschikbaar"} · stip: laatste meting · oranje: gekozen vaartijdstip · cm t.o.v. NAP</div>`;
}

function popupBridge(b) {
  const s = state(b), c = effClosed(b), o = effOpen(b);
  const label = { ok: "Je past eronderdoor", wait: "Brug moet open voor jou", bad: "Te laag voor jouw schip", unk: "Hoogte onbekend" }[s];
  const usingCur = $("useWater").checked && b.cur != null;
  const rows = Object.entries(b.a || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  let wl = "";
  if (b.st && b.st.lvl) {
    const lv = b.st.lvl, mn = minAhead(b);
    wl = `<div class="wl">Waterstand ${esc(b.st.name)} (${b.stKm.toFixed(1)} km), ${kindTxt(lv.kind)} ${whenTxt()}: <b>${signed(lv.cm)} cm NAP</b>`
      + (b.cur != null
        ? `<br>Doorvaarthoogte ${whenTxt()}: <b>${fmt(b.cur)} m</b> (bij referentiepeil ${fmt(b.closed)} m)`
          + (mn ? `<br>Laagste verwachte hoogte komende 48 uur: <b>${fmt(mn.c)} m</b> op ${new Date(mn.t * 1000).toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "")
        : `<br>Deze brug heeft geen NAP-referentie in de brondata, dus de hoogte is niet automatisch gecorrigeerd.`)
      + `</div>${sparkline(b.st, b)}`;
  }
  return `<div class="pop"><h3>${esc(b.name)}</h3>
    ${b.waterway ? `<div class="note" style="margin:0">${esc(b.waterway)}</div>` : ""}
    <div style="margin:6px 0"><span class="big">${fmt(c)} m</span> ${b.movable ? "gesloten" : "doorvaarthoogte"}${usingCur ? ` (${whenTxt()})` : ""}
    ${b.movable ? `<br><span class="mid">${o != null ? fmt(o) + " m" : "onbeperkt of onbekend"}</span> open` : ""}</div>
    <div style="font-weight:700;color:${colorOf(s)}">${label}</div>
    <div class="note">${b.movable ? "Beweegbare brug" : "Vaste brug"} · bron: Rijkswaterstaat FIS</div>
    ${wl}
    <details><summary>Alle gegevens</summary><table>${rows}</table></details>
    <div class="note">${usingCur ? "Gecorrigeerd met het dichtstbijzijnde meetpunt; lokaal kan de waterstand afwijken, en een verwachting is geen garantie." : "Hoogte t.o.v. het referentiepeil van de vaarweg. Controleer de actuele waterstand."}</div></div>`;
}
function popupStation(s) {
  const lv = s.lvl;
  return `<div class="pop"><h3>${esc(s.name)}</h3><div class="note" style="margin:0">Meetpunt Rijkswaterstaat · ${esc(s.code)}</div>
    <div style="margin:6px 0"><span class="big">${lv ? signed(lv.cm) + " cm" : "–"}</span> NAP ${lv ? `<span class="note">${kindTxt(lv.kind)} ${whenTxt()}</span>` : ""}</div>
    <div class="note">Laatste meting: ${s.cm != null ? `${signed(s.cm)} cm om ${new Date(s.t).toLocaleString("nl-NL")} (${ago(s.t)})` : "geen"}</div>
    ${sparkline(s)}</div>`;
}

function draw() {
  bridgeLayer.clearLayers(); stationLayer.clearLayers(); drawn = [];
  const water = css("--water");
  for (const b of bridges) {
    const s = state(b);
    if (!passes(b, s)) continue;
    const usingCur = $("useWater").checked && b.cur != null;
    const m = L.circleMarker([b.lat, b.lng], {
      renderer, radius: b.movable ? 6 : 5,
      color: usingCur ? water : "#0f2a3d", weight: usingCur ? 2.5 : b.movable ? 2 : 1,
      fillColor: colorOf(s), fillOpacity: 0.95,
    });
    m.bindPopup(() => popupBridge(b), { maxWidth: 330 });
    m.addTo(bridgeLayer);
    drawn.push({ b, s, m });
  }
  if ($("showStations").checked) {
    for (const st of stations) {
      if (!st.lvl && st.cm == null) continue;
      const m = L.marker([st.lat, st.lng], {
        icon: L.divIcon({ className: "", html: `<i class="sq" style="display:block;width:11px;height:11px"></i>`, iconSize: [11, 11] }),
        keyboard: false, title: st.name,
      });
      m.bindPopup(() => popupStation(st));
      m.addTo(stationLayer);
    }
  }
  updateView();
  ls.set("bh-settings", { boat: $("boatH").value, margin: $("margin").value, useWater: $("useWater").checked, showStations: $("showStations").checked });
}

function updateView() {
  const bounds = map.getBounds();
  const inView = drawn.filter((d) => bounds.contains([d.b.lat, d.b.lng]));
  const c = { ok: 0, wait: 0, bad: 0 };
  for (const d of inView) if (c[d.s] != null) c[d.s]++;
  $("sTotal").textContent = inView.length.toLocaleString("nl-NL");
  $("sOk").textContent = c.ok; $("sWait").textContent = c.wait; $("sBad").textContent = c.bad;

  const sorted = inView.filter((d) => effClosed(d.b) != null).sort((a, b) => effClosed(a.b) - effClosed(b.b)).slice(0, 120);
  const items = $("items"); items.textContent = "";
  if (!sorted.length) {
    const el = document.createElement("div"); el.className = "item"; el.style.cursor = "default";
    el.innerHTML = `<span></span><span class="m">Geen bruggen met bekende hoogte in dit kaartbeeld. Zoom uit of verschuif de kaart.</span>`;
    items.appendChild(el);
  }
  const useCur = $("useWater").checked;
  for (const d of sorted) {
    const b = d.b, cur = useCur && b.cur != null;
    const el = document.createElement("div");
    el.className = "item"; el.tabIndex = 0;
    el.innerHTML = `<span class="h${cur ? " cur" : ""}" style="background:${colorOf(d.s)}">${fmt(effClosed(b))}</span>
      <div style="min-width:0"><div class="n">${esc(b.name)}</div><div class="m">${b.movable ? "beweegbaar" : "vast"}${cur ? (offsetH() ? " · verwacht" : " · actueel") : ""}${b.waterway ? " · " + esc(b.waterway) : ""}</div></div>`;
    const go = () => { map.setView([b.lat, b.lng], Math.max(map.getZoom(), 15)); d.m.openPopup(); if (innerWidth <= 760) $("map").scrollIntoView(); };
    el.onclick = go; el.onkeydown = (e) => { if (e.key === "Enter") go(); };
    items.appendChild(el);
  }

  labelLayer.clearLayers();
  const z = map.getZoom();
  if (z >= 14) {
    for (const d of inView.slice(0, 300)) {
      const v = effClosed(d.b); if (v == null) continue;
      L.marker([d.b.lat, d.b.lng], { opacity: 0, interactive: false, keyboard: false })
        .bindTooltip(fmt(v), { permanent: true, direction: "right", offset: [6, 0], className: "hlabel" }).addTo(labelLayer);
    }
  }
  if (z >= 11 && $("showStations").checked) {
    for (const s of stations) {
      if (!s.lvl || !bounds.contains([s.lat, s.lng])) continue;
      L.marker([s.lat, s.lng], { opacity: 0, interactive: false, keyboard: false })
        .bindTooltip(signed(s.lvl.cm), { permanent: true, direction: "top", offset: [0, -6], className: "wlabel" }).addTo(labelLayer);
    }
  }
}

/* ---------- bediening ---------- */
function updateWhen() {
  const h = offsetH();
  $("whenOut").textContent = h === 0 ? "Nu" : `+${h} u · ${timeNL(new Date(targetMs()).toISOString())}`;
  $("whenNote").textContent = h === 0
    ? "Actuele meting. Schuif om de verwachting van Rijkswaterstaat te gebruiken."
    : `Verwachte waterstand ${new Date(targetMs()).toLocaleString("nl-NL", { weekday: "long", hour: "2-digit", minute: "2-digit" })}. Bruggen zonder verwachting in de buurt worden niet gecorrigeerd.`;
}
let t;
const redraw = () => { clearTimeout(t); t = setTimeout(draw, 120); };
$("boatH").addEventListener("input", () => { $("boatR").value = $("boatH").value; redraw(); });
$("boatR").addEventListener("input", () => { $("boatH").value = (+$("boatR").value).toFixed(2); redraw(); });
["margin", "search"].forEach((id) => $(id).addEventListener("input", redraw));
$("when").addEventListener("input", () => { updateWhen(); clearTimeout(t); t = setTimeout(() => { linkStations(); draw(); }, 120); });
["onlyLow", "useWater", "showStations"].forEach((id) => $(id).addEventListener("change", draw));
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
  typeFilter = c.dataset.type;
  document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  draw();
}));
$("toggle").addEventListener("click", () => {
  const p = $("panel"), min = p.classList.toggle("min");
  $("toggle").textContent = min ? "Uitklappen" : "Inklappen";
  $("toggle").setAttribute("aria-expanded", String(!min));
  setTimeout(() => map.invalidateSize(), 60);
});
let me;
$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Je browser kan je locatie niet bepalen.", true);
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (me) me.setLatLng(ll); else me = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: css("--accent"), fillOpacity: 1 }).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), 14));
  }, () => setStatus("Locatie niet beschikbaar. Geef de app toestemming voor je locatie.", true), { enableHighAccuracy: true, timeout: 10000 });
});
map.on("moveend zoomend", updateView);
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", draw);

if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
init();
})();
