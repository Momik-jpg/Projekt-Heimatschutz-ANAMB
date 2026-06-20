import {
  defaultSyncRequestTimeoutMs,
  defaultMunicipalitySourceConcurrency,
  normalizeImportedPayload,
  mapWithConcurrency,
  looksLikeJsonSourceUrl,
  extractPdfTextFromBuffer,
  geocodeMunicipalityAddressWithPrecision,
  geocodeMunicipalityParcel,
  refineImportedItems,
  buildSourceLabel,
  normalizeSourceType,
  buildAmtsblattResultUrl,
  parseAmtsblattEntries,
  buildAmtsblattItemFromEntry,
  fetchNormalizedItemsFromSource,
  assessImportedItems,
  mergeSyncResults
} from "./applicationsSyncParsing.js";

// Weiterhin aus applicationsSyncService.js erreichbar (app.js, Tests).
export {
  normalizeImportedPayload,
  geocodeMunicipalityAddressWithPrecision,
  geocodeMunicipalityParcel,
  buildAmtsblattResultUrl,
  parseAmtsblattEntries,
  buildAmtsblattItemFromEntry
};

export function createApplicationsSyncService({
  repository,
  sourceUrl = process.env.SYNC_SOURCE_URL ?? "",
  getSourceUrl = null,
  sourceToken = process.env.SYNC_SOURCE_TOKEN ?? "",
  getSourceToken = null,
  sourceType = process.env.SYNC_SOURCE_TYPE ?? "",
  getSourceType = null,
  sourceMunicipality = process.env.SYNC_SOURCE_MUNICIPALITY ?? "",
  getSourceMunicipality = null,
  getMunicipalitySources = null,
  fetchImpl = fetch,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer,
  assessApplication = null,
  notifyImportChanges = null,
  requestTimeoutMs = defaultSyncRequestTimeoutMs,
  municipalitySourceConcurrency = defaultMunicipalitySourceConcurrency
}) {
  const normalizedSourceUrl = String(sourceUrl ?? "").trim();
  const normalizedSourceToken = String(sourceToken ?? "").trim();
  const normalizedSourceType = String(sourceType ?? "").trim().toLowerCase();
  const normalizedSourceMunicipality = String(sourceMunicipality ?? "").trim();

  function resolveSourceUrl() {
    const dynamicSourceUrl = typeof getSourceUrl === "function" ? String(getSourceUrl() ?? "").trim() : "";
    return dynamicSourceUrl || normalizedSourceUrl;
  }

  function resolveSourceToken() {
    const dynamicSourceToken =
      typeof getSourceToken === "function" ? String(getSourceToken() ?? "").trim() : "";
    return dynamicSourceToken || normalizedSourceToken;
  }

  function resolveSourceType() {
    const dynamicSourceType =
      typeof getSourceType === "function" ? String(getSourceType() ?? "").trim().toLowerCase() : "";
    return dynamicSourceType || normalizedSourceType;
  }

  function resolveSourceMunicipality() {
    const dynamicSourceMunicipality =
      typeof getSourceMunicipality === "function" ? String(getSourceMunicipality() ?? "").trim() : "";
    return dynamicSourceMunicipality || normalizedSourceMunicipality;
  }

  function buildImportSourceName(normalizedSourceType, municipalityScoped = false) {
    if (normalizedSourceType === "amtsblatt") {
      return "Amtsblatt Aargau";
    }

    if (normalizedSourceType === "html") {
      return "Gemeinde-Webseite";
    }

    if (normalizedSourceType === "xml") {
      return "Gemeinde-Feed";
    }

    if (normalizedSourceType === "pdf") {
      return "Gemeinde-PDF";
    }

    if (normalizedSourceType === "arcgis") {
      return municipalityScoped ? "Gemeinde-Import" : "AGIS";
    }

    return municipalityScoped ? "Gemeinde-Import" : "API";
  }

  function resolveGlobalSourceType() {
    const sourceUrl = resolveSourceUrl();
    const explicitSourceType = resolveSourceType();
    const autoDetectedSourceType = normalizeSourceType({ sourceUrl });
    const sourceMunicipality = resolveSourceMunicipality();

    if (explicitSourceType) {
      return explicitSourceType;
    }

    if (sourceMunicipality && autoDetectedSourceType === "json" && !looksLikeJsonSourceUrl(sourceUrl)) {
      return "html";
    }

    return autoDetectedSourceType;
  }

  function resolveMunicipalitySources() {
    if (typeof getMunicipalitySources !== "function") {
      return [];
    }

    return getMunicipalitySources()
      .filter((source) => source.enabled && source.sourceUrl && source.sourceType !== "manual")
      .map((source) => {
        const normalizedSourceType = normalizeSourceType(source);

        return {
          ...source,
          sourceType: normalizedSourceType,
          source: buildImportSourceName(normalizedSourceType, true),
          pruneStale: true
        };
      });
  }

  async function syncConfiguredSource(sourceConfig) {
    const geocodeCache = new Map();
    const collected = await fetchNormalizedItemsFromSource(
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl,
      geocodeCache
    );
    const refinedItems = await refineImportedItems(collected.items, {
      sourceConfig,
      geocodeFetchImpl,
      requestTimeoutMs,
      geocodeCache
    });
    const assessedItems = await assessImportedItems(refinedItems, assessApplication);
    const result = repository.importItems(assessedItems, new Date().toISOString());
    const removedCount =
      sourceConfig.pruneStale && sourceConfig.source === "Gemeinde-Webseite" && sourceConfig.municipality && assessedItems.length > 0
        ? repository.pruneUntouchedMunicipalityImports({
            source: sourceConfig.source,
            municipality: sourceConfig.municipality,
            keepSourceReferences: assessedItems.map((item) => item.sourceReference)
          })
        : 0;
    const notificationCount =
      typeof notifyImportChanges === "function" && result.changes?.length
        ? notifyImportChanges(result.changes, buildSourceLabel(sourceConfig))
        : 0;

    return {
      imported: result.importedCount > 0 || result.updatedCount > 0,
      importedCount: result.importedCount,
      updatedCount: result.updatedCount,
      removedCount,
      skippedCount: Math.max(0, collected.rawCount - assessedItems.length),
      items: result.items,
      changes: result.changes ?? [],
      notificationCount,
      sourceSummaries: [
        {
          municipality: sourceConfig.municipality ?? "",
          sourceType: normalizeSourceType(sourceConfig),
          sourceLabel: buildSourceLabel(sourceConfig),
          importedCount: result.importedCount,
          updatedCount: result.updatedCount,
          removedCount,
          skippedCount: Math.max(0, collected.rawCount - assessedItems.length),
          notificationCount,
          error: ""
        }
      ]
    };
  }

  async function syncMunicipalitySources(sources) {
    const settledResults = await mapWithConcurrency(
      sources,
      async (source) => {
        try {
          return {
            ok: true,
            result: await syncConfiguredSource(source)
          };
        } catch (error) {
          return {
            ok: false,
            error,
            source
          };
        }
      },
      municipalitySourceConcurrency
    );
    const results = [];
    const errors = [];

    for (const settled of settledResults) {
      if (settled?.ok) {
        results.push(settled.result);
        continue;
      }

      errors.push({
        municipality: settled.source.municipality,
        sourceType: settled.source.sourceType,
        sourceLabel: buildSourceLabel(settled.source),
        importedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        notificationCount: 0,
        error: settled.error.message
      });
    }

    if (!results.length && errors.length) {
      throw new Error(`Alle aktivierten Gemeindequellen sind fehlgeschlagen. Erste Fehlermeldung: ${errors[0].error}`);
    }

    const merged = mergeSyncResults(results);

    return {
      ...merged,
      imported: merged.importedCount > 0 || merged.updatedCount > 0,
      source: "municipality-sources",
      sourceSummaries: [...merged.sourceSummaries, ...errors]
    };
  }

  return {
    isConfigured() {
      return Boolean(resolveSourceUrl()) || resolveMunicipalitySources().length > 0;
    },

    getSourceLabel() {
      const hasMunicipalitySources = resolveMunicipalitySources().length > 0;
      const hasGlobalSource = Boolean(resolveSourceUrl());
      const globalSourceType = hasGlobalSource ? resolveGlobalSourceType() : "";
      const hasWebsiteScrapingSource = ["html", "xml", "pdf"].includes(globalSourceType);
      const isAmtsblattSource = globalSourceType === "amtsblatt";
      const globalSourceName = isAmtsblattSource
        ? "Amtsblatt"
        : hasWebsiteScrapingSource
          ? "Website-Scraping"
          : "API";

      if (hasMunicipalitySources && hasGlobalSource) {
        return `Gemeindequellen + ${globalSourceName}`;
      }

      if (hasMunicipalitySources) {
        return "Gemeindequellen";
      }

      if (hasGlobalSource) {
        return globalSourceName;
      }

      return "Demo";
    },

    async sync() {
      const syncResults = [];
      const municipalitySources = resolveMunicipalitySources();

      if (municipalitySources.length > 0) {
        syncResults.push(await syncMunicipalitySources(municipalitySources));
      }

      if (resolveSourceUrl()) {
        const resolvedMunicipality = resolveSourceMunicipality();
        const resolvedSourceType = resolveGlobalSourceType();

        syncResults.push(
          await syncConfiguredSource({
            id: "GLOBAL-SYNC-SOURCE",
            sourceUrl: resolveSourceUrl(),
            sourceToken: resolveSourceToken(),
            sourceType: resolvedSourceType,
            municipality: resolvedMunicipality,
            sourceLabel: resolvedMunicipality
              ? `${resolvedMunicipality} (${resolvedSourceType})`
              : buildImportSourceName(resolvedSourceType),
            source: buildImportSourceName(resolvedSourceType),
            pruneStale: false
          })
        );
      }

      if (!syncResults.length) {
        const result = repository.simulateSync();

        if (typeof notifyImportChanges === "function" && result.changes?.length) {
          result.notificationCount = notifyImportChanges(result.changes, this.getSourceLabel());
        }

        return result;
      }

      const merged = mergeSyncResults(syncResults);

      // Die Fristaufbewahrung läuft zentral beim Start und danach täglich.
      const removedExpiredCount = 0;

      return {
        ...merged,
        imported: merged.importedCount > 0 || merged.updatedCount > 0,
        item: merged.items[0] ?? null,
        remainingQueue: 0,
        removedExpiredCount,
        source: municipalitySources.length > 0 ? "mixed" : "api"
      };
    }
  };
}
