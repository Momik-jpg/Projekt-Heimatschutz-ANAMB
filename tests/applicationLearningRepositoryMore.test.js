import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createApplicationLearningRepository } from "../server/repository/applicationLearningRepository.js";

function makeRepo(options) {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return createApplicationLearningRepository(db, options);
}

const learnedItem = {
  id: "BG-1",
  protectionStatus: "protected-zone",
  workflowStatus: "cleared",
  municipality: "Baden",
  address: "Hauptstrasse 15",
  projectType: "Neubau Mehrfamilienhaus",
  agisMatch: "Treffer in ISOS-Fläche",
  agisLayers: []
};

test("recordFromApplication: force lernt offenen Fall, Default-Werte, agisLayers als String", () => {
  const repo = makeRepo();
  const rule = repo.recordFromApplication(
    {
      id: "BG-9",
      protectionStatus: "protected-point",
      workflowStatus: "new",
      municipality: "Aarau",
      address: "Bahnhofstrasse 7",
      projectType: "Umbau",
      agisLayers: '["inventar"]'
    },
    { userId: "u-1", force: true }
  );
  assert.ok(rule, "force erzwingt das Lernen");
  assert.equal(rule.protectionStatus, "protected-point");
  assert.equal(rule.agisMatch, "Treffer im Gebäudeinventar", "Default-AGIS-Text");
  assert.deepEqual(rule.agisLayers, ["inventar"], "JSON-String wird geparst");
  assert.equal(rule.createdByUserId, "u-1");
  assert.match(rule.automatedAssessment, /Teamentscheid/);
});

test("recordFromApplication: ohne Signatur keine Regel", () => {
  const repo = makeRepo();
  assert.equal(
    repo.recordFromApplication({
      protectionStatus: "no-hit",
      workflowStatus: "cleared",
      municipality: "",
      address: "",
      projectType: ""
    }),
    null
  );
});

test("recordFromApplication: Default-AGIS-Texte je Schutzstatus", () => {
  const repo = makeRepo();
  const combined = repo.recordFromApplication({
    id: "c",
    protectionStatus: "combined-hit",
    workflowStatus: "cleared",
    municipality: "Aarau",
    address: "Weg 1",
    projectType: "Neubau"
  });
  assert.match(combined.agisMatch, /ISOS-Fläche und Gebäude/);

  const zone = repo.recordFromApplication({
    id: "z",
    protectionStatus: "protected-zone",
    workflowStatus: "cleared",
    municipality: "Wohlen",
    address: "Weg 4",
    projectType: "Anbau"
  });
  assert.match(zone.agisMatch, /Treffer in ISOS-Fläche/);

  const review = repo.recordFromApplication({
    id: "r",
    protectionStatus: "manual-review",
    workflowStatus: "cleared",
    municipality: "Brugg",
    address: "Weg 2",
    projectType: "Umbau"
  });
  assert.match(review.agisMatch, /Noch nicht eindeutig/);

  const none = repo.recordFromApplication({
    id: "n",
    protectionStatus: "no-hit",
    workflowStatus: "cleared",
    municipality: "Lenzburg",
    address: "Weg 3",
    projectType: "Sanierung"
  });
  assert.match(none.agisMatch, /Kein Schutztreffer/);
});

test("upsert: gleicher Status erhöht Confidence, abweichender Status setzt auf 0.72", () => {
  const repo = makeRepo();
  const first = repo.recordFromApplication(learnedItem);
  const second = repo.recordFromApplication(learnedItem);
  assert.equal(second.matchCount, 2);
  assert.ok(second.confidence > first.confidence, "gleicher Status -> Confidence steigt");

  const changed = repo.recordFromApplication({ ...learnedItem, protectionStatus: "no-hit" });
  assert.equal(changed.protectionStatus, "no-hit");
  assert.ok(Math.abs(changed.confidence - 0.72) < 1e-9, "abweichender Status -> 0.72");
  assert.equal(changed.matchCount, 3);
});

test("findBestMatch: unter minimumScore -> null", () => {
  const repo = makeRepo({ minimumScore: 0.99 });
  repo.recordFromApplication(learnedItem);
  assert.equal(
    repo.findBestMatch({ municipality: "Baden", address: "Komplett andere Gasse 99", projectType: "Garage" }),
    null
  );
});

test("applyToItem: Treffer aber nicht eindeutig -> manual-review", () => {
  const repo = makeRepo({ minimumScore: 0.1, confidentScore: 0.99 });
  repo.recordFromApplication(learnedItem);
  const out = repo.applyToItem({
    municipality: "Baden",
    address: "Hauptstrasse 15",
    projectType: "Neubau Mehrfamilienhaus"
  });
  assert.ok(out.rule, "Regel gefunden");
  assert.equal(out.item.protectionStatus, "manual-review");
  assert.equal(out.item.ambiguousAddress, 1);
  assert.match(out.item.automatedAssessment, /von Hand prüfen/);
});

test("getSummary: Aggregatwerte nach dem Lernen", () => {
  const repo = makeRepo();
  repo.recordFromApplication(learnedItem);
  const summary = repo.getSummary();
  assert.equal(summary.totalRules, 1);
  assert.equal(summary.totalMatches, 1);
  assert.ok(summary.averageConfidence > 0);
  assert.ok(summary.lastTrainedAt);
});
