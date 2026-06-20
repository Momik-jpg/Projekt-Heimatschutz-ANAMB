// Verfeinerung und Hydrierung importierter Baugesuche
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  chooseMoreSpecificAddress,
  extractAddressFromPublicationTitle,
  extractAddressFromSourceUrl,
  extractAddressFromText,
  extractLabeledValue,
  extractParcelFromText,
  extractRelevantHtmlFragment,
  extractSwissCoordinatesFromText,
  formatImportedMunicipalityAddress,
  normalizeImportedMunicipalityAddress,
  sanitizeExtractedAddress
} from "./applicationsSyncAddress.js";
import {
  addDays,
  addressPlaceholderPattern,
  administrativePermitAttachmentPattern,
  administrativePermitTemplatePattern,
  bgReferencePattern,
  defaultHtmlExcludePattern,
  defaultHtmlKeywordsPattern,
  defaultSyncRequestTimeoutMs,
  escapeRegExp,
  extractPdfTextFromBuffer,
  fetchWithTimeout,
  garbledStructuredTextPattern,
  genericLocationTermPattern,
  genericMunicipalityArchivePattern,
  genericMunicipalityListingPattern,
  genericMunicipalityPublicationRoutePattern,
  houseNumberAddressPattern,
  looksLikeStandaloneDate,
  monthYearListingPattern,
  nonPendingPermitPattern,
  normalizeLocationPrecision,
  normalizeText,
  normalizeWhitespace,
  parcelLikeAddressPattern,
  projectLikeAddressPattern,
  standaloneHouseNumberPattern,
  streetAddressWithNumberPattern,
  streetLikeAddressPattern,
  stripHtml
} from "./applicationsSyncCommon.js";
import {
  geocodeMunicipalityAddressWithPrecision,
  geocodeMunicipalityParcel,
  shouldAttemptMunicipalityAddressGeocode
} from "./applicationsSyncGeocode.js";
import {
  extractHtmlMetadataText,
  looksLikeGenericSearchResult,
  looksLikeListingSourceUrl,
  looksLikeMunicipalityDetailUrl,
  looksLikeNonPermitMunicipalityContent,
  looksLikePdfUrl,
  mergePageDefaults
} from "./applicationsSyncMunicipality.js";
import {
  extractDeadlineDateFromText,
  extractPagePublicationDefaults,
  extractProjectTypeFromText,
  extractPublicationDateFromText,
  normalizeImportedProjectType,
  projectTypeSpecificity
} from "./applicationsSyncPublication.js";

export function evaluateMunicipalityCandidateDetails(resolvedUrl, candidateText, pageDefaults = {}) {
  const publicationTitleAddress = extractAddressFromPublicationTitle(candidateText);
  const address = chooseMoreSpecificAddress(
    chooseMoreSpecificAddress(publicationTitleAddress, extractAddressFromText(candidateText)),
    extractAddressFromSourceUrl(resolvedUrl)
  );
  const parcel = extractParcelFromText(candidateText);
  const coordinates = extractSwissCoordinatesFromText(`${resolvedUrl} ${candidateText}`);
  const publicationDate = extractPublicationDateFromText(candidateText) || pageDefaults.publicationDate || "";
  const deadlineDate = extractDeadlineDateFromText(candidateText) || pageDefaults.deadlineDate || "";
  const hasRecoverableLocation = hasRecoverableLocationFragments(candidateText);
  const hasStrongKeyword = /\b(baugesuch|baugesuche|baupublikation|baubewilligung)\b/i.test(
    `${resolvedUrl} ${candidateText}`
  );
  const looksLikePdf = looksLikePdfUrl(resolvedUrl);
  const hasStableIdentifiers = Boolean(address || parcel || coordinates || hasRecoverableLocation);
  const hasPublicationMetadata = Boolean(publicationDate || deadlineDate);
  const looksLikeAdministrativePermitTemplate = administrativePermitTemplatePattern.test(
    `${resolvedUrl} ${candidateText}`
  );
  const looksLikeAdministrativePermitAttachment =
    looksLikePdf && administrativePermitAttachmentPattern.test(`${resolvedUrl} ${candidateText}`);
  const looksGenericListingEntry =
    genericMunicipalityListingPattern.test(candidateText) ||
    genericMunicipalityArchivePattern.test(candidateText) ||
    genericMunicipalityPublicationRoutePattern.test(resolvedUrl) ||
    looksLikeGenericSearchResult(resolvedUrl, candidateText) ||
    looksLikeNonPermitMunicipalityContent(candidateText, resolvedUrl) ||
    looksLikeAdministrativePermitTemplate ||
    looksLikeAdministrativePermitAttachment ||
    garbledStructuredTextPattern.test(candidateText) ||
    nonPendingPermitPattern.test(candidateText) ||
    monthYearListingPattern.test(candidateText) ||
    /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]+\s+20\d{2}$/u.test(candidateText);

  return {
    address,
    parcel,
    coordinates,
    publicationDate,
    deadlineDate,
    hasRecoverableLocation,
    hasStrongKeyword,
    looksLikePdf,
    hasStableIdentifiers,
    hasPublicationMetadata,
    looksGenericListingEntry
  };
}

export function shouldInspectMunicipalityPdfDocument(
  resolvedUrl,
  sourceUrl,
  candidateText,
  pageDefaults = {},
  fallbackLabel = ""
) {
  if (looksLikeListingSourceUrl(resolvedUrl, sourceUrl) || !looksLikePdfUrl(resolvedUrl)) {
    return false;
  }

  const matchingText = normalizeWhitespace([candidateText, fallbackLabel, resolvedUrl].filter(Boolean).join(" "));
  const details = evaluateMunicipalityCandidateDetails(resolvedUrl, matchingText, pageDefaults);
  const projectType = normalizeImportedProjectType(
    extractProjectTypeFromText(matchingText, fallbackLabel, details.address, resolvedUrl),
    resolvedUrl
  );
  const hasConcreteHint =
    bgReferencePattern.test(matchingText) ||
    streetLikeAddressPattern.test(matchingText) ||
    /\bParz(?:elle|\.| Nr\.?)?\s*\d{1,6}\b/i.test(matchingText);
  const needsMoreData =
    !details.hasStableIdentifiers ||
    !details.hasPublicationMetadata ||
    projectTypeSpecificity(projectType) <= 1;

  if (
    !hasConcreteHint ||
    !needsMoreData ||
    details.looksGenericListingEntry ||
    nonPendingPermitPattern.test(matchingText)
  ) {
    return false;
  }

  return true;
}

export function shouldInspectMunicipalityDetailPage(resolvedUrl, sourceUrl, candidateText, pageLooksLikePublicationPage) {
  if (looksLikeListingSourceUrl(resolvedUrl, sourceUrl)) {
    return false;
  }

  if (looksLikePdfUrl(resolvedUrl)) {
    return false;
  }

  if (looksLikeMunicipalityDetailUrl(resolvedUrl)) {
    return true;
  }

  if (!pageLooksLikePublicationPage) {
    return false;
  }

  const text = normalizeWhitespace(candidateText);

  return Boolean(
    text &&
      !defaultHtmlExcludePattern.test(text) &&
      !genericMunicipalityListingPattern.test(text) &&
      !genericMunicipalityArchivePattern.test(text) &&
      !nonPendingPermitPattern.test(text) &&
      (defaultHtmlKeywordsPattern.test(text) || bgReferencePattern.test(text))
  );
}

export function isWeakImportedAddress(address) {
  const text = normalizeWhitespace(address);

  if (!text || addressPlaceholderPattern.test(text) || standaloneHouseNumberPattern.test(text)) {
    return true;
  }

  if (parcelLikeAddressPattern.test(text)) {
    return true;
  }

  if (/^\d{1,4}[A-Za-z]?\s+\S+/u.test(text)) {
    return true;
  }

  if (!/\d/.test(text)) {
    return true;
  }

  return !streetLikeAddressPattern.test(text) && !houseNumberAddressPattern.test(text);
}

export function extractStandaloneHouseNumber(value) {
  const text = normalizeWhitespace(value);
  const standaloneMatch = text.match(standaloneHouseNumberPattern);

  if (standaloneMatch?.[1]) {
    return standaloneMatch[1];
  }

  const leadingMatch = text.match(/^(\d{1,4}[A-Za-z]?)\b/u);

  if (leadingMatch?.[1]) {
    return leadingMatch[1];
  }

  const labeledMatch = text.match(
    /\b(?:Haus(?:nummer|nr\.?)?|Geb(?:äude)?(?:\s*(?:Nr\.?|Nummer))?|Gebäudenummer|Objekt\s*Nr\.?|Standort|Bauplatz|Lage)\s*:?\s*(\d{1,4}[A-Za-z]?)\b/iu
  );

  return labeledMatch?.[1] ?? "";
}

export function extractStreetNameFromContext(value) {
  const streetTrailingLabels = [
    "Hausnummer",
    "Hausnr.",
    "Gebäude Nr.",
    "Gebäudenummer",
    "Objekt Nr.",
    "Parzelle",
    "Parz. Nr.",
    "Bauherr",
    "Bauherrschaft",
    "Bauobjekt",
    "Bauvorhaben",
    "Frist",
    "Publiziert",
    "Publikation"
  ];
  const labeledValues = [
    extractLabeledValue(value, "Strasse", streetTrailingLabels),
    extractLabeledValue(value, "Strassenname", streetTrailingLabels),
    extractLabeledValue(value, "Strasse / Weg", streetTrailingLabels),
    extractLabeledValue(value, "Bauplatz", streetTrailingLabels),
    extractLabeledValue(value, "Standort", streetTrailingLabels),
    extractLabeledValue(value, "Lage", streetTrailingLabels)
  ];

  for (const labeledValue of labeledValues) {
    const candidate = normalizeWhitespace(labeledValue)
      .replace(/\b(?:Haus(?:nummer|nr\.?)?|Geb(?:äude)?(?:\s*(?:Nr\.?|Nummer))?|Gebäudenummer)\s*:?\s*\d{1,4}[A-Za-z]?\b/giu, "")
      .replace(/\bParz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\b/gi, "")
      .replace(/[;,].*$/u, "")
      .trim();
    const sanitized = sanitizeExtractedAddress(candidate);

    if (
      sanitized &&
      sanitized.length <= 80 &&
      /[A-Za-zÄÖÜäöü]/u.test(sanitized) &&
      !/\d/.test(sanitized) &&
      !projectLikeAddressPattern.test(sanitized) &&
      !genericLocationTermPattern.test(sanitized) &&
      !looksLikeStandaloneDate(sanitized)
    ) {
      return formatImportedMunicipalityAddress(sanitized);
    }
  }

  return "";
}

export function extractAddressRefinementFromContext(address, context) {
  const text = normalizeWhitespace(context);
  const currentAddress = normalizeImportedMunicipalityAddress(address);
  const directCandidate = normalizeImportedMunicipalityAddress(
    chooseMoreSpecificAddress(extractAddressFromPublicationTitle(text), extractAddressFromText(text))
  );
  const houseNumber = extractStandaloneHouseNumber(address) || extractStandaloneHouseNumber(text);

  if (houseNumber) {
    streetAddressWithNumberPattern.lastIndex = 0;
    const matchingStreetAddress = [...text.matchAll(streetAddressWithNumberPattern)]
      .map((match) => normalizeImportedMunicipalityAddress(match[1]))
      .find((candidate) => new RegExp(`\\b${escapeRegExp(houseNumber)}\\b`, "i").test(candidate));

    if (matchingStreetAddress) {
      return matchingStreetAddress;
    }

    const streetName = extractStreetNameFromContext(text);

    if (streetName) {
      const combined = normalizeImportedMunicipalityAddress(`${streetName} ${houseNumber}`);

      if (combined && !isWeakImportedAddress(combined)) {
        return combined;
      }
    }
  }

  if (directCandidate && !isWeakImportedAddress(directCandidate)) {
    return directCandidate;
  }

  if (currentAddress && !isWeakImportedAddress(currentAddress)) {
    return chooseMoreSpecificAddress(currentAddress, directCandidate);
  }

  return directCandidate || currentAddress;
}

export function normalizeAddressWithContext(address, parcel, context) {
  const originalAddress = normalizeImportedMunicipalityAddress(address, parcel);
  const refinedAddress = normalizeImportedMunicipalityAddress(extractAddressRefinementFromContext(address, context), parcel);

  if (originalAddress && parcel && parcelLikeAddressPattern.test(originalAddress)) {
    return originalAddress;
  }

  if (
    originalAddress &&
    streetLikeAddressPattern.test(originalAddress) &&
    refinedAddress &&
    parcelLikeAddressPattern.test(refinedAddress)
  ) {
    return originalAddress;
  }

  if (
    originalAddress &&
    streetLikeAddressPattern.test(originalAddress) &&
    !/\d/.test(originalAddress) &&
    refinedAddress &&
    !normalizeText(refinedAddress).includes(normalizeText(originalAddress))
  ) {
    return originalAddress;
  }

  return (
    refinedAddress ||
    originalAddress ||
    (parcel ? `Parzelle ${parcel}` : "")
  );
}

export function hasRecoverableLocationFragments(value) {
  const text = normalizeWhitespace(value);

  if (!text) {
    return false;
  }

  if (extractAddressRefinementFromContext("", text)) {
    return true;
  }

  return Boolean(extractParcelFromText(text) || (extractStandaloneHouseNumber(text) && extractStreetNameFromContext(text)));
}

export function appendAutomatedAssessment(base, notes) {
  const existing = normalizeWhitespace(base);
  const uniqueNotes = [...new Set(notes.map((note) => normalizeWhitespace(note)).filter(Boolean))]
    .filter((note) => !existing.includes(note));
  return normalizeWhitespace([existing, ...uniqueNotes].filter(Boolean).join(" "));
}

export function buildRefinementContext(item, sourceConfig = {}) {
  return normalizeWhitespace(
    [
      item.sourceReference,
      item.sourceUrl,
      item.address,
      item.parcel ? `Parzelle ${item.parcel}` : "",
      item.projectType,
      item.description,
      sourceConfig.sourceUrl,
      sourceConfig.municipality
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export async function refineImportedItemData(item, options = {}) {
  const { sourceConfig = {}, geocodeFetchImpl = null, requestTimeoutMs = defaultSyncRequestTimeoutMs, geocodeCache = new Map() } = options;
  const refined = { ...item };
  const notes = [];
  const context = buildRefinementContext(refined, sourceConfig);
  const protectedStatuses = new Set(["protected-point", "protected-zone", "combined-hit"]);

  let parcel = String(refined.parcel ?? "").trim();

  if (!parcel) {
    parcel = extractParcelFromText(context);

    if (parcel) {
      refined.parcel = parcel;
      notes.push(`KI-Datenprüfung: Parzelle ${parcel} aus Quellkontext ergänzt.`);
    }
  }

  const originalAddress = String(refined.address ?? "").trim();
  const refinedAddress = normalizeAddressWithContext(originalAddress, parcel, context);

  if (refinedAddress && normalizeText(refinedAddress) !== normalizeText(originalAddress)) {
    refined.address = refinedAddress;
    notes.push(`KI-Datenprüfung: Adresse aus Quellkontext ergänzt: ${refinedAddress}.`);
  } else if (!refined.address && parcel) {
    refined.address = `Parzelle ${parcel}`;
  }

  if (!refined.publicationDate) {
    const publicationDate = extractPublicationDateFromText(context);

    if (publicationDate) {
      refined.publicationDate = publicationDate;
      notes.push(`KI-Datenprüfung: Publikationsdatum ergänzt: ${publicationDate}.`);
    }
  }

  if (!refined.deadlineDate) {
    const deadlineDate = extractDeadlineDateFromText(context) || (refined.publicationDate ? addDays(refined.publicationDate, 30) : "");

    if (deadlineDate) {
      refined.deadlineDate = deadlineDate;
      notes.push(`KI-Datenprüfung: Fristdatum ergänzt: ${deadlineDate}.`);
    }
  }

  const municipality = String(refined.municipality ?? sourceConfig.municipality ?? "").trim();
  const address = String(refined.address ?? "").trim();

  if (!refined.coordinates && municipality && geocodeFetchImpl) {
    if (
      address &&
      shouldAttemptMunicipalityAddressGeocode(address)
    ) {
      const geocodeMatch = await geocodeMunicipalityAddressWithPrecision(
        address,
        municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );

      if (geocodeMatch?.coordinates) {
        refined.coordinates = geocodeMatch.coordinates;
        refined.locationPrecision = geocodeMatch.locationPrecision;
      }
    }

    if (!refined.coordinates && parcel) {
      refined.coordinates = await geocodeMunicipalityParcel(
        parcel,
        municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );

      if (refined.coordinates) {
        refined.locationPrecision = "precise";
      }
    }

    if (refined.coordinates) {
      notes.push("KI-Datenprüfung: Standort über die amtliche Suche ergänzt.");
    }
  }

  const normalizedLocationPrecision = normalizeLocationPrecision(refined.locationPrecision);
  const locationIsApproximate = normalizedLocationPrecision === "approximate";
  const locationIsPreciseParcel =
    normalizedLocationPrecision === "precise" &&
    (parcelLikeAddressPattern.test(refined.address) || Boolean(parcel));
  const locationStillWeak =
    !refined.coordinates || (isWeakImportedAddress(refined.address) && !locationIsApproximate && !locationIsPreciseParcel);
  const missingDeadline = !refined.deadlineDate;
  // Nur eine unklare Lage (kein verwertbarer Standort) macht eine Hand-Prüfung
  // des Schutzstatus nötig - AGIS kann ohne Standort nicht bewerten. Eine
  // fehlende Frist ist hingegen ein reines Datenqualitätsproblem und wird nur
  // als Hinweis vermerkt, damit ein möglicher Schutztreffer nicht verdeckt wird.
  const needsManualReview = locationStillWeak;

  if (locationStillWeak) {
    notes.push("KI-Datenprüfung: Standortangaben bleiben unvollständig - bitte von Hand prüfen.");
  }

  if (missingDeadline) {
    notes.push("KI-Datenprüfung: Frist fehlt weiterhin - bitte von Hand prüfen.");
  }

  if (!protectedStatuses.has(refined.protectionStatus)) {
    refined.protectionStatus = needsManualReview ? "manual-review" : "no-hit";
    refined.agisMatch = needsManualReview ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer";
  }

  refined.ambiguousAddress = locationStillWeak ? 1 : 0;
  if (!notes.length) {
    notes.push("KI-Datenprüfung: Importdaten auf Adresse, Parzelle, Standort und Frist geprüft.");
  }
  refined.automatedAssessment = appendAutomatedAssessment(refined.automatedAssessment, notes);

  return refined;
}

export async function refineImportedItems(items, options = {}) {
  const geocodeCache = options.geocodeCache ?? new Map();
  const refinedItems = [];

  for (const item of items) {
    refinedItems.push(await refineImportedItemData(item, { ...options, geocodeCache }));
  }

  return refinedItems;
}

export async function loadMunicipalityDetailPageData(
  resolvedUrl,
  source,
  fetchImpl,
  requestTimeoutMs,
  cache,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  if (cache.has(resolvedUrl)) {
    return cache.get(resolvedUrl);
  }

  const pending = (async () => {
    const response = await fetchWithTimeout(
      fetchImpl,
      resolvedUrl,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/pdf"
        }
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      return null;
    }

    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();

    if (
      contentType.includes("pdf") ||
      (contentType.includes("application/octet-stream") && looksLikePdfUrl(resolvedUrl))
    ) {
      if (typeof pdfTextExtractImpl !== "function") {
        return null;
      }

      const pdfBuffer = new Uint8Array(await response.arrayBuffer());
      const pdfText = await pdfTextExtractImpl(pdfBuffer, { resolvedUrl, source });

      if (!pdfText) {
        return null;
      }

      return {
        pageText: pdfText,
        pageDefaults: extractPagePublicationDefaults(pdfText)
      };
    }

    const html = await response.text();
    const metadataText = extractHtmlMetadataText(html);
    const relevantHtml = extractRelevantHtmlFragment(html);
    const structuredTableText = extractStructuredDetailTextFromHtml(relevantHtml);
    const bodyText = stripHtml(relevantHtml);
    const metadataDrivenText = normalizeWhitespace([metadataText, structuredTableText].filter(Boolean).join(" "));
    const prefersMetadataText =
      /\b(?:bauobjekt|bauvorhaben|bauprojekt|bauplatz|lage|bauherr|bauherrschaft)\b/i.test(metadataDrivenText) ||
      (/\b(?:baugesuch|baubewilligung)\b/i.test(metadataDrivenText) &&
        (streetLikeAddressPattern.test(metadataDrivenText) || /\bParz(?:elle|\.| Nr\.?)?\s*\d{1,6}\b/i.test(metadataDrivenText)));
    const pageText = prefersMetadataText
      ? metadataDrivenText
      : normalizeWhitespace([metadataText, structuredTableText, bodyText].filter(Boolean).join(" "));

    return {
      pageText,
      pageDefaults: mergePageDefaults(extractPagePublicationDefaults(metadataText), extractPagePublicationDefaults(pageText))
    };
  })().catch(() => null);

  cache.set(resolvedUrl, pending);
  return pending;
}

export function extractTableRowsFromHtml(html) {
  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch = null;

  while ((rowMatch = rowRegex.exec(String(html ?? ""))) !== null) {
    const cellMatches = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    const cells = cellMatches.map((match) => stripHtml(match[1])).filter(Boolean);

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

export function extractStructuredDetailTextFromHtml(html) {
  const rows = extractTableRowsFromHtml(html);

  if (rows.length === 0) {
    return "";
  }

  const snippets = [];
  const headerText = normalizeWhitespace(rows[0]?.join(" ") ?? "");
  const looksPublicationGrid = /\b(bauherr|bauprojekt|bauplatz|öffentliche auflage|auflage)\b/i.test(headerText);

  if (looksPublicationGrid) {
    for (const row of rows.slice(1)) {
      if (row.length < 3) {
        continue;
      }

      snippets.push(
        normalizeWhitespace(
          `Bauherrschaft: ${row[0] ?? ""} Bauvorhaben: ${row[1] ?? ""} Bauplatz: ${row[2] ?? ""} Auflagefrist: ${row[3] ?? ""}`
        )
      );
    }
  }

  for (const row of rows) {
    if (
      row.length === 2 &&
      row[0].length <= 40 &&
      /[A-Za-zÄÖÜäöü]/u.test(row[0]) &&
      !/\d/.test(row[0])
    ) {
      snippets.push(`${row[0]}: ${row[1]}`);
    }
  }

  return normalizeWhitespace([...new Set(snippets.filter(Boolean))].join(" "));
}
