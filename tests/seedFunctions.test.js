import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import {
  backfillSeedMunicipalitySources,
  insertSeedMunicipalitySources,
  syncConfiguredMasterPassword,
  upsertSeedMunicipalities,
  upsertSeedMunicipalityQualityAssessments,
  upsertSeedMunicipalitySourceLinks,
  upsertSeedPublicationSources
} from "../server/db/seed.js";

function freshDb() {
  return createDatabase(":memory:", { seedDemoApplications: false });
}

test("insertSeedMunicipalitySources: minimale Items nutzen Defaults", () => {
  const db = freshDb();
  insertSeedMunicipalitySources(
    db,
    [{ id: "MS-1", municipality: "Testdorf", sourceType: "manual" }],
    "2026-06-21T00:00:00.000Z"
  );
  const row = db.prepare("SELECT * FROM municipality_sources WHERE id=?").get("MS-1");
  assert.equal(row.source_url, "");
  assert.equal(row.digital_status, "unknown");
  assert.equal(row.enabled, 0);
});

test("upsert*: Insert dann Konflikt-Update", () => {
  const db = freshDb();

  upsertSeedMunicipalities(db, [{ id: "M-1", name: "Testdorf", createdAt: "t", updatedAt: "t" }]);
  upsertSeedMunicipalities(db, [{ id: "M-1", name: "Testdorf NEU", createdAt: "t", updatedAt: "t2" }]);
  assert.equal(db.prepare("SELECT name FROM municipalities WHERE id=?").get("M-1").name, "Testdorf NEU");

  upsertSeedPublicationSources(db, [{ id: "P-1", sourceKey: "k", name: "Quelle", sourceKind: "amtsblatt" }], "t");
  upsertSeedPublicationSources(
    db,
    [{ id: "P-1", sourceKey: "k", name: "Quelle 2", sourceKind: "amtsblatt", isShared: true }],
    "t2"
  );
  assert.equal(db.prepare("SELECT is_shared FROM publication_sources WHERE id=?").get("P-1").is_shared, 1);

  upsertSeedMunicipalitySourceLinks(db, [
    { id: "L-1", municipalityId: "M-1", sourceId: "P-1", relationType: "primary", updatedAt: "t" }
  ]);
  upsertSeedMunicipalitySourceLinks(db, [
    { id: "L-1", municipalityId: "M-1", sourceId: "P-1", relationType: "primary", enabled: true, notes: "x", updatedAt: "t2" }
  ]);
  assert.equal(db.prepare("SELECT enabled FROM municipality_source_links WHERE id=?").get("L-1").enabled, 1);

  upsertSeedMunicipalityQualityAssessments(db, [
    { municipalityId: "M-1", primarySourceId: "P-1", rating: "gut", rationale: "ok", updatedAt: "t" }
  ]);
  upsertSeedMunicipalityQualityAssessments(db, [
    { municipalityId: "M-1", primarySourceId: "P-1", rating: "sehr gut", rationale: "ok", uncertain: true, updatedAt: "t2" }
  ]);
  assert.equal(
    db.prepare("SELECT uncertain FROM municipality_quality_assessments WHERE municipality_id=?").get("M-1").uncertain,
    1
  );
});

test("backfillSeedMunicipalitySources: aktualisiert Legacy-Blank, überspringt befüllte und unbekannte", () => {
  const db = freshDb();
  insertSeedMunicipalitySources(db, [{ id: "MS-L", municipality: "Legacy", sourceType: "manual" }], "t");
  insertSeedMunicipalitySources(
    db,
    [{ id: "MS-F", municipality: "Fix", sourceType: "agis", sourceToken: "TKN", notes: "Handgepflegt" }],
    "t"
  );

  backfillSeedMunicipalitySources(
    db,
    [
      {
        id: "MS-L",
        sourceType: "agis",
        sourceUrl: "https://agis.example",
        enabled: 1,
        digitalStatus: "digital",
        notes: "Neu"
      },
      { id: "MS-F", sourceType: "manual", sourceUrl: "", notes: "ignoriert" },
      { id: "MS-UNBEKANNT", sourceType: "manual" }
    ],
    "t2"
  );

  const legacy = db.prepare("SELECT source_type, enabled FROM municipality_sources WHERE id=?").get("MS-L");
  assert.equal(legacy.source_type, "agis", "Legacy-Zeile wurde aktualisiert");
  assert.equal(legacy.enabled, 1);

  const fixed = db.prepare("SELECT source_type FROM municipality_sources WHERE id=?").get("MS-F");
  assert.equal(fixed.source_type, "agis", "befüllte Zeile bleibt unverändert");
});

test("backfillSeedMunicipalitySources: keine Änderung -> kein Update", () => {
  const db = freshDb();
  insertSeedMunicipalitySources(db, [{ id: "MS-S", municipality: "Same", sourceType: "manual" }], "t");
  backfillSeedMunicipalitySources(db, [{ id: "MS-S", sourceType: "manual" }], "t2");
  assert.equal(
    db.prepare("SELECT updated_at FROM municipality_sources WHERE id=?").get("MS-S").updated_at,
    "t",
    "kein Update bei unveränderten Werten"
  );
});

test("syncConfiguredMasterPassword: leeres Passwort = no-op, gesetztes Passwort aktualisiert", () => {
  const db = freshDb();
  const before = db.prepare("SELECT password_hash FROM users WHERE id='USR-MASTER'").get().password_hash;

  syncConfiguredMasterPassword(db, "");
  assert.equal(
    db.prepare("SELECT password_hash FROM users WHERE id='USR-MASTER'").get().password_hash,
    before,
    "leeres Passwort ändert nichts"
  );

  syncConfiguredMasterPassword(db, "GanzNeuesMasterPasswort!2026");
  assert.notEqual(
    db.prepare("SELECT password_hash FROM users WHERE id='USR-MASTER'").get().password_hash,
    before,
    "Passwort wurde aktualisiert"
  );
});
