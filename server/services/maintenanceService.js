import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function millisecondsUntilNextLocalMaintenance(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, next.getTime() - now.getTime());
}

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
  intervalMs = null,
  runOnStart = true,
  backupEnabled = false,
  backupDir = "",
  backupRetention = 7,
  auditRetentionDays = 365,
  logger = console,
  nowProvider = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let timerId = null;
  let lastCleanup = { removedApplications: 0, purgedBackups: 0 };

  function purgeDatabaseBackups() {
    if (!dbPath || dbPath === ":memory:") return 0;
    const root = resolve(dirname(dbPath));
    const prefix = `${basename(dbPath)}.`;
    const directories = [root];
    let removed = 0;

    while (directories.length) {
      const directory = directories.pop();
      let entries = [];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const target = join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          directories.push(target);
        } else if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".bak")) {
          try {
            rmSync(target, { force: true });
            removed += 1;
          } catch {
            logger.warn?.(`SQLite-Backup konnte nicht gelöscht werden: ${target}`);
          }
        }
      }
    }
    return removed;
  }

  function runCleanup() {
    const referenceDate = nowProvider();
    const now = referenceDate.toISOString();
    let removed = 0;

    sessionsRepository?.deleteExpired?.(now);
    removed += registrationKeysRepository?.deleteStale?.(now) ?? 0;
    removed += masterSetupKeysRepository?.deleteStale?.(now) ?? 0;
    removed += passwordResetKeysRepository?.deleteStale?.(now) ?? 0;
    const removedApplications = applicationsRepository?.pruneExpiredApplications?.({ referenceDate }) ?? 0;
    removed += removedApplications;
    const purgedBackups = removedApplications > 0 ? purgeDatabaseBackups() : 0;
    lastCleanup = { removedApplications, purgedBackups };

    if (auditRetentionDays > 0 && auditLogRepository?.deleteOlderThan) {
      const cutoff = new Date(referenceDate.getTime() - auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
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
    return { removed, backup, ...lastCleanup };
  }

  function scheduleNext() {
    const configuredInterval = Number(intervalMs);
    const delay = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? configuredInterval
      : millisecondsUntilNextLocalMaintenance(nowProvider());
    timerId = setTimeoutFn(() => {
      try {
        runNow();
      } catch (error) {
        logger.warn?.(`Wartung fehlgeschlagen: ${error.message}`);
      } finally {
        scheduleNext();
      }
    }, delay);
    timerId?.unref?.();
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

      scheduleNext();
    },

    stop() {
      if (timerId) {
        clearTimeoutFn(timerId);
        timerId = null;
      }
    },

    runNow,
    runCleanup,
    runBackup,
    purgeDatabaseBackups
  };
}
