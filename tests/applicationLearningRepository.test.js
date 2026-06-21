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

test("recordFromApplication: nur gelernte Status + abgeschlossene Faelle", () => {
  const repo = makeRepo();
  assert.equal(repo.recordFromApplication(null), null);
  assert.equal(repo.recordFromApplication({ protectionStatus: "unbekannt" }), null);
  assert.equal(
    repo.recordFromApplication({ ...learnedItem, workflowStatus: "new" }),
    null,
    "offener Fall ohne force wird nicht gelernt"
  );
  const rule = repo.recordFromApplication(learnedItem);
  assert.ok(rule, "abgeschlossener Fall erzeugt eine Regel");
});

test("findBestMatch + applyToItem (Treffer wird angewendet)", () => {
  const repo = makeRepo({ confidentScore: 0.1, minimumScore: 0.1 });
  repo.recordFromApplication(learnedItem);

  const query = { municipality: "Baden", address: "Hauptstrasse 15", projectType: "Neubau Mehrfamilienhaus", protectionStatus: "no-hit" };
  assert.ok(repo.findBestMatch(query), "passende Regel gefunden");

  const applied = repo.applyToItem(query);
  assert.ok(applied.rule);
  assert.equal(applied.item.protectionStatus, "protected-zone", "gelernte Einstufung uebernommen");
  assert.match(applied.item.automatedAssessment, /Lernregel/);
});

test("applyToItem ohne Treffer gibt das Item unveraendert zurueck", () => {
  const repo = makeRepo();
  const item = { municipality: "Zürich", address: "Bahnhofstrasse 1", projectType: "Umbau" };
  const out = repo.applyToItem(item);
  assert.equal(out.rule, null);
  assert.equal(out.score, 0);
  assert.equal(out.item, item);
});

test("getSummary zaehlt Regeln", () => {
  const repo = makeRepo();
  assert.equal(repo.getSummary().totalRules, 0);
  repo.recordFromApplication(learnedItem);
  assert.equal(repo.getSummary().totalRules, 1);
});
