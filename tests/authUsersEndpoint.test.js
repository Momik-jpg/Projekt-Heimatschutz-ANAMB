import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";

// S6: /api/auth/users hat ohne Anmeldung interne User-IDs, Anzeigenamen und
// Rollen veroeffentlicht und wurde vom Frontend nicht genutzt -> entfernt.

function boot() {
  const directory = mkdtempSync(join(tmpdir(), "hsa-sec-"));
  const { app, db, stopBackgroundJobs } = createApp({
    dbPath: join(directory, "test.sqlite"),
    seedDemoApplications: true,
    agisAssessmentEnabled: false,
    agisRefreshOnStart: false,
    autoSyncEnabled: false,
    autoSyncRunOnStart: false,
    maintenanceEnabled: false,
    maintenanceRunOnStart: false,
    masterAccountPassword: "Test-Master-Pw-1!",
    defaultLoginPassword: "Heimat2026!"
  });
  const server = app.listen(0);
  return { server, db, stopBackgroundJobs, directory, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("GET /api/auth/users ist nicht oeffentlich erreichbar (kein Daten-Leak)", async () => {
  const { server, db, stopBackgroundJobs, directory, baseUrl } = boot();
  try {
    const res = await fetch(`${baseUrl}/api/auth/users`);
    const body = await res.text();
    assert.equal(res.status, 404, "Endpoint muss entfernt sein");
    assert.ok(!/displayName|"role"/.test(body), "darf keine internen Nutzerdaten zurueckgeben");
  } finally {
    stopBackgroundJobs?.();
    await new Promise((resolve) => server.close(resolve));
    try {
      db?.close?.();
    } catch {
      /* best effort */
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Windows haelt die SQLite-Datei evtl. noch -> Aufraeumen ist best effort */
    }
  }
});
