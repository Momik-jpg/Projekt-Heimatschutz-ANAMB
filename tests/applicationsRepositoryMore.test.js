import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";
import { createNormalizedApplication } from "../server/services/applicationsSyncCandidate.js";

function setup() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return createApplicationsRepository(db);
}

function makeItem({
  ref,
  source = "API",
  municipality = "Baden",
  address = `Hauptstrasse ${ref}`,
  parcel = `P-${ref}`,
  projectType = "Neubau",
  protectionStatus = "no-hit",
  publicationDate = "2026-01-01",
  deadlineDate,
  workflowStatus,
  ambiguousAddress
}) {
  return createNormalizedApplication(
    {
      id: ref,
      source,
      sourceReference: ref,
      municipality,
      address,
      parcel,
      coordinates: "2660000,1240000",
      publicationDate,
      deadlineDate,
      projectType,
      protectionStatus,
      workflowStatus,
      ambiguousAddress
    },
    "https://quelle.example/feed"
  );
}

test("list: Filter nach protectionStatus und source", () => {
  const repo = setup();
  repo.importItems([
    makeItem({ ref: "A", source: "AGIS", protectionStatus: "manual-review" }),
    makeItem({ ref: "B", source: "Amtsblatt", protectionStatus: "no-hit" })
  ]);
  assert.equal(repo.list({ protectionStatus: "manual-review" }).length, 1);
  assert.equal(repo.list({ source: "Amtsblatt" }).length, 1);
  assert.equal(repo.list({ source: "AGIS", protectionStatus: "no-hit" }).length, 0);
});

test("update/updateAssessment: Fallback auf aktuelle Werte", () => {
  const repo = setup();
  repo.importItems([makeItem({ ref: "A" })]);
  const id = repo.list()[0].id;

  const same = repo.update(id, {});
  assert.equal(same.workflowStatus, "new");

  const assessed = repo.updateAssessment(id, { protectionStatus: "protected-point" });
  assert.deepEqual(assessed.agisLayers, []);
  assert.equal(assessed.protectionStatus, "protected-point");
});

test("pruneUntouchedMunicipalityImports: leere Quelle, Keep-Liste, Schutz berührter Fälle", () => {
  const repo = setup();
  assert.equal(repo.pruneUntouchedMunicipalityImports({ source: "", municipality: "Baden" }), 0);

  repo.importItems([
    makeItem({ ref: "K-1", source: "AGIS", municipality: "Baden" }),
    makeItem({ ref: "K-2", source: "AGIS", municipality: "Baden" }),
    makeItem({ ref: "K-3", source: "AGIS", municipality: "Baden" })
  ]);
  const k3 = repo.list().find((x) => x.sourceReference === "K-3");
  repo.update(k3.id, { assignee: "Andrin" });

  const removed = repo.pruneUntouchedMunicipalityImports({
    source: "AGIS",
    municipality: "Baden",
    keepSourceReferences: ["K-1"]
  });
  assert.equal(removed, 1, "nur unberührtes, nicht-gekeeptes K-2 entfernt");
  assert.deepEqual(
    repo.list().map((x) => x.sourceReference).sort(),
    ["K-1", "K-3"]
  );

  const removed2 = repo.pruneUntouchedMunicipalityImports({ source: "AGIS", municipality: "Baden" });
  assert.equal(removed2, 1, "ohne Keep-Liste wird unberührtes K-1 entfernt");
  assert.deepEqual(
    repo.list().map((x) => x.sourceReference),
    ["K-3"],
    "berührtes K-3 bleibt erhalten"
  );
});

test("archiveExpiredApplications: ungültiges Datum, alte Publikation archiviert, ohne Publikation bleibt", () => {
  const repo = setup();
  assert.equal(repo.archiveExpiredApplications({ referenceDate: "kein-datum" }), 0);

  repo.importItems([
    makeItem({ ref: "ALT", publicationDate: "2026-01-01" }),
    makeItem({ ref: "OHNE-PUB", publicationDate: "" })
  ]);
  const archived = repo.archiveExpiredApplications({ referenceDate: new Date("2026-06-21") });
  assert.equal(archived, 1);
  assert.equal(repo.list().find((item) => item.sourceReference === "ALT").workflowStatus, "archived");
  assert.equal(repo.list().find((item) => item.sourceReference === "OHNE-PUB").workflowStatus, "new");
});

test("getDashboard: Kennzahlen, Quellen, dringende Fälle, ambiguousAddress", () => {
  const repo = setup();
  repo.importItems([
    makeItem({ ref: "D1", source: "Gemeinde-Webseite", protectionStatus: "combined-hit", deadlineDate: "2026-06-25" }),
    makeItem({ ref: "D2", source: "Gemeinde-Webseite", protectionStatus: "manual-review" }),
    makeItem({ ref: "D3", source: "Amtsblatt", protectionStatus: "no-hit" }),
    makeItem({ ref: "D4", source: "Amtsblatt", protectionStatus: "no-hit", ambiguousAddress: true })
  ]);

  const dashboard = repo.getDashboard({ referenceDate: new Date("2026-06-21") });
  assert.equal(dashboard.stats.totalApplications, 4);
  assert.equal(dashboard.stats.relevantApplications, 1, "nur combined-hit zählt als relevant");
  assert.equal(dashboard.stats.manualReview, 2, "manual-review ODER ambiguousAddress");
  assert.equal(dashboard.stats.dueSoon, 1, "D1 mit Frist in 4 Tagen");
  assert.equal(dashboard.sources.find((s) => s.source === "Gemeinde-Webseite").count, 2);
  assert.ok(dashboard.urgentCases.length >= 1);
  assert.ok(Array.isArray(dashboard.municipalities));

  const ambiguous = repo.list().find((x) => x.sourceReference === "D4");
  assert.equal(ambiguous.ambiguousAddress, true);
});

test("getDashboard ignoriert Fälle mit unsauberem Quellenstatus in aktiven Kennzahlen", () => {
  const repo = setup();
  repo.importItems([
    makeItem({ ref: "ACTIVE", source: "Amtsblatt", protectionStatus: "combined-hit", deadlineDate: "2026-06-25" }),
    makeItem({
      ref: "MISSING-PUB",
      source: "Gemeinde-Webseite",
      protectionStatus: "combined-hit",
      publicationDate: "",
      deadlineDate: "2026-06-25"
    }),
    makeItem({
      ref: "UNVERIFIED",
      source: "API",
      protectionStatus: "manual-review",
      publicationDate: "2026-06-20",
      deadlineDate: "2026-06-25"
    })
  ]);

  const dashboard = repo.getDashboard({ referenceDate: new Date("2026-06-21") });
  assert.equal(dashboard.stats.totalApplications, 3);
  assert.equal(dashboard.stats.relevantApplications, 1);
  assert.equal(dashboard.stats.manualReview, 0);
  assert.equal(dashboard.stats.dueSoon, 1);
  assert.deepEqual(dashboard.urgentCases.map((entry) => entry.id), ["ACTIVE"]);
});

test("simulateSync: importiert nächsten Fall aus der Warteschlange", () => {
  const repo = setup();
  const result = repo.simulateSync();
  assert.equal(result.imported, true);
  assert.equal(result.importedCount, 1);
  assert.ok(result.item);
  assert.ok(result.remainingQueue >= 0);
});
