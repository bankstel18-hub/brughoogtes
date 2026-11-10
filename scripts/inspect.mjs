// Onderhoud: velden en voorbeelden van FIS-lagen tonen.  INSPECT="16,24,29,50,58,62,198" node scripts/inspect.mjs
import { getJSON, FIS, FIS_DS } from "./rws.mjs";
const base = FIS.replace(/FeatureServer$/, "MapServer");
for (const id of (process.env.INSPECT || "").split(",").map((x) => x.trim()).filter(Boolean)) {
  if (!/^\d+$/.test(id)) {
    try { const j = await getJSON(`${FIS_DS}/${id}`); console.log(`DS ${id}:`, JSON.stringify(j).slice(0, 1500)); } catch (e) { console.log(`DS ${id} fout:`, String(e.message).slice(0, 200)); }
    continue;
  }
  try {
    const info = await getJSON(`${base}/${id}?f=json`);
    const c = await getJSON(`${base}/${id}/query?where=1%3D1&returnCountOnly=true&f=json`);
    const q = await getJSON(`${base}/${id}/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=3&f=json`);
    console.log(`LAAG ${id} ${info.name} (${info.geometryType}) aantal=${c.count}`);
    console.log(`  velden: ${(info.fields || []).map((f) => f.name).join(", ")}`);
    for (const f of q.features || []) console.log(`  vb: ${JSON.stringify(f.attributes).slice(0, 700)}`);
  } catch (e) { console.log(`LAAG ${id} fout:`, String(e.message).slice(0, 200)); }
}

// Extra analyses voor de koppeling met meetpunten.
if ((process.env.INSPECT || "").includes("analyse")) {
  const all = async (id, fields) => {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const j = await getJSON(`${base}/${id}/query?where=1%3D1&outFields=${fields}&returnGeometry=false&resultOffset=${off}&resultRecordCount=1000&f=json`);
      out.push(...(j.features || []).map((f) => f.attributes));
      if (!(j.features || []).length || !j.exceededTransferLimit) break;
    }
    return out;
  };
  const cnt = (arr, f) => { const m = {}; for (const a of arr) { const k = f(a); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const kw = await all(12, "id,structuretype,referencelevel,name");
  console.log("kunstwerk structuretype:", JSON.stringify(cnt(kw, (a) => a.structuretype)));
  console.log("kunstwerk referencelevel:", JSON.stringify(cnt(kw, (a) => a.referencelevel)));
  for (const t of [...new Set(kw.map((a) => a.structuretype))]) console.log(`  ${t}:`, kw.filter((a) => a.structuretype === t).slice(0, 4).map((a) => a.name).join(" | "));
  const br = await all(3, "id,referencelevel,mhwreferencelevel,mhwoffset");
  const op = await all(15, "id,parentid,parentgeotype,heightclosed,clearanceheightclosed");
  const bi = new Map(br.map((b) => [b.id, b]));
  const ki = new Map(kw.map((b) => [b.id, b]));
  console.log("opening parentgeotype:", JSON.stringify(cnt(op, (a) => a.parentgeotype)));
  const riv = op.filter((o) => { const b = bi.get(o.parentid); return b && b.referencelevel === "NAP" && /river/i.test(b.mhwreferencelevel || "") && b.mhwoffset != null && o.heightclosed && o.clearanceheightclosed; });
  const ok = riv.filter((o) => Math.abs(o.heightclosed - (o.clearanceheightclosed + bi.get(o.parentid).mhwoffset)) < 0.06).length;
  console.log(`toets NAP-hoogte rivierbruggen: ${ok} van ${riv.length} hebben heightclosed = clearance + mhwoffset`);
  console.log("refs bruggen (ref|mhwref):", JSON.stringify(cnt(op.filter((o) => o.parentgeotype === "bridge"), (o) => { const b = bi.get(o.parentid); return b ? `${b.referencelevel}|${b.mhwreferencelevel}` : "?"; }).slice(0, 12)));
  const kop = op.filter((o) => o.parentgeotype !== "bridge");
  console.log("refs kunstwerken (type|ref):", JSON.stringify(cnt(kop, (o) => { const k = ki.get(o.parentid); return k ? `${k.structuretype}|${k.referencelevel}` : "geen ouder"; }).slice(0, 15)));
  const ob = op.find((o) => /beijerland/i.test(ki.get(o.parentid)?.name || ""));
  console.log("Oud-Beijerland ouder:", JSON.stringify(ob && ki.get(ob.parentid)));
}
