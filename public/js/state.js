// Gedeelde toestand van de app en de instellingen uit het paneel.
export const $ = (id) => document.getElementById(id);
export const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const S = {
  bridges: [], stations: [], forecast: {}, lags: {}, locks: [],
  meta: { bridgesAt: null, waterAt: null, forecastAt: null, locksAt: null },
  stationByCode: new Map(),
  seriesCache: new Map(),       // meetpuntcode -> { data, at }
  typeFilter: "all",
  drawn: [],
  pendingRedraw: false,
  route: null,                  // actieve route (zie routeui.js)
};

/* ---------- instellingen uit het paneel ---------- */
export const num = (id) => parseFloat($(id).value) || 0;
export const need = () => num("boatH") + num("margin");                  // kruiphoogte incl. marge
export const dims = () => ({ L: num("boatL"), B: num("boatB"), T: num("boatT") });
export const offsetH = () => +$("when").value || 0;                       // uren vooruit
export const targetMs = () => Date.now() + offsetH() * 3600e3;
export const useWater = () => $("useWater").checked;

export const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const colorOf = (s) => css({ ok: "--ok", wait: "--wait", bad: "--bad", unk: "--unk" }[s]);

/* ---------- tijd ---------- */
export const ago = (iso) => {
  if (!iso) return "onbekend";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "zojuist"; if (m < 60) return `${m} min geleden`;
  const h = Math.round(m / 60); if (h < 48) return `${h} uur geleden`;
  return new Date(iso).toLocaleDateString("nl-NL");
};
export const timeNL = (iso) => new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
export const tsNL = (iso) => iso ? `${new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (${ago(iso)})` : "onbekend";
export const whenTxt = (h = offsetH()) => (h === 0 ? "nu" : `om ${timeNL(new Date(Date.now() + h * 3600e3).toISOString())}`);

export function setStatus(t, err) { const s = $("status"); s.textContent = t; s.classList.toggle("err", !!err); }
