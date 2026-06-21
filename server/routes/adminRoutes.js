// Admin-Routen (Master-Recht): Registrierungsschluessel, Benutzer, Audit-Log,
// 2FA, Sync-Einstellungen, Gemeindequellen und manueller JSON-Import.
// Aus server/app.js ausgelagert; Handler unveraendert, Zustand via context.
import { randomBytes } from "node:crypto";
import {
  agisBaugesucheDatendocUrl,
  buildCsvResponse,
  buildImportNotificationEntries,
  buildRegistrationKeyExpiry,
  generateRegistrationKey,
  isMasterUser,
  normalizeEnvString,
  normalizeSyncSourceUrl,
  nowIso,
  validateManualImportPayload,
  validateMunicipalitySourcePayload,
  validatePasswordResetPayload,
  validateRegistrationKeyCreationPayload,
  validateSyncSettingsPayload
} from "../httpSupport.js";
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from "../services/totp.js";
import { encryptToken, isTokenSet } from "../services/tokenCrypto.js";
import { normalizeImportedPayload } from "../services/applicationsSyncService.js";
import {
  municipalityDigitalStatuses,
  municipalitySourceTypes
} from "../repository/municipalitySourcesRepository.js";

// Entfernt den Quell-Token aus einer Gemeindequelle, bevor sie an den Client
// geht (S5): nie der Klartext, nur ob ein Token gesetzt ist.
function redactSourceToken(source) {
  if (!source) {
    return source;
  }
  const { sourceToken, ...rest } = source;
  return { ...rest, sourceTokenSet: isTokenSet(sourceToken) };
}

export function registerAdminRoutes(app, context) {
  const {
    registrationKeysRepository,
    recordAudit,
    usersRepository,
    sessionsRepository,
    auditLogRepository,
    settingsRepository,
    loginRateLimiter,
    municipalitySourcesRepository,
    weeklySyncService,
    normalizedSyncSourceUrl,
    normalizedSyncSourceToken,
    options,
    assessImportedApplication,
    repository,
    importNotificationsRepository,
    masterTotpEnabledSettingKey,
    masterTotpSecretSettingKey,
    masterTotpPendingSecretSettingKey
  } = context;

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

    sessionsRepository.deleteByUserId(updatedUser.id);

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

    const rateLimitKey = `2fa:${request.ip || "unknown"}`;
    if (loginRateLimiter) {
      const limitStatus = loginRateLimiter.check(rateLimitKey);
      if (limitStatus.limited) {
        response.setHeader("Retry-After", String(limitStatus.retryAfterSeconds));
        response.status(429).json({ error: "Zu viele 2FA-Versuche. Bitte in einigen Minuten erneut versuchen." });
        return;
      }
    }

    const code = String(request.body?.code ?? "").trim();
    const pendingSecret = settingsRepository.getValue(masterTotpPendingSecretSettingKey);

    if (!pendingSecret) {
      response.status(400).json({ error: "Bitte zuerst die Einrichtung starten." });
      return;
    }

    if (!verifyTotp(pendingSecret, code)) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      response.status(400).json({ error: "Der Code ist ungültig. Bitte erneut versuchen." });
      return;
    }

    loginRateLimiter?.recordSuccess(rateLimitKey);
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

    const rateLimitKey = `2fa:${request.ip || "unknown"}`;
    if (loginRateLimiter) {
      const limitStatus = loginRateLimiter.check(rateLimitKey);
      if (limitStatus.limited) {
        response.setHeader("Retry-After", String(limitStatus.retryAfterSeconds));
        response.status(429).json({ error: "Zu viele 2FA-Versuche. Bitte in einigen Minuten erneut versuchen." });
        return;
      }
    }

    const code = String(request.body?.code ?? "").trim();
    const secret = settingsRepository.getValue(masterTotpSecretSettingKey);

    if (!secret || !verifyTotp(secret, code)) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      response.status(400).json({ error: "Der Code ist ungültig. Bitte erneut versuchen." });
      return;
    }

    loginRateLimiter?.recordSuccess(rateLimitKey);
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
      // Token wird nie an den Client zurueckgegeben (S5), nur ob einer gesetzt ist.
      sourceTokenSet: isTokenSet(settingsRepository.getValue("sync_source_token", normalizedSyncSourceToken)),
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
        sourceTokenSet: false,
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
    let storedToken = null;
    if (validation.value.sourceToken) {
      storedToken = settingsRepository.setValue("sync_source_token", encryptToken(validation.value.sourceToken), currentTimestamp);
    } else {
      settingsRepository.deleteByKey("sync_source_token");
    }

    let storedType = null;
    if (validation.value.sourceType) {
      storedType = settingsRepository.setValue("sync_source_type", validation.value.sourceType, currentTimestamp);
    } else {
      settingsRepository.deleteByKey("sync_source_type");
    }

    let storedMunicipality = null;
    if (validation.value.sourceMunicipality) {
      storedMunicipality = settingsRepository.setValue("sync_source_municipality", validation.value.sourceMunicipality, currentTimestamp);
    } else {
      settingsRepository.deleteByKey("sync_source_municipality");
    }
    weeklySyncService.refreshSchedule();

    response.json({
      sourceUrl: storedSetting.value,
      sourceTokenSet: Boolean(storedToken),
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
      items: municipalitySourcesRepository.listAll().map(redactSourceToken),
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
      item: redactSourceToken(updated),
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
}
