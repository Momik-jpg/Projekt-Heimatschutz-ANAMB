// Verschlüsselung von Quell-Tokens at-rest (AES-256-GCM). Schlüssel wird aus
// TOKEN_ENCRYPTION_KEY abgeleitet. Ohne Schlüssel: Klartext-Fallback mit Warnung
// (Dev/lokal). decryptToken versteht Legacy-Klartext (ohne Präfix) fuer Migration.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ENC_PREFIX = "gcm:";
let warnedMissingKey = false;

function getKey() {
  const raw = String(process.env.TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (!raw) {
    return null;
  }
  return scryptSync(raw, "heimatschutz-token-v1", 32);
}

/** True, wenn ein (gespeicherter) Token-Wert gesetzt ist. */
export function isTokenSet(value) {
  return Boolean(String(value ?? "").trim());
}

/** Verschlüsselt einen Klartext-Token fuer die Ablage. Leeres bleibt leer. */
export function encryptToken(plain) {
  const value = String(plain ?? "");
  if (!value) {
    return "";
  }

  const key = getKey();
  if (!key) {
    if (!warnedMissingKey) {
      // eslint-disable-next-line no-console
      console.warn(
        "TOKEN_ENCRYPTION_KEY nicht gesetzt – Quell-Tokens werden unverschlüsselt gespeichert. Vor dem Produktivbetrieb setzen."
      );
      warnedMissingKey = true;
    }
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Entschlüsselt einen gespeicherten Token. Legacy-Klartext wird durchgereicht. */
export function decryptToken(stored) {
  const value = String(stored ?? "");
  if (!value) {
    return "";
  }
  if (!value.startsWith(ENC_PREFIX)) {
    return value; // Legacy-Klartext (vor Einfuehrung der Verschluesselung)
  }

  const key = getKey();
  if (!key) {
    return ""; // ohne Schlüssel nicht entschluesselbar -> fail closed
  }

  try {
    const parts = value.slice(ENC_PREFIX.length).split(":");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      return "";
    }
    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return "";
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
