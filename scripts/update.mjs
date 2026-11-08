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

// Klein overzicht voor de app en voor onderhoud.
const status = await getStatus();
await store().setJSON("status", { ...status, lastRun: new Date().toISOString() });
console.log("status:", JSON.stringify(status));
if (failed) process.exitCode = 1;
