import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { E2E_PORT, E2E_WEB_SERVER_ENV } from "../../playwright.config.js";

const serverUrl = `http://127.0.0.1:${E2E_PORT}`;
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

async function waitForServer(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server ist noch nicht bereit.
    }
    await delay(250);
  }
  throw new Error(`E2E-Server wurde nicht innert ${timeoutMs}ms bereit.`);
}

async function runChild(command, args, options) {
  const child = spawn(command, args, options);
  const result = await Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    once(child, "error").then(([error]) => {
      throw error;
    })
  ]);
  const { code, signal } = result;
  return { code, signal };
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
      await runChild("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).catch(() => {});
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

const server = spawn(process.execPath, ["server/app.js"], {
  cwd: process.cwd(),
  detached: !isWindows,
  env: {
    ...process.env,
    ...E2E_WEB_SERVER_ENV
  },
  stdio: ["ignore", "pipe", "pipe"]
});

pipePrefixed(server.stdout, "[E2E server]");
pipePrefixed(server.stderr, "[E2E server]");

try {
  await waitForServer();
  const result = await runChild(process.execPath, ["node_modules/playwright/cli.js", "test"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLAYWRIGHT_SKIP_WEB_SERVER: "true"
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
