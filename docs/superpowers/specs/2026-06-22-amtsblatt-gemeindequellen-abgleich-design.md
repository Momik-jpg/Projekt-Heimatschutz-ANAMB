# Design: Belegter Abgleich von Amtsblatt und Gemeindequellen

## Ziel

Die aktive Arbeitsliste enthält nur Baugesuche mit einem ausdrücklich belegten Publikationsdatum. Das Amtsblatt Aargau ist die verbindliche Hauptquelle. Offizielle Gemeindequellen dienen als Kontrolle, zur Ergänzung fehlender Falldetails und als Fallback, wenn ein amtliches Baugesuch im Amtsblatt nicht gefunden wird.

Es werden keine Daten erfunden, geschätzt oder aus anderen Feldern zurückgerechnet. Insbesondere wird ein Publikationsdatum niemals aus einer Einsprachefrist, einem Importzeitpunkt oder einem ähnlichen Datum abgeleitet.

## Verbindliche Fachregeln

1. Das Amtsblatt hat bei widersprüchlichen Publikationsdaten Vorrang.
2. Ein Publikationsdatum wird nur übernommen, wenn es in einer abgerufenen offiziellen Quelle ausdrücklich vorkommt.
3. Eine offizielle Gemeindequelle darf einen Fall ohne Amtsblatt-Treffer liefern, wenn sie selbst ein eindeutiges Publikationsdatum nennt.
4. Ein Fall ohne belegtes Publikationsdatum erscheint nicht in der aktiven Arbeitsliste und nicht in deren Zählern.
5. Fehlende Werte werden nicht aus Fristen, Nachbarfällen, URL-Daten, Importzeitpunkten oder üblichen Verfahrensdauern berechnet.
6. Unsichere Zuordnungen werden nicht automatisch zusammengeführt.
7. Alle beteiligten Quellnachweise bleiben am Fall erhalten.

## Quellenrollen

### Amtsblatt Aargau

Das Amtsblatt ist die kanonische Quelle für:

- Publikationsdatum,
- amtliche Referenz und Original-URL,
- Gemeinde,
- im Amtsblatt ausdrücklich genannte Frist,
- im Amtsblatt ausdrücklich genannte Parzelle, Adresse und Bauvorhaben.

Fehlt ein Wert im Amtsblatt, wird er nicht ergänzt, ausser eine offizielle Gemeindequelle belegt ihn ausdrücklich.

### Offizielle Gemeindequelle

Eine Gemeindequelle kann:

- einen Amtsblatt-Fall bestätigen,
- genauere Adress-, Parzellen- oder Projektangaben ergänzen,
- eine ausdrücklich genannte Frist ergänzen,
- einen amtlichen Gemeindefall mit ausdrücklich genanntem Publikationsdatum als Fallback liefern.

Bei abweichenden, bereits belegten Werten überschreibt die Gemeindequelle das Amtsblatt nicht. Die Abweichung wird für die manuelle Kontrolle festgehalten.

### Nicht belastbare Quellen

Folgende Werte werden nicht als Beleg akzeptiert:

- Suchtreffer-Snippets,
- automatisch erratene Daten,
- Datumswerte aus URL-Pfaden ohne ausdrücklichen Seitenbeleg,
- aus der Frist zurückgerechnete Publikationsdaten,
- allgemeine Gemeinde-Startseiten ohne konkreten Baugesuchseintrag,
- login-geschützte Portale, deren konkrete Publikation nicht eingesehen werden konnte.

## Quellenabdeckung

Der Live-Audit vom 22. Juni 2026 prüfte 196 Gemeinden und 2'128 eindeutige URLs. Alle 19 deaktivierten Gemeindequellen sind über das erreichbare kantonale Amtsblatt abgedeckt.

Für Riniken wurde mit `https://www.riniken.ch/amtliche-publikationen/` eine dauerhafte offizielle Publikationsliste gefunden. Die übrigen neu gefundenen Treffer waren einzelne Publikationen, allgemeine Navigationsseiten oder geschützte eBau-Seiten und werden nicht blind als dauerhafte Synchronisationsquellen aktiviert.

Das Amtsblatt bleibt deshalb für alle Gemeinden aktiv. Zusätzliche Gemeindequellen werden nur aktiviert, wenn eine stabile offizielle Listen-, Feed- oder Publikationsseite nachgewiesen und mit einem Live-Test bestätigt ist.

## Datenmodell

### Kanonischer Fall

Die bestehende Tabelle `applications` bleibt die Arbeitsansicht eines zusammengeführten Falls. Sie enthält die kanonischen Werte, die anhand der Quellenpriorität ausgewählt wurden.

### Quellnachweise

Eine neue Tabelle `application_source_evidence` speichert pro Fall beliebig viele Nachweise:

- `id`,
- `application_id`,
- `source_kind` (`amtsblatt` oder `municipality`),
- `source_name`,
- `source_reference`,
- `source_url`,
- `municipality`,
- ausdrücklich belegtes `publication_date`,
- ausdrücklich belegtes `deadline_date`,
- ausdrücklich belegte Adresse, Parzelle und Projektbezeichnung,
- `observed_at`,
- `match_status` (`matched`, `unmatched` oder `conflict`).

`source_kind` und `source_reference` bilden gemeinsam einen eindeutigen Schlüssel. Ein Nachweis wird aktualisiert, aber nicht als neuer Fall dupliziert.

### Abgleichstatus

Der kanonische Fall erhält einen abgeleiteten Status:

- `amtsblatt-confirmed`: Amtsblatt-Nachweis vorhanden,
- `municipality-only`: nur eine offizielle Gemeindequelle mit belegtem Publikationsdatum vorhanden,
- `conflict-review`: belegte Quellen widersprechen sich,
- `missing-publication`: kein belegtes Publikationsdatum vorhanden; nicht aktiv.

## Deterministischer Abgleich

Der Abgleich arbeitet in dieser Reihenfolge:

1. Exakte bekannte Quellreferenz.
2. Gleiche Gemeinde und gleiches belegtes Publikationsdatum sowie exakt normalisierte Parzelle.
3. Gleiche Gemeinde und gleiches belegtes Publikationsdatum sowie exakt normalisierte vollständige Adresse.
4. Wenn eine Quelle kein Publikationsdatum enthält: gleiche Gemeinde, exakt normalisierte Parzelle und übereinstimmende normalisierte Projektbezeichnung.
5. Alternativ: gleiche Gemeinde, exakt normalisierte vollständige Adresse und übereinstimmende normalisierte Projektbezeichnung.

Eine Zuordnung nach Schritt 4 oder 5 ist nur zulässig, wenn mindestens zwei unabhängige Sachmerkmale übereinstimmen. Teilwortähnlichkeit, räumliche Nähe oder eine ähnliche Projektkategorie reichen allein nicht aus.

Gibt es mehrere mögliche Treffer oder widersprüchliche Sachmerkmale, erfolgt keine automatische Zusammenführung. Der neue Nachweis wird als ungeklärt gespeichert und der Fall bleibt ausserhalb der aktiven Liste, bis ein eindeutiger Beleg vorliegt.

## Zusammenführung

Bei einer eindeutigen Zuordnung gelten folgende Prioritäten:

| Feld | Priorität |
| --- | --- |
| Publikationsdatum | ausdrücklicher Amtsblatt-Wert, sonst ausdrücklicher Gemeinde-Wert |
| Frist | ausdrücklicher Amtsblatt-Wert, sonst ausdrücklicher Gemeinde-Wert |
| Gemeinde | Amtsblatt, bei fehlendem Amtsblatt Gemeindequelle |
| Adresse, Parzelle, Projekt | fehlende Werte dürfen aus der offiziellen Gemeindequelle ergänzt werden |
| Originalquelle | Amtsblatt als Hauptlink; alle weiteren Links als Quellnachweise |

Zwei unterschiedliche, nicht leere Werte werden nicht still überschrieben. Der Amtsblatt-Wert bleibt kanonisch und die Abweichung erhält `conflict-review`.

## Gemeinde-Fallback

Ein reiner Gemeindefall wird aktiv, wenn alle folgenden Bedingungen erfüllt sind:

- offizielle Gemeinde-Domain oder nachgewiesene gemeinsame amtliche Plattform,
- konkrete Baugesuchspublikation,
- ausdrücklich genanntes und gültiges Publikationsdatum,
- Gemeinde sowie mindestens Adresse oder Parzelle,
- keine Mehrdeutigkeit zu einem vorhandenen Fall.

Der Fall wird als `municipality-only` gekennzeichnet. Sobald später ein passender Amtsblatt-Nachweis erscheint, wird er demselben Fall zugeordnet und der Status wechselt zu `amtsblatt-confirmed`.

## Aktive Arbeitsliste

Ein Fall ist nur aktiv, wenn:

- ein belegtes Publikationsdatum vorhanden ist,
- das Publikationsdatum höchstens 31 Kalendertage zurückliegt,
- der Fall nicht archiviert ist,
- der Abgleichstatus nicht `missing-publication` und nicht ungeklärt ist.

Die Liste darf nie `Frist fehlt` anzeigen, weil die angezeigte Einsprachefrist weiterhin aus der bestehenden, fachlich bestätigten Darstellungsregel zum belegten Publikationsdatum entsteht. Diese Darstellungsfrist darf nicht zurück in die Quelldaten geschrieben und nicht als amtlich belegte Frist ausgegeben werden.

## Bestehende Daten

Die vorhandenen Fälle werden einmalig durch den neuen Abgleich geführt:

1. Bestehende Amtsblatt- und Gemeindenachweise werden getrennt erfasst.
2. Eindeutige Dubletten werden zusammengeführt.
3. Teamnotizen, Zuständigkeit, Kommentare, Gelesen-Status und Verlauf bleiben vollständig erhalten.
4. Bei mehreren bearbeiteten möglichen Hauptfällen erfolgt keine automatische destruktive Zusammenführung.
5. Die vier aktuell gespeicherten Gemeindefälle ohne Publikationsdatum werden nur bei einem eindeutigen Amtsblatt-Nachweis ergänzt; andernfalls bleiben sie inaktiv.

Es wird kein bestehender Wert allein aufgrund einer Vermutung geändert oder gelöscht.

## Fehlerbehandlung und Beobachtbarkeit

- Fehler einer Gemeindequelle stoppen den Amtsblatt-Import nicht.
- Fehler des Amtsblatts werden deutlich protokolliert; Gemeinde-Fallbacks bleiben als solche gekennzeichnet.
- Jeder Sync berichtet neue, aktualisierte, zusammengeführte, ungeklärte und konfliktbehaftete Nachweise getrennt.
- Manuelle Prüfungen zeigen beide Originalquellen und die abweichenden Werte.
- Ein fehlgeschlagener Abgleich verändert keinen bestehenden kanonischen Fall.

## Tests und Abnahme

### Automatisierte Tests

- Amtsblatt und Gemeindequelle mit exakter Referenz werden einem Fall zugeordnet.
- Amtsblatt und Gemeindequelle mit Gemeinde, Publikationsdatum und Parzelle werden zusammengeführt.
- Gleiche Parzelle mit anderem Bauvorhaben wird nicht fälschlich zusammengeführt.
- Ähnliche Adressen ohne zweiten Beleg werden nicht zusammengeführt.
- Amtsblatt-Publikationsdatum gewinnt bei einem Konflikt.
- Fehlender Amtsblatt-Wert darf durch einen ausdrücklichen Gemeinde-Wert ergänzt werden.
- Publikationsdatum wird niemals aus einer Frist zurückgerechnet.
- Gemeindefall ohne belegtes Publikationsdatum bleibt inaktiv.
- Gemeindefall mit belegtem Publikationsdatum darf als `municipality-only` aktiv werden.
- Späterer Amtsblatt-Treffer ergänzt den bestehenden Gemeindefall statt einen zweiten Fall anzulegen.
- Teamdaten bleiben bei einer eindeutigen Bestandszusammenführung erhalten.
- Mehrdeutige Bestandsfälle werden nicht automatisch destruktiv zusammengeführt.

### Live- und Browserprüfung

- Amtsblatt und aktivierte Gemeindequellen laufen im selben Synchronisationslauf.
- Die aktive Liste enthält keinen Fall ohne Publikationsdatum.
- Ein reiner Gemeindefall ist sichtbar als solcher gekennzeichnet.
- Beide Originalquellen sind in der Detailansicht zugänglich.
- Konfliktfälle zeigen die abweichenden Belege, ohne erfundene Auflösung.

## Nicht Bestandteil

- Kein KI-basiertes Erfinden oder Ergänzen fehlender Fachwerte.
- Kein Rückrechnen von Publikationsdaten aus Fristen.
- Kein automatischer Merge allein aufgrund ungefähr ähnlicher Texte.
- Kein Scraping login-geschützter Inhalte ohne regulären, ausdrücklich eingerichteten Zugang.
- Keine blinde Aktivierung einzelner oder instabiler Publikations-URLs.
