import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoverySearchRequestUrl,
  buildDiscoverySearchRequestsFromHtml,
  buildDiscoverySearchRequestsFromOpenSearchXml,
  buildFallbackDiscoverySearchRequests,
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
