import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeForLog } from "../server/logSafe.js";

// S7: Log-Injection-Schutz. Steuerzeichen werden via fromCharCode gebaut, um
// literale Steuerzeichen im Quelltext zu vermeiden.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

function hasControlChar(text) {
  return [...text].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

test("entfernt Zeilenumbrueche (verhindert gefaelschte Logzeilen)", () => {
  const forged = "BG-1" + LF + "INFO: Admin-Login erfolgreich von 10.0.0.1";
  const safe = sanitizeForLog(forged);
  assert.equal(hasControlChar(safe), false, "keine Steuerzeichen im Ergebnis");
  assert.ok(safe.includes("BG-1"));
  assert.ok(safe.includes("Admin-Login"));
});

test("entfernt CR/LF/TAB und Steuerzeichen", () => {
  const safe = sanitizeForLog("a" + CR + LF + "b" + TAB + "c d");
  assert.equal(safe, "a b c d");
  assert.equal(hasControlChar(safe), false);
});

test("begrenzt die Laenge", () => {
  const safe = sanitizeForLog("x".repeat(500), 50);
  assert.ok(safe.length <= 51, "auf maxLength (+ Ellipse) begrenzt");
});

test("leere/undefinierte Werte sind sicher", () => {
  assert.equal(sanitizeForLog(undefined), "");
  assert.equal(sanitizeForLog(null), "");
  assert.equal(sanitizeForLog(""), "");
});
