# Juridisch en privacy: wat er geregeld is en wat nog openstaat

> Ik ben geen jurist. Dit overzicht helpt je op weg. Laat de voorwaarden juridisch toetsen voordat je de app commercieel aanbiedt of in de app stores zet.

## Geregeld in de app

| Onderwerp | Wat er gedaan is |
|---|---|
| **Lettertypen** | Barlow Semi Condensed en JetBrains Mono staan nu in de app zelf (`public/vendor/fonts`), niet meer bij Google. Daarmee gaat er geen IP-adres meer naar Google. In Duitsland is een website hiervoor op grond van de AVG veroordeeld (LG München, 2022). Licentie: SIL Open Font License, meegeleverd. |
| **Leaflet** | Staat ook in de app zelf (`public/vendor/leaflet`), niet meer bij cdnjs. BSD-2-licentie, meegeleverd. Bijkomend voordeel: de app werkt offline beter. |
| **Kaartlagen** | De standaard OpenStreetMap-tegels zijn eruit. De tegelservers van OpenStreetMap zijn een gratis voorziening met een gebruiksbeleid dat zwaar en commercieel gebruik niet toestaat. In plaats daarvan is er nu een kleurenkaart van PDOK (BRT). PDOK is een open overheidsdienst zonder zulke beperkingen. |
| **OpenSeaMap** | Blijft beschikbaar als extra laag, standaard uit, met naamsvermelding (CC BY-SA). OpenSeaMap is een vrijwilligersproject. Vraag toestemming of zoek een alternatief voordat je de app commercieel aanbiedt. |
| **Naamsvermelding data** | In de kaart staat nu: "Data: RWS (CC-0), Waterschappen/PDOK (CC BY-SA 4.0)". In het disclaimervenster staan alle bronnen voluit. CC BY-SA vereist naamsvermelding, en die staat er nu. |
| **Voorwaarden en privacy** | Nieuw venster in de app ("Voorwaarden en privacy", onderaan het paneel): gebruiksvoorwaarden, aansprakelijkheid en een korte privacyverklaring. |
| **Geen tracking** | De app gebruikt geen cookies en geen analysediensten. Instellingen en bootprofielen staan alleen op het toestel. |

## Nog te doen voor een bedrijf

1. **Voorwaarden laten toetsen.** Een uitsluiting van aansprakelijkheid werkt richting consumenten maar beperkt. Een jurist kan beoordelen wat houdbaar is. Voor beroepsvaart (zakelijke gebruikers) is er meer ruimte.
2. **Rechtsvorm.** Met een eenmanszaak ben je privé aansprakelijk. Een BV schermt je privévermogen af. Vraag ook naar een beroeps- of bedrijfsaansprakelijkheidsverzekering.
3. **Contactgegevens.** Wie in Nederland online iets aanbiedt, moet naam, adres, e-mail en KvK-nummer vermelden. Zet die in het voorwaardenvenster zodra je ingeschreven bent.
4. **Meldingen.** Vul je e-mailadres in bij `FEEDBACK_EMAIL` in `public/js/config.js`, zodat schippers fouten melden zonder GitHub-account. Bewaar meldingen niet langer dan nodig en noem dat in de privacyverklaring.
5. **Statistieken.** Wil je gebruiksstatistieken, kies dan een dienst zonder cookies en zonder persoonsgegevens (bijvoorbeeld Plausible of GoatCounter) en pas de privacyverklaring aan.
6. **App stores.** Apple en Google vragen een privacyverklaring op een vaste URL. Zet de tekst uit het voorwaardenvenster ook op een eigen pagina.
