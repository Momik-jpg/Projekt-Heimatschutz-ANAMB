import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Hintergrund-Wartung: räumt abgelaufene Sessions/Schlüssel und alte
// Audit-Einträge auf und legt (optional) regelmässige SQLite-Backups an.
export function createMaintenanceService({
  db,
  dbPath,
  sessionsRepository,
  registrationKeysRepository,
  masterSetupKeysRepository,
  passwordResetKeysRepository,
  auditLogRepository,
  applicationsRepository,
  enabled = true,
  intervalMs = 24 * 60 * 60 * 1000,
  runOnStart = true,
  backupEnabled = false,
  backupDir = "",
  backupRetention = 7,
  auditRetentionDays = 365,
  logger = console
} = {}) {
  let timerId = null;

  function runCleanup() {
    const now = new Date().toISOString();
    let removed = 0;

    sessionsRepository?.deleteExpired?.(now);
    removed += registrationKeysRepository?.deleteStale?.(now) ?? 0;
    removed += masterSetupKeysRepository?.deleteStale?.(now) ?? 0;
    removed += passwordResetKeysRepository?.deleteStale?.(now) ?? 0;
    removed += applicationsRepository?.pruneExpiredApplications?.({ referenceDate: new Date() }) ?? 0;

    if (auditRetentionDays > 0 && auditLogRepository?.deleteOlderThan) {
      const cutoff = new Date(Date.now() - auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
      auditLogRepository.deleteOlderThan(cutoff);
    }

    return removed;
  }

  function pruneOldBackups(dir) {
    const prefix = `${basename(dbPath)}.`;
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
      .map((name) => ({ name, modifiedAt: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    for (const { name } of backups.slice(backupRetention)) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // Ein nicht löschbares Altbackup darf die Wartung nicht stoppen.
      }
    }
  }

  function runBackup() {
    if (!backupEnabled || !dbPath || dbPath === ":memory:") {
      return null;
    }

    try {
      // WAL in die Haupt-DB schreiben, damit die kopierte Datei konsistent ist.
      try {
        db?.exec?.("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Checkpoint ist best effort.
      }

      const directory = backupDir || join(dirname(dbPath), "backups");
      mkdirSync(directory, { recursive: true });

      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const target = join(directory, `${basename(dbPath)}.${stamp}.bak`);
      copyFileSync(dbPath, target);
      pruneOldBackups(directory);
      logger.log?.(`SQLite-Backup erstellt: ${target}`);
      return target;
    } catch (error) {
      logger.warn?.(`SQLite-Backup fehlgeschlagen: ${error.message}`);
      return null;
    }
  }

  function runNow() {
    const removed = runCleanup();
    const backup = runBackup();
    return { removed, backup };
  }

  return {
    start() {
      if (!enabled) {
        return;
      }

      if (runOnStart) {
        try {
          runNow();
        } catch (error) {
          logger.warn?.(`Wartung beim Start fehlgeschlagen: ${error.message}`);
        }
      }

      timerId = setInterval(() => {
        try {
          runNow();
        } catch (error) {
          logger.warn?.(`Wartung fehlgeschlagen: ${error.message}`);
        }
      }, intervalMs);
      timerId.unref?.();
    },

    stop() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    },

    runNow,
    runCleanup,
    runBackup
  };
}
