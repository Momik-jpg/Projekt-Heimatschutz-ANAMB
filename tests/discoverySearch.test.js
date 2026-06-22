import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoverySearchRequestUrl,
  buildDiscoverySearchRequestsFromHtml,
  buildDiscoverySearchRequestsFromOpenSearchLinks,
  buildDiscoverySearchRequestsFromOpenSearchXml,
  buildFallbackDiscoverySearchRequests,
  collectDiscoveryCandidatesFromSiteSearch,
  collectOpenSearchDescriptionUrlsFromHtml
} from "../server/services/discovery/discoverySearch.js";

test("buildDiscoverySearchRequestUrl: GET haengt Query an, POST bleibt unveraendert", () => {
  const body = new URLSearchParams({ q: "Baugesuch" });
  assert.equal(
    buildDiscoverySearchRequestUrl({ url: "https://x.ch/suche", method: "GET", body }),
    "https://x.ch/suche?q=Baugesuch"
  );
  assert.equal(
    buildDiscoverySearchRequestUrl({ url: "https://x.ch/suche?a=1", method: "GET", body }),
    "https://x.ch/suche?a=1&q=Baugesuch"
  );
  assert.equal(
    buildDiscoverySearchRequestUrl({ url: "https://x.ch/suche", method: "POST", body }),
    "https://x.ch/suche"
  );
  assert.equal(
    buildDiscoverySearchRequestUrl({ url: "https://x.ch/suche", method: "GET", body: new URLSearchParams() }),
    "https://x.ch/suche"
  );
});

test("buildDiscoverySearchRequestsFromHtml: erkennt Suchformular, ignoriert formfremde", () => {
  const html = `
    <form action="/suche" method="get">
      <input type="text" name="q" />
      <input type="submit" value="Los" />
    </form>
    <form action="/newsletter" method="post"><input name="email"></form>
  `;
  const requests = buildDiscoverySearchRequestsFromHtml(html, "https://gemeinde.ch/");
  assert.ok(requests.length > 0, "Suchformular erkannt");
  assert.ok(requests.every((r) => r.url === "https://gemeinde.ch/suche"));
  assert.equal(buildDiscoverySearchRequestsFromHtml("<p>kein Formular</p>", "https://gemeinde.ch/").length, 0);
});

test("buildFallbackDiscoverySearchRequests: Pfade x Querynamen x Begriffe", () => {
  const requests = buildFallbackDiscoverySearchRequests("https://gemeinde.ch/");
  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => r.method === "GET" && r.url.startsWith("https://gemeinde.ch/")));
});

test("collectOpenSearchDescriptionUrlsFromHtml: nur gleiche Host-OpenSearch-Links", () => {
  const html =
    '<link rel="search" type="application/opensearchdescription+xml" href="/osd.xml">' +
    '<link rel="search" type="application/opensearchdescription+xml" href="https://fremd.ch/osd.xml">' +
    '<link rel="stylesheet" href="/style.css">';
  const urls = collectOpenSearchDescriptionUrlsFromHtml(html, "https://gemeinde.ch/start");
  assert.deepEqual(urls, ["https://gemeinde.ch/osd.xml"]);
  assert.deepEqual(collectOpenSearchDescriptionUrlsFromHtml(html, "kein-url"), []);
});

test("buildDiscoverySearchRequestsFromOpenSearchXml: HTML-Template mit {searchTerms}", () => {
  const xml =
    '<Url type="text/html" template="https://gemeinde.ch/s?q={searchTerms}"/>' +
    '<Url type="application/json" template="https://gemeinde.ch/api?q={searchTerms}"/>';
  const requests = buildDiscoverySearchRequestsFromOpenSearchXml(xml, "https://gemeinde.ch/osd.xml");
  assert.ok(requests.length > 0, "HTML-Template ergibt Requests");
  assert.ok(requests.every((r) => r.url.startsWith("https://gemeinde.ch/s?q=")));
  assert.deepEqual(buildDiscoverySearchRequestsFromOpenSearchXml(xml, "kein-url"), []);
});

test("buildDiscoverySearchRequestsFromOpenSearchLinks: laedt OSD und baut Requests", async () => {
  const html = '<link rel="search" type="application/opensearchdescription+xml" href="/osd.xml">';
  const osdXml = '<OpenSearchDescription><Url type="text/html" template="https://gemeinde.ch/s?q={searchTerms}"/></OpenSearchDescription>';
  const fetchImpl = async () => new Response(osdXml, { status: 200, headers: { "content-type": "application/xml" } });
  fetchImpl.skipSsrfValidation = true;
  const requests = await buildDiscoverySearchRequestsFromOpenSearchLinks(html, "https://gemeinde.ch/start", fetchImpl, 1000);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => r.url.startsWith("https://gemeinde.ch/s?q=")));
});

test("buildDiscoverySearchRequestsFromOpenSearchLinks: Fehler beim OSD-Laden -> leer", async () => {
  const html = '<link rel="search" type="application/opensearchdescription+xml" href="/osd.xml">';
  const fetchImpl = async () => {
    throw new Error("OSD weg");
  };
  fetchImpl.skipSsrfValidation = true;
  assert.deepEqual(await buildDiscoverySearchRequestsFromOpenSearchLinks(html, "https://gemeinde.ch/start", fetchImpl, 1000), []);
});

test("collectDiscoveryCandidatesFromSiteSearch: sammelt Treffer aus Suchergebnissen", async () => {
  const candidates = new Map();
  const fetchImpl = async () =>
    new Response('<a href="/baugesuche">Baugesuche Publikation</a>', { status: 200, headers: { "content-type": "text/html" } });
  fetchImpl.skipSsrfValidation = true;
  await collectDiscoveryCandidatesFromSiteSearch("https://gemeinde.ch/", fetchImpl, 1000, candidates);
  assert.ok(candidates.size >= 1);

  // Ungueltige Root-URL -> kein Wurf, keine Kandidaten.
  const empty = new Map();
  await collectDiscoveryCandidatesFromSiteSearch("kein-url", fetchImpl, 1000, empty);
  assert.equal(empty.size, 0);
});

test("buildDiscoverySearchRequestsFromHtml: POST, bracketed Feldname und Fallback-Textinput", () => {
  const post = buildDiscoverySearchRequestsFromHtml(
    '<form action="/search" method="post"><input name="tx_kesearch_pi1[sword]" type="text"><input type="submit"></form>',
    "https://gemeinde.ch/"
  );
  assert.ok(post.length > 0);
  assert.ok(post.every((r) => r.method === "POST"));

  const fallback = buildDiscoverySearchRequestsFromHtml(
    '<form action="/suche" method="get"><input name="freitext" type="search"></form>',
    "https://gemeinde.ch/"
  );
  assert.ok(fallback.length > 0, "Textinput dient als Suchfeld-Fallback");

  // Formular ohne benennbares Suchfeld -> keine Requests.
  assert.equal(
    buildDiscoverySearchRequestsFromHtml('<form action="/suche"><input type="checkbox"></form>', "https://gemeinde.ch/").length,
    0
  );
});
