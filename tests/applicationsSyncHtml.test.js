import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStructuredPublicationImportedItems,
  buildTabularImportedItems,
  cleanTabularProjectText,
  extractStructuredPublicationBlocks,
  extractStructuredPublicationField,
  extractStructuredPublicationHref,
  looksLikePublicationTable,
  structuredPublicationLabelSource
} from "../server/services/applicationsSyncHtml.js";

const source = {
  sourceUrl: "https://gemeinde.ch/baugesuche",
  municipality: "Aarau",
  includePattern: "",
  excludePattern: ""
};

const tableHtml = `<table>
<tr><th>Baugesuch Nr</th><th>Bauherrschaft</th><th>Bauvorhaben</th><th>Auflage</th></tr>
<tr><td>2026-1</td><td>Hans Muster</td><td>Neubau Einfamilienhaus, Hauptstrasse 12</td><td>vom 15. Juni bis 15. Juli 2026</td></tr>
</table>`;

const structuredHtml =
  "<div>" +
  "<p><strong>Bauherrschaft</strong> Hans Muster</p>" +
  "<p><strong>Bauobjekt</strong> Neubau Einfamilienhaus</p>" +
  '<p><strong>Bauplatz</strong> Hauptstrasse 12, Aarau <a href="/detail/1">Details</a></p>' +
  "<p>Auflage vom 15. Juni bis 15. Juli 2026</p>" +
  "</div>";

test("looksLikePublicationTable erkennt Publikations-Kopfzeilen", () => {
  assert.equal(looksLikePublicationTable([["Baugesuch Nr", "Bauherrschaft", "Auflage"]]), true);
  assert.equal(looksLikePublicationTable([["Name", "Datum", "Link"]]), false);
  assert.equal(looksLikePublicationTable([]), false);
});

test("cleanTabularProjectText entfernt Bauherrschaft/Parzelle/PLZ-Ort", () => {
  const cleaned = cleanTabularProjectText(
    "Neubau Einfamilienhaus, Hauptstrasse 12 Bauherrschaft Hans Muster Parz. 123 5000 Aarau",
    "Hauptstrasse 12"
  );
  assert.ok(/Neubau Einfamilienhaus/.test(cleaned));
  assert.ok(!/Bauherrschaft/.test(cleaned));
  assert.ok(!/Parz/.test(cleaned));
});

test("buildTabularImportedItems: Publikationstabelle ohne Geocoding -> manual-review", async () => {
  const items = await buildTabularImportedItems(tableHtml, source, 1000, null, new Map());
  assert.equal(items.length, 1);
  assert.equal(items[0].address, "Hauptstrasse 12");
  assert.equal(items[0].projectType, "Neubau Einfamilienhaus");
  assert.equal(items[0].protectionStatus, "manual-review");
  assert.equal(items[0].ambiguousAddress, 1);
});

test("buildTabularImportedItems: Nicht-Publikationstabelle -> leer", async () => {
  const html = "<table><tr><th>Name</th><th>Datum</th><th>Link</th></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>";
  assert.deepEqual(await buildTabularImportedItems(html, source, 1000, null, new Map()), []);
});

test("structuredPublicationLabelSource enthaelt die Labels", () => {
  const src = structuredPublicationLabelSource(["Bauherrschaft", "Bauherr"]);
  assert.ok(src.includes("Bauherrschaft"));
  assert.ok(src.includes("Bauherr"));
});

test("extractStructuredPublication* liest Bloecke, Felder und Links", () => {
  const blocks = extractStructuredPublicationBlocks(structuredHtml);
  assert.equal(blocks.length, 1);
  assert.equal(extractStructuredPublicationField(blocks[0], "object"), "Neubau Einfamilienhaus");
  assert.match(extractStructuredPublicationField(blocks[0], "place"), /Hauptstrasse 12/);
  assert.equal(extractStructuredPublicationHref(blocks[0], source.sourceUrl), "https://gemeinde.ch/detail/1");
  assert.equal(extractStructuredPublicationHref("<p>ohne Link</p>", source.sourceUrl), "");
  // Fehlende Label-Gruppe -> keine Bloecke.
  assert.deepEqual(extractStructuredPublicationBlocks("<p>Nur Text ohne Labels</p>"), []);
});

test("buildStructuredPublicationImportedItems: Block ohne Geocoding -> manual-review", async () => {
  const items = await buildStructuredPublicationImportedItems(structuredHtml, source, 1000, null, new Map(), {
    publicationDate: "",
    deadlineDate: ""
  });
  assert.equal(items.length, 1);
  assert.match(items[0].address, /Hauptstrasse 12/);
  assert.equal(items[0].projectType, "Neubau Einfamilienhaus");
  assert.equal(items[0].protectionStatus, "manual-review");
  assert.equal(items[0].sourceUrl, "https://gemeinde.ch/detail/1");
});

function geocodeMock() {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ results: [{ attrs: { label: "Hauptstrasse 12 5000 Aarau", x: 2645000, y: 1249000, origin: "address" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  fetchImpl.skipSsrfValidation = true;
  return fetchImpl;
}

test("buildTabularImportedItems: mit Geocoding -> no-hit und Koordinaten", async () => {
  const items = await buildTabularImportedItems(tableHtml, source, 1000, geocodeMock(), new Map());
  assert.equal(items.length, 1);
  assert.equal(items[0].coordinates, "2645000,1249000");
  assert.equal(items[0].protectionStatus, "no-hit");
  assert.equal(items[0].ambiguousAddress, 0);
});

test("buildStructuredPublicationImportedItems: mit Geocoding -> no-hit", async () => {
  const items = await buildStructuredPublicationImportedItems(structuredHtml, source, 1000, geocodeMock(), new Map(), {
    publicationDate: "",
    deadlineDate: ""
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].coordinates, "2645000,1249000");
  assert.equal(items[0].protectionStatus, "no-hit");
});

test("buildStructuredPublicationImportedItems: excludePattern und includePattern", async () => {
  const excluded = await buildStructuredPublicationImportedItems(
    structuredHtml,
    { ...source, excludePattern: "Neubau" },
    1000,
    null,
    new Map(),
    { publicationDate: "", deadlineDate: "" }
  );
  assert.deepEqual(excluded, [], "excludePattern verwirft den Block");

  const notIncluded = await buildStructuredPublicationImportedItems(
    structuredHtml,
    { ...source, includePattern: "Spezialfall" },
    1000,
    null,
    new Map(),
    { publicationDate: "", deadlineDate: "" }
  );
  assert.deepEqual(notIncluded, [], "includePattern ohne Treffer verwirft den Block");
});
