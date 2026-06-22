import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { E2E_WEB_SERVER_ENV } from "../../playwright.config.js";
import { findAvailablePort, waitForExpectedServer } from "./runnerSupport.mjs";

const isWindows = process.platform === "win32";

function pipePrefixed(stream, prefix) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line) {
        console.error(`${prefix} ${line}`);
      }
    }
  });
}

async function waitForChild(child) {
  const result = await Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    once(child, "error").then(([error]) => {
      throw error;
    })
  ]);
  const { code, signal } = result;
  return { code, signal };
}

function runNodeChild(args, options) {
  return waitForChild(spawn(process.execPath, args, options));
}

function forceKillWindowsProcess(pid) {
  return waitForChild(spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }));
}

async function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  if (isWindows) {
    child.kill();
    const exited = once(child, "exit").then(() => true);
    const timedOut = delay(5000).then(() => false);
    if (!(await Promise.race([exited, timedOut]))) {
      await forceKillWindowsProcess(child.pid).catch(() => {});
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }

  const exited = once(child, "exit").then(() => true);
  const timedOut = delay(5000).then(() => false);
  if (!(await Promise.race([exited, timedOut]))) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Prozess ist bereits weg.
    }
  }
}

const port = await findAvailablePort();
const instanceId = randomUUID();
const serverUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/app.js"], {
  cwd: process.cwd(),
  detached: !isWindows,
  env: {
    ...process.env,
    ...E2E_WEB_SERVER_ENV,
    PORT: String(port),
    E2E_INSTANCE_ID: instanceId
  },
  stdio: ["ignore", "pipe", "pipe"]
});

pipePrefixed(server.stdout, "[E2E server]");
pipePrefixed(server.stderr, "[E2E server]");

try {
  await waitForExpectedServer({ child: server, serverUrl, instanceId });
  const result = await runNodeChild(["node_modules/playwright/cli.js", "test"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLAYWRIGHT_SKIP_WEB_SERVER: "true",
      E2E_PORT: String(port),
      E2E_INSTANCE_ID: instanceId
    },
    stdio: "inherit"
  });

  if (result.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.code ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopProcessTree(server);
}
