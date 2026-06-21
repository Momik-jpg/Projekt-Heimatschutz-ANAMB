import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeTrustedEmbeddedSource,
  extractEmbeddedMunicipalityFrameCandidates,
  buildMunicipalitySourceReference,
  normalizeMunicipalityResolvedUrl,
  hasExplicitPermitSignal,
  looksLikeGenericSearchResult,
  looksLikeNonPermitMunicipalityContent,
  buildMunicipalityLinkedSourceReference,
  mergePageDefaults,
  looksLikePdfUrl,
  looksLikeListingSourceUrl,
  looksLikeMunicipalityDetailUrl,
  extractHtmlMetadataText
} from "../server/services/applicationsSyncMunicipality.js";

test("looksLikePdfUrl", () => {
  assert.equal(looksLikePdfUrl("https://x.ch/doc.pdf"), true);
  assert.equal(looksLikePdfUrl("https://x.ch/d?file=akte.pdf"), true);
  assert.equal(looksLikePdfUrl("https://x.ch/seite.html"), false);
  assert.equal(looksLikePdfUrl(""), false);
  assert.equal(looksLikePdfUrl("relativ/akte.pdf"), true);
});

test("looksLikeMunicipalityDetailUrl", () => {
  assert.equal(looksLikeMunicipalityDetailUrl("https://x.ch/news/123"), true);
  assert.equal(looksLikeMunicipalityDetailUrl("https://x.ch/baugesuch-2026-1"), true);
  assert.equal(looksLikeMunicipalityDetailUrl("https://x.ch/uebersicht"), false);
  assert.equal(looksLikeMunicipalityDetailUrl("kein url"), false);
});

test("looksLikeListingSourceUrl", () => {
  assert.equal(looksLikeListingSourceUrl("https://x.ch/a", "https://x.ch/a"), true);
  assert.equal(looksLikeListingSourceUrl("https://x.ch/category/bau", "https://x.ch/start"), true);
  assert.equal(looksLikeListingSourceUrl("https://x.ch/detail", "https://x.ch/start"), false);
  assert.equal(looksLikeListingSourceUrl("bad", "bad"), false);
});

test("looksLikeTrustedEmbeddedSource", () => {
  assert.equal(looksLikeTrustedEmbeddedSource("https://x.ch/baugesuche", "https://x.ch/start"), true);
  assert.equal(looksLikeTrustedEmbeddedSource("https://ebau.ag.ch/baugesuche", "https://gemeinde.ch/x"), true);
  assert.equal(looksLikeTrustedEmbeddedSource("https://x.ch/doc.pdf", "https://x.ch/start"), false);
  assert.equal(looksLikeTrustedEmbeddedSource("bad", "bad"), false);
});

test("normalizeMunicipalityResolvedUrl", () => {
  assert.equal(normalizeMunicipalityResolvedUrl("https://x.ch/a#frag"), "https://x.ch/a");
  assert.equal(normalizeMunicipalityResolvedUrl("abc"), "abc");
});

test("hasExplicitPermitSignal", () => {
  assert.equal(hasExplicitPermitSignal("Baugesuch für Neubau"), true);
  assert.equal(hasExplicitPermitSignal("Gemeinderatssitzung"), false);
});

test("looksLikeGenericSearchResult", () => {
  assert.equal(looksLikeGenericSearchResult("https://x.ch/suche", "Suchergebnisse: 5 Treffer"), true);
  assert.equal(looksLikeGenericSearchResult("https://x.ch/news/123", "Suchergebnisse"), false);
});

test("looksLikeNonPermitMunicipalityContent", () => {
  assert.equal(looksLikeNonPermitMunicipalityContent("Mitteilungsblatt der Gemeinde", "https://x.ch/blatt"), true);
  assert.equal(looksLikeNonPermitMunicipalityContent("Neubau Einfamilienhaus", "https://x.ch/bg-2026-1"), false);
  assert.equal(looksLikeNonPermitMunicipalityContent("", "https://x.ch"), false);
});

test("mergePageDefaults", () => {
  assert.deepEqual(mergePageDefaults({ publicationDate: "", deadlineDate: "D" }, { publicationDate: "P" }), {
    publicationDate: "P",
    deadlineDate: "D"
  });
});

test("Source-Reference-Builder erzeugen stabile AUTO-Referenzen", () => {
  const source = { id: "MS-1", municipality: "Baden", sourceUrl: "https://x.ch/liste" };
  assert.match(buildMunicipalitySourceReference(source, "https://x.ch/d", "ctx"), /^AUTO-[0-9A-F]{16}$/);
  assert.match(buildMunicipalityLinkedSourceReference(source, "https://x.ch/detail", "ctx"), /^AUTO-[0-9A-F]{16}$/);
  // resolvedUrl == sourceUrl -> faellt auf die Kontext-Variante zurueck
  assert.match(buildMunicipalityLinkedSourceReference(source, "https://x.ch/liste", "ctx"), /^AUTO-[0-9A-F]{16}$/);
});

test("extractEmbeddedMunicipalityFrameCandidates (srcdoc + vertrauenswuerdiger src)", () => {
  const html =
    '<iframe srcdoc="Inline Baugesuch Inhalt"></iframe><iframe src="https://x.ch/baugesuche"></iframe>';
  const candidates = extractEmbeddedMunicipalityFrameCandidates(html, "https://x.ch/start");
  assert.deepEqual(candidates[0], { inlineHtml: "Inline Baugesuch Inhalt" });
  assert.ok(candidates.some((c) => c.url === "https://x.ch/baugesuche"));
});

test("extractHtmlMetadataText (Title + Meta-Description)", () => {
  const html = '<title>Baugesuch Baden</title><meta name="description" content="Neubau Halle">';
  assert.equal(extractHtmlMetadataText(html), "Baugesuch Baden Neubau Halle");
});
