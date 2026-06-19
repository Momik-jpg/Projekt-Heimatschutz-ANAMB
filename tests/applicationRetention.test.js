import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";

test("löscht Fälle am Tag nach der Frist vollständig und behält Fälle ohne Frist", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-retention-"));
  const db = createDatabase(join(directory, "retention.sqlite"), {
    seedDemoApplications: false
  });

  try {
    const repository = createApplicationsRepository(db);
    const baseItem = (id, deadlineDate) => ({
      id,
      source: "Gemeinde-Webseite",
      sourceReference: id,
      sourceUrl: `https://example.org/${id}.pdf`,
      municipality: "Aarau",
      address: "Teststrasse 1",
      coordinates: "",
      publicationDate: "2026-06-01",
      deadlineDate,
      projectType: "Umbau",
      description: "Testfall",
      protectionStatus: "protected-zone",
      agisMatch: "Gebiet geschützt",
      agisLayers: [],
      ambiguousAddress: 0
    });

    repository.importItems(
      [
        baseItem("BG-EXPIRED", "2026-06-18"),
        baseItem("BG-DUE-TODAY", "2026-06-19"),
        baseItem("BG-NO-DEADLINE", "")
      ],
      "2026-06-01T08:00:00.000Z"
    );
    repository.update("BG-EXPIRED", {
      workflowStatus: "under-review",
      assignee: "Lucia Vettori",
      note: "Diese Daten müssen trotz Bearbeitung mit dem Fall verschwinden."
    });

    const userId = db.prepare("SELECT id FROM users WHERE username = 'lucia.vettori'").get().id;
    db.prepare(`
      INSERT INTO application_comments (id, application_id, user_id, message, created_at, updated_at)
      VALUES ('COM-EXPIRED', 'BG-EXPIRED', ?, 'Kommentar', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z')
    `).run(userId);
    db.prepare(`
      INSERT INTO application_reads (application_id, user_id, read_at)
      VALUES ('BG-EXPIRED', ?, '2026-06-02T08:00:00.000Z')
    `).run(userId);
    db.prepare(`
      INSERT INTO import_notifications (
        id, application_id, change_type, source_label, protection_status,
        municipality, address, created_at
      ) VALUES (
        'NOT-EXPIRED', 'BG-EXPIRED', 'new', 'Test', 'protected-zone',
        'Aarau', 'Teststrasse 1', '2026-06-02T08:00:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO application_learning_rules (
        id, municipality_key, municipality, address_signature, project_signature,
        protection_status, agis_match, agis_layers, automated_assessment,
        confidence, match_count, created_from_application_id, created_by_user_id,
        created_at, updated_at
      ) VALUES (
        'LRN-EXPIRED', 'aarau', 'Aarau', 'teststrasse', 'umbau',
        'protected-zone', 'Gebiet geschützt', '[]', 'Prüfen',
        0.9, 1, 'BG-EXPIRED', ?,
        '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z'
      )
    `).run(userId);

    const removed = repository.pruneExpiredApplications({
      referenceDate: new Date("2026-06-19T12:00:00.000Z")
    });

    assert.equal(removed, 1);
    assert.equal(repository.getById("BG-EXPIRED"), null);
    assert.ok(repository.getById("BG-DUE-TODAY"));
    assert.ok(repository.getById("BG-NO-DEADLINE"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_comments WHERE application_id = 'BG-EXPIRED'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_reads WHERE application_id = 'BG-EXPIRED'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM import_notifications WHERE application_id = 'BG-EXPIRED'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_learning_rules WHERE created_from_application_id = 'BG-EXPIRED'").get().count, 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

