// Waterstandgrafiek in RWS-stijl: meting, verwachting, astronomisch getij; tik of sleep om een tijdstip te kiezen.
import { S, $, offsetH, ago } from "./state.js";
import { esc, signed, fmt, clearanceFor } from "./core.js";
import { levelAt, bridgeLevel, stationValue, currentClearance } from "./water.js";
import { bridgeHead, bridgeWl, stationHead } from "./popups.js";
import { updateWhen } from "./panel.js";
import { DISC_SHORT } from "./config.js";

const SERIES_COLORS = { meting: "#1f6fd1", verwachting: "#d9534f", astronomisch: "#8c969e" };
const SERIES_NAMES = { meting: "Waterhoogte gemeten", verwachting: "Waterhoogte verwachting", astronomisch: "Waterhoogte astronomisch" };
export const kindTxt = (k) => ({ meting: "gemeten", verwachting: "verwacht", astronomisch: "astronomisch getij", schatting: "geschat" }[k] || "");
const fileOf = (code) => `data/series/${code.replace(/[^a-z0-9._-]/gi, "_")}.json`;

function sparkReadout(s, b, h) {
  const lv = b ? bridgeLevel(b, h) : levelAt(s, h);
  const when = h === 0 ? "Nu" : new Date(Date.now() + h * 3600e3).toLocaleString("nl-NL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (!lv) return `<b>${when}</b>: geen waterstand beschikbaar`;
  const c = b ? clearanceFor(b, lv.cm) : null;
  return `<b>${when}</b>: ${signed(lv.cm)} cm NAP (${kindTxt(lv.kind)})${b && c != null && (b.mhw != null || b.underNAP != null) ? ` · doorvaarthoogte <b>${fmt(c)} m</b>` : ""}`;
}

// Gegevens voor de grafiek: uit het bestand per meetpunt, of (zolang dat laadt) uit wat de app al heeft.
function chartData(s, b) {
  if (b?.pair) {
    const now = Date.now() / 1000, est = [], pP = [], pQ = [];
    for (let m = 0; m <= 48 * 60; m += 15) {
      const t = now + m * 60, lv = bridgeLevel(b, m / 60);
      if (lv) est.push([t, lv.cm]);
      const a = stationValue(b.pair.P.code, t), q = stationValue(b.pair.Q.code, t);
      if (a && m) pP.push([t, Math.round(a.cm)]); if (q && m) pQ.push([t, Math.round(q.cm)]);
    }
    const nowLv = bridgeLevel(b, 0);
    return { meting: [], verwachting: [], astronomisch: [], schatting: est, extra: [{ name: b.pair.P.name, pts: pP, dash: "4 3" }, { name: b.pair.Q.name, pts: pQ, dash: "1 3" }],
      nowDot: nowLv ? nowLv.cm : null, meta: S.seriesCache.get(b.pair.P.code)?.data || null, full: !!(S.seriesCache.get(b.pair.P.code) && S.seriesCache.get(b.pair.Q.code)) };
  }
  const c = S.seriesCache.get(s.code)?.data;
  if (c) return { meting: c.meting?.pts || [], verwachting: c.verwachting?.pts || [], astronomisch: c.astronomisch?.pts || [], meta: c, full: true };
  const f = S.forecast[s.code];
  return {
    meting: s.cm != null && s.t ? [[Date.parse(s.t) / 1000, s.cm]] : [],
    verwachting: f?.kind === "verwachting" ? f.pts : [], astronomisch: f?.kind === "astronomisch" ? f.pts : [],
    meta: null, full: false,
  };
}
const niceStep = (range) => (range > 300 ? 100 : range > 150 ? 50 : range > 60 ? 25 : range > 25 ? 10 : 5);

function chartSVG(d, size) {
  const now = Date.now() / 1000, t0 = now - 10 * 60, t1 = now + 48 * 3600;
  const { W, H } = size, L = 38, R = 8, T = 10, B = 22;
  const recentM = d.meting.length && now - d.meting[d.meting.length - 1][0] <= 3 * 3600 ? [d.meting[d.meting.length - 1][1]] : [];
  const all = ["verwachting", "astronomisch"].flatMap((k) => d[k].filter(([t]) => t >= t0 && t <= t1).map((p) => p[1])).concat(recentM)
    .concat((d.schatting || []).map((p) => p[1])).concat((d.extra || []).flatMap((e) => e.pts.map((p) => p[1])));
  if (!all.length) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  const step = niceStep(hi - lo || 20);
  lo = Math.floor((lo - 5) / step) * step; hi = Math.ceil((hi + 5) / step) * step;
  if (hi - lo < step * 2) hi = lo + step * 2;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let g = `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="var(--chart-bg)"/>`;
  for (let v = lo; v <= hi; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  const startDay = new Date(t0 * 1000); startDay.setHours(0, 0, 0, 0);
  for (let ms = startDay.getTime(); ms <= t1 * 1000; ms += 6 * 3600e3) {
    const t = ms / 1000; if (t < t0 + 1800 || t > t1 - 1800) continue;
    const dd = new Date(ms), hr = dd.getHours(), mid = hr === 0;
    g += `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" class="grid${mid ? " day" : ""}"/>`;
    if ((mid || hr === 12 || W > 400) && x(t) - x(t0) > 34) g += `<text x="${x(t)}" y="${H - 7}" text-anchor="middle">${mid ? dd.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric" }) : String(hr).padStart(2, "0") + ":00"}</text>`;
  }
  const line = (pts, color, w, dash) => {
    const p = pts.filter(([t]) => t >= t0 && t <= t1);
    if (!p.length) return "";
    if (p.length === 1) return `<circle cx="${x(p[0][0])}" cy="${y(p[0][1])}" r="3" fill="${color}"/>`;
    return `<path d="${p.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("")}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`;
  };
  g += line(d.astronomisch, SERIES_COLORS.astronomisch, 1.6);
  for (const e of d.extra || []) g += line(e.pts, SERIES_COLORS.astronomisch, 1.2, e.dash);
  if (d.schatting) g += line(d.schatting, SERIES_COLORS.verwachting, 2.2);
  if (d.nowDot != null) g += `<circle cx="${x(t0)}" cy="${y(d.nowDot)}" r="4" fill="${SERIES_COLORS.verwachting}" stroke="#fff" stroke-width="1.5"/>`;
  g += line(d.verwachting, SERIES_COLORS.verwachting, 1.6);
  const lastM = d.meting.length ? d.meting[d.meting.length - 1] : null;
  if (lastM && now - lastM[0] <= 3 * 3600) g += `<circle cx="${x(t0)}" cy="${y(lastM[1])}" r="4" fill="${SERIES_COLORS.meting}" stroke="#fff" stroke-width="1.5"><title>Laatste meting ${signed(lastM[1])} cm</title></circle>`;
  g += `<text x="${x(t0) + 4}" y="${H - 7}" class="nowlbl">nu</text>`;
  const tSel = now + offsetH() * 3600;
  g += `<line class="selline" x1="${x(tSel)}" x2="${x(tSel)}" y1="${T}" y2="${H - B}" stroke="var(--wait)" stroke-width="2"/>`;
  g += `<g class="cross" visibility="hidden"><line class="cx" y1="${T}" y2="${H - B}"/><g class="tip"><rect rx="4"/><text class="tt"></text></g></g>`;
  g += `<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>`;
  return { svg: `<svg class="rwschart" viewBox="0 0 ${W} ${H}" width="100%" role="slider" tabindex="0" aria-label="Waterstandgrafiek: sleep of gebruik de pijltjestoetsen om een tijdstip te kiezen" aria-valuemin="0" aria-valuemax="48" aria-valuenow="${offsetH()}">${g}</svg>`, x, y, t0, t1, L, R, W, H, T, B };
}
function legendHTML(d) {
  const now = Date.now() / 1000, items = [];
  if (d.meting.length && now - d.meting[d.meting.length - 1][0] <= 3 * 3600) items.push(`<span><i class="dotkey" style="background:${SERIES_COLORS.meting}"></i>Laatste meting</span>`);
  for (const k of ["verwachting", "astronomisch"]) if (d[k].some(([t]) => t >= now)) items.push(`<span><i style="background:${SERIES_COLORS[k]}"></i>${SERIES_NAMES[k]} t.o.v. NAP in cm</span>`);
  if (d.schatting?.length) items.push(`<span><i style="background:${SERIES_COLORS.verwachting}"></i>Geschatte waterhoogte bij de brug t.o.v. NAP in cm</span>`);
  for (const e of d.extra || []) items.push(`<span><i class="dashkey" style="border-top:2px ${e.dash === "4 3" ? "dashed" : "dotted"} ${SERIES_COLORS.astronomisch}"></i>${esc(e.name)} (verwacht)</span>`);
  return `<div class="legend2">${items.join("")}</div>`;
}
function valueAt(pts, t, maxGap = 900) {
  let best = null, bd = Infinity;
  for (const p of pts) { const dd = Math.abs(p[0] - t); if (dd < bd) { bd = dd; best = p; } }
  return best && bd <= maxGap ? best[1] : null;
}
function stampsHTML(s, d) {
  const m = d.meta, f = S.forecast[s.code];
  const t = (iso) => iso ? `${new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (${ago(iso)})` : "onbekend";
  const rows = [`Laatste meting: ${s.cm != null && s.t ? t(s.t) : "geen recente meting"}`];
  if (m?.verwachting?.fetchedAt || f?.kind === "verwachting") rows.push(`Verwachting RWS opgehaald: ${t(m?.verwachting?.fetchedAt || f?.at)}`);
  if (m?.astronomisch?.fetchedAt) rows.push(`Astronomisch getij opgehaald: ${t(m.astronomisch.fetchedAt)}`);
  return `<div class="stamps">${rows.join("<br>")}</div>`;
}

export const chartBlock = (s, b) => `<div class="chartwrap" data-code="${esc(s.code)}">${chartInner(s, b, { W: 320, H: 180 })}</div>`;
function chartInner(s, b, size) {
  const d = chartData(s, b), c = chartSVG(d, size);
  if (!c) return `<div class="note">Geen meetreeks of verwachting beschikbaar voor dit meetpunt.</div>${stampsHTML(s, d)}`;
  return `${c.svg}<div class="sparkread">${sparkReadout(s, b, offsetH())}</div>${legendHTML(d)}
    <div class="chartbar"><span class="note">Tik of sleep in de grafiek voor de waarden per tijdstip.${d.full ? "" : " Meetreeks laden…"}</span><button type="button" class="btn big-btn">Vergroot</button></div>
    ${stampsHTML(s, d)}`;
}

// Werkt de doorvaarthoogte, het oordeel en de waterstandregel in de open popup bij voor het gekozen tijdstip.
function refreshPopupHead(s, b) {
  s.lvl = levelAt(s);
  if (b) { b.lvl = bridgeLevel(b); b.cur = currentClearance(b); }
  for (const el of document.querySelectorAll(".leaflet-popup .pophead")) el.innerHTML = b ? bridgeHead(b) : stationHead(s);
  if (b) for (const el of document.querySelectorAll(".leaflet-popup .popwl")) el.innerHTML = bridgeWl(b);
}
// Koppelt interactie (tooltip, tijdstip kiezen) aan een grafiek in 'root'.
function bindChart(root, s, b, size) {
  const svg = root.querySelector(".rwschart");
  if (!svg) return;
  const d = chartData(s, b), c = chartSVG(d, size);
  if (!c) return;
  const cross = svg.querySelector(".cross"), cx = svg.querySelector(".cx"), tip = svg.querySelector(".tip"), tt = svg.querySelector(".tt"), rect = tip.querySelector("rect");
  const setH = (h) => {
    h = Math.max(0, Math.min(48, h));
    if (h !== offsetH()) { $("when").value = h; updateWhen(); S.pendingRedraw = true; }
    const xs = c.x(Date.now() / 1000 + h * 3600);
    const sl = svg.querySelector(".selline"); sl.setAttribute("x1", xs); sl.setAttribute("x2", xs);
    svg.setAttribute("aria-valuenow", h);
    const rd = root.querySelector(".sparkread"); if (rd) rd.innerHTML = sparkReadout(s, b, h);
    refreshPopupHead(s, b);
  };
  const show = (t) => {
    // vastklikken op hele uren vanaf nu, zodat kader, lijn en kop hetzelfde tijdstip tonen
    const nowS = Date.now() / 1000;
    t = nowS + Math.max(0, Math.min(48, Math.round((t - nowS) / 3600))) * 3600;
    const xs = c.x(t);
    cx.setAttribute("x1", xs); cx.setAttribute("x2", xs); cross.setAttribute("visibility", "visible");
    const lines = [new Date(t * 1000).toLocaleString("nl-NL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })];
    for (const k of ["verwachting", "astronomisch"]) { const v = valueAt(d[k], t, 2400); if (v != null) lines.push(`${k === "verwachting" ? "Verwacht" : "Astronomisch"}: ${signed(v)} cm`); }
    if (d.schatting) { const v = valueAt(d.schatting, t, 1200); if (v != null) lines.push(`Bij de brug (geschat): ${signed(v)} cm`); }
    for (const e of d.extra || []) { const v = valueAt(e.pts, t, 1200); if (v != null) lines.push(`${e.name.slice(0, 22)}: ${signed(Math.round(v))} cm`); }
    tt.innerHTML = lines.map((l, i) => `<tspan x="0" dy="${i ? 13 : 0}"${i === 0 ? ' font-weight="700"' : ""}>${esc(l)}</tspan>`).join("");
    const bb = { w: Math.max(...lines.map((l) => l.length)) * 5.6 + 12, h: lines.length * 13 + 8 };
    let tx = xs + 8; if (tx + bb.w > c.W - c.R) tx = xs - 8 - bb.w;
    tx = Math.max(c.L + 2, Math.min(tx, c.W - c.R - bb.w));
    rect.setAttribute("x", -6); rect.setAttribute("y", -12); rect.setAttribute("width", bb.w); rect.setAttribute("height", bb.h);
    tip.setAttribute("transform", `translate(${tx + 6},${c.T + 16})`);
    setH(Math.round((t - Date.now() / 1000) / 3600));
  };
  const tOf = (e) => { const r = svg.getBoundingClientRect(); const vx = ((e.clientX - r.left) / r.width) * c.W; return c.t0 + ((vx - c.L) / (c.W - c.L - c.R)) * (c.t1 - c.t0); };
  let dragging = false;
  ["mousedown", "touchstart", "dblclick", "wheel"].forEach((ev) => svg.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
  svg.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); dragging = true; svg.setPointerCapture(e.pointerId); show(tOf(e)); });
  svg.addEventListener("pointermove", (e) => { if (dragging || e.pointerType === "mouse") show(tOf(e)); });
  const end = (e) => { dragging = false; try { svg.releasePointerCapture(e.pointerId); } catch {} };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", (e) => { if (!dragging && e.pointerType === "mouse") cross.setAttribute("visibility", "hidden"); });
  svg.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key];
    if (step) { e.preventDefault(); show(Date.now() / 1000 + (offsetH() + step) * 3600); }
  });
  const big = root.querySelector(".big-btn");
  if (big) big.onclick = (e) => { e.stopPropagation(); openBigChart(s, b); };
}

// Grafiek in een popup: eerst met wat er is, daarna met de volledige meetreeks.
export async function initChartIn(root, s, b) {
  const wrap = root.querySelector(".chartwrap");
  if (!wrap) return;
  const size = { W: 320, H: 180 };
  bindChart(wrap, s, b, size);
  const codes = b?.pair ? [b.pair.P.code, b.pair.Q.code] : [s.code];
  const todo = codes.filter((c) => { const x = S.seriesCache.get(c); return !x || Date.now() - x.at >= 5 * 60e3; });
  if (!todo.length) return;
  try {
    await Promise.all(todo.map(async (code) => {
      const r = await fetch(fileOf(code), { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      S.seriesCache.set(code, { data: await r.json(), at: Date.now() });
    }));
    if (b) { b.lvl = bridgeLevel(b); b.cur = currentClearance(b); refreshPopupHead(s, b); }
    if (!wrap.isConnected) return;
    wrap.innerHTML = chartInner(s, b, size);
    bindChart(wrap, s, b, size);
  } catch {
    const n = wrap.querySelector(".chartbar .note"); if (n) n.textContent = "Tik of sleep in de grafiek voor de waarden per tijdstip. Volledige meetreeks niet beschikbaar.";
  }
}

// Grote weergave (venster over de kaart).
function openBigChart(s, b) {
  const body = $("bigChartBody");
  $("bigChartTitle").textContent = s.name;
  const size = innerWidth < 700 ? { W: 520, H: 360 } : { W: 900, H: 420 };
  body.innerHTML = chartInner(s, b, size).replace('<button type="button" class="btn big-btn">Vergroot</button>', "") + `<p class="disc-inline">${DISC_SHORT}</p>`;
  bindChart(body, s, b, size);
  $("bigChart").hidden = false; $("bigChartClose").focus();
}
