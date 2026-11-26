// Inhoud van de popups voor bruggen, sluizen en meetpunten.
import { S, colorOf, useWater, whenTxt, tsNL, ago, need, dims } from "./state.js";
import { esc, fmt, signed, m2, kmTxt, chamberCheck, lockVerdict, contactInfo, KEEL } from "./core.js";
import { effClosed, effOpen, state, minAhead } from "./water.js";
import { chartBlock, kindTxt } from "./chart.js";
import { DISC_SHORT, FEEDBACK_EMAIL, GITHUB_REPO, APP_VERSION } from "./config.js";

const REF = { KP: "kanaalpeil", NAP: "NAP", MP: "meerpeil", SP: "streefpeil", PP: "polderpeil", BP: "boezempeil", UNSPECIFIED: "een onbekend referentiepeil" };
export const refTxt = (b) => b.mhw != null
  ? `bij maatgevend hoogwater (${signed(Math.round(b.mhw * 100))} cm NAP)`
  : `t.o.v. ${REF[b.refName] || b.refName || "referentiepeil"}`;
export const lockState = (l) => lockVerdict(l.chambers, dims(), need());
const fmtTime = (t) => new Date(t * 1000).toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/* ---------- melden: klopt er iets niet? ---------- */
export function feedbackLink(kind, o, shown) {
  const subject = `Melding ${kind}: ${o.name}`;
  const body = [
    `Wat klopt er niet? (bijv. "hoogteschaal gaf 3,10 m bij waterstand ..."):`, "", "",
    "---- automatisch ingevuld ----",
    `${kind}: ${o.name}${o.waterway || o.place ? " (" + (o.waterway || o.place) + ")" : ""}`,
    `FIS-id: ${o.id ?? "onbekend"}`,
    `Locatie: ${o.lat?.toFixed(5)}, ${o.lng?.toFixed(5)}`,
    shown ? `Getoond in de app: ${shown}` : "",
    `Tijdstip: ${new Date().toLocaleString("nl-NL")}`,
    `App-versie: ${APP_VERSION}`,
  ].filter((x) => x !== "").join("\n");
  const href = FEEDBACK_EMAIL
    ? `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : `https://github.com/${GITHUB_REPO}/issues/new?labels=foutmelding&title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `<a class="report" href="${esc(href)}" target="_blank" rel="noopener">Klopt er iets niet? Meld het</a>`;
}
function contactHTML(a, phoneFallback) {
  const c = contactInfo(a);
  const phone = c.phone || phoneFallback;
  if (!phone && !c.vhf) return "";
  return `<div class="contact">${c.vhf ? `<span>Marifoon <b>VHF ${esc(c.vhf)}</b></span>` : ""}${phone ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}">☎ ${esc(phone)}</a>` : ""}</div>`;
}

/* ---------- bruggen ---------- */
export function bridgeHead(b) {
  const s = state(b), c = effClosed(b), o = effOpen(b);
  const label = { ok: "Je past eronderdoor", wait: "Brug moet open voor jou", bad: "Te laag voor jouw schip", unk: "Hoogte onbekend" }[s];
  const usingCur = useWater() && b.cur != null;
  return `<div style="margin:6px 0"><span class="big">${fmt(c)} m</span> ${b.movable ? "gesloten" : "doorvaarthoogte"}${usingCur ? ` (${whenTxt()})` : ""}
    ${b.movable ? `<br><span class="mid">${o != null ? fmt(o) + " m" : "onbeperkt of onbekend"}</span> open` : ""}</div>
    <div style="font-weight:700;color:${colorOf(s)}">${label}</div>`;
}
function pairTxt(b) {
  const p = b.pair, t = Math.abs(Math.round(p.tau));
  const first = p.tau >= 0 ? p.P : p.Q, second = p.tau >= 0 ? p.Q : p.P;
  return `tussen ${esc(p.P.name)} (${kmTxt(p.dP)} km) en ${esc(p.Q.name)} (${kmTxt(p.dQ)} km), over het water`
    + (p.lagKnown ? (t >= 5 ? `. De golf doet ${t} minuten over ${esc(first.name)} naar ${esc(second.name)}; daarmee is rekening gehouden.` : ". De waterstand loopt bij beide meetpunten vrijwel gelijk op.")
      : ". Beide waterstanden variëren nauwelijks, daarom naar afstand gewogen.");
}
export function bridgeWl(b) {
  const lv = b.lvl, mn = minAhead(b);
  if (!lv) return `<div class="wl">Geen waterstand beschikbaar voor ${whenTxt()}${b.st ? ` bij ${esc(b.st.name)}` : ""}.</div>`;
  const minRow = mn ? `<br>Laagste verwachte hoogte komende 48 uur: <b>${fmt(mn.c)} m</b> op ${fmtTime(mn.t)}` : "";
  if (b.pair && lv.kind === "schatting") {
    return `<div class="wl">Geschatte waterstand bij de brug ${whenTxt()}: <b>${signed(lv.cm)} cm NAP</b><br><span class="small">${pairTxt(b)}</span>`
      + (b.cur != null
        ? `<br>Doorvaarthoogte ${whenTxt()}: <b>${fmt(b.cur)} m</b> (${refTxt(b)}: ${fmt(b.closed)} m)${minRow}`
        : `<br>Het referentiepeil van deze hoogte is niet NAP of ontbreekt in de brondata. Daarom is niet omgerekend.`)
      + `<br><span class="small">Dit is een schatting uit twee meetpunten en kan lokaal afwijken.</span></div>`;
  }
  const where = b.stNet ? `${kmTxt(b.stKm)} km over het water, open verbinding` : `${kmTxt(b.stKm)} km hemelsbreed`;
  return `<div class="wl">Waterstand ${esc(b.st.name)} (${where}), ${kindTxt(lv.kind)} ${whenTxt()}: <b>${signed(lv.cm)} cm NAP</b>`
    + (b.cur != null
      ? `<br>Doorvaarthoogte ${whenTxt()}: <b>${fmt(b.cur)} m</b> (${refTxt(b)}: ${fmt(b.closed)} m)${minRow}`
      : `<br>${b.mhw == null && b.refName && b.refName !== "UNSPECIFIED" ? `De hoogte van deze brug geldt ${refTxt(b)}, een geregeld peil. Daarom wordt niet gecorrigeerd met meetpunten van Rijkswaterstaat.` : "Het referentiepeil van deze hoogte ontbreekt in de brondata van Rijkswaterstaat. Daarom is niet omgerekend; vergelijk de waterstand zelf met de hoogteschaal ter plaatse."}`)
    + `</div>`;
}
export function popupBridge(b) {
  const usingCur = useWater() && b.cur != null;
  const rows = Object.entries(b.a || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  let wl = "";
  if (b.lvl) wl = `<div class="popwl">${bridgeWl(b)}</div>${chartBlock(b.st || b.pair.P, b)}`;
  else if (Array.isArray(b.sts) && (b.underNAP != null || b.mhw != null)) {
    wl = `<div class="wl">Geen meetpunt van Rijkswaterstaat met actuele gegevens binnen 25 km over het water zonder sluis of stuw ertussen. De hoogte is daarom niet omgerekend.</div>`;
  }
  const shown = `${fmt(effClosed(b))} m ${b.movable ? "gesloten" : "doorvaarthoogte"} (${usingCur ? "gecorrigeerd, " + whenTxt() : refTxt(b)})${b.lvl ? `, waterstand ${signed(b.lvl.cm)} cm NAP` : ""}`;
  return `<div class="pop"><h3>${esc(b.name)}</h3>
    ${b.waterway ? `<div class="note" style="margin:0">${esc(b.waterway)}</div>` : ""}
    <div class="pophead">${bridgeHead(b)}</div>
    <div class="note">${b.movable ? "Beweegbare brug" : "Vaste brug"} · hoogte ${refTxt(b)} · bron: Rijkswaterstaat FIS</div>
    ${b.movable ? `${contactHTML(b.a)}<div class="note">Bedientijden en stremmingen: <a href="https://www.vaarweginformatie.nl" target="_blank" rel="noopener">vaarweginformatie.nl</a></div>` : ""}
    ${wl}
    <details><summary>Alle gegevens</summary><table>${rows}</table></details>
    <div class="note">${usingCur ? "Gecorrigeerd met het dichtstbijzijnde meetpunt; lokaal kan de waterstand afwijken, en een verwachting is geen garantie." : `Hoogte ${refTxt(b)}. Controleer ter plaatse de hoogteschaal.`}</div>
    <div class="stamps">Brugdata Rijkswaterstaat FIS: ${tsNL(S.meta.bridgesAt)}</div>
    ${feedbackLink("brug", b, shown)}
    <p class="disc-inline">${DISC_SHORT}</p></div>`;
}

/* ---------- sluizen ---------- */
export function popupLock(l) {
  const d = dims(), n = need();
  const hasH = l.chambers.some((x) => x.height);
  const rows = l.chambers.map((c) => {
    const ck = chamberCheck(c, d, n);
    return `<tr><td>${esc(c.name)}${ck.why.length && ck.s === "bad" ? `<div class="note" style="margin:0">${esc(ck.why.join(", "))}</div>` : ""}</td><td>${m2(c.length)}</td><td>${m2(c.width)}</td><td>${m2(c.sill)}</td>${hasH ? `<td>${m2(c.height)}</td>` : ""}<td class="${ck.s}">${ck.s === "ok" ? "✓" : ck.s === "bad" ? "✗" : "?"}</td></tr>`;
  }).join("");
  const st = lockState(l);
  const verdictTxt = { ok: "Je schip past in deze sluis", bad: "Je schip past in geen enkele kolk", unk: "Onbekend of je schip past" }[st];
  return `<div class="pop"><h3>${esc(l.name)}</h3>
    ${l.place ? `<div class="note" style="margin:0">${esc(l.place)}</div>` : ""}
    <div style="font-weight:700;margin-top:6px;color:${colorOf(st)}">${verdictTxt}</div>
    <div class="note" style="margin:0">Jouw schip: ${m2(d.L)} × ${m2(d.B)} m, diepgang ${m2(d.T)} m (+${m2(KEEL)} m onder de kiel), kruiphoogte ${m2(n)} m incl. marge</div>
    ${l.chambers.length ? `<table class="ch"><thead><tr><th>Kolk</th><th>Lengte</th><th>Breedte</th><th>Drempel</th>${hasH ? "<th>Hoogte</th>" : ""}<th>Past</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note">In meters. Drempeldiepte t.o.v. het peil, de ondiepste van boven- en benedenhoofd.${hasH ? " Hoogte: doorvaarthoogte onder een hefdeur of vaste overspanning." : ""}</div>`
      : `<div class="note">Geen kolkafmetingen in de brondata.</div>`}
    ${contactHTML(l.a, l.phone)}
    <details><summary>Alle gegevens</summary><table>${Object.entries(l.a || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></details>
    <div class="note">Bron: Rijkswaterstaat FIS. Controleer bedientijden en actuele stremmingen op <a href="https://www.vaarweginformatie.nl" target="_blank" rel="noopener">vaarweginformatie.nl</a>.</div>
    <div class="stamps">Sluisdata Rijkswaterstaat FIS: ${tsNL(S.meta.locksAt)}</div>
    ${feedbackLink("sluis", l, verdictTxt)}
    <p class="disc-inline">${DISC_SHORT}</p></div>`;
}

/* ---------- meetpunten ---------- */
export function stationHead(s) {
  const lv = s.lvl;
  return `<div style="margin:6px 0"><span class="big">${lv ? signed(lv.cm) + " cm" : "–"}</span> NAP ${lv ? `<span class="note">${kindTxt(lv.kind)} ${whenTxt()}</span>` : ""}</div>`;
}
export function popupStation(s) {
  return `<div class="pop"><h3>${esc(s.name)}</h3><div class="note" style="margin:0">Meetpunt Rijkswaterstaat · ${esc(s.code)}</div>
    <div class="pophead">${stationHead(s)}</div>
    <div class="note">Laatste meting: ${s.cm != null ? `${signed(s.cm)} cm om ${new Date(s.t).toLocaleString("nl-NL")} (${ago(s.t)})` : "geen"}</div>
    ${chartBlock(s)}<p class="disc-inline">${DISC_SHORT}</p></div>`;
}
