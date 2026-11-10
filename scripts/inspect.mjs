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
