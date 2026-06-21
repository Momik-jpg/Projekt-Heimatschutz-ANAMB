// Schema-Migrationen und Backup (aus db.js ausgelagert).
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  cleanImportedAddress,
  normalizeImportedDates
} from "../domain/applicationImportNormalization.js";

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
  { id, dbPath = "", destructive = false, backupFn = backupDatabaseBeforeMigration } = {},
  run
) {
  if (!id || typeof run !== "function" || hasAppliedMigration(db, id)) {
    return false;
  }

  if (destructive && applicationsCount(db) > 0) {
    const backup = backupFn(db, dbPath, id);
    if (backup && backup.status === "failed") {
      throw new Error(
        `Migration "${id}" abgebrochen: Backup fehlgeschlagen (${backup.error?.message ?? "unbekannt"}). ` +
          "Keine destruktive Aenderung ausgefuehrt. Backup bewusst ueberspringbar mit MIGRATION_BACKUP=false."
      );
    }
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

