import test from "node:test";
import assert from "node:assert/strict";
import {
  buildXmlPageDefaults,
  buildXmlFeedImportedItems,
  buildXmlSitemapImportedItems,
  buildXmlImportedItems
} from "../server/services/applicationsSyncXml.js";

const source = { sourceUrl: "https://gemeinde.ch/feed", municipality: "Baden", includePattern: "", excludePattern: "" };
const htmlFetch = async () =>
  new Response("<html><body><h1>Startseite</h1><p>Allgemeine Infos ohne relevante Inhalte.</p></body></html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });

test("buildXmlPageDefaults: Publikationsdatum ohne erfundene Frist", () => {
  const defaults = buildXmlPageDefaults({ publishedAt: "2026-01-01", rawText: "Baugesuch Neubau" });
  assert.ok(defaults.publicationDate, "Publikationsdatum aus publishedAt");
  assert.equal(defaults.deadlineDate, "", "ohne amtliche Angabe bleibt die Frist leer");

  const leer = buildXmlPageDefaults({ publishedAt: "", rawText: "" });
  assert.equal(leer.publicationDate, "");
  assert.equal(leer.deadlineDate, "");
});

test("buildXmlFeedImportedItems: leeres XML -> keine Items", async () => {
  const result = await buildXmlFeedImportedItems("", source, htmlFetch, 5000);
  assert.equal(result.rawCount, 0);
  assert.deepEqual(result.items, []);
});

test("buildXmlFeedImportedItems: irrelevante Eintraege werden gefiltert", async () => {
  const feed =
    "<rss><channel><item><title>Startseite</title><link>https://gemeinde.ch/home</link><description>Willkommen</description></item></channel></rss>";
  const result = await buildXmlFeedImportedItems(feed, source, htmlFetch, 5000);
  assert.equal(result.rawCount, 1);
  assert.equal(result.items.length, 0, "kein Baugesuch -> kein Item");
});

test("buildXmlSitemapImportedItems: nicht passende Detailseiten -> keine Items", async () => {
  const sitemap = "<urlset><url><loc>https://gemeinde.ch/d1</loc></url></urlset>";
  const result = await buildXmlSitemapImportedItems(sitemap, { ...source, sourceUrl: "https://gemeinde.ch/sitemap.xml" }, htmlFetch, 5000);
  assert.equal(result.rawCount, 1);
  assert.deepEqual(result.items, []);
});

test("buildXmlImportedItems routet Sitemap vs. Feed", async () => {
  const sitemap = "<urlset><url><loc>https://gemeinde.ch/a</loc></url></urlset>";
  const sitemapResult = await buildXmlImportedItems(sitemap, { ...source, sourceUrl: "https://gemeinde.ch/sitemap.xml" }, htmlFetch, 5000);
  assert.equal(sitemapResult.rawCount, 1, "Sitemap-Pfad: rawCount = URL-Anzahl");

  const feed = "<rss><channel><item><title>X</title><link>https://gemeinde.ch/x</link><description>Y</description></item></channel></rss>";
  const feedResult = await buildXmlImportedItems(feed, source, htmlFetch, 5000);
  assert.equal(feedResult.rawCount, 1, "Feed-Pfad: rawCount = Eintraege");
});
