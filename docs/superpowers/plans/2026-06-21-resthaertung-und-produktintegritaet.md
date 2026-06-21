# Resthärtung und Produktintegrität Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die verbleibenden Sicherheits-, Datenintegritäts-, CI- und Qualitätslücken so schliessen, dass die Messlatte nicht nur lokal behauptet, sondern auf `main` technisch erzwungen wird.

**Architecture:** Zuerst werden irreversible Datenpfade und Authentifizierungsgrenzen abgesichert. Danach werden Scanner und GitHub-Regeln zu echten Merge-Schranken. Fachliche Importqualität erhält explizite Herkunfts- und Vertrauenssignale. Erst anschliessend folgen Coverage und Dateisplits, aufgeteilt auf kleine, separat prüfbare Pull Requests.

**Tech Stack:** Node.js 24, Express, `node:sqlite`, Node Test Runner, Playwright, Biome, Semgrep, CodeQL, Docker Compose, GitHub Actions.

---

## Verifizierter Ausgangsstand vom 21. Juni 2026

- Commit-Stand: `aa17e22` auf `feat/coverage-und-feinschliff`, ein Commit vor `main`.
- Ungetrackt und deshalb nicht Teil des belastbaren Stands: `tests/auditLogRepositoryMore.test.js`.
- Getrackte Node-Tests: 294 grün.
- Coverage: 91.01 % Zeilen, 75.23 % Branches, 94.59 % Funktionen.
- E2E: 6/6 grün.
- `npm audit`: 0 bekannte Abhängigkeitsbefunde.
- Semgrep: 1 blockierender AES-GCM-Befund in `server/services/tokenCrypto.js`.
- CodeQL: Analyse läuft, SARIF-Upload scheitert, weil Code Scanning im Repository nicht aktiviert ist.
- GitHub: `main` ist nicht geschützt; PR #4 wurde mit rotem Semgrep und rotem CodeQL gemergt.
- Biome: Backend-Gate endet mit 3 Warnungen; `lint:all` scheitert mit 18 Fehlern und 3 Warnungen.
- Grössenlimit: `public/redesign.css` 3112, `public/app.js` 2375, `server/app.js` 1679 und `server/services/applicationsSyncDiscovery.js` 891 Zeilen.
- Live-Amtsblatt-Probe: 8/8 importierte Einträge erhielten eine nicht belegte Frist von Publikation + 30 Tagen.

## PR-Reihenfolge

1. **PR A, P0:** Datenintegrität, Master-Setup, Sitzungswiderruf, AES-GCM.
2. **PR B, P0:** Scanner reparieren, Branch-Schutz aktivieren, vollständiges Lint-Gate.
3. **PR C, P1:** Import-Provenienz, Bestandsdaten-Diagnose und ehrliche UI.
4. **PR D, P1:** Architektur-Splits und vollständiges Dateigrössen-Gate.
5. **PR E, P2:** Branch-Coverage 80 %, Hosting-Härtung und Endabnahme.

Kein PR darf mehrere noch nicht verifizierte P0-Risiken mit grossen Strukturumbauten vermischen.

## Task 0: Arbeitsbaum und Test-Baseline bereinigen

**Files:**
- Review: `tests/auditLogRepositoryMore.test.js`
- Review: `tests/auditLogRepository.test.js`
- Review: `package.json`

- [x] **Step 1: Herkunft der ungetrackten Testdatei prüfen**

Run: `git status --short --branch`

Expected: Nur `?? tests/auditLogRepositoryMore.test.js`; keine unerwarteten Änderungen.

- [x] **Step 2: Doppelungen mit dem bestehenden Audit-Log-Test prüfen**

Run: `git diff --no-index tests/auditLogRepository.test.js tests/auditLogRepositoryMore.test.js`

Expected: Klar erkennbar, welche zusätzlichen Verhaltenszweige wirklich getestet werden.

- [x] **Step 3: Test isoliert ausführen**

Run: `node --test tests/auditLogRepository.test.js tests/auditLogRepositoryMore.test.js`

Expected: Beide Dateien grün. Falls der neue Test nur Coverage ohne zusätzlichen Vertrag liefert, nicht übernehmen; die Datei aber nur nach ausdrücklicher Bestätigung entfernen.

- [x] **Step 4: Baseline ohne ungetrackte Dateien sichern**

Run:

```powershell
$files = @(git ls-files 'tests/*.test.js')
node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=75 --test-coverage-functions=94 $files
```

Expected: 294 Tests, 91.01 % Zeilen, 75.23 % Branches, 94.59 % Funktionen.

## Task 1: Automatische Löschung und Backup-Vernichtung stoppen

**Files:**
- Modify: `server/repository/applicationsRepository.js`
- Modify: `server/services/maintenanceService.js`
- Modify: `server/app.js`
- Modify: `server/db/schema.js`
- Modify: `server/db/migrations.js`
- Modify: `.env.example`
- Modify: `tests/applicationRetention.test.js`
- Modify: `tests/maintenanceService.test.js`
- Modify: `tests/maintenanceServiceMore.test.js`
- Create: `tests/applicationRetentionSafety.test.js`

- [x] **Step 1: Fehlende Sicherheitsverträge als rote Tests formulieren**

Die Testdatei enthält vier konkrete Fälle mit einer `:memory:`-Datenbank: Ein
abgelaufener unberührter Fall wird archiviert und bleibt abfragbar; ein
abgelaufener Fall mit Kommentar bleibt vollständig erhalten; ein Fall ohne
`deadline_provenance='explicit'` darf archiviert werden, ein gleich alter Fall
mit `legacy-unknown` nicht; ein Cleanup mit
archivierten Fällen ruft `purgeDatabaseBackups` nicht auf.

Run: `node --test tests/applicationRetentionSafety.test.js tests/maintenanceService.test.js`

Expected: Mindestens die neuen Verträge schlagen mit dem aktuellen Code fehl.

- [x] **Step 2: Minimale Provenienzspalte sicher migrieren**

`applications.deadline_provenance` erhält die erlaubten Werte `explicit`,
`derived-rule`, `missing` und `legacy-unknown`. Bestehende Datensätze werden
konservativ als `legacy-unknown` markiert; die Migration darf keine Fristen
automatisch als bestätigt einstufen.

- [x] **Step 3: Fristablauf als Zustandswechsel statt Hard-Delete implementieren**

In `applicationsRepository.js` eine Methode `archiveExpiredApplications` einführen. Nur Fälle mit bestätigter Frist dürfen automatisch auf `workflow_status='archived'` gesetzt werden. Kommentare, Lesestatus, Lernregeln und Historie bleiben erhalten.

- [x] **Step 4: Physische Löschung separat und konservativ machen**

Die automatische physische Löschung bleibt deaktiviert. Eine spätere Methode
`purgeArchivedApplications` darf frühestens nach erfolgreicher Backup-Restore-
Verifikation aus Task 8 eingeführt werden und nur Fälle löschen, die:

- länger als `APPLICATION_RETENTION_DAYS` archiviert sind,
- keine Notiz, Zuweisung oder Kommentare besitzen,
- keine unbestätigte oder abgeleitete Frist besitzen,
- in einer vor dem Lauf erstellten und verifizierten Sicherung enthalten sind.

- [x] **Step 5: Backup-Kopplung entfernen**

In `maintenanceService.js` diese Logik vollständig entfernen:

```js
const purgedBackups = removedApplications > 0 ? purgeDatabaseBackups() : 0;
```

Backups werden ausschliesslich nach einer zeit- und anzahlbasierten Backup-Retention bereinigt, nie als Nebenwirkung einer Fachdatensäuberung.

- [x] **Step 6: Irreführende Retention-Konfiguration entfernen**

Da kein sicherer physischer Purge existiert, wird die wirkungslose
`APPLICATION_RETENTION_DAYS`-Angabe entfernt. Die Dokumentation verspricht nur
die tatsächlich implementierte Archivierung.

- [x] **Step 7: Tests grün machen**

Run: `node --test tests/applicationRetention.test.js tests/applicationRetentionSafety.test.js tests/maintenanceService.test.js tests/maintenanceServiceMore.test.js`

Expected: Alle Retention- und Backup-Verträge grün.

- [x] **Step 8: Commit**

```bash
git add server/repository/applicationsRepository.js server/services/maintenanceService.js server/app.js server/db/schema.js server/db/migrations.js .env.example tests/applicationRetention.test.js tests/applicationRetentionSafety.test.js tests/maintenanceService.test.js tests/maintenanceServiceMore.test.js
git commit -m "fix(data): Fristablauf archivieren und Backups vor Löschpfaden schützen"
```

## Task 2: Amtsblatt-Fristen und Datenprovenienz fachlich korrekt machen

**Files:**
- Modify: `server/services/applicationsSyncAmtsblatt.js`
- Modify: `server/services/applicationsSyncCandidate.js`
- Modify: `server/domain/applicationImportNormalization.js`
- Modify: `server/db/schema.js`
- Modify: `server/db/migrations.js`
- Modify: `server/repository/applicationsRepository.js`
- Modify: `tests/api.test.js`
- Create: `tests/amtsblattLiveFixture.test.js`
- Create: `scripts/diagnose-inferred-deadlines.js`

- [ ] **Step 1: Regressionsfixture aus dem aktuellen Amtsblatt anonymisiert speichern**

Die Fixture muss die aktuell fehlerhafte Struktur mit `Bauvorhaben`, `Bauplatz`, Publikationsdatum und fehlender expliziter Frist abbilden. Keine Netzwerkanfrage im normalen Testlauf.

- [ ] **Step 2: Rote Tests für nicht belegte Fristen schreiben**

Nach dem Parsen der Fixture müssen diese konkreten Assertions gelten:

```js
assert.equal(item.deadlineDate, "");
assert.equal(item.deadlineProvenance, "missing");
assert.match(item.automatedAssessment, /Frist.*manuell/i);
assert.equal(item.address, "Wallerstrasse 16");
```

Run: `node --test tests/amtsblattLiveFixture.test.js`

Expected: Beide Tests rot.

- [ ] **Step 3: Pauschalen +30-Tage-Fallback entfernen**

In `applicationsSyncAmtsblatt.js` ersetzen:

```js
const deadlineDate = extractDeadlineDateFromText(entry.bodyText) || "";
```

Kein anderer Parser darf eine fehlende amtliche Frist als bekannte Frist ausgeben.

- [ ] **Step 4: Provenienz im Datenmodell ergänzen**

Mindestens diese Werte verwenden:

```text
deadline_provenance: explicit | derived-rule | missing | legacy-unknown
address_provenance: official-field | geocoder | fallback | legacy-unknown
```

Automatische Löschung darf nur `explicit` verwenden. `derived-rule` ist nur zulässig, wenn eine konkrete, dokumentierte Rechts- oder Quellenregel existiert und getestet ist.

- [ ] **Step 5: Adressparser an Feldgrenzen statt freiem Gesamttext ausrichten**

`Bauplatz:`/`Standort:` als Start und das nächste bekannte Label als Ende verwenden. Projekttext vor dem Label wird verworfen.

- [ ] **Step 6: Bestehende Datensätze nur diagnostizieren, nicht blind mutieren**

`scripts/diagnose-inferred-deadlines.js` listet Amtsblatt-Fälle mit exakt +30 Tagen, Quellreferenz, Team-Berührung und Backup-Status. Standard ist Dry-Run. Eine spätere Reparatur braucht einen separaten `--apply`-Schritt und ein verifiziertes Backup.

- [ ] **Step 7: Testen**

Run: `node --test tests/amtsblattLiveFixture.test.js tests/api.test.js tests/applicationImportNormalization.test.js`

Expected: Fixture, Parser und API-Verträge grün.

- [ ] **Step 8: Commit**

```bash
git add server/services/applicationsSyncAmtsblatt.js server/services/applicationsSyncCandidate.js server/domain/applicationImportNormalization.js server/db/schema.js server/db/migrations.js server/repository/applicationsRepository.js tests/api.test.js tests/amtsblattLiveFixture.test.js scripts/diagnose-inferred-deadlines.js
git commit -m "fix(import): Amtsblatt-Fristen belegen und Feldprovenienz speichern"
```

## Task 3: Authentifizierung und Token-Kryptografie schliessen

**Files:**
- Modify: `server/services/tokenCrypto.js`
- Modify: `server/httpValidation.js`
- Modify: `server/app.js`
- Modify: `server/repository/masterSetupKeysRepository.js`
- Modify: `tests/tokenCrypto.test.js`
- Modify: `tests/httpValidation.test.js`
- Create: `tests/passwordResetSessionRevocation.test.js`
- Create: `tests/masterSetupDeliveryFailure.test.js`

- [ ] **Step 1: AES-GCM-Negativtests schreiben**

In `tests/tokenCrypto.test.js` werden gültige Chiffrate gezielt mit einem
15-Byte-Tag und einem 11-Byte-IV neu zusammengesetzt; `decryptToken` muss jeweils
`""` liefern. In `tests/httpValidation.test.js` wird
`validateProductionRuntimeConfiguration({ NODE_ENV: "production", ... })` mit
ansonsten gültigen Werten, aber ohne `TOKEN_ENCRYPTION_KEY`, auf einen Fehler
geprüft.

Run: `node --test tests/tokenCrypto.test.js tests/httpValidation.test.js`

Expected: Neue Verträge rot.

- [ ] **Step 2: GCM-Längen explizit prüfen**

Vor `createDecipheriv` Base64 strikt dekodieren und `iv.length === 12`, `tag.length === 16` prüfen. Decipher mit festem Tag-Limit erstellen:

```js
const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
```

- [ ] **Step 3: Token-Key in Produktion erzwingen**

`validateProductionRuntimeConfiguration` muss einen fehlenden oder offensichtlichen Platzhalter in `TOKEN_ENCRYPTION_KEY` ablehnen. Der Klartext-Fallback bleibt ausschliesslich für lokale Entwicklung und explizite Legacy-Migration.

- [ ] **Step 4: Sitzungen bei jedem Passwortwechsel widerrufen**

Nach erfolgreichem Self-Service-Reset und Admin-Reset innerhalb desselben fachlichen Vorgangs:

```js
sessionsRepository.deleteByUserId(targetUserId);
```

Tests müssen eine vorher gültige Sitzung nach dem Reset mit 401/unauthenticated sehen.

- [ ] **Step 5: Master-Setup bei Zustellfehler fail-closed machen**

`masterSetupKeysRepository` erhält `deleteById`. Wird der Versand abgelehnt, wird der provisorische Schlüssel sofort gelöscht und der Fehler aus `ready` weitergereicht. Der direkte Produktionsstart darf vor `app.listen` scheitern.

- [ ] **Step 6: Beispielwerte als Beispielwerte erkennen**

`MASTER_SETUP_EMAIL=master@example.org` und `SMTP_HOST=smtp.example.org` dürfen in Produktion nicht als konfigurierte Zustellung gelten.

- [ ] **Step 7: Tests und Semgrep**

Run:

```bash
node --test tests/tokenCrypto.test.js tests/httpValidation.test.js tests/passwordResetSessionRevocation.test.js tests/masterSetupDeliveryFailure.test.js
semgrep scan --config p/security-audit --config p/javascript --error --metrics=off
```

Expected: Tests grün; Semgrep 0 blockierende Befunde.

- [ ] **Step 8: Commit**

```bash
git add server/services/tokenCrypto.js server/httpValidation.js server/app.js server/repository/masterSetupKeysRepository.js tests/tokenCrypto.test.js tests/httpValidation.test.js tests/passwordResetSessionRevocation.test.js tests/masterSetupDeliveryFailure.test.js
git commit -m "fix(security): GCM validieren und Zugangsdatenwechsel fail-closed machen"
```

## Task 4: Scanner und GitHub-Regeln zu echten Merge-Gates machen

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/codeql.yml`
- Modify: `.github/workflows/semgrep.yml`
- Modify: `package.json`
- Modify: `biome.json`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `server/app.js`

- [ ] **Step 1: Biome-Konfiguration migrieren**

Run: `npx biome migrate --write`

Expected: Keine Deprecation-Meldung für `recommended`.

- [ ] **Step 2: Vollständiges Lint-Gate definieren**

`lint` und CI müssen `server`, `public`, `scripts` und `tests` prüfen. Warnungen werden als Fehler behandelt. `lint:all` darf kein optionaler Nebenpfad bleiben.

- [ ] **Step 3: 18 Frontend-Fehler und 3 Backend-Warnungen beheben**

Callbacks mit Blockkörpern ohne Rückgabewert schreiben, echte semantische Elemente/ARIA-Rollen verwenden und die Kommaoperatoren in normale `if`-Blöcke auflösen.

Run: `npm run lint`

Expected: Exit 0, 0 Fehler, 0 Warnungen, 0 Deprecations.

- [ ] **Step 4: CodeQL-Funktion aktivieren oder lokalen Fallback bauen**

Bevor CodeQL als erfüllt markiert wird, in den Repository-Einstellungen Code Scanning aktivieren. Falls der GitHub-Tarif dies nicht zulässt, muss der Workflow CodeQL lokal ausführen, SARIF als Artifact hochladen und aufgrund der Resultate selbst fehlschlagen; ein bloss scheiternder SARIF-Upload ist kein Security-Gate.

- [ ] **Step 5: `main` mit einem Ruleset schützen**

Mindestens:

- Pull Request erforderlich.
- Required status checks: `CI / test`, `Semgrep / SAST (Semgrep)`, `CodeQL / Analyze (JavaScript)`.
- Branch muss vor Merge aktuell sein.
- Kein Merge bei offenen Checks.
- Admin-Bypass deaktivieren oder dokumentiert begrenzen.

- [ ] **Step 6: Ruleset per API verifizieren**

Run:

```bash
gh api repos/Momik-jpg/Projekt-Heimatschutz-ANAMB/rulesets
gh api repos/Momik-jpg/Projekt-Heimatschutz-ANAMB/branches/main/protection
```

Expected: Aktiver Schutz und Required Checks sichtbar; kein 404 `Branch not protected`.

- [ ] **Step 7: Absichtlich roten Test-PR verwenden**

Auf einem temporären Branch einen kontrollierten Lint-Fehler erzeugen, PR öffnen und verifizieren, dass Merge blockiert ist. Danach den temporären Commit zurücknehmen, nicht `main` manipulieren.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/codeql.yml .github/workflows/semgrep.yml package.json biome.json public/app.js public/index.html server/app.js
git commit -m "ci: alle Qualitätschecks erzwingen und Scanner merge-blockierend machen"
```

## Task 5: UI-Ehrlichkeit, Accessibility und Kartendatenschutz

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/redesign.css`
- Modify: `server/httpSecurity.js`
- Modify: `tests/e2e/smoke.spec.js`
- Create: `tests/e2e/dataQuality.spec.js`

- [ ] **Step 1: Irreführende KI-Bezeichnung als roten E2E-Vertrag festhalten**

Ein Datensatz mit fehlender oder unbestätigter Frist darf nicht „Vollständig“ anzeigen. Da keine KI beteiligt ist, muss der Titel „Automatische Datenprüfung“ lauten.

- [ ] **Step 2: Vollständigkeit aus Provenienz ableiten**

„Geprüft“ nur bei expliziter Frist, sauberer amtlicher Adresse, belastbarer Standortpräzision und erreichbarer Originalquelle. Sonst konkrete Warnung statt generischem Häkchen.

- [ ] **Step 3: Interaktive Tabellenzeilen semantisch bedienbar machen**

Zeilen brauchen eine echte Schaltfläche oder einen Link als primäre Aktion. Tastatur, Fokusname und Enter/Space müssen im Browser-Test belegt sein.

- [ ] **Step 4: Drittbibliotheken selbst hosten und pinnen**

Leaflet und Proj4 nicht von `unpkg.com`/`cdnjs.cloudflare.com` laden. Versionierte lokale Assets mit Lizenzhinweisen verwenden und die CSP entsprechend verkleinern.

- [ ] **Step 5: Externe Kartenkacheln nicht automatisch laden**

Der genaue Standort darf erst nach einer sichtbaren Aktion „Externe Karte laden“ an einen Tile-Provider übertragen werden. Der Hinweis nennt den Drittanbieter. Ohne Einwilligung bleibt eine lokale Standortdarstellung/AGIS-Verlinkung sichtbar.

- [ ] **Step 6: Browser prüfen**

Run: `npm run test:e2e`

Zusätzlich mit Chrome DevTools prüfen: 390 px, Tastaturnavigation, 0 Konsolenfehler, vor Kartenfreigabe keine Requests an `tile.openstreetmap.org`.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html public/redesign.css server/httpSecurity.js tests/e2e/smoke.spec.js tests/e2e/dataQuality.spec.js
git commit -m "fix(ui): Datenqualität ehrlich anzeigen und Kartenaufrufe privatsphärenschonend machen"
```

## Task 6: God-Files vollständig auflösen und Grössen-Gate ehrlich machen

**Files:**
- Modify: `server/app.js`
- Create: `server/routes/authRoutes.js`
- Create: `server/routes/adminRoutes.js`
- Create: `server/routes/applicationRoutes.js`
- Create: `server/routes/syncRoutes.js`
- Modify: `public/app.js`
- Create: `public/js/api.js`
- Create: `public/js/state.js`
- Create: `public/js/auth.js`
- Create: `public/js/applications.js`
- Create: `public/js/admin.js`
- Create: `public/js/map.js`
- Modify: `server/services/applicationsSyncDiscovery.js`
- Create: `server/services/discovery/discoveryCandidates.js`
- Create: `server/services/discovery/discoverySearch.js`
- Create: `server/services/discovery/discoveryValidation.js`
- Modify: `public/redesign.css`
- Create: `public/css/tokens.css`
- Create: `public/css/base.css`
- Create: `public/css/layout.css`
- Create: `public/css/components.css`
- Create: `public/css/admin.css`
- Create: `public/css/dark.css`
- Modify: `tests/fileSizeBudget.test.js`

- [ ] **Step 1: Dateigrössen-Test zuerst auf alle Produktivquellen erweitern**

Der Test sammelt `.js`, `.css` und `.html`. Dauerhafte Ausnahme bleibt nur `server/seed/municipalitySources.js`. Die vier aktuellen Überschreitungen werden zunächst explizit als rot erwartete Arbeit dokumentiert.

- [ ] **Step 2: `server/app.js` Route für Route extrahieren**

Je Route-Gruppe: Handler unverändert verschieben, Abhängigkeiten über ein benanntes Context-Objekt injizieren, danach `npm test`. Kein Big-Bang-Split.

- [ ] **Step 3: `public/app.js` in echte ES-Module teilen**

Zuerst `api` und `state`, dann Auth, Arbeitsliste, Admin und Karte. Nach jedem Modul `npm run lint` und den betroffenen Playwright-Test ausführen.

- [ ] **Step 4: Discovery-Service nach Verantwortung trennen**

Kandidatensuche, Suchmaschinen-/Formularlogik und Validierung in getrennte Module. Die öffentliche Exportfläche bleibt klein und wird in einem Architekturtest festgehalten.

- [ ] **Step 5: CSS ohne Kaskadenänderung teilen**

Reihenfolge der Styles explizit in `index.html` festlegen; keine verschachtelten `@import`-Ketten. Vorher/nachher Screenshots für Login, Arbeitsliste, Detail, Admin, Light/Dark und 390 px vergleichen.

- [ ] **Step 6: Allowlist leeren**

Run: `node --test tests/fileSizeBudget.test.js`

Expected: Keine Produktivdatei über 800 Zeilen ausser dem Datenkatalog; keine temporäre God-File-Allowlist.

- [ ] **Step 7: Commit pro Teil-Split**

Nicht alle Splits in einen Commit pressen. Mindestens vier getrennte Commits: Backend-Routen, Frontend-Module, Discovery, CSS.

## Task 7: Coverage auf risikorelevante 80 % bringen

**Files:**
- Modify/Create: gezielte Tests für die in Tasks 1-6 geänderten Module
- Modify: `package.json`

- [ ] **Step 1: Coverage nach den P0/P1-Fixes neu messen**

Run: `npm run test:coverage`

Expected: Neuer realer Stand; keine Zahl aus dem alten Protokoll übernehmen.

- [ ] **Step 2: Fehlende Branches nach Risiko priorisieren**

Zuerst Fehler- und Rollbackpfade in Retention, Master-Setup, Token-Krypto, Session-Widerruf und Amtsblatt-Provenienz. Danach Discovery/Parser. Keine bedeutungslosen Tests nur für Nullish-Fallbacks, solange kritische Pfade ungetestet sind.

- [ ] **Step 3: Threshold schrittweise ratcheten**

Nach jedem grünen Testpaket Branch-Gate nur bis knapp unter den gemessenen Wert anheben: 76, 77, 78, 79, 80.

- [ ] **Step 4: Endwert erzwingen**

`package.json`:

```json
"test:coverage": "node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=94"
```

Run: `npm run test:coverage`

Expected: Exit 0, Branches mindestens 80.00 %.

## Task 8: Hosting reproduzierbar und ausfallsicher machen

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `.env.example`
- Modify: `docs/HOSTING.md`
- Create: `scripts/verify-backup-restore.js`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Images unveränderlich pinnen**

`node:24-alpine` und `cloudflare/cloudflared:latest` durch geprüfte Versions-/Digest-Pins ersetzen. Renovate/Dependabot kann Updates separat vorschlagen.

- [ ] **Step 2: Compose ohne lokale Geheimnisse validierbar machen**

`env_file` parametrisieren, damit CI mit `.env.example` validieren kann, ohne eine echte `.env` anzulegen.

Run:

```powershell
$env:ENV_FILE='.env.example'
docker compose config --quiet
```

Expected: Exit 0.

- [ ] **Step 3: Backup-Wiederherstellung automatisiert prüfen**

`scripts/verify-backup-restore.js` erstellt eine temporäre DB, ein Backup, öffnet das Backup erneut und prüft zentrale Tabellen/Counts. Keine Produktivdatei verwenden.

- [ ] **Step 4: Container-Smoke-Test in CI**

Image bauen, Container mit temporärem Volume starten, `/api/health` prüfen und sauber stoppen.

- [ ] **Step 5: Betriebsdokumentation ehrlich machen**

Recovery-Zeit, Restore-Befehl, Secret-Rotation, Token-Key-Verlust, Cloudflare-Ausfall und SQLite-Einzelinstanz als Grenzen dokumentieren.

## Task 9: Dokumentation und Endabnahme

**Files:**
- Modify: `docs/PLAN-messlatte-vollstaendig.md`
- Modify: `docs/pruefprotokoll.md`
- Modify: `docs/systemdokumentation.md`
- Modify: `README.md`

- [ ] **Step 1: Alte Zahlen und falsche Häkchen entfernen**

Keine statischen Testzahlen als dauerhafte Wahrheit ausgeben. Security, Scanner und Branch-Schutz nur als erledigt markieren, wenn die aktuelle `main`-Pipeline und Repository-Regeln dies beweisen.

- [ ] **Step 2: Vollständige lokale Abnahme**

Run:

```bash
npm ci
npm run lint
npm run test:coverage
npm run test:e2e
npm audit --audit-level=high
semgrep scan --config p/security-audit --config p/javascript --error --metrics=off
```

Expected: Alles grün; Coverage mindestens 90/80/94.

- [ ] **Step 3: GitHub-Abnahme auf einem neuen PR**

Run:

```powershell
$pr = gh pr view --json number --jq .number
gh pr checks $pr --watch
```

Expected: CI, Semgrep und CodeQL grün. Merge-Schaltfläche bleibt bei einem absichtlich roten Required Check gesperrt.

- [ ] **Step 4: Dateigrössen und Arbeitsbaum prüfen**

Run:

```bash
node --test tests/fileSizeBudget.test.js
git diff --check
git status --short
```

Expected: Nur Datenkatalog ausgenommen; keine unerwarteten oder ungetrackten Dateien.

- [ ] **Step 5: Graph aktualisieren**

Run: `graphify update .`

Expected: Erfolgreiche AST-Aktualisierung ohne API-Kosten.

## Definition of Done

- Keine bekannte kritische/hohe Security-Lücke; Semgrep und CodeQL beide grün.
- `main` erzwingt Required Checks und kann nicht mit roten Scannern gemergt werden.
- Keine automatische physische Löschung aufgrund unbestätigter Fristen.
- Ein SMTP-Fehler hinterlässt keinen unzustellbaren Master-Setup-Key und verhindert einen scheinbar erfolgreichen Produktionsstart.
- Passwortänderungen widerrufen bestehende Sitzungen.
- Amtsblatt-Datensätze unterscheiden explizite, abgeleitete, fehlende und alte unbekannte Fristen.
- UI nennt Heuristiken nicht KI und meldet unbestätigte Daten nicht als vollständig.
- `npm audit` meldet 0; Node- und E2E-Tests sind grün.
- Coverage mindestens 90 % Zeilen und 80 % Branches.
- Keine Produktiv-Quelldatei über 800 Zeilen ausser `server/seed/municipalitySources.js`.
- Docker- und Backup-Restore-Smoke-Tests sind reproduzierbar.
- Dokumentation entspricht dem aktuellen `main`-Stand statt alten Momentaufnahmen.
