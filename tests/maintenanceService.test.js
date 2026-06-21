import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMaintenanceService,
  millisecondsUntilNextLocalMaintenance
} from "../server/services/maintenanceService.js";

test("plant die tägliche Wartung auf den nächsten lokalen Tageswechsel", () => {
  const now = new Date(2026, 5, 20, 23, 45, 0, 0);
  assert.equal(millisecondsUntilNextLocalMaintenance(now), 15 * 60 * 1000);
});

test("behält SQLite-Sicherungskopien nach automatischer Fallarchivierung", () => {
  const directory = mkdtempSync(join(tmpdir(), "heimatschutz-maintenance-"));
  const backupDirectory = join(directory, "backups", "legacy");
  const rootBackup = join(directory, "heimatschutz.sqlite.manual.bak");
  const nestedBackup = join(backupDirectory, "heimatschutz.sqlite.pre-migration.bak");
  mkdirSync(backupDirectory, { recursive: true });
  writeFileSync(rootBackup, "old data");
  writeFileSync(nestedBackup, "old data");

  try {
    const service = createMaintenanceService({
      dbPath: join(directory, "heimatschutz.sqlite"),
      applicationsRepository: {
        archiveExpiredApplications: () => 2
      },
      runOnStart: false,
      backupEnabled: false
    });

    const result = service.runNow();
    assert.equal(result.archivedApplications, 2);
    assert.equal(result.purgedBackups, 0);
    assert.equal(existsSync(rootBackup), true);
    assert.equal(existsSync(nestedBackup), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
