import test from "node:test";
import assert from "node:assert/strict";
import { createMaintenanceService } from "../server/services/maintenanceService.js";

test("runCleanup summiert Entfernungen und ruft Audit-Bereinigung", () => {
  let sessionsCalled = false;
  let auditCalled = false;
  const service = createMaintenanceService({
    dbPath: ":memory:",
    sessionsRepository: {
      deleteExpired: () => {
        sessionsCalled = true;
      }
    },
    registrationKeysRepository: { deleteStale: () => 1 },
    masterSetupKeysRepository: { deleteStale: () => 2 },
    passwordResetKeysRepository: { deleteStale: () => 0 },
    applicationsRepository: { pruneExpiredApplications: () => 3 },
    auditLogRepository: {
      deleteOlderThan: () => {
        auditCalled = true;
        return 5;
      }
    },
    auditRetentionDays: 30,
    runOnStart: false,
    backupEnabled: false
  });

  assert.equal(service.runCleanup(), 6, "1 + 2 + 0 + 3 entfernte Eintraege");
  assert.equal(sessionsCalled, true);
  assert.equal(auditCalled, true);
});

test("runCleanup ohne Audit-Retention laesst deleteOlderThan aus", () => {
  let auditCalled = false;
  const service = createMaintenanceService({
    dbPath: ":memory:",
    applicationsRepository: { pruneExpiredApplications: () => 0 },
    auditLogRepository: {
      deleteOlderThan: () => {
        auditCalled = true;
      }
    },
    auditRetentionDays: 0,
    runOnStart: false,
    backupEnabled: false
  });
  service.runCleanup();
  assert.equal(auditCalled, false);
});

test("start: deaktiviert -> kein Timer; aktiv -> runOnStart + scheduleNext + stop", () => {
  let scheduled = 0;
  let cleared = 0;
  let ran = 0;
  const base = {
    dbPath: ":memory:",
    applicationsRepository: {
      pruneExpiredApplications: () => {
        ran += 1;
        return 0;
      }
    },
    backupEnabled: false,
    setTimeoutFn: () => {
      scheduled += 1;
      return 123;
    },
    clearTimeoutFn: () => {
      cleared += 1;
    }
  };

  const disabled = createMaintenanceService({ ...base, enabled: false });
  disabled.start();
  assert.equal(scheduled, 0, "deaktiviert -> kein scheduleNext");

  const active = createMaintenanceService({ ...base, enabled: true, runOnStart: true });
  active.start();
  assert.ok(ran >= 1, "runOnStart fuehrt Cleanup aus");
  assert.equal(scheduled, 1, "scheduleNext setzt einen Timer");
  active.stop();
  assert.equal(cleared, 1, "stop raeumt den Timer");
});
