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
