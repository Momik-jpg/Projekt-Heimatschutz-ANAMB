import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const servicesDirectory = new URL("../server/services/", import.meta.url);
const parsingBarrel = new URL("applicationsSyncParsing.js", servicesDirectory);

const concernModules = [
  "applicationsSyncAmtsblatt.js",
  "applicationsSyncDiscovery.js",
  "applicationsSyncGeocode.js",
  "applicationsSyncHtml.js",
  "applicationsSyncPdf.js",
  "applicationsSyncSource.js",
  "applicationsSyncXml.js"
];

test("teilt das Baugesuch-Parsing nach Quellenformat und Verantwortung auf", async () => {
  const serviceFiles = new Set(await readdir(servicesDirectory));
  const missingModules = concernModules.filter((file) => !serviceFiles.has(file));

  assert.deepEqual(missingModules, []);

  const barrelSource = await readFile(parsingBarrel, "utf8");
  assert.ok(barrelSource.split(/\r?\n/).length < 40, "Parsing-Einstieg bleibt ein schmales Barrel");

  for (const moduleFile of concernModules) {
    const modulePath = `./${moduleFile.replace(/\.js$/, "")}.js`;
    assert.ok(barrelSource.includes(`export * from "${modulePath}";`));
  }
});
