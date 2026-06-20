import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../server/db.js";

test("repariert bereits gespeicherte Datumsbereiche und Adressreste einmalig", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-data-repair-"));
  const dbPath = join(directory, "repair.sqlite");
  let db = createDatabase(dbPath, { seedDemoApplications: false });

  try {
    db.prepare(`
      INSERT INTO applications (
        id, source, source_reference, source_url, municipality, address,
        publication_date, deadline_date, project_type, description,
        protection_status, agis_match, workflow_status, last_sync_at,
        created_at, updated_at
      ) VALUES (
        'BG-REPAIR', 'Gemeinde-Webseite', 'BG-REPAIR', 'https://example.org/fall', 'Aarau',
        'Bahnhofstrasse 5 box box-large box-mainbox" data-index="68"',
        '2026-07-06', '2026-07-06', 'Baugesuch',
        'Öffentliche Auflage vom 5. Juni bis 6. Juli 2026',
        'no-hit', 'Kein Schutz', 'new',
        '2026-06-20T08:00:00.000Z', '2026-06-20T08:00:00.000Z', '2026-06-20T08:00:00.000Z'
      )
    `).run();
    db.prepare("DELETE FROM schema_migrations WHERE id = 'repair-imported-application-fields-v1'").run();
    db.close();

    db = createDatabase(dbPath, { seedDemoApplications: false });
    const item = db.prepare(`
      SELECT address, publication_date AS publicationDate, deadline_date AS deadlineDate
      FROM applications WHERE id = 'BG-REPAIR'
    `).get();
    assert.equal(item.address, "Bahnhofstrasse 5");
    assert.equal(item.publicationDate, "2026-06-05");
    assert.equal(item.deadlineDate, "2026-07-06");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
