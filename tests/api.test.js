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
        : process.env.MASTER_ACCOUNT_PASSWORD ?? "HouseisGood1999?",
    defaultLoginPassword:
      "defaultLoginPassword" in options
        ? options.defaultLoginPassword
        : process.env.DEFAULT_LOGIN_PASSWORD ?? "Heimat2026!",
    masterSetupEmail: options.masterSetupEmail,
    mailService: options.mailService,
    onMasterSetupKey: options.onMasterSetupKey,
    onPasswordResetKey: options.onPasswordResetKey
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
      password: credentials.password ?? "Heimat2026!"
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
    password: "HouseisGood1999?"
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
        MASTER_ACCOUNT_PASSWORD: "HouseisGood1999?",
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
    password: "HouseisGood1999?"
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

test("master can import an AGIS export JSON as a practical fallback", async (context) => {
  const testServer = createTestServer();

  context.after(async () => {
    await closeTestServer(testServer);
    rmSync(testServer.directory, { recursive: true, force: true });
  });

  const masterCookie = await login(testServer.baseUrl, {
    username: "master",
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
  assert.equal(auwSource?.enabled, false);
  assert.match(auwSource?.notes ?? "", /eBau-Seite/i);
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
    password: "HouseisGood1999?"
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
  assert.equal(response.payload.report.totalUniqueSources, 196);
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
  const zuzgenCatalogItem = response.payload.catalogItems.find((item) => item.municipality === "Zuzgen");
  assert.ok(aarauCatalogItem);
  assert.equal(aarauCatalogItem.rating, "A");
  assert.ok(Array.isArray(aarauCatalogItem.supplementalSources));
  assert.ok(aarauCatalogItem.supplementalSources.some((source) => source.name === "eBau Aargau"));
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
    password: "HouseisGood1999?"
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

  assert.equal(auwSource.source_url, "https://gesuch.rbv-wsw.ch/");
  assert.equal(auwSource.enabled, 0);
  assert.match(auwSource.notes, /eBau-Seite/i);

  assert.equal(badenSource.source_url, "https://custom.example.org/baugesuche");
  assert.equal(badenSource.source_token, "secret-token");
  assert.equal(badenSource.include_pattern, "custom");
  assert.equal(badenSource.exclude_pattern, "menu");
  assert.equal(badenSource.enabled, 1);
  assert.equal(badenSource.notes, "Eigene Team-Konfiguration");
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
                  <a href="/aktuelles/amtliche-publikationen/einbuergerungen">
                    Einbürgerungen 95
                  </a>
                </li>
                <li>
                  <a href="/baugesuche/maerz-2026">
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
    password: "HouseisGood1999?"
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
      password: "HouseisGood1999?"
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
      password: "HouseisGood1999?"
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
      description: "Aktueller Testfall mit spaeterer Frist",
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

  // Auch eine korrekte Anmeldung bleibt waehrend der Sperre blockiert.
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

  // Vor der Einrichtung ist kein Master-Login moeglich.
  const lockedLogin = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "master", password: "irgendwas-falsches" })
  });
  assert.equal(lockedLogin.status, 401);

  // Ungueltiger Key wird abgewiesen.
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

  // Gueltiger Key + Passwort schaltet das Master-Konto frei.
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

  // Seed-Konten haben keine E-Mail; fuer den Test eine hinterlegen.
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

  // Fremder Origin auf einem aendernden Request -> blockiert.
  const blocked = await requestJson(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { Origin: "https://boeswillig.example" },
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

  // createRegistrationKey loggt das Master-Konto ein und erstellt einen Schluessel.
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
