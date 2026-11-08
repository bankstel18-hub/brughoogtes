// Gedeelde logica (GitHub-versie): ophalen en normaliseren van Rijkswaterstaat-data.
// Bruggen: FIS (Fairway Information Services) via de ArcGIS FeatureServer van RWS.
// Waterstanden: WaterWebservices (DD-API 2.0).
import { promises as fs } from "node:fs";
import path from "node:path";

// Opslag als JSON-bestanden in een map (op GitHub Pages wordt die map de data van de app).
let DATA_DIR = "data";
export function setDataDir(d) { DATA_DIR = d; }
const file = (key) => path.join(DATA_DIR, key.replace(/\//g, "__") + ".json");

export const FIS = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/fis_vnds/FeatureServer";
export const DD = "https://ddapi20-waterwebservices.rijkswaterstaat.nl";

export const store = () => ({
  async get(key) { try { return JSON.parse(await fs.readFile(file(key), "utf8")); } catch { return null; } },
  async setJSON(key, v) { await fs.mkdir(DATA_DIR, { recursive: true }); await fs.writeFile(file(key), JSON.stringify(v)); },
  async delete(key) { await fs.rm(file(key), { force: true }); },
});

/* ---------------- hulpfuncties ---------------- */
export async function getJSON(url, opts = {}, timeoutMs = 15000) {
  const r = await fetch(url, {
    ...opts,
    headers: { accept: "application/json", ...(opts.body && typeof opts.body === "string" ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]}: ${text.slice(0, 300)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Geen JSON van ${url.split("?")[0]}: ${text.slice(0, 200)}`); }
  if (j && j.error) throw new Error(`Serverfout ${url.split("?")[0]}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function getStatus() {
  return (await store().get("status", { type: "json" })) || {};
}
export async function setStatus(part, value) {
  const s = await getStatus();
  s[part] = { ...(s[part] || {}), ...value };
  await store().setJSON("status", s);
  return s;
}

/* ---------------- bruggen ---------------- */
function slim(a) {
  const o = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (v == null || v === "" || /^(shape|globalid|objectid|fid)/i.test(k)) continue;
    const s = typeof v === "string" ? v.trim() : v;
    if (typeof s === "string" && (s.length === 0 || s.length > 140)) continue;
    o[k] = s;
  }
  return o;
}
function geomPoint(g) {
  if (!g) return null;
  if (g.x != null && g.y != null) return [+g.y.toFixed(6), +g.x.toFixed(6)];
  const pts = (g.paths || g.rings || []).flat();
  if (!pts.length) return null;
  const s = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [+(s[1] / pts.length).toFixed(6), +(s[0] / pts.length).toFixed(6)];
}

// Stap 1 van de bruggen-taak: bron kiezen, lagen vinden en de pagina's plannen.
// Bronnen in volgorde: ArcGIS FeatureServer, ArcGIS MapServer, FIS-dataservice van vaarweginformatie.nl.
export const FIS_SOURCES = [FIS, FIS.replace(/FeatureServer$/, "MapServer")];
export const FIS_DS = "https://www.vaarweginformatie.nl/wfswms/dataservice/1.4";

async function planArcgis(base) {
  const svc = await getJSON(`${base}?f=json`);
  const layers = (svc.layers || []).concat(svc.tables || []);
  const pickLayer = (re) => layers.filter((l) => re.test(l.name) && !(l.subLayerIds && l.subLayerIds.length))
    .sort((a, b) => (/punt|point/i.test(b.name) ? 1 : 0) - (/punt|point/i.test(a.name) ? 1 : 0))[0];
  const chosen = [
    { role: "bridge", layer: pickLayer(/bridge|brug/i) },
    { role: "opening", layer: pickLayer(/opening/i) },
  ].filter((x) => x.layer);
  if (!chosen.length) throw new Error("Geen brug- of openingenlaag gevonden. Lagen: " + layers.map((l) => l.name).join(", "));
  const tasks = [], meta = [];
  for (const { role, layer } of chosen) {
    const info = await getJSON(`${base}/${layer.id}?f=json`);
    const max = Math.min(info.maxRecordCount || 1000, 2000);
    const pag = !!info.advancedQueryCapabilities?.supportsPagination;
    meta.push({ source: base, role, id: layer.id, name: layer.name, fields: (info.fields || []).map((f) => `${f.name}:${f.type?.replace("esriFieldType", "")}`), max, pag });
    if (pag) {
      const c = await getJSON(`${base}/${layer.id}/query?where=1%3D1&returnCountOnly=true&f=json`);
      for (let off = 0; off < (c.count || 0); off += max) tasks.push({ kind: "arcgis", base, role, id: layer.id, offset: off, n: max });
    } else {
      const ids = (await getJSON(`${base}/${layer.id}/query?where=1%3D1&returnIdsOnly=true&f=json`)).objectIds || [];
      const chunk = Math.min(max, 400);
      for (let i = 0; i < ids.length; i += chunk) tasks.push({ kind: "arcgis", base, role, id: layer.id, ids: ids.slice(i, i + chunk) });
    }
  }
  if (!tasks.length) throw new Error("Lagen gevonden maar zonder objecten");
  return { meta, tasks };
}

async function planDataservice() {
  const g = await getJSON(`${FIS_DS}/geogeneration`);
  const gen = g.GeoGeneration ?? g.geoGeneration ?? g.Result?.GeoGeneration ?? g;
  if (gen == null || typeof gen === "object") throw new Error("Geen geogeneratie in antwoord: " + JSON.stringify(g).slice(0, 200));
  const tasks = [], meta = [];
  for (const [role, kind] of [["bridge", "bridge"], ["opening", "opening"]]) {
    const first = await getJSON(`${FIS_DS}/${gen}/${kind}?offset=0&count=1`);
    const total = first.TotalCount ?? first.totalCount ?? 0;
    meta.push({ source: FIS_DS, role, generation: gen, total, sample: (first.Result || first.result || [])[0] });
    for (let off = 0; off < total; off += 500) tasks.push({ kind: "ds", role, url: `${FIS_DS}/${gen}/${kind}`, offset: off, n: 500 });
  }
  if (!tasks.length) throw new Error("Dataservice gaf geen bruggen");
  return { meta, tasks };
}

async function planBridgeJob() {
  const errors = [];
  for (const base of FIS_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const r = await planArcgis(base); return finishPlan(r, errors); }
      catch (e) { errors.push(`${base.split("/").pop()}: ${String(e.message || e).slice(0, 160)}`); }
    }
  }
  try { const r = await planDataservice(); return finishPlan(r, errors); }
  catch (e) { errors.push(`dataservice: ${String(e.message || e).slice(0, 160)}`); }
  throw new Error("Geen enkele brugbron bereikbaar. " + errors.join(" | "));
}
function finishPlan({ meta, tasks }, errors) {
  return { started: new Date().toISOString(), meta, fallbackErrors: errors, tasks: tasks.map((t, i) => ({ ...t, i, done: false })) };
}

function wktPoint(w) {
  const m = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)/i.exec(String(w || ""));
  return m ? [+(+m[2]).toFixed(6), +(+m[1]).toFixed(6)] : null;
}

async function runBridgeTask(t) {
  if (t.kind === "ds") {
    const j = await getJSON(`${t.url}?offset=${t.offset}&count=${t.n}`, {}, 30000);
    return (j.Result || j.result || []).map((r) => {
      const { Geometry, geometry, ...rest } = r;
      return { a: slim(rest), p: wktPoint(Geometry || geometry) };
    });
  }
  const base = t.base || FIS;
  const q = { outFields: "*", outSR: "4326", returnGeometry: "true", f: "json" };
  let j;
  if (t.ids) {
    j = await getJSON(`${base}/${t.id}/query`, { method: "POST", body: new URLSearchParams({ ...q, objectIds: t.ids.join(",") }) }, 30000);
  } else {
    const p = new URLSearchParams({ ...q, where: "1=1", resultOffset: String(t.offset), resultRecordCount: String(t.n), orderByFields: "OBJECTID" });
    try {
      j = await getJSON(`${base}/${t.id}/query?${p}`, {}, 30000);
    } catch (e) {
      p.delete("orderByFields");
      j = await getJSON(`${base}/${t.id}/query?${p}`, {}, 30000);
    }
  }
  return (j.features || []).map((f) => ({ a: slim(f.attributes), p: geomPoint(f.geometry) }));
}

// Voert de bruggen-taak uit binnen een tijdsbudget; hervat bij de volgende aanroep.
export async function runBridgeJob(budgetMs = 8000, { force = false } = {}) {
  const t0 = Date.now();
  const s = store();
  let job = await s.get("bridgejob", { type: "json" });
  const status = await getStatus();
  const last = status.bridges?.completedAt ? Date.parse(status.bridges.completedAt) : 0;

  if (!job) {
    if (!force && Date.now() - last < 20 * 3600e3) return { skipped: true, reason: "bruggen zijn minder dan 20 uur oud" };
    job = await planBridgeJob();
    await s.setJSON("bridgejob", job);
    await setStatus("bridges", { running: true, startedAt: job.started, error: null });
  }

  try {
    while (Date.now() - t0 < budgetMs) {
      const todo = job.tasks.filter((t) => !t.done).slice(0, 4);
      if (!todo.length) break;
      await Promise.all(todo.map(async (t) => {
        const feats = await runBridgeTask(t);
        await s.setJSON(`bj/${t.i}`, feats);
        t.done = true;
      }));
      await s.setJSON("bridgejob", job);
    }
  } catch (e) {
    await setStatus("bridges", { error: String(e.message || e), errorAt: new Date().toISOString() });
    throw e;
  }

  const remaining = job.tasks.filter((t) => !t.done).length;
  if (remaining) return { done: false, progress: `${job.tasks.length - remaining}/${job.tasks.length}` };

  // Alles binnen: samenvoegen.
  const byRole = { bridge: [], opening: [] };
  for (const t of job.tasks) {
    const feats = (await s.get(`bj/${t.i}`, { type: "json" })) || [];
    byRole[t.role].push(...feats);
  }
  const bridges = assemble(byRole.bridge, byRole.opening);
  const payload = { generatedAt: new Date().toISOString(), source: "Rijkswaterstaat FIS (CC-0)", count: bridges.length, bridges };
  await s.setJSON("bridges", payload);

  const debug = {
    at: payload.generatedAt,
    fallbackErrors: job.fallbackErrors,
    layers: job.meta.map((m) => ({ ...m, samples: (m.role === "bridge" ? byRole.bridge : byRole.opening).slice(0, 4).map((f) => f.a) })),
  };
  await s.setJSON("debug-bridges", debug);

  for (const t of job.tasks) await s.delete(`bj/${t.i}`);
  await s.delete("bridgejob");
  await setStatus("bridges", { running: false, completedAt: payload.generatedAt, count: bridges.length, error: null });
  return { done: true, count: bridges.length };
}

/* --- veldherkenning: robuust tegen schemawijzigingen --- */
function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  if (!isFinite(n)) return null;
  return n;
}
function height(v) {
  const n = num(v);
  if (n == null || n <= 0 || n >= 9000) return null;
  return n > 150 ? +(n / 100).toFixed(2) : +n.toFixed(2); // waarschijnlijk cm
}
function pick(a, regs, exclude, conv = height) {
  if (!a) return null;
  for (const re of regs) for (const k of Object.keys(a)) {
    if (re.test(k) && !(exclude && exclude.test(k))) { const n = conv(a[k]); if (n != null) return n; }
  }
  return null;
}
function str(a, regs) {
  if (!a) return "";
  for (const re of regs) for (const k of Object.keys(a)) {
    const v = a[k];
    if (re.test(k) && v != null && typeof v !== "number" && String(v).trim()) return String(v).trim();
  }
  return "";
}
const RE_CLOSED = [/height.?closed|closed.?height|hoogte.?gesloten|gesloten.?hoogte|clearance.?height.?closed/i, /^(height|hoogte|doorvaarthoogte|verticalclearance|clearance_?height)$/i, /height|hoogte|clearance/i];
const EX_CLOSED = /open|nap|maaiveld|ground|level|width|breedte|ref|peil/i;
const RE_OPEN = [/height.?open|open.?height|hoogte.?open|clearance.?height.?open/i];
// NAP-gerelateerde velden (onderkant brug t.o.v. NAP, of het referentiepeil t.o.v. NAP)
const RE_UNDER_NAP = [/(underside|onderkant|bottom|hoogte|height).*nap|nap.*(hoogte|height|onderkant)/i];
const RE_REF_NAP = [/(reference|referentie|ref).?(level|peil|niveau)?.*nap|^(referencelevel|referentiepeil|kp|kruinpeil|streefpeil)$/i];
const RE_REF_NAME = [/reference.?level|referentie.?peil|refniveau|ref_level|ijkvlak/i];

function normalize(a, p, parent, src) {
  const all = Object.assign({}, parent || {}, a);
  const closed = pick(a, RE_CLOSED, EX_CLOSED) ?? pick(parent, RE_CLOSED, EX_CLOSED);
  const open = pick(a, RE_OPEN) ?? pick(parent, RE_OPEN);
  const navNum = (v) => { const n = num(v); return n == null || Math.abs(n) > 5000 ? null : (Math.abs(n) > 60 ? +(n / 100).toFixed(2) : +n.toFixed(2)); };
  const underNAP = pick(all, RE_UNDER_NAP, /open|width|breedte/i, navNum);
  const refNAP = pick(all, RE_REF_NAP, null, navNum);
  const refName = str(all, RE_REF_NAME);

  const typeTxt = `${str(all, [/type|soort|category|catbrg/i])} ${str(all, [/canopen|movable|beweeg/i])}`.toLowerCase();
  let movable = open != null || /beweeg|bascul|draai|hef|lift|swing|draw|ophaal|klap|movable|opening/.test(typeTxt);
  if (/vast|fixed/.test(typeTxt) && open == null) movable = false;
  for (const k of Object.keys(all)) if (/^(canopen|ismovable|movable)$/i.test(k)) {
    const v = all[k]; movable = v === true || v === 1 || /^(true|ja|yes|1|y)$/i.test(String(v));
  }
  const name = str(all, [/^name$|^naam$|objectnaam|bridgename|brugnaam/i, /name|naam/i]) || "Brug zonder naam";
  const waterway = str(all, [/fairwayname|vaarwegnaam|waterwayname/i, /fairway|vaarweg|waterway/i]);
  const id = all.Id ?? all.ID ?? all.id ?? all.Isrs ?? null;
  return {
    id, lat: p[0], lng: p[1], name, waterway,
    closed, open, movable: movable ? 1 : 0,
    underNAP, refNAP, refName: refName || undefined,
    src, a: all,
  };
}

function assemble(bridgeFeats, openFeats) {
  const res = [];
  const idKey = (a) => Object.keys(a).find((k) => /^id$/i.test(k)) || Object.keys(a).find((k) => /^(bridgeid|brugid|isrs|code)$/i.test(k));
  const bIndex = new Map();
  if (bridgeFeats.length) {
    const k = idKey(bridgeFeats[0].a);
    if (k) for (const f of bridgeFeats) bIndex.set(String(f.a[k]), f);
  }
  const linkKey = openFeats.length ? Object.keys(openFeats[0].a).find((k) => /bridge.?id|parent.?id|brug.?id/i.test(k)) : null;
  const used = new Set();
  for (const f of openFeats) {
    const parent = linkKey ? bIndex.get(String(f.a[linkKey])) : null;
    if (parent) used.add(parent);
    const p = f.p || parent?.p;
    if (!p) continue;
    res.push(normalize(f.a, p, parent?.a, "opening"));
  }
  for (const f of bridgeFeats) {
    if (used.has(f) || !f.p) continue;
    res.push(normalize(f.a, f.p, null, "bridge"));
  }
  return res;
}

/* ---------------- waterstanden ---------------- */
// UTM zone 31N (ETRS89, EPSG:25831) naar WGS84
function utm31ToLatLon(E, N) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = N, lon0 = (3 * Math.PI) / 180;
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep2 * Math.cos(p1) ** 2;
  const R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(p1);
  return [+((lat * 180) / Math.PI).toFixed(6), +((lon * 180) / Math.PI).toFixed(6)];
}
function locPoint(l) {
  const lat = num(l.Lat ?? l.lat ?? l.Latitude), lon = num(l.Lon ?? l.lon ?? l.Longitude);
  if (lat != null && lon != null && Math.abs(lat) <= 90) return [lat, lon];
  const X = num(l.X), Y = num(l.Y);
  if (X == null || Y == null) return null;
  if (Math.abs(X) <= 180 && Math.abs(Y) <= 90) return [Y, X];
  return utm31ToLatLon(X, Y);
}

// Catalogus: alle meetpunten met waterhoogte t.o.v. NAP in oppervlaktewater.
export async function loadStations() {
  const body = JSON.stringify({ CatalogusFilter: { Grootheden: true, Hoedanigheden: true, Compartimenten: true, Eenheden: true, ProcesTypes: true } });
  const cat = await getJSON(`${DD}/METADATASERVICES/OphalenCatalogus`, { method: "POST", body }, 25000);
  const metas = cat.AquoMetadataLijst || [];
  // Per metadata-id het procestype (meting / verwachting / astronomisch) voor waterhoogte t.o.v. NAP.
  const procOf = new Map();
  for (const m of metas) {
    if (m.Grootheid?.Code !== "WATHTE") continue;
    if (m.Hoedanigheid && m.Hoedanigheid.Code !== "NAP") continue;
    if (m.Compartiment && m.Compartiment.Code !== "OW") continue;
    const p = String(m.ProcesType || "meting").toLowerCase();
    const kind = /verwacht/.test(p) ? "verwachting" : /astro/.test(p) ? "astronomisch" : /meting/.test(p) ? "meting" : null;
    if (kind) procOf.set(m.AquoMetadata_MessageID, kind);
  }
  const links = cat.AquoMetadataLocatieLijst || [];
  const kindsAt = new Map(); // locatie-id -> Set(kinds)
  for (const l of links) {
    const kind = procOf.get(l.AquoMetaData_MessageID ?? l.AquoMetadata_MessageID);
    if (!kind) continue;
    (kindsAt.get(l.Locatie_MessageID) || kindsAt.set(l.Locatie_MessageID, new Set()).get(l.Locatie_MessageID)).add(kind);
  }
  const stations = [];
  for (const l of cat.LocatieLijst || []) {
    const kinds = kindsAt.get(l.Locatie_MessageID);
    if (!kinds) continue;
    const p = locPoint(l);
    if (!p) continue;
    stations.push({
      code: l.Code, name: l.Naam || l.Code, lat: p[0], lng: p[1],
      meas: kinds.has("meting") ? 1 : 0,
      fc: kinds.has("verwachting") ? "verwachting" : kinds.has("astronomisch") ? "astronomisch" : null,
    });
  }
  const okMeta = { size: procOf.size }, okLoc = { size: stations.length };
  return {
    stations,
    debug: {
      catalogKeys: Object.keys(cat),
      metaSample: metas.filter((m) => m.Grootheid?.Code === "WATHTE").slice(0, 3),
      locSample: (cat.LocatieLijst || []).slice(0, 3),
      linkSample: links.slice(0, 3),
      counts: { metas: metas.length, okMeta: okMeta.size, locs: (cat.LocatieLijst || []).length, okLoc: okLoc.size },
    },
  };
}

function parseLatest(j) {
  const out = {};
  for (const w of j.WaarnemingenLijst || []) {
    const code = w.Locatie?.Code;
    const ms = (w.MetingenLijst || []).filter((m) => {
      const v = num(m.Meetwaarde?.Waarde_Numeriek);
      return v != null && Math.abs(v) < 2000;
    });
    if (!code || !ms.length) continue;
    ms.sort((a, b) => Date.parse(a.Tijdstip) - Date.parse(b.Tijdstip));
    const m = ms[ms.length - 1];
    out[code] = { cm: num(m.Meetwaarde.Waarde_Numeriek), t: m.Tijdstip };
  }
  return out;
}

const META = { AquoMetadata: { Compartiment: { Code: "OW" }, Grootheid: { Code: "WATHTE" }, Hoedanigheid: { Code: "NAP" } } };

async function latestBulk(codes) {
  const body = JSON.stringify({ LocatieLijst: codes.map((Code) => ({ Code })), AquoPlusWaarnemingMetadataLijst: [META] });
  return parseLatest(await getJSON(`${DD}/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`, { method: "POST", body }, 20000));
}
async function latestWindow(code) {
  const end = new Date(), begin = new Date(end - 3 * 3600e3);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, ".000+00:00");
  const body = JSON.stringify({
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { ...META.AquoMetadata, ProcesType: "meting" } },
    Periode: { Begindatumtijd: iso(begin), Einddatumtijd: iso(end) },
  });
  return parseLatest(await getJSON(`${DD}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, { method: "POST", body }, 10000));
}

export async function runWaterUpdate(budgetMs = 8000) {
  const t0 = Date.now();
  const s = store();
  let st = await s.get("stations", { type: "json" });
  if (!st || Date.now() - Date.parse(st.at) > 7 * 86400e3 || !st.stations?.length) {
    const r = await loadStations();
    st = { at: new Date().toISOString(), stations: r.stations };
    await s.setJSON("stations", st);
    await s.setJSON("debug-water", { at: st.at, ...r.debug, stationSample: r.stations.slice(0, 5) });
  }
  const codes = st.stations.filter((x) => x.meas !== 0).map((x) => x.code);
  const values = {};
  let method = "bulk", errors = [];
  const chunks = [];
  for (let i = 0; i < codes.length; i += 40) chunks.push(codes.slice(i, i + 40));
  try {
    await pool(chunks, 4, async (c) => Object.assign(values, await latestBulk(c)));
  } catch (e) {
    errors.push("bulk: " + String(e.message || e).slice(0, 300));
    method = "window";
    const left = codes.filter((c) => !values[c]);
    await pool(left, 10, async (c) => {
      if (Date.now() - t0 > budgetMs) return;
      try { Object.assign(values, await latestWindow(c)); } catch (err) { if (errors.length < 5) errors.push(`${c}: ${String(err.message || err).slice(0, 200)}`); }
    });
  }
  const stations = st.stations.map((x) => ({ ...x, ...(values[x.code] || {}) }));
  const payload = { generatedAt: new Date().toISOString(), source: "Rijkswaterstaat WaterWebservices", method, count: Object.keys(values).length, stations };
  if (payload.count) await s.setJSON("water", payload);
  await setStatus("water", { completedAt: payload.generatedAt, count: payload.count, stations: stations.length, method, error: errors.length ? errors.join(" | ") : null });
  return { count: payload.count, stations: stations.length, method, errors };
}

/* ---------------- waterstandsverwachtingen ---------------- */
// Per meetpunt de RWS-verwachting (of het astronomisch getij) voor de komende 48 uur, per uur.
function parseSeries(j) {
  const byHour = new Map();
  for (const w of j.WaarnemingenLijst || []) {
    for (const m of w.MetingenLijst || []) {
      const v = num(m.Meetwaarde?.Waarde_Numeriek);
      const t = Date.parse(m.Tijdstip);
      if (v == null || Math.abs(v) >= 2000 || !isFinite(t)) continue;
      const h = Math.round(t / 3600e3) * 3600e3;          // afronden op het hele uur
      const prev = byHour.get(h);
      if (!prev || Math.abs(t - h) <= Math.abs(prev.t - h)) byHour.set(h, { t, v });
    }
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, x]) => [h / 1000, Math.round(x.v)]);
}

async function fetchForecast(code, kind) {
  const begin = new Date(Date.now() - 3600e3), end = new Date(Date.now() + 49 * 3600e3);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, ".000+00:00");
  const body = JSON.stringify({
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { ...META.AquoMetadata, ProcesType: kind } },
    Periode: { Begindatumtijd: iso(begin), Einddatumtijd: iso(end) },
  });
  return parseSeries(await getJSON(`${DD}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, { method: "POST", body }, 12000));
}

export async function runForecastUpdate(budgetMs = 8000) {
  const t0 = Date.now();
  const s = store();
  const st = await s.get("stations", { type: "json" });
  if (!st?.stations?.length) return { skipped: true, reason: "nog geen meetpunten; eerst waterstanden bijwerken" };
  const list = st.stations.filter((x) => x.fc);
  if (!list.length) return { skipped: true, reason: "geen meetpunten met verwachting in de catalogus" };

  const prev = (await s.get("forecast", { type: "json" })) || { series: {}, cursor: 0 };
  const series = prev.series || {};
  let cursor = (prev.cursor || 0) % list.length;
  const order = list.slice(cursor).concat(list.slice(0, cursor));
  let done = 0, errors = [], debugSample = null;

  await pool(order, 8, async (x) => {
    if (Date.now() - t0 > budgetMs) return;
    try {
      const pts = await fetchForecast(x.code, x.fc);
      if (pts.length) { series[x.code] = { kind: x.fc, at: new Date().toISOString(), pts }; if (!debugSample) debugSample = { code: x.code, kind: x.fc, first: pts.slice(0, 3) }; }
      done++;
    } catch (e) {
      done++;
      if (errors.length < 5) errors.push(`${x.code}: ${String(e.message || e).slice(0, 200)}`);
    }
  });

  // verlopen reeksen opruimen
  const nowS = Date.now() / 1000;
  for (const [k, v] of Object.entries(series)) if (!v.pts?.length || v.pts[v.pts.length - 1][0] < nowS) delete series[k];

  const payload = { generatedAt: new Date().toISOString(), source: "Rijkswaterstaat WaterWebservices (verwachting / astronomisch getij)", cursor: (cursor + done) % list.length, count: Object.keys(series).length, series };
  await s.setJSON("forecast", payload);
  if (debugSample || errors.length) await s.setJSON("debug-forecast", { at: payload.generatedAt, sample: debugSample, errors, stationsWithForecast: list.length });
  await setStatus("forecast", { completedAt: payload.generatedAt, processed: done, series: payload.count, of: list.length, error: errors.length ? errors.join(" | ") : null });
  return { processed: done, series: payload.count, of: list.length, errors };
}
