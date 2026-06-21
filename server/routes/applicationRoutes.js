// Fach-Routen (angemeldet): Dashboard, Arbeitsliste/Detail, Gelesen-Status,
// Kommentare, Statuswechsel und AGIS-Geometrien. Aus server/app.js ausgelagert;
// Handler unveraendert, Zustand via context.
import { randomBytes } from "node:crypto";
import { nowIso, validateApplicationPatch, validateCommentPayload } from "../httpSupport.js";
import { protectionStatuses, workflowStatuses } from "../repository/applicationsRepository.js";

export function registerApplicationRoutes(app, context) {
  const {
    repository,
    applicationReadsRepository,
    commentsRepository,
    applicationLearningRepository,
    municipalitySourcesRepository,
    importNotificationsRepository,
    weeklySyncService,
    agisGeometryService
  } = context;

  app.get("/api/dashboard", (_request, response) => {
    response.json({
      ...repository.getDashboard(),
      municipalitySourcesSummary: municipalitySourcesRepository.getSummary(),
      learningSummary: applicationLearningRepository.getSummary(),
      notifications: importNotificationsRepository.listRecent(),
      syncStatus: weeklySyncService.getStatus(),
      protectionStatuses,
      workflowStatuses
    });
  });

  app.get("/api/applications", (request, response) => {
    const filters = {
      search: request.query.search ?? "",
      municipality: request.query.municipality ?? "",
      protectionStatus: request.query.protectionStatus ?? "",
      workflowStatus: request.query.workflowStatus ?? "",
      source: request.query.source ?? ""
    };

    const readApplicationIds = applicationReadsRepository.listApplicationIds(request.currentUser.id);
    const items = repository.list(filters).map((item) => ({
      ...item,
      isRead: readApplicationIds.has(item.id)
    }));
    response.json({
      items,
      total: items.length
    });
  });

  app.get("/api/applications/:id", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json({
      ...item,
      ...applicationReadsRepository.get(item.id, request.currentUser.id)
    });
  });

  app.post("/api/applications/:id/read", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json(
      applicationReadsRepository.markRead(item.id, request.currentUser.id, nowIso())
    );
  });

  app.get("/api/applications/:id/comments", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    response.json({
      items: commentsRepository.listByApplication(request.params.id)
    });
  });

  app.post("/api/applications/:id/comments", (request, response) => {
    const item = repository.getById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    const validation = validateCommentPayload(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const created = commentsRepository.create({
      id: `COM-${randomBytes(8).toString("hex")}`,
      applicationId: request.params.id,
      userId: request.currentUser.id,
      message: validation.value.message,
      createdAt: nowIso()
    });

    response.status(201).json(created);
  });

  app.patch("/api/applications/:id", (request, response) => {
    const validation = validateApplicationPatch(request.body ?? {});

    if (validation.error) {
      response.status(400).json({ error: validation.error });
      return;
    }

    const updated = repository.update(request.params.id, validation.value);

    if (!updated) {
      response.status(404).json({ error: "Application not found" });
      return;
    }

    if (validation.value.learnFromDecision || ["cleared", "archived"].includes(updated.workflowStatus)) {
      applicationLearningRepository.recordFromApplication(updated, {
        userId: request.currentUser?.id ?? "",
        force: Boolean(validation.value.learnFromDecision)
      });
    }

    response.json(updated);
  });

  app.get("/api/agis/features", async (request, response) => {
    const east = Number(request.query.east);
    const north = Number(request.query.north);

    if (!Number.isFinite(east) || !Number.isFinite(north)) {
      response.status(400).json({
        error: "east and north query parameters must be valid numbers"
      });
      return;
    }

    try {
      const payload = await agisGeometryService.getOfficialFeatures({ east, north });
      response.json(payload);
    } catch (error) {
      console.error(error);
      response.status(502).json({
        error: "AGIS-Geometrien konnten im Moment nicht geladen werden."
      });
    }
  });
}
