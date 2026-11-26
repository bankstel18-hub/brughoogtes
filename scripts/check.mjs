// Datacontrole vóór publicatie. Vergelijkt de nieuwe data met de vorige (live) versie en met de testset bekende bruggen.
// Klopt iets niet, dan blijft de vorige versie staan en faalt de workflow (GitHub stuurt dan een e-mail).
//
//   node scripts/check.mjs <nieuwe datamap> <vorige datamap>
//
// Regels (aan te passen in LIMITS):
//  - bruggen, sluizen of vaarwegvakken: aantal mag niet meer dan 5% dalen
//  - bruggen: hooguit 2% (minimaal 20) mag een andere hoogte krijgen dan bij de vorige versie (> 30 cm verschil)
//  - testset tests/bekende-bruggen.json: elke actieve brug moet de verwachte hoogte hebben
//  - waterstanden buiten -6 m tot +15 m NAP worden weggelaten (meetfout)
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = { maxDrop: 0.05, heightJump: 0.3, maxChangedFrac: 0.02, maxChangedMin: 20, waterMinCm: -600, waterMaxCm: 1500 };

const keyOf = (b) => (b.id != null ? `id:${b.id}` : `${b.name}|${b.lat.toFixed(4)}|${b.lng.toFixed(4)}`);
const near = (a, b) => { const dy = (a.lat - b.lat) * 111.2, dx = (a.lng - b.lng) * 111.2 * Math.cos((a.lat * Math.PI) / 180); return Math.hypot(dx, dy); };

// Testset bekende bruggen: per brug { naam, lat, lng, veld, verwacht, marge, actief }.
export function checkGolden(bridges, golden) {
  const out = [];
  for (const g of golden?.bruggen || []) {
    if (g.actief === false) continue;
    const cands = bridges.filter((b) => b.name.toLowerCase().includes(String(g.naam).toLowerCase()) && near(b, g) <= 0.3).sort((a, b) => near(a, g) - near(b, g));
    const b = cands[0];
    const veld = g.veld || "underNAP", marge = g.marge ?? 0.05;
    if (!b) { out.push({ naam: g.naam, ok: false, reden: "brug niet gevonden (naam binnen 300 m)" }); continue; }
    const v = b[veld];
    const ok = v != null && Math.abs(v - g.verwacht) <= marge + 1e-9;
    out.push({ naam: g.naam, ok, veld, verwacht: g.verwacht, gevonden: v ?? null, ...(ok ? {} : { reden: v == null ? `${veld} ontbreekt` : `verschil ${(v - g.verwacht).toFixed(2)} m` }) });
  }
  return out;
}

// Vergelijkt vorige en nieuwe data. Geeft bevindingen en wat er teruggezet moet worden.
export function compareData({ prev = {}, next = {}, golden = null }, L = LIMITS) {
  const issues = [], restore = new Set(), notes = [];
  const count = (o, k) => (k === "network" ? Object.keys(o?.network?.sections || {}).length : (o?.[k] || []).length);
  for (const k of ["bridges", "locks", "network"]) {
    const a = count(prev[k], k), b = count(next[k], k);
    if (a && b < a * (1 - L.maxDrop)) { issues.push(`${k}: aantal gedaald van ${a} naar ${b}`); restore.add(k); }
  }
  // Hoogtes van bruggen die ineens anders zijn.
  const pb = prev.bridges?.bridges || [], nb = next.bridges?.bridges || [];
  if (pb.length && nb.length && !restore.has("bridges") && next.bridges.generatedAt !== prev.bridges.generatedAt) {
    const m = new Map(pb.map((b) => [keyOf(b), b]));
    let matched = 0; const changed = [];
    for (const b of nb) {
      const o = m.get(keyOf(b)); if (!o) continue;
      matched++;
      for (const f of ["closed", "underNAP"]) if (o[f] != null && b[f] != null && Math.abs(o[f] - b[f]) > L.heightJump) { changed.push(`${b.name}: ${f} ${o[f]} → ${b[f]}`); break; }
    }
    const max = Math.max(L.maxChangedMin, Math.round(matched * L.maxChangedFrac));
    if (changed.length > max) { issues.push(`bruggen: ${changed.length} van ${matched} met een andere hoogte (max ${max}), bijv. ${changed.slice(0, 3).join("; ")}`); restore.add("bridges"); }
    else if (changed.length) notes.push(`bruggen: ${changed.length} hoogtes gewijzigd (binnen de grens), bijv. ${changed.slice(0, 3).join("; ")}`);
  }
  // Testset bekende bruggen.
  let goldenResult = [];
  if (golden?.bruggen?.length && nb.length) {
    goldenResult = checkGolden(nb, golden);
    const bad = goldenResult.filter((g) => !g.ok);
    if (bad.length) {
      issues.push(`testset: ${bad.length} van ${goldenResult.length} bekende bruggen wijken af: ${bad.map((g) => `${g.naam} (${g.reden})`).join("; ")}`);
      // Alleen terugzetten als de vorige versie de testset wél haalde.
      if (pb.length && checkGolden(pb, golden).every((g) => g.ok) && next.bridges.generatedAt !== prev.bridges?.generatedAt) restore.add("bridges");
    }
  }
  // Onmogelijke waterstanden weglaten.
  const waterFix = [];
  for (const s of next.water?.stations || []) if (s.cm != null && (s.cm < L.waterMinCm || s.cm > L.waterMaxCm)) waterFix.push(s.code);
  if (waterFix.length) notes.push(`water: ${waterFix.length} onmogelijke meting(en) weggelaten: ${waterFix.slice(0, 5).join(", ")}`);
  return { issues, notes, restore: [...restore], waterFix, golden: goldenResult };
}

/* ---------- uitvoeren vanuit de workflow ---------- */
async function main() {
  const [nextDir = "_site/data", prevDir = "_prev"] = process.argv.slice(2);
  const read = async (dir, k) => { try { return JSON.parse(await fs.readFile(path.join(dir, k + ".json"), "utf8")); } catch { return null; } };
  const keys = ["bridges", "locks", "network", "water"];
  const prev = {}, next = {};
  for (const k of keys) { prev[k] = await read(prevDir, k); next[k] = await read(nextDir, k); }
  const here = path.dirname(fileURLToPath(import.meta.url));
  let golden = null; try { golden = JSON.parse(await fs.readFile(path.join(here, "..", "tests", "bekende-bruggen.json"), "utf8")); } catch {}
  const r = compareData({ prev, next, golden });

  for (const k of r.restore) {
    // Vorige versie terugzetten; volgende poging over ongeveer 2 uur (niet elke 10 minuten de hele FIS-bron ophalen).
    await fs.copyFile(path.join(prevDir, k + ".json"), path.join(nextDir, k + ".json"));
    const st = (await read(nextDir, "status")) || {};
    st[k] = { ...(st[k] || {}), completedAt: new Date(Date.now() - 18 * 3600e3).toISOString(), rejectedAt: new Date().toISOString(), error: "nieuwe versie afgekeurd door datacontrole" };
    await fs.writeFile(path.join(nextDir, "status.json"), JSON.stringify(st));
  }
  if (r.waterFix.length && next.water) {
    const bad = new Set(r.waterFix);
    for (const s of next.water.stations) if (bad.has(s.code)) { s.cm = null; s.t = null; }
    await fs.writeFile(path.join(nextDir, "water.json"), JSON.stringify(next.water));
  }
  const report = { at: new Date().toISOString(), ok: !r.issues.length, ...r };
  await fs.writeFile(path.join(nextDir, "check.json"), JSON.stringify(report, null, 1));
  for (const n of r.notes) console.log("ℹ " + n);
  for (const i of r.issues) console.log("✗ " + i);
  if (r.golden.length) console.log(`testset: ${r.golden.filter((g) => g.ok).length}/${r.golden.length} in orde`);
  if (r.restore.length) console.log(`↩ vorige versie teruggezet: ${r.restore.join(", ")}`);
  if (r.issues.length) process.exitCode = 1; else console.log("✓ datacontrole in orde");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
