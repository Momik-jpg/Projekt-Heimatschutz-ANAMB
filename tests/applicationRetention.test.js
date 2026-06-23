import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";

test("archiviert Fälle 31 Tage nach Publikation und behält Team-Daten", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-retention-"));
  const db = createDatabase(join(directory, "retention.sqlite"), {
    seedDemoApplications: false
  });

  try {
    const repository = createApplicationsRepository(db);
    const baseItem = (id, publicationDate, deadlineDate = "") => ({
      id,
      source: "Gemeinde-Webseite",
      sourceReference: id,
      sourceUrl: `https://example.org/${id}.pdf`,
      municipality: "Aarau",
      address: `Teststrasse ${id}`,
      coordinates: "",
      publicationDate,
      deadlineDate,
      deadlineProvenance: deadlineDate ? "explicit" : "missing",
      addressProvenance: "official-field",
      projectType: "Umbau",
      description: "Testfall",
      protectionStatus: "protected-zone",
      agisMatch: "Gebiet geschützt",
      agisLayers: [],
      ambiguousAddress: 0
    });

    repository.importItems(
      [
        baseItem("BG-EXPIRED", "2026-05-01", "2026-05-14"),
        baseItem("BG-RECENT", "2026-06-10"),
        baseItem("BG-NO-PUB", "")
      ],
      "2026-06-01T08:00:00.000Z"
    );
    repository.update("BG-EXPIRED", {
      workflowStatus: "under-review",
      assignee: "Lucia Vettori",
      note: "Diese Daten müssen mit dem archivierten Fall erhalten bleiben."
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

    const archived = repository.archiveExpiredApplications({
      referenceDate: new Date("2026-06-19T12:00:00.000Z")
    });

    assert.equal(archived, 1);
    assert.equal(repository.getById("BG-EXPIRED").workflowStatus, "archived");
    assert.equal(repository.getById("BG-RECENT").workflowStatus, "new");
    assert.equal(repository.getById("BG-NO-PUB").workflowStatus, "new");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_comments WHERE application_id = 'BG-EXPIRED'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_reads WHERE application_id = 'BG-EXPIRED'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM import_notifications WHERE application_id = 'BG-EXPIRED'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_learning_rules WHERE created_from_application_id = 'BG-EXPIRED'").get().count, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
