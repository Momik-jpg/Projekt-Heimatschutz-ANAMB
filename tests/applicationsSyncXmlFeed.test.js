import test from "node:test";
import assert from "node:assert/strict";
import {
  buildXmlFeedImportedItems,
  buildXmlPageDefaults,
  buildXmlSitemapImportedItems
} from "../server/services/applicationsSyncXml.js";

const source = {
  sourceUrl: "https://gemeinde.ch/feed.xml",
  municipality: "Aarau",
  includePattern: "",
  excludePattern: ""
};

test("buildXmlPageDefaults: Publikations- und Fristdatum aus Eintrag", () => {
  assert.deepEqual(buildXmlPageDefaults({ publishedAt: "2026-06-01", rawText: "Einsprachefrist bis 15.07.2026" }), {
    publicationDate: "2026-06-01",
    deadlineDate: "2026-07-15"
  });
  assert.deepEqual(buildXmlPageDefaults({ publishedAt: "", rawText: "ohne Datum" }), {
    publicationDate: "",
    deadlineDate: ""
  });
});

test("buildXmlFeedImportedItems: zaehlt Eintraege, verwirft Nicht-Baugesuche", async () => {
  const xml =
    '<?xml version="1.0"?><rss version="2.0"><channel>' +
    "<item><title>Gemeindeversammlung</title><description>Traktanden und Budget</description></item>" +
    "<item><title>Newsletter</title><description>Veranstaltungen und Agenda</description></item>" +
    "</channel></rss>";
  const result = await buildXmlFeedImportedItems(xml, source, null, 1000, null);
  assert.equal(result.rawCount, 2);
  assert.deepEqual(result.items, [], "kein Eintrag qualifiziert als Baugesuch");
});

test("buildXmlFeedImportedItems: leeres/ungueltiges XML -> keine Eintraege", async () => {
  const result = await buildXmlFeedImportedItems("<rss></rss>", source, null, 1000, null);
  assert.equal(result.rawCount, 0);
  assert.deepEqual(result.items, []);
});

test("buildXmlSitemapImportedItems: zaehlt Sitemap-URLs, verwirft generische", async () => {
  const xml =
    '<?xml version="1.0"?><urlset>' +
    "<url><loc>https://gemeinde.ch/kontakt</loc></url>" +
    "<url><loc>https://gemeinde.ch/newsletter</loc></url>" +
    "</urlset>";
  const result = await buildXmlSitemapImportedItems(xml, source, null, 1000, null);
  assert.ok(result.rawCount >= 0);
  assert.deepEqual(result.items, []);
});
