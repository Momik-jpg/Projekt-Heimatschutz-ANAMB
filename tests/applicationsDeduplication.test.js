import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";

function item(overrides) {
  return {
    id: overrides.id,
    source: overrides.source ?? "Amtsblatt Aargau",
    sourceReference: overrides.sourceReference ?? overrides.id,
    sourceUrl: overrides.sourceUrl ?? `https://example.org/${overrides.id}`,
    municipality: overrides.municipality ?? "Niederlenz",
    address: overrides.address ?? "Industriestrasse 5",
    parcel: overrides.parcel ?? "22",
    coordinates: overrides.coordinates ?? "2654000,1249000",
    publicationDate: overrides.publicationDate ?? "2026-05-28",
    deadlineDate: overrides.deadlineDate ?? "",
    deadlineProvenance: overrides.deadlineProvenance ?? (overrides.deadlineDate ? "explicit" : "missing"),
    addressProvenance: "official-field",
    projectType: overrides.projectType ?? "Gewerbegebäude",
    description: overrides.description ?? "Projektanpassung Hetex Areal",
    protectionStatus: overrides.protectionStatus ?? "no-hit",
    agisMatch: "",
    agisLayers: [],
    ambiguousAddress: overrides.ambiguousAddress ?? 0
  };
}

function setup() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return { db, repo: createApplicationsRepository(db) };
}

test("Gemeinde-Nachweis zu bestehendem Amtsblatt-Fall wird zusammengeführt (1 Fall, 2 Nachweise)", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-1", source: "Amtsblatt Aargau", sourceReference: "00.096.667", parcel: "22", publicationDate: "2026-05-28", deadlineDate: "" })]);
    const result = repo.importItems([
      item({ id: "GEM-1", source: "Niederlenz Baugesuche", sourceReference: "gem-1", parcel: "Parzelle 22", publicationDate: "2026-05-28", deadlineDate: "2026-06-29" })
    ]);

    assert.equal(result.mergedCount, 1);
    assert.equal(result.importedCount, 0);

    const all = repo.list();
    assert.equal(all.length, 1, "kein zweiter Fall angelegt");
    const host = repo.getById(all[0].id);
    assert.equal(host.reconciliationStatus, "amtsblatt-confirmed");
    assert.equal(host.deadlineDate, "2026-06-29", "fehlende Frist aus Gemeindequelle ergänzt");
    assert.equal(host.sourceEvidence.length, 2);
    assert.ok(host.sourceEvidence.some((e) => e.sourceKind === "amtsblatt"));
    assert.ok(host.sourceEvidence.some((e) => e.sourceKind === "municipality"));
  } finally {
    db.close();
  }
});

test("späterer Amtsblatt-Nachweis hebt einen Gemeindefall auf amtsblatt-confirmed", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "GEM-2", source: "Gemeinde-Webseite", sourceReference: "gem-2", parcel: "22", publicationDate: "2026-05-28" })]);
    let host = repo.getById(repo.list()[0].id);
    assert.equal(host.reconciliationStatus, "municipality-only");

    const result = repo.importItems([
      item({ id: "AMT-2", source: "Amtsblatt Aargau", sourceReference: "amt-2", parcel: "22", publicationDate: "2026-05-28" })
    ]);
    assert.equal(result.mergedCount, 1);

    const all = repo.list();
    assert.equal(all.length, 1);
    host = repo.getById(all[0].id);
    assert.equal(host.reconciliationStatus, "amtsblatt-confirmed");
    assert.equal(host.source, "Amtsblatt Aargau");
  } finally {
    db.close();
  }
});

test("unterschiedliche Parzelle und Adresse: kein Abgleich, zwei Fälle bleiben", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-3", sourceReference: "amt-3", parcel: "22", address: "Industriestrasse 5" })]);
    const result = repo.importItems([
      item({ id: "GEM-3", source: "Gemeinde-Webseite", sourceReference: "gem-3", parcel: "99", address: "Dorfstrasse 1" })
    ]);

    assert.equal(result.mergedCount, 0);
    assert.equal(result.importedCount, 1);
    assert.equal(repo.list().length, 2);
  } finally {
    db.close();
  }
});

test("gleiche Referenz aus verschiedenen Quellen überschreibt keinen fremden Fall", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([
      item({
        id: "AMT-DUP-REF",
        source: "Amtsblatt Aargau",
        sourceReference: "DUP-REF",
        municipality: "Aarau",
        parcel: "22",
        address: "Bahnhofstrasse 1",
        projectType: "Umbau Wohnhaus"
      })
    ]);
    const result = repo.importItems([
      item({
        id: "GEM-DUP-REF",
        source: "Gemeinde-Webseite",
        sourceReference: "DUP-REF",
        municipality: "Baden",
        parcel: "99",
        address: "Badstrasse 9",
        projectType: "Neubau Werkstatt"
      })
    ]);

    assert.equal(result.importedCount, 1);
    assert.equal(result.mergedCount, 0);
    const all = repo.list();
    assert.equal(all.length, 2);
    const amtsblatt = repo.getById("AMT-DUP-REF");
    assert.equal(amtsblatt.municipality, "Aarau");
    assert.equal(amtsblatt.address, "Bahnhofstrasse 1");
    assert.equal(amtsblatt.reconciliationStatus, "amtsblatt-confirmed");
    const gemeinde = repo.getById("GEM-DUP-REF");
    assert.equal(gemeinde.municipality, "Baden");
    assert.equal(gemeinde.reconciliationStatus, "municipality-only");
  } finally {
    db.close();
  }
});

test("Gemeindeabgleich nutzt normalisierte Aargauer Gemeindenamen", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([
      item({
        id: "AMT-ARNI",
        source: "Amtsblatt Aargau",
        sourceReference: "amt-arni",
        municipality: "Arni (AG)",
        parcel: "22",
        publicationDate: "2026-05-28"
      })
    ]);
    const result = repo.importItems([
      item({
        id: "GEM-ARNI",
        source: "Gemeinde-Webseite",
        sourceReference: "gem-arni",
        municipality: "Arni AG",
        parcel: "Parzelle 22",
        publicationDate: "2026-05-28"
      })
    ]);

    assert.equal(result.mergedCount, 1);
    assert.equal(repo.list().length, 1);
    const host = repo.getById(repo.list()[0].id);
    assert.equal(host.reconciliationStatus, "amtsblatt-confirmed");
    assert.equal(host.sourceEvidence.length, 2);
  } finally {
    db.close();
  }
});

test("gleiche Publikation und Parzelle, aber abweichende Sachfelder bleiben Konflikt statt bestätigt", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([
      item({
        id: "AMT-CONFLICT",
        sourceReference: "amt-conflict",
        parcel: "1189",
        address: "Mellingerstrasse 7",
        projectType: "Fenstersanierung",
        publicationDate: "2026-05-28"
      })
    ]);
    const result = repo.importItems([
      item({
        id: "GEM-CONFLICT",
        source: "Gemeinde-Webseite",
        sourceReference: "gem-conflict",
        parcel: "1189",
        address: "Badstrasse 1",
        projectType: "Abbruch Scheune",
        publicationDate: "2026-05-28"
      })
    ]);

    assert.equal(result.mergedCount, 1);
    const host = repo.getById(repo.list()[0].id);
    assert.equal(host.reconciliationStatus, "conflict-review");
    assert.equal(host.sourceEvidence.length, 2);
  } finally {
    db.close();
  }
});

test("gleiche Parzelle aber abweichendes Publikationsdatum: kein automatischer Abgleich", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-4", sourceReference: "amt-4", parcel: "22", publicationDate: "2026-05-28", address: "Industriestrasse 5" })]);
    const result = repo.importItems([
      item({ id: "GEM-4", source: "Gemeinde-Webseite", sourceReference: "gem-4", parcel: "22", publicationDate: "2026-02-01", address: "Andere Gasse 9" })
    ]);

    assert.equal(result.mergedCount, 0);
    assert.equal(repo.list().length, 2);
  } finally {
    db.close();
  }
});

test("zwei Amtsblatt-Referenzen werden nicht nur wegen Inhaltsgleichheit verschmolzen", () => {
  const { db, repo } = setup();
  try {
    const result = repo.importItems([
      item({ id: "AMT-A", sourceReference: "amt-a", parcel: "22", publicationDate: "2026-05-28" }),
      item({ id: "AMT-B", sourceReference: "amt-b", parcel: "22", publicationDate: "2026-05-28" })
    ]);

    assert.equal(result.importedCount, 2);
    assert.equal(result.mergedCount, 0);
    assert.equal(repo.list().length, 2);
    assert.deepEqual(
      repo.list().map((entry) => entry.sourceReference).sort(),
      ["amt-a", "amt-b"]
    );
  } finally {
    db.close();
  }
});

test("mehrdeutiger Gemeinde-Abgleich wird als eigener Review-Fall importiert", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([
      item({ id: "AMT-AMB-1", sourceReference: "amt-amb-1", parcel: "22", publicationDate: "2026-05-28" }),
      item({ id: "AMT-AMB-2", sourceReference: "amt-amb-2", parcel: "22", publicationDate: "2026-05-28" })
    ]);

    const result = repo.importItems([
      item({
        id: "GEM-AMB",
        source: "Gemeinde-Webseite",
        sourceReference: "gem-amb",
        parcel: "Parzelle 22",
        publicationDate: "2026-05-28"
      })
    ]);

    assert.equal(result.mergedCount, 0);
    assert.equal(result.importedCount, 1);
    assert.equal(repo.list().length, 3);
    const ambiguous = repo.getById(repo.list().find((entry) => entry.sourceReference === "gem-amb").id);
    assert.equal(ambiguous.reconciliationStatus, "ambiguous-review");
    assert.equal(ambiguous.sourceEvidence[0].matchStatus, "ambiguous");
  } finally {
    db.close();
  }
});

test("generische API-Quellen werden als Importprüfung statt Gemeindequelle geführt", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "API-1", source: "API", sourceReference: "api-1", publicationDate: "2026-05-20" })]);
    const host = repo.getById(repo.list()[0].id);
    assert.equal(host.reconciliationStatus, "import-review");
    assert.equal(host.sourceEvidence[0].sourceKind, "import");
  } finally {
    db.close();
  }
});

test("reiner Gemeindefall mit Publikationsdatum ist municipality-only", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "GEM-5", source: "Gemeinde-Webseite", sourceReference: "gem-5", parcel: "5", publicationDate: "2026-05-20" })]);
    const host = repo.getById(repo.list()[0].id);
    assert.equal(host.reconciliationStatus, "municipality-only");
    assert.equal(host.sourceEvidence.length, 1);
  } finally {
    db.close();
  }
});

test("Merge ergänzt fehlenden Eigennachweis alter Fälle vor dem Fremdnachweis", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([
      item({
        id: "AMT-NO-EVIDENCE",
        source: "Amtsblatt Aargau",
        sourceReference: "amt-no-evidence",
        parcel: "22",
        publicationDate: "2026-05-28"
      })
    ]);
    db.prepare("DELETE FROM application_source_evidence WHERE application_id = ?").run("AMT-NO-EVIDENCE");

    const result = repo.importItems([
      item({
        id: "GEM-NO-EVIDENCE",
        source: "Gemeinde-Webseite",
        sourceReference: "gem-no-evidence",
        parcel: "Parzelle 22",
        publicationDate: "2026-05-28",
        deadlineDate: "2026-06-29"
      })
    ]);

    assert.equal(result.mergedCount, 1);
    const host = repo.getById("AMT-NO-EVIDENCE");
    assert.equal(host.sourceEvidence.length, 2);
    assert.ok(host.sourceEvidence.some((entry) => entry.sourceKind === "amtsblatt"));
    assert.ok(host.sourceEvidence.some((entry) => entry.sourceKind === "municipality"));
  } finally {
    db.close();
  }
});

test("gleiche ID und Referenz aktualisiert vorhandenen Fall trotz generischem API-Label", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([
      item({
        id: "SAME-ID-REF",
        source: "Amtsblatt Aargau",
        sourceReference: "same-id-ref",
        projectType: "Fenstersanierung",
        ambiguousAddress: 0
      })
    ]);

    const result = repo.importItems([
      item({
        id: "SAME-ID-REF",
        source: "API",
        sourceReference: "same-id-ref",
        projectType: "Fenstersanierung aktualisiert",
        ambiguousAddress: "yes"
      })
    ]);

    assert.equal(result.updatedCount, 1);
    assert.equal(repo.list().length, 1);
    const updated = repo.getById("SAME-ID-REF");
    assert.equal(updated.projectType, "Fenstersanierung aktualisiert");
    assert.equal(updated.ambiguousAddress, true);
    assert.equal(updated.sourceEvidence.length, 1);
    assert.equal(updated.sourceEvidence[0].sourceKind, "amtsblatt");
  } finally {
    db.close();
  }
});
