import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeExtractedAddress,
  shortenText,
  removeNonContentHtmlRegions,
  extractSwissCoordinatesFromText,
  extractParcelFromText,
  extractLabeledValue,
  extractAddressFromText,
  extractAddressFromPublicationTitle,
  chooseMoreSpecificAddress,
  formatImportedMunicipalityAddress,
  normalizeImportedMunicipalityAddress
} from "../server/services/applicationsSyncAddress.js";

test("sanitizeExtractedAddress", () => {
  assert.equal(sanitizeExtractedAddress("Hauptstrasse 15"), "Hauptstrasse 15");
  assert.equal(sanitizeExtractedAddress(", Bahnhofstrasse 7,"), "Bahnhofstrasse 7");
  assert.equal(sanitizeExtractedAddress("01.02.2026"), "");
  assert.equal(sanitizeExtractedAddress(""), "");
});

test("shortenText", () => {
  assert.equal(shortenText("kurz", 320), "kurz");
  const long = shortenText("x".repeat(500), 50);
  assert.ok(long.length <= 50);
  assert.ok(long.endsWith("…"));
});

test("removeNonContentHtmlRegions entfernt Navigation/Script", () => {
  const html = "<nav>Menü</nav><script>code()</script><p>Inhalt</p>";
  const result = removeNonContentHtmlRegions(html);
  assert.ok(!result.includes("<nav"));
  assert.ok(!result.includes("Menü"));
  assert.ok(!result.includes("code()"));
  assert.ok(result.includes("Inhalt"));
});

test("extractSwissCoordinatesFromText", () => {
  assert.equal(extractSwissCoordinatesFromText("Koordinaten 2660000 / 1240000"), "2660000,1240000");
  assert.equal(extractSwissCoordinatesFromText("keine"), "");
});

test("extractParcelFromText", () => {
  assert.equal(extractParcelFromText("Parzelle Nr. 1376"), "1376");
  assert.equal(extractParcelFromText("ohne"), "");
});

test("extractLabeledValue (bis zum naechsten Label)", () => {
  assert.equal(extractLabeledValue("Standort: Hauptstrasse 15 Bauherr: Muster", "Standort", ["Bauherr"]), "Hauptstrasse 15");
  assert.equal(extractLabeledValue("", "Standort"), "");
});

test("extractAddressFromText (Label + Muster)", () => {
  assert.match(extractAddressFromText("Standort: Bahnhofstrasse 7 Bauherr: Muster"), /Bahnhofstrasse 7/);
  assert.match(extractAddressFromText("Neubau an der Hauptstrasse 12 in Baden"), /Hauptstrasse 12/);
});

test("extractAddressFromPublicationTitle", () => {
  assert.match(extractAddressFromPublicationTitle("Baugesuch / Bahnhofstrasse 7"), /Bahnhofstrasse 7/);
  assert.equal(extractAddressFromPublicationTitle(""), "");
});

test("chooseMoreSpecificAddress bevorzugt Strasse vor Parzelle", () => {
  assert.equal(chooseMoreSpecificAddress("Parzelle 5", "Hauptstrasse 7"), "Hauptstrasse 7");
  assert.equal(chooseMoreSpecificAddress("", "Hauptstrasse 7"), "Hauptstrasse 7");
  assert.equal(chooseMoreSpecificAddress("Hauptstrasse 7", ""), "Hauptstrasse 7");
});

test("formatImportedMunicipalityAddress (Title-Case bei Kleinschreibung)", () => {
  assert.equal(formatImportedMunicipalityAddress("hauptstrasse 15"), "Hauptstrasse 15");
});

test("normalizeImportedMunicipalityAddress", () => {
  assert.equal(normalizeImportedMunicipalityAddress("Hauptstrasse 15"), "Hauptstrasse 15");
  assert.equal(normalizeImportedMunicipalityAddress("", "1376"), "Parzelle 1376");
  assert.equal(normalizeImportedMunicipalityAddress("Baugesuch-Nr 5", "1376"), "Parzelle 1376");
});
