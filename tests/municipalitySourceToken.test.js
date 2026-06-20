import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S5b: Gemeindequellen-Tokens verschluesselt at-rest, entschluesselt fuer Sync,
// "leer = behalten" beim Update, in der API geschwaerzt. Schluessel vor Import.
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key-32bytes-minimum!!";
const { createDatabase } = await import("../server/db.js");
const { createMunicipalitySourcesRepository } = await import(
  "../server/repository/municipalitySourcesRepository.js"
);
const { createApp } = await import("../server/app.js");

const MASTER_PW = "Test-Master-Pw-1!";

test("Token wird verschluesselt gespeichert und entschluesselt gelesen", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  const repo = createMunicipalitySourcesRepository(db);
  const source = repo.listAll()[0];
  assert.ok(source, "es muss eine Gemeindequelle geben");

  repo.update(source.id, { sourceToken: "geheim-123" });

  assert.equal(repo.getById(source.id).sourceToken, "geheim-123", "Lesen liefert Klartext");
  const raw = db.prepare("SELECT source_token FROM municipality_sources WHERE id = ?").get(source.id).source_token;
  assert.ok(raw.startsWith("gcm:"), "DB muss Ciphertext enthalten");
  assert.ok(!raw.includes("geheim-123"), "Klartext darf nicht in der DB stehen");
});

test("leerer Token beim Update behaelt den bestehenden", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  const repo = createMunicipalitySourcesRepository(db);
  const source = repo.listAll()[0];

  repo.update(source.id, { sourceToken: "behalten-456" });
  repo.update(source.id, { sourceToken: "" });
  assert.equal(repo.getById(source.id).sourceToken, "behalten-456", "leerer Token darf nicht loeschen");

  repo.update(source.id, { notes: "nur Notiz geaendert" });
  assert.equal(repo.getById(source.id).sourceToken, "behalten-456", "Token bleibt bei anderem Update");
});

test("GET /api/admin/municipality-sources schwaerzt den Token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hsa-mtok-"));
  const { app, db, ready, stopBackgroundJobs } = createApp({
    dbPath: join(directory, "test.sqlite"),
    seedDemoApplications: false,
    agisAssessmentEnabled: false,
    agisRefreshOnStart: false,
    autoSyncEnabled: false,
    autoSyncRunOnStart: false,
    maintenanceEnabled: false,
    maintenanceRunOnStart: false,
    masterAccountPassword: MASTER_PW,
    defaultLoginPassword: "Heimat2026!"
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await ready;
    const repo = createMunicipalitySourcesRepository(db);
    const source = repo.listAll()[0];
    repo.update(source.id, { sourceToken: "api-geheim-789" });

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "master", password: MASTER_PW })
    });
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    const res = await fetch(`${baseUrl}/api/admin/municipality-sources`, { headers: { Cookie: cookie } });
    const raw = await res.text();
    const payload = JSON.parse(raw);
    const item = payload.items.find((entry) => entry.id === source.id);

    assert.ok(item, "Quelle muss in der Liste sein");
    assert.ok(!("sourceToken" in item), "kein sourceToken-Feld in der API");
    assert.equal(item.sourceTokenSet, true, "sourceTokenSet muss true sein");
    assert.ok(!raw.includes("api-geheim-789"), "Token-Klartext darf nicht im Body sein");
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
      /* best effort */
    }
  }
});
