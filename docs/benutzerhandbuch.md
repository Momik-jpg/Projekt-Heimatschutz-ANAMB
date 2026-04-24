# Benutzerhandbuch

## Zweck

Die Anwendung unterstuetzt den Heimatschutz Aargau bei der internen Bearbeitung von Baugesuchen. Sie sammelt offizielle Publikationen, zeigt den automatischen AGIS-Treffer an und erlaubt die Team-Bearbeitung direkt im selben Fall.

## Rollen

### Teamkonto

Normale Teamkonten koennen:
- sich anmelden
- Baugesuche suchen und filtern
- die Detailansicht und Karte lesen
- Notizen speichern
- Team-Status aendern
- Kommentare hinterlassen

### Master-Konto

Das Master-Konto kann zusaetzlich:
- Registrierungsschluessel erstellen und loeschen
- Team-Passwoerter zuruecksetzen
- JSON-Exporte importieren
- automatische Importquellen speichern
- Gemeindequellen fuer den Kanton Aargau pflegen

## Anmeldung

1. Seite oeffnen.
2. Benutzernamen eingeben.
3. Passwort eingeben.
4. Optional `Benutzername merken` aktivieren.
5. `Anmelden` klicken.

Wenn ein Passwort vergessen wurde, setzt das Master-Konto ein neues Passwort.

## Registrierung

Neue Konten koennen nur mit einem gueltigen Registrierungsschluessel erstellt werden.

1. Im Bereich `Neues Konto` Namen, Benutzernamen und Passwort eingeben.
2. Registrierungsschluessel eintragen.
3. `Konto erstellen` klicken.

Der Schluessel ist einmalig und wird nach der ersten Verwendung verbraucht.

## Aufbau der Arbeitsoberflaeche

### Oberer Bereich

Oben stehen:
- die Hauptnavigation der Arbeitsoberflaeche
- Suche und Filter
- Schnellauswahl wie `Arbeitsliste`, `Schutztreffer`, `Von Hand pruefen`, `Nur offen`, `Frist bald`
- Statuschips wie letzter Sync und aktive Gemeindequellen

### Linke Seite: Arbeitsliste

Die Arbeitsliste zeigt pro Fall:
- Gemeinde
- Baugesuch
- AGIS-Treffer
- Frist
- Bearbeitung

Die Standardansicht zeigt nur aktuelle und offene Faelle. Aeltere oder erledigte Faelle treten in den Hintergrund.

### Rechte Seite: Detailansicht

Die Detailansicht zeigt:
- Ort
- Adresse oder Parzelle
- Bauvorhaben
- Fristende
- Karte
- Einschaetzung
- interne Notiz
- Team-Status
- Zustaendigkeit
- Team-Austausch

## Bedeutung der AGIS-Treffer

### `Gebaeude geschuetzt`

Der Standort liegt bei einem geschuetzten Inventarobjekt.

### `Gebiet geschuetzt`

Der Standort liegt in einer geschuetzten Flaeche oder einem amtlich erfassten Bereich.

### `Gebaeude + Gebiet`

Der Standort trifft gleichzeitig auf ein Inventarobjekt und eine geschuetzte Flaeche.

### `Kein Schutz gefunden`

Am Standort wurde aktuell kein AGIS-Treffer fuer Inventarobjekt oder Schutzzone gefunden.

### `Adresse pruefen`

Die Adresse ist vorhanden, konnte aber nicht automatisch eindeutig einem amtlichen Standortpunkt zugeordnet werden. Der Fall ist nicht kaputt; die Adresse oder Parzelle muss einfach kurz geprueft werden.

### `Manuell pruefen`

Es liegt keine genug genaue amtliche Standortangabe vor. Typische Gruende:
- nur Parzelle publiziert
- keine Hausnummer vorhanden
- Gemeinde publiziert unvollstaendig
- nicht digitalisierte oder schlecht strukturierte Quelle

## Karte

Die Karte zeigt je nach Fall:
- blauen Standortpunkt fuer das Baugesuch
- rote Punkte fuer Inventarobjekte
- gruene und violette Zonen fuer amtliche Schutzflaechen

Wenn kein exakter Standort vorliegt, erscheint statt einer falschen Karte ein klarer Hinweis.

### Kartenlegende

- Blau: Baugesuch-Standort
- Rot: Inventarobjekte
- Gruen: Ortsbild in der Gemeinde
- Hellviolett: Ortsbildteile
- Dunkelviolett: Hinweiszonen
- Graubraun gestrichelt: PDF-Perimeter

### Kartenlinks

`Karte oeffnen`:
- oeffnet die offizielle AGIS-/Onlinekarten-Ansicht am passenden Ort

`Quelle oeffnen`:
- oeffnet die offizielle Publikationsquelle der Gemeinde

## Typischer Arbeitsablauf

1. In der Arbeitsliste einen Fall auswaehlen.
2. Rechts Bauvorhaben, Frist und AGIS-Treffer lesen.
3. Karte und Quelle pruefen.
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

Filtert auf interne Bearbeitungszustaende.

### Schnellauswahl

Mehrere Schnellfilter koennen gleichzeitig aktiv sein.

Beispiele:
- `Schutztreffer` + `Nur offen`
- `Von Hand pruefen` + `Frist bald`

`Arbeitsliste` setzt die Schnellauswahl wieder auf die Standardansicht.

## Interne Bearbeitung

### Team-Status

Moegliche Werte:
- `Offen`
- `Im Team`
- `Erledigt`
- `Abgelegt`

### Zustaendig

Hier kann eine Person oder ein Team eingetragen werden.

### Interne Notiz

Die interne Notiz ist fuer die fachliche Bearbeitung des Falls gedacht. Sie bleibt am Fall gespeichert.

### Team-Austausch

Der Team-Austausch ist der Kommentarbereich zum Fall. Er wird bei Bedarf aufgeklappt.

## Master-Bereich

Der Master-Bereich ist standardmaessig eingeklappt und wird ueber `Verwaltung einblenden` geoeffnet.

### Registrierungsschluessel

Hier erstellt das Master-Konto neue Schluessel fuer Mitarbeitende.

### Passwort zuruecksetzen

Hier setzt das Master-Konto fuer ein Teammitglied ein neues Passwort.

### Datenimport

JSON-Exporte aus offiziellen Quellen koennen direkt importiert werden.

Unterstuetzte Formate:
- JSON mit `items`
- JSON mit `features`
- ArcGIS-aehnliche Exporte
- GeoJSON-aehnliche Exporte

### Automatischer Import

Hier kann eine feste Importquelle hinterlegt werden:
- JSON-URL
- ArcGIS-/AGIS-Dienst
- optional mit Token

Danach kann die App:
- die Quelle sofort testen
- oder automatisch woechentlich synchronisieren

### Gemeindequellen Aargau

Fuer jede Gemeinde koennen Quellentyp, URL und automatische Beruecksichtigung gepflegt werden.

Moegliche Quellentypen:
- `Gemeinde-Webseite`
- `XML / RSS / Sitemap`
- `JSON-Datei`
- `Direkte PDF-Quelle`
- `ArcGIS / AGIS`
- `Manuell`

Zusaetzlich zeigt der Verwaltungsbereich:
- offizielle Gemeinde-Website
- Primaerquelle
- Rating `A/B/C/D`
- Begruendung
- gemeinsame Quellen

Ueber die Export-Buttons kann der komplette Katalog als `JSON` oder `CSV` heruntergeladen werden.

## Grenzen

- Nicht jede Gemeinde publiziert gleich gut strukturierte Baugesuch-Daten.
- `Adresse pruefen` und `Manuell pruefen` werden deshalb auch im produktiven Betrieb weiter vorkommen.
- Die interne Karte ist die verlaesslichste Darstellung. Externe Kartenlinks oeffnen die offizielle Seite, die ihre Marker und Layer anders darstellen kann.
- Vollautomatischer Import aus einer geschuetzten kantonalen Quelle ist technisch vorbereitet, braucht aber eine echte Freigabe oder einen Token.

## Weiterfuehrende Dokumente

- [abschlussdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/abschlussdokumentation.md)
- [systemdokumentation.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/systemdokumentation.md)
- [pruefprotokoll.md](C:/Users/Andrin/OneDrive%20-%20Alte%20Kantonsschule%20Aarau/Desktop/xxxx/repo/docs/pruefprotokoll.md)
