import express from "express";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
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
import {
  createMasterSetupKeysRepository,
  hashSetupKey
} from "./repository/masterSetupKeysRepository.js";
import {
  createPasswordResetKeysRepository,
  hashResetKey
} from "./repository/passwordResetKeysRepository.js";
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
import { createApplicationLearningRepository } from "./repository/applicationLearningRepository.js";
import { createApplicationReadsRepository } from "./repository/applicationReadsRepository.js";
import { createMailService } from "./services/mailService.js";
import { createMaintenanceService } from "./services/maintenanceService.js";
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from "./services/totp.js";

import {
  gzipAsync,
  currentDir,
  rootDir,
  publicDir,
  sessionCookieName,
  sessionMaxAgeSeconds,
  registrationKeyLifetimeDays,
  agisBaugesucheDatendocUrl,
  placeholderPasswordValues,
  placeholderSyncSourceMarkers,
  contentSecurityPolicy,
  municipalitySourcePatternMaxLength,
  municipalitySourcePatternMaxTerms,
  municipalitySourcePatternTermMaxLength,
  municipalitySourcePatternUnsupportedChars,
  nowIso,
  buildSessionExpiry,
  buildRegistrationKeyExpiry,
  normalizeEnvString,
  normalizeHttpUrl,
  looksLikeEmailAddress,
  validateMunicipalitySourceSearchPattern,
  looksLikeMachineReadableSourceUrl,
  normalizeSecretForComparison,
  isPlaceholderPassword,
  normalizeSyncSourceUrl,
  validateProductionRuntimeConfiguration,
  generateRegistrationKey,
  masterSetupKeyLifetimeHours,
  generateMasterSetupKey,
  buildMasterSetupExpiry,
  passwordResetKeyLifetimeHours,
  generatePasswordResetKey,
  buildPasswordResetExpiry,
  normalizeRegistrationKey,
  parseCookies,
  isSecureRequest,
  buildSessionCookie,
  buildExpiredSessionCookie,
  csrfProtectedMethods,
  getRequestHosts,
  createCsrfOriginGuard,
  setCommonSecurityHeaders,
  setStaticAssetHeaders,
  compressibleContentTypePattern,
  isCompressibleContentType,
  appendVaryHeader,
  createCompressionMiddleware,
  createLoginRateLimiter,
  verifyTurnstileToken,
  validateLoginPayload,
  validateRegistrationPayload,
  validateRegistrationKeyCreationPayload,
  validatePasswordResetPayload,
  validateManualImportPayload,
  looksLikeAmtsblattUrl,
  validateSyncSettingsPayload,
  validateMunicipalitySourcePayload,
  validateCommentPayload,
  resolveCurrentUser,
  isMasterUser,
  handleHealthCheck,
  escapeCsvValue,
  buildCsvResponse,
  validateApplicationPatch,
  shouldCreateImportNotification,
  buildImportNotificationEntries
} from "./httpSupport.js";

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
      logger.warn?.(`Turnstile-Prüfung fehlgeschlagen: ${error.message}`);
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
      `Hallo ${displayName || ""}`.trim() + ",",
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

    // Bot-Prüfung erst ab dem 2. Versuch (nach einem vorherigen Fehlschlag).
    if (turnstileEnabled && loginRateLimiter?.requiresChallenge(rateLimitKey)) {
      if (!(await passesTurnstile(request))) {
        response.status(401).json({ error: "Bitte die Bot-Prüfung abschliessen.", captchaRequired: true });
        return;
      }
    }

    const user = await usersRepository.authenticate(validation.value);

    if (!user) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      recordAudit("auth.login_failed", request, {
        target: validation.value.username || validation.value.userId || ""
      });
      // Nach einem Fehlversuch verlangt der nächste Versuch eine Bot-Prüfung.
      response.status(401).json({
        error: "Benutzer oder Passwort stimmen nicht.",
        captchaRequired: turnstileEnabled
      });
      return;
    }

    // Zweiter Faktor (TOTP) für das Master-Konto, falls aktiviert.
    if (isMasterUser(user) && settingsRepository.getValue(masterTotpEnabledSettingKey) === "1") {
      const totpCode = String(request.body?.totp ?? "").trim();
      const secret = settingsRepository.getValue(masterTotpSecretSettingKey);

      if (!totpCode) {
        response.status(401).json({ error: "2FA-Code erforderlich.", totpRequired: true });
        return;
      }

      if (!secret || !verifyTotp(secret, totpCode)) {
        loginRateLimiter?.recordFailure(rateLimitKey);
        recordAudit("auth.login_2fa_failed", request, { actorUserId: user.id, actorName: user.displayName });
        response.status(401).json({ error: "2FA-Code ist ungültig.", totpRequired: true });
        return;
      }
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

    if (!(await passesTurnstile(request))) {
      response.status(400).json({ error: "Bitte die Bot-Prüfung abschliessen.", captchaRequired: true });
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
        email: validation.value.email,
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

  // Ersteinrichtung des Master-Kontos über den per E-Mail zugestellten Setup-Key.
  // Erst danach hat das Master-Konto ein gültiges Passwort.
  // Öffentliche Client-Konfiguration (z. B. Turnstile-Site-Key fürs Widget).
  app.get("/api/auth/config", (_request, response) => {
    response.json({
      turnstile: {
        enabled: turnstileEnabled,
        siteKey: turnstileEnabled ? turnstileSiteKey : ""
      }
    });
  });

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
      response.status(400).json({ error: "Bitte den Setup-Schlüssel eingeben." });
      return;
    }

    if (passwordValidation.error) {
      response.status(400).json({ error: passwordValidation.error });
      return;
    }

    if (isPlaceholderPassword(passwordValidation.value.password)) {
      response.status(400).json({ error: "Bitte ein eigenes, sicheres Passwort wählen." });
      return;
    }

    const now = nowIso();
    const setupKey = masterSetupKeysRepository.getActiveByKey(key, now);

    if (!setupKey) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      response.status(400).json({ error: "Der Setup-Schlüssel ist ungültig oder abgelaufen." });
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
        response.status(400).json({ error: "Der Setup-Schlüssel ist ungültig oder abgelaufen." });
        return;
      }

      throw error;
    }

    loginRateLimiter?.recordSuccess(rateLimitKey);
    recordAudit("auth.master_setup", request, { target: "master" });
    response.json({ success: true, message: "Master-Passwort wurde gesetzt. Sie können sich jetzt anmelden." });
  });

  // Self-Service Passwort vergessen: schickt einen Einmal-Key an die hinterlegte
  // E-Mail. Antwortet immer gleich (kein Rückschluss, ob Konto/E-Mail existiert).
  app.post("/api/auth/forgot-password", async (request, response) => {
    const genericResponse = {
      success: true,
      message: "Falls für dieses Konto eine E-Mail hinterlegt ist, wurde ein Reset-Schlüssel versendet."
    };

    // Primär wird die E-Mail-Adresse eingegeben; Benutzername bleibt als
    // Alternative möglich (z. B. für Skripte/Altpfade).
    const email = String(request.body?.email ?? "").trim().toLowerCase();
    const username = String(request.body?.username ?? "").trim().toLowerCase();

    if (!email && !username) {
      response.status(400).json({ error: "Bitte Ihre E-Mail-Adresse eingeben." });
      return;
    }

    if (!(await passesTurnstile(request))) {
      response.status(400).json({ error: "Bitte die Bot-Prüfung abschliessen.", captchaRequired: true });
      return;
    }

    const contact = email
      ? usersRepository.getContactByEmail(email)
      : usersRepository.getContactByUsername(username);

    if (!contact || !contact.email) {
      // Keine passende E-Mail/kein Konto: bewusst dieselbe Antwort (kein Rückschluss).
      recordAudit("auth.password_reset_requested", request, {
        target: email || username,
        detail: "no-match"
      });
      response.json(genericResponse);
      return;
    }

    if (!canDeliverPasswordResetKey(contact)) {
      logger.warn?.(
        "Passwort-Reset-Key wurde nicht erzeugt: SMTP ist nicht konfiguriert."
      );
      recordAudit("auth.password_reset_requested", request, {
        target: username || email,
        detail: "delivery-unavailable"
      });
      response.json(genericResponse);
      return;
    }

    const now = nowIso();
    passwordResetKeysRepository.deletePendingForUser(contact.id);

    const key = generatePasswordResetKey();
    const expiresAt = buildPasswordResetExpiry(new Date(now));

    passwordResetKeysRepository.create({
      id: `PRK-${randomBytes(8).toString("hex")}`,
      userId: contact.id,
      keyHash: hashResetKey(key),
      createdAt: now,
      expiresAt
    });

    try {
      await deliverPasswordResetKey({
        key,
        sentTo: contact.email,
        displayName: contact.displayName,
        expiresAt
      });
    } catch (error) {
      logger.warn?.(`Passwort-Reset-Mail fehlgeschlagen: ${error.message}`);
    }

    recordAudit("auth.password_reset_requested", request, { target: username });
    response.json(genericResponse);
  });

  app.post("/api/auth/reset-password", async (request, response) => {
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
      response.status(400).json({ error: "Bitte den Reset-Schlüssel eingeben." });
      return;
    }

    if (passwordValidation.error) {
      response.status(400).json({ error: passwordValidation.error });
      return;
    }

    const now = nowIso();
    const resetKey = passwordResetKeysRepository.getActiveByKey(key, now);

    if (!resetKey) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      response.status(400).json({ error: "Der Reset-Schlüssel ist ungültig oder abgelaufen." });
      return;
    }

    const passwordRecord = await createUserPasswordRecordAsync(passwordValidation.value.password);

    db.exec("BEGIN");

    try {
      const consumed = passwordResetKeysRepository.markUsed({ id: resetKey.id, usedAt: now, now });

      if (!consumed) {
        throw new Error("reset-key-not-available");
      }

      const updated = usersRepository.applyPasswordRecord(resetKey.userId, passwordRecord, now);

      if (!updated) {
        throw new Error("reset-user-not-found");
      }

      passwordResetKeysRepository.deletePendingForUser(resetKey.userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");

      if (error.message === "reset-key-not-available") {
        response.status(400).json({ error: "Der Reset-Schlüssel ist ungültig oder abgelaufen." });
        return;
      }

      throw error;
    }

    loginRateLimiter?.recordSuccess(rateLimitKey);
    recordAudit("auth.password_reset", request, { actorUserId: resetKey.userId, target: resetKey.userId });
    response.json({ success: true, message: "Passwort wurde gesetzt. Sie können sich jetzt anmelden." });
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
      items: usersRepository.listAllForAdmin()
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

  // Konto sperren/entsperren (active-Flag). Nur Master; nicht das eigene Konto und
  // kein Master-Konto. Gesperrte Konten verlieren beim nächsten Request den Zugang;
  // laufende Sitzungen werden zusätzlich sofort beendet.
  app.patch("/api/admin/users/:id/active", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Konten sperren." });
      return;
    }

    const targetId = request.params.id;

    if (targetId === request.currentUser.id) {
      response.status(400).json({ error: "Das eigene Konto kann nicht gesperrt werden." });
      return;
    }

    const target = usersRepository.findByIdAnyState(targetId);

    if (!target) {
      response.status(404).json({ error: "Benutzer nicht gefunden." });
      return;
    }

    if (isMasterUser(target)) {
      response.status(403).json({ error: "Das Master-Konto kann nicht gesperrt werden." });
      return;
    }

    if (typeof request.body?.active !== "boolean") {
      response.status(400).json({ error: "active muss ein boolescher Wert sein." });
      return;
    }

    const active = request.body.active;
    usersRepository.setActive(targetId, active);

    if (!active) {
      sessionsRepository.deleteByUserId(targetId);
    }

    recordAudit(active ? "admin.user.unlock" : "admin.user.lock", request, {
      target: target.username ?? target.displayName
    });
    response.json({
      user: { ...target, active },
      message: active ? `${target.displayName} wurde entsperrt.` : `${target.displayName} wurde gesperrt.`
    });
  });

  // Konto löschen. Nur Master; nicht das eigene Konto und kein Master-Konto.
  app.delete("/api/admin/users/:id", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf Konten löschen." });
      return;
    }

    const targetId = request.params.id;

    if (targetId === request.currentUser.id) {
      response.status(400).json({ error: "Das eigene Konto kann nicht gelöscht werden." });
      return;
    }

    const target = usersRepository.findByIdAnyState(targetId);

    if (!target) {
      response.status(404).json({ error: "Benutzer nicht gefunden." });
      return;
    }

    if (isMasterUser(target)) {
      response.status(403).json({ error: "Das Master-Konto kann nicht gelöscht werden." });
      return;
    }

    const deletion = usersRepository.deleteById(targetId);

    if (!deletion.deleted) {
      const hasProtectedContent = deletion.blockers.comments > 0 || deletion.blockers.registrationKeys > 0;

      if (hasProtectedContent) {
        response.status(409).json({
          error: "Dieses Konto enthält Kommentare oder erstellte Registrierungsschlüssel. Sperren Sie es stattdessen.",
          blockers: deletion.blockers
        });
        return;
      }

      response.status(404).json({ error: "Benutzer nicht gefunden." });
      return;
    }

    recordAudit("admin.user.delete", request, { target: target.username ?? target.displayName });
    response.json({ deleted: true, message: `${target.displayName} wurde gelöscht.` });
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

  app.get("/api/admin/2fa/status", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf die 2FA verwalten." });
      return;
    }

    response.json({ enabled: settingsRepository.getValue(masterTotpEnabledSettingKey) === "1" });
  });

  app.post("/api/admin/2fa/setup", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf die 2FA verwalten." });
      return;
    }

    const secret = generateTotpSecret();
    settingsRepository.setValue(masterTotpPendingSecretSettingKey, secret);

    response.json({
      secret,
      otpauthUri: buildOtpauthUri({ secret, account: request.currentUser.username ?? "master" })
    });
  });

  app.post("/api/admin/2fa/enable", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf die 2FA verwalten." });
      return;
    }

    const code = String(request.body?.code ?? "").trim();
    const pendingSecret = settingsRepository.getValue(masterTotpPendingSecretSettingKey);

    if (!pendingSecret) {
      response.status(400).json({ error: "Bitte zuerst die Einrichtung starten." });
      return;
    }

    if (!verifyTotp(pendingSecret, code)) {
      response.status(400).json({ error: "Der Code ist ungültig. Bitte erneut versuchen." });
      return;
    }

    settingsRepository.setValue(masterTotpSecretSettingKey, pendingSecret);
    settingsRepository.setValue(masterTotpEnabledSettingKey, "1");
    settingsRepository.deleteByKey(masterTotpPendingSecretSettingKey);

    recordAudit("admin.2fa.enabled", request, { target: "master" });
    response.json({ enabled: true, message: "Zwei-Faktor-Authentifizierung ist aktiviert." });
  });

  app.post("/api/admin/2fa/disable", (request, response) => {
    if (!isMasterUser(request.currentUser)) {
      response.status(403).json({ error: "Nur das Master-Konto darf die 2FA verwalten." });
      return;
    }

    if (settingsRepository.getValue(masterTotpEnabledSettingKey) !== "1") {
      response.json({ enabled: false });
      return;
    }

    const code = String(request.body?.code ?? "").trim();
    const secret = settingsRepository.getValue(masterTotpSecretSettingKey);

    if (!secret || !verifyTotp(secret, code)) {
      response.status(400).json({ error: "Der Code ist ungültig. Bitte erneut versuchen." });
      return;
    }

    settingsRepository.deleteByKey(masterTotpSecretSettingKey);
    settingsRepository.deleteByKey(masterTotpEnabledSettingKey);
    settingsRepository.deleteByKey(masterTotpPendingSecretSettingKey);

    recordAudit("admin.2fa.disabled", request, { target: "master" });
    response.json({ enabled: false, message: "Zwei-Faktor-Authentifizierung ist deaktiviert." });
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
      learningSummary: applicationLearningRepository.getSummary(),
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

    const readApplicationIds = applicationReadsRepository.listApplicationIds(request.currentUser.id);
    const items = repository.list(filters).map((item) => ({
      ...item,
      isRead: readApplicationIds.has(item.id)
    }));
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

    response.json({
      ...item,
      ...applicationReadsRepository.get(item.id, request.currentUser.id)
    });
  });

  app.post("/api/applications/:id/read", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json(
      applicationReadsRepository.markRead(item.id, request.currentUser.id, nowIso())
    );
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

    if (validation.value.learnFromDecision || ["cleared", "archived"].includes(updated.workflowStatus)) {
      applicationLearningRepository.recordFromApplication(updated, {
        userId: request.currentUser?.id ?? "",
        force: Boolean(validation.value.learnFromDecision)
      });
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
