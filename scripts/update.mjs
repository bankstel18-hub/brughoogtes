// Werkt de data van de app bij. Wordt door GitHub Actions elke 10 minuten uitgevoerd.
//   node scripts/update.mjs <datamap> [bruggen] [--force-bruggen]
// Waterstanden en verwachtingen worden altijd bijgewerkt; bruggen hooguit eens per ~20 uur
// (of altijd met --force-bruggen).
import { setDataDir, runWaterUpdate, runForecastUpdate, runBridgeJob, getStatus, store } from "./rws.mjs";

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
await step("verwachtingen", async () => {
  // Alle meetpunten in één keer; zonder tijdslimiet van een serverfunctie.
  const st = await store().get("stations");
  const n = st?.stations?.filter((x) => x.fc).length || 0;
  let r, rounds = 0;
  do { r = await runForecastUpdate(150000); rounds++; } while (rounds < 3 && r.processed && r.processed < n);
  return r;
});
await step("bruggen", async () => {
  let r = await runBridgeJob(240000, { force });
  while (r && r.done === false) r = await runBridgeJob(240000);
  return r;
});

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
  const hits = br.bridges.filter((b) => b.name.toLowerCase().includes(zoek) || (b.waterway || "").toLowerCase().includes(zoek)).slice(0, 12);
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
    const st = (water?.stations || []).map((x) => ({ ...x, l: lvl(x), d: km(b.lat, b.lng, x.lat, x.lng) })).filter((x) => x.l).sort((x, y) => x.d - y.d)[0];
    const cur = st && st.d <= 10 && b.underNAP != null ? +(b.underNAP - st.l.cm / 100).toFixed(2) : null;
    const curOpen = st && st.d <= 10 && b.openUnderNAP != null ? +(b.openUnderNAP - st.l.cm / 100).toFixed(2) : null;
    let minFc = null;
    if (st && b.underNAP != null && fc[st.code]) for (const [t, cm] of fc[st.code].pts) { if (t < nowS) continue; const c = +(b.underNAP - cm / 100).toFixed(2); if (!minFc || c < minFc.c) minFc = { c, t: new Date(t * 1000).toISOString() }; }
    console.log("  brug:", JSON.stringify({ naam: b.name, plaats: b.waterway, beweegbaar: !!b.movable, gesloten: b.closed, open: b.open, ref: b.refName, mhwNAP: b.mhw, onderkantNAP: b.underNAP,
      meetpunt: st && { naam: st.name, km: +st.d.toFixed(1), cmNAP: st.l.cm, soort: st.l.soort, tijd: st.l.tijd }, actueelGesloten: cur, actueelOpen: curOpen, laagsteVerwacht48u: minFc,
      velden: Object.fromEntries(Object.entries(b.a || {}).filter(([k]) => /height|clearance|reference|mhw|type|canopen|width|number/i.test(k))) }));
  }
}

// Klein overzicht voor de app en voor onderhoud.
const status = await getStatus();
await store().setJSON("status", { ...status, lastRun: new Date().toISOString() });
console.log("status:", JSON.stringify(status));
if (failed) process.exitCode = 1;
