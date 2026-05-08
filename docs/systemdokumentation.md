# Systemdokumentation

## Zielbild

Das System bildet einen internen Arbeitsprozess für Baugesuche ab:

1. Offizielle Quellen werden importiert.
2. Das Gesuch wird möglichst genau geokodiert oder über Parzelle angenaehert.
3. Der Standort wird gegen amtliche AGIS-Layer geprüft.
4. Das Team bearbeitet den Fall mit Status, Notiz und Kommentar.

Die Anwendung ist für ein kleines internes Team und eine einzelne produktive Instanz ausgelegt.

## Fachliche Quellenstrategie

Die Quellen werden bewusst priorisiert.

### Primär

- offizielle Publikationsseiten der Gemeinden
- offizielle Baugesuchsseiten und Publikations-PDFs

### Sekundaer

- amtliche AGIS-/ArcGIS-Layer für die Schutzprüfung
- optionale geschützte AGIS-/eBau-/ArcGIS-Quellen mit Token

### Fallback

- manueller JSON-Import offizieller Exportdateien
- manuelle Klärung für unvollständige Publikationen

Allgemeine News-, Event- oder Social-Media-Seiten gelten nicht als produktive Hauptquelle.

## Architektur

### Frontend

Pfad:
- `public/index.html`
- `public/app.js`
- `public/styles.css`

Aufgaben:
- Login und Registrierung
- Arbeitsliste und Filter
- Detailansicht und Karte
- Kommentarbereich
- Master-Verwaltung

### Backend

Pfad:
- `server/app.js`

Aufgaben:
- Express-Server
- API-Endpunkte
- Authentifizierung und Sitzungsprüfung
- Admin-Aktionen
- Sync-Steuerung
- AGIS-Proxy für Geometriedaten

### Datenhaltung

Pfad:
- `server/db.js`

Technik:
- SQLite über `node:sqlite`

Wichtig:
- Sitzungen bleiben persistent gespeichert.
- Seed-Demo-Baugesuche werden nicht standardmässig wieder eingefüllt.
- Gemeindequellen und Benutzer werden initial angelegt.

## Wichtige Datenfluesse

### 1. Login

1. Frontend sendet Benutzername und Passwort an `POST /api/auth/login`.
2. Backend prüft Hash und legt eine Sitzung in SQLite an.
3. Die Sitzung wird bei weiteren API-Aufrufen serverseitig geprüft.

### 2. Arbeitsliste

1. Frontend lädt `GET /api/dashboard`.
2. Frontend lädt `GET /api/applications`.
3. Die Liste wird clientseitig mit Standardansicht und Schnellfiltern reduziert.

### 3. Detailansicht

1. Ein Fall wird in der Liste ausgewählt.
2. Gespeicherte Falldaten werden aus der API angezeigt.
3. Für die Karte wird zusätzlich `GET /api/agis/features` geladen.
4. Die Karte zeigt Standort, Inventarpunkte und Kontextzonen.

### 4. Gemeindeimport

1. Aktivierte Gemeindequelle wird geladen.
2. HTML-, XML-/RSS-/Sitemap-, JSON-, PDF- oder ArcGIS-Inhalt wird geparst.
   XML-/RSS-/Sitemap-, PDF- und ArcGIS-/JSON-Quellen werden bei klarer URL-Struktur auch dann erkannt, wenn sie in der Verwaltung versehentlich noch als HTML gespeichert sind.
   Bei HTML-Quellen können zusätzlich offizielle `iframe`-Einbettungen sowie strukturierte `JSON-LD`-/`itemprop`-Metadaten ausgewertet werden.
   Verweisen HTML- oder XML-Einträge nur auf eine amtliche Publikations-PDF, wird die PDF nachgeladen und inhaltlich ausgewertet.
3. Relevante Baugesuchseinträge werden extrahiert.
4. Adresse oder Parzelle wird normalisiert.
5. Wenn möglich wird über den offiziellen Schweizer Geocoder geokodiert.
6. AGIS-Prüfung setzt Schutzstatus und Bewertung.
7. Ergebnis wird in `applications` gespeichert oder aktualisiert.

### 5. Wochen-Sync

1. `weeklySyncService` prüft geplante Läufe.
2. Aktivierte Gemeindequellen oder eine feste `SYNC_SOURCE_URL` werden importiert.
   Für eine einzelne Website-/RSS-/PDF-Quelle kann zusätzlich `SYNC_SOURCE_TYPE` und `SYNC_SOURCE_MUNICIPALITY` gesetzt werden, damit der Scraper den Gemeinde-Kontext kennt.
3. Neue oder geänderte Schutztreffer erzeugen Import-Hinweise.

## Parser-Erweiterungen für offizielle Quellen

Der bestehende Importer wurde so erweitert, dass mehr vertrauenswürdige Quellmuster ausgewertet werden können, ohne auf allgemeine News- oder Eventseiten auszuweichen.

- HTML-Publikationsseiten mit direkten Einträgen
- offizielle Detailseiten hinter Linklisten
- XML-/RSS-/Atom-Feeds
- Sitemaps mit verlinkten Publikationsseiten
- direkte amtliche PDF-Quellen
- JSON-/GeoJSON-Quellen
- ArcGIS-/AGIS-Dienste
- eingebettete `iframe`-Publikationen
- strukturierte `JSON-LD`- und `itemprop`-Metadaten

Die HTML-Erkennung bleibt absichtlich defensiv. Importiert werden nur Inhalte, die wie echte Baugesuch-Publikationen aussehen und stabile Angaben wie Adresse, Parzelle, Frist oder Publikationsdatum enthalten. Bei PDF-Quellen werden dieselben Mindestanforderungen auf den extrahierten Text angewendet.

## Offizielle Geodaten und Geokodierung

### AGIS-Layer

Verwendete amtliche Dienste:

- `https://www.ag.ch/geoportal/rest/services/are_isos/MapServer`
- `https://www.ag.ch/geoportal/rest/services/dp_denkmalpflege/MapServer`

Verwendete Layer:

- `18`: Ortsbilder in den Gemeinden
- `21`: Ortsbildteile
- `20`: Hinweiszonen
- `15`: PDF-Perimeter
- `8`: Bauinventarobjekte

### Schweizer Geocoder

Für die automatische Adress- oder Parzellenzuordnung wird standardmässig verwendet:

- `https://api3.geo.admin.ch/rest/services/api/SearchServer`

## API-Endpunkte

### Allgemein

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/sync/status`
- `POST /api/sync`

### Auth

- `GET /api/auth/users`
- `GET /api/auth/session`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`

### Anwendungen

- `GET /api/applications`
- `GET /api/applications/:id`
- `PATCH /api/applications/:id`
- `GET /api/applications/:id/comments`
- `POST /api/applications/:id/comments`

### AGIS

- `GET /api/agis/features`

### Admin

- `GET /api/admin/registration-keys`
- `POST /api/admin/registration-keys`
- `DELETE /api/admin/registration-keys/:id`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:id/password`
- `GET /api/admin/sync-settings`
- `PATCH /api/admin/sync-settings`
- `GET /api/admin/municipality-sources`
- `GET /api/admin/municipality-sources/export.json`
- `GET /api/admin/municipality-sources/export.csv`
- `PATCH /api/admin/municipality-sources/:id`
- `POST /api/admin/import-json`

## Wichtige Datenbanktabellen

### `applications`

Speichert:
- Quelle
- Gemeinde
- Adresse
- Parzelle
- Koordinaten
- Publikationsdatum
- Frist
- Bauvorhaben
- Schutzstatus
- AGIS-Match
- Layer-Information
- Team-Status
- Zuständigkeit
- Notiz

### `users`

Speichert:
- Benutzername
- Anzeigename
- Rolle
- Passwort-Hash

### `user_sessions`

Speichert:
- Sitzung
- Benutzerbezug
- Zeitstempel
- Ablauf

### `application_comments`

Speichert:
- Fallkommentare
- Autor
- Zeitstempel

### `registration_keys`

Speichert:
- Schlüsselcode
- Ersteller
- Verwendungsstatus
- Ablauf

### `municipality_sources`

Speichert pro Gemeinde:
- Quellentyp
- URL
- optionalen Token
- Include-/Exclude-Muster
- Digitalisierungsstand
- Aktivierungsstatus
- Notiz

### `municipalities`

Speichert:
- Gemeindename
- offizielle Website
- technische Referenz für den Katalog

### `publication_sources`

Speichert:
- reale Publikationsquelle
- Quellentyp / Quellkind
- kanonische URL
- Betreiber
- Marker, ob die Quelle mit anderen Gemeinden geteilt wird

### `municipality_source_links`

Speichert:
- Zuordnung Gemeinde ↔ Quelle
- Rolle der Quelle (`primary`, `supplemental`, ...)
- direkte URL
- technischer Quellentyp
- Aktivierungsstatus
- Include-/Exclude-Muster
- Hinweise auf geteilte Nutzung

### `municipality_quality_assessments`

Speichert pro Gemeinde:
- Primärquelle
- Qualitätsrating `A/B/C/D`
- Begründung
- Marker für unsichere Fälle

## Gemeinden-/Quellenkatalog

Der bestehende operative Sync verwendet weiterhin `municipality_sources`. Darüber liegt jetzt ein normalisierter Katalog für Analyse, Deduplizierung und Export.

### Ziel

- eine Gemeinde kann auf mehrere Quellen verweisen
- eine Quelle kann mehreren Gemeinden zugeordnet sein
- Primärquelle und Zusatzquellen werden getrennt sichtbar
- die Qualitätsbewertung ist pro Gemeinde dokumentiert

### Reportlogik

Der Katalog liefert über die Repository-Schicht:

- Gesamtzahl der Gemeinden
- Zahl eindeutiger Quellen
- Zahl geteilter Primärquellen
- Zahl unsicherer Bewertungen
- Verteilung der Ratings `A/B/C/D`
- häufig gemeinsam genutzte Quellen

### Exportlogik

Die Admin-API stellt den Katalog als:

- JSON-Export
- CSV-Export

bereit. Beide Exporte greifen auf den normalisierten Katalog zu, nicht nur auf die operative Sync-Tabelle.

### `app_settings`

Speichert:
- feste Sync-Quelle
- optionalen Quelltoken

## Schutzlogik

Die Bewertung trennt klar zwischen Datenquelle und Schutzprüfung.

### Gespeicherter Status in der Liste

Die Liste zeigt den aktuell gespeicherten AGIS-Status des Falls:
- `Gebäude geschützt`
- `Gebiet geschützt`
- `Gebäude + Gebiet`
- `Kein Schutz gefunden`
- `Manuell prüfen`

Wenn eine genaue Adresse vorhanden ist, aber keine automatische Zuordnung gelang, zeigt das Frontend bewusst `Adresse prüfen`.

### Detailkarte

Die Detailkarte lädt die offiziellen AGIS-Kontextdaten live nach:
- rote Punkte für Inventarobjekte
- verschiedene Zonentypen für Ortsbild- und Hinweisbereiche

Damit ist die Detailkarte fachlich aussagekraeftiger als eine reine Textliste.

## Sicherheits- und Betriebsregeln

- Produktion startet nicht mit Platzhalter-Passwörtern.
- `MASTER_ACCOUNT_PASSWORD` und `DEFAULT_LOGIN_PASSWORD` müssen in Produktion echt gesetzt sein.
- Geschützte Quellen können über Token eingebunden werden.
- Railway mit Volume ist die vorgesehene produktive Pilotumgebung.

## Testabdeckung

Die automatisierten Tests decken unter anderem ab:

- Login-Schutz
- Registrierung mit Schlüssel
- Passwort-Reset
- Sitzungen über Neustarts hinweg
- Import offizieller Gemeindequellen
- JSON-Import
- sichere Behandlung von Platzhalter-Quellen
- Geokodierung via Schweizer Suchdienst
- AGIS-Layer und Kontextzonen
- automatische Synchronisation

Der aktuelle Stand des Prüfprotokolls steht in [prüfprotokoll.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/prüfprotokoll.md).

## Bekannte Grenzen

- Nicht jede Gemeinde publiziert ausreichend strukturierte Standortdaten.
- Einige Fälle bleiben deshalb korrekt in `Adresse prüfen` oder `Manuell prüfen`.
- Eine wirklich vollautomatische kantonale Gesamtquelle braucht einen echten Zugang oder Token.
- Die Anwendung ist nicht für Mehrserver-Betrieb oder grosse horizontale Skalierung ausgelegt.
