import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImportedProjectType } from "../server/services/applicationsSyncPublication.js";
import { extractAddressFromText } from "../server/services/applicationsSyncAddress.js";
import { cleanImportedAddress } from "../server/domain/applicationImportNormalization.js";

// Phase C: die 3 vom Audit gemeldeten ReDoS-Kandidaten duerfen auf adversarialen
// Eingaben nicht katastrophal backtracken. Schwelle grosszuegig (alte Regex haetten
// Sekunden bis Minuten gebraucht).
const LIMIT_MS = 500;

function elapsed(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

test("garbledProjectTypePattern terminiert schnell", () => {
  const adversarial = `12${"_".repeat(60)}x`;
  assert.ok(elapsed(() => normalizeImportedProjectType(adversarial)) < LIMIT_MS);
});

test("Adress-Strassenmuster terminiert schnell", () => {
  const adversarial = `${"Aa ".repeat(50)}x`;
  assert.ok(elapsed(() => extractAddressFromText(adversarial)) < LIMIT_MS);
});

test("cleanImportedAddress box-Muster terminiert schnell", () => {
  const adversarial = `Bahnhofstrasse 1 box ${"box-x ".repeat(80)}`;
  assert.ok(elapsed(() => cleanImportedAddress(adversarial)) < LIMIT_MS);
});

test("valide Eingaben bleiben unveraendert (Verhaltensgleichheit)", () => {
  assert.equal(normalizeImportedProjectType("12.34.56"), "", "Ziffern-Müll bleibt als garbled erkannt");
  assert.equal(normalizeImportedProjectType("Neubau Einfamilienhaus"), "Neubau Einfamilienhaus");
  assert.match(extractAddressFromText("Standort: Bahnhofstrasse 7 Bauherr: Muster"), /Bahnhofstrasse 7/);
  assert.match(extractAddressFromText("Neubau an der Bahnhofstrasse Nord 7"), /Bahnhofstrasse Nord 7/);
});
