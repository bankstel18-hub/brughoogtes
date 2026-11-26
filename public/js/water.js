// Waterstand per brug en de daaruit berekende doorvaarthoogte.
import { S, offsetH, need, useWater } from "./state.js";
import { pickLevel, interpPts, clearanceFor, openClearance, verdict, km, WATER_MAX_AGE_H } from "./core.js";

const STATION_RADIUS_KM = 10;   // alleen voor oude data zonder netwerkkoppeling: meetpunt hemelsbreed binnen deze afstand

// Verwachting voor een meetpunt: fijnste reeks (per 10 min uit het grafiekbestand) als die geladen is, anders per uur.
function forecastOf(code) {
  const full = S.seriesCache.get(code)?.data;
  if (full?.verwachting?.pts?.length) return { kind: "verwachting", pts: full.verwachting.pts };
  if (full?.astronomisch?.pts?.length) return { kind: "astronomisch", pts: full.astronomisch.pts };
  return S.forecast[code] || null;
}
// Waterstand (cm NAP) van een meetpunt op het gekozen vaartijdstip.
export function levelAt(s, h = offsetH()) {
  return pickLevel({ cm: s.cm, t: s.t }, forecastOf(s.code), h);
}
// Waterstand van een meetpunt op tijdstip t (s): meting voor het verleden, verwachting voor de toekomst.
export function stationValue(code, t) {
  const st = S.stationByCode.get(code), full = S.seriesCache.get(code)?.data, fc = S.forecast[code];
  const nowS = Date.now() / 1000;
  const lastT = st?.t ? Date.parse(st.t) / 1000 : null;
  if (lastT && t <= lastT + 1200 && t >= nowS - 12 * 3600) {
    const past = (full?.meting?.pts?.length ? full.meting.pts : (fc?.past || [])).concat(st.cm != null ? [[lastT, st.cm]] : []);
    const v = interpPts(past.sort((a, b) => a[0] - b[0]), Math.min(t, lastT), 3600);
    if (v != null) return { cm: v, kind: "meting" };
  }
  const f = forecastOf(code);
  const v = interpPts(f?.pts, t);
  if (v != null) return { cm: v, kind: f.kind };
  if (st?.cm != null && lastT && Math.abs(t - lastT) <= 1800) return { cm: st.cm, kind: "meting" };
  return null;
}
// Schatting bij de brug tussen twee meetpunten P en Q, met de looptijd van de golf (tau, minuten, P->Q).
// Ligt de brug op fractie x van P naar Q, dan is de stand bij de brug op tijd t
//   (1-x) * P(t - x*tau) + x * Q(t + (1-x)*tau)
export function bridgeLevel(b, h = offsetH()) {
  if (b.pair) {
    const { P, Q, x, tau } = b.pair, t = Date.now() / 1000 + h * 3600;
    const vp = stationValue(P.code, t - x * tau * 60), vq = stationValue(Q.code, t + (1 - x) * tau * 60);
    if (vp && vq) return { cm: Math.round((1 - x) * vp.cm + x * vq.cm), t: new Date(t * 1000).toISOString(), kind: "schatting", parts: [vp, vq] };
  }
  return b.st ? levelAt(b.st, h) : null;
}

export function linkStations() {
  const { stations, bridges, lags } = S;
  const fresh = [];
  for (const s of stations) { s.lvl = levelAt(s); if (s.lvl) fresh.push(s); }
  const grid = new Map(), key = (lat, lng) => `${Math.floor(lat / 0.2)}|${Math.floor(lng / 0.2)}`;
  for (const s of fresh) { const k = key(s.lat, s.lng); (grid.get(k) || grid.set(k, []).get(k)).push(s); }
  S.stationByCode.clear(); for (const s of stations) S.stationByCode.set(s.code, s);
  const byCode = S.stationByCode;
  for (const b of bridges) {
    b.st = null; b.stKm = null; b.stNet = false; b.pair = null;
    if (Array.isArray(b.sts)) {
      // Via het vaarwegennetwerk: eerste meetpunt met actuele gegevens, zonder sluis of stuw ertussen.
      for (const [code, kmNet] of b.sts) { const s = byCode.get(code); if (s && s.lvl) { b.st = s; b.stKm = kmNet; b.stNet = true; break; } }
      // Twee meetpunten aan weerszijden (open verbinding): schatten met de looptijd van de golf.
      const sideP = b.sts.find((x) => x[2] === "s" && byCode.get(x[0])?.lvl), sideQ = b.sts.find((x) => x[2] === "e" && byCode.get(x[0])?.lvl);
      if (sideP && sideQ && sideP[1] <= 15 && sideQ[1] <= 15 && sideP[1] + sideQ[1] >= 0.5) {
        const P = byCode.get(sideP[0]), Q = byCode.get(sideQ[0]);
        const k = [P.code, Q.code].sort().join("|"), lag = lags[k];
        if (lag != null) {   // alleen als de twee meetpunten aantoonbaar samenhangen
          const tau = k.startsWith(P.code + "|") ? lag : -lag;
          b.pair = { P, Q, dP: sideP[1], dQ: sideQ[1], x: sideP[1] / (sideP[1] + sideQ[1]), tau, lagKnown: lag !== 0 };
        }
      }
    } else {
      // Oude data zonder netwerkkoppeling: dichtstbijzijnde meetpunt hemelsbreed.
      const gy = Math.floor(b.lat / 0.2), gx = Math.floor(b.lng / 0.2);
      let best = null, bd = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const s of grid.get(`${gy + dy}|${gx + dx}`) || []) {
        const d = km(b.lat, b.lng, s.lat, s.lng); if (d < bd) { bd = d; best = s; }
      }
      if (best && bd <= STATION_RADIUS_KM) { b.st = best; b.stKm = bd; }
    }
    b.lvl = bridgeLevel(b);
    b.cur = currentClearance(b);
  }
}
// Actuele doorvaarthoogte: alleen als de brug een NAP-referentie heeft.
export const currentClearance = (b) => (b.lvl ? clearanceFor(b, b.lvl.cm) : null);
export const effClosed = (b) => (useWater() && b.cur != null ? b.cur : b.closed);
export const effOpen = (b) => (useWater() ? openClearance(b, b.cur, b.lvl?.cm) : b.open);
export const state = (b) => verdict(effClosed(b), effOpen(b), b.movable, need());

// Hoogte en oordeel op een willekeurig tijdstip (voor de routecheck): h = uren vooruit.
export function stateAt(b, h) {
  if (!useWater()) return { c: b.closed, o: b.open, s: verdict(b.closed, b.open, b.movable, need()), lv: null };
  const lv = bridgeLevel(b, h), c0 = lv ? clearanceFor(b, lv.cm) : null;
  const c = c0 ?? b.closed, o = openClearance(b, c0, lv?.cm);
  return { c, o, s: verdict(c, o, b.movable, need()), lv, corrected: c0 != null };
}

// Laagste doorvaarthoogte volgens de verwachting in de komende 48 uur.
export function minAhead(b) {
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
export { WATER_MAX_AGE_H };
