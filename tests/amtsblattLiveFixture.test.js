import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAmtsblattItemFromEntry } from "../server/services/applicationsSyncAmtsblatt.js";
import { createNormalizedApplication } from "../server/services/applicationsSyncCandidate.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/amtsblatt-current-structure.json", import.meta.url), "utf8")
);

test("Amtsblatt erfindet keine Frist und trennt Projekttext von der Adresse", async () => {
  const item = await buildAmtsblattItemFromEntry(
    fixture,
    "https://amtsblatt.ag.ch",
    "https://amtsblatt.ag.ch/publikationen/",
    null,
    1000,
    new Map()
  );

  assert.equal(item.deadlineDate, "");
  assert.equal(item.deadlineProvenance, "missing");
  assert.match(item.automatedAssessment, /Frist.*manuell/i);
  assert.equal(item.address, "Wallerstrasse 16");
  assert.equal(item.addressProvenance, "official-field");
});

test("Normalisierung bewahrt Frist- und Adressprovenienz", async () => {
  const imported = await buildAmtsblattItemFromEntry(
    fixture,
    "https://amtsblatt.ag.ch",
    "https://amtsblatt.ag.ch/publikationen/",
    null,
    1000,
    new Map()
  );
  const normalized = createNormalizedApplication(imported, imported.sourceUrl);

  assert.equal(normalized.deadlineProvenance, "missing");
  assert.equal(normalized.addressProvenance, "official-field");
});
