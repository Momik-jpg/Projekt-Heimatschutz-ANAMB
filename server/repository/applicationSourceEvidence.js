import { randomBytes } from "node:crypto";
import {
  SOURCE_KIND_AMTSBLATT,
  buildCanonicalFields,
  deriveReconciliationStatus,
  sourceKindOf
} from "../domain/sourceReconciliation.js";

// Quellnachweis-Verwaltung und kanonischer Abgleich eines Falls. Ausgelagert aus
// applicationsRepository, damit beide Dateien klein bleiben. Arbeitet direkt auf
// der DB; die fachliche Logik (Matching/Merge/Status) liegt rein in
// domain/sourceReconciliation.js.
export function createSourceEvidenceReconciler(db) {
  const upsertEvidenceStatement = db.prepare(`
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
  `);
  const listEvidenceByApplicationStatement = db.prepare(`
    SELECT source_kind AS sourceKind, source_name AS sourceName, source_reference AS sourceReference,
           source_url AS sourceUrl, municipality, publication_date AS publicationDate,
           deadline_date AS deadlineDate, address, parcel, project_type AS projectType,
           match_status AS matchStatus, observed_at AS observedAt
    FROM application_source_evidence
    WHERE application_id = ?
    ORDER BY CASE WHEN source_kind = 'amtsblatt' THEN 0 ELSE 1 END, observed_at ASC
  `);
  const updateReconciledCanonicalStatement = db.prepare(`
    UPDATE applications
    SET source = ?, source_url = ?, municipality = ?, address = ?, parcel = ?,
        publication_date = ?, deadline_date = ?, project_type = ?,
        reconciliation_status = ?, updated_at = ?
    WHERE id = ?
  `);
  const readApplicationSourceStatement = db.prepare(
    "SELECT source, source_url, municipality FROM applications WHERE id = ?"
  );

  function evidenceFromRecord(record) {
    return {
      sourceKind: sourceKindOf(record.source),
      sourceName: record.source,
      sourceReference: record.sourceReference,
      sourceUrl: record.sourceUrl,
      municipality: record.municipality,
      publicationDate: record.publicationDate,
      deadlineDate: record.deadlineDate,
      address: record.address,
      parcel: record.parcel,
      projectType: record.projectType
    };
  }

  function upsertEvidence(applicationId, evidence, observedAt, matchStatus = evidence.matchStatus ?? "matched") {
    upsertEvidenceStatement.run(
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

  // Jeder Fall braucht einen Nachweis seiner EIGENEN Quelle, bevor ein
  // Fremdnachweis angehängt wird - sonst könnten die kanonischen Werte des
  // bestehenden Falls durch den neuen Nachweis verdrängt werden.
  function ensureSelfEvidence(applicationRecord, observedAt) {
    const existing = listEvidenceByApplicationStatement.all(applicationRecord.id);
    const selfKind = sourceKindOf(applicationRecord.source);
    const hasSelf = existing.some(
      (entry) => entry.sourceKind === selfKind && entry.sourceReference === applicationRecord.sourceReference
    );
    if (!hasSelf) {
      upsertEvidence(applicationRecord.id, evidenceFromRecord(applicationRecord), observedAt);
    }
  }

  // Berechnet kanonische Identitätsfelder + Abgleichstatus aus allen Nachweisen
  // eines Falls und schreibt sie zurück (Amtsblatt vor Gemeinde).
  function reconcileApplication(applicationId, observedAt) {
    const evidences = listEvidenceByApplicationStatement.all(applicationId);
    if (evidences.length === 0) return;

    const canonical = buildCanonicalFields(evidences);
    const status = deriveReconciliationStatus(evidences);
    const amtsblatt = evidences.find((entry) => entry.sourceKind === SOURCE_KIND_AMTSBLATT);
    const fallback = readApplicationSourceStatement.get(applicationId) ?? {};
    const source = amtsblatt ? amtsblatt.sourceName || "Amtsblatt Aargau" : fallback.source ?? "";
    const sourceUrl = amtsblatt ? amtsblatt.sourceUrl || fallback.source_url || "" : fallback.source_url ?? "";

    updateReconciledCanonicalStatement.run(
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

  function listSourceEvidence(applicationId) {
    return listEvidenceByApplicationStatement.all(applicationId);
  }

  return {
    evidenceFromRecord,
    upsertEvidence,
    ensureSelfEvidence,
    reconcileApplication,
    listSourceEvidence
  };
}
