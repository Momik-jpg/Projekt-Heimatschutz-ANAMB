import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../server/db.js";
import { backfillApplicationSourceEvidence } from "../server/db/migrations.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";

const migrationId = "backfill-application-source-evidence-v1";

function createLegacyApplicationTableWithUniqueSourceReference(db) {
  db.exec(`
    CREATE TABLE applications (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_reference TEXT NOT NULL UNIQUE,
      source_url TEXT NOT NULL,
      municipality TEXT NOT NULL,
      address TEXT NOT NULL,
      parcel TEXT NOT NULL DEFAULT '',
      coordinates TEXT NOT NULL DEFAULT '',
      publication_date TEXT NOT NULL,
      deadline_date TEXT NOT NULL,
      project_type TEXT NOT NULL,
      description TEXT NOT NULL,
      protection_status TEXT NOT NULL,
      agis_match TEXT NOT NULL,
      agis_layers TEXT NOT NULL DEFAULT '[]',
      workflow_status TEXT NOT NULL,
      assignee TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      automated_assessment TEXT NOT NULL DEFAULT '',
      ambiguous_address INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_applications_municipality ON applications(municipality);
    CREATE INDEX idx_applications_source_reference ON applications(source_reference);
  `);
}

function insertLegacyApplication(db) {
  db.prepare(
    `
      INSERT INTO applications (
        id, source, source_reference, source_url, municipality, address, parcel,
        coordinates, publication_date, deadline_date, project_type, description,
        protection_status, agis_match, agis_layers, workflow_status, assignee,
        note, automated_assessment, ambiguous_address, last_sync_at, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "BG-LEGACY",
    "Amtsblatt Aargau",
    "LEGACY-001",
    "https://example.org/legacy-001",
    "Baden",
    "Mellingerstrasse 7",
    "1189",
    "",
    "2026-06-01",
    "",
    "Fenstersanierung",
    "Fenstersanierung",
    "no-hit",
    "",
    "[]",
    "new",
    "",
    "",
    "",
    0,
    "2026-06-01T08:00:00.000Z",
    "2026-06-01T08:00:00.000Z",
    "2026-06-01T08:00:00.000Z"
  );
}

function insertApplication(db, overrides) {
  const item = {
    id: overrides.id,
    source: overrides.source,
    sourceReference: overrides.sourceReference,
    sourceUrl: overrides.sourceUrl ?? `https://example.org/${overrides.sourceReference}`,
    municipality: overrides.municipality ?? "Baden",
    address: overrides.address ?? "Mellingerstrasse 7",
    parcel: overrides.parcel ?? "1189",
    coordinates: overrides.coordinates ?? "",
    locationPrecision: overrides.locationPrecision ?? "",
    publicationDate: overrides.publicationDate ?? "2026-06-01",
    deadlineDate: overrides.deadlineDate ?? "",
    projectType: overrides.projectType ?? "Fenstersanierung",
    description: overrides.description ?? "Fenstersanierung",
    protectionStatus: overrides.protectionStatus ?? "no-hit",
    agisMatch: overrides.agisMatch ?? "",
    agisLayers: overrides.agisLayers ?? "[]",
    workflowStatus: overrides.workflowStatus ?? "new",
    assignee: overrides.assignee ?? "",
    note: overrides.note ?? "",
    automatedAssessment: overrides.automatedAssessment ?? "",
    ambiguousAddress: overrides.ambiguousAddress ?? 0,
    lastSyncAt: overrides.lastSyncAt ?? "2026-06-01T08:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-06-01T08:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-01T08:00:00.000Z"
  };

  db.prepare(
    `
      INSERT INTO applications (
        id, source, source_reference, source_url, municipality, address, parcel,
        coordinates, location_precision, publication_date, deadline_date,
        project_type, description, protection_status, agis_match, agis_layers,
        workflow_status, assignee, note, automated_assessment, ambiguous_address,
        last_sync_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    item.id,
    item.source,
    item.sourceReference,
    item.sourceUrl,
    item.municipality,
    item.address,
    item.parcel,
    item.coordinates,
    item.locationPrecision,
    item.publicationDate,
    item.deadlineDate,
    item.projectType,
    item.description,
    item.protectionStatus,
    item.agisMatch,
    item.agisLayers,
    item.workflowStatus,
    item.assignee,
    item.note,
    item.automatedAssessment,
    item.ambiguousAddress,
    item.lastSyncAt,
    item.createdAt,
    item.updatedAt
  );
}

test("Bestandsmigration legt Quellnachweise an und merged eindeutige Dubletten ohne Teamdatenverlust", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-evidence-migration-"));
  const dbPath = join(directory, "evidence.sqlite");
  let db = createDatabase(dbPath, { seedDemoApplications: false });

  try {
    insertApplication(db, {
      id: "BG-AMT",
      source: "Amtsblatt Aargau",
      sourceReference: "AMT-001",
      deadlineDate: "",
      createdAt: "2026-06-01T08:00:00.000Z"
    });
    insertApplication(db, {
      id: "BG-GEM",
      source: "Gemeinde-Webseite",
      sourceReference: "GEM-001",
      deadlineDate: "2026-06-30",
      assignee: "Fachteam",
      note: "Schon geprüft.",
      createdAt: "2026-06-01T09:00:00.000Z"
    });
    db.prepare(
      `
        INSERT INTO application_comments (id, application_id, user_id, message, created_at, updated_at)
        VALUES ('COM-MIG', 'BG-GEM', 'USR-001', 'Kommentar bleibt erhalten.', ?, ?)
      `
    ).run("2026-06-02T08:00:00.000Z", "2026-06-02T08:00:00.000Z");
    db.prepare(
      `
        INSERT INTO application_reads (application_id, user_id, read_at)
        VALUES ('BG-GEM', 'USR-001', ?)
      `
    ).run("2026-06-02T09:00:00.000Z");
    db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(migrationId);
    db.close();

    db = createDatabase(dbPath, { seedDemoApplications: false });
    const repo = createApplicationsRepository(db);
    const applications = repo.list();
    assert.equal(applications.length, 1);

    const migrated = repo.getById(applications[0].id);
    assert.equal(migrated.assignee, "Fachteam");
    assert.equal(migrated.note, "Schon geprüft.");
    assert.equal(migrated.source, "Amtsblatt Aargau");
    assert.equal(migrated.deadlineDate, "2026-06-30");
    assert.equal(migrated.reconciliationStatus, "amtsblatt-confirmed");
    assert.equal(migrated.sourceEvidence.length, 2);

    const comment = db.prepare("SELECT application_id AS applicationId FROM application_comments WHERE id = 'COM-MIG'").get();
    const read = db.prepare("SELECT application_id AS applicationId FROM application_reads WHERE user_id = 'USR-001'").get();
    assert.equal(comment.applicationId, migrated.id);
    assert.equal(read.applicationId, migrated.id);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Alt-DB-Migration entfernt globale source_reference-Eindeutigkeit und stellt Indizes wieder her", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-legacy-unique-"));
  const dbPath = join(directory, "legacy.sqlite");
  let db;

  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyApplicationTableWithUniqueSourceReference(legacyDb);
    insertLegacyApplication(legacyDb);
    legacyDb.close();

    db = createDatabase(dbPath, { seedDemoApplications: false });
    const tableSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'applications'")
      .get().sql;
    assert.doesNotMatch(tableSql, /source_reference\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

    const indexes = db.prepare("PRAGMA index_list(applications)").all();
    const sourceReferenceIndex = indexes.find((entry) => entry.name === "idx_applications_source_reference");
    assert.ok(sourceReferenceIndex, "source_reference-Index wird nach Tabellenumbau neu angelegt");
    assert.equal(Number(sourceReferenceIndex.unique), 0);

    const repo = createApplicationsRepository(db);
    repo.importItems([
      {
        id: "BG-GEM-SAME-REF",
        source: "Gemeinde Baden",
        sourceReference: "SAME-REF",
        sourceUrl: "https://example.org/gemeinde",
        municipality: "Baden",
        address: "Badstrasse 9",
        parcel: "99",
        coordinates: "",
        publicationDate: "2026-06-02",
        deadlineDate: "2026-06-30",
        projectType: "Umbau Werkstatt",
        description: "Umbau Werkstatt",
        protectionStatus: "no-hit",
        agisMatch: "",
        agisLayers: [],
        ambiguousAddress: 0
      },
      {
        id: "BG-IMPORT-SAME-REF",
        source: "AGIS Baugesuche",
        sourceReference: "SAME-REF",
        sourceUrl: "https://example.org/agis",
        municipality: "Aarau",
        address: "Bahnhofstrasse 1",
        parcel: "22",
        coordinates: "",
        publicationDate: "2026-06-02",
        deadlineDate: "",
        projectType: "Neubau",
        description: "Neubau",
        protectionStatus: "no-hit",
        agisMatch: "",
        agisLayers: [],
        ambiguousAddress: 0
      }
    ]);

    const sameReferenceRows = repo.list().filter((entry) => entry.sourceReference === "SAME-REF");
    assert.equal(sameReferenceRows.length, 2);
    assert.deepEqual(
      sameReferenceRows.map((entry) => entry.municipality).sort(),
      ["Aarau", "Baden"]
    );
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bestandsmigration setzt Gemeindefälle ohne Publikationsdatum auf missing-publication", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    insertApplication(db, {
      id: "BG-NO-PUB",
      source: "Gemeinde-Webseite",
      sourceReference: "GEM-NO-PUB",
      publicationDate: ""
    });

    backfillApplicationSourceEvidence(db);

    const repo = createApplicationsRepository(db);
    const migrated = repo.getById("BG-NO-PUB");
    assert.equal(migrated.reconciliationStatus, "missing-publication");
    assert.equal(migrated.sourceEvidence.length, 1);
  } finally {
    db.close();
  }
});

test("Bestandsmigration verschmilzt zwei Amtsblatt-Fälle nicht nur wegen Inhaltsgleichheit", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    insertApplication(db, {
      id: "BG-AMT-A",
      source: "Amtsblatt Aargau",
      sourceReference: "AMT-A",
      parcel: "1189",
      publicationDate: "2026-06-01"
    });
    insertApplication(db, {
      id: "BG-AMT-B",
      source: "Amtsblatt Aargau",
      sourceReference: "AMT-B",
      parcel: "1189",
      publicationDate: "2026-06-01"
    });

    backfillApplicationSourceEvidence(db);

    const repo = createApplicationsRepository(db);
    assert.equal(repo.list().length, 2);
    assert.deepEqual(
      repo.list().map((entry) => entry.sourceReference).sort(),
      ["AMT-A", "AMT-B"]
    );
  } finally {
    db.close();
  }
});

test("Bestandsmigration markiert mehrdeutige Gemeinde-Zuordnung statt zufällig zu mergen", () => {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  try {
    insertApplication(db, {
      id: "BG-AMT-AMB-1",
      source: "Amtsblatt Aargau",
      sourceReference: "AMT-AMB-1",
      parcel: "1189",
      publicationDate: "2026-06-01"
    });
    insertApplication(db, {
      id: "BG-AMT-AMB-2",
      source: "Amtsblatt Aargau",
      sourceReference: "AMT-AMB-2",
      parcel: "1189",
      publicationDate: "2026-06-01"
    });
    insertApplication(db, {
      id: "BG-GEM-AMB",
      source: "Gemeinde-Webseite",
      sourceReference: "GEM-AMB",
      parcel: "1189",
      publicationDate: "2026-06-01"
    });

    backfillApplicationSourceEvidence(db);

    const repo = createApplicationsRepository(db);
    assert.equal(repo.list().length, 3);
    const ambiguous = repo.getById("BG-GEM-AMB");
    assert.equal(ambiguous.reconciliationStatus, "ambiguous-review");
    assert.equal(ambiguous.sourceEvidence[0].matchStatus, "ambiguous");
  } finally {
    db.close();
  }
});
