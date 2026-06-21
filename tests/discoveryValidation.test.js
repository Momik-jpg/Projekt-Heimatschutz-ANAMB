import test from "node:test";
import assert from "node:assert/strict";
import {
  extractHtmlAttributes,
  getRootMunicipalityUrl,
  isSafePublicHttpUrl,
  slugifyForAggregator
} from "../server/services/discovery/discoveryValidation.js";

test("isSafePublicHttpUrl: erlaubt nur oeffentliche http(s)-Hosts", () => {
  assert.equal(isSafePublicHttpUrl("https://www.aarau.ch/baugesuche"), true);
  assert.equal(isSafePublicHttpUrl("http://example.org"), true);
});

test("isSafePublicHttpUrl: weist ungueltige, nicht-http und interne Hosts ab", () => {
  assert.equal(isSafePublicHttpUrl("kein-url"), false);
  assert.equal(isSafePublicHttpUrl(""), false);
  assert.equal(isSafePublicHttpUrl(null), false);
  assert.equal(isSafePublicHttpUrl("ftp://example.org"), false);
  assert.equal(isSafePublicHttpUrl("file:///etc/passwd"), false);
  assert.equal(isSafePublicHttpUrl("http://localhost/x"), false);
  assert.equal(isSafePublicHttpUrl("http://api.localhost/x"), false);
  assert.equal(isSafePublicHttpUrl("http://[::1]/x"), false);
  assert.equal(isSafePublicHttpUrl("http://drucker.local"), false);
  assert.equal(isSafePublicHttpUrl("http://service.internal"), false);
});

test("isSafePublicHttpUrl: blockiert private und reservierte IPv4-Bereiche", () => {
  for (const host of [
    "http://0.0.0.0",
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://172.16.0.1",
    "http://172.31.255.255"
  ]) {
    assert.equal(isSafePublicHttpUrl(host), false, `${host} muss blockiert sein`);
  }
  // Oeffentliche IPv4 ist erlaubt.
  assert.equal(isSafePublicHttpUrl("http://172.32.0.1"), true);
  assert.equal(isSafePublicHttpUrl("http://8.8.8.8"), true);
});

test("getRootMunicipalityUrl: Root-URL oder leer bei ungueltig", () => {
  assert.equal(getRootMunicipalityUrl("https://www.aarau.ch/a/b?c=1"), "https://www.aarau.ch/");
  assert.equal(getRootMunicipalityUrl("kein-url"), "");
});

test("slugifyForAggregator: Diakritika/Klammern weg, kebab-case", () => {
  assert.equal(slugifyForAggregator("Bözen"), "bozen");
  assert.equal(slugifyForAggregator("Hausen (AG)"), "hausen");
  assert.equal(slugifyForAggregator(""), "");
});

test("extractHtmlAttributes: liest Attribute inkl. einfache/doppelte/blanke Quotes", () => {
  const attrs = extractHtmlAttributes(`<a href="/x" data-id='7' rel=search>`);
  assert.equal(attrs.href, "/x");
  assert.equal(attrs["data-id"], "7");
  assert.equal(attrs.rel, "search");
});
