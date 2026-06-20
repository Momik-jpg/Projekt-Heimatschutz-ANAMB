import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("startet den HTTP-Server bei direktem Aufruf von server/app.js", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-startup-"));
  const output = [];
  const serverProcess = spawn(process.execPath, ["server/app.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "0",
      DATABASE_PATH: join(directory, "startup.sqlite"),
      SEED_DEMO_APPLICATIONS: "false",
      MASTER_ACCOUNT_PASSWORD: "StartupTestMaster123!",
      DEFAULT_LOGIN_PASSWORD: "StartupTestTeam123!",
      AUTO_SYNC_ENABLED: "false",
      AUTO_SYNC_RUN_ON_START: "false",
      AGIS_REFRESH_ON_START: "false",
      MAINTENANCE_ENABLED: "false",
      MIGRATION_BACKUP: "false",
      SYNC_DISABLE_DEFAULT_AMTSBLATT: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.on("data", (chunk) => output.push(String(chunk)));
  serverProcess.stderr.on("data", (chunk) => output.push(String(chunk)));

  context.after(async () => {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Serverstart nach 10 Sekunden nicht bestätigt:\n${output.join("")}`));
    }, 10000);

    serverProcess.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("Heimatschutz Aargau läuft auf Port")) return;
      clearTimeout(timeout);
      resolve();
    });

    serverProcess.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Serverprozess endete vor dem Listen-Callback (${code ?? signal}):\n${output.join("")}`));
    });
  });

  assert.equal(serverProcess.exitCode, null);
});
