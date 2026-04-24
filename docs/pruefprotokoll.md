# Prüfprotokoll

## Stand

Letzte Gesamtpruefung:
- 23.03.2026

Gepruefte Umgebung:
- lokal unter `http://localhost:3000`

## Automatisierte Prüfungen

Ausgefuehrt:

```bash
npm test
node --check public/app.js
node --check server/app.js
```

Ergebnis:
- 50 Tests erfolgreich
- 0 Tests fehlgeschlagen

Wichtige abgedeckte Bereiche:
- geschuetzte API-Endpunkte erfordern Login
- Produktionsstart blockiert Platzhalter-Passwoerter
- Registrierungen funktionieren nur mit gueltigem Schluessel
- Registrierungsschluessel werden nach erster Nutzung verbraucht
- Passwort-Reset fuer Teamkonten funktioniert
- Sitzungen bleiben nach Server-Neustart gueltig
- JSON-Import offizieller Exportdaten funktioniert
- automatische Sync-Quelle kann gespeichert werden
- Gemeindequellen aller Aargauer Gemeinden werden bereitgestellt
- normalisierter Gemeinden-/Quellenkatalog liefert 196 Gemeinden, Ratings und Shared Sources
- JSON- und CSV-Export fuer den Katalog funktionieren
- Gemeindeimporte bevorzugen offizielle Detailseiten
- allgemeine Archiv-, News- und unzuverlaessige Seitentitel werden nicht als Baugesuche uebernommen
- Adressen und Parzellen werden ueber den offiziellen Schweizer Suchdienst geokodiert
- AGIS-Endpunkt liefert direkte Treffer und Kontextzonen
- geschuetzte AGIS-/ArcGIS-Quellen koennen mit Token synchronisiert werden
- direkte amtliche PDF-Quellen koennen als eigene Quelle importiert werden
- HTML-/XML-Quellen duerfen auf amtliche Publikations-PDFs verlinken, die danach inhaltlich ausgewertet werden

## Manuelle Prüfungen

### Login und Sitzung

Geprueft:
- Login-Fenster erscheint
- Login mit `master` funktioniert lokal
- Abmelden funktioniert
- Benutzername merken funktioniert

### Arbeitsliste

Geprueft:
- Standardansicht zeigt nur aktuelle und offene Faelle
- Schnellfilter koennen kombiniert werden
- Suche und Gemeindefilter funktionieren
- ueberfaellige Faelle erscheinen nicht mehr faelschlich in der Standard-Arbeitsliste

### Detailansicht

Geprueft:
- Auswahl eines Falls aktualisiert die rechte Seite
- `Adresse pruefen` erscheint nur bei genauer Adresse ohne automatische Zuordnung
- `Manuell pruefen` bleibt fuer echte Restfaelle mit unklarer offizieller Standortangabe
- Kommentare sind im leeren Zustand nicht mehr als streuender UI-Rest sichtbar

### Karte und AGIS

Geprueft:
- falsche Atlantik-Koordinaten wurden behoben
- Schweizer Koordinaten werden korrekt interpretiert
- Inventarobjekte werden rot dargestellt
- amtliche Kontextzonen werden unterschieden dargestellt
- externe AGIS-Kartenlinks oeffnen den passenden Ort besser als vorher

Beispielpruefungen:
- `Kölliken, Schönenwerderstrasse 39`: Kontextzonen und Inventarpunkte sichtbar
- `Spreitenbach, Bahnhofstrasse 73`: Schweizer Standort statt falscher Weltkarte
- Faelle ohne exakte Koordinaten zeigen keinen falschen Marker, sondern einen klaren Hinweis

### Importlogik

Geprueft:
- generische Gemeinde-News, Events und Social-Media-Eintraege werden nicht mehr als Baugesuche uebernommen
- offizielle Detailseiten und Publikations-PDFs werden bevorzugt
- direkte PDF-Quellen und PDF-Detailseiten werden korrekt verarbeitet
- alte offensichtliche Fehlimporte werden bereinigt

## UI-Sichtprüfung mit MCP

Zusätzlich geprueft mit Playwright MCP:
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

1. Allgemeine Gemeinde-News und Events wurden faelschlich als Baugesuche uebernommen.
   Behoben:
   - strengere Parserlogik fuer offizielle Detailseiten und Publikations-PDFs

2. Fristen wurden faelschlich als ueberfaellig dargestellt.
   Behoben:
   - Berechnung gegen das echte aktuelle Datum
   - Standard-Arbeitsliste blendet ueberfaellige Standardfaelle aus

3. Einzelne Schweizer Koordinaten landeten im Atlantik.
   Behoben:
   - bessere Erkennung von Nord/Ost versus Ost/Nord
   - Plausibilitaetspruefung fuer Schweizer Koordinaten

4. Externe AGIS-Kartenlinks oeffneten nicht klar genug am richtigen Standort.
   Behoben:
   - verbesserte Layer- und `info`-Parameter fuer die offizielle Kartenansicht

5. Die Detailansicht war ueberladen.
   Behoben:
   - kompaktere Bewertung
   - ausgeblendete Nebendetails
   - eingeklappter Team-Austausch

## Bekannte Restgrenzen

- Einige offizielle Publikationen enthalten weiterhin nur Parzellen oder unvollstaendige Adressen.
- Solche Faelle bleiben korrekt in `Adresse pruefen` oder `Manuell pruefen`.
- Fuer eine echte vollautomatische kantonale Gesamtquelle braucht die App weiterhin einen echten Zugriff auf eine geschuetzte Quelle oder einen Export.
