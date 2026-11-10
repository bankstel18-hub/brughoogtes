# Brughoogtes Nederland

Web-app (PWA) met de doorvaarthoogtes van bruggen in Nederland, gecorrigeerd voor de actuele waterstand op de grote wateren. Voor binnenvaart en pleziervaart.

## Hoe het werkt

| Onderdeel | Bestand | Wat het doet |
|---|---|---|
| App | `public/` | Kaart (Leaflet + PDOK), filters op kruiphoogte, vaartijdstip tot 48 uur vooruit, installeerbaar als app, werkt offline met de laatst bekende data |
| Automatische update | `.github/workflows/update.yml` | Draait elke 10 minuten op GitHub Actions en publiceert de app met verse data op GitHub Pages |
| Updatescript | `scripts/update.mjs` | Waterstanden en verwachtingen altijd, bruggen hooguit eens per ~20 uur |
| Gedeelde logica | `scripts/rws.mjs` | Ophalen en normaliseren van de RWS-data, opslag als JSON in `data/` |

De data staat op GitHub Pages in `data/`: `bridges.json`, `water.json`, `forecast.json`, `stations.json`, `status.json` en `debug-*.json` (velden en voorbeelden uit de bronnen, voor onderhoud).

Handmatig bijwerken: tabblad **Actions** → **Data bijwerken en publiceren** → **Run workflow** (vink "Bruggen nu opnieuw ophalen" aan om ook de bruggen te verversen).

GitHub voert geplande workflows niet altijd precies op tijd uit; vertragingen van 5 tot 15 minuten zijn normaal.

## Databronnen (open data)

- **Bruggen en doorvaartopeningen**: Rijkswaterstaat Fairway Information Services (FIS), ArcGIS FeatureServer `GDR/fis_vnds`, licentie CC-0.
- **Waterstanden en verwachtingen**: Rijkswaterstaat WaterWebservices (DD-API 2.0), `ddapi20-waterwebservices.rijkswaterstaat.nl`.
- **Kaart**: PDOK BRT-achtergrondkaart en luchtfoto, OpenStreetMap, OpenSeaMap.

## Waterstandcorrectie

**Welk meetpunt?** Per brug zoekt `linkViaNetwork` (in `scripts/rws.mjs`) over het FIS-vaarwegennetwerk (vaarwegvakken en knooppunten) de dichtstbijzijnde RWS-meetpunten, tot 25 km over het water. Sluizen en stuwen gelden als scheiding; keersluizen en stormvloedkeringen staan normaal open en scheiden niet. Meetpunten worden op het dichtstbijzijnde vaarwegvak geplaatst (binnen 1,5 km). Per brug worden de drie dichtstbijzijnde bewaard (`sts`); de app kiest de eerste met actuele gegevens.

**Omrekenen.** Alleen bij een NAP-referentie:
- rivierbruggen (`mhwreferencelevel` RIVER): onderkant = `clearanceheightclosed + mhwoffset` (= `heightclosed`, getoetst bij 299 van 306)
- overige bruggen en kunstwerken met `referencelevel` NAP: onderkant = `heightclosed`
- actuele doorvaarthoogte = onderkant − waterstand

Bij kanaal-, meer-, streef- of polderpeil, of een onbekend referentiepeil, wordt niet omgerekend; de app toont dan wel de waterstand van het gekoppelde meetpunt met uitleg.

## Onderhoud

`data/debug-bridges.json`, `data/debug-water.json` en `data/debug-forecast.json` tonen de veldnamen en voorbeelden uit de bronnen. Verandert Rijkswaterstaat iets aan de data, dan is dat de eerste plek om te kijken. Veldherkenning staat in `scripts/rws.mjs` (`RE_CLOSED`, `RE_OPEN`, `RE_UNDER_NAP`, `RE_REF_NAP`).

## Disclaimer

Hulpmiddel, geen officiële vaarweginformatie. Controleer altijd de hoogteschaal bij de brug en de officiële bronnen.
