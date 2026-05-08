# Prüfprotokoll

## Stand

Letzte Gesamtprüfung:
- 23.03.2026

Geprüfte Umgebung:
- lokal unter `http://localhost:3000`

## Automatisierte Prüfungen

Ausgeführt:

```bash
npm test
node --check public/app.js
node --check server/app.js
```

Ergebnis:
- 50 Tests erfolgreich
- 0 Tests fehlgeschlagen

Wichtige abgedeckte Bereiche:
- geschützte API-Endpunkte erfordern Login
- Produktionsstart blockiert Platzhalter-Passwörter
- Registrierungen funktionieren nur mit gültigem Schlüssel
- Registrierungsschlüssel werden nach erster Nutzung verbraucht
- Passwort-Reset für Teamkonten funktioniert
- Sitzungen bleiben nach Server-Neustart gültig
- JSON-Import offizieller Exportdaten funktioniert
- automatische Sync-Quelle kann gespeichert werden
- Gemeindequellen aller Aargauer Gemeinden werden bereitgestellt
- normalisierter Gemeinden-/Quellenkatalog liefert 196 Gemeinden, Ratings und Shared Sources
- JSON- und CSV-Export für den Katalog funktionieren
- Gemeindeimporte bevorzugen offizielle Detailseiten
- allgemeine Archiv-, News- und unzuverlässige Seitentitel werden nicht als Baugesuche übernommen
- Adressen und Parzellen werden über den offiziellen Schweizer Suchdienst geokodiert
- AGIS-Endpunkt liefert direkte Treffer und Kontextzonen
- geschützte AGIS-/ArcGIS-Quellen können mit Token synchronisiert werden
- direkte amtliche PDF-Quellen können als eigene Quelle importiert werden
- HTML-/XML-Quellen duerfen auf amtliche Publikations-PDFs verlinken, die danach inhaltlich ausgewertet werden

## Manuelle Prüfungen

### Login und Sitzung

Geprüft:
- Login-Fenster erscheint
- Login mit `master` funktioniert lokal
- Abmelden funktioniert
- Benutzername merken funktioniert

### Arbeitsliste

Geprüft:
- Standardansicht zeigt nur aktuelle und offene Fälle
- Schnellfilter können kombiniert werden
- Suche und Gemeindefilter funktionieren
- überfällige Fälle erscheinen nicht mehr fälschlich in der Standard-Arbeitsliste

### Detailansicht

Geprüft:
- Auswahl eines Falls aktualisiert die rechte Seite
- `Adresse prüfen` erscheint nur bei genauer Adresse ohne automatische Zuordnung
- `Manuell prüfen` bleibt für echte Restfälle mit unklarer offizieller Standortangabe
- Kommentare sind im leeren Zustand nicht mehr als streuender UI-Rest sichtbar

### Karte und AGIS

Geprüft:
- falsche Atlantik-Koordinaten wurden behoben
- Schweizer Koordinaten werden korrekt interpretiert
- Inventarobjekte werden rot dargestellt
- amtliche Kontextzonen werden unterschieden dargestellt
- externe AGIS-Kartenlinks öffnen den passenden Ort besser als vorher

Beispielprüfungen:
- `Kölliken, Schönenwerderstrasse 39`: Kontextzonen und Inventarpunkte sichtbar
- `Spreitenbach, Bahnhofstrasse 73`: Schweizer Standort statt falscher Weltkarte
- Fälle ohne exakte Koordinaten zeigen keinen falschen Marker, sondern einen klaren Hinweis

### Importlogik

Geprüft:
- generische Gemeinde-News, Events und Social-Media-Einträge werden nicht mehr als Baugesuche übernommen
- offizielle Detailseiten und Publikations-PDFs werden bevorzugt
- direkte PDF-Quellen und PDF-Detailseiten werden korrekt verarbeitet
- alte offensichtliche Fehlimporte werden bereinigt

## UI-Sichtprüfung mit MCP

Zusätzlich geprüft mit Playwright MCP:
- Login-Ansicht
- Arbeitsliste
- Detailansicht mit AGIS-Karte
- Verwaltungsbereich des Master-Kontos

Die Screenshots dazu liegen in:
- [docs/screenshots/01-login.png](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/screenshots/01-login.png)
- [docs/screenshots/02-arbeitsliste.png](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/screenshots/02-arbeitsliste.png)
- [docs/screenshots/03-detail-agis.png](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/screenshots/03-detail-agis.png)
- [docs/screenshots/04-verwaltung.png](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/screenshots/04-verwaltung.png)

## Behobene Probleme im aktuellen Endstand

1. Allgemeine Gemeinde-News und Events wurden fälschlich als Baugesuche übernommen.
   Behoben:
   - strengere Parserlogik für offizielle Detailseiten und Publikations-PDFs

2. Fristen wurden fälschlich als überfällig dargestellt.
   Behoben:
   - Berechnung gegen das echte aktuelle Datum
   - Standard-Arbeitsliste blendet überfällige Standardfälle aus

3. Einzelne Schweizer Koordinaten landeten im Atlantik.
   Behoben:
   - bessere Erkennung von Nord/Ost versus Ost/Nord
   - Plausibilitätsprüfung für Schweizer Koordinaten

4. Externe AGIS-Kartenlinks öffneten nicht klar genug am richtigen Standort.
   Behoben:
   - verbesserte Layer- und `info`-Parameter für die offizielle Kartenansicht

5. Die Detailansicht war überladen.
   Behoben:
   - kompaktere Bewertung
   - ausgeblendete Nebendetails
   - eingeklappter Team-Austausch

## Bekannte Restgrenzen

- Einige offizielle Publikationen enthalten weiterhin nur Parzellen oder unvollständige Adressen.
- Solche Fälle bleiben korrekt in `Adresse prüfen` oder `Manuell prüfen`.
- Für eine echte vollautomatische kantonale Gesamtquelle braucht die App weiterhin einen echten Zugriff auf eine geschützte Quelle oder einen Export.
