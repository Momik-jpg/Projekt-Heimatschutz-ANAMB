import express from "express";
import { randomBytes } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createDatabase, getDefaultDbPath } from "./db.js";
import { createAgisAssessmentService } from "./services/agisAssessmentService.js";
import { createAgisGeometryService } from "./services/agisGeometryService.js";
import {
  createApplicationsSyncService,
  normalizeImportedPayload
} from "./services/applicationsSyncService.js";
import { createWeeklySyncService } from "./services/weeklySyncService.js";
import { createCommentsRepository } from "./repository/commentsRepository.js";
import { createImportNotificationsRepository } from "./repository/importNotificationsRepository.js";
import {
  createMunicipalitySourcesRepository,
  municipalityDigitalStatuses,
  municipalitySourceTypes
} from "./repository/municipalitySourcesRepository.js";
import { createRegistrationKeysRepository } from "./repository/registrationKeysRepository.js";
import {
  createMasterSetupKeysRepository,
  hashSetupKey
} from "./repository/masterSetupKeysRepository.js";
import { createSessionsRepository } from "./repository/sessionsRepository.js";
import { createSettingsRepository } from "./repository/settingsRepository.js";
import { createSyncJobsRepository } from "./repository/syncJobsRepository.js";
import { createAuditLogRepository } from "./repository/auditLogRepository.js";
import { createUsersRepository, createUserPasswordRecordAsync } from "./repository/usersRepository.js";
import {
  createApplicationsRepository,
  protectionStatuses,
  workflowStatuses
} from "./repository/applicationsRepository.js";
import { createMailService } from "./services/mailService.js";
import { createMaintenanceService } from "./services/maintenanceService.js";

const gzipAsync = promisify(gzip);

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const rootDir = dirname(currentDir);
const publicDir = join(rootDir, "public");
const sessionCookieName = "heimatschutz_session";
const sessionMaxAgeSeconds = 60 * 60 * 12;
const registrationKeyLifetimeDays = 30;
const agisBaugesucheDatendocUrl =
  "https://www.ag.ch/geoportal/geodatenshop/Datendokumentation.aspx?Datensatzelement=3018";
const placeholderPasswordValues = new Set([
  "dein_sicheres_master_passwort",
  "dein_sicheres_team_passwort",
  "eigenesmasterpasswort",
  "eigenessicherespasswort",
  "bittemasterpasswortvordemreleaseaendern123",
  "bittevordemreleaseaendern123"
]);
const placeholderSyncSourceMarkers = ["example.test", "beispiel", "placeholder"];
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://www.ag.ch"
].join("; ");

function nowIso() {
  return new Date().toISOString();
}

function buildSessionExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + sessionMaxAgeSeconds * 1000).toISOString();
}

function buildRegistrationKeyExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + registrationKeyLifetimeDays * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeEnvString(value) {
  return String(value ?? "").trim();
}

function normalizeHttpUrl(value) {
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

function looksLikeMachineReadableSourceUrl(value) {
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

function normalizeSecretForComparison(value) {
  return normalizeEnvString(value).toLowerCase();
}

function isPlaceholderPassword(value) {
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
    // Kein Master-Passwort ist nur zulaessig, wenn die E-Mail-Ersteinrichtung
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
  // gesperrt und neue Mitarbeitende registrieren sich per Schluessel. Wird ein Wert
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

function generateRegistrationKey() {
  const raw = randomBytes(6).toString("hex").toUpperCase();
  return `HSA-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

const masterSetupKeyLifetimeHours = 48;

// Hochentropischer Einmal-Key fuer die Master-Ersteinrichtung.
function generateMasterSetupKey() {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  return `HSA-SETUP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function buildMasterSetupExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + masterSetupKeyLifetimeHours * 60 * 60 * 1000).toISOString();
}

function normalizeRegistrationKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(/\s+/g, "");
}

function parseCookies(cookieHeader = "") {
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

function isSecureRequest(request) {
  if (request.secure) {
    return true;
  }

  return String(request.headers["x-forwarded-proto"] ?? "").includes("https");
}

function buildSessionCookie(sessionId, request) {
  const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureAttribute}`;
}

function buildExpiredSessionCookie(request) {
  const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute}`;
}

const csrfProtectedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getRequestHosts(request) {
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

// CSRF-Schutz: Zusammen mit dem SameSite=Lax-Session-Cookie wird jede aendernde
// Anfrage abgewiesen, deren Origin/Referer nicht zum eigenen Host gehoert. Fehlt
// Origin UND Referer (Nicht-Browser-Clients, Server-zu-Server), wird durchgelassen.
function createCsrfOriginGuard({ enabled = true } = {}) {
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
      response.status(403).json({ error: "Ungueltige Anfrage-Herkunft." });
      return;
    }

    if (getRequestHosts(request).has(sourceHost)) {
      next();
      return;
    }

    response.status(403).json({ error: "Anfrage von fremder Herkunft wurde blockiert." });
  };
}

function setCommonSecurityHeaders(_request, response, next) {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // HSTS: Browser ignorieren den Header ueber HTTP, daher ist das unbedenklich und
  // erzwingt HTTPS, sobald die App hinter TLS (z. B. Railway) ausgeliefert wird.
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

function setStaticAssetHeaders(response, filePath) {
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
  }
}

const compressibleContentTypePattern =
  /^(?:text\/|application\/(?:json|javascript|xml|rss\+xml|atom\+xml|geo\+json|manifest\+json)|image\/svg\+xml)/i;

function isCompressibleContentType(contentTypeHeader) {
  if (!contentTypeHeader) {
    return false;
  }

  return compressibleContentTypePattern.test(String(contentTypeHeader));
}

function appendVaryHeader(response, field) {
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

// Schlanke gzip-Kompression ohne externe Abhaengigkeit. Puffert den Antwort-Body
// und komprimiert ihn asynchron (blockiert die Event-Loop nicht), sofern der
// Client gzip akzeptiert, der Inhaltstyp komprimierbar ist und die Antwort den
// Schwellwert ueberschreitet.
function createCompressionMiddleware({ threshold = 1024 } = {}) {
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

      // Originale Methoden wiederherstellen, damit das eigentliche Senden normal laeuft.
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

// In-Memory-Bremse gegen Passwort-Raten. Sperrt einen Schluessel (i. d. R. Client-IP)
// nach zu vielen Fehlversuchen innerhalb des Zeitfensters fuer die Sperrdauer.
function createLoginRateLimiter({
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

function validateLoginPayload(payload) {
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

function validateRegistrationPayload(payload) {
  const displayName = String(payload.displayName ?? "").trim();
  const username = String(payload.username ?? "").trim().toLowerCase();
  const password = String(payload.password ?? "");
  const accessKey = normalizeRegistrationKey(payload.accessKey);

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

  if (!/^HSA-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(accessKey)) {
    return { error: "Der Registrierungsschlüssel ist ungültig." };
  }

  return {
    value: {
      displayName,
      username,
      password,
      accessKey,
      role: "Mitarbeiter"
    }
  };
}

function validateRegistrationKeyCreationPayload(payload) {
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

function validatePasswordResetPayload(payload) {
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

function validateManualImportPayload(payload) {
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

function looksLikeAmtsblattUrl(value) {
  try {
    return /(^|\.)amtsblatt\.ag\.ch$/i.test(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

function validateSyncSettingsPayload(payload) {
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

function validateMunicipalitySourcePayload(payload) {
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
    if (!pattern) {
      continue;
    }

    try {
      new RegExp(pattern, "i");
    } catch {
      return { error: `${label} ist kein gültiger Suchausdruck.` };
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

function validateCommentPayload(payload) {
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

function resolveCurrentUser(request, sessionsRepository, usersRepository) {
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

function isMasterUser(user) {
  return user?.role === "Master";
}

function handleHealthCheck(_request, response, databasePath) {
  response.json({
    status: "ok",
    databasePath
  });
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');

  if (/[",\n]/.test(escaped)) {
    return `"${escaped}"`;
  }

  return escaped;
}

function buildCsvResponse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(escapeCsvValue).join(",");
  const bodyRows = rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","));
  return [headerRow, ...bodyRows].join("\n");
}

function validateApplicationPatch(payload) {
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

  if (Object.keys(sanitized).length === 0) {
    return { error: "no supported fields provided" };
  }

  return { value: sanitized };
}

function shouldCreateImportNotification(item) {
  return ["protected-point", "protected-zone", "combined-hit", "manual-review"].includes(item?.protectionStatus);
}

function buildImportNotificationEntries(changes, sourceLabel) {
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

export function createApp(options = {}) {
  const logger = options.logger ?? console;
  const normalizedSyncSourceUrl = normalizeSyncSourceUrl(
    options.syncSourceUrl ?? process.env.SYNC_SOURCE_URL ?? "",
    logger
  );
  const normalizedSyncSourceToken = normalizeEnvString(
    options.syncSourceToken ?? process.env.SYNC_SOURCE_TOKEN ?? ""
  );
  const masterAccountPassword = normalizeEnvString(
    options.masterAccountPassword ?? process.env.MASTER_ACCOUNT_PASSWORD ?? ""
  );
  const defaultLoginPassword = normalizeEnvString(
    options.defaultLoginPassword ?? process.env.DEFAULT_LOGIN_PASSWORD ?? ""
  );
  const masterSetupEmail = normalizeEnvString(
    options.masterSetupEmail ?? process.env.MASTER_SETUP_EMAIL ?? ""
  );
  const db = createDatabase(options.dbPath ?? getDefaultDbPath(), {
    seedDemoApplications: options.seedDemoApplications,
    masterAccountPassword,
    defaultLoginPassword
  });
  const repository = createApplicationsRepository(db);
  const commentsRepository = createCommentsRepository(db);
  const importNotificationsRepository = createImportNotificationsRepository(db);
  const municipalitySourcesRepository = createMunicipalitySourcesRepository(db);
  const registrationKeysRepository = createRegistrationKeysRepository(db);
  const masterSetupKeysRepository = createMasterSetupKeysRepository(db);
  const sessionsRepository = createSessionsRepository(db);
  const settingsRepository = createSettingsRepository(db);
  const syncJobsRepository = createSyncJobsRepository(db);
  const auditLogRepository = createAuditLogRepository(db);
  const usersRepository = createUsersRepository(db);
  const mailService = options.mailService ?? createMailService({ logger });

  function recordAudit(action, request, fields = {}) {
    const actor = request?.currentUser;
    auditLogRepository.record({
      action,
      actorUserId: fields.actorUserId ?? actor?.id ?? "",
      actorName: fields.actorName ?? actor?.displayName ?? "",
      target: fields.target ?? "",
      detail: fields.detail ?? "",
      ip: request?.ip ?? ""
    });
  }
  const masterPasswordConfiguredSettingKey = "master_password_configured";

  function getMasterUserId() {
    const row = db
      .prepare("SELECT id FROM users WHERE username = 'master' AND role = 'Master' AND active = 1 LIMIT 1")
      .get();

    return row?.id ?? null;
  }

  async function deliverMasterSetupKey({ key, sentTo, expiresAt }) {
    // Test-/Integrationshook: erlaubt das direkte Abfangen des Klartext-Keys.
    if (typeof options.onMasterSetupKey === "function") {
      await options.onMasterSetupKey({ key, sentTo, expiresAt });
      return;
    }

    const subject = "Heimatschutz Aargau – Master-Konto einrichten";
    const text = [
      "Hallo,",
      "",
      "fuer das Master-Konto der Heimatschutz-Aargau-Anwendung wurde eine Ersteinrichtung angefordert.",
      'Bitte oeffnen Sie die Anwendung, waehlen Sie "Master-Konto einrichten" und geben Sie den folgenden',
      "Einmal-Schluessel zusammen mit Ihrem neuen Passwort ein:",
      "",
      `    ${key}`,
      "",
      `Der Schluessel ist gueltig bis ${expiresAt}.`,
      "Falls Sie diese Einrichtung nicht angefordert haben, koennen Sie diese E-Mail ignorieren.",
      "",
      "Heimatschutz Aargau"
    ].join("\n");

    if (sentTo && mailService.isConfigured?.()) {
      await mailService.sendMail({ to: sentTo, subject, text });
      logger.log?.(`Master-Setup-Key per E-Mail an ${sentTo} gesendet.`);
      return;
    }

    // Fallback ohne SMTP/Empfaenger: Key einmalig ins Server-Log schreiben, damit
    // die Ersteinrichtung nicht blockiert. In Produktion sollte SMTP gesetzt sein.
    logger.warn?.(
      `SMTP oder MASTER_SETUP_EMAIL ist nicht konfiguriert. Einmaliger Master-Setup-Key ` +
        `(nur jetzt sichtbar): ${key} – gueltig bis ${expiresAt}.`
    );
  }

  async function ensureMasterAccountReady() {
    if (masterAccountPassword) {
      // Passwort stammt aus Umgebung/Option – das Konto ist eingerichtet.
      settingsRepository.setValue(masterPasswordConfiguredSettingKey, "1");
      return;
    }

    if (settingsRepository.getValue(masterPasswordConfiguredSettingKey) === "1") {
      return;
    }

    const masterUserId = getMasterUserId();

    if (!masterUserId) {
      return;
    }

    const now = nowIso();

    if (masterSetupKeysRepository.hasActiveForUser(masterUserId, now)) {
      return;
    }

    masterSetupKeysRepository.deletePendingForUser(masterUserId);

    const key = generateMasterSetupKey();
    const expiresAt = buildMasterSetupExpiry(new Date(now));

    masterSetupKeysRepository.create({
      id: `MSK-${randomBytes(8).toString("hex")}`,
      userId: masterUserId,
      keyHash: hashSetupKey(key),
      sentTo: masterSetupEmail,
      createdAt: now,
      expiresAt
    });

    await deliverMasterSetupKey({ key, sentTo: masterSetupEmail, expiresAt });
  }

  const masterSetupReadyPromise = ensureMasterAccountReady().catch((error) => {
    logger.warn?.(`Master-Setup konnte nicht abgeschlossen werden: ${error.message}`);
    return null;
  });
  const loginRateLimiter =
    options.loginRateLimit === false
      ? null
      : createLoginRateLimiter(
          typeof options.loginRateLimit === "object" && options.loginRateLimit !== null
            ? options.loginRateLimit
            : {}
        );
  const agisGeometryService = createAgisGeometryService({
    fetchImpl: options.agisFetchImpl
  });
  const agisAssessmentEnabled = options.agisAssessmentEnabled ?? true;
  const agisAssessmentService = createAgisAssessmentService({
    repository,
    agisGeometryService
  });
  const assessImportedApplication = agisAssessmentEnabled
    ? async (item) => {
        const assessment = await agisAssessmentService.assessItem(item);
        return assessment ? { ...item, ...assessment } : item;
      }
    : null;
  const applicationsSyncService = createApplicationsSyncService({
    repository,
    sourceUrl: normalizedSyncSourceUrl,
    getSourceUrl: () => settingsRepository.getValue("sync_source_url", normalizedSyncSourceUrl),
    sourceToken: normalizedSyncSourceToken,
    getSourceToken: () => settingsRepository.getValue("sync_source_token", normalizedSyncSourceToken),
    sourceType: normalizeEnvString(options.syncSourceType ?? process.env.SYNC_SOURCE_TYPE ?? ""),
    getSourceType: () => settingsRepository.getValue("sync_source_type", normalizeEnvString(options.syncSourceType ?? process.env.SYNC_SOURCE_TYPE ?? "")),
    sourceMunicipality: normalizeEnvString(options.syncSourceMunicipality ?? process.env.SYNC_SOURCE_MUNICIPALITY ?? ""),
    getSourceMunicipality: () =>
      settingsRepository.getValue(
        "sync_source_municipality",
        normalizeEnvString(options.syncSourceMunicipality ?? process.env.SYNC_SOURCE_MUNICIPALITY ?? "")
      ),
    getMunicipalitySources: () => municipalitySourcesRepository.listEnabledConfigured(),
    fetchImpl: options.syncFetchImpl ?? fetch,
    geocodeFetchImpl:
      options.geocodeEnabled === false ? null : options.geocodeFetchImpl === undefined ? fetch : options.geocodeFetchImpl,
    pdfTextExtractImpl: options.pdfTextExtractImpl,
    assessApplication: assessImportedApplication,
    notifyImportChanges: (changes, sourceLabel) =>
      importNotificationsRepository.createMany(buildImportNotificationEntries(changes, sourceLabel))
  });
  const weeklySyncService = createWeeklySyncService({
    syncJobsRepository,
    applicationsSyncService,
    enabled:
      options.autoSyncEnabled ??
      (process.env.AUTO_SYNC_ENABLED
        ? process.env.AUTO_SYNC_ENABLED !== "false"
        : true),
    intervalMs:
      options.autoSyncIntervalMs ??
      Number(process.env.AUTO_SYNC_INTERVAL_HOURS ?? 168) * 60 * 60 * 1000,
    runOnStart: options.autoSyncRunOnStart ?? process.env.AUTO_SYNC_RUN_ON_START !== "false"
  });
  const initialAgisRefreshPromise = agisAssessmentEnabled && (options.agisRefreshOnStart ?? true)
    ? agisAssessmentService.refreshAll().catch((error) => {
        console.warn(`AGIS-Neubewertung beim Start fehlgeschlagen: ${error.message}`);
        return null;
      })
    : Promise.resolve(null);
  const maintenanceService = createMaintenanceService({
    db,
    dbPath: options.dbPath ?? getDefaultDbPath(),
    sessionsRepository,
    registrationKeysRepository,
    masterSetupKeysRepository,
    auditLogRepository,
    enabled: options.maintenanceEnabled ?? process.env.MAINTENANCE_ENABLED !== "false",
    intervalMs:
      options.maintenanceIntervalMs ??
      Number(process.env.MAINTENANCE_INTERVAL_HOURS ?? 24) * 60 * 60 * 1000,
    runOnStart: options.maintenanceRunOnStart ?? false,
    backupEnabled: options.backupEnabled ?? process.env.BACKUP_ENABLED === "true",
    backupDir: normalizeEnvString(options.backupDir ?? process.env.BACKUP_DIR ?? ""),
    backupRetention: Number(options.backupRetention ?? process.env.BACKUP_RETENTION ?? 7),
    auditRetentionDays: Number(options.auditRetentionDays ?? process.env.AUDIT_RETENTION_DAYS ?? 365),
    logger
  });
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(setCommonSecurityHeaders);
  if (options.compression !== false) {
    app.use(createCompressionMiddleware(typeof options.compression === "object" ? options.compression : {}));
  }
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", createCsrfOriginGuard({ enabled: options.csrfProtection !== false }));

  const healthDatabasePath = options.dbPath ?? getDefaultDbPath();
  app.get("/health", (_request, response) => handleHealthCheck(_request, response, healthDatabasePath));
  app.get("/api/health", (_request, response) => handleHealthCheck(_request, response, healthDatabasePath));

  app.get("/api/auth/users", (_request, response) => {
    response.json({
      items: usersRepository.listPublicUsers().map((user) => ({
        id: user.id,
        displayName: user.displayName,
        role: user.role
      }))
    });
  });

  app.get("/api/auth/session", (request, response) => {
    const currentSession = resolveCurrentUser(request, sessionsRepository, usersRepository);

    response.json({
      authenticated: Boolean(currentSession),
      user: currentSession?.user ?? null
    });
  });

  app.post("/api/auth/login", async (request, response) => {
    const rateLimitKey = request.ip || "unknown";

    if (loginRateLimiter) {
      const limitStatus = loginRateLimiter.check(rateLimitKey);

      if (limitStatus.limited) {
        response.setHeader("Retry-After", String(limitStatus.retryAfterSeconds));
        response
          .status(429)
          .json({ error: "Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen." });
        return;
      }
    }

    const validation = validateLoginPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const user = await usersRepository.authenticate(validation.value);

    if (!user) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      recordAudit("auth.login_failed", request, {
        target: validation.value.username || validation.value.userId || ""
      });
      response.status(401).json({ error: "Benutzer oder Passwort stimmen nicht." });
      return;
    }

    loginRateLimiter?.recordSuccess(rateLimitKey);

    const sessionId = randomBytes(24).toString("hex");
    const createdAt = nowIso();
    sessionsRepository.create({
      id: sessionId,
      userId: user.id,
      createdAt,
      expiresAt: buildSessionExpiry(new Date(createdAt))
    });

    recordAudit("auth.login", request, { actorUserId: user.id, actorName: user.displayName });
    response.setHeader("Set-Cookie", buildSessionCookie(sessionId, request));
    response.json({
      authenticated: true,
      user
    });
  });

  app.post("/api/auth/register", async (request, response) => {
    const validation = validateRegistrationPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    if (usersRepository.usernameExists(validation.value.username)) {
      response.status(409).json({ error: "Dieser Benutzername ist bereits vergeben." });
      return;
    }

    const currentTimestamp = nowIso();
    const invitationKey = registrationKeysRepository.getActiveByCode(validation.value.accessKey, currentTimestamp);

    if (!invitationKey) {
      response.status(400).json({ error: "Der Registrierungsschlüssel ist ungültig, abgelaufen oder bereits verwendet." });
      return;
    }

    // Passwort-Hash vor der Transaktion berechnen, damit die DB-Transaktion
    // selbst synchron (ohne await) bleibt.
    const passwordRecord = await createUserPasswordRecordAsync(validation.value.password);

    let user = null;

    db.exec("BEGIN");

    try {
      user = usersRepository.create({
        id: `USR-${randomBytes(6).toString("hex")}`,
        displayName: validation.value.displayName,
        username: validation.value.username,
        passwordRecord,
        role: validation.value.role,
        createdAt: currentTimestamp
      });

      const keyConsumed = registrationKeysRepository.markUsed({
        id: invitationKey.id,
        usedByUserId: user.id,
        usedAt: currentTimestamp,
        now: currentTimestamp
      });

      if (!keyConsumed) {
        throw new Error("registration-key-not-available");
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");

      if (error.message === "registration-key-not-available") {
        response.status(409).json({ error: "Der Registrierungsschlüssel wurde in der Zwischenzeit bereits verwendet." });
        return;
      }

      throw error;
    }

    const sessionId = randomBytes(24).toString("hex");
    sessionsRepository.create({
      id: sessionId,
      userId: user.id,
      createdAt: currentTimestamp,
      expiresAt: buildSessionExpiry(new Date(currentTimestamp))
    });

    recordAudit("auth.register", request, {
      actorUserId: user.id,
      actorName: user.displayName,
      target: user.username
    });
    response.setHeader("Set-Cookie", buildSessionCookie(sessionId, request));
    response.status(201).json({
      authenticated: true,
      user
    });
  });

  app.post("/api/auth/logout", (request, response) => {
    const currentSession = resolveCurrentUser(request, sessionsRepository, usersRepository);

    if (currentSession?.sessionId) {
      sessionsRepository.deleteById(currentSession.sessionId);
    }

    response.setHeader("Set-Cookie", buildExpiredSessionCookie(request));
    response.json({ authenticated: false });
  });

  // Ersteinrichtung des Master-Kontos ueber den per E-Mail zugestellten Setup-Key.
  // Erst danach hat das Master-Konto ein gueltiges Passwort.
  app.get("/api/auth/master-setup-status", (_request, response) => {
    const masterUserId = getMasterUserId();
    const setupRequired =
      !masterAccountPassword &&
      settingsRepository.getValue(masterPasswordConfiguredSettingKey) !== "1" &&
      Boolean(masterUserId) &&
      masterSetupKeysRepository.hasActiveForUser(masterUserId, nowIso());

    response.json({ setupRequired });
  });

  app.post("/api/auth/master-setup", async (request, response) => {
    const rateLimitKey = request.ip || "unknown";

    if (loginRateLimiter) {
      const limitStatus = loginRateLimiter.check(rateLimitKey);

      if (limitStatus.limited) {
        response.setHeader("Retry-After", String(limitStatus.retryAfterSeconds));
        response
          .status(429)
          .json({ error: "Zu viele Versuche. Bitte in einigen Minuten erneut versuchen." });
        return;
      }
    }

    const key = String(request.body?.key ?? "").trim();
    const passwordValidation = validatePasswordResetPayload(request.body ?? {});

    if (!key) {
      response.status(400).json({ error: "Bitte den Setup-Schluessel eingeben." });
      return;
    }

    if (passwordValidation.error) {
      response.status(400).json({ error: passwordValidation.error });
      return;
    }

    if (isPlaceholderPassword(passwordValidation.value.password)) {
      response.status(400).json({ error: "Bitte ein eigenes, sicheres Passwort waehlen." });
      return;
    }

    const now = nowIso();
    const setupKey = masterSetupKeysRepository.getActiveByKey(key, now);

    if (!setupKey) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      response.status(400).json({ error: "Der Setup-Schluessel ist ungueltig oder abgelaufen." });
      return;
    }

    // Passwort-Hash vor der Transaktion berechnen (Event-Loop nicht in der
    // Transaktion blockieren).
    const passwordRecord = await createUserPasswordRecordAsync(passwordValidation.value.password);

    db.exec("BEGIN");

    try {
      const consumed = masterSetupKeysRepository.markUsed({ id: setupKey.id, usedAt: now, now });

      if (!consumed) {
        throw new Error("master-setup-key-not-available");
      }

      const updated = usersRepository.applyPasswordRecord(setupKey.userId, passwordRecord, now);

      if (!updated) {
        throw new Error("master-user-not-found");
      }

      settingsRepository.setValue(masterPasswordConfiguredSettingKey, "1", now);
      masterSetupKeysRepository.deletePendingForUser(setupKey.userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");

      if (error.message === "master-setup-key-not-available") {
        response.status(400).json({ error: "Der Setup-Schluessel ist ungueltig oder abgelaufen." });
        return;
      }

      throw error;
    }

    loginRateLimiter?.recordSuccess(rateLimitKey);
    recordAudit("auth.master_setup", request, { target: "master" });
    response.json({ success: true, message: "Master-Passwort wurde gesetzt. Sie koennen sich jetzt anmelden." });
  });

  app.use("/api", (request, response, next) => {
    if (request.path === "/health" || request.path.startsWith("/auth/")) {
      next();
      return;
    }

    const currentSession = resolveCurrentUser(request, sessionsRepository, usersRepository);

    if (!currentSession) {
      response.setHeader("Set-Cookie", buildExpiredSessionCookie(request));
      response.status(401).json({ error: "Bitte zuerst anmelden." });
      return;
    }

    request.currentUser = currentSession.user;
    next();
  });

  app.get("/api/admin/registration-keys", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Registrierungsschlüssel verwalten." });
      return;
    }

    response.json({
      items: registrationKeysRepository.listRecent()
    });
  });

  app.post("/api/admin/registration-keys", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Registrierungsschlüssel verwalten." });
      return;
    }

    const validation = validateRegistrationKeyCreationPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const createdAt = nowIso();
    const createdKey = registrationKeysRepository.create({
      id: `KEY-${randomBytes(6).toString("hex")}`,
      keyCode: generateRegistrationKey(),
      note: validation.value.note,
      createdByUserId: request.currentUser.id,
      createdAt,
      expiresAt: buildRegistrationKeyExpiry(new Date(createdAt))
    });

    recordAudit("admin.registration_key.create", request, { target: createdKey.keyCode });
    response.status(201).json(createdKey);
  });

  app.delete("/api/admin/registration-keys/:id", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Registrierungsschlüssel verwalten." });
      return;
    }

    const existingKey = registrationKeysRepository.getById(request.params.id);

    if (!existingKey) {
      response.status(404).json({ error: "Registrierungsschlüssel nicht gefunden." });
      return;
    }

    if (existingKey.usedAt) {
      response.status(409).json({ error: "Bereits verwendete Registrierungsschlüssel können nicht gelöscht werden." });
      return;
    }

    const deleted = registrationKeysRepository.deleteUnusedById(request.params.id);

    if (!deleted) {
      response.status(409).json({ error: "Der Registrierungsschlüssel konnte nicht gelöscht werden." });
      return;
    }

    recordAudit("admin.registration_key.delete", request, { target: existingKey.keyCode });
    response.json({ deleted: true });
  });

  app.get("/api/admin/users", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Passwörter zurücksetzen." });
      return;
    }

    response.json({
      items: usersRepository.listForAdmin()
    });
  });

  app.patch("/api/admin/users/:id/password", async (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Passwörter zurücksetzen." });
      return;
    }

    const validation = validatePasswordResetPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const updatedUser = await usersRepository.resetPassword(request.params.id, validation.value.password);

    if (!updatedUser) {
      response.status(404).json({ error: "Benutzer nicht gefunden." });
      return;
    }

    recordAudit("admin.password_reset", request, {
      target: updatedUser.username ?? updatedUser.displayName
    });
    response.json({
      user: updatedUser,
      message: `Passwort für ${updatedUser.displayName} wurde aktualisiert.`
    });
  });

  app.get("/api/admin/audit-log", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf das Protokoll einsehen." });
      return;
    }

    response.json({
      items: auditLogRepository.listRecent(200)
    });
  });

  app.get("/api/admin/sync-settings", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf die Automatik verwalten." });
      return;
    }

    response.json({
      sourceUrl: settingsRepository.getValue("sync_source_url", normalizedSyncSourceUrl),
      sourceToken: settingsRepository.getValue("sync_source_token", normalizedSyncSourceToken),
      sourceType: settingsRepository.getValue("sync_source_type", normalizeEnvString(options.syncSourceType ?? process.env.SYNC_SOURCE_TYPE ?? "")),
      sourceMunicipality: settingsRepository.getValue(
        "sync_source_municipality",
        normalizeEnvString(options.syncSourceMunicipality ?? process.env.SYNC_SOURCE_MUNICIPALITY ?? "")
      ),
      municipalitySourcesSummary: municipalitySourcesRepository.getSummary(),
      syncStatus: weeklySyncService.getStatus()
    });
  });

  app.patch("/api/admin/sync-settings", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf die Automatik verwalten." });
      return;
    }

    const validation = validateSyncSettingsPayload(request.body ?? {});
    const currentTimestamp = nowIso();

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    if (!validation.value.sourceUrl) {
      settingsRepository.deleteByKey("sync_source_url");
      settingsRepository.deleteByKey("sync_source_token");
      settingsRepository.deleteByKey("sync_source_type");
      settingsRepository.deleteByKey("sync_source_municipality");
      weeklySyncService.refreshSchedule();
      response.json({
        sourceUrl: "",
        sourceToken: "",
        sourceType: "",
        sourceMunicipality: "",
        municipalitySourcesSummary: municipalitySourcesRepository.getSummary(),
        syncStatus: weeklySyncService.getStatus(),
        message: "Die automatische Import-Quelle wurde entfernt."
      });
      return;
    }

    const normalizedSourceUrlFromInput = normalizeSyncSourceUrl(validation.value.sourceUrl, { warn() {} });

    if (!normalizedSourceUrlFromInput) {
      response.status(400).json({
        error: "Bitte eine gültige Website-, JSON-, PDF-, AGIS- oder ArcGIS-URL mit http:// oder https:// eingeben."
      });
      return;
    }

    const storedSetting = settingsRepository.setValue(
      "sync_source_url",
      normalizedSourceUrlFromInput,
      currentTimestamp
    );
    const storedToken = validation.value.sourceToken
      ? settingsRepository.setValue("sync_source_token", validation.value.sourceToken, currentTimestamp)
      : (settingsRepository.deleteByKey("sync_source_token"), null);
    const storedType = validation.value.sourceType
      ? settingsRepository.setValue("sync_source_type", validation.value.sourceType, currentTimestamp)
      : (settingsRepository.deleteByKey("sync_source_type"), null);
    const storedMunicipality = validation.value.sourceMunicipality
      ? settingsRepository.setValue("sync_source_municipality", validation.value.sourceMunicipality, currentTimestamp)
      : (settingsRepository.deleteByKey("sync_source_municipality"), null);
    weeklySyncService.refreshSchedule();

    response.json({
      sourceUrl: storedSetting.value,
      sourceToken: storedToken?.value ?? "",
      sourceType: storedType?.value ?? "",
      sourceMunicipality: storedMunicipality?.value ?? "",
      municipalitySourcesSummary: municipalitySourcesRepository.getSummary(),
      syncStatus: weeklySyncService.getStatus(),
      message: "Die automatische Import-Quelle wurde gespeichert."
    });
  });

  app.get("/api/admin/municipality-sources", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Gemeindequellen verwalten." });
      return;
    }

    const coverageSnapshot = municipalitySourcesRepository.getCoverageSnapshot(
      String(request.query.search ?? "").trim()
    );

    response.json({
      items: municipalitySourcesRepository.listAll(),
      summary: municipalitySourcesRepository.getSummary(),
      catalogItems: coverageSnapshot.catalogItems,
      sharedSources: coverageSnapshot.sharedSources,
      report: coverageSnapshot.report,
      sourceTypes: municipalitySourceTypes,
      digitalStatuses: municipalityDigitalStatuses,
      ratingScale: {
        A: "sehr gut",
        B: "mittel",
        C: "schwach",
        D: "sehr schwach"
      }
    });
  });

  app.get("/api/admin/municipality-sources/export.json", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Gemeindequellen exportieren." });
      return;
    }

    response.json({
      generatedAt: nowIso(),
      rows: municipalitySourcesRepository.exportCoverageRows(),
      report: municipalitySourcesRepository.getCoverageReport(),
      sharedSources: municipalitySourcesRepository.listSharedSources(25)
    });
  });

  app.get("/api/admin/municipality-sources/export.csv", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Gemeindequellen exportieren." });
      return;
    }

    const csv = buildCsvResponse(municipalitySourcesRepository.exportCoverageRows());
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="aargau-gemeindequellen-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    response.send(csv);
  });

  app.patch("/api/admin/municipality-sources/:id", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Gemeindequellen verwalten." });
      return;
    }

    const validation = validateMunicipalitySourcePayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const updated = municipalitySourcesRepository.update(request.params.id, validation.value, nowIso());

    if (!updated) {
      response.status(404).json({ error: "Gemeindequelle nicht gefunden." });
      return;
    }

    weeklySyncService.refreshSchedule();
    const coverageSnapshot = municipalitySourcesRepository.getCoverageSnapshot();
    response.json({
      item: updated,
      summary: municipalitySourcesRepository.getSummary(),
      catalogItems: coverageSnapshot.catalogItems,
      sharedSources: coverageSnapshot.sharedSources,
      report: coverageSnapshot.report,
      message: `Gemeindequelle für ${updated.municipality} gespeichert.`
    });
  });

  app.post("/api/admin/import-json", async (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Exporte importieren." });
      return;
    }

    const validation = validateManualImportPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    let parsedPayload = null;

    try {
      parsedPayload = JSON.parse(validation.value.jsonText);
    } catch {
      response.status(400).json({ error: "Der eingefügte Text ist kein gültiges JSON." });
      return;
    }

    const importedItems = normalizeImportedPayload(parsedPayload, agisBaugesucheDatendocUrl);

    if (!importedItems.length) {
      response.status(400).json({
        error:
          "Im JSON wurden keine Baugesuche erkannt. Erwartet wird ein AGIS/eBau-Export mit items oder features."
      });
      return;
    }

    const assessedItems = [];

    for (const item of importedItems) {
      if (typeof assessImportedApplication === "function") {
        assessedItems.push((await assessImportedApplication(item)) ?? item);
        continue;
      }

      assessedItems.push(item);
    }

    const importResult = repository.importItems(assessedItems, nowIso());
    const notificationCount = importNotificationsRepository.createMany(
      buildImportNotificationEntries(importResult.changes, "JSON-Import")
    );

    response.json({
      ...importResult,
      source: "manual-json-import",
      notificationCount,
      message: `${importResult.importedCount} neue und ${importResult.updatedCount} bestehende Baugesuche aus dem JSON-Export verarbeitet.`
    });
  });

  app.get("/api/dashboard", (_request, response) => {
    response.json({
      ...repository.getDashboard(),
      municipalitySourcesSummary: municipalitySourcesRepository.getSummary(),
      notifications: importNotificationsRepository.listRecent(),
      syncStatus: weeklySyncService.getStatus(),
      protectionStatuses,
      workflowStatuses
    });
  });

  app.get("/api/sync/status", (_request, response) => {
    response.json(weeklySyncService.getStatus());
  });

  app.get("/api/applications", (request, response) => {
    const filters = {
      search: request.query.search ?? "",
      municipality: request.query.municipality ?? "",
      protectionStatus: request.query.protectionStatus ?? "",
      workflowStatus: request.query.workflowStatus ?? "",
      source: request.query.source ?? ""
    };

    const items = repository.list(filters);
    response.json({
      items,
      total: items.length
    });
  });

  app.get("/api/applications/:id", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json(item);
  });

  app.get("/api/applications/:id/comments", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json({
      items: commentsRepository.listByApplication(request.params.id)
    });
  });

  app.post("/api/applications/:id/comments", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    const validation = validateCommentPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const created = commentsRepository.create({
      id: `COM-${randomBytes(8).toString("hex")}`,
      applicationId: request.params.id,
      userId: request.currentUser.id,
      message: validation.value.message,
      createdAt: nowIso()
    });

    response.status(201).json(created);
  });

  app.patch("/api/applications/:id", (request, response) => {
    const validation = validateApplicationPatch(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const updated = repository.update(request.params.id, validation.value);

    if (!updated) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json(updated);
  });

  app.post("/api/sync", async (_request, response) => {
    const apiConfigured = applicationsSyncService.isConfigured();
    const result = apiConfigured
      ? await weeklySyncService.runNow()
      : await applicationsSyncService.sync();

    response.json({
      ...result,
      message: apiConfigured
        ? `API-Sync abgeschlossen. ${result.importedCount ?? 0} neu, ${result.updatedCount ?? 0} aktualisiert.`
        : result.imported
          ? "Ein neues Amtsblatt-Gesuch wurde in die Datenbank übernommen."
          : "Keine weiteren Demo-Gesuche zum Import vorhanden."
    });
  });

  app.get("/api/agis/features", async (request, response) => {
    const east = Number(request.query.east);
    const north = Number(request.query.north);

    if (!Number.isFinite(east) || !Number.isFinite(north)) {
      response.status(400).json({
        error: "east and north query parameters must be valid numbers"
      });
      return;
    }

    try {
      const payload = await agisGeometryService.getOfficialFeatures({ east, north });
      response.json(payload);
    } catch (error) {
      console.error(error);
      response.status(502).json({
        error: "AGIS-Geometrien konnten im Moment nicht geladen werden."
      });
    }
  });

  app.use(express.static(publicDir, {
    etag: true,
    lastModified: true,
    setHeaders: setStaticAssetHeaders
  }));
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(join(publicDir, "index.html"));
  });

  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    console.error(error);
    response.status(500).json({ error: "Unexpected server error" });
  });

  weeklySyncService.start();
  maintenanceService.start();

  return {
    app,
    db,
    maintenanceService,
    ready: Promise.all([initialAgisRefreshPromise, masterSetupReadyPromise]),
    stopBackgroundJobs() {
      weeklySyncService.stop();
      maintenanceService.stop();
    }
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === currentFile;

// Kantonsweite Standardquelle: Das offizielle Amtsblatt (amtsblatt.ag.ch) listet
// alle "Bau- und Rodungsgesuche" des ganzen Kantons zentral. Es wird beim
// produktiven Start automatisch als Quelle genutzt, damit die Datenbank ohne
// weitere Konfiguration moeglichst vollstaendig alle wichtigen Baugesuche erfasst.
const defaultCantonSyncSourceUrl = "https://amtsblatt.ag.ch/publikationen/";

if (isDirectRun) {
  validateProductionRuntimeConfiguration();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  // Eine per SYNC_SOURCE_URL gesetzte Quelle hat Vorrang. Ist nichts gesetzt,
  // wird das Amtsblatt als kantonsweite Vollquelle aktiviert. Abschaltbar mit
  // SYNC_DISABLE_DEFAULT_AMTSBLATT=true (dann gelten nur die Gemeindequellen).
  const configuredSyncSourceUrl = normalizeEnvString(process.env.SYNC_SOURCE_URL ?? "");
  const defaultAmtsblattDisabled =
    String(process.env.SYNC_DISABLE_DEFAULT_AMTSBLATT ?? "").toLowerCase() === "true";
  const effectiveSyncSourceUrl =
    configuredSyncSourceUrl || (defaultAmtsblattDisabled ? "" : defaultCantonSyncSourceUrl);

  const { app, ready } = createApp({
    agisAssessmentEnabled: true,
    agisRefreshOnStart: process.env.AGIS_REFRESH_ON_START !== "false",
    syncSourceUrl: effectiveSyncSourceUrl
  });

  await ready;

  app.listen(port, () => {
    console.log(`Heimatschutz Aargau läuft auf Port ${port}.`);
  });
}
