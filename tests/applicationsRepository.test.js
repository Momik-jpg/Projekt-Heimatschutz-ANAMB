import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";
import { createNormalizedApplication } from "../server/services/applicationsSyncCandidate.js";

function setup() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return createApplicationsRepository(db);
}

function makeItem({ ref, municipality = "Baden", address = "Hauptstrasse 15", projectType = "Neubau" }) {
  return createNormalizedApplication(
    {
      id: ref,
      sourceReference: ref,
      municipality,
      address,
      coordinates: "2660000,1240000",
      publicationDate: "2026-01-01",
      projectType,
      protectionStatus: "no-hit"
    },
    "https://quelle.example/feed"
  );
}

test("importItems + list + Filter", () => {
  const repo = setup();
  const result = repo.importItems([
    makeItem({ ref: "REF-1", municipality: "Baden", address: "Hauptstrasse 15" }),
    makeItem({ ref: "REF-2", municipality: "Aarau", address: "Bahnhofstrasse 7" })
  ]);
  assert.equal(result.importedCount, 2);

  assert.equal(repo.list().length, 2);
  assert.equal(repo.list({ municipality: "Baden" }).length, 1);
  assert.equal(repo.list({ workflowStatus: "new" }).length, 2);
  assert.ok(repo.list({ search: "Bahnhofstrasse" }).length >= 1);
  assert.equal(repo.list({ municipality: "Zürich" }).length, 0);
});

test("getById / update / updateAssessment", () => {
  const repo = setup();
  repo.importItems([makeItem({ ref: "REF-1" })]);
  const created = repo.list()[0];

  assert.equal(repo.getById(created.id).sourceReference, "REF-1");
  assert.equal(repo.update("nicht-da", {}), null);

  const updated = repo.update(created.id, { workflowStatus: "cleared", note: "  geprüft  " });
  assert.equal(updated.workflowStatus, "cleared");
  assert.equal(updated.note, "geprüft");

  const assessed = repo.updateAssessment(created.id, {
    protectionStatus: "protected-zone",
    agisMatch: "Treffer in ISOS-Fläche",
    agisLayers: ["isos"]
  });
  assert.equal(assessed.protectionStatus, "protected-zone");
  assert.deepEqual(assessed.agisLayers, ["isos"]);
});

test("importItems dedupliziert ueber sourceReference", () => {
  const repo = setup();
  repo.importItems([makeItem({ ref: "REF-1", projectType: "Neubau" })]);
  const second = repo.importItems([makeItem({ ref: "REF-1", projectType: "Umbau" })]);
  assert.equal(repo.list().length, 1, "gleiche Referenz -> kein Duplikat");
  assert.equal(second.importedCount, 0);
  assert.ok(second.updatedCount >= 0);
});

test("getDashboard liefert Kennzahlen", () => {
  const repo = setup();
  repo.importItems([makeItem({ ref: "REF-1" }), makeItem({ ref: "REF-2", municipality: "Aarau" })]);
  const dashboard = repo.getDashboard();
  assert.ok(dashboard);
  assert.ok(Array.isArray(dashboard.municipalities));
});
