import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMunicipalityKey,
  resolveOfficialAargauMunicipality
} from "../server/services/applicationsSyncConstants.js";

test("normalizeMunicipalityKey: Diakritika und Kantonszusatz entfernen", () => {
  assert.equal(normalizeMunicipalityKey("Hausen AG"), "hausen");
  assert.equal(normalizeMunicipalityKey("Arni (AG)"), "arni");
  assert.equal(normalizeMunicipalityKey("Möhlin"), "mohlin");
  assert.equal(normalizeMunicipalityKey(null), "");
  assert.equal(normalizeMunicipalityKey(""), "");
});

test("resolveOfficialAargauMunicipality: echte Gemeinde, Fremdort, leer", () => {
  assert.equal(resolveOfficialAargauMunicipality("Aarau"), "Aarau");
  assert.equal(resolveOfficialAargauMunicipality("aarau"), "Aarau");
  assert.equal(resolveOfficialAargauMunicipality("Zürich"), "", "Fremdkanton -> leer");
  assert.equal(resolveOfficialAargauMunicipality("Irgendein Projekttext 12"), "");
  assert.equal(resolveOfficialAargauMunicipality(""), "");
});
