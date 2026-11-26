# Wijzigingslog

Per versie wat er veranderd is. Het versienummer staat in `public/js/config.js` (`APP_VERSION`) en onderaan het paneel in de app.
Na een wijziging aan de app: `APP_VERSION` aanpassen, `VERSION` in `public/sw.js` verhogen en hier een regel toevoegen.

## 2026.11.26

**Betrouwbaarheid**
- Automatische tests (`npm test`) voor de omrekening van doorvaarthoogtes, de keuze van de waterstand, de beoordeling van sluiskolken, het inlezen van FIS-data, de datacontrole en de routeplanner. Mislukken de tests, dan wordt de app niet gepubliceerd.
- Datacontrole vóór publicatie (`scripts/check.mjs`): de vorige versie blijft staan als het aantal bruggen, sluizen of vaarwegvakken ineens daalt, als veel brughoogtes tegelijk veranderen of als een brug uit de testset afwijkt. Onmogelijke waterstanden worden weggelaten.
- Testset bekende bruggen (`tests/bekende-bruggen.json`). Nog te vullen met bruggen waarvan de hoogte zeker is.
- Waterstand voor "nu": is de meting ouder dan 30 minuten, dan gebruikt de app de verwachting van Rijkswaterstaat voor dit moment (belangrijk bij getij).
- Nieuwe kaartlaag "Toon koppeling brug → meetpunt": lijntjes van elke brug naar het meetpunt waarmee gecorrigeerd wordt.

**Hosting**
- De zelfstartende keten van workflow-runs is verwijderd. Alleen het gewone schema elke 10 minuten blijft over (zie `docs/HOSTING.md`).
- Waarschuwing voor oude waterstanden vanaf 45 minuten (was 30), omdat GitHub runs vaak later start.

**Privacy en licenties**
- Lettertypen en Leaflet staan in de app zelf: geen verzoeken meer naar Google Fonts of cdnjs.
- OpenStreetMap-tegels vervangen door de kleurenkaart van PDOK. OpenSeaMap blijft beschikbaar als extra laag.
- Naamsvermelding van de waterschapsdata (CC BY-SA 4.0) in de kaart.
- Nieuw venster "Voorwaarden en privacy" (zie `docs/JURIDISCH.md`).

**Nieuwe functies**
- Routecheck: kies vertrek en bestemming op de kaart. De app zoekt de kortste route over het water en toont welke bruggen en sluizen onderweg een knelpunt zijn, met de waterstand op het verwachte tijdstip van aankomst.
- Bootprofielen: meerdere schepen opslaan en wisselen.
- Contact bij beweegbare bruggen en sluizen: marifoonkanaal en telefoonnummer, als FIS die levert.
- "Klopt er iets niet? Meld het" in elke brug- en sluispopup, met de gegevens alvast ingevuld.

**Code**
- `app.js` (870 regels) is opgesplitst in modules in `public/js/` (zie README).
- `data/route-net.json`: compact vaarwegennetwerk voor de routecheck.
