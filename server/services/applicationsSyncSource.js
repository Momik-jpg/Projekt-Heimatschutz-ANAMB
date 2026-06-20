// Quellen-Orchestrierung, Verfeinerung und Bewertung
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  amtsblattGeocodeEnabled,
  buildAmtsblattImportedItems,
  isAmtsblattSourceUrl
} from "./applicationsSyncAmtsblatt.js";
import {
  extractPdfTextFromBuffer,
  fetchWithTimeout,
  isArcGisServiceUrl,
  looksLikeJsonSourceUrl,
  looksLikeXmlSourceUrl,
  normalizeImportedPayload,
  parseApiPayload,
  resolveArcGisQueryUrl,
  withOptionalTokenHeaders
} from "./applicationsSyncCommon.js";
import {
  discoverMunicipalityPublicationUrl,
  isSafePublicHttpUrl
} from "./applicationsSyncDiscovery.js";
import {
  buildHtmlImportedItems
} from "./applicationsSyncHtml.js";
import {
  looksLikePdfUrl,
  normalizeMunicipalityResolvedUrl
} from "./applicationsSyncMunicipality.js";
import {
  buildPdfImportedItems
} from "./applicationsSyncPdf.js";
import {
  buildXmlImportedItems
} from "./applicationsSyncXml.js";

export function buildSourceLabel(sourceConfig) {
  const normalizedSourceType = normalizeSourceType(sourceConfig);

  if (sourceConfig.municipality) {
    return `${sourceConfig.municipality} (${normalizedSourceType})`;
  }

  return sourceConfig.sourceLabel ?? "API";
}

export function normalizeSourceType(sourceConfig) {
  const explicitSourceType = String(sourceConfig.sourceType ?? "").trim().toLowerCase();

  if (explicitSourceType === "manual") {
    return "manual";
  }

  if (explicitSourceType === "amtsblatt" || isAmtsblattSourceUrl(sourceConfig.sourceUrl)) {
    return "amtsblatt";
  }

  if (isArcGisServiceUrl(sourceConfig.sourceUrl)) {
    return "arcgis";
  }

  if (looksLikePdfUrl(sourceConfig.sourceUrl)) {
    return "pdf";
  }

  if (looksLikeXmlSourceUrl(sourceConfig.sourceUrl)) {
    return "xml";
  }

  if (explicitSourceType && explicitSourceType !== "html") {
    return explicitSourceType;
  }

  if (looksLikeJsonSourceUrl(sourceConfig.sourceUrl)) {
    return "json";
  }

  if (explicitSourceType) {
    return explicitSourceType;
  }

  return "json";
}

export async function buildDiscoveredMunicipalityImportedItems(
  html,
  sourceConfig,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl,
  pdfTextExtractImpl,
  geocodeCache = new Map()
) {
  if (sourceConfig.allowDiscovery === false) {
    return [];
  }

  const sourceUrl = String(sourceConfig.sourceUrl ?? "").trim();
  const discoveredUrl = await discoverMunicipalityPublicationUrl(
    html,
    sourceConfig,
    fetchImpl,
    requestTimeoutMs
  );

  if (
    !discoveredUrl ||
    !isSafePublicHttpUrl(discoveredUrl) ||
    normalizeMunicipalityResolvedUrl(discoveredUrl) === normalizeMunicipalityResolvedUrl(sourceUrl)
  ) {
    return [];
  }

  try {
    const discoveredResponse = await fetchWithTimeout(
      fetchImpl,
      discoveredUrl,
      { headers: { Accept: "text/html,application/xhtml+xml" } },
      requestTimeoutMs
    );

    if (!discoveredResponse.ok) {
      return [];
    }

    return buildHtmlImportedItems(
      await discoveredResponse.text(),
      { ...sourceConfig, sourceUrl: discoveredUrl },
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl,
      geocodeCache
    );
  } catch {
    return [];
  }
}

export async function fetchNormalizedItemsFromSource(
  sourceConfig,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer,
  geocodeCache = new Map()
) {
  const sourceType = normalizeSourceType(sourceConfig);
  const sourceUrl = String(sourceConfig.sourceUrl ?? "").trim();
  const sourceToken = String(sourceConfig.sourceToken ?? "").trim();

  if (sourceType === "amtsblatt") {
    return buildAmtsblattImportedItems(
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      amtsblattGeocodeEnabled ? geocodeFetchImpl : null
    );
  }

  if (sourceType === "html") {
    let response;

    try {
      response = await fetchWithTimeout(
        fetchImpl,
        sourceUrl,
        {
          headers: {
            Accept: "text/html,application/xhtml+xml"
          }
        },
        requestTimeoutMs
      );
    } catch (error) {
      const discoveredItems = await buildDiscoveredMunicipalityImportedItems(
        "",
        sourceConfig,
        fetchImpl,
        requestTimeoutMs,
        geocodeFetchImpl,
        pdfTextExtractImpl,
        geocodeCache
      );

      if (discoveredItems.length > 0) {
        return {
          rawCount: discoveredItems.length,
          items: discoveredItems
        };
      }

      throw error;
    }

    if (!response.ok) {
      const discoveredItems = await buildDiscoveredMunicipalityImportedItems(
        "",
        sourceConfig,
        fetchImpl,
        requestTimeoutMs,
        geocodeFetchImpl,
        pdfTextExtractImpl,
        geocodeCache
      );

      if (discoveredItems.length > 0) {
        return {
          rawCount: discoveredItems.length,
          items: discoveredItems
        };
      }

      throw new Error(`Gemeindequelle konnte nicht geladen werden (${response.status}).`);
    }

    const html = await response.text();
    let items = await buildHtmlImportedItems(
      html,
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl,
      geocodeCache
    );

    // Auto-discovery: if the configured municipality source yields nothing, try
    // to find the current publication page from links, sitemaps and common paths.
    if (items.length === 0) {
      const discoveredItems = await buildDiscoveredMunicipalityImportedItems(
        html,
        sourceConfig,
        fetchImpl,
        requestTimeoutMs,
        geocodeFetchImpl,
        pdfTextExtractImpl
      );

      if (discoveredItems.length > 0) {
        items = discoveredItems;
      }
    }

    return {
      rawCount: items.length,
      items
    };
  }

  if (sourceType === "pdf") {
    return buildPdfImportedItems(
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
  }

  if (sourceType === "xml") {
    const response = await fetchWithTimeout(
      fetchImpl,
      sourceUrl,
      {
        headers: withOptionalTokenHeaders(
          {
            Accept: "application/xml,text/xml,application/rss+xml,application/atom+xml"
          },
          sourceToken
        )
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`Quelle konnte nicht geladen werden (${response.status}).`);
    }

    const xml = await response.text();
    return buildXmlImportedItems(
      xml,
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
  }

  const requestUrl = sourceType === "arcgis"
    ? await resolveArcGisQueryUrl(sourceUrl, sourceToken, fetchImpl)
    : sourceUrl;
  const response = await fetchWithTimeout(
    fetchImpl,
    requestUrl,
    {
      headers: withOptionalTokenHeaders(
        {
          Accept: "application/json"
        },
        sourceToken
      )
    },
    requestTimeoutMs
  );

  if (!response.ok) {
    throw new Error(`Quelle konnte nicht geladen werden (${response.status}).`);
  }

  const payload = await response.json();

  if (payload?.error?.message) {
    throw new Error(`Quelle konnte nicht geladen werden: ${payload.error.message}`);
  }

  const items = normalizeImportedPayload(payload, sourceUrl, {
    source:
      sourceConfig.source ?? (sourceConfig.municipality ? "Gemeinde-Import" : "API"),
    municipality: sourceConfig.municipality ?? "",
    sourceReferenceSeed: sourceConfig.id ?? sourceUrl
  });

  return {
    rawCount: parseApiPayload(payload).length,
    items
  };
}

export async function assessImportedItems(items, assessApplication) {
  const assessedItems = [];

  for (const item of items) {
    if (typeof assessApplication === "function") {
      assessedItems.push((await assessApplication(item)) ?? item);
      continue;
    }

    assessedItems.push(item);
  }

  return assessedItems;
}

export function mergeSyncResults(results) {
  return results.reduce(
    (aggregate, result) => ({
      imported: aggregate.imported || result.imported,
      importedCount: aggregate.importedCount + (result.importedCount ?? 0),
      updatedCount: aggregate.updatedCount + (result.updatedCount ?? 0),
      skippedCount: aggregate.skippedCount + (result.skippedCount ?? 0),
      items: [...aggregate.items, ...(result.items ?? [])],
      changes: [...aggregate.changes, ...(result.changes ?? [])],
      notificationCount: aggregate.notificationCount + (result.notificationCount ?? 0),
      sourceSummaries: [...aggregate.sourceSummaries, ...(result.sourceSummaries ?? [])]
    }),
    {
      imported: false,
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      items: [],
      changes: [],
      notificationCount: 0,
      sourceSummaries: []
    }
  );
}
