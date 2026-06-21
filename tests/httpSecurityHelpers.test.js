import test from "node:test";
import assert from "node:assert/strict";
import {
  appendVaryHeader,
  createCsrfOriginGuard,
  getRequestHosts,
  isCompressibleContentType,
  isSecureRequest,
  setStaticAssetHeaders
} from "../server/httpSecurity.js";

function mockResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: null,
    setHeader(key, value) {
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(key.toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test("isSecureRequest: secure-Flag oder x-forwarded-proto", () => {
  assert.equal(isSecureRequest({ secure: true, headers: {} }), true);
  assert.equal(isSecureRequest({ secure: false, headers: { "x-forwarded-proto": "https" } }), true);
  assert.equal(isSecureRequest({ secure: false, headers: {} }), false);
});

test("getRequestHosts: host + x-forwarded-host", () => {
  const hosts = getRequestHosts({ headers: { host: "App.CH", "x-forwarded-host": "proxy.ch, edge.ch" } });
  assert.ok(hosts.has("app.ch"));
  assert.ok(hosts.has("proxy.ch"));
  assert.ok(hosts.has("edge.ch"));
  assert.equal(getRequestHosts({ headers: {} }).size, 0);
});

test("createCsrfOriginGuard: GET durch, gleiche Herkunft durch, fremde/ungueltige blockiert", () => {
  const guard = createCsrfOriginGuard({ enabled: true });

  let nexted = 0;
  const next = () => {
    nexted += 1;
  };

  // GET -> immer durch
  guard({ method: "GET", headers: {} }, mockResponse(), next);
  // POST ohne Origin/Referer -> durch (Server-zu-Server)
  guard({ method: "POST", headers: {} }, mockResponse(), next);
  // POST gleiche Herkunft -> durch
  guard({ method: "POST", headers: { origin: "https://app.ch", host: "app.ch" } }, mockResponse(), next);
  assert.equal(nexted, 3);

  // POST fremde Herkunft -> 403
  const foreign = mockResponse();
  guard({ method: "POST", headers: { origin: "https://evil.ch", host: "app.ch" } }, foreign, next);
  assert.equal(foreign.statusCode, 403);

  // POST ungueltige Origin -> 403
  const invalid = mockResponse();
  guard({ method: "POST", headers: { origin: "kein-url", host: "app.ch" } }, invalid, next);
  assert.equal(invalid.statusCode, 403);

  // deaktiviert -> durch
  let disabledNext = 0;
  createCsrfOriginGuard({ enabled: false })({ method: "POST", headers: { origin: "https://evil.ch" } }, mockResponse(), () => {
    disabledNext += 1;
  });
  assert.equal(disabledNext, 1);
});

test("setStaticAssetHeaders: Cache-Control je Dateityp", () => {
  const cacheFor = (file) => {
    const response = mockResponse();
    setStaticAssetHeaders(response, file);
    return response.getHeader("Cache-Control");
  };
  assert.equal(cacheFor("/index.html"), "no-store");
  assert.equal(cacheFor("/js/core.js"), "no-cache");
  assert.equal(cacheFor("/css/base.css"), "no-cache");
  assert.equal(cacheFor("/img/wappen.png"), "public, max-age=86400");
  assert.equal(cacheFor("/fonts/x.woff2"), "public, max-age=31536000, immutable");
  assert.equal(cacheFor("/data.bin"), undefined);
});

test("isCompressibleContentType", () => {
  assert.equal(isCompressibleContentType("text/html; charset=utf-8"), true);
  assert.equal(isCompressibleContentType("application/json"), true);
  assert.equal(isCompressibleContentType("image/svg+xml"), true);
  assert.equal(isCompressibleContentType("image/png"), false);
  assert.equal(isCompressibleContentType(""), false);
});

test("appendVaryHeader: setzen, anhaengen, Duplikate/Wildcard ueberspringen", () => {
  const fresh = mockResponse();
  appendVaryHeader(fresh, "Accept-Encoding");
  assert.equal(fresh.getHeader("Vary"), "Accept-Encoding");

  const existing = mockResponse();
  existing.setHeader("Vary", "Origin");
  appendVaryHeader(existing, "Accept-Encoding");
  assert.equal(existing.getHeader("Vary"), "Origin, Accept-Encoding");

  appendVaryHeader(existing, "accept-encoding");
  assert.equal(existing.getHeader("Vary"), "Origin, Accept-Encoding", "kein Duplikat");

  const wildcard = mockResponse();
  wildcard.setHeader("Vary", "*");
  appendVaryHeader(wildcard, "Accept-Encoding");
  assert.equal(wildcard.getHeader("Vary"), "*");
});
