// Sync-Routen (angemeldet): Status der woechentlichen Automatik und manueller
// Sofort-Sync. Aus server/app.js ausgelagert; Handler unveraendert, Zustand via context.
export function registerSyncRoutes(app, context) {
  const { applicationsSyncService, weeklySyncService } = context;

  app.get("/api/sync/status", (_request, response) => {
    response.json(weeklySyncService.getStatus());
  });

  app.post("/api/sync", async (_request, response) => {
    const apiConfigured = applicationsSyncService.isConfigured();
    const result = apiConfigured
      ? await weeklySyncService.runNow()
      : await applicationsSyncService.sync();

    response.json({
      ...result,
      message: apiConfigured
        ? `API-Sync abgeschlossen. ${result.importedCount ?? 0} neu, ${result.updatedCount ?? 0} aktualisiert.`
        : result.imported
          ? "Ein neues Amtsblatt-Gesuch wurde in die Datenbank übernommen."
          : "Keine weiteren Demo-Gesuche zum Import vorhanden."
    });
  });
}
