import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { findSuspectedInferredDeadlines } from "../scripts/diagnose-inferred-deadlines.js";

test("Diagnose findet nur Amtsblatt-Fristen mit exakt 30 Tagen Abstand", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    const insert = db.prepare(`
      INSERT INTO applications (
        id, source, source_reference, source_url, municipality, address,
        publication_date, deadline_date, project_type, description,
        protection_status, agis_match, workflow_status, last_sync_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', 'Aarau', 'Teststrasse 1', ?, ?, 'Umbau', '', 'no-hit', '', 'new', ?, ?, ?)
    `);
    insert.run("BG-SUSPECT", "Amtsblatt Aargau", "amtsblatt:suspect", "2026-06-01", "2026-07-01", "t", "t", "t");
    insert.run("BG-EXPLICIT", "Amtsblatt Aargau", "amtsblatt:explicit", "2026-06-01", "2026-07-02", "t", "t", "t");
    insert.run("BG-OTHER", "Gemeinde-Webseite", "other", "2026-06-01", "2026-07-01", "t", "t", "t");

    const rows = findSuspectedInferredDeadlines(db);
    assert.deepEqual(rows.map((row) => row.id), ["BG-SUSPECT"]);
    assert.equal(rows[0].sourceReference, "amtsblatt:suspect");
    assert.equal(rows[0].hasTeamWork, false);
  } finally {
    db.close();
  }
});
