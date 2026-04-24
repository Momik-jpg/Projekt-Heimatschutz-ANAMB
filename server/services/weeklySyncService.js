const weeklyIntervalMs = 7 * 24 * 60 * 60 * 1000;
const retryIntervalMs = 60 * 60 * 1000;
const jobName = "applications-weekly-sync";

function nowIso() {
  return new Date().toISOString();
}

function addMilliseconds(dateValue, milliseconds) {
  return new Date(new Date(dateValue).getTime() + milliseconds).toISOString();
}

export function createWeeklySyncService({
  syncJobsRepository,
  applicationsSyncService,
  enabled = process.env.AUTO_SYNC_ENABLED ? process.env.AUTO_SYNC_ENABLED !== "false" : true,
  intervalMs = Number(process.env.AUTO_SYNC_INTERVAL_HOURS ?? 168) * 60 * 60 * 1000,
  runOnStart = true,
  logger = console
}) {
  let timerId = null;
  let runningPromise = null;

  function clearScheduledTimer() {
    if (!timerId) {
      return;
    }

    clearTimeout(timerId);
    timerId = null;
  }

  function scheduleFor(nextRunAt) {
    clearScheduledTimer();

    if (!enabled || !nextRunAt) {
      return;
    }

    const delayMs = Math.max(0, new Date(nextRunAt).getTime() - Date.now());
    timerId = setTimeout(() => {
      void runDue();
    }, delayMs);
    timerId.unref?.();
  }

  function ensureJob() {
    const existing = syncJobsRepository.getByName(jobName);

    if (existing) {
      return existing;
    }

    const currentTime = nowIso();
    const nextRunAt = runOnStart ? currentTime : addMilliseconds(currentTime, intervalMs);

    return syncJobsRepository.ensure({
      name: jobName,
      sourceLabel: applicationsSyncService.getSourceLabel(),
      nextRunAt,
      updatedAt: currentTime
    });
  }

  async function runDue(force = false) {
    if (!applicationsSyncService.isConfigured()) {
      return {
        enabled,
        job: syncJobsRepository.getByName(jobName)
      };
    }

    if (!enabled && !force) {
      return {
        enabled: false,
        job: syncJobsRepository.getByName(jobName)
      };
    }

    const job = ensureJob();

    if (!force && job?.nextRunAt && new Date(job.nextRunAt).getTime() > Date.now()) {
      scheduleFor(job.nextRunAt);
      return {
        enabled: true,
        skipped: true,
        job
      };
    }

    if (runningPromise) {
      return runningPromise;
    }

    const startedAt = nowIso();
    syncJobsRepository.markRunning({
      name: jobName,
      sourceLabel: applicationsSyncService.getSourceLabel(),
      startedAt,
      nextRunAt: null
    });

    runningPromise = (async () => {
      try {
        const result = await applicationsSyncService.sync();
        const finishedAt = nowIso();
        const nextRunAt = enabled ? addMilliseconds(finishedAt, intervalMs) : null;
        const jobState = syncJobsRepository.markFinished({
          name: jobName,
          status: "success",
          sourceLabel: applicationsSyncService.getSourceLabel(),
          finishedAt,
          nextRunAt,
          lastImportedCount: result.importedCount ?? (result.imported ? 1 : 0)
        });

        if (enabled) {
          scheduleFor(nextRunAt);
        } else {
          clearScheduledTimer();
        }
        return {
          enabled,
          ...result,
          nextRunAt,
          job: jobState
        };
      } catch (error) {
        const failedAt = nowIso();
        const nextRunAt = enabled ? addMilliseconds(failedAt, Math.min(intervalMs, retryIntervalMs)) : null;
        const jobState = syncJobsRepository.markFinished({
          name: jobName,
          status: "error",
          sourceLabel: applicationsSyncService.getSourceLabel(),
          finishedAt: failedAt,
          nextRunAt,
          lastError: error.message,
          lastImportedCount: 0
        });

        if (enabled) {
          scheduleFor(nextRunAt);
        } else {
          clearScheduledTimer();
        }
        logger.error?.(error);
        throw Object.assign(error, {
          job: jobState,
          nextRunAt
        });
      } finally {
        runningPromise = null;
      }
    })();

    return runningPromise;
  }

  return {
    start() {
      if (!enabled) {
        return {
          enabled: false,
          job: null
        };
      }

      const job = ensureJob();
      scheduleFor(job.nextRunAt);

      return {
        enabled: true,
        job
      };
    },

    refreshSchedule() {
      return this.start();
    },

    stop() {
      clearScheduledTimer();
    },

    async runNow() {
      return runDue(true);
    },

    async runDue() {
      return runDue(false);
    },

    getStatus() {
      return {
        enabled,
        configured: applicationsSyncService.isConfigured(),
        sourceLabel: applicationsSyncService.getSourceLabel(),
        intervalHours: Math.round(intervalMs / (60 * 60 * 1000)),
        job: syncJobsRepository.getByName(jobName)
      };
    }
  };
}
