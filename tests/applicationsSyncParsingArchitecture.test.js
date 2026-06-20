import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import * as parsingApi from "../server/services/applicationsSyncParsing.js";

const servicesDirectory = new URL("../server/services/", import.meta.url);
const parsingBarrel = new URL("applicationsSyncParsing.js", servicesDirectory);

const concernModules = [
  "applicationsSyncAddress.js",
  "applicationsSyncAmtsblatt.js",
  "applicationsSyncCommon.js",
  "applicationsSyncDiscovery.js",
  "applicationsSyncGeocode.js",
  "applicationsSyncHtml.js",
  "applicationsSyncMunicipality.js",
  "applicationsSyncPdf.js",
  "applicationsSyncPublication.js",
  "applicationsSyncRefinement.js",
  "applicationsSyncSource.js",
  "applicationsSyncXml.js"
];

// Die oeffentliche API, die der Service vom Barrel konsumiert. Aenderungen hier
// sind bewusst – das Barrel ist die einzige API-Grenze nach aussen.
const EXPECTED_PUBLIC_API = [
  "assessImportedItems",
  "buildAmtsblattItemFromEntry",
  "buildAmtsblattResultUrl",
  "buildSourceLabel",
  "defaultMunicipalitySourceConcurrency",
  "defaultSyncRequestTimeoutMs",
  "extractPdfTextFromBuffer",
  "fetchNormalizedItemsFromSource",
  "geocodeMunicipalityAddressWithPrecision",
  "geocodeMunicipalityParcel",
  "looksLikeJsonSourceUrl",
  "mapWithConcurrency",
  "mergeSyncResults",
  "normalizeImportedPayload",
  "normalizeSourceType",
  "parseAmtsblattEntries",
  "refineImportedItems"
];

test("Baugesuch-Parsing ist nach Verantwortung in Belang-Module geteilt", async () => {
  const serviceFiles = new Set(await readdir(servicesDirectory));
  const missingModules = concernModules.filter((file) => !serviceFiles.has(file));
  assert.deepEqual(missingModules, [], "alle Belang-Module muessen existieren");
});

test("das Barrel ist eine schmale, explizite API-Grenze (kein export *)", async () => {
  const barrelSource = await readFile(parsingBarrel, "utf8");
  assert.ok(barrelSource.split(/\r?\n/).length < 40, "Barrel bleibt schlank");
  assert.ok(!/^\s*export\s+\*/m.test(barrelSource), "kein `export *`-Statement – Internals bleiben gekapselt");
});

test("das Barrel exportiert genau die vereinbarte oeffentliche API", () => {
  const actual = Object.keys(parsingApi).sort();
  assert.deepEqual(actual, EXPECTED_PUBLIC_API, "oeffentliche API-Oberflaeche unveraendert halten");
});
