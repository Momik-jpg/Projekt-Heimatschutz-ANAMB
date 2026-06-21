import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, scryptSync } from "node:crypto";

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

test("zu kurzer GCM-Auth-Tag wird verworfen", () => {
  const stored = encryptToken("integritaet");
  const [iv, tag, ciphertext] = stored.slice("gcm:".length).split(":");
  const shortTag = Buffer.from(tag, "base64").subarray(0, 15).toString("base64");
  assert.equal(decryptToken(`gcm:${iv}:${shortTag}:${ciphertext}`), "");
});

test("zu kurzer GCM-IV wird verworfen", () => {
  const key = scryptSync(process.env.TOKEN_ENCRYPTION_KEY, "heimatschutz-token-v1", 32);
  const iv = Buffer.alloc(11, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("integritaet", "utf8"), cipher.final()]);
  const stored = `gcm:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
  assert.equal(decryptToken(stored), "");
});
