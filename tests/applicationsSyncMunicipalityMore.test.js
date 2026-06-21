import test from "node:test";
import assert from "node:assert/strict";
import {
  hasExplicitPermitSignal,
  looksLikeNonPermitMunicipalityContent,
  looksLikePdfUrl,
  mergePageDefaults
} from "../server/services/applicationsSyncMunicipality.js";

test("hasExplicitPermitSignal: Baugesuch-Signale erkennen", () => {
  assert.equal(hasExplicitPermitSignal("Baugesuch Bauherrschaft Bauobjekt"), true);
  assert.equal(hasExplicitPermitSignal("Kontakt und Impressum"), false);
});

test("looksLikeNonPermitMunicipalityContent: deckt alle Ausschlussgruende", () => {
  assert.equal(looksLikeNonPermitMunicipalityContent("", ""), false);
  // Mitteilungsblatt -> Bulletin
  assert.equal(looksLikeNonPermitMunicipalityContent("Mitteilungsblatt der Gemeinde", "https://x/y"), true);
  // Gemeinderat/Traktanden ohne Baugesuch-Signal -> Themenfilter
  assert.equal(looksLikeNonPermitMunicipalityContent("Gemeinderat Traktanden Protokoll Budget", "https://x/y"), true);
  // gleicher Text MIT Baugesuch-Signal -> kein Ausschluss
  assert.equal(looksLikeNonPermitMunicipalityContent("Baugesuch Bauherrschaft Gemeinderat", "https://x/y"), false);
  // Nicht-Permit-URL
  assert.equal(looksLikeNonPermitMunicipalityContent("irgendein text", "https://regionalebauverwaltung.ch/x"), true);
  // Plangenehmigungsverfahren -> nicht-kommunales Verfahren
  assert.equal(
    looksLikeNonPermitMunicipalityContent("Plangenehmigungsverfahren Elektrizitaetsgesetz", "https://x/y"),
    true
  );
  // generisches Suchergebnis
  assert.equal(looksLikeNonPermitMunicipalityContent("Suchergebnisse 1 bis 10", "https://x/suche"), true);
});

test("looksLikePdfUrl: Pfad, Query-Parameter, relative URL, Nicht-PDF", () => {
  assert.equal(looksLikePdfUrl("https://x/datei.pdf"), true);
  assert.equal(looksLikePdfUrl("https://x/dl?file=plan.pdf"), true);
  assert.equal(looksLikePdfUrl("relativ.pdf"), true);
  assert.equal(looksLikePdfUrl("https://x/seite"), false);
  assert.equal(looksLikePdfUrl(""), false);
});

test("mergePageDefaults: erster nicht-leerer Wert gewinnt", () => {
  assert.deepEqual(
    mergePageDefaults({ publicationDate: "", deadlineDate: "" }, { publicationDate: "2026-06-01", deadlineDate: "" }, { deadlineDate: "2026-07-01" }),
    { publicationDate: "2026-06-01", deadlineDate: "2026-07-01" }
  );
});
