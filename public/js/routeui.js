// Routecheck: kies vertrek en bestemming op de kaart; de app zoekt de kortste route over het water
// en toont welke bruggen en sluizen onderweg een probleem zijn, op het moment dat je er aankomt.
import { S, $, colorOf, offsetH, need, dims } from "./state.js";
import { esc, fmt, kmTxt, m2, lockVerdict, chamberCheck } from "./core.js";
import { makeGraph, findRoute, placeOnNetwork, alongRoute } from "./route.js";
import { stateAt } from "./water.js";
import { map, routeLayer, openBridge } from "./map.js";
import { DEFAULT_SPEED_KMH } from "./config.js";

let graph = null, graphLoading = null, placedBridges = null, placedLocks = null, placedFor = null;
let mode = null, A = null, B = null;   // mode: null | "A" | "B"

async function loadGraph() {
  if (graph) return graph;
  graphLoading ||= (async () => {
    let net = null;
    for (const f of ["data/route-net.json", "data/network.json"]) {
      try { const r = await fetch(f, { cache: "no-cache" }); if (r.ok) { const j = await r.json(); net = j.network || j; if (net?.sections) break; } } catch {}
    }
    if (!net?.sections) throw new Error("vaarwegennetwerk niet beschikbaar");
    graph = makeGraph(net);
    return graph;
  })().finally(() => { graphLoading = null; });
  return graphLoading;
}
function placements() {
  if (placedFor !== S.bridges) {
    placedBridges = placeOnNetwork(graph, S.bridges);
    placedLocks = placeOnNetwork(graph, S.locks.map((l) => ({ lat: l.lat, lng: l.lng, sec: l.a?.fairwaysectionid })), { maxKm: 0.3 });
    placedFor = S.bridges;
  }
}

const speed = () => Math.max(1, parseFloat($("routeSpeed").value) || DEFAULT_SPEED_KMH);
const hm = (h) => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} u ${String(m % 60).padStart(2, "0")}`; };
const clock = (h) => new Date(Date.now() + h * 3600e3).toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const pin = (txt) => L.divIcon({ className: "rpin", html: `<b>${txt}</b>`, iconSize: [26, 26], iconAnchor: [13, 13] });

// Op de telefoon: paneel inklappen om op de kaart te tikken, weer uitklappen voor de uitkomst.
const panelMin = (min) => { const p = $("panel"); if (innerWidth > 760 || p.classList.contains("min") === min) return; $("toggle").click(); };
function setHint(t) { const el = $("routeHint"); el.hidden = !t; el.textContent = t || ""; }
function setMode(m) {
  mode = m;
  $("map").classList.toggle("picking", !!m);
  $("routeStart").textContent = m ? "Annuleren" : A ? "Nieuwe route" : "Route kiezen";
  if (m === "A") panelMin(true);
  setHint(m === "A" ? "Tik op de kaart op je vertrekpunt" : m === "B" ? "Tik nu op je bestemming" : "");
}
export function clearRoute() {
  A = B = null; S.route = null; routeLayer.clearLayers(); $("routeOut").textContent = ""; $("routeClear").hidden = true; setMode(null);
}

async function compute() {
  $("routeOut").innerHTML = `<div class="small">Route berekenen…</div>`;
  try { await loadGraph(); } catch (e) { $("routeOut").innerHTML = `<div class="small err">Routeplanner niet beschikbaar: ${esc(e.message)}. Probeer het later opnieuw.</div>`; return; }
  const r = findRoute(graph, A, B);
  if (r.error) {
    $("routeOut").innerHTML = `<div class="small err">${r.error === "geen" ? "Geen verbinding over het water gevonden tussen deze punten." : `Het ${r.error}punt ligt niet bij een vaarweg. Tik dichter bij het water.`}</div>`;
    return;
  }
  placements();
  S.route = {
    r,
    bridges: alongRoute(r, S.bridges, placedBridges),
    locks: alongRoute(r, S.locks, placedLocks, 0.01),
  };
  renderRoute();
  map.fitBounds(L.latLngBounds(r.path), { padding: [30, 30] });
  panelMin(false);
}

// Opnieuw beoordelen (na wijzigen van schip, snelheid of vaartijdstip). Rekent de route niet opnieuw uit.
export function renderRoute() {
  const R = S.route; if (!R) return;
  routeLayer.clearLayers();
  L.polyline(R.r.path, { color: "#0b5d8f", weight: 7, opacity: 0.35, interactive: false }).addTo(routeLayer);
  L.polyline(R.r.path, { color: "#0b5d8f", weight: 3, opacity: 0.95, interactive: false }).addTo(routeLayer);
  L.marker(A, { icon: pin("A"), keyboard: false, interactive: false }).addTo(routeLayer);
  L.marker(B, { icon: pin("B"), keyboard: false, interactive: false }).addTo(routeLayer);

  const v = speed(), h0 = offsetH(), n = need(), d = dims();
  const rows = [];
  for (const x of R.bridges) {
    const h = h0 + x.km / v, st = stateAt(x.item, Math.min(h, 48));
    rows.push({ type: "brug", o: x.item, km: x.km, h, s: st.s, c: st.c, o2: st.o, corrected: st.corrected, beyond: h > 48 });
  }
  for (const x of R.locks) {
    const s = lockVerdict(x.item.chambers, d, n);
    const why = s === "bad" ? [...new Set(x.item.chambers.flatMap((c) => chamberCheck(c, d, n).why))].join(", ") : "";
    rows.push({ type: "sluis", o: x.item, km: x.km, h: h0 + x.km / v, s, why });
  }
  rows.sort((a, b) => a.km - b.km);
  const bad = rows.filter((r) => r.s === "bad"), wait = rows.filter((r) => r.type === "brug" && r.s === "wait"), unk = rows.filter((r) => r.s === "unk");
  const total = R.r.km / v;

  const row = (r) => {
    const label = r.type === "brug"
      ? `${fmt(r.c)} m${r.o.movable ? " gesloten" : ""}${r.corrected ? (r.beyond ? " (zonder verwachting)" : " (verwacht)") : ""}`
      : r.s === "bad" ? r.why : r.s === "unk" ? "afmetingen onbekend" : "past";
    return `<div class="ritem" tabindex="0" data-i="${rows.indexOf(r)}"><span class="rkm">${kmTxt(r.km)}</span><i class="dot" style="background:${colorOf(r.s)}"></i>
      <span><b>${esc(r.o.name)}</b> <span class="m">${r.type} · ${esc(label)} · ${clock(r.h)}</span></span></div>`;
  };
  const verdictTxt = bad.length
    ? `<b class="c-bad">${bad.length} ${bad.length === 1 ? "knelpunt" : "knelpunten"}</b>: je kunt deze route met dit schip niet varen.`
    : wait.length ? `<b class="c-wait">Geen onoverkomelijke knelpunten.</b> ${wait.length} ${wait.length === 1 ? "brug moet" : "bruggen moeten"} voor je open.`
    : `<b class="c-ok">Geen knelpunten gevonden</b> op deze route.`;
  $("routeOut").innerHTML = `
    <div class="rsum">${kmTxt(R.r.km)} km over het water · ca. ${hm(total)} bij ${m2(v)} km/u · aankomst ${clock(h0 + total)}</div>
    <div class="rverdict">${verdictTxt}${unk.length ? ` <span class="small">${unk.length} onderweg met onbekende hoogte of afmetingen: controleer die zelf.</span>` : ""}</div>
    ${bad.length + wait.length ? `<div class="rlist">${[...bad, ...wait].sort((a, b) => a.km - b.km).map(row).join("")}</div>` : ""}
    <details><summary>Alle ${R.bridges.length} bruggen en ${R.locks.length} sluizen op de route</summary><div class="rlist">${rows.map(row).join("") || '<div class="small">Geen.</div>'}</div></details>
    <p class="small">Hoogtes op het verwachte tijdstip van aankomst bij elke brug. De route volgt het FIS-vaarwegennetwerk en houdt geen rekening met vaarbeperkingen, bedientijden of stremmingen. Controleer die op vaarweginformatie.nl.</p>`;
  $("routeOut").querySelectorAll(".ritem").forEach((el) => {
    const r = rows[+el.dataset.i];
    const go = () => (r.type === "brug" ? openBridge(r.o) : map.setView([r.o.lat, r.o.lng], Math.max(map.getZoom(), 15)));
    el.onclick = go; el.onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
}

export function initRoute() {
  $("routeSpeed").value ||= DEFAULT_SPEED_KMH;
  $("routeStart").addEventListener("click", () => {
    if (mode) return setMode(null);
    routeLayer.clearLayers(); S.route = null; A = B = null; $("routeOut").textContent = "";
    setMode("A");
    loadGraph().catch(() => {});      // alvast laden
  });
  $("routeClear").addEventListener("click", clearRoute);
  $("routeSpeed").addEventListener("input", () => renderRoute());
  map.on("click", (e) => {
    if (!mode) return;
    const p = [e.latlng.lat, e.latlng.lng];
    if (mode === "A") { A = p; L.marker(A, { icon: pin("A"), interactive: false }).addTo(routeLayer); setMode("B"); }
    else { B = p; setMode(null); $("routeClear").hidden = false; $("routeStart").textContent = "Nieuwe route"; compute(); }
  });
}
