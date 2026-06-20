// HTML-Extraktion und HTML-basierte Importe
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  chooseMoreSpecificAddress,
  extractAddressFromText,
  extractEnclosingBlockHtml,
  extractParcelFromText,
  extractRelevantHtmlFragment,
  extractSwissCoordinatesFromText,
  narrowMunicipalityContextHtml,
  sanitizeExtractedAddress,
  shortenText
} from "./applicationsSyncAddress.js";
import {
  addDays,
  bgReferencePattern,
  createSourcePatternMatcher,
  defaultHtmlExcludePattern,
  defaultHtmlKeywordsPattern,
  extractPdfTextFromBuffer,
  genericMunicipalityAnchorPattern,
  genericMunicipalityArchivePattern,
  genericMunicipalityListingPattern,
  houseNumberAddressPattern,
  nonPendingPermitPattern,
  normalizeText,
  normalizeWhitespace,
  parcelLikeAddressPattern,
  resolveHttpUrlReference,
  streetLikeAddressPattern,
  stripHtml,
  unreliableProxyUrlPattern
} from "./applicationsSyncCommon.js";
import {
  geocodeMunicipalityAddress
} from "./applicationsSyncGeocode.js";
import {
  buildMunicipalityLinkedSourceReference,
  buildMunicipalitySourceReference,
  extractHtmlMetadataText,
  loadEmbeddedMunicipalityRelevantHtml,
  looksLikeMunicipalityDetailUrl,
  mergePageDefaults,
  normalizeMunicipalityResolvedUrl
} from "./applicationsSyncMunicipality.js";
import {
  cleanPublicationProjectSegment,
  extractDateRangeFromText,
  extractDeadlineDateFromText,
  extractPagePublicationDefaults,
  extractProjectTypeFromText,
  extractPublicationDateFromText,
  normalizeImportedProjectType,
  projectTypeSpecificity
} from "./applicationsSyncPublication.js";
import {
  evaluateMunicipalityCandidateDetails,
  extractTableRowsFromHtml,
  isWeakImportedAddress,
  loadMunicipalityDetailPageData,
  normalizeAddressWithContext,
  shouldInspectMunicipalityDetailPage,
  shouldInspectMunicipalityPdfDocument
} from "./applicationsSyncRefinement.js";

export function looksLikePublicationTable(rows) {
  const header = rows[0]?.join(" ") ?? "";
  return /\b(baugesuch\s*nr|bauherrschaft|bauvorhaben|auflage)\b/i.test(header);
}

export function cleanTabularProjectText(value, address = "") {
  const normalizedAddress = sanitizeExtractedAddress(address);
  return cleanPublicationProjectSegment(
    normalizeWhitespace(value)
      .replace(/\bZusatzgesuche?\b.*$/i, "")
      .replace(/\b(?:Bauherrschaft|Bauherr|Gesuchsteller(?:\/in)?|Grundeigentümer(?:\/in)?|Projektverfasser)\b.*$/i, "")
      .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
      .replace(/\bParz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\b/gi, "")
      .replace(/\b\d{4}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]+(?:\s*\([^)]+\))?/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim(),
    normalizedAddress
  );
}

export async function buildTabularImportedItems(relevantHtml, source, requestTimeoutMs, geocodeFetchImpl, geocodeCache) {
  const rows = extractTableRowsFromHtml(relevantHtml);

  if (rows.length < 2 || !looksLikePublicationTable(rows)) {
    return [];
  }

  const items = [];
  const seenReferences = new Set();

  for (const row of rows.slice(1)) {
    if (row.length < 3) {
      continue;
    }

    const rowText = normalizeWhitespace(row.join(" "));

    if (!rowText || genericMunicipalityListingPattern.test(rowText) || genericMunicipalityArchivePattern.test(rowText)) {
      continue;
    }

    const applicantCell = row[1] ?? "";
    const projectCell = row[2] ?? "";
    const timingCell = row.at(-1) ?? "";
    const parcel = extractParcelFromText(`${projectCell} ${applicantCell}`);
    const address =
      normalizeAddressWithContext(
        chooseMoreSpecificAddress(
          extractAddressFromText(`${projectCell} ${applicantCell}`),
          extractAddressFromText(`${applicantCell} ${projectCell}`)
        ),
        parcel,
        rowText
      ) || (parcel ? `Parzelle ${parcel}` : "");
    const projectType =
      cleanTabularProjectText(projectCell, address) ||
      extractProjectTypeFromText(projectCell, "Baugesuch", address, source.sourceUrl);
    const range = extractDateRangeFromText(timingCell);
    let coordinates = "";

    if (
      geocodeFetchImpl &&
      address &&
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

    const sourceReference = buildMunicipalitySourceReference(source, source.sourceUrl, rowText);

    if (!address || !projectType || seenReferences.has(sourceReference)) {
      continue;
    }

    seenReferences.add(sourceReference);

    items.push({
      source: "Gemeinde-Webseite",
      sourceReference,
      sourceUrl: source.sourceUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate: range.publicationDate,
      deadlineDate: range.deadlineDate || (range.publicationDate ? addDays(range.publicationDate, 30) : ""),
      projectType,
      description: shortenText(rowText, 320),
      protectionStatus: coordinates ? "no-hit" : "manual-review",
      agisMatch: coordinates ? "Kein Schutztreffer" : "Noch nicht eindeutig zugeordnet",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: coordinates
        ? "Standort wurde aus der tabellarischen Gemeinde-Publikation übernommen."
        : "Standort aus tabellarischer Gemeinde-Publikation erkannt, aber nicht eindeutig geokodiert.",
      ambiguousAddress: coordinates ? 0 : 1
    });
  }

  return items;
}
// Begriffs-Synonyme, damit komplexe Gemeinde-Websites mit unterschiedlicher
// Wortwahl erkannt werden. Längere Synonyme stehen vorn, damit die Alternation
// sie zuerst trifft.
export const structuredPublicationLabelGroups = {
  owner: ["Bauherrschaft", "Bauherrin", "Bauherr", "Gesuchstellerin", "Gesuchsteller"],
  object: ["Bauobjekt", "Bauvorhaben", "Bauprojekt"],
  place: ["Bauplatz", "Baustelle", "Bauort", "Standort", "Lage"]
};

// Inline-Tags, in denen ein Feld-Label stehen kann (<strong>, <b>, Definitionsliste, Tabelle, ...).
export const structuredPublicationLabelTags = "strong|b|dt|span|th|td|p|h\\d";

export function structuredPublicationLabelSource(labels) {
  const alternation = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");

  // Label entweder in einem Inline-Tag verpackt (mit/ohne Doppelpunkt) oder als reiner Text mit Doppelpunkt.
  return (
    `<(?:${structuredPublicationLabelTags})\\b[^>]*>\\s*(?:${alternation})\\b\\s*:?\\s*<\\/(?:${structuredPublicationLabelTags})>` +
    `|\\b(?:${alternation})\\b\\s*:`
  );
}

export function extractStructuredPublicationBlocks(html) {
  const normalizedHtml = String(html ?? "");
  const ownerSource = structuredPublicationLabelSource(structuredPublicationLabelGroups.owner);
  const objectRe = new RegExp(structuredPublicationLabelSource(structuredPublicationLabelGroups.object), "i");
  const placeRe = new RegExp(structuredPublicationLabelSource(structuredPublicationLabelGroups.place), "i");

  if (!new RegExp(ownerSource, "i").test(normalizedHtml) || !objectRe.test(normalizedHtml) || !placeRe.test(normalizedHtml)) {
    return [];
  }

  return normalizedHtml
    .split(new RegExp(`(?=${ownerSource})`, "i"))
    .map((block) => block.trim())
    .filter((block) => objectRe.test(block) && placeRe.test(block));
}

export function extractStructuredPublicationField(blockHtml, labelKey) {
  const labels = structuredPublicationLabelGroups[labelKey] ?? [labelKey];
  const allLabels = Object.values(structuredPublicationLabelGroups).flat();
  const markerSource = structuredPublicationLabelSource(labels);
  const boundarySource = structuredPublicationLabelSource(allLabels);
  const match = String(blockHtml ?? "").match(
    new RegExp(
      `(?:${markerSource})\\s*([\\s\\S]*?)(?=(?:${boundarySource})|<br\\b|<a\\b|<em\\b|<\\/p>|<\\/li>|<\\/dd>|<\\/td>|<\\/tr>|$)`,
      "i"
    )
  );

  return normalizeWhitespace(stripHtml(match?.[1] ?? ""));
}

export function extractStructuredPublicationHref(blockHtml, baseUrl) {
  const match = String(blockHtml ?? "").match(
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>[\s\S]*?<\/a>/i
  );
  const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";

  if (!href) {
    return "";
  }

  return resolveHttpUrlReference(href, baseUrl)?.toString() ?? "";
}

export async function buildStructuredPublicationImportedItems(
  relevantHtml,
  source,
  requestTimeoutMs,
  geocodeFetchImpl,
  geocodeCache,
  pageDefaults
) {
  const blocks = extractStructuredPublicationBlocks(relevantHtml);

  if (blocks.length === 0) {
    return [];
  }

  const items = [];
  const seenReferences = new Set();

  for (const block of blocks) {
    if (/<em\b[^>]*>\s*(?:Wird zu einem späteren Zeitpunkt publiziert|Zurückgezogen)\.?\s*<\/em>/i.test(block)) {
      continue;
    }

    const bauobjekt = extractStructuredPublicationField(block, "object");
    const bauplatz = extractStructuredPublicationField(block, "place");
    const blockText = normalizeWhitespace(stripHtml(block));
    const publicationDate = extractPublicationDateFromText(blockText) || pageDefaults.publicationDate || "";
    const deadlineDate = extractDeadlineDateFromText(blockText) || pageDefaults.deadlineDate || (publicationDate ? addDays(publicationDate, 30) : "");
    const resolvedUrl = extractStructuredPublicationHref(block, source.sourceUrl);
    const includeMatcher = createSourcePatternMatcher(source.includePattern);
    const excludeMatcher = createSourcePatternMatcher(source.excludePattern);
    const matchingText = normalizeWhitespace([resolvedUrl, blockText, bauobjekt, bauplatz].filter(Boolean).join(" "));

    if (excludeMatcher && excludeMatcher(matchingText)) {
      continue;
    }

    if (includeMatcher && !includeMatcher(matchingText)) {
      continue;
    }

    const parcel = extractParcelFromText(bauplatz || blockText);
    const address =
      normalizeAddressWithContext(
        chooseMoreSpecificAddress(extractAddressFromText(bauplatz), extractAddressFromText(blockText)),
        parcel,
        blockText
      ) || (parcel ? `Parzelle ${parcel}` : "");

    if (!bauobjekt || !address) {
      continue;
    }

    let coordinates = extractSwissCoordinatesFromText(block);

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

    const sourceReference = resolvedUrl
      ? buildMunicipalityLinkedSourceReference(source, resolvedUrl, blockText)
      : buildMunicipalitySourceReference(source, source.sourceUrl, blockText);

    if (seenReferences.has(sourceReference)) {
      continue;
    }

    seenReferences.add(sourceReference);

    items.push({
      source: "Gemeinde-Webseite",
      sourceReference,
      sourceUrl: resolvedUrl || source.sourceUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType: cleanPublicationProjectSegment(bauobjekt, address) || bauobjekt,
      description: shortenText(blockText, 320),
      protectionStatus: coordinates ? "no-hit" : "manual-review",
      agisMatch: coordinates ? "Kein Schutztreffer" : "Noch nicht eindeutig zugeordnet",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: coordinates
        ? "Standort wurde aus dem offiziellen Publikationsblock übernommen."
        : "Offizieller Publikationsblock erkannt, aber nicht eindeutig geokodiert.",
      ambiguousAddress: coordinates ? 0 : 1
    });
  }

  return items;
}

export function matchesMunicipalityCandidate(
  source,
  resolvedUrl,
  candidateText,
  pageLooksLikePublicationPage,
  pageDefaults,
  matchingText = candidateText
) {
  const includeMatcher = createSourcePatternMatcher(source.includePattern);
  const excludeMatcher = createSourcePatternMatcher(source.excludePattern);
  const text = normalizeWhitespace(candidateText);
  const matchText = normalizeWhitespace(matchingText);
  const details = evaluateMunicipalityCandidateDetails(resolvedUrl, text, pageDefaults);

  if (
    !text ||
    defaultHtmlExcludePattern.test(text) ||
    unreliableProxyUrlPattern.test(resolvedUrl) ||
    genericMunicipalityArchivePattern.test(resolvedUrl) ||
    details.looksGenericListingEntry
  ) {
    return false;
  }

  const included = includeMatcher ? includeMatcher(matchText) || includeMatcher(resolvedUrl) : false;
  const excluded = excludeMatcher ? excludeMatcher(matchText) || excludeMatcher(resolvedUrl) : false;
  const qualifiesAsConcretePublication =
    (details.hasStrongKeyword && (details.hasStableIdentifiers || details.hasPublicationMetadata)) ||
    (details.hasStableIdentifiers && details.hasPublicationMetadata) ||
    (details.looksLikePdf && details.hasStableIdentifiers) ||
    (looksLikeMunicipalityDetailUrl(resolvedUrl) &&
      details.hasStableIdentifiers &&
      (details.hasStrongKeyword || bgReferencePattern.test(`${resolvedUrl} ${text}`)));

  if (includeMatcher) {
    return included && !excluded && qualifiesAsConcretePublication;
  }

  if (excluded) {
    return false;
  }

  if (nonPendingPermitPattern.test(text)) {
    return false;
  }

  return (
    qualifiesAsConcretePublication &&
    (defaultHtmlKeywordsPattern.test(text) ||
      details.looksLikePdf ||
      (pageLooksLikePublicationPage && details.hasStableIdentifiers && details.hasPublicationMetadata))
  );
}

export async function buildHtmlImportedItems(
  html,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer,
  geocodeCache = new Map()
) {
  const embeddedHtmlCache = new Map();
  const baseRelevantHtml = extractRelevantHtmlFragment(html);
  const embeddedRelevantHtml = await loadEmbeddedMunicipalityRelevantHtml(
    html,
    source,
    fetchImpl,
    requestTimeoutMs,
    embeddedHtmlCache
  );
  const relevantHtml = normalizeWhitespace([baseRelevantHtml, embeddedRelevantHtml].filter(Boolean).join(" "));
  const pageMetadataText = extractHtmlMetadataText(html);
  const pageText = normalizeWhitespace([pageMetadataText, stripHtml(relevantHtml)].filter(Boolean).join(" "));
  const pageLooksLikePublicationPage = defaultHtmlKeywordsPattern.test(`${source.sourceUrl} ${pageText}`);
  const pageDefaults = mergePageDefaults(extractPagePublicationDefaults(pageMetadataText), extractPagePublicationDefaults(pageText));
  const structuredItems = await buildStructuredPublicationImportedItems(
    relevantHtml,
    source,
    requestTimeoutMs,
    geocodeFetchImpl,
    geocodeCache,
    pageDefaults
  );

  if (structuredItems.length > 0) {
    return structuredItems;
  }

  const items = [];
  const seenReferences = new Set();
  const seenResolvedUrls = new Set();
  const detailCache = new Map();
  const anchorRegex = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = anchorRegex.exec(relevantHtml)) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const resolved = resolveHttpUrlReference(href, source.sourceUrl);

    if (!resolved) {
      continue;
    }

    const resolvedUrl = resolved.toString();
    const anchorText = stripHtml(match[4]);
    const contextHtml = extractEnclosingBlockHtml(relevantHtml, match.index);
    const candidateContextHtml = narrowMunicipalityContextHtml(contextHtml, anchorText, resolvedUrl);
    const contextText = stripHtml(candidateContextHtml || contextHtml);
    let candidateText = normalizeWhitespace(contextText || anchorText);
    let candidateDefaults = pageDefaults;
    let candidateDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, candidateText, candidateDefaults);
    const currentProjectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, anchorText, candidateDetails.address, resolvedUrl),
      resolvedUrl
    );

    const shouldInspectDetail = shouldInspectMunicipalityDetailPage(
      resolvedUrl,
      source.sourceUrl,
      candidateText,
      pageLooksLikePublicationPage
    );
    const shouldInspectPdf = shouldInspectMunicipalityPdfDocument(
      resolvedUrl,
      source.sourceUrl,
      candidateText,
      candidateDefaults,
      anchorText
    );

    if (shouldInspectDetail || shouldInspectPdf) {
      const detailPage = await loadMunicipalityDetailPageData(
        resolvedUrl,
        source,
        fetchImpl,
        requestTimeoutMs,
        detailCache,
        pdfTextExtractImpl
      );

      if (detailPage?.pageText) {
        const originalCandidateDetails = candidateDetails;
        const mergedDefaults = mergePageDefaults(
          candidateDefaults,
          {
            publicationDate: candidateDetails.publicationDate,
            deadlineDate: candidateDetails.deadlineDate
          },
          detailPage.pageDefaults
        );
        const detailText = normalizeWhitespace(detailPage.pageText);
        const detailDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, detailText, mergedDefaults);
        const detailProjectType = normalizeImportedProjectType(
          extractProjectTypeFromText(detailText, anchorText, detailDetails.address, resolvedUrl),
          resolvedUrl
        );
        const mergedAddress = chooseMoreSpecificAddress(candidateDetails.address, detailDetails.address);
        const mergedParcel = detailDetails.parcel || candidateDetails.parcel;
        const mergedCoordinates = detailDetails.coordinates || candidateDetails.coordinates;
        const mergedPublicationDate = detailDetails.publicationDate || candidateDetails.publicationDate;
        const mergedDeadlineDate = detailDetails.deadlineDate || candidateDetails.deadlineDate;
        candidateDefaults = mergedDefaults;
        candidateDetails = {
          address: mergedAddress,
          parcel: mergedParcel,
          coordinates: mergedCoordinates,
          publicationDate: mergedPublicationDate,
          deadlineDate: mergedDeadlineDate,
          hasStrongKeyword: candidateDetails.hasStrongKeyword || detailDetails.hasStrongKeyword,
          looksLikePdf: candidateDetails.looksLikePdf || detailDetails.looksLikePdf,
          hasStableIdentifiers: Boolean(mergedAddress || mergedParcel || mergedCoordinates),
          hasPublicationMetadata: Boolean(mergedPublicationDate || mergedDeadlineDate),
          looksGenericListingEntry: candidateDetails.looksGenericListingEntry && detailDetails.looksGenericListingEntry
        };

        if (
          looksLikeMunicipalityDetailUrl(resolvedUrl) &&
          (detailDetails.hasStableIdentifiers ||
            detailDetails.hasPublicationMetadata ||
            projectTypeSpecificity(detailProjectType) > 0)
        ) {
          candidateText = detailText;
        }

        if (
          projectTypeSpecificity(detailProjectType) > projectTypeSpecificity(currentProjectType) ||
          (!originalCandidateDetails.address && Boolean(detailDetails.address)) ||
          parcelLikeAddressPattern.test(candidateText) ||
          parcelLikeAddressPattern.test(originalCandidateDetails.address ?? "") ||
          (genericMunicipalityAnchorPattern.test(anchorText) &&
            detailProjectType &&
            detailProjectType !== "Baugesuch") ||
          (detailDetails.hasStableIdentifiers && !originalCandidateDetails.hasStableIdentifiers) ||
          (detailDetails.hasPublicationMetadata && !originalCandidateDetails.hasPublicationMetadata) ||
          (Boolean(detailDetails.address) &&
            Boolean(originalCandidateDetails.address) &&
            normalizeText(detailDetails.address) !== normalizeText(originalCandidateDetails.address))
        ) {
          candidateText = detailText;
        }
      }
    }

    const matchingContextText = normalizeWhitespace([candidateText, contextText, anchorText].filter(Boolean).join(" "));

    if (
      !matchesMunicipalityCandidate(
        source,
        resolvedUrl,
        candidateText,
        pageLooksLikePublicationPage,
        candidateDefaults,
        matchingContextText
      )
    ) {
      continue;
    }

    const normalizedResolvedUrl = normalizeMunicipalityResolvedUrl(resolvedUrl);

    if (normalizedResolvedUrl && seenResolvedUrls.has(normalizedResolvedUrl)) {
      continue;
    }

    const sourceReference = buildMunicipalityLinkedSourceReference(source, resolvedUrl, candidateText);

    if (seenReferences.has(sourceReference)) {
      continue;
    }

    seenReferences.add(sourceReference);

    if (normalizedResolvedUrl) {
      seenResolvedUrls.add(normalizedResolvedUrl);
    }

    let coordinates = candidateDetails.coordinates;
    const parcel = candidateDetails.parcel;
    const address =
      normalizeAddressWithContext(candidateDetails.address, parcel, matchingContextText) ||
      (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");
    const publicationDate = candidateDetails.publicationDate;
    const deadlineDate = candidateDetails.deadlineDate || (publicationDate ? addDays(publicationDate, 30) : "");
    const projectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, anchorText, address, resolvedUrl),
      resolvedUrl
    );
    const automatedAssessmentNotes = [];

    if (address === "Adresse von Webseite prüfen") {
      continue;
    }

    if (
      !coordinates &&
      geocodeFetchImpl &&
      address &&
      address !== "Adresse von Webseite prüfen" &&
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

    const ambiguousAddress = !coordinates;

    if (!candidateDetails.hasStableIdentifiers) {
      if (address === "Adresse von Webseite prüfen" && !parcel && !coordinates) {
        continue;
      }

      continue;
    }

    // Recall vor Precision: Ein klar als Baugesuch erkennbarer Fall (explizites
    // Stichwort + Adresse/Parzelle) wird auch ohne erkanntes Datum aufgenommen
    // und zur manuellen Prüfung markiert, statt ihn ganz zu verwerfen.
    const missingAllDates = !publicationDate && !deadlineDate;

    if (missingAllDates && !candidateDetails.hasStrongKeyword) {
      continue;
    }

    if (!projectType || projectType === "Nicht importieren") {
      continue;
    }

    const needsManualReview = ambiguousAddress || missingAllDates;

    if (ambiguousAddress) {
      automatedAssessmentNotes.push("Standort konnte auf der Gemeindewebseite nicht eindeutig gefunden werden.");
    } else if (!candidateDetails.coordinates) {
      automatedAssessmentNotes.push("Standort wurde über den offiziellen schweizerischen Adresssuchdienst ergänzt.");
    }

    if (missingAllDates) {
      automatedAssessmentNotes.push("Kein Publikations- oder Fristdatum gefunden - bitte von Hand prüfen.");
    } else if (!deadlineDate) {
      automatedAssessmentNotes.push("Frist auf der Gemeindewebseite nicht eindeutig gefunden.");
    }

    items.push({
      source: "Gemeinde-Webseite",
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
      protectionStatus: needsManualReview ? "manual-review" : "no-hit",
      agisMatch: needsManualReview ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: automatedAssessmentNotes.join(" "),
      ambiguousAddress: needsManualReview ? 1 : 0
    });
  }

  if (items.length === 0) {
    const tabularItems = await buildTabularImportedItems(
      relevantHtml,
      source,
      requestTimeoutMs,
      geocodeFetchImpl,
      geocodeCache
    );

    if (tabularItems.length > 0) {
      return tabularItems;
    }

    const sourcePageText = normalizeWhitespace([pageMetadataText, pageText].filter(Boolean).join(" "));
    const sourcePageDefaults = mergePageDefaults(pageDefaults, extractPagePublicationDefaults(sourcePageText));

    if (matchesMunicipalityCandidate(source, source.sourceUrl, sourcePageText, pageLooksLikePublicationPage, sourcePageDefaults)) {
      let coordinates = extractSwissCoordinatesFromText(`${source.sourceUrl} ${sourcePageText}`);
      const parcel = extractParcelFromText(sourcePageText);
      const address =
        normalizeAddressWithContext(extractAddressFromText(sourcePageText), parcel, sourcePageText) ||
        (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");

      if (
        !coordinates &&
        geocodeFetchImpl &&
        address &&
        address !== "Adresse von Webseite prüfen" &&
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

      const publicationDate = extractPublicationDateFromText(sourcePageText) || sourcePageDefaults.publicationDate || "";
      const deadlineDate =
        extractDeadlineDateFromText(sourcePageText) ||
        sourcePageDefaults.deadlineDate ||
        (publicationDate ? addDays(publicationDate, 30) : "");
      const projectType = normalizeImportedProjectType(
        extractProjectTypeFromText(sourcePageText, "Baugesuch", address, source.sourceUrl),
        source.sourceUrl
      );

      if ((publicationDate || deadlineDate) && projectType && projectType !== "Nicht importieren" && address !== "Adresse von Webseite prüfen") {
        items.push({
          source: "Gemeinde-Webseite",
          sourceReference: buildMunicipalitySourceReference(source, source.sourceUrl, sourcePageText),
          sourceUrl: source.sourceUrl,
          municipality: source.municipality,
          address,
          parcel,
          coordinates,
          publicationDate,
          deadlineDate,
          projectType,
          description: shortenText(sourcePageText, 320),
          protectionStatus: coordinates ? "no-hit" : "manual-review",
          agisMatch: coordinates ? "Kein Schutztreffer" : "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          workflowStatus: "new",
          automatedAssessment: coordinates
            ? "Standort wurde über die direkte Publikationsseite ermittelt."
            : "Standort konnte auf der Gemeindewebseite nicht eindeutig gefunden werden.",
          ambiguousAddress: coordinates ? 0 : 1
        });
      }
    }
  }

  return items;
}
