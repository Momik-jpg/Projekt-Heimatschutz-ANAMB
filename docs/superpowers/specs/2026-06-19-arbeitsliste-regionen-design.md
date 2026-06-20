# Design: Regionale Arbeitsliste mit Inbox-Logik

## Ziel

Die bestehende Arbeitsoberfläche bleibt vollständig erhalten. Die Fallliste wird vereinfacht und verhält sich stärker wie ein E-Mail-Posteingang: neue ungelesene Gesuche stehen oben, ältere laufende Gesuche sind einklappbar, Regionen wirken als zusätzliche Filter und nach Fristende werden Fälle endgültig aus dem aktiven System gelöscht.

## Bestätigter Umfang

- Die Reiter `Arbeitsliste` und `Schutztreffer` bleiben bestehen und sind gegenseitig exklusiv.
- Die Reiter `Von Hand prüfen`, `Nur offen`, `Frist bald` und `Alle / Archiv` entfallen.
- Vier kombinierbare Regionsfilter werden ergänzt: `Berner Aargau`, `Fricktal`, `Baden` und `Freiamt`.
- Mehrere Regionen können gleichzeitig aktiv sein. Keine aktive Region bedeutet `Alle Regionen`.
- Bestehende Suche sowie Gemeinde-, AGIS- und Teamstatus-Filter bleiben erhalten.
- Die rechte Prüfung mit Fakten, Karte, Einschätzung, Verlauf und interner Bearbeitung bleibt unverändert bestehen.
- Unter der Beschreibung erscheint ein direkter Link zur gespeicherten Originalquelle beziehungsweise zum PDF oder Dokument.
- Jedes Bauvorhaben erhält automatisch die Grössenklasse `klein`, `mittel` oder `gross`.

## Listenverhalten

### Sortierung und 14-Tage-Grenze

Die Standardsortierung richtet sich absteigend nach `publication_date`. Die neuesten Publikationen stehen oben.

- Publikationen der letzten 14 Kalendertage erscheinen im primären Listenbereich.
- Ältere Publikationen mit noch laufender Frist erscheinen unter `Älter als 14 Tage – mehr anzeigen`.
- Der eingeklappte Bereich verwendet ebenfalls die absteigende Sortierung nach Publikationsdatum.
- Die 14-Tage-Grenze richtet sich ausschliesslich nach dem Publikationsdatum, nicht nach Import- oder Änderungszeitpunkt.

### Gelesen und ungelesen

Ein Gesuch ist für einen Benutzer ungelesen, solange dieser Benutzer es noch nie geöffnet hat. Ungelesene Zeilen werden wie neue E-Mails visuell hervorgehoben. Beim ersten Öffnen wird der Fall nur für den aktuellen Benutzer als gelesen markiert. Andere Benutzer sehen denselben Fall weiterhin als ungelesen, bis sie ihn selbst öffnen.

Der Gelesen-Status hat keinen Einfluss auf die 14-Tage-Gruppierung oder die Sortierung.

### Fristende und Löschung

Ein Gesuch bleibt am vollständigen Fristtag sichtbar. Sobald `deadline_date` vor dem heutigen Datum liegt, wird das Gesuch endgültig aus der aktiven Datenbank gelöscht. Die Löschung umfasst ohne Ausnahme:

- den Fall selbst,
- Kommentare,
- Notizen,
- Zuständigkeit und Bearbeitungsstatus,
- Entscheidungen und Verlaufseinträge,
- benutzerspezifische Gelesen-Markierungen.

Fälle mit fehlender oder ungültiger Frist werden nicht geraten und nicht automatisch gelöscht. Sie bleiben sichtbar und erhalten den Hinweis `Frist fehlt`.

Falls Datenbank-Backups aktiviert sind, können bereits gelöschte Datensätze bis zur regulären Ablösung der rollierenden Sicherungen in alten Backupdateien enthalten sein. In der aktiven Anwendung sind sie sofort nicht mehr vorhanden.

## Regionen

Die Region wird aus der Gemeinde über eine zentrale, versionierte Zuordnung abgeleitet. Die vier historischen Regionen decken die elf Aargauer Bezirke wie folgt ab:

- `Berner Aargau`: Bezirke Aarau, Brugg, Kulm, Lenzburg und Zofingen
- `Fricktal`: Bezirke Laufenburg und Rheinfelden
- `Baden`: Bezirke Baden und Zurzach
- `Freiamt`: Bezirke Bremgarten und Muri

Die Implementierung enthält eine vollständige Zuordnung der aktuell im Projekt bekannten Gemeinden. Unbekannte Gemeinden erhalten keine Region und bleiben sichtbar, wenn kein Regionsfilter aktiv ist. Bei aktivem Regionsfilter werden sie nicht fälschlich einer Region zugeordnet.

## Grössenbewertung

Die Grössenklasse wird deterministisch aus `project_type` und `description` abgeleitet. Die Regeln sind transparent und testbar; Treffer für grosse Vorhaben haben Vorrang vor mittleren und kleinen Treffern.

### Klein

Einzelne technische oder räumlich begrenzte Eingriffe, beispielsweise Wärmepumpen, Photovoltaikanlagen, einzelne Fenster, Reklamen, kleinere Nebenbauten oder vergleichbare Arbeiten.

### Mittel

Umbauten, Anbauten, Sanierungen, Einfamilienhäuser oder Vorhaben mittlerer Tragweite. `mittel` ist zugleich die neutrale Standardklasse, wenn keine eindeutige Regel greift.

### Gross

Mehrfamilienhäuser, Wohnüberbauungen, Gewerbe- und Industriebauten, mehrere Gebäude, grosse öffentliche Bauten oder vergleichbare Gesamtprojekte.

Die Bewertung ist eine Orientierungshilfe und keine denkmalrechtliche Entscheidung. Schutzstatus und AGIS-Einschätzung bleiben davon unabhängig.

## Oberfläche

### Linke Fallliste

1. Reitergruppe mit `Arbeitsliste` und `Schutztreffer`.
2. Darunter vier togglebare Regions-Chips. Keine Auswahl zeigt alle Regionen.
3. Darunter die bestehenden Such- und Auswahlfilter.
4. Bestehende Tabellenstruktur mit folgenden Ergänzungen:
   - ungelesene Zeile mit klarer, nicht nur farblicher Hervorhebung,
   - Grössenklasse als kompakter Text-Badge,
   - Quellenlink unter der Bauvorhabenbeschreibung,
   - eingeklappter Bereich für Publikationen älter als 14 Tage.

Der Quellenlink öffnet in einem neuen Tab und löst beim Anklicken nicht zusätzlich die Zeilenauswahl aus.

### Rechte Prüfung

Die vorhandene Prüfung bleibt bestehen. Im Feld `Bauvorhaben` werden zusätzlich der Grössen-Badge und darunter der Link `Originalpublikation / Dokument öffnen` angezeigt. Karte, AGIS-Daten, Empfehlung, Verlauf und interne Bearbeitung werden nicht entfernt oder strukturell verändert.

## Technische Architektur

### Abgeleitete Anzeigedaten

Region und Grössenklasse werden serverseitig aus den bestehenden Falldaten abgeleitet und als `region` und `projectScale` an das Frontend geliefert. Sie werden nicht als redundante Spalten in `applications` gespeichert.

Die fachlichen Regeln liegen in einem kleinen, eigenständig testbaren Modul. Dadurch können Gemeindezuordnungen und Schlüsselwörter später angepasst werden, ohne vorhandene Fälle migrieren zu müssen.

### Gelesen-Markierungen

Eine neue Tabelle `application_reads` enthält mindestens:

- `user_id`,
- `application_id`,
- `read_at`.

`user_id` und `application_id` bilden gemeinsam den eindeutigen Schlüssel. Beide Fremdschlüssel verwenden `ON DELETE CASCADE`.

Die Listen-API ergänzt pro Fall `isUnread`. Ein idempotenter Endpunkt markiert den Fall beim Öffnen als gelesen. Wiederholtes Öffnen ändert das Ergebnis nicht und erzeugt keine Duplikate.

### Bereinigung

Die bestehende Bereinigungslogik wird an die bestätigte Regel angepasst:

- keine Aufbewahrungsfrist nach dem Fristende,
- keine Ausnahme für bearbeitete Fälle,
- keine Ausnahme für Kommentare oder Zuständigkeiten,
- Löschung, wenn `deadline_date < heute`,
- Ausführung beim Serverstart, nach einer erfolgreichen Synchronisierung und danach über die tägliche Wartung.

Die Löschung erfolgt in einer Datenbanktransaktion. Abhängige Datensätze werden über Fremdschlüssel-Kaskaden entfernt.

## Datenfluss

1. Synchronisierung importiert oder aktualisiert einen Fall mit Publikations- und Fristdatum.
2. Die API liest den Fall und ergänzt Region, Grössenklasse und benutzerspezifischen Gelesen-Status.
3. Das Frontend kombiniert Hauptreiter, Regionsfilter und bestehende Filter.
4. Das Frontend sortiert nach Publikationsdatum und trennt die ersten 14 Tage vom eingeklappten älteren Bereich.
5. Beim Öffnen sendet das Frontend die Gelesen-Markierung und aktualisiert die Zeile ohne vollständiges Neuladen.
6. Die Wartung löscht abgelaufene Fälle und alle abhängigen Daten.

## Fehlerfälle

- Fehlende Frist: Fall bleibt erhalten und wird als unvollständig gekennzeichnet.
- Unbekannte Gemeinde: keine erfundene Region; der Fall bleibt ohne aktiven Regionsfilter sichtbar.
- Fehlende oder ungültige Quellen-URL: kein toter Link; stattdessen neutraler Hinweis `Keine direkte Quelle verfügbar`.
- Fehler beim Markieren als gelesen: Die Detailansicht öffnet trotzdem; die Zeile bleibt bis zum nächsten erfolgreichen Versuch ungelesen.
- Fehler bei der Bereinigung: Transaktion wird zurückgerollt und der Fehler wird protokolliert; es gibt keine teilweise Löschung.

## Tests und Abnahme

### Automatisierte Tests

- Regionenzuordnung für repräsentative Gemeinden aller vier Regionen sowie unbekannte Gemeinden.
- Grössenklassifikation mit grossen, mittleren, kleinen und unklaren Vorhaben.
- Gelesen-Status ist pro Benutzer getrennt und der Markierungsendpunkt ist idempotent.
- Fristtag bleibt sichtbar; ab dem Folgetag werden Fall und abhängige Daten gelöscht.
- Fälle ohne Frist werden nicht gelöscht.
- `Arbeitsliste` und `Schutztreffer` kombinieren sich korrekt mit null, einer oder mehreren Regionen.
- 14-Tage-Trennung basiert auf `publication_date` und sortiert jeweils neueste zuerst.
- Quellenlink und Grössen-Badge erscheinen in Liste und Detailansicht.

### Browserprüfung

- Bestehende Suche und Auswahlfilter funktionieren weiterhin.
- Rechte Detailansicht, Karte, Einschätzung, Verlauf und Bearbeitung bleiben bedienbar.
- Ungelesene Hervorhebung verschwindet nach dem ersten Öffnen nur beim aktuellen Benutzer.
- `Mehr anzeigen` ist per Tastatur bedienbar und kündigt den erweiterten Zustand zugänglich an.
- Quellenlinks öffnen in einem neuen Tab, ohne die falsche Tabellenzeile zu öffnen.

## Nicht Bestandteil

- Keine Entfernung der bestehenden rechten Prüfung oder ihrer Funktionen.
- Keine manuelle Korrektur der automatischen Grössenklasse in dieser Ausbaustufe.
- Keine neue Archivansicht.
- Keine Wiederherstellung gelöschter Fälle über die Benutzeroberfläche.
