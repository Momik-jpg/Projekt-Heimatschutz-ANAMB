import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Minimaler TOTP-Helfer (RFC 6238, HMAC-SHA1, 6 Stellen, 30s) ohne externe
// Abhängigkeit. Kompatibel mit gängigen Authenticator-Apps (Google Authenticator,
// Microsoft Authenticator, Aegis usw.).

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += base32Alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(input) {
  const cleaned = String(input ?? "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of cleaned) {
    const index = base32Alphabet.indexOf(char);

    if (index === -1) {
      continue;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(byteLength = 20) {
  return encodeBase32(randomBytes(byteLength));
}

function hotp(secretBuffer, counter, digits = 6) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function generateTotp(secret, { timeStepSeconds = 30, digits = 6, now = Date.now() } = {}) {
  const counter = Math.floor(now / 1000 / timeStepSeconds);
  return hotp(decodeBase32(secret), counter, digits);
}

// Prüft den Code in einem Toleranzfenster (Standard: +/- 1 Zeitschritt) gegen
// Uhren-Drift. Vergleich konstant-zeitlich.
export function verifyTotp(secret, token, { timeStepSeconds = 30, digits = 6, window = 1, now = Date.now() } = {}) {
  const normalizedToken = String(token ?? "").trim();

  if (!/^\d{6}$/.test(normalizedToken)) {
    return false;
  }

  const secretBuffer = decodeBase32(secret);
  const counter = Math.floor(now / 1000 / timeStepSeconds);
  const tokenBuffer = Buffer.from(normalizedToken);

  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = hotp(secretBuffer, counter + offset, digits);
    const candidateBuffer = Buffer.from(candidate);

    if (candidateBuffer.length === tokenBuffer.length && timingSafeEqual(candidateBuffer, tokenBuffer)) {
      return true;
    }
  }

  return false;
}

export function buildOtpauthUri({ secret, account = "master", issuer = "Heimatschutz Aargau" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}
