import test from "node:test";
import assert from "node:assert/strict";
import {
  assessImportedItems,
  buildSourceLabel,
  mergeSyncResults,
  normalizeSourceType
} from "../server/services/applicationsSyncSource.js";

test("buildSourceLabel: Gemeinde plus erkannter Typ", () => {
  assert.equal(buildSourceLabel({ municipality: "Aarau", sourceUrl: "https://x/data.json" }), "Aarau (json)");
});

test("normalizeSourceType: expliziter Typ und URL-Erkennung", () => {
  assert.equal(normalizeSourceType({ sourceType: "json" }), "json");
  assert.equal(normalizeSourceType({ sourceType: "pdf" }), "pdf");
  assert.equal(normalizeSourceType({ sourceType: "agis" }), "agis");
  assert.equal(normalizeSourceType({ sourceType: "arcgis" }), "arcgis");
  assert.equal(normalizeSourceType({ sourceType: "website" }), "website");
  assert.equal(normalizeSourceType({ sourceType: "", sourceUrl: "https://x/data.json" }), "json");
  assert.equal(normalizeSourceType({ sourceType: "", sourceUrl: "https://x/file.pdf" }), "pdf");
});

test("assessImportedItems: Funktion, Null-Rueckgabe, kein Assessor", async () => {
  const assessed = await assessImportedItems([{ id: "1" }, { id: "2" }], async (item) => ({ ...item, ok: true }));
  assert.deepEqual(assessed.map((i) => i.ok), [true, true]);

  const keepsOnNull = await assessImportedItems([{ id: "1" }], async () => null);
  assert.equal(keepsOnNull[0].id, "1");

  const keepsOnNoFn = await assessImportedItems([{ id: "1" }, { id: "2" }], null);
  assert.equal(keepsOnNoFn.length, 2);
});

test("mergeSyncResults: aggregiert Zaehler, Arrays und imported-Flag", () => {
  const merged = mergeSyncResults([
    { imported: false, importedCount: 1, updatedCount: 2, items: [{ a: 1 }], changes: [], notificationCount: 1 },
    { imported: true, importedCount: 3, updatedCount: 0, skippedCount: 5, items: [{ b: 2 }], changes: [{ c: 3 }], errors: ["e"] }
  ]);
  assert.equal(merged.imported, true);
  assert.equal(merged.importedCount, 4);
  assert.equal(merged.updatedCount, 2);
  assert.equal(merged.skippedCount, 5);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.changes.length, 1);
  assert.equal(merged.notificationCount, 1);
});
