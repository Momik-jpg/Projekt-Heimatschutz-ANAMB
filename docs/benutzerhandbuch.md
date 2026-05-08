# Benutzerhandbuch

## Zweck

Die Anwendung unterstützt den Heimatschutz Aargau bei der internen Bearbeitung von Baugesuchen. Sie sammelt offizielle Publikationen, zeigt den automatischen AGIS-Treffer an und erlaubt die Team-Bearbeitung direkt im selben Fall.

## Rollen

### Teamkonto

Normale Teamkonten können:
- sich anmelden
- Baugesuche suchen und filtern
- die Detailansicht und Karte lesen
- Notizen speichern
- Team-Status ändern
- Kommentare hinterlassen

### Master-Konto

Das Master-Konto kann zusätzlich:
- Registrierungsschlüssel erstellen und löschen
- Team-Passwörter zurücksetzen
- JSON-Exporte importieren
- automatische Importquellen speichern
- Gemeindequellen für den Kanton Aargau pflegen

## Anmeldung

1. Seite öffnen.
2. Benutzernamen eingeben.
3. Passwort eingeben.
4. Optional `Benutzername merken` aktivieren.
5. `Anmelden` klicken.

Wenn ein Passwort vergessen wurde, setzt das Master-Konto ein neues Passwort.

## Registrierung

Neue Konten können nur mit einem gültigen Registrierungsschlüssel erstellt werden.

1. Im Bereich `Neues Konto` Namen, Benutzernamen und Passwort eingeben.
2. Registrierungsschlüssel eintragen.
3. `Konto erstellen` klicken.

Der Schlüssel ist einmalig und wird nach der ersten Verwendung verbraucht.

## Aufbau der Arbeitsoberfläche

### Oberer Bereich

Oben stehen:
- die Hauptnavigation der Arbeitsoberfläche
- Suche und Filter
- Schnellauswahl wie `Arbeitsliste`, `Schutztreffer`, `Von Hand prüfen`, `Nur offen`, `Frist bald`
- Statuschips wie letzter Sync und aktive Gemeindequellen

### Linke Seite: Arbeitsliste

Die Arbeitsliste zeigt pro Fall:
- Gemeinde
- Baugesuch
- AGIS-Treffer
- Frist
- Bearbeitung

Die Standardansicht zeigt nur aktuelle und offene Fälle. Aeltere oder erledigte Fälle treten in den Hintergrund.

### Rechte Seite: Detailansicht

Die Detailansicht zeigt:
- Ort
- Adresse oder Parzelle
- Bauvorhaben
- Fristende
- Karte
- Einschätzung
- interne Notiz
- Team-Status
- Zuständigkeit
- Team-Austausch

## Bedeutung der AGIS-Treffer

### `Gebäude geschützt`

Der Standort liegt bei einem geschützten Inventarobjekt.

### `Gebiet geschützt`

Der Standort liegt in einer geschützten Fläche oder einem amtlich erfassten Bereich.

### `Gebäude + Gebiet`

Der Standort trifft gleichzeitig auf ein Inventarobjekt und eine geschützte Fläche.

### `Kein Schutz gefunden`

Am Standort wurde aktuell kein AGIS-Treffer für Inventarobjekt oder Schutzzone gefunden.

### `Adresse prüfen`

Die Adresse ist vorhanden, konnte aber nicht automatisch eindeutig einem amtlichen Standortpunkt zugeordnet werden. Der Fall ist nicht kaputt; die Adresse oder Parzelle muss einfach kurz geprüft werden.

### `Manuell prüfen`

Es liegt keine genug genaue amtliche Standortangabe vor. Typische Gründe:
- nur Parzelle publiziert
- keine Hausnummer vorhanden
- Gemeinde publiziert unvollständig
- nicht digitalisierte oder schlecht strukturierte Quelle

## Karte

Die Karte zeigt je nach Fall:
- blauen Standortpunkt für das Baugesuch
- rote Punkte für Inventarobjekte
- gruene und violette Zonen für amtliche Schutzflächen

Wenn kein exakter Standort vorliegt, erscheint statt einer falschen Karte ein klarer Hinweis.

### Kartenlegende

- Blau: Baugesuch-Standort
- Rot: Inventarobjekte
- Gruen: Ortsbild in der Gemeinde
- Hellviolett: Ortsbildteile
- Dunkelviolett: Hinweiszonen
- Graubraun gestrichelt: PDF-Perimeter

### Kartenlinks

`Karte öffnen`:
- öffnet die offizielle AGIS-/Onlinekarten-Ansicht am passenden Ort

`Quelle öffnen`:
- öffnet die offizielle Publikationsquelle der Gemeinde

## Typischer Arbeitsablauf

1. In der Arbeitsliste einen Fall auswählen.
2. Rechts Bauvorhaben, Frist und AGIS-Treffer lesen.
3. Karte und Quelle prüfen.
4. Interne Notiz erfassen.
5. Team-Status setzen.
6. Bei Bedarf Kommentar hinterlassen.
7. Fall gespeichert lassen oder als erledigt markieren.

## Filter und Schnellauswahl

### Suche

Die Suche durchsucht:
- Gemeinde
- Adresse
- Bauvorhaben

### Ort

Filtert auf eine bestimmte Gemeinde.

### AGIS-Treffer

Filtert auf den aktuellen gespeicherten AGIS-Status.

### Team-Status

Filtert auf interne Bearbeitungszustände.

### Schnellauswahl

Mehrere Schnellfilter können gleichzeitig aktiv sein.

Beispiele:
- `Schutztreffer` + `Nur offen`
- `Von Hand prüfen` + `Frist bald`

`Arbeitsliste` setzt die Schnellauswahl wieder auf die Standardansicht.

## Interne Bearbeitung

### Team-Status

Mögliche Werte:
- `Offen`
- `Im Team`
- `Erledigt`
- `Abgelegt`

### Zuständig

Hier kann eine Person oder ein Team eingetragen werden.

### Interne Notiz

Die interne Notiz ist für die fachliche Bearbeitung des Falls gedacht. Sie bleibt am Fall gespeichert.

### Team-Austausch

Der Team-Austausch ist der Kommentarbereich zum Fall. Er wird bei Bedarf aufgeklappt.

## Master-Bereich

Der Master-Bereich ist standardmässig eingeklappt und wird über `Verwaltung einblenden` geöffnet.

### Registrierungsschlüssel

Hier erstellt das Master-Konto neue Schlüssel für Mitarbeitende.

### Passwort zurücksetzen

Hier setzt das Master-Konto für ein Teammitglied ein neues Passwort.

### Datenimport

JSON-Exporte aus offiziellen Quellen können direkt importiert werden.

Unterstützte Formate:
- JSON mit `items`
- JSON mit `features`
- ArcGIS-ähnliche Exporte
- GeoJSON-ähnliche Exporte

### Automatischer Import

Hier kann eine feste Importquelle hinterlegt werden:
- JSON-URL
- ArcGIS-/AGIS-Dienst
- optional mit Token

Danach kann die App:
- die Quelle sofort testen
- oder automatisch wöchentlich synchronisieren

### Gemeindequellen Aargau

Für jede Gemeinde können Quellentyp, URL und automatische Beruecksichtigung gepflegt werden.

Mögliche Quellentypen:
- `Gemeinde-Webseite`
- `XML / RSS / Sitemap`
- `JSON-Datei`
- `Direkte PDF-Quelle`
- `ArcGIS / AGIS`
- `Manuell`

Zusätzlich zeigt der Verwaltungsbereich:
- offizielle Gemeinde-Website
- Primärquelle
- Rating `A/B/C/D`
- Begründung
- gemeinsame Quellen

Über die Export-Buttons kann der komplette Katalog als `JSON` oder `CSV` heruntergeladen werden.

## Grenzen

- Nicht jede Gemeinde publiziert gleich gut strukturierte Baugesuch-Daten.
- `Adresse prüfen` und `Manuell prüfen` werden deshalb auch im produktiven Betrieb weiter vorkommen.
- Die interne Karte ist die verlaesslichste Darstellung. Externe Kartenlinks öffnen die offizielle Seite, die ihre Marker und Layer anders darstellen kann.
- Vollautomatischer Import aus einer geschützten kantonalen Quelle ist technisch vorbereitet, braucht aber eine echte Freigabe oder einen Token.

## Weiterführende Dokumente

- [abschlussdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/abschlussdokumentation.md)
- [systemdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/systemdokumentation.md)
- [prüfprotokoll.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/prüfprotokoll.md)
