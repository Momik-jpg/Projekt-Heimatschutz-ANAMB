import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";

// S5: Der Sync-Quell-Token darf nie an den Client zurueckgegeben werden.

const MASTER_PW = "Test-Master-Pw-1!";
const SECRET = "super-secret-token-xyz-123";

function boot() {
  const directory = mkdtempSync(join(tmpdir(), "hsa-tok-"));
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
    syncSourceUrl: "https://www.ag.ch/feed.json",
    syncSourceToken: SECRET
  });
  const server = app.listen(0);
  return { server, db, ready, stopBackgroundJobs, directory, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("GET /api/admin/sync-settings gibt den Token nicht zurueck (nur sourceTokenSet)", async () => {
  const ctx = boot();
  try {
    await ctx.ready;

    const loginRes = await fetch(`${ctx.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ctx.baseUrl },
      body: JSON.stringify({ username: "master", password: MASTER_PW })
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    const res = await fetch(`${ctx.baseUrl}/api/admin/sync-settings`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const payload = JSON.parse(raw);

    assert.equal(payload.sourceTokenSet, true, "sourceTokenSet muss true sein, wenn ein Token gesetzt ist");
    assert.ok(!("sourceToken" in payload), "die Antwort darf kein sourceToken-Feld enthalten");
    assert.ok(!raw.includes(SECRET), "der Token-Klartext darf nirgends im Body auftauchen");
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
