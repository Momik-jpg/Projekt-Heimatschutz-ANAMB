// Auth-Routen (oeffentlich): Session, Login, Registrierung, Logout, Config,
// Master-Setup und Passwort-Reset. Aus server/app.js ausgelagert; die Handler
// sind unveraendert und beziehen Laufzeitzustand ueber das context-Objekt.
import { randomBytes } from "node:crypto";
import {
  buildExpiredSessionCookie,
  buildPasswordResetExpiry,
  buildSessionCookie,
  buildSessionExpiry,
  generatePasswordResetKey,
  isMasterUser,
  isPlaceholderPassword,
  nowIso,
  resolveCurrentUser,
  validateLoginPayload,
  validatePasswordResetPayload,
  validateRegistrationPayload
} from "../httpSupport.js";
import { verifyTotp } from "../services/totp.js";
import { createUserPasswordRecordAsync } from "../repository/usersRepository.js";
import { hashResetKey } from "../repository/passwordResetKeysRepository.js";
import { sanitizeForLog } from "../logSafe.js";

export function registerAuthRoutes(app, context) {
  const {
    db,
    sessionsRepository,
    usersRepository,
    loginRateLimiter,
    turnstileEnabled,
    turnstileSiteKey,
    passesTurnstile,
    recordAudit,
    settingsRepository,
    registrationKeysRepository,
    masterAccountPassword,
    getMasterUserId,
    masterSetupKeysRepository,
    passwordResetKeysRepository,
    canDeliverPasswordResetKey,
    deliverPasswordResetKey,
    logger,
    masterTotpEnabledSettingKey,
    masterTotpSecretSettingKey,
    masterPasswordConfiguredSettingKey
  } = context;

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

    if (!contact?.email) {
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
      logger.warn?.(`Passwort-Reset-Mail fehlgeschlagen: ${sanitizeForLog(error.message)}`);
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
      sessionsRepository.deleteByUserId(resetKey.userId);
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
}
