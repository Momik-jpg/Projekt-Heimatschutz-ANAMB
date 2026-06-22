import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";

function item(overrides) {
  return {
    id: overrides.id,
    source: overrides.source ?? "Amtsblatt Aargau",
    sourceReference: overrides.sourceReference ?? overrides.id,
    sourceUrl: `https://example.org/${overrides.id}`,
    municipality: overrides.municipality ?? "Niederlenz",
    address: overrides.address ?? "Hetex Areal",
    parcel: overrides.parcel ?? "22",
    coordinates: overrides.coordinates ?? "2654000,1249000",
    publicationDate: overrides.publicationDate ?? "2026-05-28",
    deadlineDate: overrides.deadlineDate ?? "",
    deadlineProvenance: overrides.deadlineProvenance ?? "missing",
    addressProvenance: "official-field",
    projectType: overrides.projectType ?? "Gewerbegebäude",
    description: overrides.description ?? "Projektanpassung Hetex Areal",
    protectionStatus: overrides.protectionStatus ?? "no-hit",
    agisMatch: "",
    agisLayers: [],
    ambiguousAddress: 0
  };
}

function setup() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return { db, repo: createApplicationsRepository(db) };
}

test("Gemeinde-Dublette zu bestehendem Amtsblatt-Fall (gleiche Parzelle, zeitnah) wird übersprungen", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-1", sourceReference: "00.096.667", parcel: "22", publicationDate: "2026-05-28" })]);
    const result = repo.importItems([
      item({ id: "GEM-1", source: "Niederlenz Baugesuche", sourceReference: "gem-niederlenz-1", parcel: "22", publicationDate: "2026-05-29" })
    ]);

    assert.equal(result.skippedDuplicates, 1);
    assert.equal(result.importedCount, 0);
    const all = repo.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].source, "Amtsblatt Aargau");
  } finally {
    db.close();
  }
});

test("andere Parzelle: kein Dublettenabgleich, beide Fälle bleiben", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-2", sourceReference: "amt-2", parcel: "22" })]);
    const result = repo.importItems([
      item({ id: "GEM-2", source: "Gemeinde-Webseite", sourceReference: "gem-2", parcel: "99" })
    ]);

    assert.equal(result.skippedDuplicates, 0);
    assert.equal(repo.list().length, 2);
  } finally {
    db.close();
  }
});

test("gleiche Parzelle aber zeitlich weit auseinander: getrennte Fälle bleiben erhalten", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-3", sourceReference: "amt-3", parcel: "22", publicationDate: "2024-01-10" })]);
    const result = repo.importItems([
      item({ id: "GEM-3", source: "Gemeinde-Webseite", sourceReference: "gem-3", parcel: "22", publicationDate: "2026-05-29" })
    ]);

    assert.equal(result.skippedDuplicates, 0);
    assert.equal(repo.list().length, 2);
  } finally {
    db.close();
  }
});

test("eingehender Amtsblatt-Fall wird nie als Dublette übersprungen", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "GEM-4", source: "Gemeinde-Webseite", sourceReference: "gem-4", parcel: "22", publicationDate: "2026-05-28" })]);
    const result = repo.importItems([
      item({ id: "AMT-4", source: "Amtsblatt Aargau", sourceReference: "amt-4", parcel: "22", publicationDate: "2026-05-28" })
    ]);

    assert.equal(result.skippedDuplicates, 0);
    assert.equal(repo.list().length, 2);
  } finally {
    db.close();
  }
});

test("ohne Parzelle findet keine inhaltsbasierte Zusammenführung statt", () => {
  const { db, repo } = setup();
  try {
    repo.importItems([item({ id: "AMT-5", sourceReference: "amt-5", parcel: "" })]);
    const result = repo.importItems([
      item({ id: "GEM-5", source: "Gemeinde-Webseite", sourceReference: "gem-5", parcel: "" })
    ]);

    assert.equal(result.skippedDuplicates, 0);
    assert.equal(repo.list().length, 2);
  } finally {
    db.close();
  }
});
