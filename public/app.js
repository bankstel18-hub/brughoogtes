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
const lockLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);

/* ---------- state ---------- */
let bridges = [], stations = [], forecast = {}, lags = {}, locks = [], meta = { bridgesAt: null, waterAt: null, forecastAt: null };
let typeFilter = "all", drawn = [];
const saved = ls.get("bh-settings") || {};
if (saved.boat) { $("boatH").value = saved.boat; $("boatR").value = saved.boat; }
if (saved.margin != null) $("margin").value = saved.margin;
for (const k of ["boatL", "boatB", "boatT"]) if (saved[k] != null && saved[k] !== "") $(k).value = saved[k];
if (saved.useWater === false) $("useWater").checked = false;
if (saved.showStations === false) $("showStations").checked = false;
if (saved.showLocks === false) $("showLocks").checked = false;

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
  // Fijnste beschikbare reeks: per 10 minuten uit het grafiekbestand (als geladen), anders per uur.
  const full = typeof seriesCache !== "undefined" && seriesCache.get(s.code)?.data;
  const fullFc = full?.verwachting?.pts?.length ? { kind: "verwachting", pts: full.verwachting.pts } : full?.astronomisch?.pts?.length ? { kind: "astronomisch", pts: full.astronomisch.pts } : null;
  const fc = fullFc || forecast[s.code];
  if (h === 0 && s.cm != null && s.t && (Date.now() - Date.parse(s.t)) / 3600e3 <= WATER_MAX_AGE_H) return { cm: s.cm, t: s.t, kind: "meting" };
  if (fc) {
    const tMs = Date.now() + h * 3600e3, v = interp(fc.pts, tMs / 1000);
    if (v != null) return { cm: v, t: new Date(tMs).toISOString(), kind: fc.kind };
  }
  return null;
}
// Waterstand (cm NAP) van een meetpunt op tijdstip t (s): meting voor het verleden, verwachting voor de toekomst.
const stationByCode = new Map();
function interpPts(pts, t, maxGap = 3 * 3600) {
  if (!pts || !pts.length) return null;
  if (t < pts[0][0] - maxGap || t > pts[pts.length - 1][0] + maxGap) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [t1, v1] = pts[i], [t2, v2] = pts[i + 1];
    if (t >= t1 && t <= t2) return t2 - t1 > maxGap ? null : v1 + ((v2 - v1) * (t - t1)) / (t2 - t1);
  }
  return t < pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
}
function stationValue(code, t) {
  const st = stationByCode.get(code), full = seriesCache.get(code)?.data, fc = forecast[code];
  const nowS = Date.now() / 1000;
  const lastT = st?.t ? Date.parse(st.t) / 1000 : null;
  if (lastT && t <= lastT + 1200 && t >= nowS - 12 * 3600) {           // verleden: meting
    const past = (full?.meting?.pts?.length ? full.meting.pts : (fc?.past || [])).concat(st.cm != null ? [[lastT, st.cm]] : []);
    const v = interpPts(past.sort((a, b) => a[0] - b[0]), Math.min(t, lastT), 3600);
    if (v != null) return { cm: v, kind: "meting" };
  }
  const futPts = full?.verwachting?.pts?.length ? full.verwachting.pts : full?.astronomisch?.pts?.length ? full.astronomisch.pts : fc?.pts;
  const kind = full?.verwachting?.pts?.length ? "verwachting" : full?.astronomisch?.pts?.length ? "astronomisch" : fc?.kind;
  const v = interpPts(futPts, t);
  if (v != null) return { cm: v, kind };
  if (st?.cm != null && lastT && Math.abs(t - lastT) <= 1800) return { cm: st.cm, kind: "meting" };
  return null;
}
// Schatting bij de brug tussen twee meetpunten P en Q, met de looptijd van de golf (tau, minuten, P->Q).
// Ligt de brug op fractie x van P naar Q, dan is de stand bij de brug op tijd t
//   (1-x) * P(t - x*tau) + x * Q(t + (1-x)*tau)
function bridgeLevel(b, h = offsetH()) {
  if (b.pair) {
    const { P, Q, x, tau } = b.pair, t = Date.now() / 1000 + h * 3600;
    const vp = stationValue(P.code, t - x * tau * 60), vq = stationValue(Q.code, t + (1 - x) * tau * 60);
    if (vp && vq) return { cm: Math.round((1 - x) * vp.cm + x * vq.cm), t: new Date(t * 1000).toISOString(), kind: "schatting", parts: [vp, vq] };
  }
  return b.st ? levelAt(b.st, h) : null;
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
  const byCode = new Map(stations.map((s) => [s.code, s]));
  stationByCode.clear(); for (const s of stations) stationByCode.set(s.code, s);
  for (const b of bridges) {
    b.st = null; b.stKm = null; b.stNet = false;
    // Gekoppeld via het vaarwegennetwerk: eerste meetpunt met actuele gegevens, zonder sluis of stuw ertussen.
    b.pair = null;
    if (Array.isArray(b.sts)) {
      for (const [code, kmNet] of b.sts) { const s = byCode.get(code); if (s && s.lvl) { b.st = s; b.stKm = kmNet; b.stNet = true; break; } }
      // Twee meetpunten aan weerszijden (over het water, open verbinding): schatten met looptijd van de golf.
      const sideP = b.sts.find((x) => x[2] === "s" && byCode.get(x[0])?.lvl), sideQ = b.sts.find((x) => x[2] === "e" && byCode.get(x[0])?.lvl);
      if (sideP && sideQ && sideP[1] <= 15 && sideQ[1] <= 15 && sideP[1] + sideQ[1] >= 0.5) {
        const P = byCode.get(sideP[0]), Q = byCode.get(sideQ[0]);
        const key = [P.code, Q.code].sort().join("|"), lag = lags[key];
        // Alleen als de twee meetpunten aantoonbaar samenhangen (of beide vrijwel stil staan); anders dichtstbijzijnde meetpunt.
        if (lag != null) {
          const tau = key.startsWith(P.code + "|") ? lag : -lag;
          b.pair = { P, Q, dP: sideP[1], dQ: sideQ[1], x: sideP[1] / (sideP[1] + sideQ[1]), tau, lagKnown: lag !== 0 };
        }
      }
      b.lvl = bridgeLevel(b);
      b.cur = currentClearance(b);
      continue;
    }
    // Oude data zonder netwerkkoppeling: dichtstbijzijnde meetpunt hemelsbreed.
    const gy = Math.floor(b.lat / 0.2), gx = Math.floor(b.lng / 0.2);
    let best = null, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const s of grid.get(`${gy + dy}|${gx + dx}`) || []) {
        const d = km(b.lat, b.lng, s.lat, s.lng);
        if (d < bd) { bd = d; best = s; }
      }
    }
    if (best && bd <= STATION_RADIUS_KM) { b.st = best; b.stKm = bd; }
    b.lvl = b.st ? b.st.lvl : null;
    b.cur = currentClearance(b);
  }
}
// Actuele doorvaarthoogte: alleen als de brug een NAP-referentie heeft.
function currentClearance(b) {
  if (!b.lvl) return null;
  return clearanceFor(b, b.lvl.cm);
}
function clearanceFor(b, cm) {
  const w = cm / 100;
  if (b.underNAP != null) return +(b.underNAP - w).toFixed(2);
  if (b.closed != null && b.refNAP != null) return +(b.closed - (w - b.refNAP)).toFixed(2);
  return null;
}
const effClosed = (b) => ($("useWater").checked && b.cur != null ? b.cur : b.closed);
const effOpen = (b) => {
  if (b.open == null) return null;
  if (!$("useWater").checked || b.cur == null) return b.open;
  if (b.openUnderNAP != null && b.st?.lvl) return +(b.openUnderNAP - b.st.lvl.cm / 100).toFixed(2);
  return b.closed != null ? +(b.open + (b.cur - b.closed)).toFixed(2) : b.open;
};
const REF = { KP: "kanaalpeil", NAP: "NAP", MP: "meerpeil", SP: "streefpeil", PP: "polderpeil", BP: "boezempeil", UNSPECIFIED: "een onbekend referentiepeil" };
const refTxt = (b) => b.mhw != null
  ? `bij maatgevend hoogwater (${signed(Math.round(b.mhw * 100))} cm NAP)`
  : `t.o.v. ${REF[b.refName] || b.refName || "referentiepeil"}`;

function state(b) {
  const n = need(), c = effClosed(b), o = effOpen(b);
  if (c == null && o == null) return "unk";
  if (c != null && c >= n) return "ok";
  if (b.movable) return o == null || o >= n ? "wait" : "bad";
  return c == null ? "unk" : "bad";
}
// Popups op de telefoon: niet hoger dan het scherm toelaat (dan scrollbaar), en vrij van de knoppen.
const popOpts = (w) => ({ maxWidth: w, maxHeight: innerWidth <= 760 ? Math.round(innerHeight * 0.58) : undefined, autoPanPaddingTopLeft: [12, 64], autoPanPaddingBottomRight: [12, 24] });
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
    lags = d.lags || {};
    meta.forecastAt = d.generatedAt;
  } catch (e) { meta.forecastErr = e.message; }
}
async function loadLocks() {
  try { const d = await getData("data/locks.json"); locks = d.locks || []; meta.locksAt = d.generatedAt; } catch (e) { meta.locksErr = e.message; }
}
async function init() {
  try {
    await Promise.all([loadBridges(), loadWater(), loadForecast(), loadLocks()]);
    linkStations(); draw(); fresh();
  } catch (e) {
    setStatus(`Brugdata niet beschikbaar: ${e.message}`, true);
    $("freshness").textContent = "Gegevens worden voorbereid. Probeer het over een paar minuten opnieuw.";
  }
  setInterval(() => refreshData(false), 5 * 60e3);
  // Terug in de app (tabblad of app weer geopend, verbinding terug): meteen verversen.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshData(true); });
  addEventListener("pageshow", (e) => { if (e.persisted) refreshData(true); });
  addEventListener("online", () => refreshData(true));
}
let refreshing = null, lastRefresh = Date.now();
async function refreshData(onResume) {
  if (refreshing) return refreshing;
  if (onResume && Date.now() - lastRefresh < 60e3) return;        // net ververst
  $("freshness").textContent = "Gegevens bijwerken…";
  $("staleWarn").hidden = true;
  refreshing = (async () => {
    const tasks = [loadWater(), loadForecast()];
    if (meta.bridgesAt && Date.now() - Date.parse(meta.bridgesAt) > 20 * 3600e3) tasks.push(loadBridges().catch(() => {}), loadLocks());
    await Promise.all(tasks);
    seriesCache.clear();
    lastRefresh = Date.now();
    linkStations(); draw(); fresh();
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function staleCheck() {
  if (refreshing) return;
  const w = meta.waterAt ? (Date.now() - Date.parse(meta.waterAt)) / 60000 : Infinity;
  const el = $("staleWarn");
  if (w > 30) {
    el.hidden = false;
    el.textContent = isFinite(w)
      ? `Let op: de waterstanden zijn ${w < 120 ? Math.round(w) + " minuten" : Math.round(w / 60) + " uur"} oud. Vertrouw er niet op en controleer de actuele situatie.`
      : "Let op: er zijn geen actuele waterstanden beschikbaar. Hoogtes zijn niet gecorrigeerd.";
  } else el.hidden = true;
}
setInterval(staleCheck, 60e3);
function fresh() {
  staleCheck();
  const parts = [];
  if (meta.waterAt) parts.push(`Waterstanden ${ago(meta.waterAt)}`);
  else parts.push("Geen actuele waterstanden");
  if (meta.forecastAt) parts.push(`verwachting ${ago(meta.forecastAt)}`);
  if (meta.bridgesAt) parts.push(`bruggen ${ago(meta.bridgesAt)}`);
  $("freshness").textContent = parts.join(" · ");
  const corrected = bridges.filter((b) => b.cur != null).length;
  setStatus(`${bridges.length.toLocaleString("nl-NL")} bruggen, ${stations.filter((s) => s.cm != null).length} meetpunten met actuele waterstand, ${Object.keys(forecast).length} met verwachting, ${locks.length.toLocaleString("nl-NL")} sluizen, ${corrected.toLocaleString("nl-NL")} bruggen gecorrigeerd voor waterstand.`);
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
const kindTxt = (k) => ({ meting: "gemeten", verwachting: "verwacht", astronomisch: "astronomisch getij", schatting: "geschat" }[k] || "");
const signed = (cm) => `${cm > 0 ? "+" : ""}${cm}`;
const whenTxt = () => (offsetH() === 0 ? "nu" : `om ${timeNL(new Date(targetMs()).toISOString())}`);

// Laagste doorvaarthoogte volgens de verwachting in de komende 48 uur.
function minAhead(b) {
  if (!b.st && !b.pair) return null;
  const now = Date.now() / 1000;
  let best = null;
  for (let h = 0; h <= 48; h += 0.25) {
    const lv = bridgeLevel(b, h); if (!lv || lv.kind === "meting") continue;
    const c = clearanceFor(b, lv.cm);
    if (c != null && (!best || c < best.c)) best = { c, t: now + h * 3600 };
  }
  return best;
}

/* ---------- disclaimer ---------- */
const DISC_VERSION = "2026-11-08";
const DISC_SHORT = "Indicatief, geen officiële vaarweginformatie. Gegevens kunnen onjuist of verouderd zijn. Controleer altijd de hoogteschaal ter plaatse en vaarweginformatie.nl. Gebruik op eigen risico.";
const tsNL = (iso) => iso ? `${new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (${ago(iso)})` : "onbekend";
function showDisclaimer(force) {
  let ok = null; try { ok = localStorage.getItem("bh-disclaimer"); } catch {}
  if (force || ok !== DISC_VERSION) { $("disclaimer").hidden = false; $("disclaimer").querySelector(".modal-box").scrollTop = 0; $("discOk").focus({ preventScroll: true }); }
}
$("discOk").addEventListener("click", () => { try { localStorage.setItem("bh-disclaimer", DISC_VERSION); } catch {} $("disclaimer").hidden = true; });
$("discOpen").addEventListener("click", () => showDisclaimer(true));
$("bigChartClose").addEventListener("click", () => { $("bigChart").hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") { $("bigChart").hidden = true; } });

/* ---------- grafiek in RWS-stijl: meting, verwachting, astronomisch getij ---------- */
let pendingRedraw = false;
const seriesCache = new Map();   // code -> { data, at }
const SERIES_COLORS = { meting: "#1f6fd1", verwachting: "#d9534f", astronomisch: "#8c969e" };
const SERIES_NAMES = { meting: "Waterhoogte gemeten", verwachting: "Waterhoogte verwachting", astronomisch: "Waterhoogte astronomisch" };
const fileOf = (code) => `data/series/${code.replace(/[^a-z0-9._-]/gi, "_")}.json`;

function sparkReadout(s, b, h) {
  const lv = b ? bridgeLevel(b, h) : levelAt(s, h);
  const when = h === 0 ? "Nu" : new Date(Date.now() + h * 3600e3).toLocaleString("nl-NL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (!lv) return `<b>${when}</b>: geen waterstand beschikbaar`;
  const c = b ? clearanceFor(b, lv.cm) : null;
  return `<b>${when}</b>: ${signed(lv.cm)} cm NAP (${kindTxt(lv.kind)})${b && c != null && (b.mhw != null || b.underNAP != null) ? ` · doorvaarthoogte <b>${fmt(c)} m</b>` : ""}`;
}

// Gegevens voor de grafiek: uit het bestand per meetpunt, of (zolang dat laadt) uit wat de app al heeft.
function chartData(s, b) {
  if (b?.pair) {
    const now = Date.now() / 1000, est = [], pP = [], pQ = [];
    for (let m = 0; m <= 48 * 60; m += 15) {
      const t = now + m * 60, lv = bridgeLevel(b, m / 60);
      if (lv) est.push([t, lv.cm]);
      const a = stationValue(b.pair.P.code, t), q = stationValue(b.pair.Q.code, t);
      if (a && m) pP.push([t, Math.round(a.cm)]); if (q && m) pQ.push([t, Math.round(q.cm)]);
    }
    const nowLv = bridgeLevel(b, 0);
    return { meting: [], verwachting: [], astronomisch: [], schatting: est, extra: [{ name: b.pair.P.name, pts: pP, dash: "4 3" }, { name: b.pair.Q.name, pts: pQ, dash: "1 3" }],
      nowDot: nowLv ? nowLv.cm : null, meta: seriesCache.get(b.pair.P.code)?.data || null, full: !!(seriesCache.get(b.pair.P.code) && seriesCache.get(b.pair.Q.code)) };
  }
  const c = seriesCache.get(s.code)?.data;
  if (c) return { meting: c.meting?.pts || [], verwachting: c.verwachting?.pts || [], astronomisch: c.astronomisch?.pts || [], meta: c, full: true };
  const f = forecast[s.code];
  return {
    meting: s.cm != null && s.t ? [[Date.parse(s.t) / 1000, s.cm]] : [],
    verwachting: f?.kind === "verwachting" ? f.pts : [], astronomisch: f?.kind === "astronomisch" ? f.pts : [],
    meta: null, full: false,
  };
}
function niceStep(range) { return range > 300 ? 100 : range > 150 ? 50 : range > 60 ? 25 : range > 25 ? 10 : 5; }

function chartSVG(d, size) {
  // Alleen vooruit: van nu tot 48 uur verder (geen gemeten historie).
  const now = Date.now() / 1000, t0 = now - 10 * 60, t1 = now + 48 * 3600;
  const { W, H } = size, L = 38, R = 8, T = 10, B = 22;
  const recentM = d.meting.length && now - d.meting[d.meting.length - 1][0] <= 3 * 3600 ? [d.meting[d.meting.length - 1][1]] : [];
  const all = ["verwachting", "astronomisch"].flatMap((k) => d[k].filter(([t]) => t >= t0 && t <= t1).map((p) => p[1])).concat(recentM)
    .concat((d.schatting || []).map((p) => p[1])).concat((d.extra || []).flatMap((e) => e.pts.map((p) => p[1])));
  if (!all.length) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  const step = niceStep(hi - lo || 20);
  lo = Math.floor((lo - 5) / step) * step; hi = Math.ceil((hi + 5) / step) * step;
  if (hi - lo < step * 2) hi = lo + step * 2;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let g = `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="var(--chart-bg)"/>`;
  for (let v = lo; v <= hi; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  // verticale lijnen elke 6 uur (lokale tijd), met datum om middernacht
  const startDay = new Date(t0 * 1000); startDay.setHours(0, 0, 0, 0);
  for (let ms = startDay.getTime(); ms <= t1 * 1000; ms += 6 * 3600e3) {
    const t = ms / 1000; if (t < t0 + 1800 || t > t1 - 1800) continue;
    const dd = new Date(ms), hr = dd.getHours(), mid = hr === 0;
    g += `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" class="grid${mid ? " day" : ""}"/>`;
    if ((mid || hr === 12 || W > 400) && x(t) - x(t0) > 34) g += `<text x="${x(t)}" y="${H - 7}" text-anchor="middle">${mid ? dd.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric" }) : String(hr).padStart(2, "0") + ":00"}</text>`;
  }
  const line = (pts, color, w, dash) => {
    const p = pts.filter(([t]) => t >= t0 && t <= t1);
    if (!p.length) return "";
    if (p.length === 1) return `<circle cx="${x(p[0][0])}" cy="${y(p[0][1])}" r="3" fill="${color}"/>`;
    return `<path d="${p.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("")}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`;
  };
  g += line(d.astronomisch, SERIES_COLORS.astronomisch, 1.6);
  for (const e of d.extra || []) g += line(e.pts, SERIES_COLORS.astronomisch, 1.2, e.dash);
  if (d.schatting) g += line(d.schatting, SERIES_COLORS.verwachting, 2.2);
  if (d.nowDot != null) g += `<circle cx="${x(t0)}" cy="${y(d.nowDot)}" r="4" fill="${SERIES_COLORS.verwachting}" stroke="#fff" stroke-width="1.5"/>`;
  g += line(d.verwachting, SERIES_COLORS.verwachting, 1.6);
  const lastM = d.meting.length ? d.meting[d.meting.length - 1] : null;
  if (lastM && now - lastM[0] <= 3 * 3600) g += `<circle cx="${x(t0)}" cy="${y(lastM[1])}" r="4" fill="${SERIES_COLORS.meting}" stroke="#fff" stroke-width="1.5"><title>Laatste meting ${signed(lastM[1])} cm</title></circle>`;
  g += `<text x="${x(t0) + 4}" y="${H - 7}" class="nowlbl">nu</text>`;
  const tSel = now + offsetH() * 3600;
  g += `<line class="selline" x1="${x(tSel)}" x2="${x(tSel)}" y1="${T}" y2="${H - B}" stroke="var(--wait)" stroke-width="2"/>`;
  g += `<g class="cross" visibility="hidden"><line class="cx" y1="${T}" y2="${H - B}"/><g class="tip"><rect rx="4"/><text class="tt"></text></g></g>`;
  g += `<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>`;
  return { svg: `<svg class="rwschart" viewBox="0 0 ${W} ${H}" width="100%" role="slider" tabindex="0" aria-label="Waterstandgrafiek: sleep of gebruik de pijltjestoetsen om een tijdstip te kiezen" aria-valuemin="0" aria-valuemax="48" aria-valuenow="${offsetH()}">${g}</svg>`, x, y, t0, t1, L, R, W, H, T, B };
}
function legendHTML(d) {
  const now = Date.now() / 1000;
  const items = [];
  if (d.meting.length && now - d.meting[d.meting.length - 1][0] <= 3 * 3600) items.push(`<span><i class="dotkey" style="background:${SERIES_COLORS.meting}"></i>Laatste meting</span>`);
  for (const k of ["verwachting", "astronomisch"]) if (d[k].some(([t]) => t >= now)) items.push(`<span><i style="background:${SERIES_COLORS[k]}"></i>${SERIES_NAMES[k]} t.o.v. NAP in cm</span>`);
  if (d.schatting?.length) items.push(`<span><i style="background:${SERIES_COLORS.verwachting}"></i>Geschatte waterhoogte bij de brug t.o.v. NAP in cm</span>`);
  for (const e of d.extra || []) items.push(`<span><i class="dashkey" style="border-top:2px ${e.dash === "4 3" ? "dashed" : "dotted"} ${SERIES_COLORS.astronomisch}"></i>${esc(e.name)} (verwacht)</span>`);
  return `<div class="legend2">${items.join("")}</div>`;
}
function valueAt(pts, t, maxGap = 900) {
  let best = null, bd = Infinity;
  for (const p of pts) { const dd = Math.abs(p[0] - t); if (dd < bd) { bd = dd; best = p; } }
  return best && bd <= maxGap ? best[1] : null;
}
function stampsHTML(s, d) {
  const m = d.meta, f = forecast[s.code];
  const t = (iso) => iso ? `${new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (${ago(iso)})` : "onbekend";
  const rows = [];
  rows.push(`Laatste meting: ${s.cm != null && s.t ? t(s.t) : "geen recente meting"}`);
  if (m?.verwachting?.fetchedAt || f?.kind === "verwachting") rows.push(`Verwachting RWS opgehaald: ${t(m?.verwachting?.fetchedAt || f?.at)}`);
  if (m?.astronomisch?.fetchedAt) rows.push(`Astronomisch getij opgehaald: ${t(m.astronomisch.fetchedAt)}`);
  return `<div class="stamps">${rows.join("<br>")}</div>`;
}

function chartBlock(s, b) {
  return `<div class="chartwrap" data-code="${esc(s.code)}">${chartInner(s, b, { W: 320, H: 180 })}</div>`;
}
function chartInner(s, b, size) {
  const d = chartData(s, b), c = chartSVG(d, size);
  if (!c) return `<div class="note">Geen meetreeks of verwachting beschikbaar voor dit meetpunt.</div>${stampsHTML(s, d)}`;
  return `${c.svg}<div class="sparkread">${sparkReadout(s, b, offsetH())}</div>${legendHTML(d)}
    <div class="chartbar"><span class="note">Tik of sleep in de grafiek voor de waarden per tijdstip.${d.full ? "" : " Meetreeks laden…"}</span><button type="button" class="btn big-btn">Vergroot</button></div>
    ${stampsHTML(s, d)}`;
}

// Werkt de doorvaarthoogte, het oordeel en de waterstandregel in de open popup bij voor het gekozen tijdstip.
function refreshPopupHead(s, b) {
  s.lvl = levelAt(s);
  if (b) { b.lvl = bridgeLevel(b); b.cur = currentClearance(b); }
  for (const el of document.querySelectorAll(".leaflet-popup .pophead")) el.innerHTML = b ? bridgeHead(b) : stationHead(s);
  if (b) for (const el of document.querySelectorAll(".leaflet-popup .popwl")) el.innerHTML = bridgeWl(b);
}
// Koppelt interactie (tooltip, tijdstip kiezen) aan een grafiek in 'root'.
function bindChart(root, s, b, size) {
  const svg = root.querySelector(".rwschart");
  if (!svg) return;
  const d = chartData(s, b), c = chartSVG(d, size);
  if (!c) return;
  const cross = svg.querySelector(".cross"), cx = svg.querySelector(".cx"), tip = svg.querySelector(".tip"), tt = svg.querySelector(".tt"), rect = tip.querySelector("rect");
  const show = (t) => {
    // vastklikken op hele uren vanaf nu, zodat kader, lijn en kop hetzelfde tijdstip tonen
    const nowS = Date.now() / 1000;
    t = nowS + Math.max(0, Math.min(48, Math.round((t - nowS) / 3600))) * 3600;
    const xs = c.x(t);
    cx.setAttribute("x1", xs); cx.setAttribute("x2", xs); cross.setAttribute("visibility", "visible");
    const lines = [new Date(t * 1000).toLocaleString("nl-NL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })];
    for (const k of ["verwachting", "astronomisch"]) { const v = valueAt(d[k], t, 2400); if (v != null) lines.push(`${k === "verwachting" ? "Verwacht" : "Astronomisch"}: ${signed(v)} cm`); }
    if (d.schatting) { const v = valueAt(d.schatting, t, 1200); if (v != null) lines.push(`Bij de brug (geschat): ${signed(v)} cm`); }
    for (const e of d.extra || []) { const v = valueAt(e.pts, t, 1200); if (v != null) lines.push(`${e.name.slice(0, 22)}: ${signed(Math.round(v))} cm`); }
    tt.innerHTML = lines.map((l, i) => `<tspan x="0" dy="${i ? 13 : 0}"${i === 0 ? ' font-weight="700"' : ""}>${esc(l)}</tspan>`).join("");
    const bb = { w: Math.max(...lines.map((l) => l.length)) * 5.6 + 12, h: lines.length * 13 + 8 };
    let tx = xs + 8; if (tx + bb.w > c.W - c.R) tx = xs - 8 - bb.w;
    tx = Math.max(c.L + 2, Math.min(tx, c.W - c.R - bb.w));
    rect.setAttribute("x", -6); rect.setAttribute("y", -12); rect.setAttribute("width", bb.w); rect.setAttribute("height", bb.h);
    tip.setAttribute("transform", `translate(${tx + 6},${c.T + 16})`);
    setH(Math.round((t - Date.now() / 1000) / 3600));
  };
  const setH = (h) => {
    h = Math.max(0, Math.min(48, h));
    if (h !== offsetH()) { $("when").value = h; updateWhen(); pendingRedraw = true; }
    const xs = c.x(Date.now() / 1000 + h * 3600);
    const sl = svg.querySelector(".selline"); sl.setAttribute("x1", xs); sl.setAttribute("x2", xs);
    svg.setAttribute("aria-valuenow", h);
    const rd = root.querySelector(".sparkread"); if (rd) rd.innerHTML = sparkReadout(s, b, h);
    refreshPopupHead(s, b);
  };
  const tOf = (e) => { const r = svg.getBoundingClientRect(); const vx = ((e.clientX - r.left) / r.width) * c.W; return c.t0 + ((vx - c.L) / (c.W - c.L - c.R)) * (c.t1 - c.t0); };
  let dragging = false;
  ["mousedown", "touchstart", "dblclick", "wheel"].forEach((ev) => svg.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
  svg.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); dragging = true; svg.setPointerCapture(e.pointerId); show(tOf(e)); });
  svg.addEventListener("pointermove", (e) => { if (dragging || e.pointerType === "mouse") show(tOf(e)); });
  const end = (e) => { dragging = false; try { svg.releasePointerCapture(e.pointerId); } catch {} };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", (e) => { if (!dragging && e.pointerType === "mouse") cross.setAttribute("visibility", "hidden"); });
  svg.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key];
    if (step) { e.preventDefault(); show(Date.now() / 1000 + (offsetH() + step) * 3600); }
  });
  const big = root.querySelector(".big-btn");
  if (big) big.onclick = (e) => { e.stopPropagation(); openBigChart(s, b); };
}

// Grafiek in een popup: eerst met wat er is, daarna met de volledige meetreeks.
async function initChartIn(root, s, b) {
  const wrap = root.querySelector(".chartwrap");
  if (!wrap) return;
  const size = { W: 320, H: 180 };
  bindChart(wrap, s, b, size);
  const codes = b?.pair ? [b.pair.P.code, b.pair.Q.code] : [s.code];
  const todo = codes.filter((c) => { const x = seriesCache.get(c); return !x || Date.now() - x.at >= 5 * 60e3; });
  if (!todo.length) return;
  try {
    await Promise.all(todo.map(async (code) => {
      const r = await fetch(fileOf(code), { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      seriesCache.set(code, { data: await r.json(), at: Date.now() });
    }));
    if (b) { b.lvl = bridgeLevel(b); b.cur = currentClearance(b); refreshPopupHead(s, b); }
    if (!wrap.isConnected) return;
    wrap.innerHTML = chartInner(s, b, size);
    bindChart(wrap, s, b, size);
  } catch {
    const n = wrap.querySelector(".chartbar .note"); if (n) n.textContent = "Tik of sleep in de grafiek voor de waarden per tijdstip. Volledige meetreeks niet beschikbaar.";
  }
}

// Grote weergave (venster over de kaart).
function openBigChart(s, b) {
  const dlg = $("bigChart"), body = $("bigChartBody");
  $("bigChartTitle").textContent = s.name;
  const size = innerWidth < 700 ? { W: 520, H: 360 } : { W: 900, H: 420 };
  body.innerHTML = chartInner(s, b, size).replace('<button type="button" class="btn big-btn">Vergroot</button>', "") + `<p class="disc-inline">${DISC_SHORT}</p>`;
  bindChart(body, s, b, size);
  dlg.hidden = false; $("bigChartClose").focus();
}

function bridgeHead(b) {
  const s = state(b), c = effClosed(b), o = effOpen(b);
  const label = { ok: "Je past eronderdoor", wait: "Brug moet open voor jou", bad: "Te laag voor jouw schip", unk: "Hoogte onbekend" }[s];
  const usingCur = $("useWater").checked && b.cur != null;
  return `<div style="margin:6px 0"><span class="big">${fmt(c)} m</span> ${b.movable ? "gesloten" : "doorvaarthoogte"}${usingCur ? ` (${whenTxt()})` : ""}
    ${b.movable ? `<br><span class="mid">${o != null ? fmt(o) + " m" : "onbeperkt of onbekend"}</span> open` : ""}</div>
    <div style="font-weight:700;color:${colorOf(s)}">${label}</div>`;
}
const kmTxt = (v) => v.toFixed(1).replace(".", ",");
function pairTxt(b) {
  const p = b.pair, t = Math.abs(Math.round(p.tau));
  const first = p.tau >= 0 ? p.P : p.Q, second = p.tau >= 0 ? p.Q : p.P;
  return `tussen ${esc(p.P.name)} (${kmTxt(p.dP)} km) en ${esc(p.Q.name)} (${kmTxt(p.dQ)} km), over het water`
    + (p.lagKnown ? (t >= 5 ? `. De golf doet ${t} minuten over ${esc(first.name)} naar ${esc(second.name)}; daarmee is rekening gehouden.` : ". De waterstand loopt bij beide meetpunten vrijwel gelijk op.")
      : ". Beide waterstanden variëren nauwelijks, daarom naar afstand gewogen.");
}
function bridgeWl(b) {
  const lv = b.lvl, mn = minAhead(b);
  if (!lv) return `<div class="wl">Geen waterstand beschikbaar voor ${whenTxt()}${b.st ? ` bij ${esc(b.st.name)}` : ""}.</div>`;
  if (b.pair && lv.kind === "schatting") {
    return `<div class="wl">Geschatte waterstand bij de brug ${whenTxt()}: <b>${signed(lv.cm)} cm NAP</b><br><span class="small">${pairTxt(b)}</span>`
      + (b.cur != null
        ? `<br>Doorvaarthoogte ${whenTxt()}: <b>${fmt(b.cur)} m</b> (${refTxt(b)}: ${fmt(b.closed)} m)`
          + (mn ? `<br>Laagste verwachte hoogte komende 48 uur: <b>${fmt(mn.c)} m</b> op ${new Date(mn.t * 1000).toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "")
        : `<br>Het referentiepeil van deze hoogte is niet NAP of ontbreekt in de brondata. Daarom is niet omgerekend.`)
      + `<br><span class="small">Dit is een schatting uit twee meetpunten en kan lokaal afwijken.</span></div>`;
  }
  const where = b.stNet ? `${kmTxt(b.stKm)} km over het water, open verbinding` : `${kmTxt(b.stKm)} km hemelsbreed`;
  return `<div class="wl">Waterstand ${esc(b.st.name)} (${where}), ${kindTxt(lv.kind)} ${whenTxt()}: <b>${signed(lv.cm)} cm NAP</b>`
      + (b.cur != null
        ? `<br>Doorvaarthoogte ${whenTxt()}: <b>${fmt(b.cur)} m</b> (${refTxt(b)}: ${fmt(b.closed)} m)`
          + (mn ? `<br>Laagste verwachte hoogte komende 48 uur: <b>${fmt(mn.c)} m</b> op ${new Date(mn.t * 1000).toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "")
        : `<br>${b.mhw == null && b.refName && b.refName !== "UNSPECIFIED" ? `De hoogte van deze brug geldt ${refTxt(b)}, een geregeld peil. Daarom wordt niet gecorrigeerd met meetpunten van Rijkswaterstaat.` : "Het referentiepeil van deze hoogte ontbreekt in de brondata van Rijkswaterstaat. Daarom is niet omgerekend; vergelijk de waterstand zelf met de hoogteschaal ter plaatse."}`)
      + `</div>`;
}
function popupBridge(b) {
  const usingCur = $("useWater").checked && b.cur != null;
  const rows = Object.entries(b.a || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  let wl = "";
  if (b.lvl) {
    wl = `<div class="popwl">${bridgeWl(b)}</div>${chartBlock(b.st || b.pair.P, b)}`;
  } else if (Array.isArray(b.sts) && (b.underNAP != null || b.mhw != null)) {
    wl = `<div class="wl">Geen meetpunt van Rijkswaterstaat met actuele gegevens binnen 25 km over het water zonder sluis of stuw ertussen. De hoogte is daarom niet omgerekend.</div>`;
  }
  return `<div class="pop"><h3>${esc(b.name)}</h3>
    ${b.waterway ? `<div class="note" style="margin:0">${esc(b.waterway)}</div>` : ""}
    <div class="pophead">${bridgeHead(b)}</div>
    <div class="note">${b.movable ? "Beweegbare brug" : "Vaste brug"} · hoogte ${refTxt(b)} · bron: Rijkswaterstaat FIS</div>
    ${wl}
    <details><summary>Alle gegevens</summary><table>${rows}</table></details>
    <div class="note">${usingCur ? "Gecorrigeerd met het dichtstbijzijnde meetpunt; lokaal kan de waterstand afwijken, en een verwachting is geen garantie." : `Hoogte ${refTxt(b)}. Controleer ter plaatse de hoogteschaal.`}</div>
    <div class="stamps">Brugdata Rijkswaterstaat FIS: ${tsNL(meta.bridgesAt)}</div>
    <p class="disc-inline">${DISC_SHORT}</p></div>`;
}
const m2 = (v) => (v == null ? "–" : v.toFixed(v < 10 ? 2 : 1).replace(".", ","));
/* ---------- sluizen: past mijn schip? ---------- */
const dims = () => ({ L: parseFloat($("boatL").value) || 0, B: parseFloat($("boatB").value) || 0, T: parseFloat($("boatT").value) || 0 });
const KEEL = 0.10; // minimale ruimte onder de kiel boven de drempel
function chamberCheck(c) {
  const d = dims(), why = [];
  if (c.length == null && c.width == null) return { s: "unk", why: ["afmetingen onbekend"] };
  if (c.length != null && d.L > c.length) why.push(`te lang (${m2(c.length)} m)`);
  if (c.width != null && d.B > c.width) why.push(`te breed (${m2(c.width)} m)`);
  if (c.sill != null && d.T + KEEL > c.sill) why.push(`te diep (drempel ${m2(c.sill)} m)`);
  if (c.height != null && need() > c.height) why.push(`te hoog (${m2(c.height)} m)`);
  return { s: why.length ? "bad" : "ok", why };
}
function lockState(l) {
  if (!l.chambers.length) return "unk";
  const st = l.chambers.map((c) => chamberCheck(c).s);
  return st.includes("ok") ? "ok" : st.every((x) => x === "unk") ? "unk" : "bad";
}
function popupLock(l) {
  const hasH = l.chambers.some((x) => x.height);
  const rows = l.chambers.map((c) => {
    const ck = chamberCheck(c);
    return `<tr><td>${esc(c.name)}${ck.why.length && ck.s === "bad" ? `<div class="note" style="margin:0">${esc(ck.why.join(", "))}</div>` : ""}</td><td>${m2(c.length)}</td><td>${m2(c.width)}</td><td>${m2(c.sill)}</td>${hasH ? `<td>${m2(c.height)}</td>` : ""}<td class="${ck.s}">${ck.s === "ok" ? "✓" : ck.s === "bad" ? "✗" : "?"}</td></tr>`;
  }).join("");
  const ls_ = lockState(l), d = dims();
  const verdict = { ok: "Je schip past in deze sluis", bad: "Je schip past in geen enkele kolk", unk: "Onbekend of je schip past" }[ls_];
  return `<div class="pop"><h3>${esc(l.name)}</h3>
    ${l.place ? `<div class="note" style="margin:0">${esc(l.place)}</div>` : ""}
    <div style="font-weight:700;margin-top:6px;color:${colorOf(ls_)}">${verdict}</div>
    <div class="note" style="margin:0">Jouw schip: ${m2(d.L)} × ${m2(d.B)} m, diepgang ${m2(d.T)} m (+${m2(KEEL)} m onder de kiel), kruiphoogte ${m2(need())} m incl. marge</div>
    ${l.chambers.length ? `<table class="ch"><thead><tr><th>Kolk</th><th>Lengte</th><th>Breedte</th><th>Drempel</th>${hasH ? "<th>Hoogte</th>" : ""}<th>Past</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note">In meters. Drempeldiepte t.o.v. het peil, de ondiepste van boven- en benedenhoofd.${hasH ? " Hoogte: doorvaarthoogte onder een hefdeur of vaste overspanning." : ""}</div>`
      : `<div class="note">Geen kolkafmetingen in de brondata.</div>`}
    ${l.phone ? `<div class="note">Contact: <span style="user-select:all">${esc(l.phone)}</span></div>` : ""}
    <details><summary>Alle gegevens</summary><table>${Object.entries(l.a || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></details>
    <div class="note">Bron: Rijkswaterstaat FIS. Controleer bedientijden en actuele stremmingen op vaarweginformatie.nl.</div>
    <div class="stamps">Sluisdata Rijkswaterstaat FIS: ${tsNL(meta.locksAt)}</div>
    <p class="disc-inline">${DISC_SHORT}</p></div>`;
}
function stationHead(s) {
  const lv = s.lvl;
  return `<div style="margin:6px 0"><span class="big">${lv ? signed(lv.cm) + " cm" : "–"}</span> NAP ${lv ? `<span class="note">${kindTxt(lv.kind)} ${whenTxt()}</span>` : ""}</div>`;
}
function popupStation(s) {
  return `<div class="pop"><h3>${esc(s.name)}</h3><div class="note" style="margin:0">Meetpunt Rijkswaterstaat · ${esc(s.code)}</div>
    <div class="pophead">${stationHead(s)}</div>
    <div class="note">Laatste meting: ${s.cm != null ? `${signed(s.cm)} cm om ${new Date(s.t).toLocaleString("nl-NL")} (${ago(s.t)})` : "geen"}</div>
    ${chartBlock(s)}<p class="disc-inline">${DISC_SHORT}</p></div>`;
}

/* ---------- zoomniveaus: hoe verder ingezoomd, hoe meer details ---------- */
// 0: heel NL (alleen knelpunten) · 1: regio (bekende hoogtes + meetpunten) · 2: ingezoomd (alles + sluizen)
const ZOOM_REGION = 10, ZOOM_DETAIL = 12;
function tier() {
  if ($("search").value.trim()) return 2;            // bij zoeken altijd alles tonen
  const z = map.getZoom();
  return z >= ZOOM_DETAIL ? 2 : z >= ZOOM_REGION ? 1 : 0;
}
const radiusFor = (b) => { const z = map.getZoom(); const r = z >= 13 ? 6 : z >= 11 ? 5 : z >= 9 ? 4 : 3; return b.movable ? r : r - 0.5; };
let lastTier = -1;

function draw() {
  bridgeLayer.clearLayers(); stationLayer.clearLayers(); drawn = [];
  const water = css("--water"), t = tier();
  lastTier = t;
  for (const b of bridges) {
    const s = state(b);
    b._m = null;
    if (!passes(b, s)) continue;
    const show = t === 2 || (t === 1 && s !== "unk") || (t === 0 && (s === "bad" || s === "wait"));
    let m = null;
    if (show) {
      const usingCur = $("useWater").checked && b.cur != null;
      m = L.circleMarker([b.lat, b.lng], {
        renderer, radius: radiusFor(b),
        color: usingCur ? water : "#0f2a3d", weight: usingCur ? 2.5 : b.movable ? 1.5 : 1,
        fillColor: colorOf(s), fillOpacity: 0.95,
      });
      m.bindPopup((layer) => { layer.getPopup()._bhCtx = b.st ? { s: b.st, b } : null; return popupBridge(b); }, popOpts(340));
      m.addTo(bridgeLayer);
      b._m = m;
    }
    drawn.push({ b, s, m });
  }
  $("zoomHint").hidden = t === 2;
  $("zoomHint").textContent = t === 0
    ? "Je ziet alleen de knelpunten voor je schip. Zoom in voor alle bruggen, meetpunten en sluizen."
    : "Zoom verder in om ook sluizen en bruggen met onbekende hoogte te zien.";
  if ($("showStations").checked && t >= 1) {
    for (const st of stations) {
      if (!st.lvl && st.cm == null) continue;
      const m = L.marker([st.lat, st.lng], {
        icon: L.divIcon({ className: "", html: `<i class="sq" style="display:block;width:11px;height:11px"></i>`, iconSize: [11, 11] }),
        keyboard: false, title: st.name,
      });
      m.bindPopup((layer) => { layer.getPopup()._bhCtx = { s: st, b: null }; return popupStation(st); }, popOpts(340));
      m.addTo(stationLayer);
    }
  }
  lockLayer.clearLayers();
  if ($("showLocks").checked && t === 2) {
    const q = $("search").value.trim().toLowerCase();
    const icons = {};
    const iconFor = (st) => icons[st] ||= L.divIcon({ className: "lkicon", html: `<i class="lk" style="background:${colorOf(st)}"></i>`, iconSize: [17, 17] });
    for (const l of locks) {
      if (q && !(l.name.toLowerCase().includes(q) || (l.place || "").toLowerCase().includes(q))) continue;
      const st = lockState(l);
      if ($("onlyLow").checked && st !== "bad") continue;
      L.marker([l.lat, l.lng], { icon: iconFor(st), keyboard: false, title: l.name }).bindPopup(() => popupLock(l), popOpts(360)).addTo(lockLayer);
    }
  }
  updateView();
  ls.set("bh-settings", { boat: $("boatH").value, margin: $("margin").value, boatL: $("boatL").value, boatB: $("boatB").value, boatT: $("boatT").value, useWater: $("useWater").checked, showStations: $("showStations").checked, showLocks: $("showLocks").checked });
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
    const go = () => { map.setView([b.lat, b.lng], Math.max(map.getZoom(), 15)); setTimeout(() => b._m?.openPopup(), 350); if (innerWidth <= 760) $("map").scrollIntoView(); };
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
["margin", "search", "boatL", "boatB", "boatT"].forEach((id) => $(id).addEventListener("input", redraw));
$("when").addEventListener("input", () => { updateWhen(); clearTimeout(t); t = setTimeout(() => { linkStations(); draw(); }, 120); });
["onlyLow", "useWater", "showStations", "showLocks"].forEach((id) => $(id).addEventListener("change", draw));
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
/* ---------- eigen locatie volgen (blijft op het toestel, wordt nergens heen gestuurd) ---------- */
let watchId = null, follow = false, centerOnFirst = false, meDot = null, meAcc = null, meArrow = null, lastFix = null, programmatic = false;
const locBtn = $("locate");
function setLocState(st) {   // "off" | "on" | "follow"
  locBtn.dataset.state = st;
  locBtn.setAttribute("aria-pressed", String(st !== "off"));
  locBtn.title = st === "follow" ? "Volgt je locatie. Tik om te stoppen." : st === "on" ? "Tik om je locatie te volgen" : "Toon mijn locatie";
}
function onFix(p) {
  const ll = [p.coords.latitude, p.coords.longitude], acc = p.coords.accuracy || 0;
  const accent = css("--accent");
  if (!meDot) {
    // Zelfde tekenlaag als de bruggen: een tweede laag zou tikken op bruggen opvangen.
    meAcc = L.circle(ll, { renderer, radius: acc, color: accent, weight: 1, fillColor: accent, fillOpacity: 0.12, interactive: false }).addTo(map);
    meArrow = L.marker(ll, { icon: L.divIcon({ className: "mearrow", html: '<i></i>', iconSize: [34, 34] }), interactive: false, keyboard: false }).addTo(map);
    meDot = L.circleMarker(ll, { renderer, radius: 8, color: "#fff", weight: 3, fillColor: accent, fillOpacity: 1 }).addTo(map)
      .bindPopup(() => `<div class="pop"><h3>Jouw locatie</h3><div class="note">Nauwkeurigheid ongeveer ${Math.round(acc)} m${p.coords.speed != null && p.coords.speed > 0.3 ? ` · snelheid ${(p.coords.speed * 3.6).toFixed(1).replace(".", ",")} km/u` : ""}</div><div class="stamps">Bepaald om ${new Date(p.timestamp).toLocaleTimeString("nl-NL")}. Je locatie blijft op je toestel en wordt nergens heen gestuurd.</div></div>`);
  } else { meDot.setLatLng(ll); meAcc.setLatLng(ll).setRadius(acc); meArrow.setLatLng(ll); }
  const h = p.coords.heading, moving = p.coords.speed != null && p.coords.speed > 0.5;
  const el = meArrow.getElement();
  if (el) { el.style.visibility = h != null && !isNaN(h) && moving ? "visible" : "hidden"; const i = el.querySelector("i"); if (i) i.style.transform = `rotate(${h || 0}deg)`; }
  const first = centerOnFirst;
  centerOnFirst = false;
  lastFix = p;
  if (follow || first) {
    programmatic = true;
    if (first) map.setView(ll, Math.max(map.getZoom(), 14)); else map.panTo(ll, { animate: true });
    setTimeout(() => (programmatic = false), 400);
  }
}
function onLocError(e) {
  if (e && e.code === 1) {                       // geen toestemming: stoppen
    stopWatch();
    return setStatus("Geen toestemming voor je locatie. Sta locatie toe in de instellingen van je browser.", true);
  }
  // Tijdelijk geen GPS (onder een brug, in een sluis): blijven proberen, laatste positie blijft staan.
  if (!lastFix) setStatus("Locatie wordt gezocht… Dit kan even duren bij slecht GPS-bereik.");
}
function startWatch(withFollow) {
  if (!navigator.geolocation) return setStatus("Je browser kan je locatie niet bepalen.", true);
  follow = withFollow;
  if (withFollow && !lastFix) centerOnFirst = true;     // alleen na een tik op de knop naar je locatie springen
  if (watchId == null) watchId = navigator.geolocation.watchPosition(onFix, onLocError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  setLocState(follow ? "follow" : "on");
  if (follow && lastFix) onFix(lastFix);
}
function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; follow = false; lastFix = null;
  for (const m of [meDot, meAcc, meArrow]) if (m) map.removeLayer(m);
  meDot = meAcc = meArrow = null;
  setLocState("off");
}
let lastTap = 0;
locBtn.addEventListener("click", () => {
  if (Date.now() - lastTap < 450) return;      // één tik, ook als die dubbel binnenkomt
  lastTap = Date.now();
  const st = locBtn.dataset.state || "off";
  if (st === "off") startWatch(true);
  else if (st === "on") startWatch(true);
  else stopWatch();
});
// Zelf de kaart verschuiven stopt het meevolgen (de stip blijft zichtbaar).
map.on("dragstart", () => { if (follow && !programmatic) { follow = false; setLocState("on"); } });
// Eerder toestemming gegeven? Dan meteen je locatie tonen (zonder te volgen).
try {
  navigator.permissions?.query({ name: "geolocation" }).then((r) => { if (r.state === "granted") startWatch(false); }).catch(() => {});
} catch {}
setLocState("off");
map.on("zoomend", () => {
  if (tier() !== lastTier) return draw();
  for (const b of bridges) if (b._m) b._m.setRadius(radiusFor(b));
});
map.on("moveend", updateView);
map.on("popupopen", (e) => {
  const ctx = e.popup._bhCtx;
  if (ctx) initChartIn(e.popup.getElement(), ctx.s, ctx.b);
  e.popup.off("contentupdate").on("contentupdate", () => { const c2 = e.popup._bhCtx; if (c2) initChartIn(e.popup.getElement(), c2.s, c2.b); });
  const p = $("panel");
  if (innerWidth <= 760 && !p.classList.contains("min")) {
    p.classList.add("min");
    $("toggle").textContent = "Uitklappen"; $("toggle").setAttribute("aria-expanded", "false");
    setTimeout(() => { map.invalidateSize(); const ll = e.popup.getLatLng(); if (ll) map.panTo(ll, { animate: true }); setTimeout(() => e.popup.update(), 260); }, 60);
  }
});
map.on("popupclose", () => { if (pendingRedraw) { pendingRedraw = false; setTimeout(() => { linkStations(); draw(); }, 0); } });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", draw);

if ("serviceWorker" in navigator) {
  // Bij een nieuwe versie van de app: één keer automatisch herladen (niet bij de allereerste installatie).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {}));
}
showDisclaimer(false);
init();
})();
