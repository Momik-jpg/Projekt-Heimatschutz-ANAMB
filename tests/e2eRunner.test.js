import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { findAvailablePort, waitForExpectedServer } from "./e2e/runnerSupport.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createChildDouble() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("findAvailablePort liefert einen lokal bindbaren Port", async () => {
  const port = await findAvailablePort();
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  await close(server);
});

test("waitForExpectedServer akzeptiert nur die erwartete Instanz", async () => {
  const instanceId = "expected-instance";
  const server = createServer((_request, response) => {
    response.setHeader("x-e2e-instance-id", instanceId);
    response.end("ok");
  });
  const serverUrl = await listen(server);

  try {
    await assert.doesNotReject(() =>
      waitForExpectedServer({ child: createChildDouble(), serverUrl, instanceId, timeoutMs: 500 })
    );
  } finally {
    await close(server);
  }
});

test("waitForExpectedServer ignoriert eine alte Instanz und meldet Child-Exit", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("x-e2e-instance-id", "stale-instance");
    response.end("ok");
  });
  const serverUrl = await listen(server);
  const child = createChildDouble();

  try {
    const waiting = waitForExpectedServer({
      child,
      serverUrl,
      instanceId: "expected-instance",
      timeoutMs: 1000
    });
    setImmediate(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    });
    await assert.rejects(waiting, /E2E-Serverprozess.*Code 1/);
  } finally {
    await close(server);
  }
});

test("waitForExpectedServer lässt eine hängende Health-Probe nicht das Gesamttimeout aushebeln", async () => {
  const waiting = waitForExpectedServer({
    child: createChildDouble(),
    serverUrl: "http://127.0.0.1:1",
    instanceId: "expected-instance",
    timeoutMs: 30,
    pollIntervalMs: 5,
    probeTimeoutMs: 5,
    fetchImpl: () => new Promise(() => {})
  });
  const guarded = Promise.race([
    waiting,
    delay(150).then(() => {
      throw new Error("Health-Probe blieb hängen.");
    })
  ]);

  await assert.rejects(guarded, /nicht innert 30ms/);
});
