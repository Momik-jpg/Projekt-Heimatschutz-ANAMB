import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";
import { createSourceEvidenceReconciler } from "../server/repository/applicationSourceEvidence.js";

function item(overrides = {}) {
  return {
    id: overrides.id ?? "APP-EVIDENCE",
    source: overrides.source ?? "Gemeinde-Webseite",
    sourceReference: overrides.sourceReference ?? overrides.id ?? "APP-EVIDENCE",
    sourceUrl: overrides.sourceUrl ?? "https://example.org/gemeinde",
    municipality: overrides.municipality ?? "Baden",
    address: overrides.address ?? "Mellingerstrasse 7",
    parcel: overrides.parcel ?? "1189",
    coordinates: overrides.coordinates ?? "",
    publicationDate: overrides.publicationDate ?? "2026-06-01",
    deadlineDate: overrides.deadlineDate ?? "",
    addressProvenance: "official-field",
    deadlineProvenance: overrides.deadlineDate ? "explicit" : "missing",
    projectType: overrides.projectType ?? "Fenstersanierung",
    description: overrides.description ?? "Fenstersanierung",
    protectionStatus: overrides.protectionStatus ?? "no-hit",
    agisMatch: "",
    agisLayers: [],
    ambiguousAddress: overrides.ambiguousAddress ?? 0
  };
}

function setup() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return { db, repo: createApplicationsRepository(db), reconciler: createSourceEvidenceReconciler(db) };
}

test("ensureSelfEvidence ist idempotent, wenn der Eigennachweis bereits existiert", () => {
  const { db, repo, reconciler } = setup();
  try {
    repo.importItems([item({ id: "SELF-EVIDENCE", sourceReference: "self-evidence" })], "2026-06-01T08:00:00.000Z");
    const before = repo.getById("SELF-EVIDENCE");

    reconciler.ensureSelfEvidence(before, "2026-06-02T08:00:00.000Z");

    const after = repo.getById("SELF-EVIDENCE");
    assert.equal(after.sourceEvidence.length, 1);
    assert.equal(after.sourceEvidence[0].observedAt, before.sourceEvidence[0].observedAt);
  } finally {
    db.close();
  }
});

test("reconcileApplication erhält Fall-Quelle und Gemeinde, wenn der Nachweis diese Werte nicht liefert", () => {
  const { db, repo, reconciler } = setup();
  try {
    repo.importItems([
      item({
        id: "FALLBACK-CANONICAL",
        sourceReference: "fallback-canonical",
        sourceUrl: "https://baden.example.org/baugesuche",
        municipality: "Baden",
        publicationDate: "2026-06-01"
      })
    ]);
    db.prepare("DELETE FROM application_source_evidence WHERE application_id = ?").run("FALLBACK-CANONICAL");

    reconciler.upsertEvidence(
      "FALLBACK-CANONICAL",
      {
        sourceKind: "municipality",
        sourceReference: "fallback-evidence",
        publicationDate: "2026-06-02",
        address: "Mellingerstrasse 7",
        projectType: "Fenstersanierung"
      },
      "2026-06-02T08:00:00.000Z"
    );
    reconciler.reconcileApplication("FALLBACK-CANONICAL", "2026-06-02T08:00:00.000Z");

    const updated = repo.getById("FALLBACK-CANONICAL");
    assert.equal(updated.source, "Gemeinde-Webseite");
    assert.equal(updated.sourceUrl, "https://baden.example.org/baugesuche");
    assert.equal(updated.municipality, "Baden");
    assert.equal(updated.publicationDate, "2026-06-02");
    assert.equal(updated.reconciliationStatus, "municipality-only");
  } finally {
    db.close();
  }
});

test("reconcileApplication nutzt Amtsblatt-Default und vorhandene URL, wenn der Amtsblatt-Nachweis lückenhaft ist", () => {
  const { db, repo, reconciler } = setup();
  try {
    repo.importItems([
      item({
        id: "AMTSBLATT-FALLBACK",
        source: "Amtsblatt Aargau",
        sourceReference: "amtsblatt-fallback",
        sourceUrl: "https://amtsblatt.example.org/original",
        publicationDate: "2026-06-01"
      })
    ]);
    db.prepare("DELETE FROM application_source_evidence WHERE application_id = ?").run("AMTSBLATT-FALLBACK");

    reconciler.upsertEvidence(
      "AMTSBLATT-FALLBACK",
      {
        sourceKind: "amtsblatt",
        sourceReference: "amtsblatt-empty",
        municipality: "Baden",
        publicationDate: "2026-06-02",
        address: "Mellingerstrasse 7",
        projectType: "Fenstersanierung"
      },
      "2026-06-02T08:00:00.000Z"
    );
    reconciler.reconcileApplication("AMTSBLATT-FALLBACK", "2026-06-02T08:00:00.000Z");

    const updated = repo.getById("AMTSBLATT-FALLBACK");
    assert.equal(updated.source, "Amtsblatt Aargau");
    assert.equal(updated.sourceUrl, "https://amtsblatt.example.org/original");
    assert.equal(updated.reconciliationStatus, "amtsblatt-confirmed");
  } finally {
    db.close();
  }
});

test("upsertEvidence speichert leere optionale Felder und expliziten Match-Status", () => {
  const { db, repo, reconciler } = setup();
  try {
    repo.importItems([item({ id: "EXPLICIT-MATCH", sourceReference: "explicit-match" })]);
    db.prepare("DELETE FROM application_source_evidence WHERE application_id = ?").run("EXPLICIT-MATCH");

    reconciler.upsertEvidence(
      "EXPLICIT-MATCH",
      {
        sourceKind: "municipality",
        sourceReference: "explicit-match-evidence",
        matchStatus: "ambiguous"
      },
      "2026-06-03T08:00:00.000Z",
      "unmatched"
    );

    const [evidence] = reconciler.listSourceEvidence("EXPLICIT-MATCH");
    assert.equal(evidence.sourceName, "");
    assert.equal(evidence.sourceUrl, "");
    assert.equal(evidence.municipality, "");
    assert.equal(evidence.publicationDate, "");
    assert.equal(evidence.matchStatus, "unmatched");
  } finally {
    db.close();
  }
});

test("reconcileApplication ohne Nachweise lässt den Fall unverändert", () => {
  const { db, repo, reconciler } = setup();
  try {
    repo.importItems([item({ id: "NO-EVIDENCE", sourceReference: "no-evidence" })]);
    db.prepare("DELETE FROM application_source_evidence WHERE application_id = ?").run("NO-EVIDENCE");
    const before = repo.getById("NO-EVIDENCE");

    reconciler.reconcileApplication("NO-EVIDENCE", "2026-06-04T08:00:00.000Z");

    const after = repo.getById("NO-EVIDENCE");
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.reconciliationStatus, before.reconciliationStatus);
  } finally {
    db.close();
  }
});
