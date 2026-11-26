// Teksten in het paneel: vaartijdstip, actualiteit van de gegevens, waarschuwing bij oude data.
import { S, $, offsetH, targetMs, timeNL, ago, setStatus } from "./state.js";
import { STALE_WARN_MIN } from "./config.js";

export function updateWhen() {
  const h = offsetH();
  $("whenOut").textContent = h === 0 ? "Nu" : `+${h} u · ${timeNL(new Date(targetMs()).toISOString())}`;
  $("whenNote").textContent = h === 0
    ? "Actuele waterstand. Schuif om de verwachting van Rijkswaterstaat te gebruiken."
    : `Verwachte waterstand ${new Date(targetMs()).toLocaleString("nl-NL", { weekday: "long", hour: "2-digit", minute: "2-digit" })}. Bruggen zonder verwachting in de buurt worden niet gecorrigeerd.`;
}

export function staleCheck(refreshing) {
  if (refreshing) return;
  const w = S.meta.waterAt ? (Date.now() - Date.parse(S.meta.waterAt)) / 60000 : Infinity;
  const el = $("staleWarn");
  if (w > STALE_WARN_MIN) {
    el.hidden = false;
    el.textContent = isFinite(w)
      ? `Let op: de waterstanden zijn ${w < 120 ? Math.round(w) + " minuten" : Math.round(w / 60) + " uur"} oud. Vertrouw er niet op en controleer de actuele situatie.`
      : "Let op: er zijn geen actuele waterstanden beschikbaar. Hoogtes zijn niet gecorrigeerd.";
  } else el.hidden = true;
}

export function fresh() {
  staleCheck(false);
  const { meta, bridges, stations, forecast, locks } = S;
  const parts = [meta.waterAt ? `Waterstanden ${ago(meta.waterAt)}` : "Geen actuele waterstanden"];
  if (meta.forecastAt) parts.push(`verwachting ${ago(meta.forecastAt)}`);
  if (meta.bridgesAt) parts.push(`bruggen ${ago(meta.bridgesAt)}`);
  $("freshness").textContent = parts.join(" · ");
  const corrected = bridges.filter((b) => b.cur != null).length;
  setStatus(`${bridges.length.toLocaleString("nl-NL")} bruggen, ${stations.filter((s) => s.cm != null).length} meetpunten met actuele waterstand, ${Object.keys(forecast).length} met verwachting, ${locks.length.toLocaleString("nl-NL")} sluizen, ${corrected.toLocaleString("nl-NL")} bruggen gecorrigeerd voor waterstand.`);
}
