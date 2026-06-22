import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";
import { createMaintenanceService } from "../server/services/maintenanceService.js";

function importedItem(id, { deadlineProvenance = "explicit", publicationDate = "2026-05-01", deadlineDate = "2026-05-14" } = {}) {
  return {
    id,
    source: "Amtsblatt Aargau",
    sourceReference: id,
    sourceUrl: `https://example.org/${id}`,
    municipality: "Aarau",
    address: "Teststrasse 1",
    coordinates: "2645000,1249000",
    locationPrecision: "precise",
    publicationDate,
    deadlineDate,
    deadlineProvenance,
    addressProvenance: "official-field",
    projectType: "Umbau",
    description: "Testfall",
    protectionStatus: "no-hit",
    agisMatch: "Kein Schutztreffer",
    agisLayers: [],
    ambiguousAddress: 0
  };
}

test("bestehende Datenbank erhält konservative Provenienzspalten", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    const columns = new Map(db.prepare("PRAGMA table_info(applications)").all().map((column) => [column.name, column]));
    assert.equal(columns.get("deadline_provenance")?.dflt_value, "'legacy-unknown'");
    assert.equal(columns.get("address_provenance")?.dflt_value, "'legacy-unknown'");
    assert.equal(columns.get("archived_at")?.dflt_value, "''");
  } finally {
    db.close();
  }
});

test("Fälle 31 Tage nach Publikation werden mit Team-Daten archiviert statt gelöscht", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    const repository = createApplicationsRepository(db);
    repository.importItems([importedItem("BG-EXPLICIT")], "2026-06-01T08:00:00.000Z");
    const userId = db.prepare("SELECT id FROM users WHERE username = 'lucia.vettori'").get().id;
    db.prepare(`
      INSERT INTO application_comments (id, application_id, user_id, message, created_at, updated_at)
      VALUES ('COM-EXPLICIT', 'BG-EXPLICIT', ?, 'Teamwissen', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z')
    `).run(userId);

    const archived = repository.archiveExpiredApplications({
      referenceDate: new Date("2026-06-19T12:00:00.000Z")
    });

    assert.equal(archived, 1);
    const item = repository.getById("BG-EXPLICIT");
    assert.equal(item.workflowStatus, "archived");
    assert.equal(item.deadlineProvenance, "explicit");
    assert.equal(item.archivedAt, "2026-06-19T12:00:00.000Z");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_comments WHERE application_id='BG-EXPLICIT'").get().count, 1);
  } finally {
    db.close();
  }
});

test("Fälle ohne Publikationsdatum werden nicht automatisch archiviert", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    const repository = createApplicationsRepository(db);
    repository.importItems(
      [importedItem("BG-NO-PUB", { publicationDate: "", deadlineDate: "", deadlineProvenance: "missing" })],
      "2026-06-01T08:00:00.000Z"
    );

    assert.equal(repository.archiveExpiredApplications({ referenceDate: new Date("2026-06-19T12:00:00.000Z") }), 0);
    const item = repository.getById("BG-NO-PUB");
    assert.equal(item.workflowStatus, "new");
  } finally {
    db.close();
  }
});

test("Fallarchivierung löscht keine vorhandenen Datenbank-Backups", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-retention-safe-"));
  const backupDirectory = join(directory, "backups");
  const backup = join(backupDirectory, "heimatschutz.sqlite.pre-migration.bak");
  mkdirSync(backupDirectory, { recursive: true });
  writeFileSync(backup, "backup data");

  try {
    const service = createMaintenanceService({
      dbPath: join(directory, "heimatschutz.sqlite"),
      applicationsRepository: { archiveExpiredApplications: () => 2 },
      runOnStart: false,
      backupEnabled: false
    });

    const result = service.runNow();
    assert.equal(result.archivedApplications, 2);
    assert.equal(result.purgedBackups, 0);
    assert.equal(existsSync(backup), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
