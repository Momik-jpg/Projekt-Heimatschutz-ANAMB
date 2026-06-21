import test from "node:test";
import assert from "node:assert/strict";
import {
  isArcGisServiceUrl,
  looksLikeXmlSourceUrl,
  looksLikeJsonSourceUrl,
  withOptionalTokenHeaders,
  finalizeArcGisQueryUrl,
  resolveArcGisQueryUrl,
  collapseRepeatedLeadingPathSegments,
  resolveHttpUrlReference,
  mapWithConcurrency
} from "../server/services/applicationsSyncNet.js";

test("isArcGisServiceUrl", () => {
  assert.equal(isArcGisServiceUrl("https://x.ch/rest/MapServer"), true);
  assert.equal(isArcGisServiceUrl("https://x.ch/rest/FeatureServer/0/query"), true);
  assert.equal(isArcGisServiceUrl("https://x.ch/seite"), false);
  assert.equal(isArcGisServiceUrl("kein url"), false);
});

test("looksLikeXmlSourceUrl", () => {
  assert.equal(looksLikeXmlSourceUrl(""), false);
  assert.equal(looksLikeXmlSourceUrl("https://x.ch/rest/MapServer"), false); // ArcGIS schliesst aus
  assert.equal(looksLikeXmlSourceUrl("https://x.ch/feed.xml"), true);
  assert.equal(looksLikeXmlSourceUrl("https://x.ch/rss"), true);
  assert.equal(looksLikeXmlSourceUrl("https://x.ch/seite.html"), false);
  assert.equal(looksLikeXmlSourceUrl("feed.xml"), true); // catch-Zweig (keine echte URL)
});

test("looksLikeJsonSourceUrl", () => {
  assert.equal(looksLikeJsonSourceUrl("https://x.ch/data.json"), true);
  assert.equal(looksLikeJsonSourceUrl("https://x.ch/api/items"), true);
  assert.equal(looksLikeJsonSourceUrl("https://x.ch/rest/MapServer"), false);
  assert.equal(looksLikeJsonSourceUrl("https://x.ch/feed.xml"), false);
  assert.equal(looksLikeJsonSourceUrl("https://x.ch/seite"), false);
  assert.equal(looksLikeJsonSourceUrl(""), false);
});

test("withOptionalTokenHeaders", () => {
  assert.deepEqual(withOptionalTokenHeaders({ Accept: "x" }, ""), { Accept: "x" });
  assert.deepEqual(withOptionalTokenHeaders({ Accept: "x" }, "T"), { Accept: "x", Authorization: "Bearer T" });
});

test("finalizeArcGisQueryUrl setzt Default-Query-Parameter", () => {
  const url = new URL(finalizeArcGisQueryUrl("https://x.ch/MapServer/0/query", "TKN"));
  assert.equal(url.searchParams.get("where"), "1=1");
  assert.equal(url.searchParams.get("outFields"), "*");
  assert.equal(url.searchParams.get("returnGeometry"), "true");
  assert.equal(url.searchParams.get("f"), "json");
  assert.equal(url.searchParams.get("token"), "TKN");

  const preset = new URL(finalizeArcGisQueryUrl("https://x.ch/MapServer/0/query?where=OBJECTID>5", ""));
  assert.equal(preset.searchParams.get("where"), "OBJECTID>5");
  assert.equal(preset.searchParams.has("token"), false);
});

test("resolveArcGisQueryUrl deckt die Pfadformen ab", async () => {
  const noFetch = () => {
    throw new Error("sollte nicht aufgerufen werden");
  };
  assert.match(await resolveArcGisQueryUrl("https://x.ch/MapServer/0/query", "", noFetch), /\/MapServer\/0\/query\?/);
  assert.match(await resolveArcGisQueryUrl("https://x.ch/MapServer/0", "", noFetch), /\/MapServer\/0\/query\?/);
  assert.equal(await resolveArcGisQueryUrl("https://x.ch/seite", "", noFetch), "https://x.ch/seite");

  const metaFetch = async () => ({ ok: true, json: async () => ({ layers: [{ id: 3 }] }) });
  assert.match(await resolveArcGisQueryUrl("https://x.ch/MapServer", "", metaFetch), /\/MapServer\/3\/query\?/);

  const failFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => resolveArcGisQueryUrl("https://x.ch/MapServer", "", failFetch), /Metadaten/);

  const errPayloadFetch = async () => ({ ok: true, json: async () => ({ error: { message: "kaputt" } }) });
  await assert.rejects(() => resolveArcGisQueryUrl("https://x.ch/MapServer", "", errPayloadFetch), /kaputt/);
});

test("collapseRepeatedLeadingPathSegments", () => {
  assert.equal(collapseRepeatedLeadingPathSegments("/a/b/a/b/c"), "/a/b/c");
  assert.equal(collapseRepeatedLeadingPathSegments("/a/b/c"), "/a/b/c");
  assert.equal(collapseRepeatedLeadingPathSegments("/a/b/a/b/"), "/a/b/"); // Trailing-Slash bleibt
});

test("resolveHttpUrlReference", () => {
  assert.equal(resolveHttpUrlReference("", "https://x.ch"), null);
  assert.equal(resolveHttpUrlReference("#frag", "https://x.ch"), null);
  assert.equal(resolveHttpUrlReference("mailto:a@b.ch", "https://x.ch"), null);
  const resolved = resolveHttpUrlReference("/pfad", "https://x.ch/basis");
  assert.equal(resolved.href, "https://x.ch/pfad");
});

test("mapWithConcurrency erhaelt Reihenfolge", async () => {
  const out = await mapWithConcurrency([1, 2, 3, 4], async (n) => n * 2, 2);
  assert.deepEqual(out, [2, 4, 6, 8]);
  assert.deepEqual(await mapWithConcurrency([], async (n) => n, 3), []);
});
