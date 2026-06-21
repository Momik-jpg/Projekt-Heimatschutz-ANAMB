// Eingabe-Validierung und Normalisierung – aus httpSupport.js aufgeteilt.
import { workflowStatuses } from "./repository/applicationsRepository.js";
import {
  municipalityDigitalStatuses,
  municipalitySourceTypes
} from "./repository/municipalitySourcesRepository.js";
import {
  normalizeRegistrationKey
} from "./httpSupportCore.js";

export const placeholderPasswordValues = new Set([
  "dein_sicheres_master_passwort",
  "dein_sicheres_team_passwort",
  "eigenesmasterpasswort",
  "eigenessicherespasswort",
  "bittemasterpasswortvordemreleaseaendern123",
  "bittevordemreleaseaendern123"
]);

export const placeholderSyncSourceMarkers = ["example.test", "beispiel", "placeholder"];

export const municipalitySourcePatternMaxLength = 160;

export const municipalitySourcePatternMaxTerms = 24;

export const municipalitySourcePatternTermMaxLength = 80;

export const municipalitySourcePatternUnsupportedChars = /[\\^$*+?()[\]{}]/;

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

