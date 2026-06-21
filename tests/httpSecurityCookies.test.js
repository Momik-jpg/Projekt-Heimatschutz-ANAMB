import assert from "node:assert/strict";
import test from "node:test";
import { parseCookies } from "../server/httpSecurity.js";

test("Cookie-Parser liefert eine Map und erlaubt keine Objekt-Property-Injection", () => {
  const cookies = parseCookies("session=abc%20123; __proto__=polluted; malformed=%E0%A4%A");

  assert.equal(cookies instanceof Map, true);
  assert.equal(cookies.get("session"), "abc 123");
  assert.equal(cookies.get("__proto__"), "polluted");
  assert.equal(cookies.has("malformed"), false);
  assert.equal({}.polluted, undefined);
});
