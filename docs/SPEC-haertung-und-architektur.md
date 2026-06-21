# Verbindliche Spezifikation: Härtung & Architektur

Status: freigegeben (Hosting-Modell: Cloudflare vor Docker/VPS).
Grundlage: externes Audit (kritisch) gegen den realen Stand `e193f89`.
Vorgehen: **Security-first, dann Architektur, dann Qualität/CI**, durchgehend
**test-getrieben** (Test zuerst rot, dann grün). Keine 10/10-Garantie, Ziel sind
reproduzierbar grüne Gates ohne bekannte Release-Blocker.

## 0. Rahmen & Hosting

- Stack bleibt: Node.js 24 + Express 5 + `node:sqlite` + nodemailer. Kein Rewrite.
- Hosting **neutral** (Docker/VPS/lokal); **Cloudflare davor** via Tunnel
  (`cloudflared`) + DNS + TLS + WAF/CDN/DDoS. Keine anbieterspezifischen Reste.
- Branch `feat/haertung-und-architektur`, PR nach `main`. Jeder Befund = eigener
  Commit mit Test.

---

## 1. Phase 1 — Sicherheit (Blocker zuerst)

### S1 — SSRF-Schutz + Download-Limits (KRITISCH)
Befund: ausgehende Fetches akzeptieren beliebige http(s)-Ziele inkl. interner IPs;
`normalizeHttpUrl` (httpSupport.js) prüft nur das Schema. Der „öffentliche Host"-
Check greift nicht für konfigurierte Quellen.
- Zentraler `safeFetch` für **alle** ausgehenden Requests (Sync, Discovery,
  Geocoding, Detail-Hydration):
  - nur `http:`/`https:`.
  - DNS-Auflösung des Hosts; Ablehnung bei privaten/reservierten IPs (IPv4 **und**
    IPv6: loopback, RFC1918, link-local 169.254/fe80, ULA fc00::/7, `::1`, `0.0.0.0`).
  - Redirects manuell folgen, jedes Ziel erneut prüfen, max. 5.
  - Antwort-Grössenlimit (Default 10 MB) durch Streamen + Abbruch.
- Abnahme: Tests lehnen `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `[::1]` ab;
  Redirect auf interne IP wird geblockt; Body > Limit bricht ab.

### S2 — Vollständiges Fetch-Timeout + langsame Bodies (KRITISCH)
Befund: applicationsSyncCommon.js löscht den Timer nach den Headern; `text()`/
`arrayBuffer()` laufen ohne Zeit-/Grössenlimit → DoS/Speichererschöpfung.
- Timeout deckt **den ganzen** Request inkl. Body-Lesen ab (AbortController erst
  nach vollständigem Lesen freigeben); harte Gesamt-Deadline.
- In `safeFetch` integriert (siehe S1).
- Abnahme: Test mit langsamem/endlosem Body bricht innerhalb der Deadline ab.

### S3 — Migration nur mit erfolgreichem Backup (KRITISCH)
Befund: `backupDatabaseBeforeMigration` (db.js) verschluckt Fehler/gibt `null`;
`applyMigrationOnce` prüft das nicht und führt Löschoperationen trotzdem aus.
- Unterscheidung: „Backup bewusst deaktiviert/irrelevant" (ok) vs. „Backup
  **fehlgeschlagen**" (Abbruch). Bei Fehlschlag wird die destruktive Migration
  **nicht** ausgeführt und ein klarer Fehler geworfen.
- Abnahme: Test simuliert Backup-Fehler → Migration läuft nicht, DB unverändert;
  Test mit `MIGRATION_BACKUP=false` läuft weiter.

### S4 — Rate-Limit für 2FA & alle sensiblen Auth-Pfade (HOCH)
Befund: 2FA enable/disable prüfen 6-stellige Codes unbegrenzt (app.js) →
Online-Bruteforce mit gestohlener Sitzung.
- Bestehenden Limiter auf anwenden: 2FA-Verify (enable/disable/login), Registrierung,
  Passwort-Reset-Anfrage + Einlösung, Master-Setup-Key-Einlösung.
- Abnahme: pro Pfad Test, dass nach N Fehlversuchen 429/Lockout greift.

### S5 — Quell-Tokens verschlüsseln + schwärzen (HOCH)
Befund: `sourceToken` liegt im Klartext in SQLite und wird voll ans Master-Frontend
zurückgegeben.
- AES-256-GCM at-rest (Schlüssel aus `TOKEN_ENCRYPTION_KEY`); Migration bestehender
  Klartext-Tokens. API gibt Tokens **nie** zurück (nur „gesetzt: ja/nein").
- Abnahme: DB-Wert ist Ciphertext; API liefert nie Klartext; Encrypt/Decrypt-Round-trip.

### S6 — `/api/auth/users` absichern (HOCH)
Befund: liefert ohne Anmeldung interne User-IDs/Namen/Rollen; Frontend nutzt es nicht.
- Endpoint entfernen oder hinter Auth + Master-Recht stellen.
- Abnahme: ohne Session 401/404; falls behalten, nur Master.

### S7 — ReDoS / Log-Injection / quadratische Regex (HOCH)
Befund: CodeQL meldet 3 ReDoS-Kandidaten, mögliche Log-Injection, quadratische
Regex auf externen Daten.
- Betroffene Regex entschärfen (Anker/Begrenzung), Logausgaben externer Strings
  neutralisieren (Zeilenumbrüche/Steuerzeichen entfernen).
- Abnahme: CodeQL-Befunde behoben oder begründet unterdrückt; Regex-Längenschutz-Test.

---

## 2. Phase 2 — Architektur

### A1 — Echte Modulgrenzen statt Dateiverschiebung
Befund: `applicationsSyncCommon.js` (1181 Z.) wird von allen 12 Modulen importiert;
XML/PDF haben je ~7 interne Deps und greifen in HTML/Refinement; Barrel exportiert
alle 237 Symbole ohne öffentliche API-Grenze.
- `applicationsSyncCommon.js` nach Verantwortung auftrennen (text/datetime/url/...).
- Barrel auf die **tatsächlich vom Service genutzte** öffentliche API reduzieren
  (keine `export *` aller Internals).
- Zielschnitt zyklenfrei (DAG bleibt), Cross-Modul-Deps minimieren.

### A2 — Keine Produktivdatei > 800 Zeilen (ausser Datenkataloge)
Betroffen: `api.test.js` (8662), `public/app.js` (2375), `server/app.js` (1678, 42
Routen → Router-Module auth/applications/admin/sync), `db.js` (1231 → schema/
migrations/queries), `redesign.css` (3112 → Sektionsdateien). Ausgenommen explizit:
`seed/municipalitySources.js` (Datenkatalog).
- Abnahme: CI-Script prüft Zeilenlimit; Ausnahmen als Allowlist dokumentiert.

### A3 — Toter Code raus
Befund: 31 tote Imports in `server/app.js`.
- Abnahme: Lint meldet 0 ungenutzte Importe.

### A4 — UI-Ehrlichkeit
Befund: redundante/scheinbar funktionierende Aktionen.
- Jede UI-Aktion hat sichtbare Wirkung oder wird entfernt; E2E deckt Kernaktionen ab.

---

## 3. Phase 3 — Qualität, Tests & CI

### Q1 — Architektur-Test mit Substanz
Befund: aktueller Test prüft nur Existenz/Barrel-Länge/`export *`.
- Echte Checks: Zyklenfreiheit (Graph), Dateigrössen-Limit, erlaubte Cross-Modul-
  Kanten, öffentliche API-Verträge.

### Q2 — CI mit echten Gates
Befund: ci.yml ohne Lint/SAST → tote Importe gemergt; Semgrep-Parserfehler
unbemerkt „erfolgreich".
- CI führt aus und **blockiert** bei: Biome (Lint+Format), `npm audit --audit-level=high`,
  Semgrep (Parserfehler = Fehlschlag, nicht Erfolg), Node-Tests, Playwright-E2E,
  Coverage-Gate. CodeQL-Workflow aktiv.

### Q3 — Coverage & fehlende Tests
Ist: 88,38 % Zeilen / 66,15 % Branch; nur 6 E2E.
- Ziel ≥ 90 % Zeilen / ≥ 80 % Branch. Neue Tests für SSRF, Redirects, langsame
  Bodies, Grössenlimits, Backupfehler, 2FA-Bruteforce, Token-Crypto, `/api/auth/users`.
- E2E + Konsolen-/Accessibility-Checks ausbauen.

### Q4 — Lint-Schulden tilgen
Ist: Biome 102 Fehler/28 Warnungen, Oxlint 33 Warnungen.
- Abnahme: Biome 0 Fehler; Oxlint 0 Warnungen (oder begründete, dokumentierte Ausnahmen).

---

## 4. Phase 4 — Hosting (Cloudflare vor Docker/VPS)

- Produktionsfertiges `Dockerfile` (multi-stage, non-root, HEALTHCHECK).
- `docker-compose.yml` für VPS; `cloudflared`-Beispielconfig (Tunnel → Container);
  ENV-Dokumentation (inkl. `TOKEN_ENCRYPTION_KEY`).
- Keine anbieterspezifischen Hosting-Reste.
- Abnahme: `docker build` + Container-Boot + `/api/health` hinter Tunnel dokumentiert.

---

## 5. Messlatte (Definition of Done)

- Keine bekannten kritischen/hohen Sicherheitsbefunde; `npm audit` = 0.
- Alle Node- **und** E2E-Tests grün.
- Coverage ≥ 90 % Zeilen / ≥ 80 % Branch.
- Keine undokumentierten Scannerfehler (Semgrep-Parserfehler = hartes CI-Fail).
- Keine Produktiv-Quelldatei > 800 Zeilen ausser deklarierten Datenkatalogen.
- Hosting ohne anbieterspezifische Abhängigkeiten.
