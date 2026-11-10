// Peilgebieden van de waterschappen (PDOK, Het Waterschapshuis, IMWA) als extra scheiding tussen wateren.
// Een brug en een meetpunt horen alleen bij elkaar als ze in hetzelfde peilgebied liggen,
// of allebei buiten de peilgebieden (rijkswateren, getijdewater, grote meren).
// Per punt wordt rondom op een paar meter gekeken, zodat een punt precies op een grens niet te snel afvalt.
import { promises as fs } from "node:fs";
import path from "node:path";

export const PEIL_URL = "https://api.pdok.nl/hwh/waterschappen-waterbeheergebieden-imwa/ogc/v1/collections/peilgebied/items?f=json&limit=1000";

// Alle peilgebieden ophalen (ongeveer 30 tot 60 pagina's van 1000). Geeft compacte polygonen terug.
export async function fetchPeilgebieden(getJSON, { maxPages = 200, log = () => {} } = {}) {
  const polys = [];
  let url = PEIL_URL, page = 0;
  while (url && page < maxPages) {
    const j = await getJSON(url, {}, 120000);
    for (const f of j.features || []) {
      const g = f.geometry;
      if (!g) continue;
      const parts = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      if (!parts.length) continue;
      const p = f.properties || {};
      const rings = parts.map((rs) => rs.map((r) => r.map(([x, y]) => [x, y])));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const rs of rings) for (const [x, y] of rs[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      polys.push({ id: p.nen3610id || p.guid || `${p.waterbeheerder}|${p.code}`, code: p.code || "", naam: p.naam || "", wb: p.waterbeheerder || "", rings, bb: [x0, y0, x1, y1] });
    }
    page++;
    if (page % 10 === 0) log(`peilgebieden: ${page} pagina's, ${polys.length} gebieden`);
    url = (j.links || []).find((l) => l.rel === "next")?.href || null;
  }
  return polys;
}

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x, y, rings) => rings.some((rs) => inRing(x, y, rs[0]) && !rs.slice(1).some((h) => inRing(x, y, h)));

// Index op een raster van 0,02 graad.
export function peilIndex(polys) {
  const cell = 0.02, grid = new Map();
  polys.forEach((p, i) => {
    for (let gx = Math.floor(p.bb[0] / cell); gx <= Math.floor(p.bb[2] / cell); gx++)
      for (let gy = Math.floor(p.bb[1] / cell); gy <= Math.floor(p.bb[3] / cell); gy++) {
        const k = gx + "|" + gy; (grid.get(k) || grid.set(k, []).get(k)).push(i);
      }
  });
  // Peilgebied op één punt: index in polys, of -1 (buiten de peilgebieden).
  const at = (lat, lng) => {
    for (const i of grid.get(Math.floor(lng / cell) + "|" + Math.floor(lat / cell)) || []) {
      const p = polys[i];
      if (lng < p.bb[0] || lng > p.bb[2] || lat < p.bb[1] || lat > p.bb[3]) continue;
      if (inPoly(lng, lat, p.rings)) return i;
    }
    return -1;
  };
  // Peilgebieden rond een punt (midden en vier punten op r meter).
  const around = (lat, lng, r = 15) => {
    const dy = r / 110570, dx = r / (111320 * Math.cos((lat * Math.PI) / 180));
    return [...new Set([[0, 0], [dy, 0], [-dy, 0], [0, dx], [0, -dx]].map(([a, b]) => at(lat + a, lng + b)))];
  };
  return { at, around };
}

export const peilKey = (lat, lng) => `${(+lat).toFixed(5)},${(+lng).toFixed(5)}`;

// Bewaarde peilgebieden laden of (eens per week, of bij force) opnieuw ophalen; schrijft polygonen naar een tijdelijk bestand.
export async function loadPeilgebieden(getJSON, cacheFile, { force = false, maxAgeDays = 7, log } = {}) {
  try {
    const st = await fs.stat(cacheFile);
    if (!force && Date.now() - st.mtimeMs < maxAgeDays * 86400e3) return JSON.parse(await fs.readFile(cacheFile, "utf8"));
  } catch {}
  const polys = await fetchPeilgebieden(getJSON, { log });
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(polys));
  return polys;
}

/* ---------------- streefpeil en getijdegebied langs de vaarweg (FIS, Rijkswaterstaat) ---------------- */
// Laag 50 'streefpeil' (lijnen met naam en waarde in m NAP) en laag 198 'getijdegebied' (lijnen).
export async function fetchFisLines(getJSON, mapServer, layerId) {
  const ids = (await getJSON(`${mapServer}/${layerId}/query?where=1%3D1&returnIdsOnly=true&f=json`)).objectIds || [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const body = new URLSearchParams({ objectIds: ids.slice(i, i + 200).join(","), outFields: "*", outSR: "4326", returnGeometry: "true", maxAllowableOffset: "0.0001", f: "json" });
    const j = await getJSON(`${mapServer}/${layerId}/query`, { method: "POST", body }, 60000);
    for (const f of j.features || []) for (const p of f.geometry?.paths || []) if (p.length > 1) out.push({ a: f.attributes || {}, path: p.map(([x, y]) => [y, x]) });
  }
  return out;
}

// Index op lijnstukken: welke lijnen liggen binnen r meter van een punt.
export function lineIndex(lines) {
  const KX = 111320 * Math.cos((52 * Math.PI) / 180), KY = 110570, cell = 0.01, grid = new Map();
  lines.forEach((l, li) => {
    for (let i = 1; i < l.path.length; i++) {
      const [a, b] = [l.path[i - 1], l.path[i]];
      for (let gy = Math.floor(Math.min(a[0], b[0]) / cell); gy <= Math.floor(Math.max(a[0], b[0]) / cell); gy++)
        for (let gx = Math.floor(Math.min(a[1], b[1]) / cell); gx <= Math.floor(Math.max(a[1], b[1]) / cell); gx++) {
          const k = gy + "|" + gx; (grid.get(k) || grid.set(k, []).get(k)).push([li, i]);
        }
    }
  });
  const near = (lat, lng, r = 50) => {
    const hit = new Set(), gy = Math.floor(lat / cell), gx = Math.floor(lng / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const [li, i] of grid.get(gy + dy + "|" + (gx + dx)) || []) {
      if (hit.has(li)) continue;
      const p = lines[li].path, a = p[i - 1], b = p[i];
      const ax = a[1] * KX, ay = a[0] * KY, bx = b[1] * KX, by = b[0] * KY, px = lng * KX, py = lat * KY;
      const ddx = bx - ax, ddy = by - ay, L2 = ddx * ddx + ddy * ddy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * ddx + (py - ay) * ddy) / L2)) : 0;
      if (Math.hypot(px - ax - t * ddx, py - ay - t * ddy) <= r) hit.add(li);
    }
    return [...hit];
  };
  return { near };
}

// Mogen brug en meetpunt aan elkaar gekoppeld worden?
//  w: peilgebieden van de waterschappen (-1 = buiten de peilgebieden), f: labels uit FIS ('T' = getijde, 'S:<waarde>' = streefpeil).
//  1. FIS: als beide een label hebben moet er een overeenkomen (getij met getij, of zelfde streefpeil).
//  2. Waterschappen: alleen als beide volledig binnendijks liggen (geen getij, niet buiten de peilgebieden) moeten ze een peilgebied delen.
export function peilCompatible(pb, ps) {
  if (!pb || !ps) return { ok: true };
  const fb = pb.f || [], fs_ = ps.f || [];
  if (fb.length && fs_.length) return fb.some((x) => fs_.includes(x)) ? { ok: true } : { ok: false, why: "fis" };   // FIS beslist als beide een label hebben
  const binnen = (p) => p.w?.length && !p.w.includes(-1) && !(p.f || []).includes("T");
  if (binnen(pb) && binnen(ps) && !pb.w.some((x) => ps.w.includes(x))) return { ok: false, why: "waterschap" };
  return { ok: true };
}
