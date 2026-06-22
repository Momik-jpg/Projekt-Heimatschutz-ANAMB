import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function findAvailablePort(host = "127.0.0.1") {
  const reservation = createServer();

  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, host, resolve);
  });

  const { port } = reservation.address();
  await new Promise((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function childTermination(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ type: "exit", code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ type: "exit", code, signal }));
    child.once("error", (error) => resolve({ type: "error", error }));
  });
}

function describeTermination(result) {
  if (result.type === "error") {
    return `E2E-Serverprozess konnte nicht gestartet werden: ${result.error.message}`;
  }
  if (result.signal) {
    return `E2E-Serverprozess wurde mit Signal ${result.signal} beendet.`;
  }
  return `E2E-Serverprozess wurde mit Code ${result.code ?? "unbekannt"} beendet.`;
}

export async function waitForExpectedServer({
  child,
  serverUrl,
  instanceId,
  timeoutMs = 30000,
  fetchImpl = fetch,
  pollIntervalMs = 100,
  probeTimeoutMs = 1000
}) {
  const terminated = childTermination(child);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probeController = new AbortController();
    const probe = fetchImpl(`${serverUrl}/health`, { signal: probeController.signal })
      .then((response) => ({
        type: "probe",
        matches: response.ok && response.headers.get("x-e2e-instance-id") === instanceId
      }))
      .catch(() => ({ type: "probe", matches: false }));
    let probeTimer;
    const probeTimedOut = new Promise((resolve) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      probeTimer = setTimeout(() => {
        probeController.abort();
        resolve({ type: "probe", matches: false });
      }, Math.min(probeTimeoutMs, remainingMs));
    });
    const result = await Promise.race([probe, probeTimedOut, terminated]);
    clearTimeout(probeTimer);
    probeController.abort();

    if (result.type !== "probe") {
      throw new Error(describeTermination(result));
    }
    if (result.matches) {
      return;
    }

    const afterDelay = await Promise.race([
      delay(pollIntervalMs).then(() => ({ type: "delay" })),
      terminated
    ]);
    if (afterDelay.type !== "delay") {
      throw new Error(describeTermination(afterDelay));
    }
  }

  throw new Error(`E2E-Server wurde nicht innert ${timeoutMs}ms als erwartete Instanz bereit.`);
}
