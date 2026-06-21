import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWhitespace,
  normalizeSourcePatternText,
  createSourcePatternMatcher,
  looksLikeStandaloneDate,
  decodeHtmlEntities,
  stripHtml,
  extractAttributeValue,
  collectStructuredMetadataSnippets,
  extractStructuredMetadataText
} from "../server/services/applicationsSyncText.js";

test("normalizeWhitespace / normalizeSourcePatternText", () => {
  assert.equal(normalizeWhitespace("  a   b\n c "), "a b c");
  assert.equal(normalizeWhitespace(null), "");
  assert.equal(normalizeSourcePatternText("  Baden  AG "), "baden ag");
});

test("createSourcePatternMatcher", () => {
  assert.equal(createSourcePatternMatcher(""), null);
  assert.equal(createSourcePatternMatcher("  |  "), null);
  const matcher = createSourcePatternMatcher("baden|aarau");
  assert.equal(matcher("Stadt Baden"), true);
  assert.equal(matcher("Gemeinde Zürich"), false);
  assert.equal(matcher(""), false);
});

test("looksLikeStandaloneDate", () => {
  assert.equal(looksLikeStandaloneDate("01.02.2026"), true);
  assert.equal(looksLikeStandaloneDate("2026-01-01"), true);
  assert.equal(looksLikeStandaloneDate("2026"), true);
  assert.equal(looksLikeStandaloneDate("kein datum"), false);
  assert.equal(looksLikeStandaloneDate(""), false);
});

test("decodeHtmlEntities deckt benannte, numerische und &amp; ab", () => {
  assert.equal(decodeHtmlEntities("a&nbsp;b"), "a b");
  assert.equal(decodeHtmlEntities("&uuml;ber"), "über");
  assert.equal(decodeHtmlEntities("&quot;x&quot;"), '"x"');
  assert.equal(decodeHtmlEntities("&#65;"), "A");
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  // &amp; wird zuletzt ersetzt -> doppelt kodiertes &nbsp; bleibt sichtbar
  assert.equal(decodeHtmlEntities("&amp;nbsp;"), "&nbsp;");
});

test("stripHtml entfernt script/style/br/tags", () => {
  assert.equal(stripHtml("<script>böse()</script><b>Hallo</b>"), "Hallo");
  assert.equal(stripHtml("<style>.x{}</style>Text"), "Text");
  assert.equal(stripHtml("A<br>B"), "A B");
  assert.equal(stripHtml(""), "");
});

test("extractAttributeValue (double/single/unquoted)", () => {
  assert.equal(extractAttributeValue('<a href="https://x.ch">', "href"), "https://x.ch");
  assert.equal(extractAttributeValue("<a href='https://y.ch'>", "href"), "https://y.ch");
  assert.equal(extractAttributeValue("<a id=abc>", "id"), "abc");
  assert.equal(extractAttributeValue("<a>", "href"), "");
});

test("collectStructuredMetadataSnippets", () => {
  assert.deepEqual(collectStructuredMetadataSnippets({ description: "Neubau" }), ["Neubau"]);
  assert.deepEqual(collectStructuredMetadataSnippets({ foo: "bar" }), []);
  assert.deepEqual(collectStructuredMetadataSnippets({ description: "https://x.ch" }), [], "URLs werden ausgelassen");
  assert.deepEqual(collectStructuredMetadataSnippets([{ name: "A" }, { name: "B" }]), ["A", "B"]);
});

test("extractStructuredMetadataText: JSON-LD + itemprop", () => {
  const jsonLd = '<script type="application/ld+json">{"description":"Neubau Halle"}</script>';
  assert.equal(extractStructuredMetadataText(jsonLd), "Neubau Halle");

  const meta = '<meta itemprop="datePublished" content="2026-01-01">';
  assert.equal(extractStructuredMetadataText(meta), "2026-01-01");

  // defekter JSON-LD-Block wird ignoriert, kein Wurf
  assert.equal(extractStructuredMetadataText('<script type="application/ld+json">{kaputt</script>'), "");
});
