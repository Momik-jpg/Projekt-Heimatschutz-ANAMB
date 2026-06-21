// PDF-Extraktion und PDF-Importe
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  extractAddressFromText,
  extractParcelFromText,
  extractSwissCoordinatesFromText,
  shortenText
} from "./applicationsSyncAddress.js";
import {
  extractPdfTextFromBuffer,
  houseNumberAddressPattern,
  normalizeWhitespace,
  parcelLikeAddressPattern,
  streetLikeAddressPattern
} from "./applicationsSyncCommon.js";
import {
  geocodeMunicipalityAddress
} from "./applicationsSyncGeocode.js";
import {
  matchesMunicipalityCandidate
} from "./applicationsSyncHtml.js";
import {
  buildMunicipalitySourceReference
} from "./applicationsSyncMunicipality.js";
import {
  extractDeadlineDateFromText,
  extractProjectTypeFromText,
  extractPublicationDateFromText,
  normalizeImportedProjectType
} from "./applicationsSyncPublication.js";
import {
  isWeakImportedAddress,
  loadMunicipalityDetailPageData,
  normalizeAddressWithContext
} from "./applicationsSyncRefinement.js";

export async function buildPdfImportedItems(
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const detailCache = new Map();
  const geocodeCache = new Map();
  const detailPage = await loadMunicipalityDetailPageData(
    source.sourceUrl,
    source,
    fetchImpl,
    requestTimeoutMs,
    detailCache,
    pdfTextExtractImpl
  );

  if (!detailPage?.pageText) {
    return {
      rawCount: 1,
      items: []
    };
  }

  const candidateText = normalizeWhitespace(detailPage.pageText);
  const candidateDefaults = detailPage.pageDefaults;

  if (!matchesMunicipalityCandidate(source, source.sourceUrl, candidateText, true, candidateDefaults, candidateText)) {
    return {
      rawCount: 1,
      items: []
    };
  }

  let coordinates = extractSwissCoordinatesFromText(`${source.sourceUrl} ${candidateText}`);
  const parcel = extractParcelFromText(candidateText);
  const address =
    normalizeAddressWithContext(extractAddressFromText(candidateText), parcel, candidateText) ||
    (parcel ? `Parzelle ${parcel}` : "Adresse von PDF prüfen");

  if (address === "Adresse von PDF prüfen") {
    return {
      rawCount: 1,
      items: []
    };
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
    "";
  const projectType = normalizeImportedProjectType(
    extractProjectTypeFromText(candidateText, "Baugesuch", address, source.sourceUrl),
    source.sourceUrl
  );

  if ((!publicationDate && !deadlineDate) || !projectType || projectType === "Nicht importieren") {
    return {
      rawCount: 1,
      items: []
    };
  }

  const ambiguousAddress = !coordinates;

  return {
    rawCount: 1,
    items: [
      {
        source: "Gemeinde-PDF",
        sourceReference: buildMunicipalitySourceReference(source, source.sourceUrl, candidateText),
        sourceUrl: source.sourceUrl,
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
          ? "Standort konnte aus dem offiziellen PDF noch nicht eindeutig geokodiert werden."
          : "Standort wurde aus dem offiziellen PDF automatisch übernommen.",
        ambiguousAddress: ambiguousAddress ? 1 : 0
      }
    ]
  };
}
