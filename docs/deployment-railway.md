# Deployment auf Railway

## Wann dieser Weg sinnvoll ist

Dieser Weg ist für den echten internen Pilot die empfohlene Variante.

Diese Anwendung verwendet aktuell SQLite. Dafür braucht der Server einen persistenten Speicherort für die Datei `heimatschutz.sqlite`.

Für den aktuellen Projektstand ist Railway am passendsten, weil:
- Docker-Deploys einfach unterstützt werden
- persistente Volumes unterstützt werden
- die App mit einer einzelnen Node-Webanwendung laufen kann

Wichtig: Railway ist für diesen Stand technisch passend, aber nicht dauerhaft gratis.

## Vorbereitung

Im Projekt sind bereits enthalten:
- `Dockerfile`
- `.dockerignore`
- `.env.example`

## Schritte

1. Repository zu GitHub pushen.
2. Auf Railway ein neues Projekt aus dem GitHub-Repository erstellen.
3. Einen Volume-Mount anlegen.
   Mount-Pfad: `/data`
4. Diese Umgebungsvariablen setzen:
   - `NODE_ENV=production`
   - `PORT=3000`
   - `DATABASE_PATH=/data/heimatschutz.sqlite`
   - `MASTER_ACCOUNT_PASSWORD=<eigenes sicheres Master-Passwort>`
   - `DEFAULT_LOGIN_PASSWORD=<eigenes sicheres Passwort>`
   - optional: `SEED_USER_PASSWORDS_JSON=<JSON mit individuellen Startpasswörtern>`
   - optional für echten Wochen-Sync: `SYNC_SOURCE_URL=<URL der externen JSON-API>`
   - optional für geschützte AGIS-/ArcGIS-Quellen: `SYNC_SOURCE_TOKEN=<Zugriffstoken>`
   - optional: `AUTO_SYNC_ENABLED=true`
   - optional: `AUTO_SYNC_INTERVAL_HOURS=168`
   - optional: `AUTO_SYNC_RUN_ON_START=true`
5. Die Anwendung deployen.
6. Nach dem ersten Start unter der Railway-URL anmelden und einen Testfall speichern.

## Wichtige Hinweise

- Ohne Volume würde die SQLite-Datei bei Neu-Deploys oder Neustarts verloren gehen.
- Im Produktionsmodus startet der Server nicht, wenn `MASTER_ACCOUNT_PASSWORD` oder `DEFAULT_LOGIN_PASSWORD` noch auf Platzhalter- oder Standardwerten stehen.
- Wenn bereits unterschiedliche Startpasswörter vergeben werden sollen, ist `SEED_USER_PASSWORDS_JSON` die sauberste Variante für den ersten Start.
- Bei einem Server-Neustart bleiben Daten, Benutzerkonten, Team-Kommentare und Sitzungen erhalten, solange das Volume bestehen bleibt.
- Registrierung neuer Benutzer funktioniert nur mit Schlüsseln, die das Master-Konto erstellt hat.
- Wenn `SYNC_SOURCE_URL` gesetzt ist, holt die App die Daten automatisch wöchentlich und speichert den letzten Sync-Status in SQLite.
- Für geschützte AGIS-/ArcGIS-Dienste kann zusätzlich `SYNC_SOURCE_TOKEN` gesetzt werden.
- Platzhalter-URLs für `SYNC_SOURCE_URL` werden ignoriert, bis eine echte Quelle hinterlegt ist.

## Nicht empfohlen für den aktuellen Stand

### GitHub Pages

Nicht geeignet, weil die Anwendung ein Node-Backend und eine Datenbank braucht.

### Render ohne Disk

Nicht geeignet, wenn Änderungen dauerhaft gespeichert werden sollen, weil nur Daten auf der gemounteten Disk dauerhaft bleiben.

### Koyeb Free für Team-Betrieb

Für eine kostenlose Demo ist Koyeb möglich. Für einen echten Team-Betrieb mit dauerhaft gespeicherten Daten ist der Gratis-Weg jedoch nicht geeignet, weil das aktuelle SQLite-Setup dort ohne persistentes Volume läuft.
