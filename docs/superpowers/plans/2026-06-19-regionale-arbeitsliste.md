# Regionale Arbeitsliste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die bestehende Baugesuch-Arbeitsoberfläche erhält kombinierbare Regionsfilter, benutzerspezifische Ungelesen-Markierungen, eine 14-Tage-Inbox, direkte Quellenlinks, automatische Grössenklassen und eine endgültige Löschung nach Fristende.

**Architecture:** Region und Grössenklasse werden in einem reinen Domainmodul aus den bestehenden Falldaten abgeleitet. Ein separates Repository speichert nur den benutzerspezifischen Gelesen-Status. Die bestehende API ergänzt diese Anzeigedaten, während Repository und Wartungsdienst abgelaufene Fälle transaktional löschen. Das bestehende Vanilla-JavaScript-Frontend behält seine Tabellen-/Detailstruktur und ergänzt zwei Filterdimensionen sowie den eingeklappten Altbereich.

**Tech Stack:** Node.js 24, Express 5, `node:sqlite`, Vanilla JavaScript/HTML/CSS, Node Test Runner, Playwright.

---

### Task 1: Region und Bauvorhabengrösse ableiten

**Files:**
- Create: `server/domain/applicationPresentation.js`
- Create: `tests/applicationPresentation.test.js`
- Modify: `server/repository/applicationsRepository.js`

- [ ] **Step 1: Failing Domain-Tests schreiben**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProjectScale,
  getApplicationRegion
} from "../server/domain/applicationPresentation.js";

test("ordnet repräsentative Gemeinden den vier Regionen zu", () => {
  assert.equal(getApplicationRegion("Aarau"), "Berner Aargau");
  assert.equal(getApplicationRegion("Rheinfelden"), "Fricktal");
  assert.equal(getApplicationRegion("Wettingen"), "Baden");
  assert.equal(getApplicationRegion("Muri"), "Freiamt");
  assert.equal(getApplicationRegion("Unbekannt"), "");
});

test("klassifiziert grosse vor mittleren und kleinen Vorhaben", () => {
  assert.equal(classifyProjectScale({ projectType: "Wohnüberbauung mit PV-Anlage" }), "gross");
  assert.equal(classifyProjectScale({ projectType: "Anbau Einfamilienhaus" }), "mittel");
  assert.equal(classifyProjectScale({ projectType: "Neue Wärmepumpe" }), "klein");
  assert.equal(classifyProjectScale({ projectType: "Baugesuch" }), "mittel");
});
```

- [ ] **Step 2: RED verifizieren**

Run: `node --test tests/applicationPresentation.test.js`

Expected: FAIL, weil `server/domain/applicationPresentation.js` noch nicht existiert.

- [ ] **Step 3: Minimales Domainmodul implementieren**

```js
const REGION_BY_MUNICIPALITY = new Map([
  // Vollständige Zuordnung aller Gemeinden aus server/seed/municipalitySources.js.
  // Berner Aargau = Aarau/Brugg/Kulm/Lenzburg/Zofingen,
  // Fricktal = Laufenburg/Rheinfelden,
  // Baden = Baden/Zurzach,
  // Freiamt = Bremgarten/Muri.
]);

const LARGE = /mehrfamilienhaus|wohnüberbauung|überbauung|industrie|gewerbebau|schulhaus|mehrere gebäude/i;
const SMALL = /wärmepumpe|photovoltaik|pv-anlage|fenster|reklame|werbeanlage|klimaanlage/i;

export function getApplicationRegion(municipality) {
  return REGION_BY_MUNICIPALITY.get(String(municipality ?? "").trim()) ?? "";
}

export function classifyProjectScale({ projectType = "", description = "" } = {}) {
  const text = `${projectType} ${description}`;
  if (LARGE.test(text)) return "gross";
  if (SMALL.test(text)) return "klein";
  return "mittel";
}
```

Die tatsächliche Map enthält alle 196 Gemeinden aus dem Seedbestand und keine Laufzeit-Netzwerkabhängigkeit.

- [ ] **Step 4: Repository-Ausgabe ergänzen**

`mapRow()` ergänzt:

```js
region: getApplicationRegion(row.municipality),
projectScale: classifyProjectScale({
  projectType: row.project_type,
  description: row.description
})
```

- [ ] **Step 5: GREEN verifizieren**

Run: `node --test tests/applicationPresentation.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/domain/applicationPresentation.js server/repository/applicationsRepository.js tests/applicationPresentation.test.js
git commit -m "feat: Regionen und Bauvorhabengrösse ableiten"
```

### Task 2: Persönlichen Gelesen-Status speichern

**Files:**
- Modify: `server/db.js`
- Create: `server/repository/applicationReadsRepository.js`
- Modify: `server/app.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Failing API-Test ergänzen**

Der Test meldet Master und Teamkonto an, liest `/api/applications`, markiert einen Fall über `POST /api/applications/:id/read` und prüft, dass nur der Master anschliessend `isUnread: false` erhält.

```js
assert.equal(masterBefore.payload.items[0].isUnread, true);
assert.equal(markRead.status, 204);
assert.equal(masterAfter.payload.items[0].isUnread, false);
assert.equal(teamAfter.payload.items[0].isUnread, true);
```

- [ ] **Step 2: RED verifizieren**

Run: `node --test --test-name-pattern="Gelesen-Status" tests/api.test.js`

Expected: FAIL, weil Tabelle, Repository und Route fehlen.

- [ ] **Step 3: Tabelle und Index ergänzen**

```sql
CREATE TABLE IF NOT EXISTS application_reads (
  user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, application_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_application_reads_application
  ON application_reads(application_id, user_id);
```

- [ ] **Step 4: Reads-Repository implementieren**

```js
export function createApplicationReadsRepository(db) {
  return {
    listReadApplicationIds(userId) {
      return new Set(
        db.prepare("SELECT application_id FROM application_reads WHERE user_id = ?")
          .all(userId)
          .map((row) => row.application_id)
      );
    },
    markRead({ userId, applicationId, readAt }) {
      db.prepare(`INSERT INTO application_reads (user_id, application_id, read_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, application_id) DO NOTHING`)
        .run(userId, applicationId, readAt);
    }
  };
}
```

- [ ] **Step 5: API-Ausgabe und idempotente Route verdrahten**

`GET /api/applications` ergänzt pro Element:

```js
const readIds = applicationReadsRepository.listReadApplicationIds(request.currentUser.id);
const items = repository.list(filters).map((item) => ({
  ...item,
  isUnread: !readIds.has(item.id)
}));
```

`POST /api/applications/:id/read` prüft den Fall, ruft `markRead()` auf und antwortet mit `204`; unbekannte IDs liefern `404`.

- [ ] **Step 6: GREEN und Gesamttests verifizieren**

Run: `node --test --test-name-pattern="Gelesen-Status" tests/api.test.js`

Expected: PASS.

Run: `npm test`

Expected: alle Tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db.js server/repository/applicationReadsRepository.js server/app.js tests/api.test.js
git commit -m "feat: Gelesen-Status pro Benutzer speichern"
```

### Task 3: Fälle unmittelbar nach Fristende löschen

**Files:**
- Modify: `server/repository/applicationsRepository.js`
- Modify: `server/services/maintenanceService.js`
- Modify: `server/services/applicationsSyncService.js`
- Modify: `server/app.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Failing Repository-/Wartungstests schreiben**

```js
test("Fristbereinigung löscht abgelaufene Fälle samt Teamdaten", async () => {
  // Fall A: Frist gestern, Kommentar und Zuweisung vorhanden -> gelöscht.
  // Fall B: Frist heute -> bleibt.
  // Fall C: Frist leer -> bleibt.
  const removed = testServer.maintenanceService.runCleanup();
  assert.equal(removed, 1);
  assert.equal(expiredApplicationCount, 0);
  assert.equal(expiredCommentCount, 0);
  assert.equal(todayApplicationCount, 1);
  assert.equal(missingDeadlineCount, 1);
});
```

- [ ] **Step 2: RED verifizieren**

Run: `node --test --test-name-pattern="Fristbereinigung" tests/api.test.js`

Expected: FAIL, weil die bestehende Bereinigung Kommentare/Zuständigkeit schützt und 90 Tage wartet.

- [ ] **Step 3: Repository-Regel auf bestätigte Löschung umstellen**

```sql
DELETE FROM applications
WHERE IFNULL(deadline_date, '') <> ''
  AND date(deadline_date) < date(?)
```

`pruneExpiredApplications()` erhält `referenceDate`, verwendet das heutige Datum ohne zusätzliche Aufbewahrungstage und führt das Statement in einer Transaktion aus. Fremdschlüssel-Kaskaden löschen Kommentare, Verlauf und Gelesen-Markierungen.

- [ ] **Step 4: Wartungsdienst verdrahten**

`createMaintenanceService()` erhält `applicationsRepository`. `runCleanup()` addiert `applicationsRepository.pruneExpiredApplications({ referenceDate: new Date() })`. `createApp()` übergibt das Repository. Die Synchronisierung ruft dieselbe Methode nach erfolgreichem Import auf.

- [ ] **Step 5: GREEN und Gesamttests verifizieren**

Run: `node --test --test-name-pattern="Fristbereinigung" tests/api.test.js`

Expected: PASS.

Run: `npm test`

Expected: alle Tests PASS; bestehende Tests mit 90-Tage-/Schutzannahmen werden an die ausdrücklich neue Produktregel angepasst.

- [ ] **Step 6: Commit**

```bash
git add server/repository/applicationsRepository.js server/services/maintenanceService.js server/services/applicationsSyncService.js server/app.js tests/api.test.js
git commit -m "feat: abgelaufene Baugesuche endgültig löschen"
```

### Task 4: Inbox- und Regionsfilter in bestehende Oberfläche integrieren

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/redesign.css`
- Modify: `tests/e2e/smoke.spec.js`

- [ ] **Step 1: Failing E2E-Tests für die neue Struktur schreiben**

```js
test("Arbeitsliste kombiniert Haupt- und Regionsfilter", async ({ page }) => {
  await loginAsMaster(page);
  await expect(page.locator('button.tab[data-tab="all"]')).toBeVisible();
  await expect(page.locator('button.tab[data-tab="important"]')).toBeVisible();
  await expect(page.locator('button.tab[data-tab="manual"]')).toHaveCount(0);
  await page.locator('[data-region="Baden"]').click();
  await expect(page.locator('[data-region="Baden"]')).toHaveAttribute("aria-pressed", "true");
});

test("Fallzeilen zeigen Grösse, Quelle und persönliche Ungelesen-Markierung", async ({ page }) => {
  await loginAsMaster(page);
  const row = page.locator("#tbody tr[data-id]").first();
  await expect(row).toHaveClass(/is-unread/);
  await expect(row.locator(".project-scale")).toBeVisible();
  await expect(row.locator(".row-source-link")).toHaveAttribute("target", "_blank");
  await row.click();
  await expect(row).not.toHaveClass(/is-unread/);
});
```

- [ ] **Step 2: RED verifizieren**

Run: `npm run test:e2e -- --grep "Regionsfilter|Ungelesen"`

Expected: FAIL, weil die neue UI noch nicht existiert.

- [ ] **Step 3: HTML-Struktur vereinfachen und ergänzen**

- Tabs `manual`, `open`, `due-soon`, `archive` entfernen.
- Regionennavigation mit vier Buttons und `aria-pressed="false"` ergänzen.
- Unterhalb der Tabelle einen echten Button `#showOlderApplications` mit `aria-expanded="false"` ergänzen.
- Im Detailfeld für Bauvorhaben Platzhalter für `#projectScale` und `#sourceLink` ergänzen.

- [ ] **Step 4: Frontend-Zustand und Filterlogik implementieren**

```js
const state = {
  // bestehende Felder bleiben
  activeRegions: new Set(),
  showOlderApplications: false
};

function isOlderPublication(item, referenceDate = new Date()) {
  if (!item.publicationDate) return true;
  const cutoff = new Date(referenceDate);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 14);
  return new Date(`${item.publicationDate}T00:00:00`) < cutoff;
}
```

`matchesTab()` unterstützt nur noch `all` und `important`; abgelaufene Fälle werden nicht clientseitig archiviert. `matchesFilters()` prüft zusätzlich `activeRegions`. `visibleItems()` sortiert standardmässig nach `publicationDate` absteigend und trennt aktuelle von älteren Publikationen.

- [ ] **Step 5: Rendering und Interaktionen ergänzen**

- `renderTable()` versieht ungelesene Zeilen mit `is-unread` und sichtbarem `Neu`-Text.
- Quellenlinks verwenden `item.sourceUrl`, `target="_blank"`, `rel="noopener noreferrer"` und stoppen das Row-Click-Ereignis.
- Beim `selectItem()` wird `POST /api/applications/:id/read` gesendet und `item.isUnread = false` gesetzt.
- Regionbuttons toggeln unabhängig; keine Auswahl zeigt alle.
- `Mehr anzeigen` schaltet den älteren Bereich zugänglich ein und aus.
- `renderDetail()` ergänzt Grössen-Badge und Quellenlink, ohne Karte oder Bearbeitungsfelder zu verändern.

- [ ] **Step 6: Bestehendes Design gezielt erweitern**

`public/redesign.css` erhält ausschliesslich Styles für `.region-filters`, `.region-chip`, `.is-unread`, `.new-indicator`, `.project-scale`, `.row-source-link` und `.older-applications-toggle`. Hervorhebung verwendet Farbe plus sichtbaren Text/Marker.

- [ ] **Step 7: GREEN verifizieren**

Run: `npm run test:e2e -- --grep "Regionsfilter|Ungelesen"`

Expected: PASS.

Run: `npm test`

Expected: alle Tests PASS.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/redesign.css tests/e2e/smoke.spec.js
git commit -m "feat: Arbeitsliste als regionale Inbox darstellen"
```

### Task 5: Dokumentation, Gesamtprüfung und lokale Website

**Files:**
- Modify: `docs/benutzerhandbuch.md`
- Modify: `docs/systemdokumentation.md`

- [ ] **Step 1: Dokumentation aktualisieren**

Das Benutzerhandbuch beschreibt die zwei Hauptreiter, kombinierbare Regionsfilter, persönliche Ungelesen-Markierungen, 14-Tage-Ansicht, Grössenklassen, Quellenlinks und endgültige Löschung nach Fristende. Die Systemdokumentation ergänzt `application_reads`, abgeleitete Felder und die Bereinigungszeitpunkte.

- [ ] **Step 2: Vollständige Verifikation ausführen**

Run: `npm test`

Expected: Exit 0, keine fehlgeschlagenen Tests.

Run: `npm run test:e2e`

Expected: Exit 0, alle Browserflüsse PASS.

Run: `graphify update .`

Expected: Wissensgraph erfolgreich aktualisiert.

- [ ] **Step 3: Browserabnahme durchführen**

Lokalen Server mit deaktivierter Start-Synchronisierung starten, als Master anmelden und mit realen Daten prüfen:

- beide Hauptreiter,
- null/eine/mehrere Regionen,
- bestehende Suche/Filter,
- ungelesen zu gelesen,
- Quellenlink in neuem Tab,
- `Mehr anzeigen`,
- rechte Fakten, Karte, Einschätzung, Verlauf und Bearbeitung.

Zusätzlich Browserkonsole auf Fehler prüfen und Desktop-Screenshot speichern.

- [ ] **Step 4: Dokumentations-/Abnahmecommit**

```bash
git add docs/benutzerhandbuch.md docs/systemdokumentation.md graphify-out
git commit -m "docs: regionale Inbox und Fristlöschung dokumentieren"
```

- [ ] **Step 5: Website starten und öffnen**

Server auf `http://localhost:3000` starten, Browser sichtbar öffnen und den erfolgreichen Login verifizieren.
