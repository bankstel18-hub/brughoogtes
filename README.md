# Brughoogtes Nederland

Web-app (PWA) met de doorvaarthoogtes van bruggen in Nederland, gecorrigeerd voor de actuele waterstand op de grote wateren. Voor binnenvaart en pleziervaart.

## Hoe het werkt

| Onderdeel | Bestand | Wat het doet |
|---|---|---|
| App | `public/` | Kaart (Leaflet + PDOK), filters op kruiphoogte, vaartijdstip tot 48 uur vooruit, routecheck, bootprofielen, installeerbaar als app, werkt offline met de laatst bekende data |
| Automatische update | `.github/workflows/update.yml` | Elke 10 minuten op GitHub Actions: tests, data bijwerken, datacontrole, publiceren op GitHub Pages (zie `docs/HOSTING.md`) |
| Updatescript | `scripts/update.mjs` | Waterstanden en verwachtingen altijd, bruggen hooguit eens per ~20 uur |
| Gedeelde logica | `scripts/rws.mjs` | Ophalen en normaliseren van de RWS-data, opslag als JSON in `data/` |
| Datacontrole | `scripts/check.mjs` | Keurt nieuwe data af als die verdacht afwijkt van de vorige versie of van de testset; de vorige versie blijft dan staan |
| Routenetwerk | `scripts/routenet.mjs` | Compact vaarwegennetwerk voor de routecheck (`data/route-net.json`) |
| Tests | `tests/` | `npm test`. Ook de testset bekende bruggen: `tests/bekende-bruggen.json` |

### Opbouw van de app (`public/js/`)

| Module | Inhoud |
|---|---|
| `main.js` | Start: gegevens laden, knoppen koppelen, periodiek verversen |
| `config.js` | Instellingen die je zelf aanpast: versie, e-mail voor meldingen, waarschuwingsgrens, standaardsnelheid |
| `core.js` | Pure rekenregels: doorvaarthoogte, keuze meting of verwachting, oordeel per brug, sluiskolken (getest) |
| `route.js` | Routeplanner over het vaarwegennetwerk (getest) |
| `water.js` | Waterstand en doorvaarthoogte per brug, koppeling met meetpunten |
| `map.js` | Kaart, lagen, markeringen, koppelingslijnen, lijst "laagste bruggen" |
| `popups.js` | Popups van brug, sluis en meetpunt, contactgegevens, meldknop |
| `chart.js` | Waterstandgrafiek |
| `panel.js` | Teksten in het paneel (tijdstip, actualiteit, waarschuwing) |
| `profiles.js` | Instellingen en bootprofielen bewaren (alleen op het toestel) |
| `routeui.js` | Bediening van de routecheck |
| `locate.js` | Eigen locatie tonen en volgen |

Na een wijziging aan de app: verhoog `APP_VERSION` in `config.js` en `VERSION` in `public/sw.js`, en zet een regel in `CHANGELOG.md`. Lokaal bekijken: `npm run serve` en open `http://localhost:8080`. Met `#debug` achter het adres staan kaart en gegevens in de console als `bh`.

De data staat op GitHub Pages in `data/`: `bridges.json`, `water.json`, `forecast.json`, `stations.json`, `status.json` en `debug-*.json` (velden en voorbeelden uit de bronnen, voor onderhoud).

Handmatig bijwerken: tabblad **Actions** → **Data bijwerken en publiceren** → **Run workflow** (vink "Bruggen nu opnieuw ophalen" aan om ook de bruggen te verversen).

GitHub voert geplande workflows niet altijd precies op tijd uit; vertragingen van 5 tot 15 minuten zijn normaal.

## Databronnen (open data)

- **Bruggen en doorvaartopeningen**: Rijkswaterstaat Fairway Information Services (FIS), ArcGIS FeatureServer `GDR/fis_vnds`, licentie CC-0.
- **Waterstanden en verwachtingen**: Rijkswaterstaat WaterWebservices (DD-API 2.0), `ddapi20-waterwebservices.rijkswaterstaat.nl`.
- **Peilgebieden**: Waterschappen Waterbeheergebieden IMWA via PDOK, CC BY-SA 4.0.
- **Kaart**: PDOK BRT-achtergrondkaart (grijs en kleur) en luchtfoto; OpenSeaMap als optionele laag.

## Waterstandcorrectie

**Welk meetpunt?** Per brug zoekt `linkViaNetwork` (in `scripts/rws.mjs`) over het FIS-vaarwegennetwerk (vaarwegvakken en knooppunten) de dichtstbijzijnde RWS-meetpunten, tot 25 km over het water. Sluizen en stuwen gelden als scheiding; keersluizen en stormvloedkeringen staan normaal open en scheiden niet. Meetpunten worden op het dichtstbijzijnde vaarwegvak geplaatst (binnen 1,5 km). Per brug worden de drie dichtstbijzijnde bewaard (`sts`); de app kiest de eerste met actuele gegevens.

**Peilgebieden als extra scheiding.** Niet elke sluis of kering staat als scheiding in het netwerk. Daarom toetst `scripts/peil.mjs` elke koppeling ook op het peil van het water (eens per dag berekend, opgeslagen in `data/peil.json`):
1. FIS-lagen *streefpeil* (50) en *getijdegebied* (198) langs de vaarweg: hebben brug en meetpunt allebei een label, dan moeten die gelijk zijn (getij met getij, of hetzelfde streefpeil). Een meetpunt zonder label maar met duidelijk getij in de metingen (> 20 cm schommeling) telt als getij.
2. Peilgebieden van de waterschappen (PDOK, *Waterschappen Waterbeheergebieden IMWA*, CC BY-SA 4.0): alleen als FIS niet beslist en beide punten volledig binnendijks liggen, moeten ze in hetzelfde peilgebied liggen. Buitendijks gebruiken we ze niet, omdat sommige waterschappen open rivieren in stukken verdelen.
Punten worden eerst op de vaarweg gezet, zodat ze op het water liggen en niet op de kade.

**Omrekenen.** Alleen bij een NAP-referentie:
- rivierbruggen (`mhwreferencelevel` RIVER): onderkant = `clearanceheightclosed + mhwoffset` (= `heightclosed`, getoetst bij 299 van 306)
- overige bruggen en kunstwerken met `referencelevel` NAP: onderkant = `heightclosed`
- actuele doorvaarthoogte = onderkant − waterstand

Bij kanaal-, meer-, streef- of polderpeil, of een onbekend referentiepeil, wordt niet omgerekend; de app toont dan wel de waterstand van het gekoppelde meetpunt met uitleg.

## Routecheck

De app laadt `data/route-net.json` (of anders `data/network.json`) pas als je een route kiest. `route.js` zoekt met Dijkstra de kortste weg over de FIS-vaarwegvakken. Bruggen worden op de route geplaatst via hun eigen vak (`sec`), sluizen via `fairwaysectionid` of het dichtstbijzijnde vak. Per brug rekent de app het verwachte tijdstip van aankomst uit (vaartijdstip plus afstand gedeeld door snelheid) en gebruikt de waterstand op dat moment. De route houdt geen rekening met vaarwegklassen, bedientijden of stremmingen.

## Testset bekende bruggen

`tests/bekende-bruggen.json` bevat bruggen waarvan de hoogte zeker is. Bij elke update controleert `scripts/check.mjs` of de data daar nog mee klopt. Voeg bruggen toe met een hoogte van de hoogteschaal of van vaarweginformatie.nl. Hoe, staat bovenin het bestand. Vijftien tot dertig bruggen, verspreid over rivieren, kanalen en getijdewater, geven een goed vangnet.

## Onderhoud

`data/debug-bridges.json`, `data/debug-water.json` en `data/debug-forecast.json` tonen de veldnamen en voorbeelden uit de bronnen. Verandert Rijkswaterstaat iets aan de data, dan is dat de eerste plek om te kijken. Veldherkenning staat in `scripts/rws.mjs` (`RE_CLOSED`, `RE_OPEN`, `RE_UNDER_NAP`, `RE_REF_NAP`).

## Disclaimer

Hulpmiddel, geen officiële vaarweginformatie. Controleer altijd de hoogteschaal bij de brug en de officiële bronnen.
