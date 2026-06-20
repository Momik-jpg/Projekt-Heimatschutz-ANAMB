# Hosting: Docker + Cloudflare Tunnel

Die App ist hosting-neutral (Docker/VPS/lokal). Empfohlen wird der Betrieb als
Container mit **Cloudflare davor via Tunnel** – so liegt kein Port offen am
Server, und Cloudflare liefert TLS, WAF, CDN und DDoS-Schutz. Es gibt keine
Railway-spezifischen Abhängigkeiten.

## 1. Voraussetzungen

- Docker + Docker Compose
- Node.js-Stack bleibt unverändert (Node 24, `node:sqlite`, nodemailer).
- Eine `.env` (Vorlage: `.env.example`). **Mindestens setzen:**
  - `MASTER_ACCOUNT_PASSWORD` **oder** `MASTER_SETUP_EMAIL` + `SMTP_*`
  - `TOKEN_ENCRYPTION_KEY` (Quell-Tokens werden sonst nur im Klartext gespeichert)

Schlüssel erzeugen:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## 2. Nur Docker (lokal / VPS-intern)

```bash
cp .env.example .env   # ausfüllen
docker compose up -d --build app
# Healthcheck:
curl -fsS http://127.0.0.1:3000/api/health
```

Die SQLite-Datenbank liegt im benannten Volume `hsa-data` (`/data` im Container).
Der Port ist nur an `127.0.0.1` gebunden, also nicht öffentlich.

## 3. Mit Cloudflare Tunnel (öffentlich, empfohlen)

1. In **Cloudflare Zero Trust → Networks → Tunnels** einen Tunnel anlegen,
   den **Tunnel-Token** kopieren und als `CLOUDFLARE_TUNNEL_TOKEN` in `.env` setzen.
2. Im Tunnel einen **Public Hostname** anlegen (z. B. `heimatschutz.example.ch`)
   und als Service **`http://app:3000`** eintragen (Compose-internes Netz).
3. Starten:

```bash
docker compose up -d --build
```

`cloudflared` verbindet sich ausgehend mit Cloudflare; am Server muss **kein
Port** geöffnet werden. Für rein internen Betrieb den `cloudflared`-Dienst
weglassen (`docker compose up -d --build app`).

## 4. Updates & Backups

```bash
git pull
docker compose up -d --build
```

- Datenmigrationen laufen einmalig und brechen bei fehlgeschlagenem Backup ab.
- Automatische SQLite-Backups optional über `BACKUP_ENABLED=true` (`BACKUP_DIR`,
  `BACKUP_RETENTION`); das Volume `hsa-data` zusätzlich extern sichern.

## 5. Sicherheitshinweise

- `TOKEN_ENCRYPTION_KEY` und alle Passwörter als echte Secrets verwalten, nicht
  im Image. `.env` ist in `.gitignore`.
- Cloudflare WAF/Rate-Limiting zusätzlich aktivieren; die App bringt eigene
  Rate-Limits (Login/2FA) und SSRF-/Download-Limits für Importe mit.
- `NODE_ENV=production` lässt den Start abbrechen, wenn weder ein Master-Passwort
  noch die E-Mail-Einrichtung gesetzt ist.
