# Release-Checkliste

## Vor dem Veröffentlichen

1. `npm test` lokal ausführen.
2. Prüfen, ob Login, Liste, Detailansicht und Karte im Browser funktionieren.
3. Produktives Passwort setzen:
   - `MASTER_ACCOUNT_PASSWORD` in der Hosting-Umgebung setzen
   - `DEFAULT_LOGIN_PASSWORD` in der Hosting-Umgebung setzen
   - das Demo-Passwort nicht weiterverwenden
4. Produktiven Datenpfad setzen:
   - `DATABASE_PATH=/data/heimatschutz.sqlite`
5. Sicherstellen, dass der Server über HTTPS erreichbar ist.
6. Prüfen, ob AGIS-Abfragen vom Server aus erreichbar sind.

## Für den ersten Live-Start

1. Mit dem Master-Konto `master` anmelden.
2. Einen Registrierungsschlüssel erstellen.
3. Einen neuen Benutzer mit diesem Registrierungsschlüssel registrieren.
4. Einen Fall öffnen.
5. Eine Notiz speichern.
6. Einen Team-Kommentar speichern.
7. Abmelden und erneut anmelden.
8. Prüfen, ob die gespeicherte Änderung erhalten bleibt.
9. Server neu starten und prüfen, ob die Sitzung weiter funktioniert.

## Aktuelle Restpunkte

- Sitzungen werden in SQLite gespeichert und bleiben über Neustarts erhalten.
- Die Baugesuch-Liste links basiert weiterhin auf der gespeicherten Vorprüfung.
  Die Live-AGIS-Prüfung wird rechts für den ausgewählten Fall ausgeführt.
- Der Amtsblatt-Import ist im Prototyp weiterhin demo-basiert.

## Hosting-Entscheid

- Für eine kostenlose Demo kann Koyeb verwendet werden, aber ohne dauerhaft garantierte SQLite-Daten.
- Für den echten internen Pilot mit gespeicherten Teamdaten ist Railway mit Volume die empfohlene Variante.
