# Abschlussdokumentation

## Projektstand

Die Anwendung ist als interner Pilot fuer den Heimatschutz Aargau fertig aufgebaut. Sie verbindet offizielle Gemeindequellen mit amtlichen AGIS-Daten und stellt dem Team eine klare Arbeitsoberflaeche fuer Sichtung, Bewertung und Bearbeitung von Baugesuchen bereit.

## Abdeckung aller Aargauer Gemeinden

Der aktuelle Systemstand fuehrt einen vollstaendigen Gemeinden-/Quellenkatalog fuer alle 196 Aargauer Gemeinden.

Aktueller Reportstand:
- 196 Gemeinden erfasst
- 196 eindeutige Primaerquellen im aktuellen Seed
- 4 Gemeinden mit geteilter Primaerquelle
- 3 haeufig geteilte Zusatzquellen
- 106 unsichere Bewertungen

Rating-Verteilung:
- `A`: 51
- `B`: 42
- `C`: 102
- `D`: 1

Hauefig gemeinsam genutzte Quellen:
- `AGIS Baugesuche`
- `Amtsblatt Aargau`
- `eBau Aargau`

Die Quellen sind im System von den Gemeinden getrennt modelliert. Eine Gemeinde kann damit auf mehrere Quellen verweisen, und eine Quelle kann mehreren Gemeinden zugeordnet sein.

## Gestalterischer Endstand

Die Oberflaeche wurde bewusst an oeffentlichen digitalen Auftritten ausgerichtet:

- ruhige, sachliche Farbpalette
- klare Hierarchie zwischen Arbeitsliste und Detailansicht
- reduzierte Bedientexte
- grosse, gut lesbare Eingaben und Statuschips
- konsistente Panel- und Kartenstruktur

Als Orientierung dienten offizielle, zurueckhaltende Webmuster aus dem Umfeld von Kanton und Bund, insbesondere die oeffentliche Gestaltung des Kantons Aargau und die Schweizer Bundes-Styleguide-Prinzipien fuer klare Informationsdarstellung.

## Fachliche Logik

### Was die App automatisch macht

- offizielle Gemeindequellen abrufen
- relevante Baugesuche aus Detailseiten oder Publikations-PDFs ableiten
- unzuverlaessige News-/Archiv-/Eventeintraege ausfiltern
- Adressen und Parzellen normalisieren
- moeglichst amtlich geokodieren
- AGIS-Treffer gegen Schutzflaechen und Inventarobjekte pruefen
- Hinweise und Schutzstatus speichern

### Was bewusst manuell bleibt

- Faelle ohne genug genaue Adresse oder nur mit Parzellenangabe
- fachliche Endbeurteilung
- interne Priorisierung, Notizen und Kommentare

## Screenshots

### 1. Login

Die Anwendung trennt internen Zugang und Registrierung klar. Benutzer melden sich mit Benutzername und Passwort an; neue Konten brauchen einen Registrierungsschluessel.

![Login](screenshots/01-login.png)

### 2. Arbeitsliste

Die Standardansicht ist auf aktuelle und offene Faelle reduziert. Suche, Filter und Schnellauswahl stehen oben; links steht die Arbeitsliste, rechts die Bearbeitung des gewaehlten Falls.

![Arbeitsliste](screenshots/02-arbeitsliste.png)

### 3. Detailansicht mit AGIS

Bei einem Schutztreffer zeigt die Karte Standort, rote Inventarobjekte und amtliche Kontextzonen. Die Bewertung bleibt kompakt und ist direkt unter der Karte lesbar.

![Detailansicht mit AGIS](screenshots/03-detail-agis.png)

### 4. Verwaltungsbereich

Das Master-Konto kann Schluessel, Passwoerter, Datenimporte, automatische Sync-Quellen und Gemeindequellen zentral verwalten. Der neue Verwaltungsbereich zeigt zusaetzlich Katalogreport, gemeinsame Quellen, Qualitaetsrating und Exportfunktionen.

![Verwaltung](screenshots/04-verwaltung.png)

## Aufbau der Anwendung

### Linke Seite

- Arbeitsliste
- Suche und Filter
- AGIS-Treffer
- Frist
- Team-Status

### Rechte Seite

- Stammdaten des ausgewaehlten Falls
- Karte
- Einschaetzung
- interne Notiz
- Team-Austausch

### Verwaltungsbereich

- Registrierungsschluessel
- Passwort-Reset
- JSON-Import
- automatische Sync-Quelle
- Gemeindequellen Aargau

## Verwendete offizielle Daten

Die Anwendung setzt auf amtliche Quellen:

- offizielle Gemeinde-Publikationsseiten
- offizielle Gemeinde-PDFs fuer Baugesuche
- AGIS-/ArcGIS-Layer des Kantons fuer Schutzpruefung
- optional geschuetzte AGIS-/eBau-Quellen mit Token
- offizieller Schweizer Suchdienst fuer Geokodierung

Nicht als Hauptquelle vorgesehen:

- allgemeine Newsseiten
- Eventseiten
- Social-Media-Seiten
- unscharfe Archivseiten ohne belastbare Baugesuchsinformation

## Test- und Abnahmestand

Der Endstand wurde lokal geprueft:

- `42` automatisierte Tests erfolgreich
- Syntaxpruefung von Frontend und Backend erfolgreich
- manuelle UI-Pruefung mit Playwright MCP erfolgreich
- Screenshots stammen aus der laufenden lokalen Anwendung

## Produktive Bereitstellung

Fuer den internen Pilot ist Railway mit Volume vorgesehen.

Pflichtvariablen:

```env
DATABASE_PATH=/data/heimatschutz.sqlite
MASTER_ACCOUNT_PASSWORD=...
DEFAULT_LOGIN_PASSWORD=...
NODE_ENV=production
PORT=3000
```

Optional fuer eine echte geschuetzte Vollautomatik:

```env
SYNC_SOURCE_URL=...
SYNC_SOURCE_TOKEN=...
AUTO_SYNC_ENABLED=true
AUTO_SYNC_INTERVAL_HOURS=168
AUTO_SYNC_RUN_ON_START=true
```

## Offene technische Grenze

Die Anwendung ist im internen Pilot einsatzbereit. Was fuer die volle kantonale Vollautomatik noch fehlt, ist kein Frontend- oder Importproblem mehr, sondern ein echter Zugriff auf eine geschuetzte Gesamtquelle oder ein offizieller periodischer Export.

## Verwandte Dokumente

- [README.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/README.md)
- [benutzerhandbuch.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/benutzerhandbuch.md)
- [systemdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/systemdokumentation.md)
- [pruefprotokoll.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/pruefprotokoll.md)
