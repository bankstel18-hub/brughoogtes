// De kaart: achtergrondlagen, bruggen, meetpunten, sluizen, koppelingslijnen en de lijst "laagste bruggen in beeld".
import { S, $, css, colorOf, useWater, offsetH } from "./state.js";
import { esc, fmt, signed } from "./core.js";
import { state, effClosed } from "./water.js";
import { popupBridge, popupLock, popupStation, lockState } from "./popups.js";
import { saveSettings } from "./profiles.js";

/* ---------- kaart en lagen ---------- */
export const map = L.map("map", { preferCanvas: true }).setView([52.15, 5.3], 8);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a> · Data: RWS (CC-0), Waterschappen/PDOK (CC BY-SA 4.0)');
const pdok = (path, ext, attribution) => L.tileLayer(`https://service.pdok.nl/${path}/EPSG:3857/{z}/{x}/{y}.${ext}`, { maxZoom: 19, attribution });
const base = {
  "Grijs (PDOK BRT)": pdok("brt/achtergrondkaart/wmts/v2_0/grijs", "png", "Kaart © Kadaster / PDOK"),
  "Kleur (PDOK BRT)": pdok("brt/achtergrondkaart/wmts/v2_0/standaard", "png", "Kaart © Kadaster / PDOK"),
  "Luchtfoto (PDOK)": pdok("hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR", "jpeg", "Luchtfoto © Beeldmateriaal Nederland / PDOK"),
};
base["Grijs (PDOK BRT)"].addTo(map);
// OpenSeaMap: vrijwillig project met beperkte servercapaciteit. Alleen als extra laag, standaard uit.
const seamark = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '© <a href="https://www.openseamap.org" target="_blank" rel="noopener">OpenSeaMap</a>-bijdragers (CC BY-SA)' });
L.control.layers(base, { "Vaarwegmarkeringen (OpenSeaMap)": seamark }, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
export const renderer = L.canvas({ padding: 0.3 });
const bridgeLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);
const lockLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);
const linkLayer = L.layerGroup().addTo(map);
export const routeLayer = L.layerGroup().addTo(map);

export const popOpts = (w) => ({ maxWidth: w, maxHeight: innerWidth <= 760 ? Math.round(innerHeight * 0.58) : undefined, autoPanPaddingTopLeft: [12, 64], autoPanPaddingBottomRight: [12, 24] });

/* ---------- filters ---------- */
function passes(b, s) {
  if (S.typeFilter === "fixed" && b.movable) return false;
  if (S.typeFilter === "movable" && !b.movable) return false;
  if ($("onlyLow").checked && !(s === "bad" || s === "wait")) return false;
  const q = $("search").value.trim().toLowerCase();
  if (q && !(b.name.toLowerCase().includes(q) || (b.waterway || "").toLowerCase().includes(q))) return false;
  return true;
}

/* ---------- zoomniveaus: hoe verder ingezoomd, hoe meer details ---------- */
// 0: heel NL (alleen knelpunten) · 1: regio (bekende hoogtes + meetpunten) · 2: ingezoomd (alles + sluizen)
const ZOOM_REGION = 10, ZOOM_DETAIL = 12;
export function tier() {
  if ($("search").value.trim()) return 2;
  const z = map.getZoom();
  return z >= ZOOM_DETAIL ? 2 : z >= ZOOM_REGION ? 1 : 0;
}
const radiusFor = (b) => { const z = map.getZoom(); const r = z >= 13 ? 6 : z >= 11 ? 5 : z >= 9 ? 4 : 3; return b.movable ? r : r - 0.5; };
let lastTier = -1;
export const tierChanged = () => tier() !== lastTier;
export function resizeMarkers() { for (const b of S.bridges) if (b._m) b._m.setRadius(radiusFor(b)); }

export function openBridge(b) {
  map.setView([b.lat, b.lng], Math.max(map.getZoom(), 15));
  setTimeout(() => b._m?.openPopup(), 350);
  if (innerWidth <= 760) $("map").scrollIntoView();
}

export function draw() {
  bridgeLayer.clearLayers(); stationLayer.clearLayers(); S.drawn = [];
  const water = css("--water"), t = tier();
  lastTier = t;
  for (const b of S.bridges) {
    const s = state(b);
    b._m = null;
    if (!passes(b, s)) continue;
    const show = t === 2 || (t === 1 && s !== "unk") || (t === 0 && (s === "bad" || s === "wait"));
    let m = null;
    if (show) {
      const usingCur = useWater() && b.cur != null;
      m = L.circleMarker([b.lat, b.lng], {
        renderer, radius: radiusFor(b),
        color: usingCur ? water : "#0f2a3d", weight: usingCur ? 2.5 : b.movable ? 1.5 : 1,
        fillColor: colorOf(s), fillOpacity: 0.95,
      });
      m.bindPopup((layer) => { layer.getPopup()._bhCtx = b.st ? { s: b.st, b } : b.pair ? { s: b.pair.P, b } : null; return popupBridge(b); }, popOpts(340));
      m.addTo(bridgeLayer);
      b._m = m;
    }
    S.drawn.push({ b, s, m });
  }
  $("zoomHint").hidden = t === 2;
  $("zoomHint").textContent = t === 0
    ? "Je ziet alleen de knelpunten voor je schip. Zoom in voor alle bruggen, meetpunten en sluizen."
    : "Zoom verder in om ook sluizen en bruggen met onbekende hoogte te zien.";
  if ($("showStations").checked && t >= 1) {
    for (const st of S.stations) {
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
    for (const l of S.locks) {
      if (q && !(l.name.toLowerCase().includes(q) || (l.place || "").toLowerCase().includes(q))) continue;
      const st = lockState(l);
      if ($("onlyLow").checked && st !== "bad") continue;
      L.marker([l.lat, l.lng], { icon: iconFor(st), keyboard: false, title: l.name }).bindPopup(() => popupLock(l), popOpts(360)).addTo(lockLayer);
    }
  }
  updateView();
  saveSettings();
}

// Koppelingslijnen: van elke brug in beeld naar het meetpunt (of de twee meetpunten) waarmee gecorrigeerd wordt.
// Zo zie je in één oogopslag of een koppeling logisch is.
function drawLinks(inView) {
  linkLayer.clearLayers();
  if (!$("showLinks").checked || map.getZoom() < 11) return;
  const water = css("--water");
  let n = 0;
  for (const { b } of inView) {
    if (n > 600) break;
    const targets = b.pair && b.lvl?.kind === "schatting" ? [b.pair.P, b.pair.Q] : b.st ? [b.st] : [];
    for (const s of targets) {
      L.polyline([[b.lat, b.lng], [s.lat, s.lng]], { renderer, color: water, weight: 1.5, opacity: 0.75, dashArray: b.stNet || b.pair ? null : "4 4", interactive: false }).addTo(linkLayer);
      n++;
    }
  }
}

export function updateView() {
  const bounds = map.getBounds();
  const inView = S.drawn.filter((d) => bounds.contains([d.b.lat, d.b.lng]));
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
  const useCur = useWater();
  for (const d of sorted) {
    const b = d.b, cur = useCur && b.cur != null;
    const el = document.createElement("div");
    el.className = "item"; el.tabIndex = 0;
    el.innerHTML = `<span class="h${cur ? " cur" : ""}" style="background:${colorOf(d.s)}">${fmt(effClosed(b))}</span>
      <div style="min-width:0"><div class="n">${esc(b.name)}</div><div class="m">${b.movable ? "beweegbaar" : "vast"}${cur ? (offsetH() ? " · verwacht" : " · actueel") : ""}${b.lvl ? ` · water <b>${signed(b.lvl.cm)} cm NAP</b>` : ""}${b.waterway ? " · " + esc(b.waterway) : ""}</div></div>`;
    el.onclick = () => openBridge(b); el.onkeydown = (e) => { if (e.key === "Enter") openBridge(b); };
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
    for (const s of S.stations) {
      if (!s.lvl || !bounds.contains([s.lat, s.lng])) continue;
      L.marker([s.lat, s.lng], { opacity: 0, interactive: false, keyboard: false })
        .bindTooltip(signed(s.lvl.cm), { permanent: true, direction: "top", offset: [0, -6], className: "wlabel" }).addTo(labelLayer);
    }
  }
  drawLinks(inView);
}
