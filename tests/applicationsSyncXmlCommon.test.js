import test from "node:test";
import assert from "node:assert/strict";
import {
  extractXmlBlocks,
  decodeXmlValue,
  extractXmlTagValue,
  extractXmlAttributeValue,
  resolveXmlUrl,
  extractFeedEntriesFromXml,
  extractSitemapUrlsFromXml,
  resolveSitemapUrls
} from "../server/services/applicationsSyncXmlCommon.js";

test("extractXmlBlocks", () => {
  assert.deepEqual(extractXmlBlocks("<item>A</item><item>B</item>", "item"), ["A", "B"]);
  assert.deepEqual(extractXmlBlocks("", "item"), []);
});

test("decodeXmlValue (CDATA + Entities + Whitespace)", () => {
  assert.equal(decodeXmlValue("<![CDATA[  Neubau &amp;  Umbau ]]>"), "Neubau & Umbau");
  assert.equal(decodeXmlValue(null), "");
});

test("extractXmlTagValue (Fallback-Liste)", () => {
  assert.equal(extractXmlTagValue("<title>T</title>", ["title"]), "T");
  assert.equal(extractXmlTagValue("<summary>S</summary>", ["description", "summary"]), "S");
  assert.equal(extractXmlTagValue("<x>y</x>", ["title"]), "");
});

test("extractXmlAttributeValue (double/single/unquoted)", () => {
  assert.equal(extractXmlAttributeValue('<link href="https://x.ch/a"/>', "link", "href"), "https://x.ch/a");
  assert.equal(extractXmlAttributeValue("<link href='https://y.ch'/>", "link", "href"), "https://y.ch");
  assert.equal(extractXmlAttributeValue("<enclosure url=abc />", "enclosure", "url"), "abc");
});

test("resolveXmlUrl", () => {
  assert.equal(resolveXmlUrl("/pfad", "https://x.ch/basis"), "https://x.ch/pfad");
  assert.equal(resolveXmlUrl("", "https://x.ch"), "");
  assert.equal(resolveXmlUrl("http://[", "https://x.ch"), "");
});

test("extractFeedEntriesFromXml: Atom und RSS", () => {
  const atom = '<feed><entry><title>T1</title><link href="https://x.ch/a"/></entry></feed>';
  const atomEntries = extractFeedEntriesFromXml(atom, "https://x.ch");
  assert.equal(atomEntries.length, 1);
  assert.equal(atomEntries[0].title, "T1");
  assert.equal(atomEntries[0].link, "https://x.ch/a");
  assert.equal(atomEntries[0].id, "xml-entry-0");

  const rss = "<rss><channel><item><title>T2</title><link>https://x.ch/b</link><guid>G2</guid></item></channel></rss>";
  const rssEntries = extractFeedEntriesFromXml(rss, "https://x.ch");
  assert.equal(rssEntries[0].title, "T2");
  assert.equal(rssEntries[0].link, "https://x.ch/b");
  assert.equal(rssEntries[0].id, "G2");
});

test("extractSitemapUrlsFromXml (direkt + verschachtelt, dedupe)", () => {
  const urlset = "<urlset><url><loc>https://x.ch/1</loc></url><url><loc>https://x.ch/1</loc></url></urlset>";
  assert.deepEqual(extractSitemapUrlsFromXml(urlset, "https://x.ch").directUrls, ["https://x.ch/1"]);

  const index = "<sitemapindex><sitemap><loc>https://x.ch/sub.xml</loc></sitemap></sitemapindex>";
  assert.deepEqual(extractSitemapUrlsFromXml(index, "https://x.ch").nestedSitemaps, ["https://x.ch/sub.xml"]);
});

test("resolveSitemapUrls: Tiefenlimit + verschachteltes Laden", async () => {
  const source = { sourceUrl: "https://x.ch/sitemap.xml" };
  const index = "<sitemapindex><sitemap><loc>https://x.ch/sub.xml</loc></sitemap></sitemapindex>";

  // depth>=1: keine weitere Aufloesung, kein Fetch
  const noFetch = () => {
    throw new Error("kein Fetch erwartet");
  };
  assert.deepEqual(await resolveSitemapUrls(index, source, noFetch, 5000, 1), []);

  // depth 0: verschachtelte Sitemap wird geladen
  const mockFetch = async () => new Response("<urlset><url><loc>https://x.ch/deep</loc></url></urlset>", { status: 200 });
  const urls = await resolveSitemapUrls(index, source, mockFetch, 5000);
  assert.deepEqual(urls, ["https://x.ch/deep"]);
});
