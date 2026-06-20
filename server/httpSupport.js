// HTTP-, Validierungs- und Sicherheits-Helfer für den Express-Server.
// Aus server/app.js extrahiert (reine Funktionen ohne createApp-Closure-Bezug),
// damit app.js auf die Komposition der Anwendung fokussiert bleibt.
import { randomBytes } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  municipalityDigitalStatuses,
  municipalitySourceTypes
} from "./repository/municipalitySourcesRepository.js";
import { workflowStatuses } from "./repository/applicationsRepository.js";

export const gzipAsync = promisify(gzip);

export const currentFile = fileURLToPath(import.meta.url);
export const currentDir = dirname(currentFile);
export const rootDir = dirname(currentDir);
export const publicDir = join(rootDir, "public");
export const sessionCookieName = "heimatschutz_session";
export const sessionMaxAgeSeconds = 60 * 60 * 12;
export const registrationKeyLifetimeDays = 30;
export const agisBaugesucheDatendocUrl =
  "https://www.ag.ch/geoportal/geodatenshop/Datendokumentation.aspx?Datensatzelement=3018";
export const placeholderPasswordValues = new Set([
  "dein_sicheres_master_passwort",
  "dein_sicheres_team_passwort",
  "eigenesmasterpasswort",
  "eigenessicherespasswort",
  "bittemasterpasswortvordemreleaseaendern123",
  "bittevordemreleaseaendern123"
]);
export const placeholderSyncSourceMarkers = ["example.test", "beispiel", "placeholder"];
export const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' https://cdnjs.cloudflare.com https://unpkg.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://www.ag.ch https://unpkg.com https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com"
].join("; ");
export const municipalitySourcePatternMaxLength = 160;
export const municipalitySourcePatternMaxTerms = 24;
export const municipalitySourcePatternTermMaxLength = 80;
export const municipalitySourcePatternUnsupportedChars = /[\\^$*+?()[\]{}]/;

export function nowIso() {
  return new Date().toISOString();
}

export function buildSessionExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + sessionMaxAgeSeconds * 1000).toISOString();
}

export function buildRegistrationKeyExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + registrationKeyLifetimeDays * 24 * 60 * 60 * 1000).toISOString();
}

export function normalizeEnvString(value) {
  return String(value ?? "").trim();
}

export function normalizeHttpUrl(value) {
  const normalized = normalizeEnvString(value);

  if (!normalized) {
    return "";
  }

  try {
    const parsedUrl = new URL(normalized);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
}

export function looksLikeEmailAddress(value) {
  const email = String(value ?? "").trim();

  if (!email || email.length > 120 || /\s/.test(email)) {
    return false;
  }

  const atIndex = email.indexOf("@");

  if (atIndex <= 0 || atIndex !== email.lastIndexOf("@")) {
    return false;
  }

  const domain = email.slice(atIndex + 1);

  if (!domain || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".") || !domain.includes(".")) {
    return false;
  }

  return domain
    .split(".")
    .every((part) => part.length > 0 && part.length <= 63 && /^[a-z0-9-]+$/i.test(part) && !part.startsWith("-") && !part.endsWith("-"));
}

export function validateMunicipalitySourceSearchPattern(label, pattern) {
  if (!pattern) {
    return "";
  }

  if (pattern.length > municipalitySourcePatternMaxLength) {
    return `${label} ist zu lang.`;
  }

  if (municipalitySourcePatternUnsupportedChars.test(pattern)) {
    return `${label} darf nur einfache Suchbegriffe enthalten. Mehrere Begriffe können mit | getrennt werden.`;
  }

  const terms = pattern
    .split("|")
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return `${label} enthält keinen gültigen Suchbegriff.`;
  }

  if (terms.length > municipalitySourcePatternMaxTerms) {
    return `${label} enthält zu viele Suchbegriffe.`;
  }

  if (terms.some((term) => term.length > municipalitySourcePatternTermMaxLength)) {
    return `${label} enthält einen zu langen Suchbegriff.`;
  }

  return "";
}

export function looksLikeMachineReadableSourceUrl(value) {
  const normalized = normalizeEnvString(value);

  if (!normalized) {
    return false;
  }

  try {
    const parsedUrl = new URL(normalized);
    const decodedPathAndSearch = decodeURIComponent(`${parsedUrl.pathname} ${parsedUrl.search}`);

    return (
      /\/(?:MapServer|FeatureServer)(?:\/\d+)?(?:\/query)?$/i.test(parsedUrl.pathname) ||
      /\.(?:json|geojson|xml|rss|atom|pdf)(?:$|[?#\s])/i.test(decodedPathAndSearch) ||
      /\bf=(?:p?json|geojson)\b/i.test(decodedPathAndSearch) ||
      /\b(?:feed|rss|atom|sitemap)\b/i.test(decodedPathAndSearch)
    );
  } catch {
    return false;
  }
}

export function normalizeSecretForComparison(value) {
  return normalizeEnvString(value).toLowerCase();
}

export function isPlaceholderPassword(value) {
  return placeholderPasswordValues.has(normalizeSecretForComparison(value));
}

export function normalizeSyncSourceUrl(value, logger = console) {
  const normalizedValue = normalizeEnvString(value);

  if (!normalizedValue) {
    return "";
  }

  const normalizedLower = normalizedValue.toLowerCase();

  if (placeholderSyncSourceMarkers.some((marker) => normalizedLower.includes(marker))) {
    logger.warn?.(
      "SYNC_SOURCE_URL verwendet noch einen Platzhalter und wird bis zur echten API-Anbindung ignoriert."
    );
    return "";
  }

  try {
    const parsedUrl = new URL(normalizedValue);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      logger.warn?.("SYNC_SOURCE_URL muss mit http:// oder https:// beginnen und wird sonst ignoriert.");
      return "";
    }

    return parsedUrl.toString();
  } catch {
    logger.warn?.("SYNC_SOURCE_URL ist keine gültige URL und wird deshalb ignoriert.");
    return "";
  }
}

export function validateProductionRuntimeConfiguration(env = process.env) {
  if (normalizeEnvString(env.NODE_ENV).toLowerCase() !== "production") {
    return;
  }

  const masterPassword = normalizeEnvString(env.MASTER_ACCOUNT_PASSWORD);
  const defaultLoginPassword = normalizeEnvString(env.DEFAULT_LOGIN_PASSWORD);
  const masterSetupEmail = normalizeEnvString(env.MASTER_SETUP_EMAIL);
  const smtpHost = normalizeEnvString(env.SMTP_HOST);
  const emailSetupConfigured = Boolean(masterSetupEmail && smtpHost);
  const errors = [];

  if (!masterPassword) {
    // Kein Master-Passwort ist nur zulässig, wenn die E-Mail-Ersteinrichtung
    // (Setup-Key per SMTP) konfiguriert ist.
    if (!emailSetupConfigured) {
      errors.push(
        "Es ist weder MASTER_ACCOUNT_PASSWORD gesetzt noch die E-Mail-Ersteinrichtung (MASTER_SETUP_EMAIL + SMTP_HOST) konfiguriert."
      );
    }
  } else if (isPlaceholderPassword(masterPassword)) {
    errors.push("MASTER_ACCOUNT_PASSWORD verwendet noch einen Platzhalter oder das Standardpasswort.");
  }

  // DEFAULT_LOGIN_PASSWORD ist optional: ohne Wert bleiben die Seed-Teamkonten
  // gesperrt und neue Mitarbeitende registrieren sich per Schlüssel. Wird ein Wert
  // gesetzt, darf er kein Platzhalter sein.
  if (defaultLoginPassword && isPlaceholderPassword(defaultLoginPassword)) {
    errors.push("DEFAULT_LOGIN_PASSWORD verwendet noch einen Platzhalter oder das Standardpasswort.");
  }

  if (errors.length > 0) {
    throw new Error(
      `Produktionsstart abgebrochen: ${errors.join(" ")} Bitte in der Hosting-Umgebung echte sichere Werte setzen.`
    );
  }
}

export function generateRegistrationKey() {
  const raw = randomBytes(6).toString("hex").toUpperCase();
  return `HSA-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export const masterSetupKeyLifetimeHours = 48;

// Hochentropischer Einmal-Key für die Master-Ersteinrichtung.
export function generateMasterSetupKey() {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  return `HSA-SETUP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function buildMasterSetupExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + masterSetupKeyLifetimeHours * 60 * 60 * 1000).toISOString();
}

export const passwordResetKeyLifetimeHours = 2;

// Hochentropischer Einmal-Key für den Passwort-Reset.
export function generatePasswordResetKey() {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  return `HSA-RESET-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function buildPasswordResetExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + passwordResetKeyLifetimeHours * 60 * 60 * 1000).toISOString();
}

export function normalizeRegistrationKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(/\s+/g, "");
}

export function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

export function isSecureRequest(request) {
  if (request.secure) {
    return true;
  }

  return String(request.headers["x-forwarded-proto"] ?? "").includes("https");
}

export function buildSessionCookie(sessionId, request) {
  const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureAttribute}`;
}

export function buildExpiredSessionCookie(request) {
  const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute}`;
}

export const csrfProtectedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function getRequestHosts(request) {
  const hosts = new Set();

  if (request.headers.host) {
    hosts.add(String(request.headers.host).toLowerCase());
  }

  const forwardedHost = request.headers["x-forwarded-host"];

  if (forwardedHost) {
    for (const host of String(forwardedHost).split(",")) {
      hosts.add(host.trim().toLowerCase());
    }
  }

  return hosts;
}

// CSRF-Schutz: Zusammen mit dem SameSite=Lax-Session-Cookie wird jede ändernde
// Anfrage abgewiesen, deren Origin/Referer nicht zum eigenen Host gehoert. Fehlt
// Origin UND Referer (Nicht-Browser-Clients, Server-zu-Server), wird durchgelassen.
export function createCsrfOriginGuard({ enabled = true } = {}) {
  return function csrfOriginGuard(request, response, next) {
    if (!enabled || !csrfProtectedMethods.has(request.method)) {
      next();
      return;
    }

    const source = request.headers.origin || request.headers.referer;

    if (!source) {
      next();
      return;
    }

    let sourceHost;

    try {
      sourceHost = new URL(source).host.toLowerCase();
    } catch {
      response.status(403).json({ error: "Ungültige Anfrage-Herkunft." });
      return;
    }

    if (getRequestHosts(request).has(sourceHost)) {
      next();
      return;
    }

    response.status(403).json({ error: "Anfrage von fremder Herkunft wurde blockiert." });
  };
}

export function setCommonSecurityHeaders(_request, response, next) {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // HSTS: Browser ignorieren den Header über HTTP, daher ist das unbedenklich und
  // erzwingt HTTPS, sobald die App hinter TLS ausgeliefert wird.
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

export function setStaticAssetHeaders(response, filePath) {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".html") {
    response.setHeader("Cache-Control", "no-store");
    return;
  }

  if ([".css", ".js"].includes(extension)) {
    response.setHeader("Cache-Control", "no-cache");
    return;
  }

  if ([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"].includes(extension)) {
    response.setHeader("Cache-Control", "public, max-age=86400");
    return;
  }

  if ([".woff2", ".woff"].includes(extension)) {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}

export const compressibleContentTypePattern =
  /^(?:text\/|application\/(?:json|javascript|xml|rss\+xml|atom\+xml|geo\+json|manifest\+json)|image\/svg\+xml)/i;

export function isCompressibleContentType(contentTypeHeader) {
  if (!contentTypeHeader) {
    return false;
  }

  return compressibleContentTypePattern.test(String(contentTypeHeader));
}

export function appendVaryHeader(response, field) {
  const existing = response.getHeader("Vary");

  if (!existing) {
    response.setHeader("Vary", field);
    return;
  }

  const values = String(existing)
    .split(",")
    .map((value) => value.trim().toLowerCase());

  if (values.includes("*") || values.includes(field.toLowerCase())) {
    return;
  }

  response.setHeader("Vary", `${existing}, ${field}`);
}

// Schlanke gzip-Kompression ohne externe Abhängigkeit. Puffert den Antwort-Body
// und komprimiert ihn asynchron (blockiert die Event-Loop nicht), sofern der
// Client gzip akzeptiert, der Inhaltstyp komprimierbar ist und die Antwort den
// Schwellwert überschreitet.
export function createCompressionMiddleware({ threshold = 1024 } = {}) {
  return function compressionMiddleware(request, response, next) {
    const acceptEncoding = String(request.headers["accept-encoding"] ?? "");

    if (request.method === "HEAD" || !/\bgzip\b/i.test(acceptEncoding)) {
      next();
      return;
    }

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    const chunks = [];

    function collect(chunk, encoding) {
      if (!chunk) {
        return;
      }

      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
      );
    }

    response.write = function patchedWrite(chunk, encoding, callback) {
      collect(chunk, encoding);

      if (typeof encoding === "function") {
        encoding(null);
      } else if (typeof callback === "function") {
        callback(null);
      }

      return true;
    };

    response.end = function patchedEnd(chunk, encoding, callback) {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }

      collect(chunk, encoding);

      // Originale Methoden wiederherstellen, damit das eigentliche Senden normal läuft.
      response.write = originalWrite;
      response.end = originalEnd;

      const body = Buffer.concat(chunks);
      const shouldCompress =
        response.statusCode === 200 &&
        body.length >= threshold &&
        !response.getHeader("Content-Encoding") &&
        !response.getHeader("Content-Range") &&
        isCompressibleContentType(response.getHeader("Content-Type"));

      if (!shouldCompress) {
        return originalEnd(body, callback);
      }

      gzipAsync(body)
        .then((compressed) => {
          response.setHeader("Content-Encoding", "gzip");
          response.removeHeader("Content-Length");
          response.setHeader("Content-Length", compressed.length);
          appendVaryHeader(response, "Accept-Encoding");
          originalEnd(compressed, callback);
        })
        .catch(() => {
          originalEnd(body, callback);
        });

      return response;
    };

    next();
  };
}

// In-Memory-Bremse gegen Passwort-Raten. Sperrt einen Schlüssel (i. d. R. Client-IP)
// nach zu vielen Fehlversuchen innerhalb des Zeitfensters für die Sperrdauer.
export function createLoginRateLimiter({
  maxAttempts = 10,
  windowMs = 15 * 60 * 1000,
  lockoutMs = 15 * 60 * 1000
} = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      const expiry = Math.max(entry.lockedUntil ?? 0, entry.firstAttempt + windowMs);

      if (expiry <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    check(key) {
      const now = Date.now();
      const entry = entries.get(key);

      if (entry?.lockedUntil && entry.lockedUntil > now) {
        return { limited: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
      }

      return { limited: false };
    },

    // True, sobald für diesen Schlüssel im Zeitfenster bereits ein Fehlversuch
    // vorliegt (=> ab dem 2. Login-Versuch eine Bot-Prüfung verlangen).
    requiresChallenge(key) {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || now - entry.firstAttempt > windowMs) {
        return false;
      }

      return (entry.count ?? 0) >= 1;
    },

    recordFailure(key) {
      const now = Date.now();
      prune(now);

      let entry = entries.get(key);

      if (!entry || now - entry.firstAttempt > windowMs) {
        entry = { firstAttempt: now, count: 0, lockedUntil: 0 };
      }

      entry.count += 1;

      if (entry.count >= maxAttempts) {
        entry.lockedUntil = now + lockoutMs;
      }

      entries.set(key, entry);
    },

    recordSuccess(key) {
      entries.delete(key);
    }
  };
}

// Prüft ein Cloudflare-Turnstile-Token gegen die siteverify-API.
export async function verifyTurnstileToken(token, secret, remoteIp) {
  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);

  if (remoteIp) {
    params.set("remoteip", remoteIp);
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const data = await response.json();
  return Boolean(data?.success);
}

export function validateLoginPayload(payload) {
  const userId = String(payload.userId ?? "").trim();
  const username = String(payload.username ?? "").trim().toLowerCase();
  const password = String(payload.password ?? "");

  if ((!userId && !username) || !password) {
    return { error: "Bitte Benutzer und Passwort eingeben." };
  }

  return {
    value: {
      userId,
      username,
      password
    }
  };
}

export function validateRegistrationPayload(payload) {
  const displayName = String(payload.displayName ?? "").trim();
  const username = String(payload.username ?? "").trim().toLowerCase();
  const password = String(payload.password ?? "");
  const accessKey = normalizeRegistrationKey(payload.accessKey);
  const email = String(payload.email ?? "").trim().toLowerCase();

  if (!displayName || !username || !password || !accessKey) {
    return { error: "Bitte Name, Benutzername, Passwort und Registrierungsschlüssel eingeben." };
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return { error: "Der Benutzername darf nur Kleinbuchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich enthalten." };
  }

  if (displayName.length < 3 || displayName.length > 80) {
    return { error: "Der Name muss zwischen 3 und 80 Zeichen lang sein." };
  }

  if (password.length < 8) {
    return { error: "Das Passwort muss mindestens 8 Zeichen lang sein." };
  }

  if (email.length > 120) {
    return { error: "Die E-Mail-Adresse ist zu lang." };
  }

  // E-Mail ist optional, wird aber für den Self-Service-Passwort-Reset benötigt.
  if (email && !looksLikeEmailAddress(email)) {
    return { error: "Bitte eine gültige E-Mail-Adresse eingeben oder das Feld leer lassen." };
  }

  return {
    value: {
      displayName,
      username,
      password,
      accessKey,
      email,
      role: "Mitarbeiter"
    }
  };
}

export function validateRegistrationKeyCreationPayload(payload) {
  const note = String(payload.note ?? "").trim();

  if (note.length > 120) {
    return { error: "Die Notiz zum Registrierungsschlüssel ist zu lang." };
  }

  return {
    value: {
      note
    }
  };
}

export function validatePasswordResetPayload(payload) {
  const password = String(payload.password ?? "");

  if (!password) {
    return { error: "Bitte ein neues Passwort eingeben." };
  }

  if (password.length < 8) {
    return { error: "Das neue Passwort muss mindestens 8 Zeichen lang sein." };
  }

  return {
    value: {
      password
    }
  };
}

export function validateManualImportPayload(payload) {
  const jsonText = String(payload.jsonText ?? "").trim();

  if (!jsonText) {
    return { error: "Bitte einen JSON-Export aus AGIS oder eBau einfügen." };
  }

  return {
    value: {
      jsonText
    }
  };
}

export function looksLikeAmtsblattUrl(value) {
  try {
    return /(^|\.)amtsblatt\.ag\.ch$/i.test(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

export function validateSyncSettingsPayload(payload) {
  const sourceUrl = String(payload.sourceUrl ?? "").trim();
  const sourceToken = String(payload.sourceToken ?? "").trim();
  const sourceType = String(payload.sourceType ?? "").trim().toLowerCase();
  const sourceMunicipality = String(payload.sourceMunicipality ?? "").trim();
  const allowedSourceTypes = ["", "auto", "amtsblatt", ...municipalitySourceTypes.filter((type) => type !== "manual")];

  if (!allowedSourceTypes.includes(sourceType)) {
    return { error: "Der Quellentyp ist ungültig." };
  }

  if (sourceMunicipality.length > 80) {
    return { error: "Der Gemeindename zur Quelle ist zu lang." };
  }

  if (
    sourceUrl &&
    sourceType !== "amtsblatt" &&
    !looksLikeAmtsblattUrl(sourceUrl) &&
    (["html", "xml", "pdf"].includes(sourceType) || (!sourceType && !looksLikeMachineReadableSourceUrl(sourceUrl))) &&
    !sourceMunicipality
  ) {
    return { error: "Für Website-, RSS-/Sitemap- oder PDF-Scraping bitte die Gemeinde angeben." };
  }

  return {
    value: {
      sourceUrl,
      sourceToken,
      sourceType: sourceType === "auto" ? "" : sourceType,
      sourceMunicipality
    }
  };
}

export function validateMunicipalitySourcePayload(payload) {
  const sourceType = String(payload.sourceType ?? "").trim();
  const digitalStatus = String(payload.digitalStatus ?? "").trim();
  const sourceUrl = normalizeHttpUrl(payload.sourceUrl ?? "");
  const sourceToken = String(payload.sourceToken ?? "").trim();
  const includePattern = String(payload.includePattern ?? "").trim();
  const excludePattern = String(payload.excludePattern ?? "").trim();
  const notes = String(payload.notes ?? "").trim();
  const enabled = Boolean(payload.enabled);

  if (!municipalitySourceTypes.includes(sourceType)) {
    return { error: "Der Quellentyp ist ungültig." };
  }

  if (!municipalityDigitalStatuses.includes(digitalStatus)) {
    return { error: "Der Digitalisierungsstatus ist ungültig." };
  }

  if (payload.sourceUrl && sourceUrl === null) {
    return { error: "Die Quellen-URL muss mit http:// oder https:// beginnen." };
  }

  if (notes.length > 500) {
    return { error: "Die Notiz zur Gemeindequelle ist zu lang." };
  }

  for (const [label, pattern] of [
    ["Include-Muster", includePattern],
    ["Exclude-Muster", excludePattern]
  ]) {
    const patternError = validateMunicipalitySourceSearchPattern(label, pattern);

    if (patternError) {
      return { error: patternError };
    }
  }

  if (enabled && sourceType !== "manual" && !sourceUrl) {
    return { error: "Für eine aktivierte automatische Gemeindequelle wird eine URL benötigt." };
  }

  return {
    value: {
      sourceType,
      digitalStatus,
      sourceUrl: sourceUrl ?? "",
      sourceToken,
      includePattern,
      excludePattern,
      notes,
      enabled
    }
  };
}

export function validateCommentPayload(payload) {
  const message = String(payload.message ?? "").trim();

  if (!message) {
    return { error: "Bitte einen Team-Kommentar eingeben." };
  }

  if (message.length > 2000) {
    return { error: "Der Team-Kommentar ist zu lang." };
  }

  return {
    value: {
      message
    }
  };
}

export function resolveCurrentUser(request, sessionsRepository, usersRepository) {
  sessionsRepository.deleteExpired(nowIso());
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies[sessionCookieName];

  if (!sessionId) {
    return null;
  }

  const session = sessionsRepository.getActiveById(sessionId, nowIso());

  if (!session) {
    return null;
  }

  const user = usersRepository.getPublicUserById(session.userId);

  if (!user) {
    sessionsRepository.deleteById(sessionId);
    return null;
  }

  sessionsRepository.touch(sessionId, nowIso(), buildSessionExpiry());

  return {
    sessionId,
    user
  };
}

export function isMasterUser(user) {
  return user?.role === "Master";
}

export function handleHealthCheck(_request, response, databasePath) {
  response.json({
    status: "ok",
    databasePath
  });
}

export function escapeCsvValue(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');

  if (/[",\n]/.test(escaped)) {
    return `"${escaped}"`;
  }

  return escaped;
}

export function buildCsvResponse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(escapeCsvValue).join(",");
  const bodyRows = rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","));
  return [headerRow, ...bodyRows].join("\n");
}

export function validateApplicationPatch(payload) {
  const sanitized = {};

  if (payload.workflowStatus !== undefined) {
    if (!workflowStatuses.includes(payload.workflowStatus)) {
      return { error: "workflowStatus is invalid" };
    }

    sanitized.workflowStatus = payload.workflowStatus;
  }

  if (payload.assignee !== undefined) {
    if (typeof payload.assignee !== "string") {
      return { error: "assignee must be a string" };
    }

    sanitized.assignee = payload.assignee;
  }

  if (payload.note !== undefined) {
    if (typeof payload.note !== "string") {
      return { error: "note must be a string" };
    }

    sanitized.note = payload.note;
  }

  if (payload.learnFromDecision !== undefined) {
    sanitized.learnFromDecision = Boolean(payload.learnFromDecision);
  }

  if (Object.keys(sanitized).length === 0) {
    return { error: "no supported fields provided" };
  }

  return { value: sanitized };
}

export function shouldCreateImportNotification(item) {
  return ["protected-point", "protected-zone", "combined-hit", "manual-review"].includes(item?.protectionStatus);
}

export function buildImportNotificationEntries(changes, sourceLabel) {
  const createdAt = nowIso();

  return (changes ?? [])
    .filter((entry) => entry?.item && shouldCreateImportNotification(entry.item))
    .map((entry) => ({
      id: `NTF-${randomBytes(8).toString("hex")}`,
      applicationId: entry.item.id,
      changeType: entry.changeType ?? "updated",
      sourceLabel,
      protectionStatus: entry.item.protectionStatus,
      municipality: entry.item.municipality,
      address: entry.item.address,
      createdAt
    }));
}

