// Instellingen bewaren en bootprofielen: meerdere schepen opslaan en snel wisselen.
// Alles blijft op het toestel (localStorage).
import { $, ls } from "./state.js";

const FIELDS = ["boatH", "margin", "boatL", "boatB", "boatT"];
const KEY_SETTINGS = "bh-settings", KEY_PROFILES = "bh-profiles";
const profiles = () => ls.get(KEY_PROFILES) || [];

export function restoreSettings() {
  const s = ls.get(KEY_SETTINGS) || {};
  if (s.boat) { $("boatH").value = s.boat; $("boatR").value = s.boat; }
  if (s.margin != null) $("margin").value = s.margin;
  for (const k of ["boatL", "boatB", "boatT"]) if (s[k] != null && s[k] !== "") $(k).value = s[k];
  for (const k of ["useWater", "showStations", "showLocks", "showLinks"]) if (typeof s[k] === "boolean") $(k).checked = s[k];
  if (s.speed) $("routeSpeed").value = s.speed;
  fillProfiles(s.profile || "");
}
export function saveSettings() {
  ls.set(KEY_SETTINGS, {
    boat: $("boatH").value, margin: $("margin").value, boatL: $("boatL").value, boatB: $("boatB").value, boatT: $("boatT").value,
    useWater: $("useWater").checked, showStations: $("showStations").checked, showLocks: $("showLocks").checked, showLinks: $("showLinks").checked,
    speed: $("routeSpeed").value, profile: $("profile").value,
  });
}

function fillProfiles(active) {
  const sel = $("profile"), list = profiles();
  sel.textContent = "";
  sel.append(new Option(list.length ? "Kies een opgeslagen schip…" : "Nog geen schepen opgeslagen", ""));
  for (const p of list) sel.append(new Option(p.name, p.name));
  sel.value = list.some((p) => p.name === active) ? active : "";
  $("profDel").disabled = !sel.value;
}

// Na het aanpassen van een maat: profiel loslaten als de waarden niet meer overeenkomen.
export function checkProfileMatch() {
  const p = profiles().find((x) => x.name === $("profile").value);
  if (p && FIELDS.some((k) => String(p[k]) !== String($(k).value))) { $("profile").value = ""; $("profDel").disabled = true; }
}

export function initProfiles(onChange) {
  $("profile").addEventListener("change", () => {
    const p = profiles().find((x) => x.name === $("profile").value);
    $("profDel").disabled = !p;
    if (!p) return;
    for (const k of FIELDS) if (p[k] != null) $(k).value = p[k];
    $("boatR").value = $("boatH").value;
    onChange();
  });
  $("profSave").addEventListener("click", () => {
    const cur = $("profile").value;
    const name = (prompt("Naam van dit schip (bijv. 'Eigen boot' of 'MS Johanna'):", cur) || "").trim().slice(0, 40);
    if (!name) return;
    const list = profiles().filter((p) => p.name !== name);
    list.push(Object.fromEntries([["name", name], ...FIELDS.map((k) => [k, $(k).value])]));
    list.sort((a, b) => a.name.localeCompare(b.name, "nl"));
    ls.set(KEY_PROFILES, list);
    fillProfiles(name);
    saveSettings();
  });
  $("profDel").addEventListener("click", () => {
    const name = $("profile").value;
    if (!name || !confirm(`Schip '${name}' verwijderen?`)) return;
    ls.set(KEY_PROFILES, profiles().filter((p) => p.name !== name));
    fillProfiles("");
    saveSettings();
  });
}
