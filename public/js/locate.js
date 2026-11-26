// Eigen locatie tonen en volgen. De positie blijft op het toestel en wordt nergens heen gestuurd.
import { $, css, setStatus } from "./state.js";
import { map, renderer } from "./map.js";

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
    meArrow = L.marker(ll, { icon: L.divIcon({ className: "mearrow", html: "<i></i>", iconSize: [34, 34] }), interactive: false, keyboard: false }).addTo(map);
    meDot = L.circleMarker(ll, { renderer, radius: 8, color: "#fff", weight: 3, fillColor: accent, fillOpacity: 1 }).addTo(map)
      .bindPopup(() => `<div class="pop"><h3>Jouw locatie</h3><div class="note">Nauwkeurigheid ongeveer ${Math.round(lastFix?.coords.accuracy || acc)} m${lastFix?.coords.speed > 0.3 ? ` · snelheid ${(lastFix.coords.speed * 3.6).toFixed(1).replace(".", ",")} km/u` : ""}</div><div class="stamps">Bepaald om ${new Date(lastFix?.timestamp || p.timestamp).toLocaleTimeString("nl-NL")}. Je locatie blijft op je toestel en wordt nergens heen gestuurd.</div></div>`);
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
  if (e && e.code === 1) {
    stopWatch();
    return setStatus("Geen toestemming voor je locatie. Sta locatie toe in de instellingen van je browser.", true);
  }
  // Tijdelijk geen GPS (onder een brug, in een sluis): blijven proberen, laatste positie blijft staan.
  if (!lastFix) setStatus("Locatie wordt gezocht… Dit kan even duren bij slecht GPS-bereik.");
}
function startWatch(withFollow) {
  if (!navigator.geolocation) return setStatus("Je browser kan je locatie niet bepalen.", true);
  follow = withFollow;
  if (withFollow && !lastFix) centerOnFirst = true;
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

export function initLocate() {
  let lastTap = 0;
  locBtn.addEventListener("click", () => {
    if (Date.now() - lastTap < 450) return;      // één tik, ook als die dubbel binnenkomt
    lastTap = Date.now();
    const st = locBtn.dataset.state || "off";
    if (st === "follow") stopWatch(); else startWatch(true);
  });
  // Zelf de kaart verschuiven stopt het meevolgen (de stip blijft zichtbaar).
  map.on("dragstart", () => { if (follow && !programmatic) { follow = false; setLocState("on"); } });
  // Eerder toestemming gegeven? Dan meteen je locatie tonen (zonder te volgen).
  try { navigator.permissions?.query({ name: "geolocation" }).then((r) => { if (r.state === "granted") startWatch(false); }).catch(() => {}); } catch {}
  setLocState("off");
}
