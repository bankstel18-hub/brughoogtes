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

// FIS-taken (bruggen, sluizen): bron kiezen, lagen vinden en de pagina's plannen.
// Bronnen in volgorde: ArcGIS FeatureServer, ArcGIS MapServer, FIS-dataservice van vaarweginformatie.nl.
export const FIS_SOURCES = [FIS, FIS.replace(/FeatureServer$/, "MapServer")];
export const FIS_DS = "https://www.vaarweginformatie.nl/wfswms/dataservice/1.4";

// Welke FIS-lagen bij welke taak horen.
const JOBS = {
  bridges: {
    label: "bruggen", jobKey: "bridgejob", prefix: "bj/", out: "bridges", debugKey: "debug-bridges",
    roles: [{ role: "bridge", re: /bridge|brug/i, ds: "bridge" }, { role: "opening", re: /opening/i, ds: "opening" }],
    build: (r) => assemble(r.bridge || [], r.opening || []),
  },
  locks: {
    label: "sluizen", jobKey: "lockjob", prefix: "lj/", out: "locks", debugKey: "debug-locks",
    // Sluizen staan verspreid over een punten- en een vlakkenlaag: beide ophalen.
    roles: [{ role: "lock", re: /^lock\b|^lock\s|sluis(?!kolk)/i, ds: "lock", all: true }, { role: "chamber", re: /chamber|kolk/i, ds: "chamber" }],
    build: (r) => assembleLocks(r.lock || [], r.chamber || []),
  },
};

async function planArcgis(base, cfg) {
  const svc = await getJSON(`${base}?f=json`);
  const layers = (svc.layers || []).concat(svc.tables || []);
  // Per onderdeel de kandidaat-laag met de meeste objecten (punten- en vlakkenlagen kunnen verschillen).
  const countOf = async (l) => { try { return (await getJSON(`${base}/${l.id}/query?where=1%3D1&returnCountOnly=true&f=json`)).count || 0; } catch { return 0; } };
  const candidates = (re) => layers.filter((l) => re.test(l.name) && !(l.subLayerIds && l.subLayerIds.length) && !/subchamber|deelkamer/i.test(l.name));
  const chosen = [];
  for (const r of cfg.roles) {
    const withCount = [];
    for (const l of candidates(r.re)) withCount.push({ l, n: await countOf(l) });
    withCount.sort((a, b) => b.n - a.n);
    const use = r.all ? withCount.filter((x) => x.n > 0) : withCount.slice(0, 1);
    for (const { l } of use) chosen.push({ role: r.role, layer: l });
  }
  if (!chosen.length) throw new Error(`Geen lagen voor ${cfg.label} gevonden. Lagen: ` + layers.map((l) => l.name).join(", "));
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
  meta.push({ role: "_lagen", all: layers.map((l) => `${l.id}:${l.name}`) });
  return { meta, tasks };
}

async function planDataservice(cfg) {
  const g = await getJSON(`${FIS_DS}/geogeneration`);
  const gen = g.GeoGeneration ?? g.geoGeneration ?? g.Result?.GeoGeneration ?? g;
  if (gen == null || typeof gen === "object") throw new Error("Geen geogeneratie in antwoord: " + JSON.stringify(g).slice(0, 200));
  const tasks = [], meta = [];
  for (const { role, ds } of cfg.roles) {
    const first = await getJSON(`${FIS_DS}/${gen}/${ds}?offset=0&count=1`);
    const total = first.TotalCount ?? first.totalCount ?? 0;
    meta.push({ source: FIS_DS, role, generation: gen, total, sample: (first.Result || first.result || [])[0] });
    for (let off = 0; off < total; off += 500) tasks.push({ kind: "ds", role, url: `${FIS_DS}/${gen}/${ds}`, offset: off, n: 500 });
  }
  if (!tasks.length) throw new Error(`Dataservice gaf geen ${cfg.label}`);
  return { meta, tasks };
}

async function planJob(cfg) {
  const errors = [];
  for (const base of FIS_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const r = await planArcgis(base, cfg); return finishPlan(r, errors); }
      catch (e) { errors.push(`${base.split("/").pop()}: ${String(e.message || e).slice(0, 160)}`); }
    }
  }
  try { const r = await planDataservice(cfg); return finishPlan(r, errors); }
  catch (e) { errors.push(`dataservice: ${String(e.message || e).slice(0, 160)}`); }
  throw new Error(`Geen enkele bron voor ${cfg.label} bereikbaar. ` + errors.join(" | "));
}
function finishPlan({ meta, tasks }, errors) {
  return { started: new Date().toISOString(), meta, fallbackErrors: errors, tasks: tasks.map((t, i) => ({ ...t, i, done: false })) };
}

function wktPoint(w) {
  const m = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)/i.exec(String(w || ""));
  return m ? [+(+m[2]).toFixed(6), +(+m[1]).toFixed(6)] : null;
}

async function runTask(t) {
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

// Voert een FIS-taak (bruggen of sluizen) uit binnen een tijdsbudget; hervat bij de volgende aanroep.
async function runFisJob(cfg, budgetMs, { force = false } = {}) {
  const t0 = Date.now();
  const s = store();
  let job = await s.get(cfg.jobKey, { type: "json" });
  const status = await getStatus();
  const last = status[cfg.out]?.completedAt ? Date.parse(status[cfg.out].completedAt) : 0;

  if (!job) {
    if (!force && Date.now() - last < 20 * 3600e3) return { skipped: true, reason: `${cfg.label} zijn minder dan 20 uur oud` };
    job = await planJob(cfg);
    await s.setJSON(cfg.jobKey, job);
    await setStatus(cfg.out, { running: true, startedAt: job.started, error: null });
  }

  try {
    while (Date.now() - t0 < budgetMs) {
      const todo = job.tasks.filter((t) => !t.done).slice(0, 4);
      if (!todo.length) break;
      await Promise.all(todo.map(async (t) => {
        const feats = await runTask(t);
        await s.setJSON(`${cfg.prefix}${t.i}`, feats);
        t.done = true;
      }));
      await s.setJSON(cfg.jobKey, job);
    }
  } catch (e) {
    await setStatus(cfg.out, { error: String(e.message || e), errorAt: new Date().toISOString() });
    throw e;
  }

  const remaining = job.tasks.filter((t) => !t.done).length;
  if (remaining) return { done: false, progress: `${job.tasks.length - remaining}/${job.tasks.length}` };

  const byRole = {};
  for (const t of job.tasks) {
    const feats = (await s.get(`${cfg.prefix}${t.i}`, { type: "json" })) || [];
    (byRole[t.role] ||= []).push(...feats);
  }
  const items = cfg.build(byRole);
  const buildStats = items.stats; delete items.stats;
  const payload = { generatedAt: new Date().toISOString(), source: "Rijkswaterstaat FIS (CC-0)", count: items.length, [cfg.out]: items };
  await s.setJSON(cfg.out, payload);
  await s.setJSON(cfg.debugKey, {
    at: payload.generatedAt, fallbackErrors: job.fallbackErrors, buildStats,
    layers: job.meta.map((m) => ({ ...m, samples: (byRole[m.role] || []).slice(0, 4).map((f) => f.a) })),
  });
  for (const t of job.tasks) await s.delete(`${cfg.prefix}${t.i}`);
  await s.delete(cfg.jobKey);
  await setStatus(cfg.out, { running: false, completedAt: payload.generatedAt, count: items.length, error: null });
  return { done: true, count: items.length };
}

export const runBridgeJob = (budgetMs = 8000, opts) => runFisJob(JOBS.bridges, budgetMs, opts);
export const runLockJob = (budgetMs = 8000, opts) => runFisJob(JOBS.locks, budgetMs, opts);

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
  const navNum = (v) => { const n = num(v); return n == null || Math.abs(n) > 5000 ? null : (Math.abs(n) > 60 ? +(n / 100).toFixed(2) : +n.toFixed(2)); };
  const minOf = (...v) => { const x = v.filter((n) => n != null); return x.length ? Math.min(...x) : null; };

  let closed, open, underNAP = null, openUnderNAP = null, mhw = null, refNAP = null;
  const hasFis = "heightclosed" in all || "clearanceheightclosed" in all;
  if (hasFis) {
    // RWS FIS: heightclosed = hoogte t.o.v. referentiepeil; clearanceheightclosed = doorvaarthoogte
    // (bij rivieren: bij maatgevend hoogwater, MHW = mhwoffset m t.o.v. NAP). Vaste waarde: de laagste.
    const hc = height(all.heightclosed), chc = height(all.clearanceheightclosed);
    const ho = height(all.heightopened), cho = height(all.clearanceheightopened);
    closed = minOf(hc, chc);
    open = minOf(ho, cho);
    if (/river/i.test(String(all.mhwreferencelevel || "")) && num(all.mhwoffset) != null) {
      mhw = +num(all.mhwoffset).toFixed(2);
      if (chc != null) underNAP = +(chc + mhw).toFixed(2);       // onderkant brug t.o.v. NAP
      if (cho != null) openUnderNAP = +(cho + mhw).toFixed(2);
    }
  } else {
    closed = pick(a, RE_CLOSED, EX_CLOSED) ?? pick(parent, RE_CLOSED, EX_CLOSED);
    open = pick(a, RE_OPEN) ?? pick(parent, RE_OPEN);
    underNAP = pick(all, RE_UNDER_NAP, /open|width|breedte/i, navNum);
    refNAP = pick(all, RE_REF_NAP, null, navNum);
  }
  const refName = str(all, RE_REF_NAME);

  // Beweegbaar: het type van de doorvaartopening (VST = vast), anders 'canopen' van de brug.
  let movable;
  if (a.type != null && src === "opening") movable = !/^(VST|VAST|FIXED)$/i.test(String(a.type));
  else {
    const typeTxt = `${str(all, [/type|soort|category|catbrg/i])} ${str(all, [/canopen|movable|beweeg/i])}`.toLowerCase();
    movable = open != null || /beweeg|bascul|draai|hef|lift|swing|draw|ophaal|klap|movable|^yes$|\byes\b/.test(typeTxt);
    if (/vast|fixed|\bvst\b/.test(typeTxt) && open == null) movable = false;
  }

  const pName = parent?.name || parent?.Name;
  let name = pName || str(all, [/^name$|^naam$|objectnaam|bridgename|brugnaam/i]) || "Brug zonder naam";
  if (pName && (parent.numberofopenings || 0) > 1 && a.number != null) name += ` · opening ${a.number}`;
  const place = str(all, [/^city$|^plaats$|^woonplaats$/i]);
  const id = a.id ?? a.Id ?? all.id ?? all.Id ?? all.isrsid ?? null;
  return {
    id, lat: p[0], lng: p[1], name, waterway: place,
    closed, open, movable: movable ? 1 : 0,
    underNAP, openUnderNAP, mhw, refNAP, refName: refName || undefined,
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

/* --- sluizen: sluis met kolken --- */
function pickNum(a, regs, exclude) {
  for (const re of regs) for (const k of Object.keys(a || {})) {
    if (re.test(k) && !(exclude && exclude.test(k))) { const n = num(a[k]); if (n != null && n > 0 && n < 2000) return +n.toFixed(2); }
  }
  return null;
}
function assembleLocks(lockFeats, chamberFeats) {
  const idOf = (a) => a.id ?? a.Id ?? a.ID;
  const byId = new Map();
  for (const f of lockFeats) { const k = String(idOf(f.a)); const prev = byId.get(k); if (!prev || (!prev.f.p && f.p)) byId.set(k, { f, chambers: [] }); }
  const linkKey = chamberFeats.length ? Object.keys(chamberFeats[0].a).find((k) => /^(parentid|lockid|lock_id)$/i.test(k)) : null;
  const orphans = [];
  let linkedByDistance = 0;
  for (const c of chamberFeats) {
    const a = c.a;
    const ch = {
      name: a.name || a.Name || (a.number != null ? `Kolk ${a.number}` : "Kolk"),
      length: pickNum(a, [/^usablelength$|^length$|lengte/i, /length/i], /convoy|width/i),
      width: pickNum(a, [/^usablewidth$|^width$|breedte/i, /width/i], /convoy/i),
      // drempeldiepte staat negatief t.o.v. het peil; benedenhoofd (bebu) en bovenhoofd (bobi) apart
      sill: (() => { const v = ["silldepthbebu", "silldepthbobi", "silldebthinner", "silldepth"].map((k) => num(a[k])).filter((n) => n != null && n !== 0).map(Math.abs); return v.length ? +Math.min(...v).toFixed(2) : null; })(),
      height: pickNum(a, [/clearanceheight|heightclosed|^height$|hoogte|doorvaarthoogte/i]),
    };
    let parent = linkKey ? byId.get(String(a[linkKey])) : null;
    if (!parent && c.p) {
      // Kolk-ID's verwijzen soms naar een andere sluislaag: dan koppelen op afstand (binnen 1 km).
      let bd = 1.0;
      for (const L of byId.values()) {
        if (!L.f.p) continue;
        const dy = (L.f.p[0] - c.p[0]) * 111.2, dx = (L.f.p[1] - c.p[1]) * 111.2 * Math.cos((c.p[0] * Math.PI) / 180);
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; parent = L; }
      }
      if (parent) linkedByDistance++;
    }
    if (parent) parent.chambers.push(ch); else orphans.push({ c, ch });
  }
  const out = [];
  for (const { f, chambers } of byId.values()) {
    if (!f.p) continue;
    const a = f.a;
    out.push({
      id: idOf(a), lat: f.p[0], lng: f.p[1],
      name: a.name || a.Name || "Sluis zonder naam",
      place: a.city || a.City || a.plaats || "",
      phone: a.phonenumber || a.PhoneNumber || "",
      chambers: chambers.sort((x, y) => String(x.name).localeCompare(String(y.name), "nl")),
      a,
    });
  }
  for (const { c, ch } of orphans) if (c.p) out.push({ id: idOf(c.a), lat: c.p[0], lng: c.p[1], name: ch.name, place: c.a.city || "", phone: "", chambers: [ch], a: c.a });
  out.stats = { locks: lockFeats.length, chambers: chamberFeats.length, linkKey, linked: chamberFeats.length - orphans.length, linkedByDistance, orphanSample: orphans.slice(0, 3).map((o) => ({ parent: linkKey && o.c.a[linkKey], name: o.ch.name, p: o.c.p })), lockPointSample: lockFeats.slice(0, 3).map((f) => f.p), lockIdSample: lockFeats.slice(0, 3).map((f) => idOf(f.a)) };
  return out;
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
      fcv: kinds.has("verwachting") ? 1 : 0,
      astro: kinds.has("astronomisch") ? 1 : 0,
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
    if (Date.now() - Date.parse(m.Tijdstip) > 24 * 3600e3) continue;   // oude of stilgelegde meetpunten overslaan
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
  if (!st || Date.now() - Date.parse(st.at) > 7 * 86400e3 || !st.stations?.length || !("astro" in st.stations[0])) {
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
  await appendHistory(values);
  await setStatus("water", { completedAt: payload.generatedAt, count: payload.count, stations: stations.length, method, error: errors.length ? errors.join(" | ") : null });
  return { count: payload.count, stations: stations.length, method, errors };
}

/* ---------------- reeksen: historie, verwachting, astronomisch getij ---------------- */
const H48 = 48 * 3600;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, ".000+00:00");

// Volledige resolutie (meestal elke 10 minuten): [[tijd in s, cm], ...]
function parseSeriesFull(j) {
  const m = new Map();
  for (const w of j.WaarnemingenLijst || []) for (const x of w.MetingenLijst || []) {
    const v = num(x.Meetwaarde?.Waarde_Numeriek), t = Date.parse(x.Tijdstip);
    if (v == null || Math.abs(v) >= 2000 || !isFinite(t)) continue;
    m.set(Math.round(t / 1000), Math.round(v));
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}
// Per uur (voor de app-brede berekeningen)
function hourly(pts) {
  const by = new Map();
  for (const [t, v] of pts) { const h = Math.round(t / 3600) * 3600; const p = by.get(h); if (!p || Math.abs(t - h) <= Math.abs(p[0] - h)) by.set(h, [t, v]); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([h, x]) => [h, x[1]]);
}
async function fetchSeries(code, kind, fromH, toH) {
  const body = JSON.stringify({
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { ...META.AquoMetadata, ProcesType: kind } },
    Periode: { Begindatumtijd: iso(new Date(Date.now() + fromH * 3600e3)), Einddatumtijd: iso(new Date(Date.now() + toH * 3600e3)) },
  });
  return parseSeriesFull(await getJSON(`${DD}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, { method: "POST", body }, 15000));
}
const trim = (pts, fromS, toS = Infinity) => pts.filter(([t]) => t >= fromS && t <= toS);
function mergePts(a = [], b = []) { const m = new Map(a); for (const [t, v] of b) m.set(t, v); return [...m.entries()].sort((x, y) => x[0] - y[0]); }

// Meethistorie opbouwen uit de laatste metingen van elke run (geen extra verzoeken).
async function appendHistory(values) {
  const s = store();
  const hist = (await s.get("hist")) || {};
  const from = Date.now() / 1000 - H48 - 3600;
  for (const [code, v] of Object.entries(values)) {
    const t = Math.round(Date.parse(v.t) / 1000);
    hist[code] = { ...(hist[code] || {}), pts: trim(mergePts(hist[code]?.pts, [[t, Math.round(v.cm)]]), from) };
  }
  await s.setJSON("hist", hist);
}

// Ontbrekende historie aanvullen: per run een beperkt aantal meetpunten, om RWS niet te belasten.
export async function runHistoryBackfill(budgetMs = 60000, max = 60) {
  const t0 = Date.now(), s = store();
  const st = await s.get("stations"), water = await s.get("water");
  if (!st?.stations?.length) return { skipped: true };
  const fresh = new Set((water?.stations || []).filter((x) => x.cm != null).map((x) => x.code));
  const hist = (await s.get("hist")) || {};
  const nowS = Date.now() / 1000;
  const todo = st.stations.filter((x) => fresh.has(x.code)).filter((x) => {
    const h = hist[x.code];
    const covered = h?.pts?.length && h.pts[0][0] <= nowS - 40 * 3600;
    const tried = h?.backfillAt && Date.now() - Date.parse(h.backfillAt) < 6 * 3600e3;
    return !covered && !tried;
  }).slice(0, max);
  let ok = 0, errors = [];
  await pool(todo, 6, async (x) => {
    if (Date.now() - t0 > budgetMs) return;
    try {
      const pts = await fetchSeries(x.code, "meting", -48, 0);
      hist[x.code] = { pts: trim(mergePts(pts, hist[x.code]?.pts), nowS - H48 - 3600), backfillAt: new Date().toISOString() };
      ok++;
    } catch (e) {
      hist[x.code] = { ...(hist[x.code] || { pts: [] }), backfillAt: new Date().toISOString() };
      if (errors.length < 3) errors.push(`${x.code}: ${String(e.message || e).slice(0, 150)}`);
    }
  });
  await s.setJSON("hist", hist);
  const remaining = st.stations.filter((x) => fresh.has(x.code) && !(hist[x.code]?.pts?.length && hist[x.code].pts[0][0] <= nowS - 40 * 3600)).length;
  return { aangevuld: ok, nogTeDoen: remaining, errors };
}

// Verwachting (elk half uur ververst) en astronomisch getij (elke 12 uur) op volle resolutie.
export async function runForecastUpdate(budgetMs = 120000) {
  const t0 = Date.now(), s = store();
  const st = await s.get("stations");
  if (!st?.stations?.length) return { skipped: true, reason: "nog geen meetpunten" };
  const fc10 = (await s.get("fc10")) || {}, astro = (await s.get("astro")) || {};
  const age = (x) => (x?.at ? Date.now() - Date.parse(x.at) : Infinity);
  const jobs = [];
  for (const x of st.stations) {
    if (x.fcv && age(fc10[x.code]) > 25 * 60e3) jobs.push({ x, kind: "verwachting", store: fc10, from: -6, to: 49 });
    if (x.astro && age(astro[x.code]) > 12 * 3600e3) jobs.push({ x, kind: "astronomisch", store: astro, from: -48, to: 49 });
  }
  let done = 0, errors = [], debugSample = null;
  await pool(jobs, 8, async (j) => {
    if (Date.now() - t0 > budgetMs) return;
    try {
      const pts = await fetchSeries(j.x.code, j.kind, j.from, j.to);
      if (pts.length) { j.store[j.x.code] = { at: new Date().toISOString(), pts }; if (!debugSample) debugSample = { code: j.x.code, kind: j.kind, n: pts.length, first: pts.slice(0, 2) }; }
      else j.store[j.x.code] = { at: new Date().toISOString(), pts: j.store[j.x.code]?.pts || [] };
      done++;
    } catch (e) {
      done++;
      if (errors.length < 5) errors.push(`${j.x.code} (${j.kind}): ${String(e.message || e).slice(0, 160)}`);
    }
  });
  const nowS = Date.now() / 1000;
  for (const m of [fc10, astro]) for (const [k, v] of Object.entries(m)) { v.pts = trim(v.pts || [], nowS - H48 - 3600); if (!v.pts.length || v.pts[v.pts.length - 1][0] < nowS) delete m[k]; }
  await s.setJSON("fc10", fc10);
  await s.setJSON("astro", astro);

  // Voor de app: per meetpunt de beste toekomstreeks per uur (verwachting, anders astronomisch).
  const series = {};
  for (const x of st.stations) {
    const f = fc10[x.code], a = astro[x.code];
    if (f?.pts?.length) series[x.code] = { kind: "verwachting", at: f.at, pts: hourly(trim(f.pts, nowS - 3600)) };
    else if (a?.pts?.length) series[x.code] = { kind: "astronomisch", at: a.at, pts: hourly(trim(a.pts, nowS - 3600)) };
  }
  const payload = { generatedAt: new Date().toISOString(), source: "Rijkswaterstaat WaterWebservices (verwachting / astronomisch getij)", count: Object.keys(series).length, series };
  await s.setJSON("forecast", payload);
  await s.setJSON("debug-forecast", { at: payload.generatedAt, sample: debugSample, errors, jobs: jobs.length });
  await setStatus("forecast", { completedAt: payload.generatedAt, processed: done, of: jobs.length, series: payload.count, error: errors.length ? errors.join(" | ") : null });
  return { verwerkt: done, van: jobs.length, reeksen: payload.count, errors };
}

// Per meetpunt één klein bestand voor de grafiek in de app (wordt pas geladen bij aantikken).
export async function writeSeriesFiles() {
  const s = store();
  const st = await s.get("stations"), water = await s.get("water");
  const hist = (await s.get("hist")) || {}, fc10 = (await s.get("fc10")) || {}, astro = (await s.get("astro")) || {};
  const latest = new Map((water?.stations || []).map((x) => [x.code, x]));
  const dir = path.join(DATA_DIR, "series");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  let n = 0;
  for (const x of st?.stations || []) {
    const h = hist[x.code]?.pts || [], f = fc10[x.code], a = astro[x.code];
    if (!h.length && !f?.pts?.length && !a?.pts?.length) continue;
    const l = latest.get(x.code);
    const out = {
      code: x.code, name: x.name, generatedAt: new Date().toISOString(),
      meting: { lastAt: l?.t || null, pts: h },
      verwachting: f ? { fetchedAt: f.at, pts: f.pts } : null,
      astronomisch: a ? { fetchedAt: a.at, pts: a.pts } : null,
    };
    await fs.writeFile(path.join(dir, x.code.replace(/[^a-z0-9._-]/gi, "_") + ".json"), JSON.stringify(out));
    n++;
  }
  return { bestanden: n };
}
