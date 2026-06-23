import {
  insertSeedRecords,
  insertSeedUsers,
  insertSeedMunicipalitySources,
  upsertSeedMunicipalities,
  upsertSeedPublicationSources,
  upsertSeedMunicipalitySourceLinks,
  upsertSeedMunicipalityQualityAssessments,
  backfillSeedMunicipalitySources,
  syncConfiguredMasterPassword
} from "./db/seed.js";

import { schema } from "./db/schema.js";
import {
  ensureColumn,
  normalizeLegacyApplicationCoordinates,
  normalizeInvalidApplicationDeadlines,
  repairImportedApplicationFields,
  backfillApplicationSourceEvidence,
  relaxApplicationSourceReferenceUniqueness,
  applyMigrationOnce
} from "./db/migrations.js";

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// ACHTUNG: node:sqlite (DatabaseSync) ist in Node noch als *experimental* markiert
// ("might change at any time") und erfordert Node >= 24 (siehe package.json engines).
// Folgen: (1) Die API kann sich zwischen Node-Versionen ändern – Node-Version pinnen.
// (2) DatabaseSync ist synchron und blockiert die Event-Loop bei jedem Query; für den
// internen Low-Traffic-Betrieb akzeptabel, bei steigender Last auf better-sqlite3 wechseln.
import { DatabaseSync } from "node:sqlite";
import {
  aargauMunicipalities,
  aargauMunicipalityQualityAssessments,
  aargauMunicipalitySourceLinks,
  aargauMunicipalitySources,
  aargauPublicationSources,
} from "./seed/municipalitySources.js";
import { seedApplications } from "./seed/applications.js";
import { seedUsers } from "./seed/users.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDbPath = process.env.DATABASE_PATH || join(rootDir, "data", "heimatschutz.sqlite");
const defaultSeedDemoApplications =
  String(process.env.SEED_DEMO_APPLICATIONS ?? "")
    .trim()
    .toLowerCase() === "true";
/**
 * @param {string} [dbPath]
 * @param {CreateDatabaseOptions} [options]
 */
// Demo-Daten sollen immer aktuell wirken: die statischen Seed-Publikationsdaten
// werden so verschoben, dass der neueste Fall etwa zwei Tage alt ist. Sonst
// altern die festen Daten aus dem 31-Tage-Fenster der aktiven Liste heraus und
// die Demo-/E2E-Liste wäre leer. Die relative Reihenfolge bleibt erhalten.
function shiftSeedDatesToRecent(applications, referenceDate = new Date()) {
  const day = 24 * 60 * 60 * 1000;
  const toTime = (value) => {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  };
  const times = applications.map((item) => toTime(item.publicationDate)).filter((time) => time !== null);
  if (times.length === 0) return applications;

  const newest = Math.max(...times);
  const target = referenceDate.getTime() - 2 * day;
  const shiftDays = Math.round((target - newest) / day);
  if (shiftDays === 0) return applications;

  const shift = (value) => {
    const time = toTime(value);
    return time === null ? value : new Date(time + shiftDays * day).toISOString().slice(0, 10);
  };
  return applications.map((item) => ({
    ...item,
    publicationDate: shift(item.publicationDate),
    deadlineDate: shift(item.deadlineDate)
  }));
}

export function createDatabase(dbPath = defaultDbPath, options = {}) {
  const databaseOptions = /** @type {Record<string, unknown>} */ (options);
  const seedDemoApplications = databaseOptions.seedDemoApplications ?? defaultSeedDemoApplications;
  const masterAccountPassword = String(databaseOptions.masterAccountPassword ?? process.env.MASTER_ACCOUNT_PASSWORD ?? "").trim();
  const defaultLoginPassword = String(databaseOptions.defaultLoginPassword ?? process.env.DEFAULT_LOGIN_PASSWORD ?? "").trim();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  ensureColumn(db, "users", "email", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "applications", "location_precision", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "applications", "address_provenance", "TEXT NOT NULL DEFAULT 'legacy-unknown'");
  ensureColumn(db, "applications", "deadline_provenance", "TEXT NOT NULL DEFAULT 'legacy-unknown'");
  ensureColumn(db, "applications", "archived_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "applications", "reconciliation_status", "TEXT NOT NULL DEFAULT ''");
  applyMigrationOnce(
    db,
    { id: "relax-application-source-reference-unique-v1", dbPath, destructive: true, transaction: false },
    relaxApplicationSourceReferenceUniqueness
  );
  // Datenmigrationen laufen einmalig pro Datenbank (vermerkt in
  // schema_migrations), nicht bei jedem Start. Vor destruktiven Schritten wird
  // – sofern Daten vorhanden sind – ein Backup angelegt.
  applyMigrationOnce(db, { id: "normalize-legacy-coordinates", dbPath }, normalizeLegacyApplicationCoordinates);
  applyMigrationOnce(
    db,
    { id: "clear-invalid-deadlines", dbPath, destructive: true },
    normalizeInvalidApplicationDeadlines
  );
  applyMigrationOnce(
    db,
    { id: "repair-imported-application-fields-v1", dbPath, destructive: true },
    repairImportedApplicationFields
  );
  applyMigrationOnce(db, { id: "cleanup-seed-artifacts-and-junk", dbPath, destructive: true }, (database) => {
    database.exec(`
    UPDATE applications
    SET workflow_status = 'new'
    WHERE workflow_status = 'escalated';

    UPDATE applications
    SET note = ''
    WHERE note = 'Mögliches Einsprachepotenzial. Priorisiert behandeln.';

    UPDATE applications
    SET assignee = ''
    WHERE source_reference = 'GS-ZOF-2026-014'
      AND assignee = 'Aleksandar Nikolic';

    UPDATE applications
    SET automated_assessment = 'Der Standort wurde einem geschützten Inventarobjekt zugeordnet.'
    WHERE source_reference = 'GS-ZOF-2026-014'
      AND automated_assessment = 'Objekt ist im Inventar eingetragen und liegt in sensiblem Ortsbildbereich.';

    DELETE FROM applications
    WHERE source = 'Gemeinde-Webseite'
      AND address = 'Adresse von Webseite prüfen'
      AND IFNULL(parcel, '') = ''
      AND IFNULL(coordinates, '') = ''
      AND workflow_status = 'new'
      AND IFNULL(assignee, '') = ''
      AND IFNULL(note, '') = ''
      AND id NOT IN (SELECT application_id FROM application_comments);

    DELETE FROM applications
    WHERE source = 'Gemeinde-Webseite'
      AND ambiguous_address = 1
      AND IFNULL(parcel, '') = ''
      AND IFNULL(coordinates, '') = ''
      AND workflow_status = 'new'
      AND IFNULL(assignee, '') = ''
      AND IFNULL(note, '') = ''
      AND id NOT IN (SELECT application_id FROM application_comments)
      AND (
        address LIKE 'Januar 20%'
        OR address LIKE 'Februar 20%'
        OR address LIKE 'März 20%'
        OR address LIKE 'März 20%'
        OR address LIKE 'April 20%'
        OR address LIKE 'Mai 20%'
        OR address LIKE 'Juni 20%'
        OR address LIKE 'Juli 20%'
        OR address LIKE 'August 20%'
        OR address LIKE 'September 20%'
        OR address LIKE 'Oktober 20%'
        OR address LIKE 'November 20%'
        OR address LIKE 'Dezember 20%'
        OR address LIKE '%Facebook%'
        OR address LIKE '%Instagram%'
        OR address LIKE '%Youtube%'
        OR address LIKE '%Gemeinderatsnachrichten%'
        OR address LIKE '%Aktuelles%'
        OR address LIKE '%News%'
        OR address LIKE '%Vernehmlassung%'
        OR address LIKE '%Wohnraumstrategie%'
        OR address LIKE '%Stadtteilziele%'
        OR address LIKE '%Förderprogramm%'
        OR address LIKE '%Stadtbibliothek%'
        OR address LIKE '%Einbürgerung%'
        OR address LIKE '%Altlasten%'
        OR address LIKE '%Zertifizierung%'
        OR project_type LIKE '%Wohnraumstrategie%'
        OR project_type LIKE '%Stadtteilziele%'
        OR project_type LIKE '%Förderprogramm%'
        OR project_type LIKE '%Stadtbibliothek%'
        OR project_type LIKE '%Einbürgerung%'
        OR project_type LIKE '%Altlasten%'
        OR project_type LIKE '%Zertifizierung%'
        OR description LIKE '%Wohnraumstrategie%'
        OR description LIKE '%Stadtteilziele%'
        OR description LIKE '%Förderprogramm%'
        OR description LIKE '%Stadtbibliothek%'
        OR description LIKE '%Einbürgerung%'
        OR description LIKE '%Altlasten%'
        OR description LIKE '%Zertifizierung%'
      );

    DELETE FROM applications
    WHERE source = 'Gemeinde-Webseite'
      AND workflow_status = 'new'
      AND IFNULL(assignee, '') = ''
      AND IFNULL(note, '') = ''
      AND id NOT IN (SELECT application_id FROM application_comments)
      AND (
        source_url LIKE '%/category/%'
        OR source_url LIKE '%/author/%'
        OR source_url LIKE '%/newsarchive/%'
        OR source_url LIKE '%/route/rss-%'
        OR address LIKE 'Archiv RSS%'
        OR address LIKE 'Baubewilligungen Baubewilligung BG 2025%'
        OR address LIKE 'Erteilte Baubewilligungen%'
        OR project_type IN ('RSS', 'Archiv', 'Baubewilligungen', 'Nicht importieren')
        OR project_type LIKE 'Erteilte Baubewilligungen%'
      );

    DELETE FROM applications
    WHERE source = 'Gemeinde-Webseite'
      AND workflow_status = 'new'
      AND IFNULL(assignee, '') = ''
      AND IFNULL(note, '') = ''
      AND id NOT IN (SELECT application_id FROM application_comments)
      AND (
        source_url LIKE '%/suche%'
        OR source_url LIKE '%/search%'
        OR source_url LIKE '%/_rtr/%'
        OR source_url LIKE '%Vorpruefungsbericht%'
        OR source_url LIKE '%Vorprüfungsbericht%'
        OR source_url LIKE '%Nutzungsplanung%'
        OR source_url LIKE '%Familiengartenzone%'
        OR source_url LIKE '%Baugesuchumschlag%'
        OR source_url LIKE '%Formular_Baugesuch%'
        OR source_url LIKE '%formular%baugesuch%'
        OR source_url LIKE '%OnlineSchalter%Bauverwaltung%'
        OR source_url LIKE '%regionalebauverwaltung.ch%'
        OR source_url LIKE '%/bauen/baubewilligungen/ebau-aargau%'
        OR source_url LIKE '%bno_%'
        OR source_url LIKE '%bno-%'
        OR source_url LIKE '%Mitteilungsblatt%'
        OR source_url LIKE '%mitteilungsblatt%'
        OR source_url LIKE '%Infoblatt%'
        OR source_url LIKE '%infoblatt%'
        OR source_url LIKE '%Katasterplan%'
        OR source_url LIKE '%Katasterplankopie%'
        OR source_url LIKE '%Situationsplan%'
        OR address LIKE 'Im Januar 20%'
        OR address LIKE 'Im Februar 20%'
        OR address LIKE 'Im März 20%'
        OR address LIKE 'Im April 20%'
        OR address LIKE 'Im Mai 20%'
        OR address LIKE 'Im Juni 20%'
        OR address LIKE 'Im Juli 20%'
        OR address LIKE 'Im August 20%'
        OR address LIKE 'Im September 20%'
        OR address LIKE 'Im Oktober 20%'
        OR address LIKE 'Im November 20%'
        OR address LIKE 'Im Dezember 20%'
        OR address LIKE 'Ab Anfang Januar 20%'
        OR address LIKE 'Ab Anfang Februar 20%'
        OR address LIKE 'Ab Anfang März 20%'
        OR address LIKE 'Ab Anfang April 20%'
        OR address LIKE 'Ab Anfang Mai 20%'
        OR address LIKE 'Ab Anfang Juni 20%'
        OR address LIKE 'Ab Anfang Juli 20%'
        OR address LIKE 'Ab Anfang August 20%'
        OR address LIKE 'Ab Anfang September 20%'
        OR address LIKE 'Ab Anfang Oktober 20%'
        OR address LIKE 'Ab Anfang November 20%'
        OR address LIKE 'Ab Anfang Dezember 20%'
        OR address LIKE 'Ab Mitte Januar 20%'
        OR address LIKE 'Ab Mitte Februar 20%'
        OR address LIKE 'Ab Mitte März 20%'
        OR address LIKE 'Ab Mitte April 20%'
        OR address LIKE 'Ab Mitte Mai 20%'
        OR address LIKE 'Ab Mitte Juni 20%'
        OR address LIKE 'Ab Mitte Juli 20%'
        OR address LIKE 'Ab Mitte August 20%'
        OR address LIKE 'Ab Mitte September 20%'
        OR address LIKE 'Ab Mitte Oktober 20%'
        OR address LIKE 'Ab Mitte November 20%'
        OR address LIKE 'Ab Mitte Dezember 20%'
        OR address LIKE 'Ab Ende Januar 20%'
        OR address LIKE 'Ab Ende Februar 20%'
        OR address LIKE 'Ab Ende März 20%'
        OR address LIKE 'Ab Ende April 20%'
        OR address LIKE 'Ab Ende Mai 20%'
        OR address LIKE 'Ab Ende Juni 20%'
        OR address LIKE 'Ab Ende Juli 20%'
        OR address LIKE 'Ab Ende August 20%'
        OR address LIKE 'Ab Ende September 20%'
        OR address LIKE 'Ab Ende Oktober 20%'
        OR address LIKE 'Ab Ende November 20%'
        OR address LIKE 'Ab Ende Dezember 20%'
        OR address LIKE 'vom %.% bis %.%'
        OR address LIKE 'vom %. Januar 20% bis %. Januar 20%'
        OR address LIKE 'vom %. Februar 20% bis %. Februar 20%'
        OR address LIKE 'vom %. März 20% bis %. März 20%'
        OR address LIKE 'vom %. April 20% bis %. April 20%'
        OR address LIKE 'vom %. Mai 20% bis %. Mai 20%'
        OR address LIKE 'vom %. Juni 20% bis %. Juni 20%'
        OR address LIKE 'vom %. Juli 20% bis %. Juli 20%'
        OR address LIKE 'vom %. August 20% bis %. August 20%'
        OR address LIKE 'vom %. September 20% bis %. September 20%'
        OR address LIKE 'vom %. Oktober 20% bis %. Oktober 20%'
        OR address LIKE 'vom %. November 20% bis %. November 20%'
        OR address LIKE 'vom %. Dezember 20% bis %. Dezember 20%'
        OR address LIKE 'Pdf%Bg%'
        OR address LIKE '%Mitteilungsblatt%'
        OR project_type = '2'
        OR project_type LIKE '%Suchergebnisse%'
        OR project_type LIKE '%Mitteilungsblatt%'
        OR project_type LIKE '%Infoblatt%'
        OR project_type LIKE '%Plangenehmigungsverfahren%'
        OR project_type LIKE '%Elektrizitätsgesetz%'
        OR project_type LIKE '%Elektrizitaetsgesetz%'
        OR project_type LIKE '%EleG%'
        OR project_type LIKE '%Familiengartenzone%'
        OR project_type LIKE '%Vorprüfungsbericht%'
        OR project_type LIKE '%Nutzungsplanung%'
        OR project_type LIKE '%Bau- und Nutzungsordnung%'
        OR project_type LIKE '%BNO%'
        OR project_type LIKE '%Mitwirkung%'
        OR project_type LIKE '%Genehmigung%'
        OR project_type LIKE '%Gemeinde Oberentfelden%'
      );

    DELETE FROM municipality_source_links
    WHERE municipality_id = 'MUN-KULM';

    DELETE FROM municipality_quality_assessments
    WHERE municipality_id = 'MUN-KULM';

    DELETE FROM municipalities
    WHERE id = 'MUN-KULM'
      AND name = 'Kulm';

    DELETE FROM municipality_sources
    WHERE id = 'SRC-KULM'
      AND municipality = 'Kulm'
      AND source_type = 'manual'
      AND IFNULL(source_url, '') = '';
    `);
  });

  /** @type {{ count?: number } | undefined} */
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM applications").get();
  const count = Number(countRow?.count ?? 0);

  if (count === 0 && seedDemoApplications) {
    db.exec("BEGIN");

    try {
      insertSeedRecords(db, shiftSeedDatesToRecent(seedApplications), "2026-03-20T07:00:00.000Z");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  applyMigrationOnce(
    db,
    { id: "backfill-application-source-evidence-v1", dbPath, destructive: true },
    backfillApplicationSourceEvidence
  );

  db.exec("BEGIN");

  try {
    insertSeedUsers(db, seedUsers, "2026-03-20T07:00:00.000Z", {
      masterAccountPassword,
      defaultLoginPassword
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  db.exec("BEGIN");

  try {
    insertSeedMunicipalitySources(db, aargauMunicipalitySources, "2026-03-21T08:00:00.000Z");
    backfillSeedMunicipalitySources(db, aargauMunicipalitySources, "2026-03-21T08:00:00.000Z");
    upsertSeedMunicipalities(db, aargauMunicipalities);
    upsertSeedPublicationSources(db, aargauPublicationSources, "2026-03-23T00:00:00.000Z");
    db.prepare("DELETE FROM municipality_source_links").run();
    upsertSeedMunicipalitySourceLinks(db, aargauMunicipalitySourceLinks);
    upsertSeedMunicipalityQualityAssessments(db, aargauMunicipalityQualityAssessments);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  syncConfiguredMasterPassword(db, masterAccountPassword);

  return db;
}

export function getDefaultDbPath() {
  return defaultDbPath;
}


// applyMigrationOnce bleibt aus db.js erreichbar (Tests).
export { applyMigrationOnce };
