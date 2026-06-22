import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";

const MASTER = { username: "master", password: "Test-Master-Pw-1!" };
const TEAM = { username: "lucia.vettori", password: "Heimat2026!" };

function startServer() {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-guards-"));
  const { app, db, stopBackgroundJobs } = createApp({
    dbPath: join(directory, "test.sqlite"),
    agisAssessmentEnabled: false,
    agisRefreshOnStart: false,
    seedDemoApplications: true,
    geocodeEnabled: false,
    autoSyncEnabled: false,
    maintenanceEnabled: false,
    maintenanceRunOnStart: false,
    loginRateLimit: false,
    masterAccountPassword: MASTER.password,
    defaultLoginPassword: TEAM.password
  });
  const server = app.listen(0);
  return { server, db, stopBackgroundJobs, directory, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function stopServer(handle) {
  return new Promise((resolve) => {
    handle.stopBackgroundJobs?.();
    handle.server.close(() => {
      try {
        handle.db.close();
      } catch {
        // schon geschlossen
      }
      rmSync(handle.directory, { recursive: true, force: true });
      resolve();
    });
  });
}

async function req(baseUrl, path, { cookie, method = "GET", body } = {}) {
  const normalizedMethod = String(method).toUpperCase();
  const originHeader = normalizedMethod === "GET" || normalizedMethod === "HEAD" ? {} : { Origin: baseUrl };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...originHeader,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function login(baseUrl, creds) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(creds)
  });
  assert.equal(response.status, 200, "Login muss gelingen");
  return response.headers.get("set-cookie").split(";")[0];
}

const ADMIN_ROUTES = [
  ["GET", "/api/admin/registration-keys"],
  ["POST", "/api/admin/registration-keys", { note: "x" }],
  ["DELETE", "/api/admin/registration-keys/KEY-x"],
  ["GET", "/api/admin/users"],
  ["PATCH", "/api/admin/users/USR-x/password", { password: "NeuesPasswort!1" }],
  ["PATCH", "/api/admin/users/USR-x/active", { active: true }],
  ["DELETE", "/api/admin/users/USR-x"],
  ["GET", "/api/admin/audit-log"],
  ["GET", "/api/admin/2fa/status"],
  ["POST", "/api/admin/2fa/setup"],
  ["POST", "/api/admin/2fa/enable", { code: "000000" }],
  ["POST", "/api/admin/2fa/disable", { code: "000000" }],
  ["GET", "/api/admin/sync-settings"],
  ["PATCH", "/api/admin/sync-settings", { sourceUrl: "" }],
  ["GET", "/api/admin/municipality-sources"],
  ["GET", "/api/admin/municipality-sources/export.json"],
  ["GET", "/api/admin/municipality-sources/export.csv"],
  ["PATCH", "/api/admin/municipality-sources/MS-x", {}],
  ["POST", "/api/admin/import-json", { jsonText: "[]" }]
];

test("Admin-Routen verlangen das Master-Konto (403 fuer Team)", async (context) => {
  const handle = startServer();
  context.after(() => stopServer(handle));
  const teamCookie = await login(handle.baseUrl, TEAM);

  for (const [method, path, body] of ADMIN_ROUTES) {
    const result = await req(handle.baseUrl, path, { cookie: teamCookie, method, body });
    assert.equal(result.status, 403, `${method} ${path} muss fuer Team 403 liefern`);
  }
});

test("Admin-Validierung und Not-Found als Master", async (context) => {
  const handle = startServer();
  context.after(() => stopServer(handle));
  const cookie = await login(handle.baseUrl, MASTER);

  // Registrierungsschluessel: unbekannt -> 404
  assert.equal(
    (await req(handle.baseUrl, "/api/admin/registration-keys/KEY-unbekannt", { cookie, method: "DELETE" })).status,
    404
  );

  // Benutzer: unbekannt -> 404
  assert.equal(
    (
      await req(handle.baseUrl, "/api/admin/users/USR-unbekannt/password", {
        cookie,
        method: "PATCH",
        body: { password: "NeuesPasswort!1" }
      })
    ).status,
    404
  );
  assert.equal(
    (
      await req(handle.baseUrl, "/api/admin/users/USR-unbekannt/active", {
        cookie,
        method: "PATCH",
        body: { active: true }
      })
    ).status,
    404
  );

  // Eigenes Master-Konto sperren -> 400 (Selbstschutz)
  const users = await req(handle.baseUrl, "/api/admin/users", { cookie });
  const master = users.payload.items.find((u) => u.username === "master");
  const team = users.payload.items.find((u) => u.username === TEAM.username);
  assert.equal(
    (
      await req(handle.baseUrl, `/api/admin/users/${master.id}/active`, {
        cookie,
        method: "PATCH",
        body: { active: false }
      })
    ).status,
    400
  );

  // active ist kein boolean -> 400
  assert.equal(
    (
      await req(handle.baseUrl, `/api/admin/users/${team.id}/active`, {
        cookie,
        method: "PATCH",
        body: { active: "nope" }
      })
    ).status,
    400
  );

  // import-json: ungueltige Payload, kaputtes JSON, keine Eintraege
  assert.equal((await req(handle.baseUrl, "/api/admin/import-json", { cookie, method: "POST", body: {} })).status, 400);
  assert.equal(
    (await req(handle.baseUrl, "/api/admin/import-json", { cookie, method: "POST", body: { jsonText: "{" } })).status,
    400
  );
  assert.equal(
    (await req(handle.baseUrl, "/api/admin/import-json", { cookie, method: "POST", body: { jsonText: "[]" } })).status,
    400
  );

  // 2FA aktivieren ohne gestartete Einrichtung -> 400; deaktivieren wenn aus -> enabled:false
  assert.equal(
    (await req(handle.baseUrl, "/api/admin/2fa/enable", { cookie, method: "POST", body: { code: "000000" } })).status,
    400
  );
  const disable = await req(handle.baseUrl, "/api/admin/2fa/disable", { cookie, method: "POST", body: { code: "000000" } });
  assert.equal(disable.status, 200);
  assert.equal(disable.payload.enabled, false);

  // sync-settings leeren -> 200
  assert.equal(
    (await req(handle.baseUrl, "/api/admin/sync-settings", { cookie, method: "PATCH", body: { sourceUrl: "" } })).status,
    200
  );

  // Gemeindequelle mit leerer Payload -> 400 (Validierung)
  assert.equal(
    (await req(handle.baseUrl, "/api/admin/municipality-sources/MS-x", { cookie, method: "PATCH", body: {} })).status,
    400
  );
});

test("Application-Routen: Not-Found und Validierung", async (context) => {
  const handle = startServer();
  context.after(() => stopServer(handle));
  const cookie = await login(handle.baseUrl, TEAM);

  const list = await req(handle.baseUrl, "/api/applications", { cookie });
  const realId = list.payload.items[0].id;

  assert.equal((await req(handle.baseUrl, "/api/applications/NOPE", { cookie })).status, 404);
  assert.equal((await req(handle.baseUrl, "/api/applications/NOPE/read", { cookie, method: "POST" })).status, 404);
  assert.equal((await req(handle.baseUrl, "/api/applications/NOPE/comments", { cookie })).status, 404);
  assert.equal(
    (await req(handle.baseUrl, "/api/applications/NOPE/comments", { cookie, method: "POST", body: { message: "hi" } })).status,
    404
  );
  // Kommentar mit leerem Text auf echtem Fall -> 400
  assert.equal(
    (await req(handle.baseUrl, `/api/applications/${realId}/comments`, { cookie, method: "POST", body: {} })).status,
    400
  );
  // PATCH: ungueltiger Status -> 400; unbekannte ID -> 404
  assert.equal(
    (await req(handle.baseUrl, `/api/applications/${realId}`, { cookie, method: "PATCH", body: { workflowStatus: "bogus" } })).status,
    400
  );
  assert.equal(
    (await req(handle.baseUrl, "/api/applications/NOPE", { cookie, method: "PATCH", body: { workflowStatus: "cleared" } })).status,
    404
  );
  // AGIS-Features ohne gueltige Koordinaten -> 400
  assert.equal((await req(handle.baseUrl, "/api/agis/features?east=abc&north=def", { cookie })).status, 400);
});

test("Auth-Routen: Validierungs- und Fehlerpfade", async (context) => {
  const handle = startServer();
  context.after(() => stopServer(handle));

  assert.equal((await req(handle.baseUrl, "/api/auth/login", { method: "POST", body: {} })).status, 400);
  assert.equal(
    (await req(handle.baseUrl, "/api/auth/login", { method: "POST", body: { username: "x", password: "y" } })).status,
    401
  );
  assert.equal((await req(handle.baseUrl, "/api/auth/register", { method: "POST", body: {} })).status, 400);
  assert.equal((await req(handle.baseUrl, "/api/auth/forgot-password", { method: "POST", body: {} })).status, 400);
  assert.equal((await req(handle.baseUrl, "/api/auth/master-setup", { method: "POST", body: {} })).status, 400);
  assert.equal(
    (await req(handle.baseUrl, "/api/auth/reset-password", { method: "POST", body: { password: "NeuesPasswort!1" } })).status,
    400
  );

  const config = await req(handle.baseUrl, "/api/auth/config");
  assert.equal(config.status, 200);
  assert.equal(config.payload.turnstile.enabled, false);

  assert.equal((await req(handle.baseUrl, "/api/auth/master-setup-status")).status, 200);
});
