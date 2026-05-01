import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  aargauMunicipalities,
  aargauMunicipalityQualityAssessments,
  aargauMunicipalitySourceLinks,
  aargauMunicipalitySources,
  aargauPublicationSources,
  isAutoManagedMunicipalitySourceNote
} from "./seed/municipalitySources.js";
import { randomBytes } from "node:crypto";
import { seedApplications } from "./seed/applications.js";
import { seedUsers } from "./seed/users.js";
import { createUserPasswordRecord } from "./repository/usersRepository.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDbPath = process.env.DATABASE_PATH || join(rootDir, "data", "heimatschutz.sqlite");
const defaultSeedDemoApplications =
  String(process.env.SEED_DEMO_APPLICATIONS ?? "")
    .trim()
    .toLowerCase() === "true";
const seededPasswordMap = (() => {
  if (!process.env.SEED_USER_PASSWORDS_JSON) {
    return {};
  }

  try {
    const parsed = JSON.parse(process.env.SEED_USER_PASSWORDS_JSON);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS applications (
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

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_comments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS registration_keys (
    id TEXT PRIMARY KEY,
    key_code TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_by_user_id TEXT NOT NULL,
    used_by_user_id TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    revoked_at TEXT DEFAULT NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS master_setup_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    sent_to TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    source_label TEXT NOT NULL DEFAULT '',
    last_run_at TEXT DEFAULT NULL,
    last_success_at TEXT DEFAULT NULL,
    next_run_at TEXT DEFAULT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    last_imported_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_notifications (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    source_label TEXT NOT NULL DEFAULT '',
    protection_status TEXT NOT NULL,
    municipality TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS municipality_sources (
    id TEXT PRIMARY KEY,
    municipality TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_url TEXT NOT NULL DEFAULT '',
    source_token TEXT NOT NULL DEFAULT '',
    include_pattern TEXT NOT NULL DEFAULT '',
    exclude_pattern TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    digital_status TEXT NOT NULL DEFAULT 'unknown',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS municipalities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    official_website TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS publication_sources (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    operator_name TEXT NOT NULL DEFAULT '',
    website_url TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '',
    is_shared INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS municipality_source_links (
    id TEXT PRIMARY KEY,
    municipality_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'primary',
    direct_url TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'manual',
    enabled INTEGER NOT NULL DEFAULT 0,
    digital_status TEXT NOT NULL DEFAULT 'unknown',
    include_pattern TEXT NOT NULL DEFAULT '',
    exclude_pattern TEXT NOT NULL DEFAULT '',
    source_token TEXT NOT NULL DEFAULT '',
    shared_hint TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (municipality_id, source_id, relation_type),
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
    FOREIGN KEY (source_id) REFERENCES publication_sources(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS municipality_quality_assessments (
    municipality_id TEXT PRIMARY KEY,
    primary_source_id TEXT NOT NULL,
    rating TEXT NOT NULL,
    rationale TEXT NOT NULL,
    shared_source_note TEXT NOT NULL DEFAULT '',
    uncertain INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
    FOREIGN KEY (primary_source_id) REFERENCES publication_sources(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_application_comments_application_id ON application_comments(application_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_applications_municipality ON applications(municipality);
  CREATE INDEX IF NOT EXISTS idx_applications_protection_status ON applications(protection_status);
  CREATE INDEX IF NOT EXISTS idx_applications_workflow_deadline ON applications(workflow_status, deadline_date);
  CREATE INDEX IF NOT EXISTS idx_applications_source_municipality ON applications(source, municipality);
  CREATE INDEX IF NOT EXISTS idx_applications_last_sync_at ON applications(last_sync_at DESC);
  CREATE INDEX IF NOT EXISTS idx_registration_keys_created_at ON registration_keys(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_registration_keys_key_code ON registration_keys(key_code);
  CREATE INDEX IF NOT EXISTS idx_sync_jobs_next_run_at ON sync_jobs(next_run_at);
  CREATE INDEX IF NOT EXISTS idx_app_settings_updated_at ON app_settings(updated_at);
  CREATE INDEX IF NOT EXISTS idx_import_notifications_created_at ON import_notifications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_municipality_sources_enabled ON municipality_sources(enabled, municipality);
  CREATE INDEX IF NOT EXISTS idx_publication_sources_shared ON publication_sources(is_shared, name);
  CREATE INDEX IF NOT EXISTS idx_municipality_source_links_municipality ON municipality_source_links(municipality_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_municipality_source_links_source ON municipality_source_links(source_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_municipality_quality_assessments_rating ON municipality_quality_assessments(rating);
`;

function insertSeedRecords(db, items, syncedAt) {
  const statement = db.prepare(`
    INSERT INTO applications (
      id,
      source,
      source_reference,
      source_url,
      municipality,
      address,
      parcel,
      coordinates,
      publication_date,
      deadline_date,
      project_type,
      description,
      protection_status,
      agis_match,
      agis_layers,
      workflow_status,
      assignee,
      note,
      automated_assessment,
      ambiguous_address,
      last_sync_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    statement.run(
      item.id,
      item.source,
      item.sourceReference,
      item.sourceUrl,
      item.municipality,
      item.address,
      item.parcel ?? "",
      item.coordinates ?? "",
      item.publicationDate,
      item.deadlineDate,
      item.projectType,
      item.description,
      item.protectionStatus,
      item.agisMatch,
      JSON.stringify(item.agisLayers ?? []),
      item.workflowStatus,
      item.assignee ?? "",
      item.note ?? "",
      item.automatedAssessment ?? "",
      item.ambiguousAddress ?? 0,
      syncedAt,
      syncedAt,
      syncedAt
    );
  }
}

// Sperrt ein Konto mit einem unbrauchbaren Zufallspasswort. Wird verwendet, wenn
// fuer ein Konto kein Passwort konfiguriert ist (z. B. das Master-Konto vor der
// Ersteinrichtung per Setup-Key).
function lockedPasswordRecord() {
  return createUserPasswordRecord(randomBytes(32).toString("hex"));
}

function insertSeedUsers(db, items, createdAt, { masterAccountPassword = "", defaultLoginPassword = "" } = {}) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO users (
      id,
      username,
      display_name,
      role,
      password_salt,
      password_hash,
      active,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    const configuredPassword =
      seededPasswordMap[item.username] ??
      (item.role === "Master" ? masterAccountPassword : defaultLoginPassword) ??
      "";
    // Ohne konfiguriertes Passwort wird das Konto gesperrt (kein Klartext-Default
    // im Repository). Das Master-Konto wird dann per Setup-Key freigeschaltet.
    const passwordRecord = configuredPassword
      ? createUserPasswordRecord(configuredPassword)
      : lockedPasswordRecord();

    statement.run(
      item.id,
      item.username,
      item.displayName,
      item.role,
      passwordRecord.salt,
      passwordRecord.hash,
      1,
      createdAt,
      createdAt
    );
  }
}

function insertSeedMunicipalitySources(db, items, updatedAt) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO municipality_sources (
      id,
      municipality,
      source_type,
      source_url,
      source_token,
      include_pattern,
      exclude_pattern,
      enabled,
      digital_status,
      notes,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    statement.run(
      item.id,
      item.municipality,
      item.sourceType,
      item.sourceUrl ?? "",
      item.sourceToken ?? "",
      item.includePattern ?? "",
      item.excludePattern ?? "",
      item.enabled ?? 0,
      item.digitalStatus ?? "unknown",
      item.notes ?? "",
      updatedAt
    );
  }
}

function upsertSeedMunicipalities(db, items) {
  const statement = db.prepare(`
    INSERT INTO municipalities (
      id,
      name,
      official_website,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      official_website = excluded.official_website,
      updated_at = excluded.updated_at
  `);

  for (const item of items) {
    statement.run(item.id, item.name, item.officialWebsite ?? "", item.createdAt, item.updatedAt);
  }
}

function upsertSeedPublicationSources(db, items, timestamp) {
  const statement = db.prepare(`
    INSERT INTO publication_sources (
      id,
      source_key,
      name,
      source_kind,
      operator_name,
      website_url,
      canonical_url,
      is_shared,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_key = excluded.source_key,
      name = excluded.name,
      source_kind = excluded.source_kind,
      operator_name = excluded.operator_name,
      website_url = excluded.website_url,
      canonical_url = excluded.canonical_url,
      is_shared = excluded.is_shared,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `);

  for (const item of items) {
    statement.run(
      item.id,
      item.sourceKey,
      item.name,
      item.sourceKind,
      item.operatorName ?? "",
      item.websiteUrl ?? "",
      item.canonicalUrl ?? "",
      item.isShared ? 1 : 0,
      item.notes ?? "",
      timestamp,
      timestamp
    );
  }
}

function upsertSeedMunicipalitySourceLinks(db, items) {
  const statement = db.prepare(`
    INSERT INTO municipality_source_links (
      id,
      municipality_id,
      source_id,
      relation_type,
      direct_url,
      source_type,
      enabled,
      digital_status,
      include_pattern,
      exclude_pattern,
      source_token,
      shared_hint,
      notes,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      municipality_id = excluded.municipality_id,
      source_id = excluded.source_id,
      relation_type = excluded.relation_type,
      direct_url = excluded.direct_url,
      source_type = excluded.source_type,
      enabled = excluded.enabled,
      digital_status = excluded.digital_status,
      include_pattern = excluded.include_pattern,
      exclude_pattern = excluded.exclude_pattern,
      shared_hint = excluded.shared_hint,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `);

  for (const item of items) {
    statement.run(
      item.id,
      item.municipalityId,
      item.sourceId,
      item.relationType,
      item.directUrl ?? "",
      item.sourceType ?? "manual",
      item.enabled ? 1 : 0,
      item.digitalStatus ?? "unknown",
      item.includePattern ?? "",
      item.excludePattern ?? "",
      "",
      item.sharedHint ?? "",
      item.notes ?? "",
      item.updatedAt
    );
  }
}

function upsertSeedMunicipalityQualityAssessments(db, items) {
  const statement = db.prepare(`
    INSERT INTO municipality_quality_assessments (
      municipality_id,
      primary_source_id,
      rating,
      rationale,
      shared_source_note,
      uncertain,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(municipality_id) DO UPDATE SET
      primary_source_id = excluded.primary_source_id,
      rating = excluded.rating,
      rationale = excluded.rationale,
      shared_source_note = excluded.shared_source_note,
      uncertain = excluded.uncertain,
      updated_at = excluded.updated_at
  `);

  for (const item of items) {
    statement.run(
      item.municipalityId,
      item.primarySourceId,
      item.rating,
      item.rationale,
      item.sharedSourceNote ?? "",
      item.uncertain ? 1 : 0,
      item.updatedAt
    );
  }
}

function backfillSeedMunicipalitySources(db, items, updatedAt) {
  const rows = db
    .prepare(`
      SELECT
        id,
        source_type,
        source_url,
        source_token,
        include_pattern,
        exclude_pattern,
        enabled,
        digital_status,
        notes
      FROM municipality_sources
    `)
    .all();
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const updateStatement = db.prepare(`
    UPDATE municipality_sources
    SET source_type = ?,
        source_url = ?,
        source_token = ?,
        include_pattern = ?,
        exclude_pattern = ?,
        enabled = ?,
        digital_status = ?,
        notes = ?,
        updated_at = ?
    WHERE id = ?
  `);

  for (const item of items) {
    const current = rowsById.get(item.id);

    if (!current) {
      continue;
    }

    const isLegacyBlankSeed =
      String(current.source_type ?? "manual") === "manual" &&
      String(current.source_url ?? "").trim() === "" &&
      String(current.source_token ?? "").trim() === "" &&
      String(current.include_pattern ?? "").trim() === "" &&
      String(current.exclude_pattern ?? "").trim() === "" &&
      Number(current.enabled ?? 0) === 0 &&
      ["", "unknown"].includes(String(current.digital_status ?? "").trim()) &&
      ["", "Noch keine Gemeindequelle hinterlegt."].includes(String(current.notes ?? "").trim());

    const isAutoManagedSeed =
      String(current.source_token ?? "").trim() === "" &&
      isAutoManagedMunicipalitySourceNote(current.notes);

    if (!isLegacyBlankSeed && !isAutoManagedSeed) {
      continue;
    }

    const hasChanged =
      String(current.source_type ?? "manual") !== String(item.sourceType ?? "manual") ||
      String(current.source_url ?? "") !== String(item.sourceUrl ?? "") ||
      String(current.source_token ?? "") !== String(item.sourceToken ?? "") ||
      String(current.include_pattern ?? "") !== String(item.includePattern ?? "") ||
      String(current.exclude_pattern ?? "") !== String(item.excludePattern ?? "") ||
      Number(current.enabled ?? 0) !== Number(item.enabled ?? 0) ||
      String(current.digital_status ?? "unknown") !== String(item.digitalStatus ?? "unknown") ||
      String(current.notes ?? "") !== String(item.notes ?? "");

    if (!hasChanged) {
      continue;
    }

    updateStatement.run(
      item.sourceType,
      item.sourceUrl ?? "",
      item.sourceToken ?? "",
      item.includePattern ?? "",
      item.excludePattern ?? "",
      item.enabled ?? 0,
      item.digitalStatus ?? "unknown",
      item.notes ?? "",
      updatedAt,
      item.id
    );
  }
}

function syncConfiguredMasterPassword(db, masterAccountPassword) {
  const configuredPassword = String(masterAccountPassword ?? process.env.MASTER_ACCOUNT_PASSWORD ?? "").trim();

  if (!configuredPassword) {
    return;
  }

  const masterUser = db
    .prepare(`
      SELECT id
      FROM users
      WHERE username = 'master' AND role = 'Master' AND active = 1
      LIMIT 1
    `)
    .get();

  if (!masterUser) {
    return;
  }

  const passwordRecord = createUserPasswordRecord(configuredPassword);
  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE users
    SET password_salt = ?,
        password_hash = ?,
        updated_at = ?
    WHERE id = ?
  `).run(passwordRecord.salt, passwordRecord.hash, updatedAt, masterUser.id);
}

export function createDatabase(dbPath = defaultDbPath, options = {}) {
  const seedDemoApplications = options.seedDemoApplications ?? defaultSeedDemoApplications;
  const masterAccountPassword = String(options.masterAccountPassword ?? process.env.MASTER_ACCOUNT_PASSWORD ?? "").trim();
  const defaultLoginPassword = String(options.defaultLoginPassword ?? process.env.DEFAULT_LOGIN_PASSWORD ?? "").trim();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.exec(`
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
      AND IFNULL(coordinates, '') = '';

    DELETE FROM applications
    WHERE source = 'Gemeinde-Webseite'
      AND ambiguous_address = 1
      AND IFNULL(parcel, '') = ''
      AND IFNULL(coordinates, '') = ''
      AND (
        address LIKE 'Januar 20%'
        OR address LIKE 'Februar 20%'
        OR address LIKE 'März 20%'
        OR address LIKE 'Maerz 20%'
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

  const count = db.prepare("SELECT COUNT(*) AS count FROM applications").get().count;

  if (count === 0 && seedDemoApplications) {
    db.exec("BEGIN");

    try {
      insertSeedRecords(db, seedApplications, "2026-03-20T07:00:00.000Z");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

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
