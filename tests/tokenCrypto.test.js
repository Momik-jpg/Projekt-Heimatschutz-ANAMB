import test from "node:test";
import assert from "node:assert/strict";

// S5: Quell-Token-Verschlüsselung (AES-256-GCM). Schlüssel vor dem Import setzen.
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key-32bytes-minimum!!";
const { encryptToken, decryptToken, isTokenSet } = await import("../server/services/tokenCrypto.js");

test("encrypt/decrypt ist ein verlustfreier Round-trip", () => {
  const secret = "geheimes-api-token-12345";
  const stored = encryptToken(secret);
  assert.notEqual(stored, secret, "gespeicherter Wert darf nicht der Klartext sein");
  assert.ok(stored.startsWith("gcm:"), "Ciphertext-Praefix erwartet");
  assert.equal(decryptToken(stored), secret);
});

test("zwei Verschlüsselungen desselben Werts unterscheiden sich (IV)", () => {
  const a = encryptToken("gleich");
  const b = encryptToken("gleich");
  assert.notEqual(a, b);
  assert.equal(decryptToken(a), "gleich");
  assert.equal(decryptToken(b), "gleich");
});

test("Legacy-Klartext wird beim Entschlüsseln durchgereicht", () => {
  assert.equal(decryptToken("alter-klartext-token"), "alter-klartext-token");
});

test("leere Werte bleiben leer", () => {
  assert.equal(encryptToken(""), "");
  assert.equal(decryptToken(""), "");
  assert.equal(isTokenSet(""), false);
  assert.equal(isTokenSet("x"), true);
});

test("manipulierter Ciphertext entschlüsselt nicht (Auth-Tag)", () => {
  const stored = encryptToken("integritaet");
  const tampered = `${stored.slice(0, -4)}AAAA`;
  assert.equal(decryptToken(tampered), "");
});
