import test from "node:test";
import assert from "node:assert/strict";
import {
  projectTypeSpecificity,
  cleanProjectFilePathText,
  normalizeImportedProjectType,
  extractPublicationDateFromText,
  extractDeadlineDateFromText,
  extractProjectTypeFromText,
  extractPagePublicationDefaults
} from "../server/services/applicationsSyncPublication.js";

test("projectTypeSpecificity", () => {
  assert.equal(projectTypeSpecificity(""), 0);
  assert.equal(projectTypeSpecificity("Nicht importieren"), 0);
  assert.equal(projectTypeSpecificity("Baugesuch"), 1);
  assert.equal(projectTypeSpecificity("Neubau Halle"), 2);
});

test("cleanProjectFilePathText", () => {
  assert.equal(cleanProjectFilePathText("Neubau Halle"), "Neubau Halle");
  const cleaned = cleanProjectFilePathText("plan.pdf Bauprojekt Neubau Halle");
  assert.match(cleaned, /Neubau Halle/);
  assert.ok(!/plan\.pdf/i.test(cleaned));
});

test("normalizeImportedProjectType", () => {
  assert.equal(normalizeImportedProjectType(""), "");
  assert.equal(normalizeImportedProjectType("", "https://x.aarau.ch/d/bg-2026-1"), "Baugesuch");
  assert.equal(normalizeImportedProjectType("x".repeat(150)), "");
  assert.equal(normalizeImportedProjectType("Bauherrschaft Muster AG"), "");
  assert.equal(normalizeImportedProjectType("Neubau Einfamilienhaus"), "Neubau Einfamilienhaus");
});

test("extractPublicationDateFromText", () => {
  assert.equal(extractPublicationDateFromText("Publiziert am 01.02.2026"), "2026-02-01");
  assert.equal(extractPublicationDateFromText("Stand 2026-02-01 aktuell"), "2026-02-01");
  assert.equal(extractPublicationDateFromText("kein datum hier"), "");
});

test("extractDeadlineDateFromText", () => {
  assert.equal(extractDeadlineDateFromText("Einsprachefrist bis 03.03.2026"), "2026-03-03");
  assert.equal(extractDeadlineDateFromText("ohne frist"), "");
});

test("extractProjectTypeFromText", () => {
  assert.match(extractProjectTypeFromText("Bauvorhaben: Neubau Mehrfamilienhaus Bauherr: Muster"), /Neubau Mehrfamilienhaus/);
  assert.equal(extractProjectTypeFromText("Erteilte Baubewilligungen der Gemeinde"), "Nicht importieren");
  assert.equal(extractProjectTypeFromText("beliebiger text", ""), "Baugesuch");
});

test("extractPagePublicationDefaults", () => {
  assert.deepEqual(extractPagePublicationDefaults("Öffentliche Auflage vom 01.02.2026 bis 03.03.2026"), {
    publicationDate: "2026-02-01",
    deadlineDate: "2026-03-03"
  });
  assert.deepEqual(extractPagePublicationDefaults("Stand 2026-02-01"), {
    publicationDate: "2026-02-01",
    deadlineDate: ""
  });
  assert.deepEqual(extractPagePublicationDefaults("nichts"), { publicationDate: "", deadlineDate: "" });
});
