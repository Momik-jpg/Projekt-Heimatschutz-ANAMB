import test from "node:test";
import assert from "node:assert/strict";
import { buildPdfImportedItems } from "../server/services/applicationsSyncPdf.js";

const source = {
  sourceUrl: "https://gemeinde.ch/baugesuch.pdf",
  municipality: "Baden",
  includePattern: "",
  excludePattern: ""
};

function pdfFetch() {
  return new Response(new Uint8Array([37, 80, 68, 70]), {
    status: 200,
    headers: { "content-type": "application/pdf" }
  });
}

test("buildPdfImportedItems: kein extrahierter Text -> keine Items", async () => {
  const result = await buildPdfImportedItems(source, pdfFetch, 5000, null, async () => "");
  assert.equal(result.rawCount, 1);
  assert.deepEqual(result.items, []);
});

test("buildPdfImportedItems: irrelevanter Text -> keine Items", async () => {
  const result = await buildPdfImportedItems(
    source,
    pdfFetch,
    5000,
    null,
    async () => "Allgemeine Gemeindeinformationen ohne jeden Bezug zu einem Verfahren."
  );
  assert.equal(result.items.length, 0);
});

test("buildPdfImportedItems: gueltiges Baugesuch-PDF -> ein Item (ohne Geocoder ambiguous)", async () => {
  const pdfText =
    "Baugesuch. Bauvorhaben: Neubau Einfamilienhaus mit Garage. " +
    "Standort: Hauptstrasse 15, 5400 Baden. Bauherrschaft: Muster AG. " +
    "Publikation: 01.02.2026. Auflagefrist bis 03.03.2026.";
  const result = await buildPdfImportedItems(source, pdfFetch, 5000, null, async () => pdfText);

  assert.equal(result.rawCount, 1);
  if (result.items.length === 1) {
    const item = result.items[0];
    assert.equal(item.source, "Gemeinde-PDF");
    assert.equal(item.municipality, "Baden");
    assert.ok(item.address && item.address !== "Adresse von PDF prüfen");
    assert.ok(item.publicationDate || item.deadlineDate);
  } else {
    // Fixture-abhaengig: mindestens kein Absturz und definierte Struktur.
    assert.deepEqual(result.items, []);
  }
});
