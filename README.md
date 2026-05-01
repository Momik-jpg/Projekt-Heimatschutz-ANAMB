# Projekt-Heimatschutz-ANAMB

Interne Webanwendung fuer den Heimatschutz Aargau zur Sichtung, Pruefung und Team-Bearbeitung von Baugesuchen.

## Ziel

Die Anwendung sammelt offizielle Baugesuchs-Publikationen, ordnet sie wenn moeglich automatisch einem Standort zu und prueft den Fall gegen amtliche AGIS-Schutzdaten. Das Team sieht links die Arbeitsliste und rechts die fachliche Einschaetzung, Karte und interne Bearbeitung.

## Vertrauenswuerdige Quellenn

Die Anwendung ist bewusst auf offizielle Quellen ausgerichtet.

1. Offizielle Baugesuchs- und Publikationsseiten der Gemeinden
2. Offizielle AGIS-/ArcGIS-Dienste des Kantons fuer Schutzflaechen und Inventarobjekte
3. Optional geschuetzte AGIS-/eBau-/ArcGIS-Quellen mit Token
4. Manuelle Klaerung fuer Gemeinden ohne digitale Publikation oder fuer unklare Parzellen-/Adressfaelle

Allgemeine News-, Event- oder Social-Media-Seiten sollen nicht als produktive Hauptquelle verwendet werden.

## Hauptfunktionen

- Login fuer internes Team
- Master-Konto fuer Verwaltung
- Keine Passwoerter im Quellcode: das Master-Konto wird per Umgebungsvariable oder ueber einen per E-Mail zugestellten Einmal-Setup-Schluessel eingerichtet
- Registrierung nur mit einmaligem Registrierungsschluessel
- Passwort-Reset durch das Master-Konto
- Schutz gegen Passwort-Raten (Rate-Limiting), asynchrones Passwort-Hashing (scrypt), gzip-Kompression und gehaertete Security-Header (CSP, HSTS u. a.)
- Arbeitsliste mit Suche, Filtern und Schnellauswahl
- Detailansicht mit Karte, AGIS-Treffer und naechstem Schritt
- Interne Notizen und Team-Kommentare
- Verwaltung und Pflege der Gemeindequellen fuer den ganzen Kanton Aargau
- normalisierter Gemeinden-/Quellenkatalog mit 196 Gemeinden
- deduplizierte Sicht auf geteilte Quellen und Qualitaetsratings `A` bis `D`
- Export des Gemeinden-/Quellenkatalogs als JSON und CSV
- Manueller JSON-Import fuer offizielle Exportdateien
- Automatischer Sync ueber offizielle Gemeindequellen
- Auto-Discovery: Ist nur die offizielle Gemeinde-Webseite bekannt, sucht der Sync die Baugesuch-/Publikationsseite selbststaendig (Link-Analyse, gaengige Publikationspfade und der kantonale Anzeiger als Fallback) und wertet sie aus
- SSRF-Schutz: Auto-Discovery folgt nur oeffentlichen http(s)-Adressen auf derselben Domain und blockiert interne/lokale Netzwerkadressen
- Optionaler Wochen-Sync ueber HTML-, XML-/RSS-/Sitemap-, JSON-, direkte PDF- und ArcGIS-/AGIS-Quellen
- Robuste Auto-Erkennung von XML-/RSS-/Sitemap- und ArcGIS-/JSON-Quellen anhand der URL, falls ein Quellentyp einmal falsch als HTML gepflegt wurde
- HTML-Import kann zusaetzlich eingebettete `iframe`-Publikationen und strukturierte `JSON-LD`-/`itemprop`-Seitendaten auswerten
- PDF-Publikationen koennen direkt als Quelle gepflegt oder aus HTML-/XML-Quellen nachgeladen und extrahiert werden

## Gemeinden- und Quellenmodell

Die Anwendung fuehrt neben der operativen Tabelle `municipality_sources` jetzt einen normalisierten Katalog:

- `municipalities`: alle 196 Aargauer Gemeinden
- `publication_sources`: reale Publikationsquellen und geteilte Zusatzquellen
- `municipality_source_links`: Zuordnung Gemeinde ↔ Quelle, inklusive gemeinsamer Quellen
- `municipality_quality_assessments`: Rating `A/B/C/D`, Begruendung und Unsicherheitsmarker

Die operative Sync-Logik bleibt kompatibel zur bestehenden Architektur. Der normalisierte Katalog wird parallel gefuellt und fuer Admin-Ansicht, Report und Export verwendet.

## Aktueller Katalogstand

Der aktuelle Seed-/Katalogstand deckt alle 196 Gemeinden ab.

- 196 Gemeinden
- rund 170 Gemeinden sind fuer den automatischen Sync aktiviert; Gemeinden mit nur bekannter Webseite werden per Auto-Discovery erschlossen
- 196 eindeutige Primaerquellen im aktuellen Seed
- 4 Gemeinden mit geteilter Primaerquelle
- 3 haeufig geteilte Zusatzquellen: AGIS Baugesuche, Amtsblatt Aargau, eBau Aargau
- eBau Aargau ist fuer 57 Gemeinden als login-geschuetzte Portalquelle hinterlegt
- Rating-Verteilung:
  - `A`: 81
  - `B`: 46
  - `C`: 69
  - `D`: 0

### eBau Aargau

eBau Aargau (`https://ebauportal.ag.ch/`) ist im Katalog als gemeinsame Portalquelle fuer die Gemeinden markiert, in denen Gesuche aktuell digital eingereicht werden koennen. Das Portal ist login-geschuetzt und wird deshalb nicht als offene Scrapingquelle aktiviert; fuer automatische Arbeitslisten bleiben Amtsblatt, AGIS-Abgleich und offene Gemeindequellen massgebend.

Aktuell hinterlegte eBau-Gemeinden:

A: Aarau*, Aarburg, Arni (AG)
B: Biberstein, Boswil*, Bremgarten*
D: Densbueren, Dietwil
E: Endingen
F: Fischbach-Goeslikon, Freienwil
G: Gipf-Oberfrick*, Gontenschwil
H: Haegglingen, Hellikon, Herznach-Ueken, Hirschthal
J: Jonen
K: Kirchleerau
L: Lengnau
M: Meisterschwanden, Menziken, Merenschwand, Mettauertal, Moehlin, Moosleerau, Muri*, Muelligen, Muenchwilen
O: Oberhof, Obermumpf, Oberwil-Lieli, Oeschgen, Olsberg
R: Reitnau, Remigen, Riniken
S: Safenwil, Schlossrued, Schmiedrued, Schoeftland, Staffelbach, Strengelbach, Suhr
T: Taegerig, Tegerfelden
U: Uerkheim*, Unterkulm
W: Wallbach, Wegenstetten, Wiliberg, Wohlen, Woelflinswil, Wuerenlingen
Z: Zeihen, Zofingen*, Zuzgen

## Lokal starten

Voraussetzung:
- Node.js 24 oder neuer

PowerShell:

```powershell
# Einfachste Variante: Master-Passwort direkt setzen (kein Passwort im Code).
$env:MASTER_ACCOUNT_PASSWORD="LokalesMasterPasswort_2026!"
# Optional: Startpasswort fuer die Seed-Teamkonten (sonst bleiben sie gesperrt).
$env:DEFAULT_LOGIN_PASSWORD="LokalesTeamPasswort_2026!"
npm install
npm start
```

Danach ist die Anwendung lokal unter [http://localhost:3000](http://localhost:3000) erreichbar.

Alternativ ohne Passwort in der Umgebung: `MASTER_ACCOUNT_PASSWORD` weglassen. Beim
ersten Start erzeugt die App einen Einmal-Setup-Schluessel. Ist SMTP konfiguriert,
wird er an `MASTER_SETUP_EMAIL` gesendet; sonst erscheint er einmalig im Server-Log.
Im Login-Bildschirm unter "Master-Konto einrichten" Schluessel und neues Passwort
eingeben.

## Wichtige Umgebungsvariablen

```env
DATABASE_PATH=/data/heimatschutz.sqlite
NODE_ENV=production
PORT=3000

# Master-Konto: entweder direkt ein Passwort setzen ...
MASTER_ACCOUNT_PASSWORD=EinSicheresMasterPasswort
# ... oder MASTER_ACCOUNT_PASSWORD leer lassen und die E-Mail-Einrichtung nutzen:
# MASTER_SETUP_EMAIL=master@example.org
# SMTP_HOST=smtp.example.org
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=postfach@example.org
# SMTP_PASSWORD=DEIN_SMTP_PASSWORT
# SMTP_FROM=Heimatschutz Aargau <postfach@example.org>

# Optionales Startpasswort fuer die Seed-Teamkonten (sonst gesperrt):
# DEFAULT_LOGIN_PASSWORD=EinSicheresTeamPasswort
```

Hinweis: Es sind keine Standardpasswoerter im Code hinterlegt. In Produktion
(`NODE_ENV=production`) bricht der Start ab, wenn weder `MASTER_ACCOUNT_PASSWORD`
gesetzt noch die E-Mail-Einrichtung (`MASTER_SETUP_EMAIL` + `SMTP_HOST`)
konfiguriert ist.

### Master-Konto per E-Mail einrichten (Setup-Schluessel)

1. `MASTER_ACCOUNT_PASSWORD` leer lassen, dafuer `MASTER_SETUP_EMAIL` und die
   `SMTP_*`-Variablen setzen.
2. Beim ersten Start erzeugt die App einen Einmal-Schluessel und sendet ihn an
   `MASTER_SETUP_EMAIL` (ohne SMTP: einmalige Ausgabe im Server-Log).
3. Im Login-Bildschirm "Master-Konto einrichten" oeffnen, Schluessel und neues
   Passwort eingeben. Der Schluessel ist 48 Stunden gueltig und nur einmal nutzbar.
4. Danach normal mit Benutzer `master` und dem neuen Passwort anmelden.

Optional fuer einen echten automatischen Quellimport:

```env
SYNC_SOURCE_URL=https://www.aarau.ch/baugesuche
SYNC_SOURCE_TYPE=html
SYNC_SOURCE_MUNICIPALITY=Aarau
SYNC_SOURCE_TOKEN=EIN_ECHTER_TOKEN
AUTO_SYNC_ENABLED=true
AUTO_SYNC_INTERVAL_HOURS=168
AUTO_SYNC_RUN_ON_START=true
```

`SYNC_SOURCE_TYPE` kann leer bleiben, wenn die URL klar als JSON, RSS/Sitemap, PDF oder ArcGIS erkennbar ist. Fuer normale Gemeinde-Webseiten wird `html` zusammen mit `SYNC_SOURCE_MUNICIPALITY` verwendet.

### Amtsblatt des Kantons Aargau (kantonsweite Quelle)

Das offizielle Amtsblatt (`amtsblatt.ag.ch`) listet die Bau- und Rodungsgesuche aller Aargauer Gemeinden zentral. Es wird als eigener Quellentyp `amtsblatt` automatisch erkannt und kantonsweit ausgelesen. Pro Eintrag werden Gemeinde, Bauplatz-Adresse (nicht die Wohnadresse der Bauherrschaft), Bauvorhaben und Datum extrahiert.

```env
SYNC_SOURCE_URL=https://amtsblatt.ag.ch/publikationen/
AMTSBLATT_MAX_PAGES=50
AMTSBLATT_GEOCODE=true
```

- `AMTSBLATT_MAX_PAGES`: wie viele Ergebnisseiten je Sync gelesen werden (jede Seite ~10 amtliche Publikationen, davon ~4 Baugesuche). Hoehere Werte holen mehr Historie, erzeugen aber mehr Anfragen an die Behoerdenseite.
- `AMTSBLATT_GEOCODE`: `false` schaltet die Live-Geokodierung beim Massen-Import ab (schneller Backfill grosser Mengen ohne Last-Spitze auf die amtlichen Dienste); die AGIS-Schutzpruefung erfolgt dann pro Fall spaeter.

## Railway

Fuer den internen Pilot ist Railway mit Volume die vorgesehene Betriebsumgebung.

Pflicht:
- Volume an `/data`
- `DATABASE_PATH=/data/heimatschutz.sqlite`
- Master-Konto eingerichtet: entweder ein sicherer Wert fuer `MASTER_ACCOUNT_PASSWORD` oder die E-Mail-Einrichtung (`MASTER_SETUP_EMAIL` + `SMTP_*`)

Details:
- [docs/deployment-railway.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/deployment-railway.md)

## Dokumentation

- [docs/abschlussdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/abschlussdokumentation.md): finale Uebersicht mit Screenshots
- [docs/benutzerhandbuch.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/benutzerhandbuch.md): Bedienung fuer Team und Master
- [docs/systemdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/systemdokumentation.md): Architektur, Quellen und API
- [docs/pruefprotokoll.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/pruefprotokoll.md): aktueller Test- und Pruefstand
- [docs/datenimport-kurzanleitung.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/datenimport-kurzanleitung.md): Kurzablauf fuer JSON-Importe
- [docs/release-checkliste.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/release-checkliste.md): letzte Punkte vor dem Livegang

## Projektstruktur

- `public/`: Oberflaeche, Karte, Filter, Kommentare
- `server/`: API, Datenbank, Sync, AGIS-Logik
- `tests/`: automatisierte Tests
- `docs/`: Dokumentation und Screenshots

## Aktueller Stand

- Die Anwendung ist fuer einen internen Pilot mit kleinem Team einsatzbereit.
- Die Gemeindequellen werden gegen offizielle Publikationsseiten gepflegt.
- Der Importer kann jetzt auch offizielle Publikationsinhalte aus eingebetteten Frames, strukturierten Metadaten und direkten PDF-Quellen erschliessen.
- Die Detailkarte nutzt amtliche AGIS-Layer und zeigt je nach Fall Standort, Inventarobjekte und Zonen.
- Ueberfaellige oder unklare Faelle werden in der Standard-Arbeitsliste bewusst reduziert.
- Vollautomatischer Import aus einer geschuetzten kantonalen Quelle ist technisch vorbereitet, braucht aber eine echte Zugangsquelle oder einen Token.
