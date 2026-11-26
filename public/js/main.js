// Startpunt van de app: gegevens laden, knoppen koppelen, periodiek verversen.
// Opbouw (zie ook README):
//   core.js     pure rekenfuncties (getest)       route.js   routeplanner (getest)
//   state.js    gedeelde toestand en instellingen  water.js   waterstand en doorvaarthoogte per brug
//   map.js      kaart en lijst                     popups.js  popups van brug, sluis, meetpunt
//   chart.js    waterstandgrafiek                  panel.js   teksten in het paneel
//   profiles.js bootprofielen                      routeui.js routecheck
//   locate.js   eigen locatie                      config.js  instellingen
import { S, $, setStatus } from "./state.js";
import { linkStations } from "./water.js";
import { map, draw, updateView, tierChanged, resizeMarkers } from "./map.js";
import { initChartIn } from "./chart.js";
import { updateWhen, staleCheck, fresh } from "./panel.js";
import { restoreSettings, initProfiles, checkProfileMatch } from "./profiles.js";
import { initRoute, renderRoute } from "./routeui.js";
import { initLocate } from "./locate.js";
import { DISC_VERSION, APP_VERSION } from "./config.js";

/* ---------- data laden ---------- */
async function getData(path) {
  const r = await fetch(path, { cache: "no-cache" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function loadBridges() { const d = await getData("data/bridges.json"); S.bridges = d.bridges || []; S.meta.bridgesAt = d.generatedAt; }
async function loadWater() {
  try { const d = await getData("data/water.json"); S.stations = (d.stations || []).filter((s) => s.lat != null); S.meta.waterAt = d.generatedAt; }
  catch (e) { S.meta.waterErr = e.message; }
}
async function loadForecast() {
  try { const d = await getData("data/forecast.json"); S.forecast = d.series || {}; S.lags = d.lags || {}; S.meta.forecastAt = d.generatedAt; }
  catch (e) { S.meta.forecastErr = e.message; }
}
async function loadLocks() {
  try { const d = await getData("data/locks.json"); S.locks = d.locks || []; S.meta.locksAt = d.generatedAt; } catch (e) { S.meta.locksErr = e.message; }
}

function redrawAll() { linkStations(); draw(); renderRoute(); }

async function init() {
  try {
    await Promise.all([loadBridges(), loadWater(), loadForecast(), loadLocks()]);
    redrawAll(); fresh();
  } catch (e) {
    setStatus(`Brugdata niet beschikbaar: ${e.message}`, true);
    $("freshness").textContent = "Gegevens worden voorbereid. Probeer het over een paar minuten opnieuw.";
  }
  setInterval(() => refreshData(false), 5 * 60e3);
  setInterval(() => staleCheck(refreshing), 60e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshData(true); });
  addEventListener("pageshow", (e) => { if (e.persisted) refreshData(true); });
  addEventListener("online", () => refreshData(true));
}
let refreshing = null, lastRefresh = Date.now();
async function refreshData(onResume) {
  if (refreshing) return refreshing;
  if (onResume && Date.now() - lastRefresh < 60e3) return;
  $("freshness").textContent = "Gegevens bijwerken…";
  $("staleWarn").hidden = true;
  refreshing = (async () => {
    const tasks = [loadWater(), loadForecast()];
    if (S.meta.bridgesAt && Date.now() - Date.parse(S.meta.bridgesAt) > 20 * 3600e3) tasks.push(loadBridges().catch(() => {}), loadLocks());
    await Promise.all(tasks);
    S.seriesCache.clear();
    lastRefresh = Date.now();
    redrawAll(); fresh();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/* ---------- vensters ---------- */
function showDisclaimer(force) {
  let ok = null; try { ok = localStorage.getItem("bh-disclaimer"); } catch {}
  if (force || ok !== DISC_VERSION) { $("disclaimer").hidden = false; $("disclaimer").querySelector(".modal-box").scrollTop = 0; $("discOk").focus({ preventScroll: true }); }
}
$("discOk").addEventListener("click", () => { try { localStorage.setItem("bh-disclaimer", DISC_VERSION); } catch {} $("disclaimer").hidden = true; });
$("discOpen").addEventListener("click", () => showDisclaimer(true));
$("termsOpen").addEventListener("click", () => { $("terms").hidden = false; $("termsClose").focus(); });
$("termsClose").addEventListener("click", () => { $("terms").hidden = true; });
$("bigChartClose").addEventListener("click", () => { $("bigChart").hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") { $("bigChart").hidden = true; $("terms").hidden = true; } });
$("appVersion").textContent = APP_VERSION;

/* ---------- bediening ---------- */
restoreSettings();
let t;
const redraw = () => { clearTimeout(t); t = setTimeout(() => { draw(); renderRoute(); }, 120); };
const boatChanged = () => { checkProfileMatch(); redraw(); };
$("boatH").addEventListener("input", () => { $("boatR").value = $("boatH").value; boatChanged(); });
$("boatR").addEventListener("input", () => { $("boatH").value = (+$("boatR").value).toFixed(2); boatChanged(); });
["margin", "boatL", "boatB", "boatT"].forEach((id) => $(id).addEventListener("input", boatChanged));
$("search").addEventListener("input", redraw);
$("when").addEventListener("input", () => { updateWhen(); clearTimeout(t); t = setTimeout(redrawAll, 120); });
["onlyLow", "useWater", "showStations", "showLocks", "showLinks"].forEach((id) => $(id).addEventListener("change", () => { draw(); renderRoute(); }));
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
  S.typeFilter = c.dataset.type;
  document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  draw();
}));
$("toggle").addEventListener("click", () => {
  const p = $("panel"), min = p.classList.toggle("min");
  $("toggle").textContent = min ? "Uitklappen" : "Inklappen";
  $("toggle").setAttribute("aria-expanded", String(!min));
  setTimeout(() => map.invalidateSize(), 60);
});
initProfiles(() => { draw(); renderRoute(); });
initRoute();
initLocate();

map.on("zoomend", () => { if (tierChanged()) return draw(); resizeMarkers(); });
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
map.on("popupclose", () => { if (S.pendingRedraw) { S.pendingRedraw = false; setTimeout(redrawAll, 0); } });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", draw);

if ("serviceWorker" in navigator) {
  // Bij een nieuwe versie van de app: één keer automatisch herladen (niet bij de allereerste installatie).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {}));
}
updateWhen();
showDisclaimer(false);
init();

// Voor onderhoud en automatische tests: open de app met #debug in de adresbalk.
if (location.hash === "#debug") window.bh = { S, map };
