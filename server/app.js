import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, getDefaultDbPath } from "./db.js";
import { createAgisAssessmentService } from "./services/agisAssessmentService.js";
import { createAgisGeometryService } from "./services/agisGeometryService.js";
import { createApplicationsSyncService } from "./services/applicationsSyncService.js";
import { createWeeklySyncService } from "./services/weeklySyncService.js";
import { createCommentsRepository } from "./repository/commentsRepository.js";
import { createImportNotificationsRepository } from "./repository/importNotificationsRepository.js";
import { createMunicipalitySourcesRepository } from "./repository/municipalitySourcesRepository.js";
import { createRegistrationKeysRepository } from "./repository/registrationKeysRepository.js";
import {
  createMasterSetupKeysRepository,
  hashSetupKey
} from "./repository/masterSetupKeysRepository.js";
import { createPasswordResetKeysRepository } from "./repository/passwordResetKeysRepository.js";
import { createSessionsRepository } from "./repository/sessionsRepository.js";
import { createSettingsRepository } from "./repository/settingsRepository.js";
import { createSyncJobsRepository } from "./repository/syncJobsRepository.js";
import { createAuditLogRepository } from "./repository/auditLogRepository.js";
import { createUsersRepository } from "./repository/usersRepository.js";
import { createApplicationsRepository } from "./repository/applicationsRepository.js";
import { createApplicationLearningRepository } from "./repository/applicationLearningRepository.js";
import { createApplicationReadsRepository } from "./repository/applicationReadsRepository.js";
import { createMailService } from "./services/mailService.js";
import { createMaintenanceService } from "./services/maintenanceService.js";
import { decryptToken } from "./services/tokenCrypto.js";
import { sanitizeForLog } from "./logSafe.js";
import { createGracefulShutdown } from "./gracefulShutdown.js";

import {
  publicDir,
  nowIso,
  normalizeEnvString,
  normalizeSyncSourceUrl,
  validateProductionRuntimeConfiguration,
  generateMasterSetupKey,
  buildMasterSetupExpiry,
  buildExpiredSessionCookie,
  createCsrfOriginGuard,
  setCommonSecurityHeaders,
  setStaticAssetHeaders,
  createCompressionMiddleware,
  createLoginRateLimiter,
  verifyTurnstileToken,
  resolveTrustProxySetting,
  resolveCurrentUser,
  handleHealthCheck,
  buildImportNotificationEntries
} from "./httpSupport.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerAdminRoutes } from "./routes/adminRoutes.js";
import { registerApplicationRoutes } from "./routes/applicationRoutes.js";
import { registerSyncRoutes } from "./routes/syncRoutes.js";

// Für die Test-Suite weiterhin aus app.js erreichbar.
export { normalizeSyncSourceUrl, validateProductionRuntimeConfiguration };

export function createApp(options = {}) {
  const logger = options.logger ?? console;
  const normalizedSyncSourceUrl = normalizeSyncSourceUrl(
    options.syncSourceUrl ?? process.env.SYNC_SOURCE_URL ?? "",
    logger
  );
  const normalizedSyncSourceToken = normalizeEnvString(
    options.syncSourceToken ?? process.env.SYNC_SOURCE_TOKEN ?? ""
  );
  const healthInstanceId = normalizeEnvString(
    options.healthInstanceId ?? (process.env.NODE_ENV === "test" ? process.env.E2E_INSTANCE_ID : "")
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
  const applicationLearningRepository = createApplicationLearningRepository(db);
  const applicationReadsRepository = createApplicationReadsRepository(db);
  const commentsRepository = createCommentsRepository(db);
  const importNotificationsRepository = createImportNotificationsRepository(db);
  const municipalitySourcesRepository = createMunicipalitySourcesRepository(db);
  const registrationKeysRepository = createRegistrationKeysRepository(db);
  const masterSetupKeysRepository = createMasterSetupKeysRepository(db);
  const passwordResetKeysRepository = createPasswordResetKeysRepository(db);
  const sessionsRepository = createSessionsRepository(db);
  const settingsRepository = createSettingsRepository(db);
  const syncJobsRepository = createSyncJobsRepository(db);
  const auditLogRepository = createAuditLogRepository(db);
  const usersRepository = createUsersRepository(db);
  const mailService = options.mailService ?? createMailService({ logger });

  // Cloudflare Turnstile (Bot-Schutz). Ohne konfigurierte Keys vollständig
  // deaktiviert, damit lokale/Test-Läufe ohne externe Abhängigkeit funktionieren.
  const turnstileSiteKey = normalizeEnvString(options.turnstileSiteKey ?? process.env.TURNSTILE_SITE_KEY ?? "");
  const turnstileSecretKey = normalizeEnvString(options.turnstileSecretKey ?? process.env.TURNSTILE_SECRET_KEY ?? "");
  const turnstileVerifyImpl = options.turnstileVerify ?? verifyTurnstileToken;
  const turnstileEnabled =
    Boolean(turnstileSiteKey) && (Boolean(turnstileSecretKey) || typeof options.turnstileVerify === "function");

  async function passesTurnstile(request) {
    if (!turnstileEnabled) {
      return true;
    }

    const token = String(request.body?.turnstileToken ?? "").trim();

    if (!token) {
      return false;
    }

    try {
      return Boolean(await turnstileVerifyImpl(token, turnstileSecretKey, request.ip));
    } catch (error) {
      logger.warn?.(`Turnstile-Prüfung fehlgeschlagen: ${sanitizeForLog(error.message)}`);
      return false;
    }
  }

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
  const masterTotpEnabledSettingKey = "master_totp_enabled";
  const masterTotpSecretSettingKey = "master_totp_secret";
  const masterTotpPendingSecretSettingKey = "master_totp_pending_secret";

  function canUseMailDelivery(sentTo) {
    return Boolean(
      sentTo &&
        typeof mailService.sendMail === "function" &&
        (typeof mailService.isConfigured !== "function" || mailService.isConfigured())
    );
  }

  function canDeliverMasterSetupKey() {
    return typeof options.onMasterSetupKey === "function" || canUseMailDelivery(masterSetupEmail);
  }

  function canDeliverPasswordResetKey(contact) {
    return typeof options.onPasswordResetKey === "function" || canUseMailDelivery(contact?.email);
  }

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
      "für das Master-Konto der Heimatschutz-Aargau-Anwendung wurde eine Ersteinrichtung angefordert.",
      'Bitte öffnen Sie die Anwendung, wählen Sie "Master-Konto einrichten" und geben Sie den folgenden',
      "Einmal-Schlüssel zusammen mit Ihrem neuen Passwort ein:",
      "",
      `    ${key}`,
      "",
      `Der Schlüssel ist gültig bis ${expiresAt}.`,
      "Falls Sie diese Einrichtung nicht angefordert haben, können Sie diese E-Mail ignorieren.",
      "",
      "Heimatschutz Aargau"
    ].join("\n");

    if (canUseMailDelivery(sentTo)) {
      await mailService.sendMail({ to: sentTo, subject, text });
      logger.log?.("Master-Setup-Key per E-Mail versendet.");
      return;
    }

    throw new Error("Master-Setup-Key kann nicht sicher zugestellt werden (SMTP oder Empfänger fehlt).");
  }

  async function deliverPasswordResetKey({ key, sentTo, displayName, expiresAt }) {
    // Test-/Integrationshook: erlaubt das direkte Abfangen des Klartext-Keys.
    if (typeof options.onPasswordResetKey === "function") {
      await options.onPasswordResetKey({ key, sentTo, expiresAt });
      return;
    }

    const subject = "Heimatschutz Aargau – Passwort zurücksetzen";
    const text = [
      `${`Hallo ${displayName || ""}`.trim()},`,
      "",
      "für Ihr Konto wurde ein Passwort-Reset angefordert. Bitte öffnen Sie die Anwendung,",
      'wählen Sie "Passwort vergessen" und geben Sie den folgenden Einmal-Schlüssel zusammen',
      "mit Ihrem neuen Passwort ein:",
      "",
      `    ${key}`,
      "",
      `Der Schlüssel ist gültig bis ${expiresAt}.`,
      "Falls Sie keinen Reset angefordert haben, können Sie diese E-Mail ignorieren.",
      "",
      "Heimatschutz Aargau"
    ].join("\n");

    if (canUseMailDelivery(sentTo)) {
      await mailService.sendMail({ to: sentTo, subject, text });
      logger.log?.("Passwort-Reset-Key per E-Mail versendet.");
      return;
    }

    throw new Error("Passwort-Reset-Key kann nicht sicher zugestellt werden (SMTP fehlt).");
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

    if (!canDeliverMasterSetupKey()) {
      logger.warn?.(
        "Master-Setup-Key wurde nicht erzeugt: Bitte MASTER_ACCOUNT_PASSWORD setzen oder SMTP + MASTER_SETUP_EMAIL konfigurieren."
      );
      return;
    }

    masterSetupKeysRepository.deletePendingForUser(masterUserId);

    const key = generateMasterSetupKey();
    const expiresAt = buildMasterSetupExpiry(new Date(now));

    const setupKeyId = `MSK-${randomBytes(8).toString("hex")}`;
    masterSetupKeysRepository.create({
      id: setupKeyId,
      userId: masterUserId,
      keyHash: hashSetupKey(key),
      sentTo: masterSetupEmail,
      createdAt: now,
      expiresAt
    });

    try {
      await deliverMasterSetupKey({ key, sentTo: masterSetupEmail, expiresAt });
    } catch (error) {
      masterSetupKeysRepository.deleteById(setupKeyId);
      throw error;
    }
  }

  const masterSetupReadyPromise = ensureMasterAccountReady().catch((error) => {
    logger.warn?.(`Master-Setup konnte nicht abgeschlossen werden: ${sanitizeForLog(error.message)}`);
    throw error;
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
  const assessImportedApplication = async (item) => {
    const learned = applicationLearningRepository.applyToItem(item);
    const learnedItem = learned.item ?? item;
    const canUseOfficialAgis =
      agisAssessmentEnabled &&
      String(learnedItem.coordinates ?? "").trim() &&
      !learnedItem.ambiguousAddress;

    if (!canUseOfficialAgis) {
      return learnedItem;
    }

    const assessment = await agisAssessmentService.assessItem(learnedItem);
    return assessment ? { ...learnedItem, ...assessment } : learnedItem;
  };
  const applicationsSyncService = createApplicationsSyncService({
    repository,
    sourceUrl: normalizedSyncSourceUrl,
    getSourceUrl: () => settingsRepository.getValue("sync_source_url", normalizedSyncSourceUrl),
    sourceToken: normalizedSyncSourceToken,
    getSourceToken: () => decryptToken(settingsRepository.getValue("sync_source_token", normalizedSyncSourceToken)),
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
        console.warn(`AGIS-Neubewertung beim Start fehlgeschlagen: ${sanitizeForLog(error.message)}`);
        return null;
      })
    : Promise.resolve(null);
  const maintenanceService = createMaintenanceService({
    db,
    dbPath: options.dbPath ?? getDefaultDbPath(),
    sessionsRepository,
    registrationKeysRepository,
    masterSetupKeysRepository,
    passwordResetKeysRepository,
    auditLogRepository,
    applicationsRepository: repository,
    enabled: options.maintenanceEnabled ?? process.env.MAINTENANCE_ENABLED !== "false",
    intervalMs:
      options.maintenanceIntervalMs ??
      (process.env.MAINTENANCE_INTERVAL_HOURS
        ? Number(process.env.MAINTENANCE_INTERVAL_HOURS) * 60 * 60 * 1000
        : null),
    runOnStart: options.maintenanceRunOnStart ?? true,
    backupEnabled: options.backupEnabled ?? process.env.BACKUP_ENABLED === "true",
    backupDir: normalizeEnvString(options.backupDir ?? process.env.BACKUP_DIR ?? ""),
    backupRetention: Number(options.backupRetention ?? process.env.BACKUP_RETENTION ?? 7),
    auditRetentionDays: Number(options.auditRetentionDays ?? process.env.AUDIT_RETENTION_DAYS ?? 365),
    logger
  });
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", resolveTrustProxySetting(options.trustProxy ?? process.env.TRUST_PROXY));
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1200,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({ error: "Zu viele Anfragen. Bitte versuchen Sie es später erneut." });
    }
  }));
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
  const healthHandler = (request, response) => {
    if (healthInstanceId) {
      response.setHeader("X-E2E-Instance-Id", healthInstanceId);
    }
    handleHealthCheck(request, response, healthDatabasePath);
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // Hinweis: Der frühere oeffentliche Endpoint GET /api/auth/users wurde entfernt
  // (S6). Er lieferte ohne Anmeldung interne User-IDs, Anzeigenamen und Rollen und
  // wurde vom Frontend nicht genutzt. Benutzerlisten gibt es nur noch unter
  // /api/admin/users (Master-Recht erforderlich).

const routeContext = {
    db,
    logger,
    options,
    loginRateLimiter,
    turnstileEnabled,
    turnstileSiteKey,
    passesTurnstile,
    recordAudit,
    getMasterUserId,
    canDeliverPasswordResetKey,
    deliverPasswordResetKey,
    assessImportedApplication,
    masterAccountPassword,
    normalizedSyncSourceUrl,
    normalizedSyncSourceToken,
    masterPasswordConfiguredSettingKey,
    masterTotpEnabledSettingKey,
    masterTotpSecretSettingKey,
    masterTotpPendingSecretSettingKey,
    repository,
    applicationLearningRepository,
    applicationReadsRepository,
    commentsRepository,
    importNotificationsRepository,
    municipalitySourcesRepository,
    registrationKeysRepository,
    masterSetupKeysRepository,
    passwordResetKeysRepository,
    sessionsRepository,
    settingsRepository,
    auditLogRepository,
    usersRepository,
    agisGeometryService,
    applicationsSyncService,
    weeklySyncService
  };

  registerAuthRoutes(app, routeContext);

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

  registerAdminRoutes(app, routeContext);
  registerApplicationRoutes(app, routeContext);
  registerSyncRoutes(app, routeContext);

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

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Kantonsweite Standardquelle: Das offizielle Amtsblatt (amtsblatt.ag.ch) listet
// alle "Bau- und Rodungsgesuche" des ganzen Kantons zentral. Es wird beim
// produktiven Start automatisch als Quelle genutzt, damit die Datenbank ohne
// weitere Konfiguration möglichst vollständig alle wichtigen Baugesuche erfasst.
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

  const { app, db, ready, stopBackgroundJobs } = createApp({
    agisAssessmentEnabled: true,
    agisRefreshOnStart: process.env.AGIS_REFRESH_ON_START !== "false",
    syncSourceUrl: effectiveSyncSourceUrl
  });

  await ready;

  const server = app.listen(port, () => {
    console.log(`Heimatschutz Aargau läuft auf Port ${port}.`);
  });

  const shutdown = createGracefulShutdown({
    server,
    stopBackgroundJobs,
    closeDatabase: () => db.close()
  });

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
