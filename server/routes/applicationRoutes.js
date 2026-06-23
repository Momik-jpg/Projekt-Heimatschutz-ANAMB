// Fach-Routen (angemeldet): Dashboard, Arbeitsliste/Detail, Gelesen-Status,
// Kommentare, Statuswechsel und AGIS-Geometrien. Aus server/app.js ausgelagert;
// Handler unveraendert, Zustand via context.
import { randomBytes } from "node:crypto";
import { nowIso, validateApplicationPatch, validateCommentPayload } from "../httpSupport.js";
import { protectionStatuses, workflowStatuses } from "../repository/applicationsRepository.js";
import { SOURCE_KIND_MUNICIPALITY, sourceKindOf } from "../domain/sourceReconciliation.js";

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value ?? "").trim());
}

function isPdfUrl(value) {
  return /\.pdf(?:$|[?#])/i.test(String(value ?? "").trim());
}

function sourceContainerUrl(value) {
  const url = String(value ?? "").trim();
  if (!isHttpUrl(url) || !isPdfUrl(url)) return url;

  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    const pathParts = parsed.pathname.split("/");
    pathParts.pop();
    parsed.pathname = pathParts.join("/") || "/";
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed.toString();
  } catch {
    return url.replace(/\/[^/?#]+\.pdf(?:[?#].*)?$/i, "/");
  }
}

function preferredSourcePageUrl(...values) {
  for (const value of values) {
    const sourcePageUrl = sourceContainerUrl(value);
    if (isHttpUrl(sourcePageUrl)) return sourcePageUrl;
  }

  return "";
}

function sourceLinkLabel(_url, sourceName = "") {
  if (/amtsblatt/i.test(sourceName)) return "Amtsblatt öffnen";
  return "Gemeindequelle öffnen";
}

function sourceLinkPayload(url, sourceName, fallbackName = "Gemeindequelle") {
  const sourcePageUrl = sourceContainerUrl(url);
  if (!isHttpUrl(sourcePageUrl)) return null;

  return {
    municipalitySourceUrl: sourcePageUrl,
    municipalitySourceName: sourceName || fallbackName,
    municipalitySourceLabel: sourceLinkLabel(sourcePageUrl, sourceName)
  };
}

function buildMunicipalitySourceLink(item, municipalitySourcesRepository) {
  const catalogItem = municipalitySourcesRepository.getCatalogItemByMunicipality(item.municipality);
  const catalogUrl = preferredSourcePageUrl(
    catalogItem?.primaryDirectUrl,
    catalogItem?.primarySourceCanonicalUrl,
    catalogItem?.officialWebsite
  );

  const municipalityEvidence = (item.sourceEvidence ?? []).find(
    (entry) => entry.sourceKind === SOURCE_KIND_MUNICIPALITY && isHttpUrl(entry.sourceUrl)
  );

  if (municipalityEvidence) {
    const payload = sourceLinkPayload(
      municipalityEvidence.sourceUrl,
      municipalityEvidence.sourceName,
      "Gemeindequelle"
    );
    if (payload) return payload;
  }

  if (sourceKindOf(item.source) === SOURCE_KIND_MUNICIPALITY && isHttpUrl(item.sourceUrl)) {
    const payload = sourceLinkPayload(item.sourceUrl, item.source, "Gemeindequelle");
    if (payload) return payload;
  }

  if (catalogUrl) {
    return {
      municipalitySourceUrl: catalogUrl,
      municipalitySourceName: catalogItem.primarySourceName || `${item.municipality} Gemeindequelle`,
      municipalitySourceLabel: sourceLinkLabel(catalogUrl, catalogItem.primarySourceName)
    };
  }

  if (isHttpUrl(item.sourceUrl)) {
    const payload = sourceLinkPayload(item.sourceUrl, item.source, "Originalquelle");
    if (payload) return payload;
  }

  return {
    municipalitySourceUrl: "",
    municipalitySourceName: "",
    municipalitySourceLabel: "Gemeindequelle öffnen"
  };
}

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
      ...buildMunicipalitySourceLink(item, municipalitySourcesRepository),
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
