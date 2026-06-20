import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import {
  createApp,
  normalizeSyncSourceUrl,
  validateProductionRuntimeConfiguration
} from "../server/app.js";
import { createDatabase } from "../server/db.js";
import { createApplicationsRepository } from "../server/repository/applicationsRepository.js";
import { createAgisAssessmentService } from "../server/services/agisAssessmentService.js";
import { generateTotp } from "../server/services/totp.js";

// Test-Zugangsdaten für die ephemere In-Memory-Testdatenbank. Das sind KEINE
// echten Secrets und tauchen nirgends produktiv auf. Per Umgebungsvariable
// überschreibbar, sonst neutrale Platzhalter.
const TEST_MASTER_PASSWORD = process.env.TEST_MASTER_PASSWORD ?? "Test-Master-Pw-1!";
const TEST_TEAM_PASSWORD = process.env.TEST_TEAM_PASSWORD ?? "Heimat2026!";

function createTestServer(options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "heimatschutz-aargau-"));
  const dbPath = options.dbPath ?? join(directory, "test.sqlite");
  const { app, db, maintenanceService, stopBackgroundJobs, ready } = createApp({
    dbPath,
    agisFetchImpl: options.agisFetchImpl,
    agisAssessmentEnabled: options.agisAssessmentEnabled ?? false,
    agisRefreshOnStart: options.agisRefreshOnStart ?? false,
    seedDemoApplications: options.seedDemoApplications ?? true,
    syncFetchImpl: options.syncFetchImpl,
    geocodeFetchImpl: options.geocodeFetchImpl,
    pdfTextExtractImpl: options.pdfTextExtractImpl,
    geocodeEnabled: options.geocodeEnabled ?? false,
    syncSourceUrl: options.syncSourceUrl,
    autoSyncEnabled: options.autoSyncEnabled ?? false,
    autoSyncIntervalMs: options.autoSyncIntervalMs,
    autoSyncRunOnStart: options.autoSyncRunOnStart,
    loginRateLimit: options.loginRateLimit,
    compression: options.compression,
    logger: options.logger,
    maintenanceEnabled: options.maintenanceEnabled ?? false,
    maintenanceRunOnStart: options.maintenanceRunOnStart ?? false,
    backupEnabled: options.backupEnabled,
    backupDir: options.backupDir,
    backupRetention: options.backupRetention,
    csrfProtection: options.csrfProtection,
    // Seed-Passwörter stehen nicht mehr im Repository, daher liefert der Test-Harness
    // sie über Optionen. Einzelne Tests können sie überschreiben (z. B. weglassen,
    // um den Master-Setup-Key-Flow zu testen). Eine gesetzte Umgebungsvariable hat
    // Vorrang vor dem Default (für den Server-Restart-Test).
    masterAccountPassword:
      "masterAccountPassword" in options
        ? options.masterAccountPassword
        : process.env.MASTER_ACCOUNT_PASSWORD ?? TEST_MASTER_PASSWORD,
    defaultLoginPassword:
      "defaultLoginPassword" in options
        ? options.defaultLoginPassword
        : process.env.DEFAULT_LOGIN_PASSWORD ?? TEST_TEAM_PASSWORD,
    masterSetupEmail: options.masterSetupEmail,
    mailService: options.mailService,
    onMasterSetupKey: options.onMasterSetupKey,
    onPasswordResetKey: options.onPasswordResetKey,
    turnstileSiteKey: options.turnstileSiteKey,
    turnstileSecretKey: options.turnstileSecretKey,
    turnstileVerify: options.turnstileVerify
  });

  if (!options.keepSeededMunicipalitySourcesEnabled) {
    db.prepare("UPDATE municipality_sources SET enabled = 0").run();
  }

  const server = app.listen(0);

  return {
    server,
    db,
    maintenanceService,
    stopBackgroundJobs,
    ready,
    directory,
    dbPath,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  };
}

function createJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function dateOnlyDaysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function closeTestServer(testServer) {
  return new Promise((resolve, reject) => {
    testServer.stopBackgroundJobs?.();
    testServer.server.close((error) => {
      try {
        testServer.db.close();
      } catch {
        // Database may already be closed during teardown.
      }

      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitFor(assertion, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const intervalMs = options.intervalMs ?? 80;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await assertion();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return assertion();
}

async function requestJson(baseUrl, path, options = {}) {
  const { headers, ...fetchOptions } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    ...fetchOptions
  });

  const payload = await response.json();
  return {
    status: response.status,
    payload,
    headers: response.headers
  };
}

async function requestText(baseUrl, path, options = {}) {
  const { headers, ...fetchOptions } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...headers
    },
    ...fetchOptions
  });

  const body = await response.text();
  return {
    status: response.status,
    body,
    headers: response.headers
  };
}

// Roher HTTP-Client, der – anders als fetch – die Antwort nicht automatisch
// dekomprimiert. Nötig, um Content-Encoding und den gzip-Body direkt zu prüfen.
function rawRequest(baseUrl, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${path}`);
    const requestObject = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    requestObject.on("error", reject);
    requestObject.end();
  });
}

async function login(baseUrl, credentials = {}) {
  const response = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: credentials.username ?? "lucia.vettori",
      password: credentials.password ?? TEST_TEAM_PASSWORD
    })
  });

  assert.equal(response.status, 200);

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);

  return setCookie.split(";")[0];
}

async function createRegistrationKey(baseUrl) {
  const masterCookie = await login(baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const response = await requestJson(baseUrl, "/api/admin/registration-keys", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      note: "Testzugang"
    })
  });

  assert.equal(response.status, 201);
  return {
    cookie: masterCookie,
    id: response.payload.id,
    keyCode: response.payload.keyCode
  };
}

test("protected endpoints require login", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const response = await requestJson(testServer.baseUrl, "/api/dashboard");
  assert.equal(response.status, 401);
});

test("health endpoint is available at /health and /api/health", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const healthResponse = await requestJson(testServer.baseUrl, "/health");
  const apiHealthResponse = await requestJson(testServer.baseUrl, "/api/health");

  assert.equal(healthResponse.status, 200);
  assert.equal(apiHealthResponse.status, 200);
  assert.equal(healthResponse.payload.status, "ok");
  assert.deepEqual(healthResponse.payload, apiHealthResponse.payload);
});

test("server sends security and cache headers for app assets", async (context) => {
  const testServer = createTestServer({
    seedDemoApplications: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const healthResponse = await requestJson(testServer.baseUrl, "/health");
  const scriptResponse = await requestText(testServer.baseUrl, "/app.js");
  const indexResponse = await requestText(testServer.baseUrl, "/");

  assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(healthResponse.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(scriptResponse.headers.get("cache-control"), /no-cache/);
  assert.match(indexResponse.headers.get("cache-control"), /no-store/);
});

test("production startup validation rejects placeholder passwords", () => {
  assert.throws(
    () =>
      validateProductionRuntimeConfiguration({
        NODE_ENV: "production",
        MASTER_ACCOUNT_PASSWORD: TEST_MASTER_PASSWORD,
        DEFAULT_LOGIN_PASSWORD: "BitteVorDemReleaseAendern123"
      }),
    /Produktionsstart abgebrochen/i
  );
});

test("sync source placeholders are ignored until a real API is configured", () => {
  assert.equal(normalizeSyncSourceUrl("https://example.test/baugesuche.json"), "");
  assert.equal(
    normalizeSyncSourceUrl("https://api.example.org/baugesuche.json"),
    "https://api.example.org/baugesuche.json"
  );
});

test("registration creates a new user and logs that person in", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const registrationKey = await createRegistrationKey(testServer.baseUrl);
  const response = await requestJson(testServer.baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      displayName: "Maria Beispiel",
      username: "maria.beispiel",
      password: "Sicher1234",
      accessKey: registrationKey.keyCode
    })
  });

  assert.equal(response.status, 201);
  assert.equal(response.payload.user.displayName, "Maria Beispiel");

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);

  const sessionResponse = await requestJson(testServer.baseUrl, "/api/auth/session", {
    headers: {
      Cookie: setCookie.split(";")[0]
    }
  });

  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.payload.authenticated, true);
  assert.equal(sessionResponse.payload.user.displayName, "Maria Beispiel");
});

test("registration is rejected without a valid key", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const response = await requestJson(testServer.baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      displayName: "Ohne Schlüssel",
      username: "ohne.schluessel",
      password: "Sicher1234",
      accessKey: "HSA-0000-0000-0000"
    })
  });

  assert.equal(response.status, 400);
  assert.match(response.payload.error, /Registrierungsschlüssel/i);
});

test("only the master account can create registration keys", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const employeeCookie = await login(testServer.baseUrl);
  const forbiddenResponse = await requestJson(testServer.baseUrl, "/api/admin/registration-keys", {
    method: "POST",
    headers: {
      Cookie: employeeCookie
    },
    body: JSON.stringify({
      note: "Darf nicht gehen"
    })
  });

  assert.equal(forbiddenResponse.status, 403);

  const registrationKey = await createRegistrationKey(testServer.baseUrl);
  assert.match(registrationKey.keyCode, /^HSA-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
});

test("master can delete an unused registration key", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const registrationKey = await createRegistrationKey(testServer.baseUrl);
  const deleteResponse = await requestJson(testServer.baseUrl, `/api/admin/registration-keys/${registrationKey.id}`, {
    method: "DELETE",
    headers: {
      Cookie: registrationKey.cookie
    }
  });

  assert.equal(deleteResponse.status, 200);

  const listResponse = await requestJson(testServer.baseUrl, "/api/admin/registration-keys", {
    headers: {
      Cookie: registrationKey.cookie
    }
  });

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.payload.items.some((item) => item.id === registrationKey.id), false);
});

test("master can reset a forgotten password for a team member", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const usersResponse = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(usersResponse.status, 200);
  const lucia = usersResponse.payload.items.find((user) => user.username === "lucia.vettori");
  assert.ok(lucia);

  const resetResponse = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}/password`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      password: "NeuesPasswort2026!"
    })
  });

  assert.equal(resetResponse.status, 200);

  const oldLoginResponse = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "lucia.vettori",
      password: "Heimat2026!"
    })
  });
  assert.equal(oldLoginResponse.status, 401);

  const newLoginResponse = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "lucia.vettori",
      password: "NeuesPasswort2026!"
    })
  });
  assert.equal(newLoginResponse.status, 200);
});

test("master can lock and unlock a team member", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const usersResponse = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  const lucia = usersResponse.payload.items.find((user) => user.username === "lucia.vettori");
  assert.ok(lucia);
  assert.equal(lucia.active, true);

  const lockResponse = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}/active`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ active: false })
  });
  assert.equal(lockResponse.status, 200);

  // Gesperrtes Konto kann sich nicht mehr anmelden.
  const lockedLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(lockedLogin.status, 401);

  const afterLock = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  assert.equal(afterLock.payload.items.find((user) => user.id === lucia.id).active, false);

  const unlockResponse = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}/active`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ active: true })
  });
  assert.equal(unlockResponse.status, 200);

  const unlockedLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(unlockedLogin.status, 200);
});

test("account activation rejects missing and non-boolean values", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const usersResponse = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  const lucia = usersResponse.payload.items.find((user) => user.username === "lucia.vettori");
  assert.ok(lucia);

  for (const body of [{}, { active: "false" }]) {
    const response = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}/active`, {
      method: "PATCH",
      headers: { Cookie: masterCookie },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }

  const afterRequests = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  assert.equal(afterRequests.payload.items.find((user) => user.id === lucia.id).active, true);
});

test("master can delete a team member", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const usersResponse = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  const lucia = usersResponse.payload.items.find((user) => user.username === "lucia.vettori");
  assert.ok(lucia);

  const deleteResponse = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}`, {
    method: "DELETE",
    headers: { Cookie: masterCookie }
  });
  assert.equal(deleteResponse.status, 200);

  const afterDelete = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  assert.equal(afterDelete.payload.items.find((user) => user.id === lucia.id), undefined);

  const deletedLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(deletedLogin.status, 401);
});

test("account deletion preserves user comments by blocking destructive deletion", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const teamCookie = await login(testServer.baseUrl);
  const commentResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002/comments", {
    method: "POST",
    headers: { Cookie: teamCookie },
    body: JSON.stringify({ message: "Dieser Kommentar muss erhalten bleiben." })
  });
  assert.equal(commentResponse.status, 201);

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const usersResponse = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  const lucia = usersResponse.payload.items.find((user) => user.username === "lucia.vettori");
  assert.ok(lucia);

  const deleteResponse = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}`, {
    method: "DELETE",
    headers: { Cookie: masterCookie }
  });
  assert.equal(deleteResponse.status, 409);

  const commentsResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002/comments", {
    headers: { Cookie: teamCookie }
  });
  assert.equal(commentsResponse.status, 200);
  assert.equal(commentsResponse.payload.items.some((comment) => comment.message === "Dieser Kommentar muss erhalten bleiben."), true);

  const loginResponse = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: TEST_TEAM_PASSWORD })
  });
  assert.equal(loginResponse.status, 200);
});

test("locking and deleting accounts is guarded (own account, master, non-master)", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const usersResponse = await requestJson(testServer.baseUrl, "/api/admin/users", {
    headers: { Cookie: masterCookie }
  });
  const masterUser = usersResponse.payload.items.find((user) => user.role === "Master");
  const lucia = usersResponse.payload.items.find((user) => user.username === "lucia.vettori");
  assert.ok(masterUser);
  assert.ok(lucia);

  // Eigenes (Master-)Konto kann nicht gesperrt oder gelöscht werden.
  const selfLock = await requestJson(testServer.baseUrl, `/api/admin/users/${masterUser.id}/active`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ active: false })
  });
  assert.equal(selfLock.status, 400);

  const selfDelete = await requestJson(testServer.baseUrl, `/api/admin/users/${masterUser.id}`, {
    method: "DELETE",
    headers: { Cookie: masterCookie }
  });
  assert.equal(selfDelete.status, 400);

  // Ein Team-Konto darf weder sperren noch löschen.
  const luciaCookie = await login(testServer.baseUrl, {
    username: "lucia.vettori",
    password: "Heimat2026!"
  });

  const teamLock = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}/active`, {
    method: "PATCH",
    headers: { Cookie: luciaCookie },
    body: JSON.stringify({ active: false })
  });
  assert.equal(teamLock.status, 403);

  const teamDelete = await requestJson(testServer.baseUrl, `/api/admin/users/${lucia.id}`, {
    method: "DELETE",
    headers: { Cookie: luciaCookie }
  });
  assert.equal(teamDelete.status, 403);
});

test("master can import an AGIS export JSON as a practical fallback", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const importResponse = await requestJson(testServer.baseUrl, "/api/admin/import-json", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      jsonText: JSON.stringify({
        features: [
          {
            attributes: {
              id: "BG-AGIS-IMPORT-001",
              GES_ID: "AGIS-IMPORT-001",
              Gemeinde: "Aarau",
              ParzNr: "1234",
              GES_TITEL: "Dachsanierung",
              GES_EINGANG: "2026-03-20",
              agisMatch: "Treffer in ISOS-Fläche",
              URL: "https://www.ag.ch/beispiel/baugesuch/1"
            },
            geometry: {
              x: 2650000,
              y: 1250000
            }
          }
        ]
      })
    })
  });

  assert.equal(importResponse.status, 200);
  assert.equal(importResponse.payload.importedCount, 1);
  assert.equal(importResponse.payload.updatedCount, 0);
  assert.equal(importResponse.payload.notificationCount, 1);
  assert.match(importResponse.payload.message, /Baugesuche aus dem JSON-Export verarbeitet/i);
  assert.equal(importResponse.payload.items[0].id, "BG-AGIS-IMPORT-001");
  assert.equal(importResponse.payload.items[0].municipality, "Aarau");
  assert.equal(importResponse.payload.items[0].address, "Parzelle 1234");
  assert.equal(importResponse.payload.items[0].projectType, "Dachsanierung");
  assert.equal(importResponse.payload.items[0].sourceReference, "AGIS-IMPORT-001");
  assert.equal(importResponse.payload.items[0].coordinates, "2650000,1250000");
  assert.equal(importResponse.payload.items[0].source, "AGIS Export");
  assert.match(importResponse.payload.items[0].automatedAssessment, /Frist im Import nicht vorhanden/i);

  const detailResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-AGIS-IMPORT-001", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.address, "Parzelle 1234");
  assert.equal(detailResponse.payload.publicationDate, "2026-03-20");

  const dashboardResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(dashboardResponse.status, 200);
  assert.ok(
    dashboardResponse.payload.notifications.some(
      (notification) =>
        notification.applicationId === "BG-AGIS-IMPORT-001" &&
        notification.protectionStatus === "protected-zone"
    )
  );
});

test("manual JSON import sends impossible deadline dates to manual review", async (context) => {
  const testServer = createTestServer({
    seedDemoApplications: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const importResponse = await requestJson(testServer.baseUrl, "/api/admin/import-json", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      jsonText: JSON.stringify({
        items: [
          {
            id: "BG-INVALID-DATE-001",
            source: "Test",
            sourceReference: "INVALID-DATE-001",
            sourceUrl: "https://example.org/invalid-date",
            municipality: "Aarau",
            address: "Bahnhofstrasse 2",
            coordinates: "2650000,1250000",
            publicationDate: "2026-05-05",
            deadlineDate: "2026-05-04",
            projectType: "Umbau",
            description: "Frist liegt vor Publikation",
            protectionStatus: "no-hit",
            agisMatch: "Kein Schutz gefunden",
            agisLayers: []
          }
        ]
      })
    })
  });

  assert.equal(importResponse.status, 200);
  assert.equal(importResponse.payload.importedCount, 1);
  assert.equal(importResponse.payload.items[0].deadlineDate, "");
  // Ein ungültiges Fristdatum ist ein Datenqualitätsproblem und darf den
  // Schutzstatus nicht überschreiben: der ursprüngliche Status bleibt erhalten,
  // damit ein möglicher Schutztreffer nicht verdeckt wird.
  assert.equal(importResponse.payload.items[0].protectionStatus, "no-hit");
  assert.match(importResponse.payload.items[0].automatedAssessment, /Fristdatum liegt vor Publikationsdatum/i);
});

test("master can store an automatic JSON source url and trigger the first sync", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://files.example.org/agis-export.json");

    return createJsonResponse({
      features: [
        {
          attributes: {
            id: "BG-AUTO-001",
            GES_ID: "AUTO-001",
            Gemeinde: "Brugg",
            Adresse: "Aarauerstrasse 11",
            GES_TITEL: "Vordach",
            GES_EINGANG: "2026-03-21",
            FRISTENDE: "2026-03-30",
            agisMatch: "Treffer im Gebäudeinventar",
            URL: "https://files.example.org/agis-export.json"
          },
          geometry: {
            x: 2651888,
            y: 1251044
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const saveResponse = await requestJson(testServer.baseUrl, "/api/admin/sync-settings", {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceUrl: "https://files.example.org/agis-export.json"
    })
  });

  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.payload.sourceUrl, "https://files.example.org/agis-export.json");
  assert.equal(saveResponse.payload.syncStatus.configured, true);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.notificationCount, 1);

  const detailResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-AUTO-001", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.municipality, "Brugg");
  assert.equal(detailResponse.payload.address, "Aarauerstrasse 11");
  assert.equal(detailResponse.payload.projectType, "Vordach");

  const dashboardResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(dashboardResponse.status, 200);
  assert.ok(
    dashboardResponse.payload.notifications.some(
      (notification) =>
        notification.applicationId === "BG-AUTO-001" &&
        notification.protectionStatus === "protected-point"
    )
  );
});

test("master can use a global website scraping source for a municipality", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://aarau.example.org/baugesuche");

    return new Response(
      `
        <html>
          <body>
            <main>
              <h1>Baugesuche Aarau</h1>
              <p>Öffentliche Auflage vom 24. März 2026 bis 24. April 2026</p>
              <p>
                <strong>Bauherr:</strong> Beispiel AG, Aarau
                <br>
                <strong>Bauobjekt:</strong> Umbau Dachgeschoss
                <br>
                <strong>Bauplatz:</strong> Rathausgasse 4, Parzelle 100 / BG 2026.101
              </p>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const saveResponse = await requestJson(testServer.baseUrl, "/api/admin/sync-settings", {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      sourceMunicipality: "Aarau",
      sourceUrl: "https://aarau.example.org/baugesuche"
    })
  });

  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.payload.sourceType, "html");
  assert.equal(saveResponse.payload.sourceMunicipality, "Aarau");
  assert.equal(saveResponse.payload.syncStatus.configured, true);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.sourceSummaries[0].sourceType, "html");
  assert.equal(syncResponse.payload.items[0].source, "Gemeinde-Webseite");
  assert.equal(syncResponse.payload.items[0].municipality, "Aarau");
  assert.equal(syncResponse.payload.items[0].address, "Rathausgasse 4");
  assert.equal(syncResponse.payload.items[0].projectType, "Umbau Dachgeschoss");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-03-24");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2026-04-24");
});

test("global website scraping settings require a municipality context", async (context) => {
  const testServer = createTestServer({
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const explicitScrapingResponse = await requestJson(testServer.baseUrl, "/api/admin/sync-settings", {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      sourceUrl: "https://aarau.example.org/baugesuche"
    })
  });

  assert.equal(explicitScrapingResponse.status, 400);
  assert.match(explicitScrapingResponse.payload.error, /Gemeinde/i);

  const autoDetectedWebsiteResponse = await requestJson(testServer.baseUrl, "/api/admin/sync-settings", {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceUrl: "https://aarau.example.org/baugesuche"
    })
  });

  assert.equal(autoDetectedWebsiteResponse.status, 400);
  assert.match(autoDetectedWebsiteResponse.payload.error, /Gemeinde/i);
});

test("master can list seeded municipality sources for all Aargau municipalities", async (context) => {
  const testServer = createTestServer({ keepSeededMunicipalitySourcesEnabled: true });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const response = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(response.status, 200);
  assert.ok(response.payload.items.length >= 190);
  assert.ok(response.payload.items.some((item) => item.municipality === "Aarau"));
  assert.ok(response.payload.items.some((item) => item.municipality === "Baden"));
  assert.ok(response.payload.summary.configuredCount >= 190);
  assert.ok(response.payload.summary.enabledCount >= 85);

  const aarauSource = response.payload.items.find((item) => item.municipality === "Aarau");
  const merenschwandSource = response.payload.items.find((item) => item.municipality === "Merenschwand");
  const auwSource = response.payload.items.find((item) => item.municipality === "Auw");
  const jonenSource = response.payload.items.find((item) => item.municipality === "Jonen");
  const muriSource = response.payload.items.find((item) => item.municipality === "Muri");
  const rinikenSource = response.payload.items.find((item) => item.municipality === "Riniken");
  const zuzgenSource = response.payload.items.find((item) => item.municipality === "Zuzgen");

  assert.ok(aarauSource?.sourceUrl.startsWith("https://www.aarau.ch/"));
  assert.equal(aarauSource?.sourceType, "html");
  assert.equal(aarauSource?.enabled, true);
  assert.ok(merenschwandSource?.sourceUrl.includes("/aktuelles/"));
  assert.equal(merenschwandSource?.enabled, true);
  assert.equal(auwSource?.sourceUrl, "https://www.auw.ch/gemeinde/aktuelles.html/402");
  assert.equal(auwSource?.enabled, true);
  assert.match(auwSource?.notes ?? "", /Baugesuchseite/i);
  assert.equal(jonenSource?.enabled, false);
  assert.equal(jonenSource?.sourceUrl, "https://www.jonen.ch");
  assert.equal(muriSource?.enabled, true);
  assert.equal(rinikenSource?.enabled, false);
  assert.match(rinikenSource?.notes ?? "", /einzelne publikation/i);
  assert.equal(zuzgenSource?.sourceType, "html");
  assert.equal(zuzgenSource?.enabled, false);
  assert.match(zuzgenSource?.notes ?? "", /eBau-Seite/i);
  assert.equal(response.payload.summary.totalCount, response.payload.items.length);
});

test("municipality source catalog exposes coverage report, ratings and shared sources", async (context) => {
  const testServer = createTestServer({ keepSeededMunicipalitySourcesEnabled: true });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const response = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.catalogItems.length, 196);
  assert.equal(response.payload.report.totalMunicipalities, 196);
  assert.equal(
    response.payload.report.ratings.A +
      response.payload.report.ratings.B +
      response.payload.report.ratings.C +
      response.payload.report.ratings.D,
    196
  );
  assert.ok(response.payload.report.municipalitiesWithSharedPrimary > 0);
  assert.ok(
    response.payload.report.totalUniqueSources >=
      response.payload.report.totalMunicipalities - response.payload.report.municipalitiesWithSharedPrimary + 1
  );
  assert.ok(response.payload.sharedSources.length >= 1);
  assert.ok(
    response.payload.sharedSources.some(
      (source) => source.name === "AGIS Baugesuche" && source.municipalityCount === 196
    )
  );
  assert.ok(
    response.payload.sharedSources.some(
      (source) => source.name === "eBau Aargau" && source.municipalityCount === 57
    )
  );

  const aarauCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Aarau");
  const aarburgCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Aarburg");
  const abtwilCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Abtwil");
  const ammerswilCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Ammerswil");
  const aristauCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Aristau");
  const arniCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Arni (AG)");
  const auensteinCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Auenstein");
  const auwCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Auw");
  const boniswilCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Boniswil");
  const bremgartenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Bremgarten");
  const dintikonCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Dintikon");
  const fislisbachCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Fislisbach");
  const herznachUekenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Herznach-Ueken");
  const niederlenzCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Niederlenz");
  const oberentfeldenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Oberentfelden");
  const rottenschwilCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Rottenschwil");
  const unterkulmCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Unterkulm");
  const wohlenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Wohlen");
  const zufikonCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Zufikon");
  const moerikenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Möriken-Wildegg");
  const zuzgenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Zuzgen");
  assert.ok(aarauCatalogItem);
  assert.equal(aarauCatalogItem.rating, "A");
  assert.ok(Array.isArray(aarauCatalogItem.supplementalSources));
  assert.ok(aarauCatalogItem.supplementalSources.some((source) => source.name === "eBau Aargau"));
  for (const item of [
    aarburgCatalogItem,
    abtwilCatalogItem,
    aristauCatalogItem,
    arniCatalogItem,
    auensteinCatalogItem,
    auwCatalogItem,
    bremgartenCatalogItem,
    dintikonCatalogItem,
    fislisbachCatalogItem,
    herznachUekenCatalogItem,
    niederlenzCatalogItem,
    oberentfeldenCatalogItem,
    unterkulmCatalogItem,
    wohlenCatalogItem,
    zufikonCatalogItem
  ]) {
    assert.ok(item);
    assert.equal(item.rating, "A");
  }
  assert.ok(ammerswilCatalogItem);
  assert.equal(ammerswilCatalogItem.rating, "A");
  for (const item of [ammerswilCatalogItem, boniswilCatalogItem, rottenschwilCatalogItem]) {
    assert.ok(item);
    assert.equal(item.primarySourceName, "Amtsblatt Aargau");
    assert.equal(item.primaryDirectUrl, "https://amtsblatt.ag.ch/publikationen/");
    assert.equal(item.primaryShared, true);
  }
  assert.ok(moerikenCatalogItem);
  assert.equal(moerikenCatalogItem.rating, "A");
  assert.equal(moerikenCatalogItem.primarySourceName, "Möriken-Wildegg: direkte Baugesuchseite");
  assert.ok(zuzgenCatalogItem);
  assert.equal(zuzgenCatalogItem.primarySourceName, "eBau Aargau");
});

test("municipality source exports are available as json and csv", async (context) => {
  const testServer = createTestServer({ keepSeededMunicipalitySourcesEnabled: true });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const jsonResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources/export.json", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.payload.rows.length, 196);
  assert.equal(jsonResponse.payload.report.totalMunicipalities, 196);
  assert.ok(jsonResponse.payload.rows.some((row) => row.municipality === "Aarau"));

  const csvResponse = await requestText(testServer.baseUrl, "/api/admin/municipality-sources/export.csv", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get("content-type") ?? "", /^text\/csv/i);
  assert.match(csvResponse.body, /^municipality,officialWebsite,primarySourceName,/i);
  assert.match(csvResponse.body, /Aarau/);
});

test("auto-managed municipality sources are refreshed to safer official defaults without overwriting custom settings", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-aargau-db-"));
  const dbPath = join(directory, "test.sqlite");
  const initialDb = createDatabase(dbPath);

  initialDb.prepare(`
    UPDATE municipality_sources
    SET source_type = 'html',
        source_url = 'https://gesuch.rbv-wsw.ch/',
        source_token = '',
        include_pattern = '',
        exclude_pattern = '',
        enabled = 1,
        digital_status = 'digital',
        notes = 'Automatisch erkannte offizielle Baugesuchseite der Gemeinde. (eBaugesuch)'
    WHERE municipality = 'Auw'
  `).run();

  initialDb.prepare(`
    UPDATE municipality_sources
    SET source_type = 'html',
        source_url = 'https://custom.example.org/baugesuche',
        source_token = 'secret-token',
        include_pattern = 'custom',
        exclude_pattern = 'menu',
        enabled = 1,
        digital_status = 'digital',
        notes = 'Eigene Team-Konfiguration'
    WHERE municipality = 'Baden'
  `).run();

  initialDb.prepare(`
    UPDATE municipality_sources
    SET source_type = 'html',
        source_url = 'https://www.full-reuenthal.ch/_rte/information/2660222',
        source_token = '',
        include_pattern = 'baugesuch',
        exclude_pattern = 'einbürger',
        enabled = 0,
        digital_status = 'partial',
        notes = 'Automatisch wurde nur eine einzelne Publikation erkannt. Diese Quelle wird nicht blind als Dauer-Sync aktiviert. (Baubewilligungen)'
    WHERE municipality = 'Full-Reuenthal'
  `).run();

  initialDb.close();

  const migratedDb = createDatabase(dbPath);

  context.after(() => {
    migratedDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const auwSource = migratedDb
    .prepare(`
      SELECT municipality, source_url, enabled, notes
      FROM municipality_sources
      WHERE municipality = 'Auw'
    `)
    .get();
  const badenSource = migratedDb
    .prepare(`
      SELECT municipality, source_url, source_token, include_pattern, exclude_pattern, enabled, notes
      FROM municipality_sources
      WHERE municipality = 'Baden'
    `)
    .get();
  const fullReuenthalSource = migratedDb
    .prepare(`
      SELECT municipality, source_url, enabled, digital_status, notes
      FROM municipality_sources
      WHERE municipality = 'Full-Reuenthal'
    `)
    .get();

  assert.equal(auwSource.source_url, "https://www.auw.ch/gemeinde/aktuelles.html/402");
  assert.equal(auwSource.enabled, 1);
  assert.match(auwSource.notes, /Baugesuchseite/i);

  assert.equal(badenSource.source_url, "https://custom.example.org/baugesuche");
  assert.equal(badenSource.source_token, "secret-token");
  assert.equal(badenSource.include_pattern, "custom");
  assert.equal(badenSource.exclude_pattern, "menu");
  assert.equal(badenSource.enabled, 1);
  assert.equal(badenSource.notes, "Eigene Team-Konfiguration");

  assert.equal(fullReuenthalSource.source_url, "https://www.full-reuenthal.ch/aktuellesinformationen");
  assert.equal(fullReuenthalSource.enabled, 1);
  assert.equal(fullReuenthalSource.digital_status, "digital");
  assert.match(fullReuenthalSource.notes, /Baugesuchseite/i);
});

test("database startup normalizes legacy swapped LV95 application coordinates", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-aargau-db-"));
  const dbPath = join(directory, "test.sqlite");
  const initialDb = createDatabase(dbPath);
  const repository = createApplicationsRepository(initialDb);

  repository.importItems(
    [
      {
        source: "Test",
        sourceReference: "LEGACY-COORDS-001",
        sourceUrl: "https://example.org/legacy",
        municipality: "Aarau",
        address: "Bahnhofstrasse 1",
        parcel: "",
        coordinates: "1250000,2650000",
        publicationDate: "2026-03-01",
        deadlineDate: "2026-03-30",
        projectType: "Umbau",
        description: "Legacy-Koordinaten in alter Reihenfolge",
        protectionStatus: "no-hit",
        agisMatch: "Kein Schutztreffer",
        agisLayers: [],
        automatedAssessment: "Test"
      }
    ],
    "2026-03-01T00:00:00.000Z"
  );
  // Migration als noch nicht angewendet markieren, damit der naechste Start die
  // Legacy-Daten wie bei einer echten Bestands-DB normalisiert.
  initialDb.prepare("DELETE FROM schema_migrations WHERE id = 'normalize-legacy-coordinates'").run();
  initialDb.close();

  const migratedDb = createDatabase(dbPath);

  context.after(() => {
    migratedDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const row = migratedDb
    .prepare("SELECT coordinates FROM applications WHERE source_reference = 'LEGACY-COORDS-001'")
    .get();

  assert.equal(row.coordinates, "2650000,1250000");
});

test("database startup clears deadlines before publication dates", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-aargau-db-"));
  const dbPath = join(directory, "test.sqlite");
  const initialDb = createDatabase(dbPath);
  const repository = createApplicationsRepository(initialDb);

  repository.importItems(
    [
      {
        source: "Test",
        sourceReference: "LEGACY-DATE-001",
        sourceUrl: "https://example.org/legacy-date",
        municipality: "Aarau",
        address: "Bahnhofstrasse 2",
        parcel: "",
        coordinates: "2650000,1250000",
        publicationDate: "2026-05-05",
        deadlineDate: "2026-05-04",
        projectType: "Umbau",
        description: "Legacy-Frist liegt vor Publikation",
        protectionStatus: "no-hit",
        agisMatch: "Kein Schutztreffer",
        agisLayers: [],
        automatedAssessment: "Test"
      }
    ],
    "2026-05-05T00:00:00.000Z"
  );
  // Migration als noch nicht angewendet markieren, damit der naechste Start die
  // ungueltige Frist wie bei einer echten Bestands-DB bereinigt.
  initialDb.prepare("DELETE FROM schema_migrations WHERE id = 'clear-invalid-deadlines'").run();
  initialDb.close();

  const migratedDb = createDatabase(dbPath);

  context.after(() => {
    migratedDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const row = migratedDb
    .prepare(
      "SELECT deadline_date, protection_status, automated_assessment FROM applications WHERE source_reference = 'LEGACY-DATE-001'"
    )
    .get();

  assert.equal(row.deadline_date, "");
  // Die Migration bereinigt nur das ungültige Fristdatum und vermerkt es; der
  // Schutzstatus bleibt erhalten, damit AGIS den Fall weiterhin prüfen kann.
  assert.equal(row.protection_status, "no-hit");
  assert.match(row.automated_assessment, /Fristdatum liegt vor Publikationsdatum/i);
});

test("destructive startup migrations are recorded and do not re-run on restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-migrate-"));
  const dbPath = join(directory, "migrate.sqlite");
  const db = createDatabase(dbPath, { seedDemoApplications: false });

  const recorded = db
    .prepare("SELECT id FROM schema_migrations")
    .all()
    .map((entry) => entry.id);
  assert.ok(recorded.includes("cleanup-seed-artifacts-and-junk"));
  assert.ok(recorded.includes("clear-invalid-deadlines"));

  // Eine Junk-Zeile, die die Bereinigung normalerweise entfernen wuerde.
  const repository = createApplicationsRepository(db);
  repository.importItems(
    [
      {
        id: "BG-MIGRATE-JUNK",
        source: "Gemeinde-Webseite",
        sourceReference: "MIGRATE-JUNK",
        sourceUrl: "https://aarau.example.org/baugesuche",
        municipality: "Aarau",
        address: "Adresse von Webseite prüfen",
        coordinates: "",
        publicationDate: "2026-03-01",
        deadlineDate: "",
        projectType: "Baugesuch",
        description: "Junk",
        protectionStatus: "manual-review",
        agisMatch: "Noch nicht eindeutig zugeordnet",
        agisLayers: [],
        ambiguousAddress: 1
      }
    ],
    "2026-03-01T00:00:00.000Z"
  );
  db.close();

  // Marker bleibt bestehen -> Bereinigung laeuft beim Neustart nicht erneut.
  const reopened = createDatabase(dbPath, { seedDemoApplications: false });
  const remaining = reopened
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE id = 'BG-MIGRATE-JUNK'")
    .get().n;
  reopened.close();
  rmSync(directory, { recursive: true, force: true });

  assert.equal(remaining, 1, "Einmalige Migration darf beim Neustart nicht erneut loeschen");
});

test("destructive startup migration writes a pre-migration backup when data exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-migrate-bak-"));
  const dbPath = join(directory, "migrate.sqlite");
  const seedDb = createDatabase(dbPath, { seedDemoApplications: false });

  const repository = createApplicationsRepository(seedDb);
  repository.importItems(
    [
      {
        id: "BG-BACKUP-001",
        source: "Gemeinde-Webseite",
        sourceReference: "BACKUP-001",
        sourceUrl: "https://aarau.example.org/baugesuche",
        municipality: "Aarau",
        address: "Teststrasse 9",
        coordinates: "2650000,1250000",
        publicationDate: "2026-03-01",
        deadlineDate: "2026-03-30",
        projectType: "Baugesuch",
        description: "Bestehender Fall",
        protectionStatus: "no-hit",
        agisMatch: "Kein Schutztreffer",
        agisLayers: []
      }
    ],
    "2026-03-01T00:00:00.000Z"
  );
  // Marker entfernen, damit die destruktive Migration beim Neustart laeuft.
  seedDb.prepare("DELETE FROM schema_migrations WHERE id = 'cleanup-seed-artifacts-and-junk'").run();
  seedDb.close();

  const reopened = createDatabase(dbPath, { seedDemoApplications: false });
  reopened.close();

  const backupDir = join(directory, "backups");
  const backups = existsSync(backupDir) ? readdirSync(backupDir).filter((name) => name.endsWith(".bak")) : [];
  rmSync(directory, { recursive: true, force: true });

  assert.ok(backups.length >= 1, "Vor der destruktiven Migration wird ein Backup angelegt");
});

test("municipality website sources can be configured and imported automatically", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://aarau.example.org/baugesuche");

    return new Response(
      `
        <html>
          <body>
            <nav>
              <ul>
                <li>
                  <a href="/aktuelles/amtliche-publikationen/einbürgerungen">
                    Einbürgerungen 95
                  </a>
                </li>
                <li>
                  <a href="/baugesuche/märz-2026">
                    März 2026
                  </a>
                </li>
                <li>
                  <a href="/baugesuche/facebook-30">
                    Facebook 30
                  </a>
                </li>
                <li>
                  <a href="/baugesuche/gemeinderatsnachrichten-2026">
                    Gemeinderatsnachrichten 2026
                  </a>
                </li>
              </ul>
            </nav>
            <main>
              <h1>Baugesuche Aarau</h1>
              <p>
                <strong>Baugesuche Woche 12 (Öffentliche Auflage vom Samstag, 21. März 2026, bis Montag, 20. April 2026)</strong>
              </p>
              <p>
                <strong>Bauherr:</strong> Max Muster, Aarau
                <br>
                <strong>Bauobjekt:</strong> Neubau Einfamilienhaus
                <br>
                <strong>Bauplatz:</strong> Bahnhofstrasse 12, Parzelle 998 / BG 2026.021
                <br>
                <a href="/dokumente/baugesuch-bahnhofstrasse-12.pdf">
                  Zu den Dokumenten
                </a>
              </p>
              <p>
                <a href="/dokumente/wohnraumstrategie">
                  Wohnraumstrategie Stadtteilziele 2024
                </a>
              </p>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const aarauSource = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(aarauSource);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${aarauSource.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://aarau.example.org/baugesuche",
        includePattern: "baugesuch|bahnhofstrasse",
        excludePattern: "kontakt|impressum",
        notes: "Digitale Publikationsseite"
      })
    }
  );

  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.payload.item.enabled, true);
  assert.equal(saveResponse.payload.item.sourceType, "html");

  testServer.db
    .prepare(`
      INSERT INTO applications (
        id,
        source,
        source_reference,
        source_url,
        municipality,
        address,
        parcel,
        coordinates,
        publication_date,
        deadline_date,
        project_type,
        description,
        protection_status,
        agis_match,
        agis_layers,
        workflow_status,
        assignee,
        note,
        automated_assessment,
        ambiguous_address,
        last_sync_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "BG-STALE-AARAU-01",
      "Gemeinde-Webseite",
      "AUTO-STALE-AARAU-01",
      "https://aarau.example.org/baugesuche/facebook-30",
      "Aarau",
      "Facebook 30",
      "",
      "",
      "2026-03-20",
      "",
      "Facebook 30",
      "Falscher Altimport",
      "manual-review",
      "Noch nicht eindeutig zugeordnet",
      "[]",
      "new",
      "",
      "",
      "Standort konnte auf der Gemeindewebseite nicht eindeutig gefunden werden.",
      1,
      "2026-03-20T10:00:00.000Z",
      "2026-03-20T10:00:00.000Z",
      "2026-03-20T10:00:00.000Z"
    );
  testServer.db
    .prepare(`
      INSERT INTO applications (
        id,
        source,
        source_reference,
        source_url,
        municipality,
        address,
        parcel,
        coordinates,
        publication_date,
        deadline_date,
        project_type,
        description,
        protection_status,
        agis_match,
        agis_layers,
        workflow_status,
        assignee,
        note,
        automated_assessment,
        ambiguous_address,
        last_sync_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "BG-STALE-AARAU-02",
      "Gemeinde-Webseite",
      "AUTO-STALE-AARAU-02",
      "https://aarau.example.org/dokumente/wohnraumstrategie",
      "Aarau",
      "Wohnraumstrategie Stadtteilziele 2024",
      "",
      "",
      "",
      "",
      "Wohnraumstrategie Stadtteilziele 2024",
      "Falscher Altimport",
      "manual-review",
      "Noch nicht eindeutig zugeordnet",
      "[]",
      "new",
      "",
      "",
      "Standort konnte auf der Gemeindewebseite nicht eindeutig gefunden werden.",
      1,
      "2026-03-20T10:00:00.000Z",
      "2026-03-20T10:00:00.000Z",
      "2026-03-20T10:00:00.000Z"
    );

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.ok(syncResponse.payload.sourceSummaries.some((entry) => entry.municipality === "Aarau"));
  assert.equal(syncResponse.payload.items[0].address, "Bahnhofstrasse 12");
  assert.equal(syncResponse.payload.items[0].projectType, "Neubau Einfamilienhaus");
  assert.equal(
    testServer.db.prepare("SELECT COUNT(*) AS count FROM applications WHERE address = 'Facebook 30'").get().count,
    0
  );
  assert.equal(
    testServer.db
      .prepare("SELECT COUNT(*) AS count FROM applications WHERE address = 'Wohnraumstrategie Stadtteilziele 2024'")
      .get().count,
    0
  );

  const importedItemId = syncResponse.payload.items[0].id;
  const detailResponse = await requestJson(testServer.baseUrl, `/api/applications/${importedItemId}`, {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.source, "Gemeinde-Webseite");
  assert.equal(detailResponse.payload.municipality, "Aarau");
  assert.equal(detailResponse.payload.address, "Bahnhofstrasse 12");
  assert.equal(detailResponse.payload.projectType, "Neubau Einfamilienhaus");
  assert.equal(detailResponse.payload.protectionStatus, "manual-review");
  assert.equal(detailResponse.payload.deadlineDate, "2026-04-20");
  assert.equal(detailResponse.payload.publicationDate, "2026-03-21");
});

test("municipality import collapses repeated leading path segments in detail links", async (context) => {
  const sourceUrl = "http://www.doettingen.ch/gemeinde/mitteilungen/baugesuche/";
  const detailUrl =
    "http://www.doettingen.ch/gemeinde/mitteilungen/baugesuche/baugesuche-liste/latest/detailansicht/?tx_ttnews%5Btt_news%5D=5636";
  const duplicateUrl =
    "http://www.doettingen.ch/gemeinde/mitteilungen/baugesuche/gemeinde/mitteilungen/baugesuche/baugesuche-liste/latest/detailansicht/?tx_ttnews%5Btt_news%5D=5636";
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === sourceUrl) {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baugesuche</h1>
                <a href="gemeinde/mitteilungen/baugesuche/baugesuche-liste/latest/detailansicht/?tx_ttnews%5Btt_news%5D=5636">
                  Baugesuch Neubau EFH
                </a>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    assert.equal(String(url), detailUrl);
    return new Response(
      `
        <html>
          <body>
            <main>
              <h1>Baugesuch</h1>
              <p>Bauherr: Test Bauherrschaft, Döttingen</p>
              <p>Bauprojekt: Neubau EFH mit Doppelgarage</p>
              <p>Lage: Parz. Nr. 1615, Erlenweg 9, 5312 Döttingen</p>
              <p>Publikation: 16.05.2026, Auflage bis 15.06.2026</p>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Döttingen");
  assert.ok(source);

  await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl,
      includePattern: "",
      excludePattern: "",
      notes: "Digitale Publikationsseite"
    })
  });

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].sourceUrl, detailUrl);
  assert.ok(requestedUrls.includes(detailUrl));
  assert.equal(requestedUrls.includes(duplicateUrl), false);
});

test("municipality import hydrates official detail pages and ignores generic archive titles", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://fischbach.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baubewilligungen</h1>
                <article>
                  <a href="/baubewilligung-bg-2025-026/">Baubewilligung BG 2025-026</a>
                  <p>11. September 2025 in Baubewilligungen</p>
                </article>
                <article>
                  <a href="/category/baubewilligungen/">Baubewilligungen</a>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://fischbach.example.org/baubewilligung-bg-2025-026/") {
      return new Response(
        `
          <html>
            <head>
              <title>Baubewilligung BG 2025-026</title>
              <meta
                name="description"
                content="Bauherrschaft: Karin und Oliver Markl. Bauobjekt: Neubau Wintergarten (beheizt) und Terrassendeck. Lage: Parzelle Nr. 537. Publiziert am 11. September 2025."
              />
            </head>
            <body>
              <main>
                <article>
                  <p><strong>Bauobjekt:</strong> Neubau Wintergarten (beheizt) und Terrassendeck</p>
                  <p><strong>Lage:</strong> Parzelle Nr. 537</p>
                  <p><strong>Publiziert:</strong> 11. September 2025</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected municipality sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Fischbach-Göslikon");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://fischbach.example.org/baugesuche",
        includePattern: "baubewilligung|baugesuch",
        excludePattern: "facebook|newsletter|einbürgerungen",
        notes: "Offizielle Baugesuchseite"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.ok(requestedUrls.includes("https://fischbach.example.org/baubewilligung-bg-2025-026/"));
  assert.equal(syncResponse.payload.items[0].municipality, "Fischbach-Göslikon");
  assert.equal(syncResponse.payload.items[0].address, "Parzelle 537");
  assert.equal(syncResponse.payload.items[0].projectType, "Neubau Wintergarten (beheizt) und Terrassendeck");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2025-09-11");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2025-10-11");
  assert.equal(syncResponse.payload.items[0].sourceUrl, "https://fischbach.example.org/baubewilligung-bg-2025-026/");

  const duplicateCategoryCount = testServer.db
    .prepare("SELECT COUNT(*) AS count FROM applications WHERE source_url = 'https://fischbach.example.org/category/baubewilligungen/'")
    .get().count;
  assert.equal(duplicateCategoryCount, 0);
});

test("municipality import keeps clear Baugesuch without a date for manual review", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://datelos.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baugesuche</h1>
                <article>
                  <a href="/baugesuch-bg-2026-099/">Baugesuch BG 2026-099</a>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://datelos.example.org/baugesuch-bg-2026-099/") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-099</title>
              <meta
                name="description"
                content="Bauherrschaft: Sandra Bachmann. Bauobjekt: Neubau Gartenhaus mit Pergola. Lage: Parzelle Nr. 412."
              />
            </head>
            <body>
              <main>
                <article>
                  <p><strong>Bauobjekt:</strong> Neubau Gartenhaus mit Pergola</p>
                  <p><strong>Lage:</strong> Parzelle Nr. 412</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected municipality sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Fischbach-Göslikon");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://datelos.example.org/baugesuche",
        includePattern: "baubewilligung|baugesuch",
        excludePattern: "facebook|newsletter",
        notes: "Baugesuchseite ohne Datum"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const imported = syncResponse.payload.items[0];
  assert.equal(imported.municipality, "Fischbach-Göslikon");
  assert.equal(imported.address, "Parzelle 412");
  assert.equal(imported.publicationDate, "");
  assert.equal(imported.deadlineDate, "");
  assert.equal(imported.protectionStatus, "manual-review");
  assert.match(imported.automatedAssessment, /von Hand prüfen/i);
});

test("municipality import reads definition-list publication layouts cleanly", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://dl.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baupublikationen</h1>
                <p>Öffentliche Auflage vom 10. Mai 2026 bis 9. Juni 2026</p>
                <dl>
                  <dt>Bauherrschaft</dt>
                  <dd>Familie Brunner, Lenzburg</dd>
                  <dt>Bauvorhaben</dt>
                  <dd>Neubau Doppelgarage mit Vordach</dd>
                  <dt>Standort</dt>
                  <dd>Lindenweg 9, Parzelle 233</dd>
                </dl>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected municipality sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Fischbach-Göslikon");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://dl.example.org/baugesuche",
      includePattern: "baugesuch|baubewilligung|bauvorhaben|bauobjekt",
      excludePattern: "facebook|newsletter",
      notes: "Definitionslisten-Layout"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const imported = syncResponse.payload.items[0];
  assert.equal(imported.municipality, "Fischbach-Göslikon");
  assert.equal(imported.address, "Lindenweg 9");
  assert.equal(imported.parcel, "233");
  assert.equal(imported.projectType, "Neubau Doppelgarage mit Vordach");
  assert.equal(imported.publicationDate, "2026-05-10");
  assert.equal(imported.deadlineDate, "2026-06-09");
});

test("municipality import reads bold-label layouts with synonym wording", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://bold.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baugesuche</h1>
                <p>Öffentliche Auflage vom 3. April 2026 bis 3. Mai 2026</p>
                <p>
                  <b>Bauherrschaft:</b> Familie Keller, Aarau
                  <br>
                  <b>Bauvorhaben:</b> Aufstockung Mehrfamilienhaus
                  <br>
                  <b>Standort:</b> Schulstrasse 14, Parzelle 678
                </p>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected municipality sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Fischbach-Göslikon");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://bold.example.org/baugesuche",
      includePattern: "baugesuch|baubewilligung|bauvorhaben|bauobjekt",
      excludePattern: "facebook|newsletter",
      notes: "Fettschrift-Layout mit Synonymen"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const imported = syncResponse.payload.items[0];
  assert.equal(imported.municipality, "Fischbach-Göslikon");
  assert.equal(imported.address, "Schulstrasse 14");
  assert.equal(imported.parcel, "678");
  assert.equal(imported.projectType, "Aufstockung Mehrfamilienhaus");
  assert.equal(imported.publicationDate, "2026-04-03");
  assert.equal(imported.deadlineDate, "2026-05-03");
});

test("municipality import prefers official detail pages over vague list titles", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://muri.example.org/baupublikationen") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <article>
                  <p><time datetime="2026-02-23 08:00">23. Februar 2026</time></p>
                  <a href="/baupublikationen/news/2918">Baugesuch Einwohnergemeinde Muri</a>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://muri.example.org/baupublikationen/news/2918") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <p>Öffentliche Auflage vom 23. Februar 2026 bis 24. März 2026</p>
                <table>
                  <tbody>
                    <tr>
                      <td>Bauherr:</td>
                      <td>Einwohnergemeinde Muri, Seetalstrasse 6, 5630 Muri</td>
                    </tr>
                    <tr>
                      <td>Bauobjekt:</td>
                      <td>Naturerlebnispfad Maiholzwald</td>
                    </tr>
                    <tr>
                      <td>Bauplatz:</td>
                      <td>Parzelle Nr. 1994, Maiholzwald</td>
                    </tr>
                    <tr>
                      <td>Weitere Bewilligungen:</td>
                      <td>Departement Bau, Verkehr und Umwelt</td>
                    </tr>
                  </tbody>
                </table>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected municipality sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Muri");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://muri.example.org/baupublikationen",
      includePattern: "baugesuch|auflage",
      excludePattern: "newsletter|archiv",
      notes: "Offizielle Baupublikationen"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Parzelle 1994");
  assert.equal(syncResponse.payload.items[0].projectType, "Naturerlebnispfad Maiholzwald");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-02-23");
});

test("municipality import supports official RSS feeds with linked detail pages", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://feed.example.org/baugesuche.rss") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Baugesuche</title>
            <item>
              <title>Baubewilligung BG 2026-014</title>
              <link>https://feed.example.org/baugesuche/bg-2026-014</link>
              <description><![CDATA[Publiziert am 24. März 2026.]]></description>
              <pubDate>Tue, 24 Mar 2026 09:00:00 GMT</pubDate>
            </item>
            <item>
              <title>Newsletter April 2026</title>
              <link>https://feed.example.org/newsletter/april-2026</link>
              <description>Gemeinde-News</description>
              <pubDate>Tue, 24 Mar 2026 09:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>`,
        {
          status: 200,
          headers: {
            "Content-Type": "application/rss+xml"
          }
        }
      );
    }

    if (String(url) === "https://feed.example.org/baugesuche/bg-2026-014") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <article>
                  <p><strong>Bauobjekt:</strong> Ersatzneubau Carport</p>
                  <p><strong>Bauplatz:</strong> Hauptstrasse 17</p>
                  <p><strong>Publiziert:</strong> 24. März 2026</p>
                  <p><strong>Auflagefrist:</strong> 24. April 2026</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://feed.example.org/newsletter/april-2026") {
      return new Response("<html><body><main><article><h1>Newsletter</h1></article></main></body></html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      });
    }

    throw new Error(`Unexpected municipality sync URL: ${url}`);
  };

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Hauptstrasse%2017/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Hauptstrasse 17, 5000 Aarau",
            origin: "address",
            x: 2649567.12,
            y: 1249834.55
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "xml",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://feed.example.org/baugesuche.rss",
        includePattern: "baugesuch|baubewilligung|hauptstrasse",
        excludePattern: "newsletter|facebook|einbürgerungen",
        notes: "Offizieller Feed"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.ok(requestedUrls.includes("https://feed.example.org/baugesuche/bg-2026-014"));
  assert.equal(syncResponse.payload.items[0].municipality, "Aarau");
  assert.equal(syncResponse.payload.items[0].address, "Hauptstrasse 17");
  assert.equal(syncResponse.payload.items[0].projectType, "Ersatzneubau Carport");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-03-24");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2026-04-24");
  assert.equal(syncResponse.payload.items[0].source, "Gemeinde-Feed");

  const importedNoiseCount = testServer.db
    .prepare("SELECT COUNT(*) AS count FROM applications WHERE source_url = 'https://feed.example.org/newsletter/april-2026'")
    .get().count;
  assert.equal(importedNoiseCount, 0);
});

test("municipality import auto-detects XML feed URLs even if a source is configured as html", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://autodetect.example.org/baugesuche.xml") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Baugesuche</title>
            <item>
              <title>Baubewilligung BG 2026-021</title>
              <link>https://autodetect.example.org/baugesuche/bg-2026-021</link>
              <description><![CDATA[Publiziert am 7. April 2026.]]></description>
            </item>
          </channel>
        </rss>`,
        {
          status: 200,
          headers: {
            "Content-Type": "application/rss+xml"
          }
        }
      );
    }

    if (String(url) === "https://autodetect.example.org/baugesuche/bg-2026-021") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <article>
                  <p><strong>Bauobjekt:</strong> Anbau Wintergarten</p>
                  <p><strong>Bauplatz:</strong> Bahnhofstrasse 4</p>
                  <p><strong>Publiziert:</strong> 7. April 2026</p>
                  <p><strong>Auflagefrist:</strong> 7. Mai 2026</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected autodetect URL: ${url}`);
  };

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Bahnhofstrasse%204/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Bahnhofstrasse 4, 5000 Aarau",
            origin: "address",
            x: 2648704.11,
            y: 1249644.22
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://autodetect.example.org/baugesuche.xml",
        includePattern: "",
        excludePattern: "",
        notes: "Autodetect"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);

  const importedApplication = testServer.db
    .prepare(`
      SELECT municipality, address, project_type, source
      FROM applications
      WHERE source_url = 'https://autodetect.example.org/baugesuche/bg-2026-021'
    `)
    .get();

  assert.ok(importedApplication);
  assert.equal(importedApplication.municipality, "Aarau");
  assert.equal(importedApplication.address, "Bahnhofstrasse 4");
  assert.equal(importedApplication.project_type, "Anbau Wintergarten");
  assert.equal(importedApplication.source, "Gemeinde-Feed");
});

test("municipality import supports sitemap sources with official detail pages", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://sitemap.example.org/baugesuche.xml") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://sitemap.example.org/baugesuche/hauptstrasse-9</loc></url>
          <url><loc>https://sitemap.example.org/aktuelles/veranstaltung</loc></url>
        </urlset>`,
        {
          status: 200,
          headers: {
            "Content-Type": "application/xml"
          }
        }
      );
    }

    if (String(url) === "https://sitemap.example.org/baugesuche/hauptstrasse-9") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <article>
                  <p><strong>Bauobjekt:</strong> Dachsanierung mit Gaube</p>
                  <p><strong>Bauplatz:</strong> Hauptstrasse 9</p>
                  <p><strong>Publiziert:</strong> 2. April 2026</p>
                  <p><strong>Auflagefrist:</strong> 2. Mai 2026</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://sitemap.example.org/aktuelles/veranstaltung") {
      return new Response(
        "<html><body><main><article><h1>Frühlingsfest</h1><p>Agenda</p></article></main></body></html>",
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected sitemap sync URL: ${url}`);
  };

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Hauptstrasse%209/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Hauptstrasse 9, 5400 Baden",
            origin: "address",
            x: 2669001.2,
            y: 1256111.4
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Baden");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "xml",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://sitemap.example.org/baugesuche.xml",
        includePattern: "baugesuch|hauptstrasse|dachsanierung",
        excludePattern: "veranstaltung|agenda|newsletter",
        notes: "Sitemap mit Publikationsseiten"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.ok(requestedUrls.includes("https://sitemap.example.org/baugesuche/hauptstrasse-9"));
  assert.equal(syncResponse.payload.items[0].municipality, "Baden");
  assert.equal(syncResponse.payload.items[0].address, "Hauptstrasse 9");
  assert.equal(syncResponse.payload.items[0].projectType, "Dachsanierung mit Gaube");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-04-02");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2026-05-02");
  assert.equal(syncResponse.payload.items[0].source, "Gemeinde-Sitemap");

  const importedNoiseCount = testServer.db
    .prepare("SELECT COUNT(*) AS count FROM applications WHERE source_url = 'https://sitemap.example.org/aktuelles/veranstaltung'")
    .get().count;
  assert.equal(importedNoiseCount, 0);
});

test("municipality import supports official iframe-embedded publication pages", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://iframe.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <iframe src="/widgets/baugesuche-aktuell"></iframe>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://iframe.example.org/widgets/baugesuche-aktuell") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <article>
                  <p><strong>Bauobjekt:</strong> Ersatzneubau Gartenhaus</p>
                  <p><strong>Bauplatz:</strong> Dorfstrasse 15</p>
                  <p><strong>Publiziert:</strong> 4. April 2026</p>
                  <p><strong>Auflagefrist:</strong> 4. Mai 2026</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected iframe sync URL: ${url}`);
  };

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Dorfstrasse%2015/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Dorfstrasse 15, 5600 Lenzburg",
            origin: "address",
            x: 2658001.4,
            y: 1242500.6
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Lenzburg");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://iframe.example.org/baugesuche",
        includePattern: "baugesuch|bauobjekt|dorfstrasse|gartenhaus",
        excludePattern: "newsletter|facebook|agenda",
        notes: "Eingebettete offizielle Publikationsseite"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.ok(requestedUrls.includes("https://iframe.example.org/widgets/baugesuche-aktuell"));
  assert.equal(syncResponse.payload.items[0].municipality, "Lenzburg");
  assert.equal(syncResponse.payload.items[0].address, "Dorfstrasse 15");
  assert.equal(syncResponse.payload.items[0].projectType, "Ersatzneubau Gartenhaus");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-04-04");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2026-05-04");
});

test("municipality import extracts official publication metadata from JSON-LD pages", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://jsonld.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <head>
              <title>Amtliche Publikationen</title>
              <script type="application/ld+json">
                {
                  "@context": "https://schema.org",
                  "@type": "Article",
                  "headline": "Baugesuch Bahnhofstrasse 18",
                  "description": "Bauobjekt: Ersatzneubau Garage. Bauplatz: Bahnhofstrasse 18. Publiziert: 6. April 2026. Auflagefrist: 6. Mai 2026.",
                  "datePublished": "2026-04-06T08:00:00+02:00"
                }
              </script>
            </head>
            <body>
              <main>
                <h1>Publikationen</h1>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected JSON-LD sync URL: ${url}`);
  };

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Bahnhofstrasse%2018/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Bahnhofstrasse 18, 5000 Aarau",
            origin: "address",
            x: 2648818.5,
            y: 1249707.3
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(
    testServer.baseUrl,
    `/api/admin/municipality-sources/${source.id}`,
    {
      method: "PATCH",
      headers: {
        Cookie: masterCookie
      },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl: "https://jsonld.example.org/baugesuche",
        includePattern: "baugesuch|bahnhofstrasse|garage",
        excludePattern: "newsletter|facebook|agenda",
        notes: "JSON-LD Publikationsseite"
      })
    }
  );

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].municipality, "Aarau");
  assert.equal(syncResponse.payload.items[0].address, "Bahnhofstrasse 18");
  assert.equal(syncResponse.payload.items[0].projectType, "Ersatzneubau Garage");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-04-06");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2026-05-06");
});

test("municipality import geocodes valid addresses through the official swiss search service", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://aarau.example.org/baugesuche");

    return new Response(
      `
        <html>
          <body>
            <main>
              <article>
                <a href="/bg-2026-001">Baugesuch Bahnhofstrasse 12</a>
                <p>Bauobjekt: Neubau Einfamilienhaus</p>
                <p>Bauplatz: Bahnhofstrasse 12</p>
                <p>Publiziert: 21. März 2026</p>
              </article>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };
  const geocodeFetchImpl = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.origin, "https://api3.geo.admin.ch");
    assert.match(requestUrl.searchParams.get("searchText") ?? "", /Bahnhofstrasse 12, Aarau/i);

    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Bahnhofstrasse 12, 5000 Aarau",
            municipality: "Aarau",
            x: 2648701,
            y: 1249642
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau.example.org/baugesuche",
      includePattern: "baugesuch|bauobjekt|bauplatz",
      excludePattern: "newsletter|facebook|archiv",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Bahnhofstrasse 12");
  assert.equal(syncResponse.payload.items[0].coordinates, "2648701,1249642");
  assert.equal(syncResponse.payload.items[0].protectionStatus, "no-hit");
  assert.match(syncResponse.payload.items[0].automatedAssessment, /Adresssuchdienst/i);
});

test("municipality import refines split house-number locations before manual review", async (context) => {
  const syncFetchImpl = async (url) => {
    if (
      String(url) !== "https://wettingen.example.org/baugesuche" &&
      String(url) !== "https://wettingen.example.org/bg-2026-120"
    ) {
      throw new Error(`Unexpected Wettingen sync URL: ${url}`);
    }

    return new Response(
      `
        <html>
          <body>
            <main>
              <article>
                <a href="/bg-2026-120">Baugesuch BG-2026-120</a>
                <p>Bauvorhaben: Umnutzung eines Erdgeschosses ohne sichtbare Aussenveränderung.</p>
                <p>Standort: 120</p>
                <p>Strasse: Landstrasse</p>
                <p>Parzelle Nr. 5220</p>
                <p>Publiziert: 15. März 2026</p>
              </article>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };
  const geocodeFetchImpl = async (url) => {
    const requestUrl = new URL(String(url));
    assert.match(requestUrl.searchParams.get("searchText") ?? "", /Landstrasse 120, Wettingen/i);

    return createJsonResponse({
      results: [
        {
          attrs: {
            origin: "address",
            label: "Landstrasse 120, 5430 Wettingen",
            municipality: "Wettingen",
            x: 2660160,
            y: 1258505
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Wettingen");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://wettingen.example.org/baugesuche",
      includePattern: "baugesuch|landstrasse|standort|parzelle",
      excludePattern: "newsletter|facebook|archiv",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Landstrasse 120");
  assert.equal(syncResponse.payload.items[0].parcel, "5220");
  assert.equal(syncResponse.payload.items[0].coordinates, "2660160,1258505");
  assert.equal(syncResponse.payload.items[0].protectionStatus, "no-hit");
  assert.equal(syncResponse.payload.items[0].ambiguousAddress, false);
  assert.match(syncResponse.payload.items[0].automatedAssessment, /KI-Datenprüfung/i);

  const detailResponse = await requestJson(
    testServer.baseUrl,
    `/api/applications/${encodeURIComponent(syncResponse.payload.items[0].id)}`,
    {
      headers: {
        Cookie: masterCookie
      }
    }
  );

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.address, "Landstrasse 120");
  assert.equal(detailResponse.payload.parcel, "5220");
});

test("municipality import geocodes addresses without a street suffix and skips coarse municipality hits", async (context) => {
  const syncFetchImpl = async () => {
    return new Response(
      `
        <html>
          <body>
            <main>
              <article>
                <a href="/bg-2026-077">Baugesuch Vorstadt 7</a>
                <p>Bauobjekt: Umbau Wohnhaus</p>
                <p>Bauplatz: Vorstadt 7</p>
                <p>Publiziert: 21. März 2026</p>
              </article>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };
  const geocodeFetchImpl = async (url) => {
    const requestUrl = new URL(String(url));
    assert.match(requestUrl.searchParams.get("searchText") ?? "", /Vorstadt 7, Aarau/i);

    return createJsonResponse({
      results: [
        {
          // Grober Gemeindeumriss-Treffer: muss verworfen werden, damit kein
          // falscher "kein Schutz"-Befund am Ortszentrum entsteht.
          attrs: {
            origin: "gg25",
            label: "Aarau",
            municipality: "Aarau",
            x: 2645000,
            y: 1248000
          }
        },
        {
          // Genauer Adresstreffer: dieser zaehlt.
          attrs: {
            origin: "address",
            label: "Vorstadt 7, 5000 Aarau",
            municipality: "Aarau",
            x: 2648777,
            y: 1249777
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau.example.org/baugesuche",
      includePattern: "baugesuch|bauobjekt|bauplatz",
      excludePattern: "newsletter|facebook|archiv",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Vorstadt 7");
  // Der grobe gg25-Treffer wird ignoriert, der genaue Adresstreffer gewinnt.
  assert.equal(syncResponse.payload.items[0].coordinates, "2648777,1249777");
  assert.equal(syncResponse.payload.items[0].protectionStatus, "no-hit");
});

test("municipality import can geocode parcel-based locations through the official swiss search service", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://auenstein.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <article>
                  <a href="/news/3163">Öffentliche Auflage - Baugesuch 2026-0011</a>
                  <p>Bauobjekt: Installation Luft-Wasser-Wärmepumpe (aussenaufgestellt)</p>
                  <p>Bauplatz: Parzelle Nr. 1297</p>
                  <p>Publiziert: 12. März 2026</p>
                </article>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://auenstein.example.org/news/3163") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Öffentliche Auflage - Baugesuch 2026-0011</h1>
                <p>Bauobjekt: Installation Luft-Wasser-Wärmepumpe (aussenaufgestellt)</p>
                <p>Bauplatz: Parzelle Nr. 1297; Gebäude Nr. 24b; Hueb 24b</p>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected Auenstein sync URL: ${url}`);
  };
  const geocodeFetchImpl = async (url) => {
    assert.match(decodeURIComponent(String(url)), /Hueb\+24b,\+Auenstein|Hueb 24b, Auenstein/i);

    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Hueb 24b, Auenstein",
            municipality: "Auenstein",
            x: 2641000,
            y: 1251000
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Auenstein");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://auenstein.example.org/baugesuche",
      includePattern: "baugesuch|parzelle",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Hueb 24b");
  assert.equal(syncResponse.payload.items[0].coordinates, "2641000,1251000");
  assert.equal(syncResponse.payload.items[0].protectionStatus, "no-hit");
});

test("municipality import resolves the correct address from mixed official overview context", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://aarau-detail.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <p>
                  <strong>Baugesuche Woche 12 (Öffentliche Auflage vom Samstag, 21. März 2026, bis Montag, 20. April 2026)</strong>
                  <br>
                  <strong>Bauobjekt:</strong> Revitalisierung Markthalle
                  <br>
                  <strong>Bauplatz:</strong> Bahnhofstrasse 20 / BG 2026.028
                  <br>
                  <a href="/leben/bauen/baugesuche/bg-2026028_bahnhofstrasse-20.html/2964">
                    Zu den Dokumenten
                  </a>
                </p>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://aarau-detail.example.org/leben/bauen/baugesuche/bg-2026028_bahnhofstrasse-20.html/2964") {
      return new Response(
        `
          <html>
            <head>
              <title>BG 2026.028_Bahnhofstrasse 20</title>
            </head>
            <body>
              <main>
                <h1>BG 2026.028_Bahnhofstrasse 20</h1>
                <ul>
                  <li>
                    <a href="/dokumente/Baugesuch_Neubau_Wohnhaus_Bahnhofstrasse_20.pdf">
                      Baugesuch Neubau Wohnhaus Bahnhofstrasse 20
                    </a>
                  </li>
                </ul>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected Aarau detail sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau-detail.example.org/baugesuche",
      includePattern: "baugesuch|bahnhofstrasse",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Bahnhofstrasse 20");
  assert.ok(
    requestedUrls.includes("https://aarau-detail.example.org/leben/bauen/baugesuche/bg-2026028_bahnhofstrasse-20.html/2964")
  );
});

test("municipality import narrows Aarau overview blocks by official BG links instead of generic document text", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://aarau-overview.example.org/baugesuche");

    return new Response(
      `
        <html>
          <body>
            <main>
              <p>
                <strong>Baugesuche Woche 09 (Öffentliche Auflage vom Samstag, 28. Februar 2026, bis Montag, 30. März 2026)</strong>
                <br>
                <strong>Bauherr:</strong> Stadt Aarau
                <br>
                <strong>Bauobjekt:</strong> Aufwertungsmassnahmen Markthalle
                <br>
                <strong>Bauplatz:</strong> Pelzgasse, Parzelle 1736 / BG 2025.134
                <br>
                <em>Wird zu einem späteren Zeitpunkt publiziert.</em>
                <br>
                <br>
                <strong>Bauherr:</strong> Fasler Susanne, Herzogstrasse 51, Aarau
                <br>
                <strong>Bauobjekt:</strong> Umnutzung Einliegerwohnung EG in Wohnraum, Fenstereinbau
                <br>
                <strong>Bauplatz:</strong> Herzogstrasse 51, Parzelle 2246 / BG 2026.042
                <br>
                <a href="https://aarau-overview.example.org/leben/bauen/baugesuche/bg-2026042_herzogstrasse-51.html/2978">
                  Zu den Dokumenten
                </a>
                <br>
                <br>
                <strong>Bauherr:</strong> APGISGA, Allgemeine Plakatgesellschaft AG, Münchenstein
                <br>
                <strong>Bauobjekt:</strong> Umbau bestehender F200L in City ePanel 75 Zoll
                <br>
                <strong>Bauplatz:</strong> Tellistrasse, Parzelle 5065 / BG 2026.044
                <br>
                <a href="https://aarau-overview.example.org/leben/bauen/baugesuche/bg-2026044_tellistrasse.html/2969">
                  Zu den Dokumenten
                </a>
              </p>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau-overview.example.org/baugesuche",
      includePattern: "herzogstrasse|2026.042|2026042",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Herzogstrasse 51");
  assert.equal(syncResponse.payload.items[0].projectType, "Umnutzung Einliegerwohnung EG in Wohnraum, Fenstereinbau");
});

test("municipality import keeps official Aarau publication blocks separated", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://aarau-blocks.example.org/baugesuche");

    return new Response(
      `
        <html>
          <body>
            <main>
              <p>
                <strong>Baugesuche Woche 11 (Öffentliche Auflage vom Samstag, 14. März 2026, bis Montag, 13. April 2026)</strong>
                <br>
                <strong>Bauherr:</strong> APGISGA, Allgemeine Plakatgesellschaft AG, Münchenstein
                <br>
                <strong>Bauobjekt:</strong> Umbau bestehender F200L in City ePanel 75 Zoll
                <br>
                <strong>Bauplatz:</strong> Tellistrasse, Parzelle 5065 / BG 2026.044
                <br>
                <a href="https://aarau-blocks.example.org/leben/bauen/baugesuche/bg-2026044_tellistrasse.html/2969">
                  Zu den Dokumenten
                </a>
                <br>
                <br>
                <strong>Bauherr:</strong> Beispiel AG, Aarau
                <br>
                <strong>Bauobjekt:</strong> Sanierung Schaufensteranlage
                <br>
                <strong>Bauplatz:</strong> Mühlemattstrasse 51, Parzelle 1234 / BG 2026.045
                <br>
                <a href="https://aarau-blocks.example.org/leben/bauen/baugesuche/bg-2026045_muehlemattstrasse-51.html/2970">
                  Zu den Dokumenten
                </a>
              </p>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau-blocks.example.org/baugesuche",
      includePattern: "baugesuch|2026.044|2026.045",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 2);

  const tellistrasse = syncResponse.payload.items.find((item) => item.sourceUrl.includes("bg-2026044_tellistrasse"));
  const muehlematt = syncResponse.payload.items.find((item) => item.sourceUrl.includes("bg-2026045_muehlemattstrasse-51"));

  assert.ok(tellistrasse);
  assert.ok(muehlematt);
  assert.equal(tellistrasse.address, "Tellistrasse");
  assert.equal(tellistrasse.projectType, "Umbau bestehender F200L in City ePanel 75 Zoll");
  assert.equal(muehlematt.address, "Mühlemattstrasse 51");
  assert.equal(muehlematt.projectType, "Sanierung Schaufensteranlage");
});

test("municipality import derives project types from official pdf publication titles", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://birmenstorf.example.org/baugesuche");

    return new Response(
      `
        <html>
          <body>
            <main>
              <h1>Baugesuche / öffentliche Auflagen</h1>
              <ul class="uploads-list">
                <li>
                  <div class="uploads-fileNameWrap">
                    <span class="uploads-fileName">
                      <strong>BG 2025-0035 Cubical AG, Dietikon; Sanierung MFH, Badenerstrasse 18 - Frist bis 07.04.2026</strong>
                    </span>
                    <a href="/fileadmin/user_upload/BG_2025-0035_Cubical_AG__Dietikon__Sanierung_MFH__Badenerstrasse_18_-_Frist_bis_07.04.2026.pdf">
                      Herunterladen
                    </a>
                  </div>
                </li>
              </ul>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  };
  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birmenstorf");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://birmenstorf.example.org/baugesuche",
      includePattern: "baugesuch|badenerstrasse",
      excludePattern: "kontakt|impressum",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Badenerstrasse 18");
  assert.equal(syncResponse.payload.items[0].projectType, "Sanierung MFH");
  assert.equal(syncResponse.payload.items[0].protectionStatus, "manual-review");
});

test("municipality import can extract official details from publication PDFs when link text is too vague", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://pdf-detail.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <ul>
                  <li>
                    <a href="/amtliche-publikationen/BG-2026-090.pdf">
                      Baubewilligung BG 2026-090
                    </a>
                  </li>
                </ul>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://pdf-detail.example.org/amtliche-publikationen/BG-2026-090.pdf") {
      return new Response("%PDF-1.6 binary", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf"
        }
      });
    }

    throw new Error(`Unexpected PDF detail sync URL: ${url}`);
  };

  const pdfTextExtractImpl = async (_buffer) =>
    "Baubewilligung BG 2026-090 Bauobjekt: Ersatzneubau Geräteschopf Bauplatz: Dorfstrasse 27 Publiziert: 8. April 2026 Auflagefrist: 8. Mai 2026";

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Dorfstrasse%2027/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Dorfstrasse 27, 5600 Lenzburg",
            origin: "address",
            x: 2658123.5,
            y: 1242550.7
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    pdfTextExtractImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Lenzburg");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://pdf-detail.example.org/baugesuche",
      includePattern: "baugesuch|baubewilligung|bg 2026",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle PDF-Publikationen"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Dorfstrasse 27");
  assert.equal(syncResponse.payload.items[0].projectType, "Ersatzneubau Geräteschopf");
  assert.equal(syncResponse.payload.items[0].publicationDate, "2026-04-08");
  assert.equal(syncResponse.payload.items[0].deadlineDate, "2026-05-08");
  assert.ok(
    requestedUrls.includes("https://pdf-detail.example.org/amtliche-publikationen/BG-2026-090.pdf")
  );
});

test("municipality import supports direct official pdf sources", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://pdf-source.example.org/baugesuche/BG-2026-091.pdf");
    return new Response("%PDF-1.6 binary", {
      status: 200,
      headers: {
        "Content-Type": "application/pdf"
      }
    });
  };

  const pdfTextExtractImpl = async () =>
    "Baubewilligung BG 2026-091 Bauobjekt: Neubau Velohaus Bauplatz: Bahnhofstrasse 12 Publiziert: 9. April 2026 Auflagefrist: 9. Mai 2026";

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Bahnhofstrasse%2012/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Bahnhofstrasse 12, 5000 Aarau",
            origin: "address",
            x: 2647560.3,
            y: 1248788.1
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    pdfTextExtractImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "pdf",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://pdf-source.example.org/baugesuche/BG-2026-091.pdf",
      includePattern: "baugesuch|bahnhofstrasse|velohaus",
      excludePattern: "newsletter|archiv",
      notes: "Direktes amtliches PDF"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Bahnhofstrasse 12");
  assert.equal(syncResponse.payload.items[0].projectType, "Neubau Velohaus");
  assert.equal(syncResponse.payload.items[0].source, "Gemeinde-PDF");
});

test("municipality import auto-detects direct pdf urls even if a source is configured as html", async (context) => {
  const syncFetchImpl = async (url) => {
    assert.equal(String(url), "https://pdf-autodetect.example.org/baugesuche/BG-2026-092.pdf");
    return new Response("%PDF-1.6 binary", {
      status: 200,
      headers: {
        "Content-Type": "application/pdf"
      }
    });
  };

  const pdfTextExtractImpl = async () =>
    "Baubewilligung BG 2026-092 Bauobjekt: Dachsanierung Mehrfamilienhaus Bauplatz: Lindenweg 14 Publiziert: 10. April 2026 Auflagefrist: 10. Mai 2026";

  const geocodeFetchImpl = async (url) => {
    assert.match(String(url), /searchText=Lindenweg%2014/);
    return createJsonResponse({
      results: [
        {
          attrs: {
            label: "Lindenweg 14, 5313 Klingnau",
            origin: "address",
            x: 2669588.4,
            y: 1272833.2
          }
        }
      ]
    });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    pdfTextExtractImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Klingnau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://pdf-autodetect.example.org/baugesuche/BG-2026-092.pdf",
      includePattern: "baugesuch|lindenweg|dachsanierung",
      excludePattern: "newsletter|archiv",
      notes: "PDF-URL trotz altem Quellentyp"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Lindenweg 14");
  assert.equal(syncResponse.payload.items[0].projectType, "Dachsanierung Mehrfamilienhaus");
  assert.equal(syncResponse.payload.sourceSummaries[0].sourceType, "pdf");
});

test("municipality import treats query-parameter pdf links as publication files and does not fetch them as html pages", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://boettstein.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <ul>
                  <li>
                    <a href="/amtliche-publikationen.html?file=files/content/docs/aktuelles/2026/BG_Sanierung_Schulhaus_1901_Hauptstrasse_8.pdf&cid=4376">
                      Baugesuch Sanierung Schulhaus 1901, Hauptstrasse 8 - Frist bis 07.04.2026
                    </a>
                  </li>
                  <li>
                    <a href="/amtliche-publikationen.html?file=files/content/docs/aktuelles/2026/Gestaltungsplan_Areal.pdf&cid=4377">
                      Gestaltungsplan Areal - Frist bis 07.04.2026
                    </a>
                  </li>
                </ul>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url).includes("BG_Sanierung_Schulhaus_1901_Hauptstrasse_8.pdf")) {
      return new Response("%PDF-1.6 binary", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf"
        }
      });
    }

    if (String(url).includes("Gestaltungsplan_Areal.pdf")) {
      return new Response("%PDF-1.6 binary", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf"
        }
      });
    }

    throw new Error(`Unexpected Böttstein sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Böttstein");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://boettstein.example.org/baugesuche",
      includePattern: "baugesuch|hauptstrasse",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Hauptstrasse 8");
  assert.equal(syncResponse.payload.items[0].projectType, "Sanierung Schulhaus 1901");
  assert.ok(!syncResponse.payload.items[0].description.includes("%PDF"));
  assert.equal(
    requestedUrls.filter((entry) => entry.includes("BG_Sanierung_Schulhaus_1901_Hauptstrasse_8.pdf")).length,
    0
  );
});

test("municipality import ignores generic publication pdf entries without a reliable address", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://boettstein-generic.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <ul>
                  <li>
                    <a href="/amtliche-publikationen.html?file=files/content/docs/aktuelles/2026/BG_2765_Gemeinde_Boettstein.pdf&cid=4370">
                      Amtliche Publikation vom 26. Februar 2026 / Baugesuch Einwohnergemeinde Böttstein / Sanierung Schulhaus 1901
                    </a>
                  </li>
                </ul>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected generic Böttstein sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Böttstein");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://boettstein-generic.example.org/baugesuche",
      includePattern: "baugesuch|publikation",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Publikationen"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 0);
});

test("municipality import auto-discovers the publication page from a homepage-only source", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (
      String(url) === "https://discovery-demo.example.org" ||
      String(url) === "https://discovery-demo.example.org/"
    ) {
      return new Response(
        `
          <html>
            <body>
              <header>
                <nav>
                  <a href="/">Startseite</a>
                  <a href="/verwaltung/kontakt">Kontakt</a>
                  <a href="/aktuelles/veranstaltungen">Veranstaltungen</a>
                  <a href="/baugesuche">Baugesuche – öffentliche Auflage</a>
                </nav>
              </header>
              <main>
                <h1>Willkommen in unserer Gemeinde</h1>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://discovery-demo.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <a href="https://discovery-demo.example.org/baugesuch-bg-2026-014/">Baugesuch BG 2026-014</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://discovery-demo.example.org/baugesuch-bg-2026-014/") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-014</title>
              <meta name="description" content="Bauherrschaft: Muster AG, Dorfstrasse 12, 5200 Brugg Bauobjekt: Neubau Doppeleinfamilienhaus Lage: Parzelle Nr. 814">
              <meta property="article:published_time" content="2026-02-18T08:00:00+01:00">
            </head>
            <body><main><h1>Baugesuch BG 2026-014</h1></main></body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2657000, y: 1259000, label: "Parzelle 814, Brugg" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected discovery sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birr");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "partial",
      enabled: true,
      sourceUrl: "https://discovery-demo.example.org",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Nur Startseite bekannt"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].municipality, "Birr");
  assert.ok(requestedUrls.includes("https://discovery-demo.example.org/baugesuche"));
  assert.ok(requestedUrls.includes("https://discovery-demo.example.org/baugesuch-bg-2026-014/"));
});

test("municipality import rediscovers moved publication pages when the configured URL is stale", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://moving-source.example.org/alte-baugesuche") {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
    }

    if (
      String(url) === "https://moving-source.example.org" ||
      String(url) === "https://moving-source.example.org/"
    ) {
      return new Response(
        `
          <html>
            <body>
              <nav>
                <a href="/gemeinde">Gemeinde</a>
                <a href="/kontakt">Kontakt</a>
              </nav>
              <main><h1>Startseite</h1></main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://moving-source.example.org/sitemap.xml") {
      return new Response(
        `
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://moving-source.example.org/aktuell/baugesuche</loc></url>
            <url><loc>https://moving-source.example.org/aktuell/veranstaltungen</loc></url>
          </urlset>
        `,
        { status: 200, headers: { "Content-Type": "application/xml" } }
      );
    }

    if (String(url) === "https://moving-source.example.org/sitemap_index.xml") {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "application/xml" } });
    }

    if (String(url) === "https://moving-source.example.org/aktuell/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baugesuche und öffentliche Auflagen</h1>
                <a href="/aktuell/baugesuch-bg-2026-201">Baugesuch BG 2026-201</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://moving-source.example.org/aktuell/baugesuch-bg-2026-201") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-201</title>
              <meta name="description" content="Bauherrschaft: Muster AG, Hauptstrasse 4, 5242 Birr Bauobjekt: Anbau Werkstatt Bauplatz: Hauptstrasse 4, Parzelle Nr. 812">
              <meta property="article:published_time" content="2026-05-12T08:00:00+01:00">
            </head>
            <body>
              <main>
                <h1>Baugesuch BG 2026-201</h1>
                <p>Öffentliche Auflage vom 12. Mai 2026 bis 10. Juni 2026.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2651000, y: 1252000, label: "Hauptstrasse 4, Birr" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected moved-source sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birr");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://moving-source.example.org/alte-baugesuche",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Alte Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].municipality, "Birr");
  assert.equal(syncResponse.payload.items[0].sourceUrl, "https://moving-source.example.org/aktuell/baugesuch-bg-2026-201");
  assert.ok(requestedUrls.includes("https://moving-source.example.org/"));
  assert.ok(requestedUrls.includes("https://moving-source.example.org/sitemap.xml"));
  assert.ok(requestedUrls.includes("https://moving-source.example.org/aktuell/baugesuche"));
});

test("municipality import uses the municipal site search when publications are only searchable", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url, options = {}) => {
    requestedUrls.push(`${options.method ?? "GET"} ${String(url)}`);

    if (String(url) === "https://search-source.example.org/alte-baugesuche") {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
    }

    if (
      String(url) === "https://search-source.example.org" ||
      String(url) === "https://search-source.example.org/"
    ) {
      return new Response(
        "<html><body><main><h1>Gemeinde</h1><a href=\"/verwaltung\">Verwaltung</a></main></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://search-source.example.org/suche/") {
      return new Response(
        `
          <html>
            <body>
              <form method="post" id="tx_indexedsearch" action="/suche/?tx_indexedsearch_pi2%5Baction%5D=search&amp;tx_indexedsearch_pi2%5Bcontroller%5D=Search">
                <input type="hidden" name="tx_indexedsearch_pi2[search][numberOfResults]" value="10" />
                <input type="text" name="tx_indexedsearch_pi2[search][sword]" value="" />
                <input type="submit" name="tx_indexedsearch_pi2[search][submitButton]" value="Suchen" />
              </form>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://search-source.example.org/suche/?tx_indexedsearch_pi2%5Baction%5D=search&tx_indexedsearch_pi2%5Bcontroller%5D=Search") {
      const bodyText = String(options.body ?? "");
      assert.match(bodyText, /Baugesuch/i);
      return new Response(
        `
          <html>
            <body>
              <main>
                <p>Anzeige der Ergebnisse 1 bis 10 von insgesamt 28.</p>
                <article>
                  <a href="/aktuelles/amtliche-publikationen/">Amtliche Publikationen / Limmatwelle</a>
                  <p>Alle amtlichen Publikationen und Baugesuche.</p>
                </article>
                <article>
                  <a href="/aktuelles/aktuelles/news-detail/artikel/amtliche-publikation-baugesuch-bg-2026-030">Amtliche Publikation - Baugesuch BG 2026-030</a>
                </article>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://search-source.example.org/aktuelles/amtliche-publikationen/") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <h2>Baugesuche</h2>
                <a href="/aktuelles/aktuelles/news-detail/artikel/amtliche-publikation-baugesuch-bg-2026-030">Baugesuch BG 2026-030</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://search-source.example.org/aktuelles/aktuelles/news-detail/artikel/amtliche-publikation-baugesuch-bg-2026-030") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-030</title>
              <meta name="description" content="Bauherrschaft: Beispiel AG, Dorfstrasse 8, 5242 Birr Bauobjekt: Umbau Wohnhaus Bauplatz: Dorfstrasse 8, Parzelle Nr. 812">
              <meta property="article:published_time" content="2026-05-18T08:00:00+01:00">
            </head>
            <body>
              <main>
                <h1>Baugesuch BG 2026-030</h1>
                <p>Öffentliche Auflage vom 18. Mai 2026 bis 17. Juni 2026.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2651000, y: 1252000, label: "Dorfstrasse 8, Birr" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (String(url).endsWith("/sitemap.xml") || String(url).endsWith("/sitemap_index.xml")) {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "application/xml" } });
    }

    throw new Error(`Unexpected search-source sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birr");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://search-source.example.org/alte-baugesuche",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Alte Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].municipality, "Birr");
  assert.equal(
    syncResponse.payload.items[0].sourceUrl,
    "https://search-source.example.org/aktuelles/aktuelles/news-detail/artikel/amtliche-publikation-baugesuch-bg-2026-030"
  );
  assert.ok(requestedUrls.includes("GET https://search-source.example.org/suche/"));
  assert.ok(
    requestedUrls.some((entry) =>
      entry.startsWith(
        "POST https://search-source.example.org/suche/?tx_indexedsearch_pi2%5Baction%5D=search"
      )
    )
  );
});

test("municipality import tries simple municipal search query urls when no search form is visible", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url, options = {}) => {
    requestedUrls.push(`${options.method ?? "GET"} ${String(url)}`);

    if (String(url) === "https://query-search.example.org/alte-baugesuche") {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
    }

    if (
      String(url) === "https://query-search.example.org" ||
      String(url) === "https://query-search.example.org/"
    ) {
      return new Response("<html><body><main>Startseite ohne Baugesuch-Link</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (String(url) === "https://query-search.example.org/suche/") {
      return new Response("<html><body><main>Suche</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (String(url) === "https://query-search.example.org/suche/?q=Baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <p>Anzeige der Ergebnisse 1 bis 10 von insgesamt 12.</p>
                <article>
                  <a href="/news/erteilte-baubewilligung-bg-2026-999">Erteilte Baubewilligung BG 2026-999</a>
                  <p>Archivmeldung zu einem bereits abgeschlossenen Baugesuch.</p>
                </article>
                <article>
                  <a href="/publikationen">Alle amtlichen Publikationen</a>
                  <p>Baugesuche und öffentliche Auflagen werden hier gesammelt.</p>
                </article>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://query-search.example.org/publikationen") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <a href="/news/baugesuch-bg-2026-041">Baugesuch BG 2026-041</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://query-search.example.org/news/baugesuch-bg-2026-041") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-041</title>
              <meta name="description" content="Bauherrschaft: Beispiel AG Bauobjekt: Ausbau Dachgeschoss Bauplatz: Schulstrasse 2, Parzelle Nr. 801">
              <meta property="article:published_time" content="2026-05-21T08:00:00+01:00">
            </head>
            <body><main><p>Öffentliche Auflage vom 21. Mai 2026 bis 20. Juni 2026.</p></main></body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2651000, y: 1252000, label: "Schulstrasse 2, Birr" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (String(url).endsWith("/sitemap.xml") || String(url).endsWith("/sitemap_index.xml")) {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "application/xml" } });
    }

    return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birr");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://query-search.example.org/alte-baugesuche",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Alte Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].sourceUrl, "https://query-search.example.org/news/baugesuch-bg-2026-041");
  assert.ok(requestedUrls.includes("GET https://query-search.example.org/suche/?q=Baugesuche"));
  assert.ok(requestedUrls.includes("GET https://query-search.example.org/publikationen"));
  assert.ok(!requestedUrls.some((entry) => entry.includes("erteilte-baubewilligung")));
});

test("municipality import uses OpenSearch descriptions when the search form is hidden", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://opensearch-source.example.org/alte-baugesuche") {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
    }

    if (
      String(url) === "https://opensearch-source.example.org" ||
      String(url) === "https://opensearch-source.example.org/"
    ) {
      return new Response(
        `
          <html>
            <head>
              <link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml" />
            </head>
            <body><main><h1>Gemeinde</h1></main></body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://opensearch-source.example.org/opensearch.xml") {
      return new Response(
        `
          <OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
            <Url type="text/html" template="https://opensearch-source.example.org/suche?search={searchTerms}" />
          </OpenSearchDescription>
        `,
        { status: 200, headers: { "Content-Type": "application/opensearchdescription+xml" } }
      );
    }

    if (String(url) === "https://opensearch-source.example.org/suche?search=Baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <p>Anzeige der Ergebnisse 1 bis 10 von insgesamt 14.</p>
                <article>
                  <a href="/amtliche-publikationen">Amtliche Publikationen</a>
                  <p>Baugesuche und öffentliche Auflagen werden hier gesammelt.</p>
                </article>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://opensearch-source.example.org/amtliche-publikationen") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <h2>Baugesuche</h2>
                <a href="/amtliche-publikation-baugesuch-bg-2026-052">Baugesuch BG 2026-052</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://opensearch-source.example.org/amtliche-publikation-baugesuch-bg-2026-052") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-052</title>
              <meta name="description" content="Bauherrschaft: Beispiel AG Bauobjekt: Umbau Werkstatt Bauplatz: Dorfstrasse 6, Parzelle Nr. 802">
              <meta property="article:published_time" content="2026-05-22T08:00:00+01:00">
            </head>
            <body><main><p>Öffentliche Auflage vom 22. Mai 2026 bis 21. Juni 2026.</p></main></body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2651000, y: 1252000, label: "Dorfstrasse 6, Birr" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birr");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://opensearch-source.example.org/alte-baugesuche",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Alte Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(
    syncResponse.payload.items[0].sourceUrl,
    "https://opensearch-source.example.org/amtliche-publikation-baugesuch-bg-2026-052"
  );
  assert.ok(requestedUrls.includes("https://opensearch-source.example.org/opensearch.xml"));
  assert.ok(requestedUrls.includes("https://opensearch-source.example.org/suche?search=Baugesuche"));
});

test("municipality discovery rejects path-only Baugesuch pages that render generic content", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url) === "https://path-only-source.example.org/alte-baugesuche") {
      return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
    }

    if (
      String(url) === "https://path-only-source.example.org" ||
      String(url) === "https://path-only-source.example.org/"
    ) {
      return new Response("<html><body><main><h1>Willkommen</h1><p>Kontakt und Verwaltung.</p></main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (String(url) === "https://path-only-source.example.org/baugesuche") {
      return new Response("<html><body><main><h1>Willkommen</h1><p>Kontakt und Verwaltung.</p></main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (String(url) === "https://path-only-source.example.org/amtlichepublikationen") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Amtliche Publikationen</h1>
                <h2>Baugesuche</h2>
                <a href="/publikation-baugesuch-bg-2026-061">Baugesuch BG 2026-061</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://path-only-source.example.org/publikation-baugesuch-bg-2026-061") {
      return new Response(
        `
          <html>
            <head>
              <title>Baugesuch BG 2026-061</title>
              <meta name="description" content="Bauherrschaft: Beispiel AG Bauobjekt: Ersatzneubau Garage Bauplatz: Bahnhofstrasse 10, Parzelle Nr. 803">
              <meta property="article:published_time" content="2026-05-25T08:00:00+01:00">
            </head>
            <body><main><p>Öffentliche Auflage vom 25. Mai 2026 bis 24. Juni 2026.</p></main></body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2651000, y: 1252000, label: "Bahnhofstrasse 10, Birr" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Birr");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://path-only-source.example.org/alte-baugesuche",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Alte Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(
    syncResponse.payload.items[0].sourceUrl,
    "https://path-only-source.example.org/publikation-baugesuch-bg-2026-061"
  );
  assert.ok(requestedUrls.includes("https://path-only-source.example.org/baugesuche"));
  assert.ok(requestedUrls.includes("https://path-only-source.example.org/amtlichepublikationen"));
});

test("municipality import rejects generic search-result pages without concrete Baugesuch details", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://niederwil.example.org/suche?query=baugesuch") {
      return new Response(
        `
          <html>
            <head><title>Suchergebnisse | Gemeinde Niederwil AG</title></head>
            <body>
              <main>
                <h1>Suchergebnisse</h1>
                <p>Webseite der Gemeinde Niederwil AG. Hauptstrasse 4, 5524 Niederwil.</p>
                <p>Ihre Suche nach Baugesuch lieferte allgemeine Seiten der Gemeindeverwaltung.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Niederwil");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://niederwil.example.org/suche?query=baugesuch",
      includePattern: "baugesuch|baubewilligung|publikation",
      excludePattern: "",
      notes: "Suchseite ohne konkrete Treffer"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 0);
  assert.equal(syncResponse.payload.updatedCount, 0);
});

test("municipality import rejects bulletin and planning pages without pending Baugesuch signal", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://oberentfelden.example.org/mitteilungsblatt") {
      return new Response(
        `
          <html>
            <head><title>Mitteilungsblatt Gemeinde Oberentfelden</title></head>
            <body>
              <main>
                <h1>Mitteilungsblatt</h1>
                <p>Im Februar 2026. Infoblatt bezüglich Elektronetz-Ausbau. Dorfstrasse 7, Oberentfelden.</p>
                <p>Archivtext mit dem Stichwort Baugesuch, aber ohne konkrete öffentliche Auflage.</p>
                <p>Mitteilung vom 17.02.2026, Gemeinderat und Verwaltung.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://oberrohrdorf.example.org/nutzungsplanung") {
      return new Response(
        `
          <html>
            <head><title>Familiengartenzone Staretschwil</title></head>
            <body>
              <main>
                <h1>Öffentliche Auflage Nutzungsplanung</h1>
                <p>KLP Familiengartenzone Staretschwil. Änderungen der BNO, Vorprüfungsbericht vom 10.07.2025.</p>
                <p>Parzelle 199, Mitwirkung und Genehmigung.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://auenstein.example.org/eleg-plangenehmigung") {
      return new Response(
        `
          <html>
            <head><title>Ordentliches Plangenehmigungsverfahren nach Elektrizitätsgesetz</title></head>
            <body>
              <main>
                <h1>Ordentliches Plangenehmigungsverfahren nach Elektrizitätsgesetz (EleG)</h1>
                <p>Betroffene Gemeinden: Auenstein. Parzelle 721. Öffentliche Auflage bis 10.06.2026.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const oberentfelden = sourcesResponse.payload.items.find((item) => item.municipality === "Oberentfelden");
  const oberrohrdorf = sourcesResponse.payload.items.find((item) => item.municipality === "Oberrohrdorf");
  const auenstein = sourcesResponse.payload.items.find((item) => item.municipality === "Auenstein");
  assert.ok(oberentfelden);
  assert.ok(oberrohrdorf);
  assert.ok(auenstein);

  for (const [source, sourceUrl] of [
    [oberentfelden, "https://oberentfelden.example.org/mitteilungsblatt"],
    [oberrohrdorf, "https://oberrohrdorf.example.org/nutzungsplanung"],
    [auenstein, "https://auenstein.example.org/eleg-plangenehmigung"]
  ]) {
    const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
      method: "PATCH",
      headers: { Cookie: masterCookie },
      body: JSON.stringify({
        sourceType: "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl,
        includePattern: "baugesuch|baubewilligung|publikation|auflage",
        excludePattern: "",
        notes: "Nicht-Baugesuch-Seite"
      })
    });
    assert.equal(saveResponse.status, 200);
  }

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 0);
  assert.equal(syncResponse.payload.updatedCount, 0);
});

test("municipality import rejects generic publication routes and Baugesuch form templates", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://wohlen.example.org/_rtr/beschluesse") {
      return new Response(
        `
          <html>
            <head><title>Beschluesse und Reglemente | Gemeinde Wohlen</title></head>
            <body>
              <main>
                <h1>Publikationen der Politik und Verwaltung</h1>
                <p>Ab Mitte Februar 2018 finden Sie hier Beschluesse, Reglemente und weitere Publikationen.</p>
                <p>Die Suche enthaelt auch Treffer zum Stichwort Baugesuch.</p>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://killwangen.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Bauverwaltung</h1>
                <a href="/docs/Formular_Baugesuch_Killwangen_ausfuellbar.pdf">Formular Baugesuch</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://killwangen.example.org/docs/Formular_Baugesuch_Killwangen_ausfuellbar.pdf") {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" }
      });
    }

    if (String(url) === "https://zufikon.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <h1>Baugesuche</h1>
                <a href="/src/pdf_bt_bg_260504.pdf">Baugesuch 06.05.2026 - 05.06.2026</a>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    if (String(url) === "https://zufikon.example.org/src/pdf_bt_bg_260504.pdf") {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" }
      });
    }

    if (String(url) === "https://menziken.example.org/Baugesuchumschlag_2023.pdf") {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" }
      });
    }

    return new Response("Nicht gefunden", { status: 404, headers: { "Content-Type": "text/html" } });
  };

  const pdfTextExtractImpl = async (_buffer, { resolvedUrl } = {}) => {
    if (String(resolvedUrl).includes("pdf_bt_bg_260504")) {
      return "Baugesuch 06.05.2026 - 05.06.2026";
    }

    if (String(resolvedUrl).includes("Baugesuchumschlag_2023")) {
      return "Print To PDF 2023. Gesuchsteller Max Muster, Hauptstrasse 1. Einsprachfrist 10.06.2026.";
    }

    return "Gesuchsteller Thomas Gretener, Bahnhofstrasse 1. Einsprachfrist 10.06.2026.";
  };

  const testServer = createTestServer({
    syncFetchImpl,
    pdfTextExtractImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: { Cookie: masterCookie }
  });
  const wohlen = sourcesResponse.payload.items.find((item) => item.municipality === "Wohlen");
  const killwangen = sourcesResponse.payload.items.find((item) => item.municipality === "Killwangen");
  const zufikon = sourcesResponse.payload.items.find((item) => item.municipality === "Zufikon");
  const menziken = sourcesResponse.payload.items.find((item) => item.municipality === "Menziken");
  assert.ok(wohlen);
  assert.ok(killwangen);
  assert.ok(zufikon);
  assert.ok(menziken);

  for (const [source, sourceUrl] of [
    [wohlen, "https://wohlen.example.org/_rtr/beschluesse"],
    [killwangen, "https://killwangen.example.org/baugesuche"],
    [zufikon, "https://zufikon.example.org/baugesuche"],
    [menziken, "https://menziken.example.org/Baugesuchumschlag_2023.pdf"]
  ]) {
    const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
      method: "PATCH",
      headers: { Cookie: masterCookie },
      body: JSON.stringify({
        sourceType: source === menziken ? "pdf" : "html",
        digitalStatus: "digital",
        enabled: true,
        sourceUrl,
        includePattern: "baugesuch|baubewilligung|publikation|auflage",
        excludePattern: "",
        notes: "Allgemeine Publikation oder Formularvorlage"
      })
    });
    assert.equal(saveResponse.status, 200);
  }

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 0);
  assert.equal(syncResponse.payload.updatedCount, 0);
});

test("Amtsblatt source scrapes canton-wide Baugesuche and tags the correct municipality", async (context) => {
  const requestedUrls = [];
  const listingPage = `
    <div class="publication-list__item publication-list__item--publication box" data-index="0"
      data-detailurl="/ekab/00.096.761/publikation/" data-overlayurl="/publikationen?x=1">
      <article class="publication-summary">
        <h2 class="box-publication-title">
          <a class="publication-summary__title" href="/ekab/00.096.761/publikation/">Baugesuch 2026-0069</a>
        </h2>
        <div class="box-publication-date">29.05.2026</div>
        <ul class="box-defenition-list">
          <li><div class="row"><div class="col-sm-4"><b>Publ.-Nr.:</b></div><div class="col-sm-8">00.096.761</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Stelle:</b></div><div class="col-sm-8">Stadt Baden, Bau</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Rubrik:</b></div><div class="col-sm-8">Gemeinden / Bau- und Rodungsgesuche</div></div></li>
        </ul>
        <p class="mb-3">Bauherrschaft: Stadt Baden, Stadtforstamt, Rathausgasse 5, 5400 Baden | Bauvorhaben: \\32_Baueingabe\\BP_Wilk_Untersiggenthal_rev.pln N Bauprojekt Umnutzung Keller, 5417 Untersiggenthal 1:500 08.04.2026 CM | Standort: Taefernstrasse (Parz. 11, 4088), Baden | Zone: Teilweise ausserhalb Bauzone</p>
      </article>
    </div>
    <div class="publication-list__item publication-list__item--publication box" data-index="1"
      data-detailurl="/ekab/00.096.097/publikation/">
      <article class="publication-summary">
        <h2 class="box-publication-title"><a class="publication-summary__title" href="/ekab/00.096.097/publikation/">Ersatzwahl Regierungsrat</a></h2>
        <div class="box-publication-date">29.05.2026</div>
        <ul class="box-defenition-list">
          <li><div class="row"><div class="col-sm-4"><b>Stelle:</b></div><div class="col-sm-8">Staatskanzlei</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Rubrik:</b></div><div class="col-sm-8">Kanton / Wahlen und Abstimmungen</div></div></li>
        </ul>
        <p>Wahlausschreibung ohne Baubezug.</p>
      </article>
    </div>
  `;

  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));

    if (String(url).includes("amtsblatt.ag.ch") && String(url).includes("page=1")) {
      return new Response(listingPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (String(url).includes("amtsblatt.ag.ch")) {
      return new Response("<html><body><main>Keine weiteren Publikationen</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2665500, y: 1258300, label: "Täfernstrasse, Baden" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected Amtsblatt sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    syncSourceUrl: "https://amtsblatt.ag.ch/publikationen/",
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const item = syncResponse.payload.items[0];
  assert.equal(item.municipality, "Baden");
  assert.equal(item.source, "Amtsblatt Aargau");
  assert.ok(item.address.includes("Taefernstrasse"));
  assert.equal(item.projectType, "Umnutzung Keller");
  assert.equal(item.publicationDate, "2026-05-29");
  assert.ok(requestedUrls.some((entry) => entry.includes("resultAjax")));
});

test("Amtsblatt uses the build-site address, not the applicant's residence", async (context) => {
  const listingPage = `
    <div class="publication-list__item publication-list__item--publication" data-index="0"
      data-detailurl="/ekab/00.097.555/publikation/">
      <article class="publication-summary">
        <h2 class="box-publication-title"><a class="publication-summary__title" href="/ekab/00.097.555/publikation/">Baugesuch 2026-0421</a></h2>
        <div class="box-publication-date">28.05.2026</div>
        <ul class="box-defenition-list">
          <li><div class="row"><div class="col-sm-4"><b>Stelle:</b></div><div class="col-sm-8">Stadt Baden, Bau</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Rubrik:</b></div><div class="col-sm-8">Gemeinden / Bau- und Rodungsgesuche</div></div></li>
        </ul>
        <p class="mb-3">Bauherrschaft: Mario Rossi, Via Nassa 5, 6900 Lugano | Bauvorhaben: Neubau Einfamilienhaus | Objektadresse: Mellingerstrasse 12, Baden | Zone: Wohnzone W2</p>
      </article>
    </div>
  `;

  const syncFetchImpl = async (url) => {
    if (String(url).includes("amtsblatt.ag.ch") && String(url).includes("page=1")) {
      return new Response(listingPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (String(url).includes("amtsblatt.ag.ch")) {
      return new Response("<html><body>keine</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      // The build site is in Baden; the geocoder must be queried for the Baden street.
      assert.ok(!String(url).toLowerCase().includes("lugano"), "geocoder must not be queried with the Ticino residence");
      return new Response(
        JSON.stringify({ results: [{ attrs: { x: 2665800, y: 1258700, label: "Mellingerstrasse, Baden" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    syncSourceUrl: "https://amtsblatt.ag.ch/publikationen/",
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const item = syncResponse.payload.items[0];
  assert.equal(item.municipality, "Baden");
  assert.ok(item.address.includes("Mellingerstrasse"));
  assert.ok(!item.address.toLowerCase().includes("nassa"));
  assert.ok(!item.address.toLowerCase().includes("lugano"));
  assert.notEqual(item.municipality, "Lugano");
});

test("Amtsblatt reads Parzelle / Strasse as the build-site address", async (context) => {
  const listingPage = `
    <div class="publication-list__item publication-list__item--publication" data-index="0"
      data-detailurl="/ekab/00.095.219/publikation/">
      <article class="publication-summary">
        <h2 class="box-publication-title"><a class="publication-summary__title" href="/ekab/00.095.219/publikation/">Baugesuchspublikation</a></h2>
        <div class="box-publication-date">08.05.2026</div>
        <ul class="box-defenition-list">
          <li><div class="row"><div class="col-sm-4"><b>Stelle:</b></div><div class="col-sm-8">Gemeinde Moosleerau</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Rubrik:</b></div><div class="col-sm-8">Gemeinden / Bau- und Rodungsgesuche</div></div></li>
        </ul>
        <p class="mb-3">
          Bauherrschaft: Test Bauherr, Seckistrasse 15, 6318 Walchwil |
          Parzelle / Strasse: 397, Ausserdorfstrasse 90, 5054 Moosleerau |
          Bauobjekt: Umbau Bauernhaus
        </p>
      </article>
    </div>
  `;

  const syncFetchImpl = async (url) => {
    if (String(url).includes("amtsblatt.ag.ch") && String(url).includes("page=1")) {
      return new Response(listingPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (String(url).includes("amtsblatt.ag.ch")) {
      return new Response("<html><body>keine</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      const requestUrl = new URL(String(url));
      assert.match(requestUrl.searchParams.get("searchText") ?? "", /Ausserdorfstrasse 90, Moosleerau/i);
      assert.ok(!String(url).toLowerCase().includes("seckistrasse"), "geocoder must not use the applicant address");
      assert.ok(!String(url).toLowerCase().includes("walchwil"), "geocoder must not use the applicant municipality");

      return createJsonResponse({
        results: [
          {
            attrs: {
              origin: "address",
              label: "Ausserdorfstrasse 90 5054 Moosleerau",
              detail: "ausserdorfstrasse 90 5054 moosleerau 4277 moosleerau ch ag",
              x: 1235208.375,
              y: 2647695.25
            }
          }
        ]
      });
    }

    throw new Error(`Unexpected sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    syncSourceUrl: "https://amtsblatt.ag.ch/publikationen/",
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const item = syncResponse.payload.items[0];
  assert.equal(item.municipality, "Moosleerau");
  assert.equal(item.address, "Ausserdorfstrasse 90");
  assert.equal(item.coordinates, "2647695.25,1235208.375");
  assert.equal(item.protectionStatus, "no-hit");
  assert.ok(!item.address.toLowerCase().includes("seckistrasse"));
});

test("Amtsblatt detail enrichment reads locality-prefixed parcel numbers", async (context) => {
  const listingPage = `
    <div class="publication-list__item publication-list__item--publication" data-index="0"
      data-detailurl="/ekab/00.096.159/publikation/">
      <article class="publication-summary">
        <h2 class="box-publication-title"><a class="publication-summary__title" href="/ekab/00.096.159/publikation/">Baugesuch</a></h2>
        <div class="box-publication-date">31.05.2026</div>
        <ul class="box-defenition-list">
          <li><div class="row"><div class="col-sm-4"><b>Stelle:</b></div><div class="col-sm-8">Gemeinde Böztal</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Rubrik:</b></div><div class="col-sm-8">Gemeinden / Bau- und Rodungsgesuche</div></div></li>
        </ul>
        <p class="mb-3">Bauvorhaben: Anbau Remise, Neubau Silo</p>
      </article>
    </div>
  `;
  const detailPage = `
    <article class="publication-detail">
      <h1>Baugesuch</h1>
      <p>Bauherrschaft: Amsler Jolanda, Summelegg 221, 5075 Hornussen</p>
      <p>Bauobjekt: Anbau Remise, Neubau Silo, Sanierung Fassade Wohnhaus</p>
      <p>Ortslage: Parzelle Hornussen Nr. 689 und 690, Summelegg</p>
    </article>
  `;

  const syncFetchImpl = async (url) => {
    const value = String(url);

    if (value.includes("amtsblatt.ag.ch") && value.includes("page=1")) {
      return new Response(listingPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (value === "https://amtsblatt.ag.ch/ekab/00.096.159/publikation/") {
      return new Response(detailPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (value.includes("amtsblatt.ag.ch")) {
      return new Response("<html><body>keine</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (value.includes("api3.geo.admin.ch")) {
      const requestUrl = new URL(value);

      if (requestUrl.searchParams.get("origins") === "parcel") {
        assert.match(requestUrl.searchParams.get("searchText") ?? "", /Böztal 689/i);
        return createJsonResponse({
          results: [
            {
              attrs: {
                detail: "689 boeztal ch ag",
                x: 2646131,
                y: 1260895.125
              }
            }
          ]
        });
      }

      return createJsonResponse({ results: [] });
    }

    throw new Error(`Unexpected sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    syncSourceUrl: "https://amtsblatt.ag.ch/publikationen/",
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const item = syncResponse.payload.items[0];
  assert.equal(item.municipality, "Böztal");
  assert.equal(item.address, "Parzelle 689");
  assert.equal(item.parcel, "689");
  assert.equal(item.coordinates, "2646131,1260895.125");
  assert.equal(item.protectionStatus, "no-hit");
});

test("Amtsblatt detail enrichment ignores unrelated digits when deciding whether to fetch detail pages", async (context) => {
  const requestedUrls = [];
  const listingPage = `
    <div class="publication-list__item publication-list__item--publication" data-index="0"
      data-detailurl="/ekab/00.093.416/publikation/">
      <article class="publication-summary">
        <h2 class="box-publication-title"><a class="publication-summary__title" href="/ekab/00.093.416/publikation/">Baugesuch</a></h2>
        <div class="box-publication-date">09.04.2026</div>
        <ul class="box-defenition-list">
          <li><div class="row"><div class="col-sm-4"><b>Stelle:</b></div><div class="col-sm-8">Gemeinde Lupfig</div></div></li>
          <li><div class="row"><div class="col-sm-4"><b>Rubrik:</b></div><div class="col-sm-8">Gemeinden / Bau- und Rodungsgesuche</div></div></li>
        </ul>
        <p class="mb-3">
          Bauherr: IBB Energie AG, Gaswerkstrasse 5, 5200 Brugg |
          Bauobjekt: Trasseeneubau ab Unterwerk Lupfig für Erschliessung mit Mittelspannung Green Lupin 4
        </p>
      </article>
    </div>
  `;
  const detailPage = `
    <article class="publication-detail">
      <h1>Baugesuch</h1>
      <p>Bauherr: IBB Energie AG, Gaswerkstrasse 5, 5200 Brugg</p>
      <p>Bauobjekt: Trasseeneubau ab Unterwerk Lupfig für Erschliessung mit Mittelspannung Green Lupin 4</p>
      <p>Parzellen: 903, 358, 352, 706, 362, 356, 919</p>
      <p>Öffentliche Auflage vom 11. April 2026 bis 11. Mai 2026 bei der Bauverwaltung Eigenamt.</p>
    </article>
  `;

  const syncFetchImpl = async (url) => {
    const value = String(url);
    requestedUrls.push(value);

    if (value.includes("amtsblatt.ag.ch") && value.includes("page=1")) {
      return new Response(listingPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (value === "https://amtsblatt.ag.ch/ekab/00.093.416/publikation/") {
      return new Response(detailPage, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (value.includes("amtsblatt.ag.ch")) {
      return new Response("<html><body>keine</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (value.includes("api3.geo.admin.ch")) {
      const requestUrl = new URL(value);
      assert.equal(requestUrl.searchParams.get("origins"), "parcel");
      assert.match(requestUrl.searchParams.get("searchText") ?? "", /Lupfig 903/i);

      return createJsonResponse({
        results: [
          {
            attrs: {
              detail: "903 lupfig ch ag",
              x: 2658069.5,
              y: 1255958.875
            }
          }
        ]
      });
    }

    throw new Error(`Unexpected sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    syncSourceUrl: "https://amtsblatt.ag.ch/publikationen/",
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });

  assert.equal(syncResponse.status, 200);
  assert.ok(requestedUrls.includes("https://amtsblatt.ag.ch/ekab/00.093.416/publikation/"));
  assert.equal(syncResponse.payload.importedCount, 1);
  const item = syncResponse.payload.items[0];
  assert.equal(item.municipality, "Lupfig");
  assert.equal(item.address, "Parzelle 903");
  assert.equal(item.parcel, "903");
  assert.equal(item.coordinates, "2658069.5,1255958.875");
  assert.equal(item.protectionStatus, "no-hit");
});

test("municipality import deduplicates repeated official detail links and uses metadata from municipality detail pages", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://fischbach.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <a href="https://fischbach.example.org/baubewilligung-bg-2025-031/">Baubewilligung BG 2025-031</a>
                <a href="https://fischbach.example.org/baubewilligung-bg-2025-031/">Baubewilligung BG 2025-031</a>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://fischbach.example.org/baubewilligung-bg-2025-031/") {
      return new Response(
        `
          <html>
            <head>
              <title>Baubewilligung BG 2025-031</title>
              <meta name="description" content="Bauherrschaft: Misselwitz Eric, Ruppliweg 2, 5525 Fischbach-Göslikon Bauobjekt: Einbau Kaminofen mit externem Kamin Lage: Parzelle Nr. 662">
              <meta property="article:published_time" content="2025-12-12T04:57:39+01:00">
            </head>
            <body>
              <main>
                <h1>Baubewilligung BG 2025-031</h1>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url).includes("api3.geo.admin.ch")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              attrs: {
                x: 2663000,
                y: 1239000,
                label: "Parzelle 662, Fischbach-Göslikon"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    throw new Error(`Unexpected Fischbach sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl: syncFetchImpl,
    geocodeEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Fischbach-Göslikon");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://fischbach.example.org/baugesuche",
      includePattern: "baubewilligung|baugesuch|bg 2025",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.items[0].address, "Parzelle 662");
  assert.equal(syncResponse.payload.items[0].projectType, "Einbau Kaminofen mit externem Kamin");
  assert.equal(syncResponse.payload.items[0].coordinates, "2663000,1239000");
});

test("municipality import skips synthetic Aarau detail pages when only a filename shell is available", async (context) => {
  const syncFetchImpl = async (url) => {
    if (String(url) === "https://aarau-fallback.example.org/baugesuche") {
      return new Response(
        `
          <html>
            <body>
              <main>
                <p>
                  <strong>Baugesuche Woche 11 (Öffentliche Auflage vom Samstag, 14. März 2026, bis Montag, 13. April 2026)</strong>
                  <br>
                  <strong>Bauplatz:</strong> Wallerstrasse 13 / BG 2026.011
                  <br>
                  <a href="https://aarau-fallback.example.org/leben/bauen/baugesuche/bg-2026011_wallerstrasse-13.html/2972">
                    Zu den Dokumenten
                  </a>
                </p>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    if (String(url) === "https://aarau-fallback.example.org/leben/bauen/baugesuche/bg-2026011_wallerstrasse-13.html/2972") {
      return new Response(
        `
          <html>
            <head>
              <title>BG 2026.011_Wallerstrasse 13</title>
            </head>
            <body>
              <main>
                BG 2026.011_Wallerstrasse 13_Grundstücksangaben, Projektpläne und -beschrieb_Stützmauer Wallerstrasse 13 5000 Aarau.pdf
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      );
    }

    throw new Error(`Unexpected Aarau fallback sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau-fallback.example.org/baugesuche",
      includePattern: "baugesuch|wallerstrasse",
      excludePattern: "archiv|newsletter",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 0);
});

test("protected AGIS ArcGIS sources can sync automatically with a token", async (context) => {
  const requestedUrls = [];
  const syncFetchImpl = async (url) => {
    requestedUrls.push(String(url));
    const requestUrl = new URL(String(url));

    assert.equal(requestUrl.searchParams.get("token"), "AGIS-TOKEN-123");

    if (requestUrl.pathname.endsWith("/MapServer")) {
      return createJsonResponse({
        layers: [{ id: 0, name: "Baugesuche" }]
      });
    }

    if (requestUrl.pathname.endsWith("/MapServer/0/query")) {
      assert.equal(requestUrl.searchParams.get("where"), "1=1");
      assert.equal(requestUrl.searchParams.get("outFields"), "*");
      assert.equal(requestUrl.searchParams.get("returnGeometry"), "true");
      assert.equal(requestUrl.searchParams.get("f"), "json");

      return createJsonResponse({
        features: [
          {
            attributes: {
              id: "BG-AGIS-TOKEN-001",
              GES_ID: "AGIS-TOKEN-001",
              Gemeinde: "Baden",
              Adresse: "Mellingerstrasse 99",
              GES_TITEL: "Umbau Laden",
              GES_EINGANG: "2026-03-21",
              FRISTENDE: "2026-03-31",
              agisMatch: "Treffer in ISOS-Fläche",
              URL: "https://www.ag.ch/beispiel/baugesuch/token"
            },
            geometry: {
              x: 2667000,
              y: 1259000
            }
          }
        ]
      });
    }

    throw new Error(`Unexpected AGIS sync URL: ${url}`);
  };

  const testServer = createTestServer({
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  const saveResponse = await requestJson(testServer.baseUrl, "/api/admin/sync-settings", {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceUrl: "https://www.ag.ch/geoportal/rest/services/AGIS/afb_bauges/MapServer",
      sourceToken: "AGIS-TOKEN-123"
    })
  });

  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.payload.sourceUrl, "https://www.ag.ch/geoportal/rest/services/AGIS/afb_bauges/MapServer");
  assert.equal(saveResponse.payload.sourceToken, "AGIS-TOKEN-123");

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.notificationCount, 1);
  assert.ok(requestedUrls.some((entry) => entry.includes("/MapServer?")));
  assert.ok(requestedUrls.some((entry) => entry.includes("/MapServer/0/query?")));

  const detailResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-AGIS-TOKEN-001", {
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.municipality, "Baden");
  assert.equal(detailResponse.payload.protectionStatus, "protected-zone");
});

test("configured master password is applied again on server start", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-aargau-"));
  const dbPath = join(directory, "test.sqlite");
  const previousMasterPassword = process.env.MASTER_ACCOUNT_PASSWORD;
  let testServer = createTestServer({ directory, dbPath });

  context.after(async () => {
    if (testServer) {
      await closeTestServer(testServer);
    }

    if (previousMasterPassword === undefined) {
      delete process.env.MASTER_ACCOUNT_PASSWORD;
    } else {
      process.env.MASTER_ACCOUNT_PASSWORD = previousMasterPassword;
    }

    rmSync(directory, { recursive: true, force: true });
  });

  const originalLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "master",
      password: TEST_MASTER_PASSWORD
    })
  });
  assert.equal(originalLogin.status, 200);

  await closeTestServer(testServer);
  process.env.MASTER_ACCOUNT_PASSWORD = "MasterNeu2026!";
  testServer = createTestServer({ directory, dbPath });

  const oldPasswordLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "master",
      password: TEST_MASTER_PASSWORD
    })
  });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "master",
      password: "MasterNeu2026!"
    })
  });
  assert.equal(newPasswordLogin.status, 200);
});

test("session remains valid after server restart because it is stored in sqlite", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-aargau-"));
  const dbPath = join(directory, "test.sqlite");
  let testServer = createTestServer({ directory, dbPath });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  await closeTestServer(testServer);
  testServer = createTestServer({ directory, dbPath });

  const response = await requestJson(testServer.baseUrl, "/api/auth/session", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.authenticated, true);
  assert.equal(response.payload.user.displayName, "Lucia Vettori");
});

test("a registration key is consumed after first use", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const registrationKey = await createRegistrationKey(testServer.baseUrl);
  const firstResponse = await requestJson(testServer.baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      displayName: "Erste Person",
      username: "erste.person",
      password: "Sicher1234",
      accessKey: registrationKey.keyCode
    })
  });

  assert.equal(firstResponse.status, 201);

  const secondResponse = await requestJson(testServer.baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      displayName: "Zweite Person",
      username: "zweite.person",
      password: "Sicher1234",
      accessKey: registrationKey.keyCode
    })
  });

  assert.equal(secondResponse.status, 400);
});

test("dashboard exposes seeded statistics", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const response = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.stats.totalApplications, 8);
  assert.ok(response.payload.stats.relevantApplications >= 4);
  assert.ok(Array.isArray(response.payload.municipalities));
});

test("dashboard calculates due-soon cases from the current date", async (context) => {
  const testServer = createTestServer({
    seedDemoApplications: false
  });
  const repository = createApplicationsRepository(testServer.db);

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  repository.importItems([
    {
      source: "Test",
      sourceReference: "DUE-SOON-CURRENT-01",
      sourceUrl: "https://example.org/due-soon",
      municipality: "Aarau",
      address: "Teststrasse 1",
      publicationDate: dateOnlyDaysFromNow(-1),
      deadlineDate: dateOnlyDaysFromNow(6),
      projectType: "Testfall",
      description: "Aktueller Testfall mit naher Frist",
      protectionStatus: "no-hit",
      agisMatch: "Kein Schutz gefunden",
      agisLayers: [],
      workflowStatus: "new"
    },
    {
      source: "Test",
      sourceReference: "DUE-SOON-CURRENT-02",
      sourceUrl: "https://example.org/later",
      municipality: "Aarau",
      address: "Teststrasse 2",
      publicationDate: dateOnlyDaysFromNow(-1),
      deadlineDate: dateOnlyDaysFromNow(8),
      projectType: "Testfall",
      description: "Aktueller Testfall mit späterer Frist",
      protectionStatus: "no-hit",
      agisMatch: "Kein Schutz gefunden",
      agisLayers: [],
      workflowStatus: "new"
    },
    {
      source: "Test",
      sourceReference: "DUE-SOON-CURRENT-03",
      sourceUrl: "https://example.org/cleared",
      municipality: "Aarau",
      address: "Teststrasse 3",
      publicationDate: dateOnlyDaysFromNow(-1),
      deadlineDate: dateOnlyDaysFromNow(3),
      projectType: "Testfall",
      description: "Erledigter Testfall mit naher Frist",
      protectionStatus: "no-hit",
      agisMatch: "Kein Schutz gefunden",
      agisLayers: [],
      workflowStatus: "cleared"
    },
    {
      source: "Test",
      sourceReference: "DUE-SOON-CURRENT-04",
      sourceUrl: "https://example.org/overdue",
      municipality: "Aarau",
      address: "Teststrasse 4",
      publicationDate: dateOnlyDaysFromNow(-10),
      deadlineDate: dateOnlyDaysFromNow(-2),
      projectType: "Testfall",
      description: "Überfälliger Testfall",
      protectionStatus: "no-hit",
      agisMatch: "Kein Schutz gefunden",
      agisLayers: [],
      workflowStatus: "new"
    }
  ]);

  const cookie = await login(testServer.baseUrl);
  const response = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.stats.dueSoon, 1);
});

test("startup AGIS refresh replaces stale seed hits with official hits", async (context) => {
  const agisFetchImpl = async (url) => {
    const requestUrl = new URL(typeof url === "string" ? url : url.url ?? String(url));

    if (requestUrl.pathname.endsWith("/are_isos/MapServer/21/query")) {
      const geometry = requestUrl.searchParams.get("geometry");

      if (geometry === "2651766,1250865") {
        return createJsonResponse({
          features: [
            {
              attributes: {
                OBJECTID: 11,
                BENENN_F: "Brugg Testperimeter"
              },
              geometry: {
                rings: [
                  [
                    [2651700, 1250800],
                    [2651850, 1250800],
                    [2651850, 1250950],
                    [2651700, 1250950],
                    [2651700, 1250800]
                  ]
                ]
              }
            }
          ]
        });
      }

      return createJsonResponse({ features: [] });
    }

    if (requestUrl.pathname.endsWith("/dp_denkmalpflege/MapServer/8/query")) {
      const geometry = JSON.parse(requestUrl.searchParams.get("geometry"));

      if (geometry.xmin === 2651646 && geometry.ymin === 1250745) {
        return createJsonResponse({
          features: [
            {
              attributes: {
                Titel: "Brugg Testhaus",
                Gemeinde: "Brugg",
                Adresse: "Hauptstrasse 44",
                Signatur: "INV-BRUGG-001"
              },
              geometry: {
                x: 2651766,
                y: 1250865
              }
            }
          ]
        });
      }

      return createJsonResponse({ features: [] });
    }

    return createJsonResponse({ features: [] });
  };

  const testServer = createTestServer({
    agisFetchImpl,
    agisAssessmentEnabled: true,
    agisRefreshOnStart: true
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  await testServer.ready;

  const cookie = await login(testServer.baseUrl);
  const zofingenResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-003", {
    headers: {
      Cookie: cookie
    }
  });
  const bruggResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-005", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(zofingenResponse.status, 200);
  assert.equal(zofingenResponse.payload.protectionStatus, "no-hit");
  assert.equal(zofingenResponse.payload.agisMatch, "Kein Schutztreffer");
  assert.equal(bruggResponse.status, 200);
  assert.equal(bruggResponse.payload.protectionStatus, "combined-hit");
  assert.equal(bruggResponse.payload.agisMatch, "ISOS-Fläche und Gebäude im Inventar");
});

test("AGIS re-assesses manual-review items that still have valid coordinates", async () => {
  // Regression für den kritischen Datenintegritäts-Befund: ein Fall, der nur
  // wegen eines Datenqualitätsproblems (z. B. ungültiges Fristdatum) auf
  // "manual-review" stand, aber gültige Koordinaten besitzt, muss bei der
  // AGIS-Neubewertung wieder geprüft werden - sonst bleibt ein echter
  // Schutztreffer dauerhaft verdeckt.
  const service = createAgisAssessmentService({
    repository: { getById: () => null, list: () => [], updateAssessment: () => null },
    agisGeometryService: {
      getOfficialFeatures: async () => ({ matched: { points: true } })
    }
  });

  const assessment = await service.assessItem({
    id: "BG-STICKY-001",
    coordinates: "2651766,1250865",
    protectionStatus: "manual-review",
    ambiguousAddress: 0
  });

  assert.equal(assessment.protectionStatus, "protected-point");
  assert.equal(assessment.agisMatch, "Treffer im Gebäudeinventar");
});

test("AGIS leaves genuinely ambiguous addresses in manual review without querying", async () => {
  // Die legitime Hand-Prüfung (kein verwertbarer Standort) bleibt erhalten und
  // ruft AGIS gar nicht erst auf.
  let geometryCalled = false;
  const service = createAgisAssessmentService({
    repository: { getById: () => null, list: () => [], updateAssessment: () => null },
    agisGeometryService: {
      getOfficialFeatures: async () => {
        geometryCalled = true;
        return { matched: { points: true } };
      }
    }
  });

  const assessment = await service.assessItem({
    id: "BG-AMBIG-001",
    coordinates: "2651766,1250865",
    ambiguousAddress: 1
  });

  assert.equal(assessment.protectionStatus, "manual-review");
  assert.equal(geometryCalled, false);
});

test("application updates persist workflow and note", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const updateResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002", {
    method: "PATCH",
    headers: {
      Cookie: cookie
    },
    body: JSON.stringify({
      workflowStatus: "cleared",
      assignee: "QA Team",
      note: "Automatisch freigegeben."
    })
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.payload.workflowStatus, "cleared");
  assert.equal(updateResponse.payload.assignee, "QA Team");

  const detailResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002", {
    headers: {
      Cookie: cookie
    }
  });
  assert.equal(detailResponse.payload.note, "Automatisch freigegeben.");
});

test("confirmed decisions train future Baugesuch recognition", async (context) => {
  const syncFetchImpl = async () =>
    createJsonResponse({
      items: [
        {
          id: "BG-LEARN-001",
          source: "API",
          sourceReference: "LEARN-001",
          sourceUrl: "https://api.example.org/learned/1",
          municipality: "Baden",
          address: "Mellingerstrasse 7",
          parcel: "1189",
          publicationDate: dateOnlyDaysFromNow(-1),
          deadlineDate: dateOnlyDaysFromNow(14),
          projectType: "Fenstersanierung",
          description: "Ersatz der Fensterfront mit neuen Holz-Metall-Fenstern.",
          protectionStatus: "manual-review",
          agisMatch: "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          ambiguousAddress: true
        }
      ]
    });

  const testServer = createTestServer({
    syncSourceUrl: "https://api.example.org/learned.json",
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const patchResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002", {
    method: "PATCH",
    headers: {
      Cookie: cookie
    },
    body: JSON.stringify({
      workflowStatus: "cleared",
      assignee: "QA Team",
      note: "Lernsignal bestätigt.",
      learnFromDecision: true
    })
  });

  assert.equal(patchResponse.status, 200);

  const dashboardResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });
  assert.ok(dashboardResponse.payload.learningSummary.totalRules >= 1);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const importedItem = syncResponse.payload.items.find((item) => item.id === "BG-LEARN-001");
  assert.ok(importedItem);
  assert.equal(importedItem.protectionStatus, "no-hit");
  assert.equal(importedItem.agisMatch, "Kein Schutztreffer");
  assert.match(importedItem.automatedAssessment, /Lernregel/i);

  const detailResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-LEARN-001", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.protectionStatus, "no-hit");
  assert.equal(detailResponse.payload.ambiguousAddress, false);
});

test("configured API sync auto-clears coarse geocoder locations far from AGIS protection context", async (context) => {
  const syncFetchImpl = async () =>
    createJsonResponse({
      items: [
        {
          id: "BG-COARSE-FAR-001",
          source: "API",
          sourceReference: "COARSE-FAR-001",
          sourceUrl: "https://api.example.org/coarse/far",
          municipality: "Aarau",
          address: "Burghaldenstrasse",
          publicationDate: "2026-03-20",
          deadlineDate: "2026-04-19",
          projectType: "Umbau Wohnhaus",
          description: "Baugesuch mit Strassenangabe ohne Hausnummer.",
          protectionStatus: "manual-review",
          agisMatch: "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          ambiguousAddress: true
        }
      ]
    });
  const geocodeFetchImpl = async (url) => {
    const requestUrl = new URL(String(url));
    assert.match(requestUrl.searchParams.get("searchText") ?? "", /Burghaldenstrasse, Aarau/i);

    return createJsonResponse({
      results: [
        {
          attrs: {
            origin: "gg25",
            label: "Burghaldenstrasse, 5000 Aarau",
            municipality: "Aarau",
            x: 2645000,
            y: 1248000
          }
        }
      ]
    });
  };
  const agisFetchImpl = async () => createJsonResponse({ features: [] });

  const testServer = createTestServer({
    syncSourceUrl: "https://api.example.org/coarse/far.json",
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    agisFetchImpl,
    agisAssessmentEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const importedItem = syncResponse.payload.items.find((item) => item.id === "BG-COARSE-FAR-001");
  assert.ok(importedItem);
  assert.equal(importedItem.coordinates, "2645000,1248000");
  assert.equal(importedItem.locationPrecision, "approximate");
  assert.equal(importedItem.protectionStatus, "no-hit");
  assert.equal(importedItem.agisMatch, "Kein Schutztreffer");
  assert.equal(importedItem.ambiguousAddress, false);
  assert.match(importedItem.automatedAssessment, /Sicherheitsradius/i);
});

test("configured API sync keeps coarse geocoder locations near AGIS protection context in manual review", async (context) => {
  const syncFetchImpl = async () =>
    createJsonResponse({
      items: [
        {
          id: "BG-COARSE-NEAR-001",
          source: "API",
          sourceReference: "COARSE-NEAR-001",
          sourceUrl: "https://api.example.org/coarse/near",
          municipality: "Aarau",
          address: "Burghaldenstrasse",
          publicationDate: "2026-03-20",
          deadlineDate: "2026-04-19",
          projectType: "Umbau Wohnhaus",
          description: "Baugesuch mit Strassenangabe ohne Hausnummer.",
          protectionStatus: "manual-review",
          agisMatch: "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          ambiguousAddress: true
        }
      ]
    });
  const geocodeFetchImpl = async () =>
    createJsonResponse({
      results: [
        {
          attrs: {
            origin: "gg25",
            label: "Burghaldenstrasse, 5000 Aarau",
            municipality: "Aarau",
            x: 2645000,
            y: 1248000
          }
        }
      ]
    });
  const agisFetchImpl = async (url) => {
    const requestUrl = new URL(String(url));

    if (requestUrl.pathname.endsWith("/dp_denkmalpflege/MapServer/8/query")) {
      const geometry = JSON.parse(requestUrl.searchParams.get("geometry"));
      const isContextQuery = geometry.xmax - geometry.xmin > 1000;

      if (isContextQuery) {
        return createJsonResponse({
          features: [
            {
              attributes: {
                Titel: "Inventarobjekt in der Nähe",
                Gemeinde: "Aarau",
                Adresse: "Burghaldenstrasse 9",
                Signatur: "INV-AARAU-COARSE"
              },
              geometry: {
                x: 2645180,
                y: 1248000
              }
            }
          ]
        });
      }
    }

    return createJsonResponse({ features: [] });
  };

  const testServer = createTestServer({
    syncSourceUrl: "https://api.example.org/coarse/near.json",
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    agisFetchImpl,
    agisAssessmentEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  const importedItem = syncResponse.payload.items.find((item) => item.id === "BG-COARSE-NEAR-001");
  assert.ok(importedItem);
  assert.equal(importedItem.coordinates, "2645000,1248000");
  assert.equal(importedItem.locationPrecision, "approximate");
  assert.equal(importedItem.protectionStatus, "manual-review");
  assert.equal(importedItem.agisMatch, "Nahe Schutzobjekte bei unscharfer Lage");
  assert.equal(importedItem.ambiguousAddress, false);
  assert.match(importedItem.automatedAssessment, /von Hand prüfen/i);
});

test("municipality sync reuses coarse geocoder matches during refinement", async (context) => {
  const syncFetchImpl = async () =>
    new Response(
      `
        <html>
          <body>
            <main>
              <article>
                <a href="/bg-2026-088">Baugesuch Vorstadt 7</a>
                <p>Bauobjekt: Umbau Wohnhaus</p>
                <p>Bauplatz: Vorstadt 7</p>
                <p>Publiziert: 21. März 2026</p>
              </article>
            </main>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  let geocodeRequestCount = 0;
  const geocodeFetchImpl = async (url) => {
    geocodeRequestCount += 1;
    const requestUrl = new URL(String(url));
    assert.match(requestUrl.searchParams.get("searchText") ?? "", /Vorstadt 7, Aarau/i);

    return createJsonResponse({
      results: [
        {
          attrs: {
            origin: "gg25",
            label: "Vorstadt 7, 5000 Aarau",
            municipality: "Aarau",
            x: 2645000,
            y: 1248000
          }
        }
      ]
    });
  };
  const agisFetchImpl = async () => createJsonResponse({ features: [] });

  const testServer = createTestServer({
    syncFetchImpl,
    geocodeFetchImpl,
    geocodeEnabled: true,
    agisFetchImpl,
    agisAssessmentEnabled: true,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });
  const sourcesResponse = await requestJson(testServer.baseUrl, "/api/admin/municipality-sources", {
    headers: {
      Cookie: masterCookie
    }
  });
  const source = sourcesResponse.payload.items.find((item) => item.municipality === "Aarau");
  assert.ok(source);

  const saveResponse = await requestJson(testServer.baseUrl, `/api/admin/municipality-sources/${source.id}`, {
    method: "PATCH",
    headers: {
      Cookie: masterCookie
    },
    body: JSON.stringify({
      sourceType: "html",
      digitalStatus: "digital",
      enabled: true,
      sourceUrl: "https://aarau.example.org/baugesuche",
      includePattern: "baugesuch|bauobjekt|bauplatz",
      excludePattern: "newsletter|facebook|archiv",
      notes: "Offizielle Baugesuchseite"
    })
  });

  assert.equal(saveResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: masterCookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(geocodeRequestCount, 1);
  assert.equal(syncResponse.payload.items[0].coordinates, "2645000,1248000");
  assert.equal(syncResponse.payload.items[0].locationPrecision, "approximate");
  assert.equal(syncResponse.payload.items[0].protectionStatus, "no-hit");
});

test("application read state is stored per user", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const luciaCookie = await login(testServer.baseUrl);
  const beforeRead = await requestJson(testServer.baseUrl, "/api/applications", {
    headers: { Cookie: luciaCookie }
  });
  assert.equal(beforeRead.status, 200);
  assert.equal(beforeRead.payload.items.find((item) => item.id === "BG-2026-002").isRead, false);

  const markRead = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002/read", {
    method: "POST",
    headers: { Cookie: luciaCookie }
  });
  assert.equal(markRead.status, 200);
  assert.equal(markRead.payload.isRead, true);

  const afterRead = await requestJson(testServer.baseUrl, "/api/applications", {
    headers: { Cookie: luciaCookie }
  });
  assert.equal(afterRead.payload.items.find((item) => item.id === "BG-2026-002").isRead, true);

  const aleksandarCookie = await login(testServer.baseUrl, {
    username: "aleksandar.nikolic"
  });
  const otherUserList = await requestJson(testServer.baseUrl, "/api/applications", {
    headers: { Cookie: aleksandarCookie }
  });
  assert.equal(otherUserList.payload.items.find((item) => item.id === "BG-2026-002").isRead, false);
});

test("team comments can be stored and read for an application", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const createResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002/comments", {
    method: "POST",
    headers: {
      Cookie: cookie
    },
    body: JSON.stringify({
      message: "Ich habe die Unterlagen geprüft und bitte um Zweitmeinung."
    })
  });

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.payload.userDisplayName, "Lucia Vettori");

  const listResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002/comments", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.payload.items.length, 1);
  assert.equal(listResponse.payload.items[0].message, "Ich habe die Unterlagen geprüft und bitte um Zweitmeinung.");
});

test("sync prune keeps untouched municipality imports that carry team comments", () => {
  // Regression für den Datenverlust-Befund: der Sync-Prune darf einen Fall, zu
  // dem das Team bereits einen Kommentar erfasst hat, nicht entfernen - sonst
  // wuerde der Kommentar via ON DELETE CASCADE ebenfalls verschwinden.
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-prune-"));
  const dbPath = join(directory, "prune.sqlite");
  const db = createDatabase(dbPath, { seedDemoApplications: false });
  const repository = createApplicationsRepository(db);

  const baseItem = (id, reference, address) => ({
    id,
    source: "Gemeinde-Webseite",
    sourceReference: reference,
    sourceUrl: `https://aarau.example.org/baugesuche/${reference}`,
    municipality: "Aarau",
    address,
    coordinates: "",
    publicationDate: "2026-03-01",
    deadlineDate: "",
    projectType: "Baugesuch",
    description: "Importierter Fall",
    protectionStatus: "manual-review",
    agisMatch: "Noch nicht eindeutig zugeordnet",
    agisLayers: [],
    ambiguousAddress: 1
  });

  repository.importItems(
    [
      baseItem("BG-PRUNE-COMMENTED", "PRUNE-COMMENTED", "Teststrasse 1"),
      baseItem("BG-PRUNE-PLAIN", "PRUNE-PLAIN", "Teststrasse 2")
    ],
    "2026-03-01T00:00:00.000Z"
  );

  const userId = db.prepare("SELECT id FROM users LIMIT 1").get().id;
  db.prepare(
    `INSERT INTO application_comments (id, application_id, user_id, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("C-PRUNE-1", "BG-PRUNE-COMMENTED", userId, "Bereits besprochen, bitte aufbewahren.", "2026-03-02T08:00:00.000Z", "2026-03-02T08:00:00.000Z");

  repository.pruneUntouchedMunicipalityImports({ source: "Gemeinde-Webseite", municipality: "Aarau" });

  const commented = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE id = 'BG-PRUNE-COMMENTED'").get().n;
  const plain = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE id = 'BG-PRUNE-PLAIN'").get().n;
  const comment = db.prepare("SELECT COUNT(*) AS n FROM application_comments WHERE application_id = 'BG-PRUNE-COMMENTED'").get().n;

  db.close();
  rmSync(directory, { recursive: true, force: true });

  assert.equal(commented, 1, "Fall mit Team-Kommentar darf vom Sync nicht entfernt werden");
  assert.equal(plain, 0, "Unberührter Fall ohne Kommentar wird wie bisher entfernt");
  assert.equal(comment, 1, "Der Kommentar bleibt erhalten");
});

test("startup cleanup keeps junk-pattern rows that carry team comments", () => {
  // Regression: die Startup-Bereinigung loescht HTML-/URL-Muell, darf dabei aber
  // keine Zeile entfernen, an der das Team schon gearbeitet hat (Kommentar).
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-cleanup-"));
  const dbPath = join(directory, "cleanup.sqlite");
  const seedDb = createDatabase(dbPath, { seedDemoApplications: false });
  const repository = createApplicationsRepository(seedDb);

  const junkItem = (id, reference) => ({
    id,
    source: "Gemeinde-Webseite",
    sourceReference: reference,
    sourceUrl: "https://aarau.example.org/baugesuche",
    municipality: "Aarau",
    address: "Adresse von Webseite prüfen",
    coordinates: "",
    publicationDate: "2026-03-01",
    deadlineDate: "",
    projectType: "Baugesuch",
    description: "HTML-Müll ohne verwertbaren Standort",
    protectionStatus: "manual-review",
    agisMatch: "Noch nicht eindeutig zugeordnet",
    agisLayers: [],
    ambiguousAddress: 1
  });

  repository.importItems(
    [junkItem("BG-JUNK-COMMENTED", "JUNK-COMMENTED"), junkItem("BG-JUNK-PLAIN", "JUNK-PLAIN")],
    "2026-03-01T00:00:00.000Z"
  );

  const userId = seedDb.prepare("SELECT id FROM users LIMIT 1").get().id;
  seedDb.prepare(
    `INSERT INTO application_comments (id, application_id, user_id, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("C-JUNK-1", "BG-JUNK-COMMENTED", userId, "Trotz Mülladresse hier bereits geprüft.", "2026-03-02T08:00:00.000Z", "2026-03-02T08:00:00.000Z");
  // Die Bereinigung ist eine einmalige Migration; Marker entfernen, damit sie
  // beim erneuten Öffnen (wie bei einer Bestands-DB) noch einmal läuft.
  seedDb.prepare("DELETE FROM schema_migrations WHERE id = 'cleanup-seed-artifacts-and-junk'").run();
  seedDb.close();

  // Erneutes Öffnen führt die Startup-Bereinigung aus.
  const reopened = createDatabase(dbPath, { seedDemoApplications: false });
  const commented = reopened.prepare("SELECT COUNT(*) AS n FROM applications WHERE id = 'BG-JUNK-COMMENTED'").get().n;
  const plain = reopened.prepare("SELECT COUNT(*) AS n FROM applications WHERE id = 'BG-JUNK-PLAIN'").get().n;
  reopened.close();
  rmSync(directory, { recursive: true, force: true });

  assert.equal(commented, 1, "Junk-Zeile mit Team-Kommentar bleibt beim Startup-Cleanup erhalten");
  assert.equal(plain, 0, "Junk-Zeile ohne Team-Arbeit wird wie bisher bereinigt");
});

test("sync imports the next queued Amtsblatt record", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const beforeResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });
  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: cookie
    }
  });
  const afterResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.imported, true);
  assert.equal(afterResponse.payload.stats.totalApplications, beforeResponse.payload.stats.totalApplications + 1);
});

test("configured API sync imports new items and preserves team workflow on updates", async (context) => {
  const syncFetchImpl = async () =>
    createJsonResponse({
      items: [
        {
          id: "BG-2026-002",
          source: "API",
          sourceReference: "AB-2026-03-20-002",
          sourceUrl: "https://api.example.org/baugesuche",
          municipality: "Baden",
          address: "Mellingerstrasse 7",
          publicationDate: "2026-03-20",
          deadlineDate: "2026-03-29",
          projectType: "Fenstersanierung aktualisiert",
          description: "Aktualisierte Unterlagen aus der API.",
          protectionStatus: "no-hit",
          agisMatch: "Kein Schutztreffer",
          agisLayers: []
        },
        {
          id: "BG-API-001",
          source: "API",
          sourceReference: "API-2026-001",
          sourceUrl: "https://api.example.org/baugesuche",
          municipality: "Aarau",
          address: "Tellistrasse 8",
          publicationDate: "2026-03-20",
          deadlineDate: "2026-03-31",
          projectType: "Neubau Velounterstand",
          description: "Neuer Fall aus der externen API.",
          protectionStatus: "manual-review",
          agisMatch: "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          ambiguousAddress: true
        }
      ]
    });

  const testServer = createTestServer({
    syncSourceUrl: "https://api.example.org/baugesuche",
    syncFetchImpl,
    autoSyncEnabled: false
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const beforeResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });

  const patchResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002", {
    method: "PATCH",
    headers: {
      Cookie: cookie
    },
    body: JSON.stringify({
      workflowStatus: "under-review",
      assignee: "Lucia Vettori",
      note: "Bitte intern ansehen."
    })
  });

  assert.equal(patchResponse.status, 200);

  const syncResponse = await requestJson(testServer.baseUrl, "/api/sync", {
    method: "POST",
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.payload.importedCount, 1);
  assert.equal(syncResponse.payload.updatedCount, 1);

  const afterResponse = await requestJson(testServer.baseUrl, "/api/dashboard", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(afterResponse.payload.stats.totalApplications, beforeResponse.payload.stats.totalApplications + 1);

  const updatedExisting = await requestJson(testServer.baseUrl, "/api/applications/BG-2026-002", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(updatedExisting.payload.workflowStatus, "under-review");
  assert.equal(updatedExisting.payload.note, "Bitte intern ansehen.");
  assert.equal(updatedExisting.payload.description, "Aktualisierte Unterlagen aus der API.");
  assert.equal(updatedExisting.payload.projectType, "Fenstersanierung aktualisiert");

  const importedNew = await requestJson(testServer.baseUrl, "/api/applications/BG-API-001", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(importedNew.status, 200);
  assert.equal(importedNew.payload.source, "API");
  assert.equal(importedNew.payload.protectionStatus, "manual-review");

  const syncStatus = await requestJson(testServer.baseUrl, "/api/sync/status", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(syncStatus.status, 200);
  assert.equal(syncStatus.payload.configured, true);
  assert.ok(syncStatus.payload.job.lastSuccessAt);
});

test("weekly API sync can run automatically on start", async (context) => {
  const syncFetchImpl = async () =>
    createJsonResponse({
      items: [
        {
          id: "BG-API-START-001",
          source: "API",
          sourceReference: "API-START-001",
          sourceUrl: "https://api.example.org/start",
          municipality: "Brugg",
          address: "Aarauerstrasse 11",
          publicationDate: "2026-03-20",
          deadlineDate: "2026-03-27",
          projectType: "Vordach",
          description: "Automatisch beim Start importiert.",
          protectionStatus: "no-hit",
          agisMatch: "Kein Schutztreffer",
          agisLayers: []
        }
      ]
    });

  const testServer = createTestServer({
    syncSourceUrl: "https://api.example.org/start",
    syncFetchImpl,
    autoSyncEnabled: true,
    autoSyncRunOnStart: true
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);

  await waitFor(async () => {
    const statusResponse = await requestJson(testServer.baseUrl, "/api/sync/status", {
      headers: {
        Cookie: cookie
      }
    });

    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.payload.job.status, "success");
    assert.equal(statusResponse.payload.job.lastImportedCount, 1);
  });

  const detailResponse = await requestJson(testServer.baseUrl, "/api/applications/BG-API-START-001", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.payload.address, "Aarauerstrasse 11");
});

test("agis endpoint exposes normalized official geometry hits", async (context) => {
  const agisFetchImpl = async (url) => {
    const requestUrl = new URL(typeof url === "string" ? url : url.url ?? String(url));

    if (requestUrl.pathname.endsWith("/are_isos/MapServer/21/query")) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              OBJECTID: 42,
              BENENN_F: "Test-Ortsbild",
              KAT_F: "G Gebiet",
              Bedeutung: "national",
              ERHALT_F: "A Erhalten der Substanz",
              Inventarblatt: null
            },
            geometry: {
              rings: [
                [
                  [2651700, 1250800],
                  [2651800, 1250800],
                  [2651800, 1250900],
                  [2651700, 1250900],
                  [2651700, 1250800]
                ]
              ]
            }
          }
        ]
      });
    }

    if (requestUrl.pathname.endsWith("/dp_denkmalpflege/MapServer/8/query")) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              Titel: "Testhaus",
              Gemeinde: "Brugg",
              Adresse: "Hauptstrasse 44",
              Signatur: "INV-TEST-001"
            },
            geometry: {
              x: 2651766,
              y: 1250865
            }
          }
        ]
      });
    }

    return createJsonResponse({ features: [] });
  };

  const testServer = createTestServer({ agisFetchImpl });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const response = await requestJson(testServer.baseUrl, "/api/agis/features?east=2651766&north=1250865", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.matched.area, true);
  assert.equal(response.payload.matched.points, true);
  assert.equal(response.payload.areaFeatures.length, 1);
  assert.equal(response.payload.pointFeatures.length, 1);
  assert.equal(response.payload.displayAreaFeatures.length, 1);
  assert.equal(response.payload.displayPointFeatures.length, 1);
  assert.equal(response.payload.areaFeatures[0].properties.title, "Test-Ortsbild");
  assert.equal(response.payload.pointFeatures[0].properties.reference, "INV-TEST-001");
  assert.ok(Array.isArray(response.payload.areaFeatures[0].parts));
});

test("agis endpoint returns nearby official zones and points for map context without forcing a direct hit", async (context) => {
  const agisFetchImpl = async (url) => {
    const requestUrl = new URL(typeof url === "string" ? url : url.url ?? String(url));

    if (
      requestUrl.pathname.endsWith("/are_isos/MapServer/21/query") &&
      requestUrl.searchParams.get("geometryType") === "esriGeometryPoint"
    ) {
      return createJsonResponse({ features: [] });
    }

    if (
      requestUrl.pathname.endsWith("/dp_denkmalpflege/MapServer/8/query") &&
      requestUrl.searchParams.get("geometryType") === "esriGeometryEnvelope"
    ) {
      const geometry = JSON.parse(requestUrl.searchParams.get("geometry"));

      if (geometry.xmax - geometry.xmin === 240) {
        return createJsonResponse({ features: [] });
      }
    }

    if (requestUrl.pathname.endsWith("/are_isos/MapServer/18/query")) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              OBJECTID: 18,
              GEMEINDE: "Kölliken",
              ORTSBILD: "Kölliken",
              E_STUF: "national"
            },
            geometry: {
              rings: [
                [
                  [2642500, 1242500],
                  [2645000, 1242500],
                  [2645000, 1244500],
                  [2642500, 1244500],
                  [2642500, 1242500]
                ]
              ]
            }
          }
        ]
      });
    }

    if (requestUrl.pathname.endsWith("/are_isos/MapServer/21/query")) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              OBJECTID: 21,
              BENENN_F: "Ortsbildteil XI",
              KAT_F: "G Gebiet"
            },
            geometry: {
              rings: [
                [
                  [2643400, 1243000],
                  [2643900, 1243000],
                  [2643900, 1243500],
                  [2643400, 1243500],
                  [2643400, 1243000]
                ]
              ]
            }
          }
        ]
      });
    }

    if (
      requestUrl.pathname.endsWith("/are_isos/MapServer/20/query") &&
      requestUrl.searchParams.get("geometryType") === "esriGeometryEnvelope"
    ) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              OBJECTID: 20,
              BENENN_E: "Hinweiszone 0.3",
              KAT_E: "Hinweis"
            },
            geometry: {
              rings: [
                [
                  [2643100, 1242150],
                  [2643400, 1242150],
                  [2643400, 1242450],
                  [2643100, 1242450],
                  [2643100, 1242150]
                ]
              ]
            }
          }
        ]
      });
    }

    if (requestUrl.pathname.endsWith("/dp_denkmalpflege/MapServer/8/query")) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              TITEL: "Bauinventar Kölliken",
              GEMEINDE: "Kölliken",
              ADRESSE: "Dorfstrasse 1",
              SIGNATUR: "INV-KOELL-001"
            },
            geometry: {
              x: 2643600,
              y: 1243200
            }
          }
        ]
      });
    }

    return createJsonResponse({ features: [] });
  };

  const testServer = createTestServer({ agisFetchImpl });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const response = await requestJson(testServer.baseUrl, "/api/agis/features?east=2643869&north=1243285", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.matched.area, false);
  assert.equal(response.payload.matched.points, false);
  assert.equal(response.payload.areaFeatures.length, 0);
  assert.equal(response.payload.pointFeatures.length, 0);
  assert.equal(response.payload.displayAreaFeatures.length, 3);
  assert.equal(response.payload.displayPointFeatures.length, 1);
  assert.deepEqual(
    response.payload.displayAreaFeatures.map((feature) => feature.properties.layerKey),
    ["municipality-zone", "zone-part", "hint-zone"]
  );
  assert.equal(response.payload.displayPointFeatures[0].properties.reference, "INV-KOELL-001");
});

test("agis endpoint falls back to official perimeter layers with alternate field names", async (context) => {
  const agisFetchImpl = async (url) => {
    const requestUrl = new URL(typeof url === "string" ? url : url.url ?? String(url));

    if (requestUrl.pathname.endsWith("/are_isos/MapServer/21/query")) {
      return createJsonResponse({ features: [] });
    }

    if (requestUrl.pathname.endsWith("/are_isos/MapServer/15/query")) {
      return createJsonResponse({
        features: [
          {
            attributes: {
              OBJECTID: 2533,
              ORT: "Rupperswil, Fabrikanlage",
              RASTER: "Spezialfall",
              Bedeutung: "national",
              PDF_1: "https://example.test/isos.pdf"
            },
            geometry: {
              rings: [
                [
                  [2651304, 1251662],
                  [2652030, 1251666],
                  [2652367, 1250180],
                  [2651309, 1250173],
                  [2651304, 1251662]
                ]
              ]
            }
          }
        ]
      });
    }

    if (requestUrl.pathname.endsWith("/dp_denkmalpflege/MapServer/8/query")) {
      return createJsonResponse({ features: [] });
    }

    return createJsonResponse({ features: [] });
  };

  const testServer = createTestServer({ agisFetchImpl });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  const response = await requestJson(testServer.baseUrl, "/api/agis/features?east=2651766&north=1250865", {
    headers: {
      Cookie: cookie
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.matched.area, true);
  assert.equal(response.payload.matched.points, false);
  assert.equal(response.payload.meta.areaLayerId, 15);
  assert.equal(response.payload.areaFeatures[0].properties.title, "Rupperswil, Fabrikanlage");
  assert.equal(response.payload.areaFeatures[0].properties.category, "Spezialfall");
  assert.equal(response.payload.areaFeatures[0].properties.inventorySheet, "https://example.test/isos.pdf");
});

test("responses carry hardened security headers including HSTS", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const response = await requestText(testServer.baseUrl, "/api/health");

  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("large responses are gzip-compressed when the client accepts it", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const compressed = await rawRequest(testServer.baseUrl, "/", {
    headers: { "Accept-Encoding": "gzip" }
  });

  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.match(String(compressed.headers.vary ?? ""), /accept-encoding/i);

  const decoded = gunzipSync(compressed.body).toString("utf8");
  assert.match(decoded, /<html/i);
});

test("responses are not compressed when the client does not accept gzip", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const response = await rawRequest(testServer.baseUrl, "/", {
    headers: { "Accept-Encoding": "identity" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.match(response.body.toString("utf8"), /<html/i);
});

test("repeated failed logins are rate-limited per client", async (context) => {
  const testServer = createTestServer({
    loginRateLimit: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 60_000 }
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  async function attempt(password) {
    return requestJson(testServer.baseUrl, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "lucia.vettori", password })
    });
  }

  for (let index = 0; index < 3; index += 1) {
    const failed = await attempt("falsches-passwort");
    assert.equal(failed.status, 401);
  }

  const blocked = await attempt("falsches-passwort");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);

  // Auch eine korrekte Anmeldung bleibt während der Sperre blockiert.
  const blockedValid = await attempt("Heimat2026!");
  assert.equal(blockedValid.status, 429);
});

test("rate limiting can be disabled for trusted environments", async (context) => {
  const testServer = createTestServer({ loginRateLimit: false });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  for (let index = 0; index < 6; index += 1) {
    const failed = await requestJson(testServer.baseUrl, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "lucia.vettori", password: "falsch" })
    });
    assert.equal(failed.status, 401);
  }

  const cookie = await login(testServer.baseUrl);
  assert.ok(cookie);
});

test("master account is locked and bootstrapped via an emailed setup key", async (context) => {
  const setupKeys = [];
  const testServer = createTestServer({
    masterAccountPassword: "",
    masterSetupEmail: "master@example.test",
    onMasterSetupKey: ({ key, sentTo }) => {
      setupKeys.push({ key, sentTo });
    }
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  await testServer.ready;

  // Ein Setup-Key wurde erzeugt und an die konfigurierte Adresse zugestellt.
  assert.equal(setupKeys.length, 1);
  assert.equal(setupKeys[0].sentTo, "master@example.test");
  assert.match(setupKeys[0].key, /^HSA-SETUP-/);

  const statusBefore = await requestJson(testServer.baseUrl, "/api/auth/master-setup-status");
  assert.equal(statusBefore.payload.setupRequired, true);

  // Vor der Einrichtung ist kein Master-Login möglich.
  const lockedLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: "irgendwas-falsches" })
  });
  assert.equal(lockedLogin.status, 401);

  // Ungültiger Key wird abgewiesen.
  const wrongKey = await requestJson(testServer.baseUrl, "/api/auth/master-setup", {
    method: "POST",
    body: JSON.stringify({ key: "HSA-SETUP-0000-0000-0000-0000", password: "NeuesMaster_2026!" })
  });
  assert.equal(wrongKey.status, 400);

  // Zu kurzes Passwort wird abgewiesen.
  const shortPassword = await requestJson(testServer.baseUrl, "/api/auth/master-setup", {
    method: "POST",
    body: JSON.stringify({ key: setupKeys[0].key, password: "kurz" })
  });
  assert.equal(shortPassword.status, 400);

  // Gültiger Key + Passwort schaltet das Master-Konto frei.
  const setup = await requestJson(testServer.baseUrl, "/api/auth/master-setup", {
    method: "POST",
    body: JSON.stringify({ key: setupKeys[0].key, password: "NeuesMaster_2026!" })
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.payload.success, true);

  // Danach funktioniert der Login mit dem neuen Passwort.
  const masterLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: "NeuesMaster_2026!" })
  });
  assert.equal(masterLogin.status, 200);

  // Der Key ist verbraucht und kann nicht erneut verwendet werden.
  const reuse = await requestJson(testServer.baseUrl, "/api/auth/master-setup", {
    method: "POST",
    body: JSON.stringify({ key: setupKeys[0].key, password: "NochEinMal_2026!" })
  });
  assert.equal(reuse.status, 400);

  const statusAfter = await requestJson(testServer.baseUrl, "/api/auth/master-setup-status");
  assert.equal(statusAfter.payload.setupRequired, false);
});

test("a configured master password does not trigger the setup key flow", async (context) => {
  const setupKeys = [];
  const testServer = createTestServer({
    masterAccountPassword: "MasterDirekt_2026!",
    onMasterSetupKey: ({ key }) => {
      setupKeys.push(key);
    }
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  await testServer.ready;

  assert.equal(setupKeys.length, 0);

  const status = await requestJson(testServer.baseUrl, "/api/auth/master-setup-status");
  assert.equal(status.payload.setupRequired, false);

  const masterLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: "MasterDirekt_2026!" })
  });
  assert.equal(masterLogin.status, 200);
});

test("one-time setup and reset keys are not written to logs without mail delivery", async (context) => {
  const logMessages = [];
  const logger = {
    log: (message) => logMessages.push(String(message)),
    warn: (message) => logMessages.push(String(message)),
    error: (message) => logMessages.push(String(message))
  };
  const testServer = createTestServer({
    masterAccountPassword: "",
    masterSetupEmail: "",
    logger
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  await testServer.ready;

  assert.doesNotMatch(logMessages.join("\n"), /HSA-(?:SETUP|RESET)-/);

  const status = await requestJson(testServer.baseUrl, "/api/auth/master-setup-status");
  assert.equal(status.payload.setupRequired, false);

  testServer.db
    .prepare("UPDATE users SET email = 'lucia@example.test' WHERE username = 'lucia.vettori'")
    .run();

  const forgot = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "lucia@example.test" })
  });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.payload.success, true);

  const resetKeyCount = testServer.db.prepare("SELECT COUNT(*) AS count FROM password_reset_keys").get().count;
  assert.equal(resetKeyCount, 0);
  assert.doesNotMatch(logMessages.join("\n"), /HSA-(?:SETUP|RESET)-/);
});

test("self-service password reset by email works for accounts with an email", async (context) => {
  const resetKeys = [];
  const testServer = createTestServer({
    onPasswordResetKey: ({ key, sentTo }) => {
      resetKeys.push({ key, sentTo });
    }
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  // Seed-Konten haben keine E-Mail; für den Test eine hinterlegen.
  testServer.db
    .prepare("UPDATE users SET email = 'lucia@example.test' WHERE username = 'lucia.vettori'")
    .run();

  const forgot = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori" })
  });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.payload.success, true);
  assert.equal(resetKeys.length, 1);
  assert.equal(resetKeys[0].sentTo, "lucia@example.test");
  assert.match(resetKeys[0].key, /^HSA-RESET-/);

  const reset = await requestJson(testServer.baseUrl, "/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ key: resetKeys[0].key, password: "NeuLucia_2026!" })
  });
  assert.equal(reset.status, 200);

  const newLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "NeuLucia_2026!" })
  });
  assert.equal(newLogin.status, 200);

  const oldLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(oldLogin.status, 401);

  const reuse = await requestJson(testServer.baseUrl, "/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ key: resetKeys[0].key, password: "NochMal_2026!" })
  });
  assert.equal(reuse.status, 400);
});

test("forgot-password does not reveal whether an account or email exists", async (context) => {
  const resetKeys = [];
  const testServer = createTestServer({
    onPasswordResetKey: ({ key }) => resetKeys.push(key)
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  // Unbekanntes Konto -> generische Erfolgsantwort, kein Key.
  const unknown = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ username: "gibt.es.nicht" })
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.payload.success, true);

  // Bekanntes Konto ohne E-Mail -> ebenfalls generisch, kein Key.
  const noEmail = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ username: "david.huber" })
  });
  assert.equal(noEmail.status, 200);
  assert.equal(noEmail.payload.success, true);

  assert.equal(resetKeys.length, 0);
});

test("reset-password rejects an invalid key", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const response = await requestJson(testServer.baseUrl, "/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ key: "HSA-RESET-0000-0000-0000-0000", password: "Irgendwas_2026!" })
  });
  assert.equal(response.status, 400);
});

test("cross-origin state-changing requests are blocked by the CSRF guard", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  // Fremder Origin auf einem ändernden Request -> blockiert.
  const blocked = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { Origin: "https://böswillig.example" },
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(blocked.status, 403);

  // Gleicher Origin -> erlaubt (Login funktioniert normal).
  const allowed = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { Origin: testServer.baseUrl },
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(allowed.status, 200);

  // Ohne Origin/Referer (z. B. Server-zu-Server) -> erlaubt.
  const noOrigin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(noOrigin.status, 200);
});

test("audit log records master actions and is only readable by the master", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  // createRegistrationKey loggt das Master-Konto ein und erstellt einen Schlüssel.
  const { cookie } = await createRegistrationKey(testServer.baseUrl);

  const auditResponse = await requestJson(testServer.baseUrl, "/api/admin/audit-log", {
    headers: { Cookie: cookie }
  });
  assert.equal(auditResponse.status, 200);

  const actions = auditResponse.payload.items.map((entry) => entry.action);
  assert.ok(actions.includes("auth.login"));
  assert.ok(actions.includes("admin.registration_key.create"));

  // Ein Team-Konto (nicht Master) darf das Protokoll nicht einsehen.
  const teamCookie = await login(testServer.baseUrl);
  const forbidden = await requestJson(testServer.baseUrl, "/api/admin/audit-log", {
    headers: { Cookie: teamCookie }
  });
  assert.equal(forbidden.status, 403);
});

test("maintenance cleanup removes expired sessions and stale registration keys", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  testServer.db
    .prepare(`
      INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at)
      VALUES ('SESS-EXPIRED', 'USR-MASTER', ?, ?, ?)
    `)
    .run(past, past, past);

  testServer.db
    .prepare(`
      INSERT INTO registration_keys (id, key_code, note, created_by_user_id, created_at, expires_at)
      VALUES ('KEY-STALE', 'HSA-DEAD-DEAD-DEAD', '', 'USR-MASTER', ?, ?)
    `)
    .run(past, past);

  const removed = testServer.maintenanceService.runCleanup();
  assert.ok(removed >= 1);

  const session = testServer.db.prepare("SELECT id FROM user_sessions WHERE id = 'SESS-EXPIRED'").get();
  assert.equal(session, undefined);

  const key = testServer.db.prepare("SELECT id FROM registration_keys WHERE id = 'KEY-STALE'").get();
  assert.equal(key, undefined);
});

test("maintenance creates a SQLite backup file when enabled", async (context) => {
  const backupDir = mkdtempSync(join(tmpdir(), "heimatschutz-backup-"));
  const testServer = createTestServer({ backupEnabled: true, backupDir });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  });

  const target = testServer.maintenanceService.runBackup();
  assert.ok(target);
  assert.ok(existsSync(target));

  const backups = readdirSync(backupDir).filter((name) => name.endsWith(".bak"));
  assert.ok(backups.length >= 1);
});

test("master 2FA can be enabled and is then required at login", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: TEST_MASTER_PASSWORD
  });

  // Einrichtung starten -> Secret erhalten.
  const setup = await requestJson(testServer.baseUrl, "/api/admin/2fa/setup", {
    method: "POST",
    headers: { Cookie: masterCookie }
  });
  assert.equal(setup.status, 200);
  assert.ok(setup.payload.secret);
  assert.match(setup.payload.otpauthUri, /^otpauth:\/\/totp\//);

  // Falscher Code -> Aktivierung abgelehnt.
  const wrongEnable = await requestJson(testServer.baseUrl, "/api/admin/2fa/enable", {
    method: "POST",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ code: "000000" })
  });
  assert.equal(wrongEnable.status, 400);

  // Korrekter Code -> aktiviert.
  const enable = await requestJson(testServer.baseUrl, "/api/admin/2fa/enable", {
    method: "POST",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ code: generateTotp(setup.payload.secret) })
  });
  assert.equal(enable.status, 200);
  assert.equal(enable.payload.enabled, true);

  const status = await requestJson(testServer.baseUrl, "/api/admin/2fa/status", {
    headers: { Cookie: masterCookie }
  });
  assert.equal(status.payload.enabled, true);

  // Login ohne Code -> 401 mit totpRequired.
  const noCode = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: TEST_MASTER_PASSWORD })
  });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.payload.totpRequired, true);

  // Login mit falschem Code -> 401.
  const badCode = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: TEST_MASTER_PASSWORD, totp: "000000" })
  });
  assert.equal(badCode.status, 401);

  // Login mit korrektem Code -> 200.
  const goodCode = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "master",
      password: TEST_MASTER_PASSWORD,
      totp: generateTotp(setup.payload.secret)
    })
  });
  assert.equal(goodCode.status, 200);

  // Deaktivieren mit korrektem Code -> Login wieder ohne Code möglich.
  const disable = await requestJson(testServer.baseUrl, "/api/admin/2fa/disable", {
    method: "POST",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ code: generateTotp(setup.payload.secret) })
  });
  assert.equal(disable.status, 200);
  assert.equal(disable.payload.enabled, false);

  const afterDisable = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: TEST_MASTER_PASSWORD })
  });
  assert.equal(afterDisable.status, 200);
});

test("a normal team login is unaffected by master 2FA being available", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const cookie = await login(testServer.baseUrl);
  assert.ok(cookie);

  // Team-Konto darf 2FA nicht verwalten.
  const forbidden = await requestJson(testServer.baseUrl, "/api/admin/2fa/setup", {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(forbidden.status, 403);
});

test("forgot-password by email address finds the account and sends a key", async (context) => {
  const resetKeys = [];
  const testServer = createTestServer({
    onPasswordResetKey: ({ key, sentTo }) => resetKeys.push({ key, sentTo })
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  testServer.db
    .prepare("UPDATE users SET email = 'lucia@example.test' WHERE username = 'lucia.vettori'")
    .run();

  // Bekannte E-Mail -> Key wird an genau diese Adresse gesendet.
  const known = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "LUCIA@example.test" })
  });
  assert.equal(known.status, 200);
  assert.equal(resetKeys.length, 1);
  assert.equal(resetKeys[0].sentTo, "lucia@example.test");

  // Unbekannte E-Mail -> generische Antwort, kein Key.
  const unknown = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "niemand@example.test" })
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.payload.success, true);
  assert.equal(resetKeys.length, 1);
});

test("turnstile (when enabled) protects register, forgot-password and the second login attempt", async (context) => {
  const testServer = createTestServer({
    turnstileSiteKey: "test-site-key",
    turnstileVerify: async (token) => token === "good",
    onPasswordResetKey: () => {}
  });

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  testServer.db
    .prepare("UPDATE users SET email = 'lucia@example.test' WHERE username = 'lucia.vettori'")
    .run();

  // Config-Endpoint meldet aktiviert + Site-Key (fürs Frontend-Widget).
  const config = await requestJson(testServer.baseUrl, "/api/auth/config");
  assert.equal(config.payload.turnstile.enabled, true);
  assert.equal(config.payload.turnstile.siteKey, "test-site-key");

  // forgot-password: ohne Token abgewiesen, mit gültigem Token erlaubt.
  const forgotNoToken = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "lucia@example.test" })
  });
  assert.equal(forgotNoToken.status, 400);
  assert.equal(forgotNoToken.payload.captchaRequired, true);

  const forgotGood = await requestJson(testServer.baseUrl, "/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "lucia@example.test", turnstileToken: "good" })
  });
  assert.equal(forgotGood.status, 200);

  // Registrierung ohne Token abgewiesen.
  const masterCookie = await login(testServer.baseUrl, { username: "master", password: TEST_MASTER_PASSWORD });
  const keyResponse = await requestJson(testServer.baseUrl, "/api/admin/registration-keys", {
    method: "POST",
    headers: { Cookie: masterCookie },
    body: JSON.stringify({ note: "Turnstile-Test" })
  });
  const regNoToken = await requestJson(testServer.baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      displayName: "Bot Person",
      username: "bot.person",
      password: "Sicher1234",
      accessKey: keyResponse.payload.keyCode
    })
  });
  assert.equal(regNoToken.status, 400);
  assert.equal(regNoToken.payload.captchaRequired, true);

  // Login: 1. Versuch (falsch) braucht KEIN Token, meldet aber captchaRequired für den nächsten.
  const firstWrong = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "falsch" })
  });
  assert.equal(firstWrong.status, 401);
  assert.equal(firstWrong.payload.captchaRequired, true);

  // 2. Versuch ohne Token -> abgewiesen (Bot-Prüfung verlangt).
  const secondNoToken = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!" })
  });
  assert.equal(secondNoToken.status, 401);
  assert.equal(secondNoToken.payload.captchaRequired, true);

  // 2. Versuch mit gültigem Token + richtigem Passwort -> Login klappt.
  const secondGood = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "lucia.vettori", password: "Heimat2026!", turnstileToken: "good" })
  });
  assert.equal(secondGood.status, 200);
});
