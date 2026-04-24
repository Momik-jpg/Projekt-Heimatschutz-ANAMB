import express from "express";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createSessionsRepository } from "./repository/sessionsRepository.js";
import { createSettingsRepository } from "./repository/settingsRepository.js";
import { createSyncJobsRepository } from "./repository/syncJobsRepository.js";
import { createUsersRepository } from "./repository/usersRepository.js";
import {
  createApplicationsRepository,
  protectionStatuses,
  workflowStatuses
} from "./repository/applicationsRepository.js";
import { defaultMasterPassword, defaultSeedPassword } from "./seed/users.js";

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
  defaultMasterPassword,
  defaultSeedPassword,
  "dein_sicheres_master_passwort",
  "dein_sicheres_team_passwort",
  "eigenesmasterpasswort",
  "eigenessicherespasswort",
  "bittemasterpasswortvordemreleaseaendern123",
  "bittevordemreleaseaendern123"
]);
const placeholderSyncSourceMarkers = ["example.test", "beispiel", "placeholder"];

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
  const errors = [];

  if (!masterPassword) {
    errors.push("MASTER_ACCOUNT_PASSWORD fehlt.");
  } else if (isPlaceholderPassword(masterPassword)) {
    errors.push("MASTER_ACCOUNT_PASSWORD verwendet noch einen Platzhalter oder das Standardpasswort.");
  }

  if (!defaultLoginPassword) {
    errors.push("DEFAULT_LOGIN_PASSWORD fehlt.");
  } else if (isPlaceholderPassword(defaultLoginPassword)) {
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
  const normalizedSyncSourceUrl = normalizeSyncSourceUrl(
    options.syncSourceUrl ?? process.env.SYNC_SOURCE_URL ?? "",
    options.logger ?? console
  );
  const normalizedSyncSourceToken = normalizeEnvString(
    options.syncSourceToken ?? process.env.SYNC_SOURCE_TOKEN ?? ""
  );
  const db = createDatabase(options.dbPath ?? getDefaultDbPath(), {
    seedDemoApplications: options.seedDemoApplications
  });
  const repository = createApplicationsRepository(db);
  const commentsRepository = createCommentsRepository(db);
  const importNotificationsRepository = createImportNotificationsRepository(db);
  const municipalitySourcesRepository = createMunicipalitySourcesRepository(db);
  const registrationKeysRepository = createRegistrationKeysRepository(db);
  const sessionsRepository = createSessionsRepository(db);
  const settingsRepository = createSettingsRepository(db);
  const syncJobsRepository = createSyncJobsRepository(db);
  const usersRepository = createUsersRepository(db);
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
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));

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

  app.post("/api/auth/login", (request, response) => {
    const validation = validateLoginPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const user = usersRepository.authenticate(validation.value);

    if (!user) {
      response.status(401).json({ error: "Benutzer oder Passwort stimmen nicht." });
      return;
    }

    const sessionId = randomBytes(24).toString("hex");
    const createdAt = nowIso();
    sessionsRepository.create({
      id: sessionId,
      userId: user.id,
      createdAt,
      expiresAt: buildSessionExpiry(new Date(createdAt))
    });

    response.setHeader("Set-Cookie", buildSessionCookie(sessionId, request));
    response.json({
      authenticated: true,
      user
    });
  });

  app.post("/api/auth/register", (request, response) => {
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

    let user = null;

    db.exec("BEGIN");

    try {
      user = usersRepository.create({
        id: `USR-${randomBytes(6).toString("hex")}`,
        displayName: validation.value.displayName,
        username: validation.value.username,
        password: validation.value.password,
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

  app.patch("/api/admin/users/:id/password", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Passwörter zurücksetzen." });
      return;
    }

    const validation = validatePasswordResetPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const updatedUser = usersRepository.resetPassword(request.params.id, validation.value.password);

    if (!updatedUser) {
      response.status(404).json({ error: "Benutzer nicht gefunden." });
      return;
    }

    response.json({
      user: updatedUser,
      message: `Passwort für ${updatedUser.displayName} wurde aktualisiert.`
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

  app.use(express.static(publicDir));
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(join(publicDir, "index.html"));
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Unexpected server error" });
  });

  weeklySyncService.start();

  return {
    app,
    db,
    ready: initialAgisRefreshPromise,
    stopBackgroundJobs() {
      weeklySyncService.stop();
    }
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === currentFile;

if (isDirectRun) {
  validateProductionRuntimeConfiguration();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const { app, ready } = createApp({
    agisAssessmentEnabled: true,
    agisRefreshOnStart: process.env.AGIS_REFRESH_ON_START !== "false"
  });

  await ready;

  app.listen(port, () => {
    console.log(`Heimatschutz Aargau läuft auf Port ${port}.`);
  });
}
