import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";

// S4: 2FA-Code-Verifikation (enable/disable) muss rate-limitiert sein, damit eine
// gestohlene Master-Sitzung keinen unbegrenzten Online-Bruteforce erlaubt.

const MASTER_PW = "Test-Master-Pw-1!";

function boot() {
  const directory = mkdtempSync(join(tmpdir(), "hsa-2fa-"));
  const { app, db, ready, stopBackgroundJobs } = createApp({
    dbPath: join(directory, "test.sqlite"),
    seedDemoApplications: false,
    agisAssessmentEnabled: false,
    agisRefreshOnStart: false,
    autoSyncEnabled: false,
    autoSyncRunOnStart: false,
    maintenanceEnabled: false,
    maintenanceRunOnStart: false,
    masterAccountPassword: MASTER_PW,
    defaultLoginPassword: "Heimat2026!",
    loginRateLimit: { maxAttempts: 3, lockoutMs: 60000 }
  });
  const server = app.listen(0);
  return { server, db, ready, stopBackgroundJobs, directory, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function post(baseUrl, path, body, cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {})
  });
}

test("2FA-enable ist rate-limitiert (kein unbegrenzter Code-Bruteforce)", async () => {
  const ctx = boot();
  try {
    await ctx.ready;

    const loginRes = await post(ctx.baseUrl, "/api/auth/login", { username: "master", password: MASTER_PW });
    assert.equal(loginRes.status, 200, "Master-Login muss gelingen");
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    const setup = await post(ctx.baseUrl, "/api/admin/2fa/setup", {}, cookie);
    assert.equal(setup.status, 200, "2FA-Setup muss starten");

    let got429 = false;
    for (let i = 0; i < 8; i++) {
      const res = await post(ctx.baseUrl, "/api/admin/2fa/enable", { code: "000000" }, cookie);
      if (res.status === 429) {
        got429 = true;
        break;
      }
      assert.equal(res.status, 400, "ungueltiger Code vor dem Limit -> 400");
    }

    assert.ok(got429, "nach mehreren Fehlversuchen muss 429 (Rate-Limit) kommen");
  } finally {
    ctx.stopBackgroundJobs?.();
    await new Promise((resolve) => ctx.server.close(resolve));
    try {
      ctx.db?.close?.();
    } catch {
      /* best effort */
    }
    try {
      rmSync(ctx.directory, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
