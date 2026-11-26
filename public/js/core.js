// Pure rekenfuncties, zonder kaart of pagina. Worden gebruikt door de app én door de tests (tests/*.test.mjs).
// Wijzig je hier iets, draai dan `npm test`.

export const WATER_MAX_AGE_H = 3;       // oudere metingen gebruiken we nooit voor de correctie
export const MEAS_FRESH_MIN = 30;       // meting jonger dan dit: altijd de meting; ouder: liever de verwachting voor nu
export const KEEL = 0.10;               // minimale ruimte onder de kiel boven de drempel van een sluis

/* ---------- opmaak ---------- */
export const fmt = (v) => (v == null ? "?" : v >= 90 ? "∞" : v.toFixed(2));
export const signed = (cm) => `${cm > 0 ? "+" : ""}${cm}`;
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const m2 = (v) => (v == null ? "–" : v.toFixed(v < 10 ? 2 : 1).replace(".", ","));
export const kmTxt = (v) => v.toFixed(1).replace(".", ",");

/* ---------- afstand ---------- */
export function km(lat1, lng1, lat2, lng2) {
  const R = 6371, r = Math.PI / 180, x = (lng2 - lng1) * r * Math.cos(((lat1 + lat2) / 2) * r), y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * R;
}

/* ---------- reeksen interpoleren ---------- */
// pts: [[tijd in s, cm], ...] oplopend. Buiten de reeks (met 1 uur speling) geen waarde.
export function interp(pts, tSec) {
  if (!pts || !pts.length || tSec < pts[0][0] - 3600 || tSec > pts[pts.length - 1][0] + 3600) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [t1, v1] = pts[i], [t2, v2] = pts[i + 1];
    if (tSec >= t1 && tSec <= t2) return Math.round(v1 + ((v2 - v1) * (tSec - t1)) / (t2 - t1));
  }
  return tSec < pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
}
// Als interp, maar zonder afronden en zonder waarde over een gat groter dan maxGap seconden.
export function interpPts(pts, t, maxGap = 3 * 3600) {
  if (!pts || !pts.length) return null;
  if (t < pts[0][0] - maxGap || t > pts[pts.length - 1][0] + maxGap) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [t1, v1] = pts[i], [t2, v2] = pts[i + 1];
    if (t >= t1 && t <= t2) return t2 - t1 > maxGap ? null : v1 + ((v2 - v1) * (t - t1)) / (t2 - t1);
  }
  return t < pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
}

/* ---------- welke waterstand gebruiken we? ---------- */
// meas: { cm, t } laatste meting · fc: { kind, pts } verwachting · h: uren vooruit · nowMs: nu
// - "nu" en een verse meting (< 30 min): de meting
// - anders de verwachting voor het gekozen tijdstip (bij getij is een uur oude meting al te ver af)
// - geen verwachting, "nu" en een meting tot 3 uur oud: die meting
export function pickLevel(meas, fc, h, nowMs = Date.now()) {
  const ageH = meas?.cm != null && meas.t ? (nowMs - Date.parse(meas.t)) / 3600e3 : Infinity;
  if (h === 0 && ageH * 60 <= MEAS_FRESH_MIN) return { cm: meas.cm, t: meas.t, kind: "meting" };
  if (fc?.pts?.length) {
    const tMs = nowMs + h * 3600e3, v = interp(fc.pts, tMs / 1000);
    if (v != null) return { cm: v, t: new Date(tMs).toISOString(), kind: fc.kind };
  }
  if (h === 0 && ageH <= WATER_MAX_AGE_H) return { cm: meas.cm, t: meas.t, kind: "meting" };
  return null;
}

/* ---------- doorvaarthoogte ---------- */
// Alleen omrekenen bij een NAP-referentie. cm = waterstand in cm NAP.
export function clearanceFor(b, cm) {
  if (cm == null || !isFinite(cm)) return null;
  const w = cm / 100;
  if (b.underNAP != null) return +(b.underNAP - w).toFixed(2);
  if (b.closed != null && b.refNAP != null) return +(b.closed - (w - b.refNAP)).toFixed(2);
  return null;
}
// Open stand: gecorrigeerd als de gesloten stand gecorrigeerd is.
export function openClearance(b, cur, cm) {
  if (b.open == null) return null;
  if (cur == null) return b.open;
  if (b.openUnderNAP != null && cm != null) return +(b.openUnderNAP - cm / 100).toFixed(2);
  return b.closed != null ? +(b.open + (cur - b.closed)).toFixed(2) : b.open;
}
// Oordeel: ok (past), wait (brug moet open), bad (te laag), unk (onbekend).
export function verdict(closed, open, movable, need) {
  if (closed == null && open == null) return "unk";
  if (closed != null && closed >= need) return "ok";
  if (movable) return open == null || open >= need ? "wait" : "bad";
  return closed == null ? "unk" : "bad";
}

/* ---------- sluizen ---------- */
// d: { L, B, T } schip · need: kruiphoogte incl. marge
export function chamberCheck(c, d, need, keel = KEEL) {
  const why = [];
  if (c.length == null && c.width == null) return { s: "unk", why: ["afmetingen onbekend"] };
  if (c.length != null && d.L > c.length) why.push(`te lang (${m2(c.length)} m)`);
  if (c.width != null && d.B > c.width) why.push(`te breed (${m2(c.width)} m)`);
  if (c.sill != null && d.T + keel > c.sill) why.push(`te diep (drempel ${m2(c.sill)} m)`);
  if (c.height != null && need > c.height) why.push(`te hoog (${m2(c.height)} m)`);
  return { s: why.length ? "bad" : "ok", why };
}
export function lockVerdict(chambers, d, need) {
  if (!chambers?.length) return "unk";
  const st = chambers.map((c) => chamberCheck(c, d, need).s);
  return st.includes("ok") ? "ok" : st.every((x) => x === "unk") ? "unk" : "bad";
}

/* ---------- contactgegevens uit de FIS-velden ---------- */
// FIS levert per brug of sluis wisselende velden; we zoeken telefoon en marifoonkanaal op naam.
export function contactInfo(a = {}) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === "") continue;
    if (!out.phone && /phone|telefoon|tel(nr|nummer)?$/i.test(k) && /\d{6,}/.test(String(v).replace(/\D/g, ""))) out.phone = String(v).trim();
    else if (!out.vhf && /vhf|marifoon|radiochannel|channel|kanaal/i.test(k) && /^\s*(vhf\s*)?\d{1,2}\s*$/i.test(String(v))) out.vhf = String(v).replace(/\D/g, "");
  }
  return out;
}
