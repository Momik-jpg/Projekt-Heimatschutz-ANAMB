export function createGracefulShutdown({
  server,
  stopBackgroundJobs,
  closeDatabase,
  exitProcess = process.exit,
  scheduleForce = setTimeout,
  cancelForce = clearTimeout,
  reportError = console.error,
  gracePeriodMs = 10000
}) {
  let shuttingDown = false;
  let finished = false;
  let forceTimer;

  const finish = (requestedExitCode) => {
    if (finished) return;
    finished = true;

    if (forceTimer) {
      cancelForce(forceTimer);
      forceTimer = undefined;
    }

    let exitCode = requestedExitCode;
    try {
      closeDatabase();
    } catch (error) {
      reportError(error);
      exitCode = 1;
    }
    exitProcess(exitCode);
  };

  return function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      stopBackgroundJobs();
    } catch (error) {
      reportError(error);
    }

    forceTimer = scheduleForce(() => {
      forceTimer = undefined;
      try {
        server.closeAllConnections?.();
      } catch (error) {
        reportError(error);
      }
      finish(1);
    }, gracePeriodMs);
    forceTimer?.unref?.();

    try {
      server.close((error) => {
        if (error) reportError(error);
        finish(error ? 1 : 0);
      });
      server.closeIdleConnections?.();
    } catch (error) {
      reportError(error);
      finish(1);
    }
  };
}
