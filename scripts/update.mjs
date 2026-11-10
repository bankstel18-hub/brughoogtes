// Werkt de data van de app bij. Wordt door GitHub Actions elke 10 minuten uitgevoerd.
//   node scripts/update.mjs <datamap> [bruggen] [--force-bruggen]
// Waterstanden en verwachtingen worden altijd bijgewerkt; bruggen hooguit eens per ~20 uur
// (of altijd met --force-bruggen).
import { setDataDir, runWaterUpdate, runForecastUpdate, runHistoryBackfill, writeSeriesFiles, runBridgeJob, runLockJob, runNetworkJob, linkViaNetwork, snapToNetwork, computeLags, getStatus, store, getJSON, FIS } from "./rws.mjs";
import { loadPeilgebieden, peilIndex, peilKey, fetchFisLines, lineIndex, peilCompatible } from "./peil.mjs";
import os from "node:os";
import path from "node:path";

const [dir = "data", ...flags] = process.argv.slice(2);
setDataDir(dir);
const force = flags.includes("--force-bruggen");
let failed = false;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s):`, JSON.stringify(r));
  } catch (e) {
    failed = true;
    console.error(`✗ ${name} mislukt:`, e?.stack || e);
  }
}

await step("waterstanden", () => runWaterUpdate(120000));
await step("historie aanvullen", () => runHistoryBackfill(90000, 60));
await step("verwachtingen", () => runForecastUpdate(150000));
await step("bruggen", async () => {
  let r = await runBridgeJob(240000, { force });
  while (r && r.done === false) r = await runBridgeJob(240000);
  return r;
});

await step("sluizen", async () => {
  let r = await runLockJob(240000, { force });
  while (r && r.done === false) r = await runLockJob(240000);
  return r;
});

await step("vaarwegennetwerk", async () => {
  let r = await runNetworkJob(240000, { force });
  while (r && r.done === false) r = await runNetworkJob(240000);
  return r;
});
// Peilgebieden van de waterschappen: per brug en per meetpunt bepalen in welk peilgebied het water ligt.
// Eens per dag opnieuw (of als bruggen, netwerk of meetpunten nieuwer zijn), anders de bewaarde toewijzing.
await step("peilgebieden", async () => {
  const brp = await store().get("bridges"), netp = await store().get("network"), st = await store().get("stations");
  const net = netp?.network;
  if (!brp?.bridges?.length || !net?.sections || !st?.stations?.length) return { skipped: true, reason: "netwerk, bruggen of meetpunten ontbreken" };
  const prev = await store().get("peil");
  const newest = Math.max(...[brp.generatedAt, netp.generatedAt, st.at].map((x) => Date.parse(x || 0) || 0));
  if (!force && prev?.at && Date.now() - Date.parse(prev.at) < 24 * 3600e3 && Date.parse(prev.at) > newest) return { skipped: true, reason: "toewijzing is van vandaag", gebieden: prev.gebieden?.length };
  const polys = await loadPeilgebieden(getJSON, path.join(os.tmpdir(), "peilgebieden.json"), { force: true, log: (m) => console.log("  " + m) });
  const idx = peilIndex(polys);
  // Streefpeil en getijdegebied langs de vaarweg uit FIS.
  const ms = FIS.replace(/FeatureServer$/, "MapServer");
  const sp = (await fetchFisLines(getJSON, ms, 50)).map((l) => ({ ...l, lab: l.a.value != null ? `S:${(+l.a.value).toFixed(2)}` : `S:${l.a.name || "?"}` }));
  const tij = (await fetchFisLines(getJSON, ms, 198)).map((l) => ({ ...l, lab: "T" }));
  const lines = [...sp, ...tij], li = lineIndex(lines);
  const spNames = {}; for (const l of sp) spNames[l.lab] ||= l.a.name || "";
  // Punten eerst op de vaarweg zetten: dan ligt het punt op het water en niet op de kade of dijk ernaast.
  const stp = snapToNetwork(net, st.stations.map((x) => [x.lat, x.lng]), { maxKm: 1.5 });
  const brp2 = snapToNetwork(net, brp.bridges.map((b) => [b.lat, b.lng]), { maxKm: 0.3, secOf: (i) => brp.bridges[i].sec });
  const used = new Map(), ref = (i) => { if (i < 0) return -1; if (!used.has(i)) used.set(i, used.size); return used.get(i); };
  const info = (p) => ({ w: idx.around(p[0], p[1], 15).map(ref), f: [...new Set(li.near(p[0], p[1], 50).map((k) => lines[k].lab))] });
  const stations = {}, bridges = {};
  st.stations.forEach((x, i) => { stations[x.code] = info(stp[i]); });
  brp.bridges.forEach((b, i) => { bridges[peilKey(b.lat, b.lng)] = info(brp2[i]); });
  const gebieden = [...used.keys()].map((i) => ({ code: polys[i].code, naam: polys[i].naam, wb: polys[i].wb }));
  await store().setJSON("peil", { at: new Date().toISOString(), bron: "PDOK Waterschappen Waterbeheergebieden IMWA (CC BY-SA 4.0); Rijkswaterstaat FIS streefpeil en getijdegebied (CC-0)", gebieden, streefpeilen: spNames, stations, bridges });
  const cnt = (o) => { const v = Object.values(o); return { metFisLabel: v.filter((a) => a.f.length).length, getij: v.filter((a) => a.f.includes("T")).length, binnendijks: v.filter((a) => a.w.length && !a.w.includes(-1)).length }; };
  // Toets op de paren die bij de vorige run verdacht waren.
  const lgPrev = (await store().get("lags")) || {}, nm = new Map(st.stations.map((x) => [x.code, x.name]));
  const lab = (x) => `${x.w.map((k) => (k < 0 ? "buiten" : gebieden[k].code)).join("/")} | ${x.f.join("/") || "-"}`;
  for (const [k, v] of Object.entries(lgPrev)) {
    if (!/gescheiden|lage overeenkomst/.test(v.why || "")) continue;
    const [a, b] = k.split("|"), A = stations[a], B = stations[b];
    if (!A || !B) continue;
    const c = peilCompatible(A, B);
    console.log(`PEILPAAR\t${c.ok ? "samen" : "gescheiden(" + c.why + ")"}\t${nm.get(a)}\t${lab(A)}\t${nm.get(b)}\t${lab(B)}\t${v.why}`);
  }
  return { peilgebiedenTotaal: polys.length, streefpeilLijnen: sp.length, getijLijnen: tij.length, gebruikteGebieden: gebieden.length, meetpunten: cnt(stations), bruggen: cnt(bridges) };
});

// Bruggen koppelen aan meetpunten over het water (sluizen en stuwen scheiden de wateren; daarnaast de peilgebieden).
await step("koppeling meetpunten", async () => {
  const brp = await store().get("bridges"), net = (await store().get("network"))?.network, st = await store().get("stations");
  if (!brp?.bridges?.length || !net?.sections || !st?.stations?.length) return { skipped: true, reason: "netwerk, bruggen of meetpunten ontbreken" };
  const t0 = Date.now();
  const pl = await store().get("peil");
  const why = {}, ex = [], stName = new Map(st.stations.map((x) => [x.code, x.name]));
  const peil = pl?.stations && pl.stations[Object.keys(pl.stations)[0]]?.w ? { allow: (b, code) => {
    const pb = pl.bridges[peilKey(b.lat, b.lng)], ps = pl.stations[code], c = peilCompatible(pb, ps);
    if (!c.ok) { why[c.why] = (why[c.why] || 0) + 1; if (ex.length < 40 && Math.random() < 0.05) ex.push(`${b.name} -> ${stName.get(code)} [${pb.f.join("/")}|${pb.w.join("/")}] vs [${ps.f.join("/")}|${ps.w.join("/")}] (${c.why})`); }
    return c.ok;
  } } : null;
  const r = linkViaNetwork(net, brp.bridges, st.stations, { peil });
  r.afgewezenPerReden = why;
  for (const e of ex) console.log("PEILAF\t" + e);
  brp.linkedAt = new Date().toISOString();
  await store().setJSON("bridges", brp);
  return { ...r, seconden: ((Date.now() - t0) / 1000).toFixed(1) };
});
await step("looptijden tussen meetpunten", async () => computeLags((await store().get("bridges"))?.bridges || [], { force }));
// Overzicht van paren die vermoedelijk gescheiden zijn (voor controle van het netwerk).
await step("controlelijst gescheiden paren", async () => {
  const lg = (await store().get("lags")) || {}, st = await store().get("stations"), brp = await store().get("bridges");
  const nm = new Map((st?.stations || []).map((x) => [x.code, x]));
  const per = {};
  for (const b of brp?.bridges || []) {
    const S = (b.sts || []).filter((x) => x[2] === "s").slice(0, 2), E = (b.sts || []).filter((x) => x[2] === "e").slice(0, 2);
    for (const a of S) for (const e of E) { const k = [a[0], e[0]].sort().join("|"); const o = (per[k] ||= { n: 0, km: a[1] + e[1], brug: b.name }); o.n++; if (a[1] + e[1] < o.km) { o.km = a[1] + e[1]; o.brug = b.name; } }
  }
  const pl = await store().get("peil");
  const pn = (code) => { const x = pl?.stations?.[code]; if (!x?.w) return ""; return x.w.map((k) => (k < 0 ? "buiten" : pl.gebieden[k].code)).join("/") + " | " + (x.f.join("/") || "-"); };
  const rows = Object.entries(lg).filter(([, v]) => /gescheiden|lage overeenkomst/.test(v.why || ""));
  for (const [k, v] of rows.sort((x, y) => (per[y[0]]?.n || 0) - (per[x[0]]?.n || 0))) {
    const [a, b] = k.split("|"), A = nm.get(a), B = nm.get(b), p = per[k] || {};
    console.log("PAAR\t" + [A?.name || a, B?.name || b, v.sd?.[0], v.sd?.[1], v.r, v.lagBest, (p.km ?? 0).toFixed(1), p.n || 0, p.brug || "", v.why,
      A ? `${A.lat.toFixed(4)},${A.lng.toFixed(4)}` : "", B ? `${B.lat.toFixed(4)},${B.lng.toFixed(4)}` : "", pn(a), pn(b)].join("\t"));
  }
  return { aantal: rows.length };
});
// verwachtingen opnieuw wegschrijven met de looptijden erin (geen extra verzoeken bij RWS)
await step("verwachtingen bijwerken met looptijden", () => runForecastUpdate(-1));
await step("grafiekbestanden", () => writeSeriesFiles());

// Samenvatting van de sluisdata in het logboek.
const lk = await store().get("locks");
const dbgL = await store().get("debug-locks");
if (lk?.locks?.length) {
  const L = lk.locks, n = (f) => L.filter(f).length;
  console.log("sluisdata:", JSON.stringify({ totaal: L.length, metKolken: n((x) => x.chambers.length), kolken: L.reduce((t, x) => t + x.chambers.length, 0),
    metLengte: n((x) => x.chambers.some((c) => c.length)), metBreedte: n((x) => x.chambers.some((c) => c.width)), metDrempel: n((x) => x.chambers.some((c) => c.sill)), metHoogte: n((x) => x.chambers.some((c) => c.height)) }));
  console.log("koppeling kolken:", JSON.stringify(dbgL?.buildStats));
  console.log("alle lagen:", JSON.stringify((dbgL?.layers || []).find((l) => l.role === "_lagen")?.all));
  console.log("gekozen:", JSON.stringify((dbgL?.layers || []).filter((l) => l.role !== "_lagen").map((l) => [l.role, l.id, l.name, l.max, l.pag])));
  for (const l of dbgL?.layers || []) {
    console.log(`laag ${l.role} (${l.name || l.source}): velden=${(l.fields || []).join(", ")}`);
    console.log(`  voorbeeld: ${JSON.stringify((l.samples || [l.sample])[0] || {}).slice(0, 900)}`);
  }
  console.log("voorbeeldsluis:", JSON.stringify((L.find((x) => x.chambers.length > 1) || L[0]), (k, v) => (k === "a" ? undefined : v)).slice(0, 900));
}

// Samenvatting van de brugdata in het logboek (voor onderhoud en controle).
const br = await store().get("bridges");
const dbg = await store().get("debug-bridges");
if (br?.bridges?.length) {
  const B = br.bridges, n = (f) => B.filter(f).length;
  console.log("brugdata:", JSON.stringify({
    totaal: B.length, metHoogteGesloten: n((b) => b.closed != null), metHoogteOpen: n((b) => b.open != null),
    beweegbaar: n((b) => b.movable), metOnderkantNAP: n((b) => b.underNAP != null), metReferentieNAP: n((b) => b.refNAP != null),
    metReferentieNaam: n((b) => b.refName), zonderNaam: n((b) => b.name === "Brug zonder naam"),
  }));
  // Analyse van de hoogtevelden ten opzichte van het referentiepeil.
  const cnt = (f) => { const m = {}; for (const b of B) { const k = f(b.a || {}); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 15); };
  console.log("referencelevel:", JSON.stringify(cnt((a) => a.referencelevel ?? "-")));
  console.log("mhwreferencelevel:", JSON.stringify(cnt((a) => a.mhwreferencelevel ?? "-")));
  const both = B.filter((b) => b.a?.heightclosed != null && b.a?.clearanceheightclosed != null);
  const diffs = both.map((b) => +(b.a.clearanceheightclosed - b.a.heightclosed).toFixed(2));
  const off = both.filter((b) => b.a.mhwoffset != null);
  const near = (x, y) => Math.abs(x - y) < 0.06;
  console.log("hoogtevelden:", JSON.stringify({
    beideAanwezig: both.length, gelijk: diffs.filter((d) => d === 0).length, clearanceHoger: diffs.filter((d) => d > 0).length, clearanceLager: diffs.filter((d) => d < 0).length,
    metMhwOffset: off.length,
    verschilIsOffset: off.filter((b) => near(b.a.clearanceheightclosed - b.a.heightclosed, b.a.mhwoffset)).length,
    verschilIsMinOffset: off.filter((b) => near(b.a.clearanceheightclosed - b.a.heightclosed, -b.a.mhwoffset)).length,
    alleenClearance: B.filter((b) => b.a?.heightclosed == null && b.a?.clearanceheightclosed != null).length,
    alleenHeight: B.filter((b) => b.a?.heightclosed != null && b.a?.clearanceheightclosed == null).length,
  }));
  const ex = (re) => B.filter((b) => re.test(String(b.a?.referencelevel || "")) && b.a?.heightclosed != null).slice(0, 3)
    .map((b) => ({ naam: b.name, ref: b.a.referencelevel, mhwref: b.a.mhwreferencelevel, mhwoffset: b.a.mhwoffset, h: b.a.heightclosed, ch: b.a.clearanceheightclosed, ho: b.a.heightopened, cho: b.a.clearanceheightopened, vaarweg: b.waterway }));
  for (const r of [/^NAP$/, /OLR/, /^KP$/, /GLW|LAT|MLW/, /MHW|HW/]) console.log(`voorbeelden ${r}:`, JSON.stringify(ex(r)));
  for (const l of dbg?.layers || []) {
    console.log(`laag ${l.role} (${l.name || l.source}): velden=${(l.fields || []).join(", ")}`);
    console.log(`  voorbeeld: ${JSON.stringify((l.samples || [l.sample])[0] || {}).slice(0, 900)}`);
  }
}

// Opzoeken van een brug (workflow-invoer 'zoek'): gegevens plus actuele doorvaarthoogte.
const zoek = (process.env.ZOEK || "").trim().toLowerCase();
if (zoek && br?.bridges?.length) {
  const water = await store().get("water");
  const fc = (await store().get("forecast"))?.series || {};
  const km = (a, b, c, d) => { const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r; return Math.sqrt(x * x + y * y) * 6371; };
  const terms = zoek.split("|").map((x) => x.trim()).filter(Boolean);
  const hits = br.bridges.filter((b) => terms.some((z) => b.name.toLowerCase().includes(z) || (b.waterway || "").toLowerCase().includes(z))).slice(0, 12);
  console.log(`zoek "${zoek}": ${hits.length} resultaten`);
  for (const b of hits) {
    // Zelfde logica als de app: verse meting (< 3 uur), anders de verwachting voor nu.
    const nowS = Date.now() / 1000;
    const interp = (pts, t) => { for (let i = 0; i < pts.length - 1; i++) if (t >= pts[i][0] && t <= pts[i + 1][0]) return pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * (t - pts[i][0])) / (pts[i + 1][0] - pts[i][0]); return null; };
    const lvl = (x) => {
      if (x.cm != null && x.t && Date.now() - Date.parse(x.t) <= 3 * 3600e3) return { cm: x.cm, soort: "meting", tijd: x.t };
      const v = fc[x.code] && interp(fc[x.code].pts, nowS);
      return v != null ? { cm: Math.round(v), soort: fc[x.code].kind, tijd: new Date().toISOString() } : null;
    };
    // Zelfde keuze als de app: meetpunten via het vaarwegennetwerk (open verbinding), eerste met actuele gegevens.
    const wmap = new Map((water?.stations || []).map((x) => [x.code, x]));
    let st = null;
    if (Array.isArray(b.sts)) for (const [code, kmNet] of b.sts) { const x = wmap.get(code); const l = x && lvl(x); if (l) { st = { ...x, l, d: kmNet, net: true }; break; } }
    else st = (water?.stations || []).map((x) => ({ ...x, l: lvl(x), d: km(b.lat, b.lng, x.lat, x.lng) })).filter((x) => x.l).sort((x, y) => x.d - y.d)[0];
    const hemels = (water?.stations || []).map((x) => ({ n: x.name, d: +km(b.lat, b.lng, x.lat, x.lng).toFixed(1) })).sort((x, y) => x.d - y.d)[0];
    const cur = st && (st.net || st.d <= 10) && b.underNAP != null ? +(b.underNAP - st.l.cm / 100).toFixed(2) : null;
    const curOpen = st && (st.net || st.d <= 10) && b.openUnderNAP != null ? +(b.openUnderNAP - st.l.cm / 100).toFixed(2) : null;
    let minFc = null;
    if (st && b.underNAP != null && fc[st.code]) for (const [t, cm] of fc[st.code].pts) { if (t < nowS) continue; const c = +(b.underNAP - cm / 100).toFixed(2); if (!minFc || c < minFc.c) minFc = { c, t: new Date(t * 1000).toISOString() }; }
    console.log("  brug:", JSON.stringify({ naam: b.name, plaats: b.waterway, beweegbaar: !!b.movable, gesloten: b.closed, open: b.open, ref: b.refName, mhwNAP: b.mhw, onderkantNAP: b.underNAP,
      meetpunt: st && { naam: st.name, km: +st.d.toFixed(1), overWater: !!st.net, cmNAP: st.l.cm, soort: st.l.soort, tijd: st.l.tijd },
      kandidaten: b.sts, dichtstbijHemelsbreed: hemels, actueelGesloten: cur, actueelOpen: curOpen, laagsteVerwacht48u: minFc,
      velden: Object.fromEntries(Object.entries(b.a || {}).filter(([k]) => /height|clearance|reference|mhw|type|canopen|width|number/i.test(k))) }));
  }
}

// Klein overzicht voor de app en voor onderhoud.
const status = await getStatus();
await store().setJSON("status", { ...status, lastRun: new Date().toISOString() });
console.log("status:", JSON.stringify(status));
if (failed) process.exitCode = 1;
