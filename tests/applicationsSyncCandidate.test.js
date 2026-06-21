import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultAgisMatch,
  buildGeneratedSourceReference,
  looksLikeMarkupJunk,
  cleanProjectText,
  isDeadlineBeforePublication,
  appendAutomatedAssessmentNote,
  createImportCandidate,
  createNormalizedApplication,
  parseApiPayload,
  normalizeImportedPayload
} from "../server/services/applicationsSyncCandidate.js";

test("defaultAgisMatch deckt alle Status ab", () => {
  assert.equal(defaultAgisMatch("protected-zone", true), "Noch nicht eindeutig zugeordnet");
  assert.equal(defaultAgisMatch("combined-hit", false), "ISOS-Fläche und Gebäude im Inventar");
  assert.equal(defaultAgisMatch("protected-point", false), "Treffer im Gebäudeinventar");
  assert.equal(defaultAgisMatch("protected-zone", false), "Treffer in ISOS-Fläche");
  assert.equal(defaultAgisMatch("manual-review", false), "Noch nicht eindeutig zugeordnet");
  assert.equal(defaultAgisMatch("no-hit", false), "Kein Schutztreffer");
});

test("buildGeneratedSourceReference", () => {
  const a = buildGeneratedSourceReference(["Baden", "Hauptstr 1"]);
  assert.match(a, /^AUTO-[0-9A-F]{16}$/);
  assert.equal(buildGeneratedSourceReference(["Baden", "Hauptstr 1"]), a, "deterministisch fuer gleiche Teile");
  assert.match(buildGeneratedSourceReference([]), /^AUTO-[0-9A-F]{16}$/);
});

test("looksLikeMarkupJunk", () => {
  assert.equal(looksLikeMarkupJunk("<div>x</div>"), true);
  assert.equal(looksLikeMarkupJunk("tx_news_pi1"), true);
  assert.equal(looksLikeMarkupJunk("Neubau Halle"), false);
});

test("cleanProjectText", () => {
  assert.equal(cleanProjectText("<b>Neubau</b> Halle"), "Neubau Halle");
  assert.equal(cleanProjectText("Bauvorhaben: Neubau"), "Neubau");
  assert.equal(cleanProjectText("Neubau Halle Bauherr: Meier AG"), "Neubau Halle");
  assert.equal(cleanProjectText("tx_news_pi1 filter%"), "");
  assert.equal(cleanProjectText(""), "");
});

test("isDeadlineBeforePublication", () => {
  assert.equal(isDeadlineBeforePublication("2026-01-01", "2026-02-01"), true);
  assert.equal(isDeadlineBeforePublication("2026-03-01", "2026-02-01"), false);
  assert.equal(isDeadlineBeforePublication("", "2026-02-01"), false);
});

test("appendAutomatedAssessmentNote", () => {
  assert.equal(appendAutomatedAssessmentNote("", "Hinweis"), "Hinweis");
  assert.equal(appendAutomatedAssessmentNote("A", ""), "A");
  assert.equal(appendAutomatedAssessmentNote("A B", "B"), "A B", "Duplikat wird nicht angehaengt");
  assert.equal(appendAutomatedAssessmentNote("A", "C"), "A C");
});

test("createImportCandidate", () => {
  assert.equal(createImportCandidate(null), null);
  assert.equal(createImportCandidate("x"), "x");

  const c = createImportCandidate({ attributes: { Gemeinde: "Baden", Adresse: "Hauptstr 1", PUBLIKATIONSDATUM: "2026-01-01" } }, "https://q.ch");
  assert.equal(c.municipality, "Baden");
  assert.equal(c.address, "Hauptstr 1");
  assert.equal(c.sourceUrl, "https://q.ch");

  const parcelOnly = createImportCandidate({ ParzNr: "123" }, "");
  assert.equal(parcelOnly.address, "Parzelle 123", "Parzelle dient als Adress-Platzhalter");
  assert.match(parcelOnly.automatedAssessment, /Frist im Import nicht vorhanden/);
});

test("createNormalizedApplication: gueltig, fehlend, ungueltige Frist", () => {
  const ok = createNormalizedApplication(
    { municipality: "Baden", address: "Hauptstr 1", publicationDate: "2026-01-01", sourceReference: "REF1" },
    "https://q.ch"
  );
  assert.equal(ok.municipality, "Baden");
  assert.equal(ok.sourceReference, "REF1");
  assert.equal(ok.projectType, "Baugesuch");

  assert.equal(
    createNormalizedApplication({ address: "Hauptstr 1", sourceReference: "R" }, ""),
    null,
    "ohne Gemeinde -> null"
  );

  const badDeadline = createNormalizedApplication(
    { municipality: "Baden", address: "X 1", publicationDate: "2026-02-01", deadlineDate: "2026-01-01", sourceReference: "R" },
    ""
  );
  assert.equal(badDeadline.deadlineDate, "", "ungueltige Frist wird geleert");
  assert.match(badDeadline.automatedAssessment, /Fristdatum liegt vor Publikationsdatum/);
});

test("parseApiPayload + normalizeImportedPayload", () => {
  assert.deepEqual(parseApiPayload([1, 2]), [1, 2]);
  assert.deepEqual(parseApiPayload({ items: [1] }), [1]);
  assert.deepEqual(parseApiPayload({ features: [2] }), [2]);
  assert.deepEqual(parseApiPayload({ other: true }), []);

  const items = normalizeImportedPayload(
    { items: [{ municipality: "Baden", address: "Hauptstr 1", sourceReference: "REF1", publicationDate: "2026-01-01" }, { nothing: true }] },
    "https://q.ch"
  );
  assert.equal(items.length, 1, "ungueltige Eintraege werden gefiltert");
  assert.equal(items[0].municipality, "Baden");
});
