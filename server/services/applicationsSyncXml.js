// XML-, Feed-, Sitemap- und ArcGIS-Parser
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  chooseMoreSpecificAddress,
  extractAddressFromText,
  extractParcelFromText,
  extractSwissCoordinatesFromText,
  shortenText
} from "./applicationsSyncAddress.js";
import {
  addDays,
  createSourcePatternMatcher,
  defaultHtmlKeywordsPattern,
  extractFeedEntriesFromXml,
  extractPdfTextFromBuffer,
  houseNumberAddressPattern,
  nonPendingPermitPattern,
  normalizeDate,
  normalizeWhitespace,
  parcelLikeAddressPattern,
  resolveSitemapUrls,
  streetLikeAddressPattern
} from "./applicationsSyncCommon.js";
import {
  geocodeMunicipalityAddress
} from "./applicationsSyncGeocode.js";
import {
  matchesMunicipalityCandidate
} from "./applicationsSyncHtml.js";
import {
  buildMunicipalityLinkedSourceReference,
  mergePageDefaults,
  normalizeMunicipalityResolvedUrl
} from "./applicationsSyncMunicipality.js";
import {
  extractDeadlineDateFromText,
  extractProjectTypeFromText,
  extractPublicationDateFromText,
  normalizeImportedProjectType,
  projectTypeSpecificity
} from "./applicationsSyncPublication.js";
import {
  evaluateMunicipalityCandidateDetails,
  isWeakImportedAddress,
  loadMunicipalityDetailPageData,
  normalizeAddressWithContext,
  shouldInspectMunicipalityDetailPage,
  shouldInspectMunicipalityPdfDocument
} from "./applicationsSyncRefinement.js";

export function buildXmlPageDefaults(entry) {
  const publicationDate = normalizeDate(entry.publishedAt) || extractPublicationDateFromText(entry.rawText);
  return {
    publicationDate,
    deadlineDate: extractDeadlineDateFromText(entry.rawText) || (publicationDate ? addDays(publicationDate, 30) : "")
  };
}

export async function buildXmlFeedImportedItems(
  xml,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const entries = extractFeedEntriesFromXml(xml, source.sourceUrl);
  const geocodeCache = new Map();
  const detailCache = new Map();
  const items = [];
  const seenReferences = new Set();
  const seenResolvedUrls = new Set();

  for (const entry of entries) {
    if (!entry.rawText) {
      continue;
    }

    const resolvedUrl = entry.link || source.sourceUrl;
    let candidateText = entry.rawText;
    let candidateDefaults = buildXmlPageDefaults(entry);
    let candidateDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, candidateText, candidateDefaults);
    const currentProjectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, entry.title, candidateDetails.address, resolvedUrl),
      resolvedUrl
    );
    const shouldInspectPdf = entry.link
      ? shouldInspectMunicipalityPdfDocument(
          resolvedUrl,
          source.sourceUrl,
          candidateText,
          candidateDefaults,
          entry.title
        )
      : false;

    if (
      entry.link &&
      (shouldInspectMunicipalityDetailPage(resolvedUrl, source.sourceUrl, candidateText, true) || shouldInspectPdf)
    ) {
      const detailPage = await loadMunicipalityDetailPageData(
        resolvedUrl,
        source,
        fetchImpl,
        requestTimeoutMs,
        detailCache,
        pdfTextExtractImpl
      );

      if (detailPage?.pageText) {
        const detailText = normalizeWhitespace(detailPage.pageText);
        const detailDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, detailText, detailPage.pageDefaults);
        const detailProjectType = normalizeImportedProjectType(
          extractProjectTypeFromText(detailText, entry.title, detailDetails.address, resolvedUrl),
          resolvedUrl
        );

        candidateDefaults = mergePageDefaults(candidateDefaults, detailPage.pageDefaults);
        candidateDetails = {
          address: chooseMoreSpecificAddress(candidateDetails.address, detailDetails.address),
          parcel: detailDetails.parcel || candidateDetails.parcel,
          coordinates: detailDetails.coordinates || candidateDetails.coordinates,
          publicationDate: detailDetails.publicationDate || candidateDetails.publicationDate,
          deadlineDate: detailDetails.deadlineDate || candidateDetails.deadlineDate,
          hasStrongKeyword: candidateDetails.hasStrongKeyword || detailDetails.hasStrongKeyword,
          looksLikePdf: candidateDetails.looksLikePdf || detailDetails.looksLikePdf,
          hasStableIdentifiers: Boolean(
            chooseMoreSpecificAddress(candidateDetails.address, detailDetails.address) ||
              detailDetails.parcel ||
              candidateDetails.parcel ||
              detailDetails.coordinates ||
              candidateDetails.coordinates
          ),
          hasPublicationMetadata: Boolean(
            detailDetails.publicationDate ||
              candidateDetails.publicationDate ||
              detailDetails.deadlineDate ||
              candidateDetails.deadlineDate
          ),
          looksGenericListingEntry: candidateDetails.looksGenericListingEntry && detailDetails.looksGenericListingEntry
        };

        if (
          projectTypeSpecificity(detailProjectType) > projectTypeSpecificity(currentProjectType) ||
          detailDetails.hasStableIdentifiers ||
          detailDetails.hasPublicationMetadata
        ) {
          candidateText = detailText;
        }
      }
    }

    const matchingText = normalizeWhitespace([entry.title, entry.summary, entry.content, candidateText].filter(Boolean).join(" "));
    const includeMatcher = createSourcePatternMatcher(source.includePattern);
    const excludeMatcher = createSourcePatternMatcher(source.excludePattern);
    const includedByPattern = includeMatcher ? includeMatcher(matchingText) || includeMatcher(resolvedUrl) : false;
    const excludedByPattern = excludeMatcher ? excludeMatcher(matchingText) || excludeMatcher(resolvedUrl) : false;
    const matchesFeedCandidate =
      !excludedByPattern &&
      !candidateDetails.looksGenericListingEntry &&
      !nonPendingPermitPattern.test(matchingText) &&
      (includeMatcher
        ? includedByPattern && (candidateDetails.hasStableIdentifiers || candidateDetails.hasPublicationMetadata)
        : defaultHtmlKeywordsPattern.test(matchingText) &&
          candidateDetails.hasStableIdentifiers &&
          candidateDetails.hasPublicationMetadata);

    if (
      !matchesFeedCandidate &&
      !matchesMunicipalityCandidate(source, resolvedUrl, candidateText, true, candidateDefaults, matchingText)
    ) {
      continue;
    }

    const normalizedResolvedUrl = normalizeMunicipalityResolvedUrl(resolvedUrl);

    if (normalizedResolvedUrl && seenResolvedUrls.has(normalizedResolvedUrl)) {
      continue;
    }

    const sourceReference = buildMunicipalityLinkedSourceReference(source, resolvedUrl, `${entry.id} ${candidateText}`);

    if (seenReferences.has(sourceReference)) {
      continue;
    }

    let coordinates = candidateDetails.coordinates;
    const parcel = candidateDetails.parcel;
    const address =
      normalizeAddressWithContext(candidateDetails.address, parcel, matchingText) ||
      (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");

    if (address === "Adresse von Webseite prüfen") {
      continue;
    }

    if (
      !coordinates &&
      geocodeFetchImpl &&
      !isWeakImportedAddress(address) &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    if (!coordinates && geocodeFetchImpl && parcel) {
      coordinates = await geocodeMunicipalityAddress(
        `Parzelle ${parcel}`,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const publicationDate = candidateDetails.publicationDate || candidateDefaults.publicationDate || "";
    const deadlineDate = candidateDetails.deadlineDate || candidateDefaults.deadlineDate || (publicationDate ? addDays(publicationDate, 30) : "");
    const projectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, entry.title || "Baugesuch", address, resolvedUrl),
      resolvedUrl
    );

    if (!candidateDetails.hasStableIdentifiers || (!publicationDate && !deadlineDate) || !projectType || projectType === "Nicht importieren") {
      continue;
    }

    seenReferences.add(sourceReference);

    if (normalizedResolvedUrl) {
      seenResolvedUrls.add(normalizedResolvedUrl);
    }

    const ambiguousAddress = !coordinates;
    const automatedAssessmentNotes = [];

    if (ambiguousAddress) {
      automatedAssessmentNotes.push("Standort konnte aus dem Feed nicht eindeutig geokodiert werden.");
    } else if (!candidateDetails.coordinates) {
      automatedAssessmentNotes.push("Standort wurde über den offiziellen schweizerischen Adresssuchdienst ergänzt.");
    }

    items.push({
      source: "Gemeinde-Feed",
      sourceReference,
      sourceUrl: resolvedUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType,
      description: shortenText(candidateText, 320),
      protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
      agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: automatedAssessmentNotes.join(" "),
      ambiguousAddress: ambiguousAddress ? 1 : 0
    });
  }

  return {
    rawCount: entries.length,
    items
  };
}

export async function buildXmlSitemapImportedItems(
  xml,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const urls = await resolveSitemapUrls(xml, source, fetchImpl, requestTimeoutMs);
  const items = [];
  const seenReferences = new Set();
  const geocodeCache = new Map();
  const detailCache = new Map();

  for (const resolvedUrl of urls) {
    const detailPage = await loadMunicipalityDetailPageData(
      resolvedUrl,
      source,
      fetchImpl,
      requestTimeoutMs,
      detailCache,
      pdfTextExtractImpl
    );

    if (!detailPage?.pageText) {
      continue;
    }

    const candidateText = normalizeWhitespace(detailPage.pageText);
    const candidateDefaults = detailPage.pageDefaults;

    if (!matchesMunicipalityCandidate(source, resolvedUrl, candidateText, true, candidateDefaults, candidateText)) {
      continue;
    }

    let coordinates = extractSwissCoordinatesFromText(candidateText);
    const parcel = extractParcelFromText(candidateText);
    const address =
      normalizeAddressWithContext(extractAddressFromText(candidateText), parcel, candidateText) ||
      (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");

    if (address === "Adresse von Webseite prüfen") {
      continue;
    }

    if (
      !coordinates &&
      geocodeFetchImpl &&
      !isWeakImportedAddress(address) &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    if (!coordinates && geocodeFetchImpl && parcel) {
      coordinates = await geocodeMunicipalityAddress(
        `Parzelle ${parcel}`,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const publicationDate = extractPublicationDateFromText(candidateText) || candidateDefaults.publicationDate || "";
    const deadlineDate =
      extractDeadlineDateFromText(candidateText) ||
      candidateDefaults.deadlineDate ||
      (publicationDate ? addDays(publicationDate, 30) : "");
    const projectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, "Baugesuch", address, resolvedUrl),
      resolvedUrl
    );
    const sourceReference = buildMunicipalityLinkedSourceReference(source, resolvedUrl, candidateText);

    if (
      seenReferences.has(sourceReference) ||
      (!publicationDate && !deadlineDate) ||
      !projectType ||
      projectType === "Nicht importieren"
    ) {
      continue;
    }

    seenReferences.add(sourceReference);

    const ambiguousAddress = !coordinates;

    items.push({
      source: "Gemeinde-Sitemap",
      sourceReference,
      sourceUrl: resolvedUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType,
      description: shortenText(candidateText, 320),
      protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
      agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: ambiguousAddress
        ? "Sitemap-Eintrag erkannt, aber Standort noch nicht eindeutig geokodiert."
        : "Sitemap-Eintrag automatisch über offizielle Detailseite übernommen.",
      ambiguousAddress: ambiguousAddress ? 1 : 0
    });
  }

  return {
    rawCount: urls.length,
    items
  };
}

export async function buildXmlImportedItems(
  xml,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const normalizedXml = String(xml ?? "");

  if (/<urlset\b|<sitemapindex\b/i.test(normalizedXml)) {
    return buildXmlSitemapImportedItems(
      normalizedXml,
      source,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
  }

  return buildXmlFeedImportedItems(
    normalizedXml,
    source,
    fetchImpl,
    requestTimeoutMs,
    geocodeFetchImpl,
    pdfTextExtractImpl
  );
}
