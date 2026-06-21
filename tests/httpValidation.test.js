import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHttpUrl,
  looksLikeEmailAddress,
  validateMunicipalitySourceSearchPattern,
  looksLikeMachineReadableSourceUrl,
  normalizeSecretForComparison,
  isPlaceholderPassword,
  normalizeSyncSourceUrl,
  validateProductionRuntimeConfiguration,
  validateLoginPayload,
  validateRegistrationPayload,
  validateRegistrationKeyCreationPayload,
  validatePasswordResetPayload,
  validateManualImportPayload,
  looksLikeAmtsblattUrl,
  validateSyncSettingsPayload,
  validateMunicipalitySourcePayload,
  validateCommentPayload,
  validateApplicationPatch
} from "../server/httpValidation.js";
import { workflowStatuses } from "../server/repository/applicationsRepository.js";

const silent = { warn() {} };

test("normalizeHttpUrl deckt leere, ungueltige und gueltige URLs ab", () => {
  assert.equal(normalizeHttpUrl(""), "");
  assert.equal(normalizeHttpUrl("   "), "");
  assert.equal(normalizeHttpUrl("ftp://x.ch"), null);
  assert.equal(normalizeHttpUrl("kein url"), null);
  assert.equal(normalizeHttpUrl("https://ag.ch/x"), "https://ag.ch/x");
});

test("looksLikeEmailAddress prueft alle Zweige", () => {
  assert.equal(looksLikeEmailAddress("a@b.ch"), true);
  assert.equal(looksLikeEmailAddress(""), false);
  assert.equal(looksLikeEmailAddress(`${"x".repeat(125)}@b.ch`), false);
  assert.equal(looksLikeEmailAddress("a b@c.ch"), false);
  assert.equal(looksLikeEmailAddress("ab.ch"), false);
  assert.equal(looksLikeEmailAddress("a@@b.ch"), false);
  assert.equal(looksLikeEmailAddress("@b.ch"), false);
  assert.equal(looksLikeEmailAddress("a@b"), false);
  assert.equal(looksLikeEmailAddress("a@.b.ch"), false);
  assert.equal(looksLikeEmailAddress("a@-b.ch"), false);
});

test("validateMunicipalitySourceSearchPattern deckt jeden Fehlerzweig ab", () => {
  assert.equal(validateMunicipalitySourceSearchPattern("L", ""), "");
  assert.match(validateMunicipalitySourceSearchPattern("L", "x".repeat(161)), /zu lang/);
  assert.match(validateMunicipalitySourceSearchPattern("L", "a(b"), /einfache Suchbegriffe/);
  assert.match(validateMunicipalitySourceSearchPattern("L", " | "), /keinen gültigen/);
  assert.match(validateMunicipalitySourceSearchPattern("L", Array.from({ length: 25 }, (_, i) => `t${i}`).join("|")), /zu viele/);
  assert.match(validateMunicipalitySourceSearchPattern("L", "y".repeat(81)), /zu langen/);
  assert.equal(validateMunicipalitySourceSearchPattern("L", "baden|aarau"), "");
});

test("looksLikeMachineReadableSourceUrl erkennt maschinenlesbare Quellen", () => {
  assert.equal(looksLikeMachineReadableSourceUrl("https://x.ch/rest/MapServer/0/query"), true);
  assert.equal(looksLikeMachineReadableSourceUrl("https://x.ch/data.json"), true);
  assert.equal(looksLikeMachineReadableSourceUrl("https://x.ch/feed"), true);
  assert.equal(looksLikeMachineReadableSourceUrl("https://x.ch/seite.html"), false);
  assert.equal(looksLikeMachineReadableSourceUrl(""), false);
  assert.equal(looksLikeMachineReadableSourceUrl("kein url"), false);
});

test("Secret-/Placeholder-Helfer", () => {
  assert.equal(normalizeSecretForComparison("  ABC  "), "abc");
  assert.equal(isPlaceholderPassword("eigenesmasterpasswort"), true);
  assert.equal(isPlaceholderPassword("ein-echtes-Passwort!"), false);
});

test("normalizeSyncSourceUrl: leer, Platzhalter, ungueltig, gueltig", () => {
  assert.equal(normalizeSyncSourceUrl("", silent), "");
  assert.equal(normalizeSyncSourceUrl("https://example.test/x", silent), "");
  assert.equal(normalizeSyncSourceUrl("ftp://x.ch", silent), "");
  assert.equal(normalizeSyncSourceUrl("kein url", silent), "");
  assert.equal(normalizeSyncSourceUrl("https://ag.ch/feed", silent), "https://ag.ch/feed");
});

test("validateProductionRuntimeConfiguration", () => {
  assert.doesNotThrow(() => validateProductionRuntimeConfiguration({ NODE_ENV: "development" }));
  assert.throws(() => validateProductionRuntimeConfiguration({ NODE_ENV: "production" }), /weder MASTER_ACCOUNT_PASSWORD/);
  assert.throws(
    () => validateProductionRuntimeConfiguration({ NODE_ENV: "production", MASTER_ACCOUNT_PASSWORD: "eigenesmasterpasswort" }),
    /Platzhalter/
  );
  assert.doesNotThrow(() =>
    validateProductionRuntimeConfiguration({
      NODE_ENV: "production",
      MASTER_ACCOUNT_PASSWORD: "Echt-Sicher-123!",
      TOKEN_ENCRYPTION_KEY: "Echter-Token-Key-32-Zeichen-lang!"
    })
  );
  assert.throws(
    () =>
      validateProductionRuntimeConfiguration({
        NODE_ENV: "production",
        MASTER_ACCOUNT_PASSWORD: "Echt-Sicher-123!",
        TOKEN_ENCRYPTION_KEY: "Echter-Token-Key-32-Zeichen-lang!",
        DEFAULT_LOGIN_PASSWORD: "bittevordemreleaseaendern123"
      }),
    /DEFAULT_LOGIN_PASSWORD/
  );
  // E-Mail-Ersteinrichtung statt Passwort ist zulaessig:
  assert.doesNotThrow(() =>
    validateProductionRuntimeConfiguration({
      NODE_ENV: "production",
      MASTER_SETUP_EMAIL: "master@ag.ch",
      SMTP_HOST: "smtp.ag.ch",
      TOKEN_ENCRYPTION_KEY: "Echter-Token-Key-32-Zeichen-lang!"
    })
  );
  assert.throws(
    () =>
      validateProductionRuntimeConfiguration({
        NODE_ENV: "production",
        MASTER_ACCOUNT_PASSWORD: "Echt-Sicher-123!"
      }),
    /TOKEN_ENCRYPTION_KEY/
  );
  assert.throws(
    () =>
      validateProductionRuntimeConfiguration({
        NODE_ENV: "production",
        MASTER_ACCOUNT_PASSWORD: "Echt-Sicher-123!",
        TOKEN_ENCRYPTION_KEY: "<als-secret-setzen>"
      }),
    /TOKEN_ENCRYPTION_KEY/
  );
  assert.throws(
    () =>
      validateProductionRuntimeConfiguration({
        NODE_ENV: "production",
        MASTER_SETUP_EMAIL: "master@example.org",
        SMTP_HOST: "smtp.example.org",
        TOKEN_ENCRYPTION_KEY: "Echter-Token-Key-32-Zeichen-lang!"
      }),
    /Beispielwerte/
  );
});

test("validateLoginPayload", () => {
  assert.match(validateLoginPayload({}).error, /Benutzer und Passwort/);
  assert.match(validateLoginPayload({ username: "x" }).error, /Benutzer und Passwort/);
  assert.deepEqual(validateLoginPayload({ username: "Lucia", password: "pw" }).value, {
    userId: "",
    username: "lucia",
    password: "pw"
  });
});

test("validateRegistrationPayload deckt alle Regeln ab", () => {
  assert.match(validateRegistrationPayload({}).error, /Name, Benutzername/);
  assert.match(
    validateRegistrationPayload({ displayName: "Anna", username: "a!", password: "12345678", accessKey: "KEY-1" }).error,
    /Benutzername darf nur/
  );
  assert.match(
    validateRegistrationPayload({ displayName: "An", username: "anna", password: "12345678", accessKey: "KEY-1" }).error,
    /Name muss zwischen/
  );
  assert.match(
    validateRegistrationPayload({ displayName: "Anna", username: "anna", password: "kurz", accessKey: "KEY-1" }).error,
    /mindestens 8/
  );
  assert.match(
    validateRegistrationPayload({ displayName: "Anna", username: "anna", password: "12345678", accessKey: "KEY-1", email: `${"x".repeat(130)}@b.ch` }).error,
    /E-Mail-Adresse ist zu lang/
  );
  assert.match(
    validateRegistrationPayload({ displayName: "Anna", username: "anna", password: "12345678", accessKey: "KEY-1", email: "keinemail" }).error,
    /gültige E-Mail/
  );
  const ok = validateRegistrationPayload({ displayName: "Anna", username: "anna", password: "12345678", accessKey: "KEY-1", email: "anna@b.ch" });
  assert.equal(ok.value.role, "Mitarbeiter");
});

test("kleine Payload-Validatoren", () => {
  assert.match(validateRegistrationKeyCreationPayload({ note: "x".repeat(121) }).error, /zu lang/);
  assert.deepEqual(validateRegistrationKeyCreationPayload({ note: "Team" }).value, { note: "Team" });

  assert.match(validatePasswordResetPayload({}).error, /neues Passwort/);
  assert.match(validatePasswordResetPayload({ password: "kurz" }).error, /mindestens 8/);
  assert.deepEqual(validatePasswordResetPayload({ password: "langgenug1" }).value, { password: "langgenug1" });

  assert.match(validateManualImportPayload({}).error, /JSON-Export/);
  assert.deepEqual(validateManualImportPayload({ jsonText: " {} " }).value, { jsonText: "{}" });

  assert.match(validateCommentPayload({}).error, /Team-Kommentar eingeben/);
  assert.match(validateCommentPayload({ message: "x".repeat(2001) }).error, /zu lang/);
  assert.deepEqual(validateCommentPayload({ message: " hi " }).value, { message: "hi" });
});

test("looksLikeAmtsblattUrl", () => {
  assert.equal(looksLikeAmtsblattUrl("https://amtsblatt.ag.ch/x"), true);
  assert.equal(looksLikeAmtsblattUrl("https://www.amtsblatt.ag.ch/x"), true);
  assert.equal(looksLikeAmtsblattUrl("https://example.com"), false);
  assert.equal(looksLikeAmtsblattUrl("kein url"), false);
});

test("validateSyncSettingsPayload", () => {
  assert.match(validateSyncSettingsPayload({ sourceType: "quatsch" }).error, /Quellentyp ist ungültig/);
  assert.match(validateSyncSettingsPayload({ sourceMunicipality: "x".repeat(81) }).error, /Gemeindename zur Quelle/);
  assert.match(
    validateSyncSettingsPayload({ sourceUrl: "https://gemeinde.ch/seite", sourceType: "html" }).error,
    /bitte die Gemeinde angeben/
  );
  assert.deepEqual(validateSyncSettingsPayload({ sourceUrl: "https://amtsblatt.ag.ch/p", sourceType: "amtsblatt" }).value.sourceType, "amtsblatt");
  assert.equal(validateSyncSettingsPayload({ sourceType: "auto" }).value.sourceType, "");
});

test("validateMunicipalitySourcePayload", () => {
  assert.match(validateMunicipalitySourcePayload({ sourceType: "x" }).error, /Quellentyp ist ungültig/);
  assert.match(validateMunicipalitySourcePayload({ sourceType: "html", digitalStatus: "x" }).error, /Digitalisierungsstatus/);
  assert.match(
    validateMunicipalitySourcePayload({ sourceType: "html", digitalStatus: "digital", sourceUrl: "ftp://x" }).error,
    /http:\/\/ oder https:\/\//
  );
  assert.match(
    validateMunicipalitySourcePayload({ sourceType: "html", digitalStatus: "digital", notes: "x".repeat(501) }).error,
    /Notiz zur Gemeindequelle/
  );
  assert.match(
    validateMunicipalitySourcePayload({ sourceType: "html", digitalStatus: "digital", includePattern: "a(b" }).error,
    /Include-Muster/
  );
  assert.match(
    validateMunicipalitySourcePayload({ sourceType: "html", digitalStatus: "digital", enabled: true }).error,
    /wird eine URL benötigt/
  );
  const ok = validateMunicipalitySourcePayload({
    sourceType: "html",
    digitalStatus: "digital",
    sourceUrl: "https://gemeinde.ch/baugesuche",
    enabled: true
  });
  assert.equal(ok.value.sourceUrl, "https://gemeinde.ch/baugesuche");
});

test("validateApplicationPatch", () => {
  assert.match(validateApplicationPatch({ workflowStatus: "ungueltig" }).error, /workflowStatus/);
  assert.match(validateApplicationPatch({ assignee: 5 }).error, /assignee/);
  assert.match(validateApplicationPatch({ note: 5 }).error, /note/);
  assert.match(validateApplicationPatch({}).error, /no supported fields/);
  const ok = validateApplicationPatch({ workflowStatus: workflowStatuses[0], assignee: "lucia", note: "x", learnFromDecision: 1 });
  assert.equal(ok.value.workflowStatus, workflowStatuses[0]);
  assert.equal(ok.value.learnFromDecision, true);
});
