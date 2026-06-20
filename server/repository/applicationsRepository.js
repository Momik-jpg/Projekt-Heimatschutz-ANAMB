import { randomBytes } from "node:crypto";
import {
  classifyProjectScale,
  getApplicationRegion
} from "../domain/applicationPresentation.js";
import {
  cleanImportedAddress,
  normalizeImportedDates
} from "../domain/applicationImportNormalization.js";
import { importQueue } from "../seed/applications.js";

export const protectionStatuses = [
  "no-hit",
  "protected-point",
  "protected-zone",
  "combined-hit",
  "manual-review"
];

export const workflowStatuses = [
  "new",
  "under-review",
  "cleared",
  "archived"
];

function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    source: row.source,
    sourceReference: row.source_reference,
    sourceUrl: row.source_url,
    municipality: row.municipality,
    region: getApplicationRegion(row.municipality),
    address: cleanImportedAddress(row.address),
    parcel: row.parcel,
    coordinates: row.coordinates,
    locationPrecision: row.location_precision ?? "",
    publicationDate: row.publication_date,
    deadlineDate: row.deadline_date,
    projectType: row.project_type,
    description: row.description,
    projectScale: classifyProjectScale({
      projectType: row.project_type,
      description: row.description
    }),
    protectionStatus: row.protection_status,
    agisMatch: row.agis_match,
    agisLayers: JSON.parse(row.agis_layers || "[]"),
    workflowStatus: row.workflow_status,
    assignee: row.assignee,
    note: row.note,
    automatedAssessment: row.automated_assessment,
    ambiguousAddress: Boolean(row.ambiguous_address),
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function buildListQuery(filters) {
  const conditions = [];
  const params = [];

  if (filters.search) {
    conditions.push("(municipality LIKE ? OR address LIKE ? OR project_type LIKE ? OR description LIKE ?)");
    const pattern = `%${filters.search.trim()}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (filters.municipality) {
    conditions.push("municipality = ?");
    params.push(filters.municipality);
  }

  if (filters.protectionStatus) {
    conditions.push("protection_status = ?");
    params.push(filters.protectionStatus);
  }

  if (filters.workflowStatus) {
    conditions.push("workflow_status = ?");
    params.push(filters.workflowStatus);
  }

  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
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
    FROM applications
    ${whereClause}
    ORDER BY
      CASE
        WHEN protection_status = 'manual-review' THEN 0
        WHEN protection_status = 'combined-hit' THEN 1
        WHEN protection_status = 'protected-point' THEN 2
        WHEN protection_status = 'protected-zone' THEN 3
        ELSE 4
      END,
      CASE
        WHEN workflow_status IN ('cleared', 'archived') THEN 1
        ELSE 0
      END,
      date(deadline_date) ASC,
      date(publication_date) DESC,
      municipality ASC
  `;

  return { sql, params };
}

function buildImportedRecord(item, syncedAt) {
  const dates = normalizeImportedDates({
    publicationDate: item.publicationDate,
    deadlineDate: item.deadlineDate,
    text: [item.description, item.projectType, item.address].filter(Boolean).join(" "),
    referenceDate: syncedAt
  });
  return {
    id: item.id || `BG-${randomBytes(6).toString("hex").toUpperCase()}`,
    source: item.source,
    sourceReference: item.sourceReference,
    sourceUrl: item.sourceUrl,
    municipality: item.municipality,
    address: cleanImportedAddress(item.address),
    parcel: item.parcel ?? "",
    coordinates: item.coordinates ?? "",
    locationPrecision: item.locationPrecision ?? "",
    publicationDate: dates.publicationDate,
    deadlineDate: dates.deadlineDate,
    projectType: item.projectType,
    description: item.description,
    protectionStatus: item.protectionStatus,
    agisMatch: item.agisMatch,
    agisLayers: item.agisLayers ?? [],
    workflowStatus: item.workflowStatus ?? "new",
    assignee: item.assignee ?? "",
    note: item.note ?? "",
    automatedAssessment: item.automatedAssessment ?? "",
    ambiguousAddress: item.ambiguousAddress ?? 0,
    lastSyncAt: syncedAt,
    createdAt: syncedAt,
    updatedAt: syncedAt
  };
}

function toDateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().slice(0, 10);
}

export function createApplicationsRepository(db) {
  const findBySourceReferenceStatement = db.prepare(`
    SELECT id
    FROM applications
    WHERE source_reference = ?
  `);
  const insertStatement = db.prepare(`
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
  const updateImportedStatement = db.prepare(`
    UPDATE applications
    SET source = ?,
        source_url = ?,
        municipality = ?,
        address = ?,
        parcel = ?,
        coordinates = ?,
        location_precision = ?,
        publication_date = ?,
        deadline_date = ?,
        project_type = ?,
        description = ?,
        protection_status = ?,
        agis_match = ?,
        agis_layers = ?,
        automated_assessment = ?,
        ambiguous_address = ?,
        last_sync_at = ?,
        updated_at = ?
    WHERE id = ?
  `);
  const deleteUntouchedMunicipalityImportsStatement = db.prepare(`
    DELETE FROM applications
    WHERE source = ?
      AND municipality = ?
      AND workflow_status = 'new'
      AND IFNULL(assignee, '') = ''
      AND IFNULL(note, '') = ''
      AND id NOT IN (SELECT application_id FROM application_comments)
  `);

  return {
    list(filters = {}) {
      const { sql, params } = buildListQuery(filters);
      return db.prepare(sql).all(...params).map(mapRow);
    },

    getById(id) {
      const row = db
        .prepare(`
          SELECT
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
          FROM applications
          WHERE id = ?
        `)
        .get(id);

      return mapRow(row);
    },

    update(id, changes) {
      const current = this.getById(id);

      if (!current) {
        return null;
      }

      const next = {
        workflowStatus: changes.workflowStatus ?? current.workflowStatus,
        assignee: changes.assignee ?? current.assignee,
        note: changes.note ?? current.note
      };

      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE applications
        SET workflow_status = ?,
            assignee = ?,
            note = ?,
            updated_at = ?
        WHERE id = ?
      `).run(next.workflowStatus, next.assignee.trim(), next.note.trim(), updatedAt, id);

      return this.getById(id);
    },

    updateAssessment(id, changes) {
      const current = this.getById(id);

      if (!current) {
        return null;
      }

      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE applications
        SET protection_status = ?,
            agis_match = ?,
            agis_layers = ?,
            automated_assessment = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        changes.protectionStatus ?? current.protectionStatus,
        changes.agisMatch ?? current.agisMatch,
        JSON.stringify(changes.agisLayers ?? current.agisLayers ?? []),
        changes.automatedAssessment ?? current.automatedAssessment,
        updatedAt,
        id
      );

      return this.getById(id);
    },

    importItems(items, syncedAt = new Date().toISOString()) {
      const importedItems = [];
      const changes = [];
      let importedCount = 0;
      let updatedCount = 0;

      db.exec("BEGIN");

      try {
        for (const item of items) {
          const next = buildImportedRecord(item, syncedAt);
          const existing = findBySourceReferenceStatement.get(next.sourceReference);

          if (existing) {
            updateImportedStatement.run(
              next.source,
              next.sourceUrl,
              next.municipality,
              next.address,
              next.parcel,
              next.coordinates,
              next.locationPrecision,
              next.publicationDate,
              next.deadlineDate,
              next.projectType,
              next.description,
              next.protectionStatus,
              next.agisMatch,
              JSON.stringify(next.agisLayers),
              next.automatedAssessment,
              next.ambiguousAddress,
              next.lastSyncAt,
              next.updatedAt,
              existing.id
            );
            const updatedItem = this.getById(existing.id);
            importedItems.push(updatedItem);
            changes.push({
              changeType: "updated",
              item: updatedItem
            });
            updatedCount += 1;
            continue;
          }

          insertStatement.run(
            next.id,
            next.source,
            next.sourceReference,
            next.sourceUrl,
            next.municipality,
            next.address,
            next.parcel,
            next.coordinates,
            next.locationPrecision,
            next.publicationDate,
            next.deadlineDate,
            next.projectType,
            next.description,
            next.protectionStatus,
            next.agisMatch,
            JSON.stringify(next.agisLayers),
            next.workflowStatus,
            next.assignee,
            next.note,
            next.automatedAssessment,
            next.ambiguousAddress,
            next.lastSyncAt,
            next.createdAt,
            next.updatedAt
          );
          const importedItem = this.getById(next.id);
          importedItems.push(importedItem);
          changes.push({
            changeType: "imported",
            item: importedItem
          });
          importedCount += 1;
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return {
        importedCount,
        updatedCount,
        items: importedItems,
        changes
      };
    },

    pruneUntouchedMunicipalityImports({ source, municipality, keepSourceReferences = [] }) {
      const normalizedSource = String(source ?? "").trim();
      const normalizedMunicipality = String(municipality ?? "").trim();
      const keptReferences = [...new Set(keepSourceReferences.map((value) => String(value ?? "").trim()).filter(Boolean))];

      if (!normalizedSource || !normalizedMunicipality) {
        return 0;
      }

      db.exec("BEGIN");

      try {
        let removedCount = 0;

        if (!keptReferences.length) {
          const result = deleteUntouchedMunicipalityImportsStatement.run(normalizedSource, normalizedMunicipality);
          removedCount = result.changes ?? 0;
        } else {
          const placeholders = keptReferences.map(() => "?").join(", ");
          const result = db
            .prepare(`
              DELETE FROM applications
              WHERE source = ?
                AND municipality = ?
                AND workflow_status = 'new'
                AND IFNULL(assignee, '') = ''
                AND IFNULL(note, '') = ''
                AND id NOT IN (SELECT application_id FROM application_comments)
                AND source_reference NOT IN (${placeholders})
            `)
            .run(normalizedSource, normalizedMunicipality, ...keptReferences);
          removedCount = result.changes ?? 0;
        }

        db.exec("COMMIT");
        return removedCount;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    // Einen Tag nach der Frist verschwindet der komplette Fall. Fälle ohne
    // verlässliche Frist bleiben erhalten und müssen in der Oberfläche auffallen.
    pruneExpiredApplications({ referenceDate = new Date() } = {}) {
      const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);

      if (Number.isNaN(date.getTime())) {
        return 0;
      }

      const referenceDateOnly = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
      ].join("-");

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          DELETE FROM application_learning_rules
          WHERE created_from_application_id IN (
            SELECT id
            FROM applications
            WHERE IFNULL(deadline_date, '') <> ''
              AND date(deadline_date) < date(?)
          )
        `).run(referenceDateOnly);

        const result = db.prepare(`
          DELETE FROM applications
          WHERE IFNULL(deadline_date, '') <> ''
            AND date(deadline_date) < date(?)
        `).run(referenceDateOnly);

        db.exec("COMMIT");
        const removed = result.changes ?? 0;
        if (removed > 0) {
          // secure_delete überschreibt gelöschte Inhalte; der Checkpoint entfernt
          // zusätzlich alte Frames aus der WAL-Datei.
          db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        return removed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getDashboard({ referenceDate = new Date() } = {}) {
      const referenceDateText = toDateOnly(referenceDate);
      const totalApplications = db.prepare("SELECT COUNT(*) AS count FROM applications").get().count;
      const relevantApplications = db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM applications
          WHERE protection_status IN ('protected-point', 'protected-zone', 'combined-hit')
        `)
        .get().count;
      const manualReview = db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM applications
          WHERE protection_status = 'manual-review' OR ambiguous_address = 1
        `)
        .get().count;
      const dueSoon = db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM applications
          WHERE workflow_status NOT IN ('cleared', 'archived')
            AND IFNULL(deadline_date, '') <> ''
            AND julianday(deadline_date) >= julianday(?)
            AND julianday(deadline_date) - julianday(?) <= 7
        `)
        .get(referenceDateText, referenceDateText).count;
      const municipalities = db
        .prepare("SELECT name FROM municipalities ORDER BY name ASC")
        .all()
        .map((row) => row.name);
      const sources = db
        .prepare(`
          SELECT source, COUNT(*) AS count
          FROM applications
          GROUP BY source
          ORDER BY count DESC, source ASC
        `)
        .all()
        .map((row) => ({
          source: row.source,
          count: row.count
        }));
      const lastSyncAt = db
        .prepare("SELECT MAX(last_sync_at) AS last_sync_at FROM applications")
        .get().last_sync_at;
      const existingReferences = new Set(
        db.prepare("SELECT source_reference FROM applications").all().map((row) => row.source_reference)
      );
      const remainingQueue = importQueue.filter((item) => !existingReferences.has(item.sourceReference)).length;
      const urgentCases = db
        .prepare(`
          SELECT
            id,
            municipality,
            address,
            protection_status,
            workflow_status,
            deadline_date
          FROM applications
          WHERE workflow_status NOT IN ('cleared', 'archived')
          ORDER BY
            CASE
              WHEN protection_status = 'manual-review' THEN 0
              WHEN protection_status = 'combined-hit' THEN 1
              WHEN protection_status = 'protected-point' THEN 2
              WHEN protection_status = 'protected-zone' THEN 3
              ELSE 4
            END,
            CASE
              WHEN IFNULL(deadline_date, '') = '' THEN 1
              ELSE 0
            END,
            date(deadline_date) ASC
          LIMIT 5
        `)
        .all()
        .map((row) => ({
          id: row.id,
          municipality: row.municipality,
          address: row.address,
          protectionStatus: row.protection_status,
          workflowStatus: row.workflow_status,
          deadlineDate: row.deadline_date
        }));

      return {
        stats: {
          totalApplications,
          relevantApplications,
          manualReview,
          dueSoon
        },
        municipalities,
        sources,
        lastSyncAt,
        remainingQueue,
        urgentCases
      };
    },

    simulateSync() {
      const existingReferences = new Set(
        db.prepare("SELECT source_reference FROM applications").all().map((row) => row.source_reference)
      );
      const nextItem = importQueue.find((item) => !existingReferences.has(item.sourceReference));

      if (!nextItem) {
        return {
          imported: false,
          importedCount: 0,
          updatedCount: 0,
          item: null,
          items: [],
          changes: [],
          remainingQueue: 0
        };
      }

      const syncedAt = new Date().toISOString();
      const importResult = this.importItems([nextItem], syncedAt);

      const remainingQueue = importQueue.filter(
        (item) => item.sourceReference !== nextItem.sourceReference && !existingReferences.has(item.sourceReference)
      ).length;

      return {
        imported: true,
        importedCount: importResult.importedCount,
        updatedCount: importResult.updatedCount,
        item: importResult.items[0] ?? null,
        items: importResult.items,
        changes: importResult.changes,
        remainingQueue
      };
    }
  };
}
