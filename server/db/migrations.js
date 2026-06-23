// Schema-Migrationen und Backup (aus db.js ausgelagert).
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  cleanImportedAddress,
  normalizeImportedDates
} from "../domain/applicationImportNormalization.js";
import {
  SOURCE_KIND_AMTSBLATT,
  buildCanonicalFields,
  canReconcileSources,
  deriveReconciliationStatus,
  findReconciliationMatch,
  normalizeMunicipality,
  sourceKindOf
} from "../domain/sourceReconciliation.js";
import { randomBytes } from "node:crypto";

// Fügt eine Spalte nur hinzu, wenn sie in einer bestehenden DB noch fehlt
// (CREATE TABLE IF NOT EXISTS ändert vorhandene Tabellen nicht).
export function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function normalizeLegacyApplicationCoordinates(db) {
  const rows = db
    .prepare(
      `
        SELECT id, coordinates
        FROM applications
        WHERE IFNULL(coordinates, '') <> ''
      `
    )
    .all();
  const update = db.prepare("UPDATE applications SET coordinates = ? WHERE id = ?");
  const looksLikeLv95East = (value) => value >= 2400000 && value <= 2900000;
  const looksLikeLv95North = (value) => value >= 1000000 && value <= 1400000;

  for (const row of rows) {
    const [firstValue, secondValue] =
      String(row.coordinates)
        .match(/\d{6,7}(?:\.\d+)?/g)
        ?.map((value) => Number(value)) ?? [];

    if (
      Number.isFinite(firstValue) &&
      Number.isFinite(secondValue) &&
      looksLikeLv95North(firstValue) &&
      looksLikeLv95East(secondValue)
    ) {
      update.run(`${secondValue},${firstValue}`, row.id);
    }
  }
}

export function normalizeInvalidApplicationDeadlines(db) {
  const assessmentNote = "Fristdatum liegt vor Publikationsdatum und muss von Hand geprüft werden.";

  // Ein Fristdatum vor dem Publikationsdatum ist ein reines Datenqualitäts-
  // problem. Es wird geleert und als Hinweis vermerkt, der Schutzstatus bleibt
  // aber unangetastet: sonst würde ein möglicher Schutztreffer pauschal auf
  // "manual-review" gesetzt, danach nicht mehr durch AGIS geprüft und aus der
  // Prioritätsliste entfernt.
  db.prepare(
    `
      UPDATE applications
      SET deadline_date = '',
          automated_assessment = CASE
            WHEN IFNULL(automated_assessment, '') = '' THEN ?
            WHEN automated_assessment LIKE '%' || ? || '%' THEN automated_assessment
            ELSE automated_assessment || ' ' || ?
          END
      WHERE IFNULL(publication_date, '') <> ''
        AND IFNULL(deadline_date, '') <> ''
        AND date(deadline_date) < date(publication_date)
    `
  ).run(assessmentNote, assessmentNote, assessmentNote);
}

function applicationTableHasUniqueSourceReference(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'applications'")
    .get();
  return /source_reference\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(String(row?.sql ?? ""));
}

export function relaxApplicationSourceReferenceUniqueness(db) {
  if (!applicationTableHasUniqueSourceReference(db)) {
    return;
  }

  const columns = [
    "id",
    "source",
    "source_reference",
    "source_url",
    "municipality",
    "address",
    "address_provenance",
    "parcel",
    "coordinates",
    "location_precision",
    "publication_date",
    "deadline_date",
    "deadline_provenance",
    "project_type",
    "description",
    "protection_status",
    "agis_match",
    "agis_layers",
    "workflow_status",
    "archived_at",
    "reconciliation_status",
    "assignee",
    "note",
    "automated_assessment",
    "ambiguous_address",
    "last_sync_at",
    "created_at",
    "updated_at"
  ].join(", ");

  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("PRAGMA legacy_alter_table = ON;");
    db.exec("BEGIN;");
    db.exec(`
      ALTER TABLE applications RENAME TO applications_old_unique_source_reference;

      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        source_url TEXT NOT NULL,
        municipality TEXT NOT NULL,
        address TEXT NOT NULL,
        address_provenance TEXT NOT NULL DEFAULT 'legacy-unknown',
        parcel TEXT NOT NULL DEFAULT '',
        coordinates TEXT NOT NULL DEFAULT '',
        location_precision TEXT NOT NULL DEFAULT '',
        publication_date TEXT NOT NULL,
        deadline_date TEXT NOT NULL,
        deadline_provenance TEXT NOT NULL DEFAULT 'legacy-unknown',
        project_type TEXT NOT NULL,
        description TEXT NOT NULL,
        protection_status TEXT NOT NULL,
        agis_match TEXT NOT NULL,
        agis_layers TEXT NOT NULL DEFAULT '[]',
        workflow_status TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT '',
        reconciliation_status TEXT NOT NULL DEFAULT '',
        assignee TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        automated_assessment TEXT NOT NULL DEFAULT '',
        ambiguous_address INTEGER NOT NULL DEFAULT 0,
        last_sync_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO applications (${columns})
      SELECT ${columns}
      FROM applications_old_unique_source_reference;

      DROP TABLE applications_old_unique_source_reference;

      CREATE INDEX IF NOT EXISTS idx_applications_municipality ON applications(municipality);
      CREATE INDEX IF NOT EXISTS idx_applications_protection_status ON applications(protection_status);
      CREATE INDEX IF NOT EXISTS idx_applications_workflow_deadline ON applications(workflow_status, deadline_date);
      CREATE INDEX IF NOT EXISTS idx_applications_source_municipality ON applications(source, municipality);
      CREATE INDEX IF NOT EXISTS idx_applications_source_reference ON applications(source_reference);
      CREATE INDEX IF NOT EXISTS idx_applications_last_sync_at ON applications(last_sync_at DESC);
    `);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback errors; the original error is more useful.
    }
    throw error;
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF;");
    db.exec("PRAGMA foreign_keys = ON;");
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error("Migration der Anwendungen abgebrochen: Fremdschlüsselprüfung fehlgeschlagen.");
  }
}

export function hasAppliedMigration(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id));
}

export function recordAppliedMigration(db, id) {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
    id,
    new Date().toISOString()
  );
}

export function applicationsCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM applications").get()?.count ?? 0);
}

export function repairImportedApplicationFields(db) {
  const rows = db.prepare(`
    SELECT id, address, publication_date, deadline_date, project_type,
           description, created_at
    FROM applications
  `).all();
  const update = db.prepare(`
    UPDATE applications
    SET address = ?, publication_date = ?, deadline_date = ?, updated_at = ?
    WHERE id = ?
  `);
  const repairedAt = new Date().toISOString();

  for (const row of rows) {
    const address = cleanImportedAddress(row.address) || row.address;
    const dates = normalizeImportedDates({
      publicationDate: row.publication_date,
      deadlineDate: row.deadline_date,
      text: [row.description, row.project_type, row.address].filter(Boolean).join(" "),
      referenceDate: new Date()
    });
    if (
      address !== row.address
      || dates.publicationDate !== row.publication_date
      || dates.deadlineDate !== row.deadline_date
    ) {
      update.run(address, dates.publicationDate, dates.deadlineDate, repairedAt, row.id);
    }
  }
}

function mapApplicationRow(row) {
  return {
    id: row.id,
    source: row.source,
    sourceReference: row.source_reference,
    sourceUrl: row.source_url,
    municipality: row.municipality,
    address: row.address,
    parcel: row.parcel,
    publicationDate: row.publication_date,
    deadlineDate: row.deadline_date,
    projectType: row.project_type,
    workflowStatus: row.workflow_status,
    assignee: row.assignee,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncAt: row.last_sync_at,
    commentsCount: Number(row.comments_count ?? 0),
    readsCount: Number(row.reads_count ?? 0)
  };
}

function listBackfillApplications(db) {
  return db
    .prepare(
      `
        SELECT a.*,
          (SELECT COUNT(*) FROM application_comments c WHERE c.application_id = a.id) AS comments_count,
          (SELECT COUNT(*) FROM application_reads r WHERE r.application_id = a.id) AS reads_count
        FROM applications a
        ORDER BY a.created_at ASC, a.id ASC
      `
    )
    .all()
    .map(mapApplicationRow);
}

function rowHasTeamState(row) {
  return (
    row.workflowStatus !== "new"
    || Boolean(String(row.assignee ?? "").trim())
    || Boolean(String(row.note ?? "").trim())
    || row.commentsCount > 0
    || row.readsCount > 0
  );
}

function compareCreatedAt(left, right) {
  const leftTime = new Date(left.createdAt || left.updatedAt || 0).getTime();
  const rightTime = new Date(right.createdAt || right.updatedAt || 0).getTime();
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return left.id.localeCompare(right.id);
  if (Number.isNaN(leftTime)) return 1;
  if (Number.isNaN(rightTime)) return -1;
  return leftTime - rightTime || left.id.localeCompare(right.id);
}

function chooseBackfillMergeHost(left, right) {
  const leftTouched = rowHasTeamState(left);
  const rightTouched = rowHasTeamState(right);
  if (leftTouched && rightTouched) return null;
  if (leftTouched) return left;
  if (rightTouched) return right;

  const leftIsAmtsblatt = sourceKindOf(left.source) === SOURCE_KIND_AMTSBLATT;
  const rightIsAmtsblatt = sourceKindOf(right.source) === SOURCE_KIND_AMTSBLATT;
  if (leftIsAmtsblatt && !rightIsAmtsblatt) return left;
  if (rightIsAmtsblatt && !leftIsAmtsblatt) return right;

  return compareCreatedAt(left, right) <= 0 ? left : right;
}

function evidenceFromApplication(row) {
  return {
    sourceKind: sourceKindOf(row.source),
    sourceName: row.source,
    sourceReference: row.sourceReference,
    sourceUrl: row.sourceUrl,
    municipality: row.municipality,
    publicationDate: row.publicationDate,
    deadlineDate: row.deadlineDate,
    address: row.address,
    parcel: row.parcel,
    projectType: row.projectType
  };
}

function upsertBackfillEvidence(db, applicationId, evidence, observedAt, matchStatus = evidence.matchStatus ?? "matched") {
  db.prepare(
    `
      INSERT INTO application_source_evidence (
        id, application_id, source_kind, source_name, source_reference, source_url,
        municipality, publication_date, deadline_date, address, parcel, project_type,
        match_status, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_kind, source_reference) DO UPDATE SET
        application_id = excluded.application_id,
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        municipality = excluded.municipality,
        publication_date = excluded.publication_date,
        deadline_date = excluded.deadline_date,
        address = excluded.address,
        parcel = excluded.parcel,
        project_type = excluded.project_type,
        match_status = excluded.match_status,
        observed_at = excluded.observed_at
    `
  ).run(
    `EVD-${randomBytes(8).toString("hex").toUpperCase()}`,
    applicationId,
    evidence.sourceKind,
    evidence.sourceName ?? "",
    evidence.sourceReference,
    evidence.sourceUrl ?? "",
    evidence.municipality ?? "",
    evidence.publicationDate ?? "",
    evidence.deadlineDate ?? "",
    evidence.address ?? "",
    evidence.parcel ?? "",
    evidence.projectType ?? "",
    matchStatus,
    observedAt
  );
}

function listBackfillEvidence(db, applicationId) {
  return db
    .prepare(
      `
        SELECT source_kind AS sourceKind, source_name AS sourceName,
               source_reference AS sourceReference, source_url AS sourceUrl,
               municipality, publication_date AS publicationDate,
               deadline_date AS deadlineDate, address, parcel, project_type AS projectType
               , match_status AS matchStatus
        FROM application_source_evidence
        WHERE application_id = ?
        ORDER BY CASE WHEN source_kind = 'amtsblatt' THEN 0 ELSE 1 END, observed_at ASC
      `
    )
    .all(applicationId);
}

function reconcileBackfillApplication(db, applicationId, observedAt) {
  const evidences = listBackfillEvidence(db, applicationId);
  if (evidences.length === 0) return;

  const canonical = buildCanonicalFields(evidences);
  const status = deriveReconciliationStatus(evidences);
  const amtsblatt = evidences.find((entry) => entry.sourceKind === SOURCE_KIND_AMTSBLATT);
  const fallback = db
    .prepare("SELECT source, source_url, municipality FROM applications WHERE id = ?")
    .get(applicationId) ?? {};
  const source = amtsblatt ? amtsblatt.sourceName || "Amtsblatt Aargau" : fallback.source ?? "";
  const sourceUrl = amtsblatt ? amtsblatt.sourceUrl || fallback.source_url || "" : fallback.source_url ?? "";

  db.prepare(
    `
      UPDATE applications
      SET source = ?, source_url = ?, municipality = ?, address = ?, parcel = ?,
          publication_date = ?, deadline_date = ?, project_type = ?,
          reconciliation_status = ?, updated_at = ?
      WHERE id = ?
    `
  ).run(
    source,
    sourceUrl,
    canonical.municipality || fallback.municipality || "",
    canonical.address,
    canonical.parcel,
    canonical.publicationDate,
    canonical.deadlineDate,
    canonical.projectType,
    status,
    observedAt,
    applicationId
  );
}

function mergeBackfillApplications(db, host, duplicate, observedAt) {
  db.prepare("UPDATE application_comments SET application_id = ? WHERE application_id = ?").run(host.id, duplicate.id);
  db.prepare(
    `
      INSERT OR IGNORE INTO application_reads (application_id, user_id, read_at)
      SELECT ?, user_id, read_at
      FROM application_reads
      WHERE application_id = ?
    `
  ).run(host.id, duplicate.id);
  db.prepare("DELETE FROM application_reads WHERE application_id = ?").run(duplicate.id);
  db.prepare("UPDATE import_notifications SET application_id = ? WHERE application_id = ?").run(host.id, duplicate.id);
  db.prepare("UPDATE application_source_evidence SET application_id = ? WHERE application_id = ?").run(host.id, duplicate.id);
  db.prepare("UPDATE application_learning_rules SET created_from_application_id = ? WHERE created_from_application_id = ?").run(
    host.id,
    duplicate.id
  );
  db.prepare("DELETE FROM applications WHERE id = ?").run(duplicate.id);
  reconcileBackfillApplication(db, host.id, observedAt);
}

export function backfillApplicationSourceEvidence(db) {
  const observedAt = new Date().toISOString();

  for (const row of listBackfillApplications(db)) {
    upsertBackfillEvidence(db, row.id, evidenceFromApplication(row), row.lastSyncAt || observedAt);
  }

  let merged = true;
  while (merged) {
    merged = false;
    const rows = listBackfillApplications(db);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const row of rows) {
      const rowKind = sourceKindOf(row.source);
      if (rowKind === SOURCE_KIND_AMTSBLATT) continue;

      const candidates = rows.filter(
        (candidate) =>
          candidate.id !== row.id
          && candidate.workflowStatus !== "archived"
          && canReconcileSources(rowKind, sourceKindOf(candidate.source))
          && normalizeMunicipality(candidate.municipality) === normalizeMunicipality(row.municipality)
      );
      const match = findReconciliationMatch(row, candidates);
      if (match.status === "ambiguous") {
        upsertBackfillEvidence(db, row.id, { ...evidenceFromApplication(row), matchStatus: "ambiguous" }, row.lastSyncAt || observedAt);
        continue;
      }
      if (match.status !== "matched") continue;

      const candidate = byId.get(match.candidate.id);
      if (!candidate) continue;

      const host = chooseBackfillMergeHost(row, candidate);
      if (!host) continue;
      const duplicate = host.id === row.id ? candidate : row;
      mergeBackfillApplications(db, host, duplicate, observedAt);
      merged = true;
      break;
    }
  }

  for (const row of listBackfillApplications(db)) {
    reconcileBackfillApplication(db, row.id, observedAt);
  }
}

/**
 * Legt vor einer destruktiven Migration eine Sicherungskopie der SQLite-Datei
 * an (best effort). Per MIGRATION_BACKUP=false abschaltbar; bei In-Memory-DB,
 * fehlendem Pfad oder Fehlern wird kein Backup erstellt.
 */
export function backupDatabaseBeforeMigration(db, dbPath, migrationId) {
  // status: "skipped" (bewusst kein Backup noetig), "ok" (Backup erstellt) oder
  // "failed" (Backup wollte erstellt werden, schlug aber fehl). Nur "failed"
  // darf eine destruktive Migration verhindern.
  if (!dbPath || dbPath === ":memory:") {
    return { status: "skipped" };
  }

  if (String(process.env.MIGRATION_BACKUP ?? "").trim().toLowerCase() === "false") {
    return { status: "skipped" };
  }

  try {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Checkpoint ist best effort.
    }

    const directory = join(dirname(dbPath), "backups");
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const target = join(directory, `${basename(dbPath)}.pre-${migrationId}.${stamp}.bak`);
    copyFileSync(dbPath, target);
    return { status: "ok", path: target };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * Führt eine Datenmigration genau einmal pro Datenbank aus und vermerkt sie in
 * schema_migrations. So werden Fachdaten nicht bei jedem Start verändert oder
 * gelöscht. Vor destruktiven Migrationen wird – sofern bereits Daten vorhanden
 * sind – ein Backup angelegt. Der Lauf selbst ist in eine Transaktion gekapselt.
 */
export function applyMigrationOnce(
  db,
  { id, dbPath = "", destructive = false, backupFn = backupDatabaseBeforeMigration, transaction = true } = {},
  run
) {
  if (!id || typeof run !== "function" || hasAppliedMigration(db, id)) {
    return false;
  }

  if (destructive && applicationsCount(db) > 0) {
    const backup = backupFn(db, dbPath, id);
    if (backup && backup.status === "failed") {
      throw new Error(
        `Migration "${id}" abgebrochen: Backup fehlgeschlagen (${backup.error?.message ?? "ohne Detail"}). ` +
          "Keine destruktive Aenderung ausgefuehrt. Backup bewusst ueberspringbar mit MIGRATION_BACKUP=false."
      );
    }
  }

  if (!transaction) {
    run(db);
    recordAppliedMigration(db, id);
    return true;
  }

  db.exec("BEGIN");

  try {
    run(db);
    recordAppliedMigration(db, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return true;
}
