import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_KIND_AMTSBLATT,
  SOURCE_KIND_IMPORT,
  SOURCE_KIND_MUNICIPALITY,
  RECONCILIATION_STATUS,
  sourceKindOf,
  normalizeParcel,
  normalizeAddress,
  matchRule,
  findReconciliationMatch,
  canReconcileSources,
  detectConflicts,
  deriveReconciliationStatus,
  buildCanonicalFields
} from "../server/domain/sourceReconciliation.js";

test("sourceKindOf erkennt Amtsblatt vs Gemeinde", () => {
  assert.equal(sourceKindOf("Amtsblatt Aargau"), SOURCE_KIND_AMTSBLATT);
  assert.equal(sourceKindOf("Niederlenz Baugesuche"), SOURCE_KIND_MUNICIPALITY);
  assert.equal(sourceKindOf("Gemeinde-Webseite"), SOURCE_KIND_MUNICIPALITY);
  assert.equal(sourceKindOf("API"), SOURCE_KIND_IMPORT);
  assert.equal(sourceKindOf("AGIS"), SOURCE_KIND_IMPORT);
  assert.equal(sourceKindOf("AGIS Baugesuche"), SOURCE_KIND_IMPORT);
  assert.equal(sourceKindOf("API Baugesuche"), SOURCE_KIND_IMPORT);
  assert.equal(sourceKindOf("Baugesuche Import"), SOURCE_KIND_IMPORT);
});

test("Normalizer vereinheitlichen Parzelle und Strasse", () => {
  assert.equal(normalizeParcel("Parzelle 22"), "22");
  assert.equal(normalizeParcel("GB 1119"), "1119");
  assert.equal(normalizeParcel(" 22 "), "22");
  assert.equal(normalizeAddress("Bahnhofstrasse 12"), normalizeAddress("Bahnhofstr. 12"));
});

test("matchRule: Gemeinde + Publikationsdatum + Parzelle wird zugeordnet", () => {
  const a = { municipality: "Niederlenz", publicationDate: "2026-05-28", parcel: "22", projectType: "Gewerbe" };
  const b = { municipality: "Niederlenz", publicationDate: "2026-05-28", parcel: "Parzelle 22", projectType: "Anderer Text" };
  assert.equal(matchRule(a, b), "publication+parcel");
});

test("matchRule: Gemeindenamen mit Kantonszusatz werden vor dem Abgleich vereinheitlicht", () => {
  const a = { municipality: "Arni (AG)", publicationDate: "2026-05-28", parcel: "22" };
  const b = { municipality: "Arni AG", publicationDate: "2026-05-28", parcel: "Parzelle 22" };
  assert.equal(matchRule(a, b), "publication+parcel");
});

test("matchRule: Gemeinde + Publikationsdatum + volle Adresse wird zugeordnet", () => {
  const a = { municipality: "Aarau", publicationDate: "2026-06-10", address: "Bahnhofstrasse 12", projectType: "Umbau" };
  const b = { municipality: "Aarau", publicationDate: "2026-06-10", address: "Bahnhofstr. 12", projectType: "Neubau" };
  assert.equal(matchRule(a, b), "publication+address");
});

test("matchRule: gleiche Parzelle aber anderes Bauvorhaben (ohne Publikationsdatum) wird NICHT zugeordnet", () => {
  const a = { municipality: "Aarau", publicationDate: "", parcel: "22", projectType: "Neubau Einfamilienhaus" };
  const b = { municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22", projectType: "Abbruch Scheune" };
  assert.equal(matchRule(a, b), null);
});

test("matchRule: ohne Publikationsdatum reichen Parzelle + Bauvorhaben", () => {
  const a = { municipality: "Aarau", publicationDate: "", parcel: "22", projectType: "Neubau Einfamilienhaus" };
  const b = { municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22", projectType: "Neubau Einfamilienhaus" };
  assert.equal(matchRule(a, b), "parcel+project");
});

test("matchRule: ähnliche Adresse ohne zweites Merkmal wird NICHT zugeordnet", () => {
  const a = { municipality: "Aarau", publicationDate: "", address: "Bahnhofstrasse 12", projectType: "Umbau" };
  const b = { municipality: "Aarau", publicationDate: "", address: "Bahnhofstrasse 12", projectType: "Voellig anderes Projekt" };
  assert.equal(matchRule(a, b), null);
});

test("matchRule: andere Gemeinde wird nie zugeordnet", () => {
  const a = { municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22" };
  const b = { municipality: "Baden", publicationDate: "2026-06-10", parcel: "22" };
  assert.equal(matchRule(a, b), null);
});

test("findReconciliationMatch: eindeutig / keiner / mehrdeutig", () => {
  const incoming = { municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22" };
  assert.equal(findReconciliationMatch(incoming, []).status, "none");

  const single = findReconciliationMatch(incoming, [
    { id: "X", municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22" },
    { id: "Y", municipality: "Baden", publicationDate: "2026-06-10", parcel: "99" }
  ]);
  assert.equal(single.status, "matched");
  assert.equal(single.candidate.id, "X");

  const ambiguous = findReconciliationMatch(incoming, [
    { id: "X", municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22" },
    { id: "Z", municipality: "Aarau", publicationDate: "2026-06-10", parcel: "22" }
  ]);
  assert.equal(ambiguous.status, "ambiguous");
});

test("canReconcileSources verhindert Importquellen und Amtsblatt-zu-Amtsblatt-Merges", () => {
  assert.equal(canReconcileSources(SOURCE_KIND_MUNICIPALITY, SOURCE_KIND_AMTSBLATT), true);
  assert.equal(canReconcileSources(SOURCE_KIND_AMTSBLATT, SOURCE_KIND_MUNICIPALITY), true);
  assert.equal(canReconcileSources(SOURCE_KIND_AMTSBLATT, SOURCE_KIND_AMTSBLATT), false);
  assert.equal(canReconcileSources(SOURCE_KIND_IMPORT, SOURCE_KIND_AMTSBLATT), false);
  assert.equal(canReconcileSources(SOURCE_KIND_MUNICIPALITY, SOURCE_KIND_IMPORT), false);
});

test("detectConflicts meldet abweichende belegte Identitätsfelder", () => {
  const a = {
    municipality: "Baden",
    publicationDate: "2026-05-28",
    deadlineDate: "2026-06-11",
    parcel: "22",
    address: "Bahnhofstrasse 1",
    projectType: "Umbau"
  };
  const b = {
    municipality: "Baden",
    publicationDate: "2026-05-30",
    deadlineDate: "2026-06-11",
    parcel: "22",
    address: "Bahnhofstr. 1",
    projectType: "Umbau"
  };
  assert.deepEqual(detectConflicts(a, b), ["publicationDate"]);
  assert.deepEqual(detectConflicts(a, { ...a }), []);
  assert.deepEqual(detectConflicts(a, { ...a, parcel: "99" }), ["parcel"]);
  assert.deepEqual(detectConflicts(a, { ...a, address: "Dorfstrasse 9" }), ["address"]);
  assert.deepEqual(detectConflicts(a, { ...a, projectType: "Abbruch" }), ["projectType"]);
});

test("buildCanonicalFields: Amtsblatt-Werte gewinnen, fehlende werden aus Gemeinde ergänzt", () => {
  const evidences = [
    { sourceKind: SOURCE_KIND_AMTSBLATT, publicationDate: "2026-05-28", deadlineDate: "", address: "", parcel: "22", projectType: "Gewerbe" },
    { sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "2026-05-29", deadlineDate: "2026-06-29", address: "Industriestrasse 5", parcel: "22", projectType: "Gewerbe" }
  ];
  const canonical = buildCanonicalFields(evidences);
  assert.equal(canonical.publicationDate, "2026-05-28", "Amtsblatt-Publikationsdatum gewinnt");
  assert.equal(canonical.deadlineDate, "2026-06-29", "fehlende Frist aus Gemeinde ergänzt");
  assert.equal(canonical.address, "Industriestrasse 5", "fehlende Adresse aus Gemeinde ergänzt");
});

test("buildCanonicalFields: Publikationsdatum wird nie aus der Frist abgeleitet", () => {
  const evidences = [
    { sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "", deadlineDate: "2026-07-13", address: "Zelglistrasse 21", parcel: "1503", projectType: "Balkon" }
  ];
  assert.equal(buildCanonicalFields(evidences).publicationDate, "");
});

test("deriveReconciliationStatus deckt alle Status ab", () => {
  assert.equal(
    deriveReconciliationStatus([{ sourceKind: SOURCE_KIND_AMTSBLATT, publicationDate: "2026-05-28", deadlineDate: "2026-06-29" }]),
    RECONCILIATION_STATUS.AMTSBLATT_CONFIRMED
  );
  assert.equal(
    deriveReconciliationStatus([{ sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "2026-05-28" }]),
    RECONCILIATION_STATUS.MUNICIPALITY_ONLY
  );
  assert.equal(
    deriveReconciliationStatus([
      { sourceKind: SOURCE_KIND_AMTSBLATT, publicationDate: "2026-05-28" },
      { sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "2026-05-30" }
    ]),
    RECONCILIATION_STATUS.CONFLICT_REVIEW
  );
  assert.equal(
    deriveReconciliationStatus([
      { sourceKind: SOURCE_KIND_AMTSBLATT, publicationDate: "2026-05-28", parcel: "1189", address: "Mellingerstrasse 7", projectType: "Fenster" },
      { sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "2026-05-28", parcel: "9999", address: "Badstrasse 1", projectType: "Abbruch" }
    ]),
    RECONCILIATION_STATUS.CONFLICT_REVIEW
  );
  assert.equal(
    deriveReconciliationStatus([{ sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "", deadlineDate: "2026-07-13" }]),
    RECONCILIATION_STATUS.MISSING_PUBLICATION
  );
  assert.equal(
    deriveReconciliationStatus([{ sourceKind: SOURCE_KIND_IMPORT, publicationDate: "2026-05-28" }]),
    RECONCILIATION_STATUS.IMPORT_REVIEW
  );
  assert.equal(
    deriveReconciliationStatus([{ sourceKind: SOURCE_KIND_MUNICIPALITY, publicationDate: "2026-05-28", matchStatus: "ambiguous" }]),
    RECONCILIATION_STATUS.AMBIGUOUS_REVIEW
  );
  assert.equal(deriveReconciliationStatus([]), RECONCILIATION_STATUS.MISSING_PUBLICATION);
});
