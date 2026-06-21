# Plan: vollständige Erfüllung der Messlatte

Ziel: alle offenen Messlatte-Punkte erreichen. Vorgehen: **sicher zuerst, riskant
zuletzt**, jede Phase test-gegated, je eigener Commit. Basis: PR #4
(`feat/haertung-und-architektur`), Ist: Tests 218, Zeilen 90.1 %, Branches 71.4 %,
`npm audit` = 0.

## Messlatte → Phase (Nachverfolgung)
| Messlatte-Ziel | Status | Phase |
|---|---|---|
| Keine kritischen/hohen Security-Befunde | ✅ | erledigt (Phase 1) |
| `npm audit` = 0 | ✅ | CI-Gate |
| Alle Node-/E2E-Tests grün | ✅ | laufend |
| Zeilen ≥ 90 % | ✅ 90.1 % | erledigt |
| Branches ≥ 80 % | ⏳ 71.4 % | **A** |
| Keine undokumentierten Scannerfehler | ⏳ | **B, C** |
| Keine Prod-Datei > 800 Z. (ausser Datenkataloge) | ⏳ | **D, E, F** |
| Hosting ohne Railway | ✅ | erledigt (Phase 4) |

---

## Phase A — Branch-Coverage 71 → 80 % (sicher, additiv)
Reihenfolge nach Hebel (uncovered Branches × Testbarkeit). Je eine Testdatei,
Mock-Fetch bzw. `:memory:`-DB, danach Ratchet im Gate anheben.

- **A1 `applicationsSyncXml`** — Feed-/Sitemap-Item-Bau; Fixtures: RSS/Atom/Sitemap-Strings + Mock-Fetch.
- **A2 `applicationsSyncPdf`** — `buildPdfImportedItems` mit injiziertem `pdfTextExtractImpl` + Mock-Fetch; Fixture: extrahierter PDF-Text.
- **A3 `applicationsSyncAmtsblatt`** — `parseAmtsblattEntries`/`buildAmtsblattItemFromEntry` mit HTML-Fixtures.
- **A4 `applicationsSyncSource` + `applicationsSyncDiscovery`** — `fetchNormalizedItemsFromSource`/Discovery mit Mock-Fetch + HTML.
- **A5 Services** — `agisGeometryService`, `agisAssessmentService` (Mock-Fetch), `mailService` (Mock-Transport), `maintenanceService` (`:memory:`-DB, Zeit-Edge-Cases).
- **A6 Repositories** — `applicationsRepository`, `applicationLearningRepository`, `registrationKeys/passwordReset/masterSetup/sessions/settings/syncJobs` via `:memory:`-DB.

**Akzeptanz:** `npm run test:coverage --test-coverage-branches=80` grün; Gate auf 80 angehoben.

## Phase B — Lint scharf (Biome)
- `@biomejs/biome` als devDependency, `biome.json` (Lint + Format), `npm run lint`.
- `biome check --write` für sichere Autofixes; Rest manuell (ungenutzte Importe nach den Splits etc.).
- CI-Step `npm run lint` **blockierend**; Tests nach jeder Korrektur grün.

**Akzeptanz:** Biome 0 Fehler; Oxlint 0 Warnungen (oder dokumentierte Ausnahmen).

## Phase C — SAST + ReDoS (Sicherheit)
- **Semgrep**: Parserfehler beheben (Zielpfade/Config eingrenzen), als CI-Step, der bei Fehler **failt** (kein „grün trotz Parserfehler").
- **CodeQL**-Workflow aktiv; die 3 ReDoS-Kandidaten + quadratische Regex entschärfen (Anker, Längen-Caps vor regex-schwerer Verarbeitung externer Daten), Log-Injection-Reste mit `sanitizeForLog`.

**Akzeptanz:** CodeQL 0 offene Produktbefunde (oder begründet unterdrückt); Semgrep ohne Parserfehler; `npm audit` = 0.

## Phase D — `server/app.js` < 800 (Router-Split, RISKANT)
- `context`-Objekt mit allen `createApp`-Abhängigkeiten inkl. verschachtelter Helfer (`recordAudit`, `passesTurnstile`, `deliverMasterSetupKey`, `canDeliver*`, `getMasterUserId`).
- Router-Module `server/routes/{auth,admin,applications,sync}Routes.js`, je `register(app, context)`; Handler-Bodies **verbatim**, Deps via Destructuring; httpSupport-Importe pro Modul.
- **Streng inkrementell:** eine Gruppe → `npm test` → commit → nächste Gruppe.

**Akzeptanz:** `app.js` < 800; alle Tests grün; aus Grössen-Allowlist entfernt.

## Phase E — `public/app.js` < 800 (Frontend, RISKANT)
- ES-Module: `index.html` → `<script type="module">`; `app.js` in Feature-Module (`api`, `state`, `dom`, `work`, `detail`, `admin`) mit echten `import`s.
- **Browser-Verifikation** (Playwright MCP): Login, Liste, Detail, Admin, Theme, 0 Konsolenfehler.

**Akzeptanz:** alle Frontend-Module < 800; E2E + Browser-Check grün.

## Phase F — CSS + grosse Testdatei
- `redesign.css` (3112) → Sektionsdateien via `@import` (`tokens/base/layout/components/admin/dark`); Browser-Check: Stil unverändert.
- `api.test.js` (8662) → gemeinsamer Helfer `tests/helpers/server.js` + thematische Testdateien (auth/applications/admin/sync).

**Akzeptanz:** keine Quelldatei > 800 ausser Datenkatalogen; Grössen-Allowlist leer.

## Phase G — Endabnahme + Merge
- Voll: `npm run test:coverage` (90/80), `npm run test:e2e`, Browser-/a11y-Check, `Run-All-Scans-With-CodeQL`, `npm audit`.
- Messlatte-Checkliste komplett abhaken; **PR #4 → `main` mergen**.

---

## Reihenfolge & Risiko
A (Coverage) → B (Lint) → C (SAST/ReDoS) sind **sicher/additiv**. D (app.js) → E (Frontend) → F (CSS/Test) sind **Struktur-Risiko** und kommen mit Test-/Browser-Gates danach. G ist die Endabnahme. Jede Phase ist eigenständig grün und committbar; bei Problemen jederzeit abbrechbar ohne die vorherigen Gewinne zu verlieren.
