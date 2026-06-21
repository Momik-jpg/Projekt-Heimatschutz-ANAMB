// Seed-Daten-Einspielung und Master-Passwort-Sync (aus db.js ausgelagert).
import {
  randomBytes
} from "node:crypto";
import {
  createUserPasswordRecord
} from "../repository/usersRepository.js";
import {
  isAutoManagedMunicipalitySourceNote
} from "../seed/municipalitySources.js";

export const seededPasswordMap = (() => {
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

/**
 * @typedef {object} MunicipalitySourceRow
 * @property {string} id
 * @property {string} source_type
 * @property {string} source_url
 * @property {string} source_token
 * @property {string} include_pattern
 * @property {string} exclude_pattern
 * @property {number} enabled
 * @property {string} digital_status
 * @property {string} notes
 */

/**
 * @typedef {object} CreateDatabaseOptions
 * @property {boolean} [seedDemoApplications]
 * @property {string} [masterAccountPassword]
 * @property {string} [defaultLoginPassword]
 */

export function insertSeedRecords(db, items, syncedAt) {
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
      location_precision,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      item.locationPrecision ?? "",
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
// für ein Konto kein Passwort konfiguriert ist (z. B. das Master-Konto vor der
// Ersteinrichtung per Setup-Key).
export function lockedPasswordRecord() {
  return createUserPasswordRecord(randomBytes(32).toString("hex"));
}

export function insertSeedUsers(db, items, createdAt, { masterAccountPassword = "", defaultLoginPassword = "" } = {}) {
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

export function insertSeedMunicipalitySources(db, items, updatedAt) {
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

export function upsertSeedMunicipalities(db, items) {
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

export function upsertSeedPublicationSources(db, items, timestamp) {
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

export function upsertSeedMunicipalitySourceLinks(db, items) {
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

export function upsertSeedMunicipalityQualityAssessments(db, items) {
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

export function backfillSeedMunicipalitySources(db, items, updatedAt) {
  const rows = /** @type {MunicipalitySourceRow[]} */ (db
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
    .all());
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
    const current = /** @type {Record<string, unknown> | undefined} */ (rowsById.get(item.id));

    if (!current) {
      continue;
    }

    const currentSourceType = String(current.source_type ?? "manual");
    const currentSourceUrl = String(current.source_url ?? "");
    const currentSourceToken = String(current.source_token ?? "");
    const currentIncludePattern = String(current.include_pattern ?? "");
    const currentExcludePattern = String(current.exclude_pattern ?? "");
    const currentEnabled = Number(current.enabled ?? 0);
    const currentDigitalStatus = String(current.digital_status ?? "unknown");
    const currentNotes = String(current.notes ?? "");
    const isLegacyBlankSeed =
      currentSourceType === "manual" &&
      currentSourceUrl.trim() === "" &&
      currentSourceToken.trim() === "" &&
      currentIncludePattern.trim() === "" &&
      currentExcludePattern.trim() === "" &&
      currentEnabled === 0 &&
      ["", "unknown"].includes(currentDigitalStatus.trim()) &&
      ["", "Noch keine Gemeindequelle hinterlegt."].includes(currentNotes.trim());

    const isAutoManagedSeed =
      currentSourceToken.trim() === "" &&
      isAutoManagedMunicipalitySourceNote(currentNotes);

    if (!isLegacyBlankSeed && !isAutoManagedSeed) {
      continue;
    }

    const hasChanged =
      currentSourceType !== String(item.sourceType ?? "manual") ||
      currentSourceUrl !== String(item.sourceUrl ?? "") ||
      currentSourceToken !== String(item.sourceToken ?? "") ||
      currentIncludePattern !== String(item.includePattern ?? "") ||
      currentExcludePattern !== String(item.excludePattern ?? "") ||
      currentEnabled !== Number(item.enabled ?? 0) ||
      currentDigitalStatus !== String(item.digitalStatus ?? "unknown") ||
      currentNotes !== String(item.notes ?? "");

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

export function syncConfiguredMasterPassword(db, masterAccountPassword) {
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

