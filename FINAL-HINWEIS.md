# Finaler Ordner

Dies ist der bereinigte Übergabeordner der Anwendung.

Enthalten sind nur die für Betrieb, Prüfung und Dokumentation relevanten Bestandteile:

- `public/`
- `server/`
- `tests/`
- `docs/`
- `package.json`
- `package-lock.json`
- `Dockerfile`
- `.env.example`
- `.gitignore`
- `.dockerignore`
- leeres `data/`-Verzeichnis für die SQLite-Datenbank

Nicht enthalten sind absichtlich:

- `node_modules/`
- lokale Temp-Dateien
- Recherche-Exports
- Mockup- und Zwischenstände
- Output-/Scrape-Artefakte

## Lokal starten

```powershell
npm install
$env:MASTER_ACCOUNT_PASSWORD="LokalesMasterPasswort_2026!"
$env:DEFAULT_LOGIN_PASSWORD="LokalesTeamPasswort_2026!"
npm start
```

Danach läuft die App unter:

- `http://localhost:3000`
- `http://localhost:3000/health`

## Wichtig

Für Railway produktive Werte setzen:

```env
DATABASE_PATH=/data/heimatschutz.sqlite
NODE_ENV=production
PORT=3000
MASTER_ACCOUNT_PASSWORD=...
DEFAULT_LOGIN_PASSWORD=...
```
