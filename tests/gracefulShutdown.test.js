import test from "node:test";
import assert from "node:assert/strict";
import { createGracefulShutdown } from "../server/gracefulShutdown.js";

function createHarness({ databaseCloseThrows = false } = {}) {
  const events = [];
  let closeCallback;
  let forceCallback;
  const timer = { unref: () => events.push("timer.unref") };
  const server = {
    close(callback) {
      events.push("server.close");
      closeCallback = callback;
    },
    closeIdleConnections() {
      events.push("server.closeIdleConnections");
    },
    closeAllConnections() {
      events.push("server.closeAllConnections");
    }
  };

  const shutdown = createGracefulShutdown({
    server,
    stopBackgroundJobs: () => events.push("jobs.stop"),
    closeDatabase: () => {
      events.push("database.close");
      if (databaseCloseThrows) throw new Error("database close failed");
    },
    exitProcess: (code) => events.push(`process.exit:${code}`),
    scheduleForce: (callback, timeoutMs) => {
      events.push(`timer.schedule:${timeoutMs}`);
      forceCallback = callback;
      return timer;
    },
    cancelForce: (scheduledTimer) => {
      assert.equal(scheduledTimer, timer);
      events.push("timer.cancel");
    },
    reportError: (error) => events.push(`error:${error.message}`),
    gracePeriodMs: 5000
  });

  return {
    events,
    shutdown,
    completeServerClose: (error) => closeCallback(error),
    force: () => forceCallback()
  };
}

test("graceful shutdown stoppt neue Verbindungen und lässt laufende Requests auslaufen", () => {
  const harness = createHarness();

  harness.shutdown();

  assert.ok(harness.events.indexOf("server.close") < harness.events.indexOf("server.closeIdleConnections"));
  assert.equal(harness.events.includes("server.closeAllConnections"), false);

  harness.completeServerClose();
  assert.deepEqual(harness.events.slice(-3), ["timer.cancel", "database.close", "process.exit:0"]);
  assert.equal(harness.events.filter((event) => event === "database.close").length, 1);
});

test("graceful shutdown beendet aktive Verbindungen erst nach dem Timeout hart", () => {
  const harness = createHarness();

  harness.shutdown();
  harness.force();

  assert.ok(harness.events.indexOf("server.close") < harness.events.indexOf("server.closeAllConnections"));
  assert.deepEqual(harness.events.slice(-3), ["server.closeAllConnections", "database.close", "process.exit:1"]);

  harness.completeServerClose();
  harness.shutdown();
  assert.equal(harness.events.filter((event) => event === "database.close").length, 1);
  assert.equal(harness.events.filter((event) => event === "server.close").length, 1);
});

test("graceful shutdown meldet Fehler beim Datenbank-Schliessen und beendet fehlerhaft", () => {
  const harness = createHarness({ databaseCloseThrows: true });

  harness.shutdown();
  harness.completeServerClose();

  assert.deepEqual(harness.events.slice(-3), ["database.close", "error:database close failed", "process.exit:1"]);
});
