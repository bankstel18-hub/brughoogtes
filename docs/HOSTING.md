# Hosting

## Hoe het nu werkt (sinds versie 2026.11.26)

De app en de data staan op **GitHub Pages**. Een **GitHub Actions**-workflow (`.github/workflows/update.yml`) haalt de gegevens op bij Rijkswaterstaat en publiceert ze. Stap voor stap:

1. **Tests** van de rekenregels en de routeplanner (`npm test`). Mislukt dat, dan wordt er niets gepubliceerd.
2. **Vorige data ophalen** van de live site en apart bewaren (`_prev`).
3. **Data bijwerken** bij Rijkswaterstaat (`scripts/update.mjs`).
4. **Datacontrole** (`scripts/check.mjs`): nieuwe data tegen de vorige versie en tegen de testset `tests/bekende-bruggen.json`. Afgekeurd: de vorige versie blijft staan.
5. **Publiceren** op GitHub Pages.

### Wat is er veranderd

Eerder startte elke run na 9 minuten wachten zelf de volgende run (job `volgende`). Daardoor draaide GitHub Actions eigenlijk de klok rond. GitHub Actions is bedoeld voor bouwen, testen en publiceren van software, niet als server die altijd aan staat. Zo'n constructie kan GitHub beperken. Die keten is weg. Nu start alleen het gewone schema (`cron: */10 * * * *`).

**Gevolg:** GitHub voert geplande runs niet altijd op tijd uit. Vaak zit er 10 tot 30 minuten tussen, soms meer. De app vangt dat zo op:

- Voor "nu" gebruikt de app de meting alleen als die jonger is dan 30 minuten. Is hij ouder, dan neemt de app de verwachting van Rijkswaterstaat voor dit moment. Bij getij is een meting van een uur oud al te ver af. Dit staat in `public/js/core.js` (`pickLevel`) en wordt getest.
- Bij waterstanden ouder dan 45 minuten verschijnt er een waarschuwing in beeld. Dat stel je in met `STALE_WARN_MIN` in `public/js/config.js`.

### Als er iets misgaat

- **Rode run met de melding "datacontrole"**: open de run in het tabblad *Actions* en kijk bij de stap *Datacontrole* wat er is afgekeurd. De vorige brugdata blijft gewoon in de app staan. Na ongeveer 2 uur probeert de workflow de bruggen opnieuw op te halen.
- **Rode run met de melding "Tests"**: er is iets aan de app-code veranderd waardoor een rekenregel niet meer klopt. De live app blijft op de vorige versie staan tot dat opgelost is.
- Het rapport van de laatste controle staat ook online: `data/check.json`.

## Later: een eigen server (voor een bedrijf)

Als je de app commercieel wilt aanbieden, raad ik een kleine eigen server aan in plaats van GitHub Actions:

- **Wat:** een kleine virtuele server (VPS) bij een Europese aanbieder. Die kost een paar euro per maand en dat is ruim genoeg.
- **Hoe:** dezelfde scripts draaien elke 5 tot 10 minuten via `cron` op de server. De map met data wordt door een eenvoudige webserver (bijvoorbeeld Caddy) aangeboden. De app zelf kan op GitHub Pages blijven staan, of ook op de server.
- **Voordelen:** updates precies op tijd, geen afhankelijkheid van de regels van GitHub, en ruimte voor extra's zoals pushmeldingen of een database met meldingen van gebruikers.

Over Cloudflare Workers, dat ik eerder noemde: het gratis tarief geeft per run maar heel weinig rekentijd. Het koppelen van alle bruggen aan meetpunten via het vaarwegennetwerk past daar niet in. Een VPS is voor dit soort werk eenvoudiger en voorspelbaarder.
