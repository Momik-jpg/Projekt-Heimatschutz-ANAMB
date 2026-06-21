// Datums- und Projekttyp-Extraktion aus Publikationstexten
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import { extractPublicationDateRange } from "../domain/applicationImportNormalization.js";
import {
  extractLabeledValue,
  sanitizeExtractedAddress,
  shortenText
} from "./applicationsSyncAddress.js";
import {
  escapeRegExp,
  garbledProjectTypePattern,
  garbledStructuredTextPattern,
  genericDownloadPattern,
  genericMunicipalityArchivePattern,
  genericMunicipalityListingPattern,
  looksLikeStandaloneDate,
  monthYearListingPattern,
  nonPendingPermitPattern,
  normalizeDate,
  normalizeWhitespace,
  streetLikeAddressPattern,
  swissDateLikePatternSource
} from "./applicationsSyncCommon.js";

export function projectTypeSpecificity(projectType) {
  if (!projectType || projectType === "Nicht importieren") {
    return 0;
  }

  if (projectType === "Baugesuch") {
    return 1;
  }

  return 2;
}

export function cleanProjectFilePathText(value) {
  let normalized = normalizeWhitespace(value);

  if (!normalized || !/\\|\/|\.(?:pln|dwg|dxf|ifc|pdf)\b/i.test(normalized)) {
    return normalized;
  }

  const projectKeywordMatch = normalized.match(/\b(?:Bauprojekt|Bauvorhaben)\b\s+(.+)/i);

  if (projectKeywordMatch?.[1]) {
    normalized = projectKeywordMatch[1];
  }

  normalized = normalized
    .replace(/\b\d{4}\s+[A-ZÄÖÜ][\wÄÖÜäöüéèà .'-]+?\s+1:\d+\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
    .replace(/\b1:\d+\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
    .replace(/\b\d{1,2}\.\d{1,2}\.20\d{2}\s+[A-Z]{2,}.*$/i, "")
    .replace(/^[\\/\w.-]+\.(?:pln|dwg|dxf|ifc|pdf)\b\s*/i, "")
    .replace(/^[A-Z]\s+(?=\b(?:Bauprojekt|Bauvorhaben)\b)/i, "")
    .replace(/\s*[,;:-]+\s*$/g, "")
    .trim();

  return normalizeWhitespace(normalized);
}

export function normalizeImportedProjectType(projectType, sourceUrl = "") {
  let normalizedProjectType = normalizeWhitespace(projectType).replace(/^[,;:-]+\s*/, "");
  normalizedProjectType = cleanProjectFilePathText(normalizedProjectType);
  const hasAarauDetailFallback = /\.aarau\.ch\/.*\/bg[-_.]?20\d{2}/i.test(sourceUrl);

  if (!normalizedProjectType) {
    return hasAarauDetailFallback ? "Baugesuch" : "";
  }

  if (
    normalizedProjectType.length > 140 ||
    /(?:bauplatz|\blage\b|standort|bauherr|bauherrschaft|grundeigent|projektverfasser|publiziert|planauflage|weitere bewilligung|\[\s*mehr\s*\])/i.test(
      normalizedProjectType
    ) ||
    /^(?:zu den dokumenten|herunterladen|download|mehr lesen|seite drucken|öffnen|amtsblatt öffnen|agis-karte öffnen|übersichtsseite öffnen)$/i.test(
      normalizedProjectType
    ) ||
    /^öffentliche auflage\b/i.test(normalizedProjectType) ||
    garbledProjectTypePattern.test(normalizedProjectType) ||
    /^\d{4,}/.test(normalizedProjectType)
  ) {
    return hasAarauDetailFallback ? "Baugesuch" : "";
  }

  return normalizedProjectType;
}

export function extractDateRangeFromText(value) {
  return extractPublicationDateRange(normalizeWhitespace(value));
}

export function extractPublicationDateFromText(value) {
  const text = normalizeWhitespace(value);
  const range = extractDateRangeFromText(text);

  if (range.publicationDate) {
    return range.publicationDate;
  }

  const contextualMatch = text.match(
    new RegExp(`\\b(?:publiziert|publikation|veröffentlicht|auflage vom|aufgelegt am|vom)\\D{0,20}(${swissDateLikePatternSource})`, "i")
  );

  if (contextualMatch?.[1]) {
    return normalizeDate(contextualMatch[1]);
  }

  const isoDateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)?/);

  if (isoDateMatch?.[1]) {
    return isoDateMatch[1];
  }

  const firstMatch = text.match(new RegExp(`\\b(${swissDateLikePatternSource})\\b`, "i"));
  return firstMatch?.[1] ? normalizeDate(firstMatch[1]) : "";
}

export function extractDeadlineDateFromText(value) {
  const text = normalizeWhitespace(value);
  const range = extractDateRangeFromText(text);

  if (range.deadlineDate) {
    return range.deadlineDate;
  }

  const contextualMatch = text.match(
    new RegExp(
      `\\b(?:frist(?:ende)?|einsprachfrist|auflage(?:frist)?(?: bis| ende)?|bis spätestens|bis)\\D{0,20}(${swissDateLikePatternSource})`,
      "i"
    )
  );

  if (contextualMatch?.[1]) {
    return normalizeDate(contextualMatch[1]);
  }

  return "";
}

export function extractProjectTypeFromText(value, fallback = "", address = "", sourceUrl = "") {
  const projectTypeLabels = ["Bauobjekt", "Bauvorhaben", "Bauprojekt"];
  const projectTypeTrailingLabels = [
    "Bauplatz",
    "Baustelle",
    "Standort",
    "Lage",
    "Bauherr",
    "Bauherrschaft",
    "Gesuchsteller/in",
    "Grundeigentümer/in",
    "Grundeigentümer",
    "Projektverfasser",
    "Bewilligungen",
    "Weitere Bewilligung",
    "Weitere Bewilligungen",
    "Frist",
    "Auflagefrist",
    "Planauflage",
    "Publiziert",
    "Publikation"
  ];

  for (const label of projectTypeLabels) {
    const labeledValue = extractLabeledValue(value, label, projectTypeTrailingLabels);

    if (labeledValue) {
      return cleanPublicationProjectSegment(labeledValue, address).replace(/[.;:,]\s*$/u, "");
    }
  }

  const publicationTitleProjectType = extractProjectTypeFromPublicationTitle(value, address, sourceUrl);

  if (publicationTitleProjectType) {
    return publicationTitleProjectType;
  }

  const normalizedFallback = normalizeWhitespace(fallback);
  const normalizedValue = normalizeWhitespace(value);

  if (nonPendingPermitPattern.test(normalizedValue)) {
    return "Nicht importieren";
  }

  if (
    !normalizedFallback ||
    looksLikeStandaloneDate(normalizedFallback) ||
    genericMunicipalityListingPattern.test(normalizedFallback) ||
    genericMunicipalityArchivePattern.test(normalizedFallback) ||
    genericDownloadPattern.test(normalizedFallback)
  ) {
    return "Baugesuch";
  }

  return shortenText(normalizedFallback, 120);
}

export function cleanPublicationProjectSegment(value, address = "") {
  if (!value) {
    return "";
  }

  const normalizedAddress = sanitizeExtractedAddress(address);
  let text = normalizeWhitespace(value)
    .replace(/\s*-\s*(?:frist|auflage|publiziert)\b[\s\S]*$/i, "")
    .replace(/\bBG\s*20\d{2}(?:[-/.]\d+)?\b/gi, "")
    .replace(/\bBaugesuch(?:e)?\b[:\s-]*/gi, "")
    .replace(/\bÖffentliche(?:r|)? Auflage\b[:\s-]*/gi, "")
    .replace(/\bAmtliche Publikation(?:en)?\b[:\s-]*/gi, "")
    .replace(/\bPublikation\b[:\s-]*/gi, "")
    .replace(/\b(?:Gesuchsteller(?:\/in)?|Grundeigentümer(?:\/in)?|Bauherr(?:schaft)?|Projektverfasser)\b.*$/i, "")
    .replace(/\bZusatzgesuche?\b.*$/i, "")
    .replace(/\bFrist bis\b[\s\S]*$/i, "")
    .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
    .replace(/^[,;/\s-]+|[,;/\s-]+$/g, "")
    .trim();

  if (normalizedAddress) {
    text = text
      .replace(new RegExp(`(?:,|/)?\\s*${escapeRegExp(normalizedAddress)}\\b`, "i"), "")
      .replace(/^[,;/\s-]+|[,;/\s-]+$/g, "")
      .trim();
  }

  if (
    !text ||
    garbledStructuredTextPattern.test(text) ||
    genericDownloadPattern.test(text) ||
    genericMunicipalityArchivePattern.test(text) ||
    genericMunicipalityListingPattern.test(text) ||
    monthYearListingPattern.test(text) ||
    looksLikeStandaloneDate(text)
  ) {
    return "";
  }

  return shortenText(text, 120);
}

export function extractProjectTypeFromPublicationTitle(value, address = "", sourceUrl = "") {
  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    return "";
  }

  const rawSlashSegments = normalizedValue.split(/\s*\/\s*/).map((segment) => normalizeWhitespace(segment)).filter(Boolean);
  const baugesuchSegmentIndex = rawSlashSegments.findIndex((segment) => /\bbaugesuch\b/i.test(segment));

  if (baugesuchSegmentIndex >= 0 && rawSlashSegments[baugesuchSegmentIndex + 1]) {
    return cleanPublicationProjectSegment(rawSlashSegments[baugesuchSegmentIndex + 1], address);
  }

  const withoutDeadline = normalizedValue.replace(/\s*-\s*frist\b[\s\S]*$/i, "").trim();
  const normalizedAddress = sanitizeExtractedAddress(address);
  const publicationTitleSegments = normalizedValue
    .split(/\s*,\s*/)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);

  if (
    /^baugesuch$/i.test(publicationTitleSegments[0] ?? "") &&
    publicationTitleSegments.length >= 3 &&
    (streetLikeAddressPattern.test(publicationTitleSegments[2]) || /\bParz(?:elle|\.| Nr\.?)?\s*\d{1,6}\b/i.test(publicationTitleSegments[2]))
  ) {
    const likelyApplicant = publicationTitleSegments[1] ?? "";

    if (likelyApplicant && !streetLikeAddressPattern.test(likelyApplicant) && !/\bparz/i.test(likelyApplicant)) {
      return "Baugesuch";
    }
  }

  if (withoutDeadline.includes(";")) {
    const afterSemicolon = withoutDeadline.split(";").slice(1).join(";").trim();
    const semicolonCandidate = cleanPublicationProjectSegment(afterSemicolon, normalizedAddress);

    if (semicolonCandidate) {
      return semicolonCandidate;
    }
  }

  if (normalizedAddress) {
    const lowerTitle = withoutDeadline.toLowerCase();
    const lowerAddress = normalizedAddress.toLowerCase();
    const addressIndex = lowerTitle.indexOf(lowerAddress);

    if (addressIndex > 0) {
      const beforeAddress = withoutDeadline
        .slice(0, addressIndex)
        .replace(/[,\s;/-]+$/g, "")
        .trim();
      const segments = beforeAddress
        .split(/\s*[;,/]\s*/)
        .map((segment) => cleanPublicationProjectSegment(segment, normalizedAddress))
        .filter(Boolean);
      const lastSegment = segments.at(-1);

      if (lastSegment) {
        return lastSegment;
      }
    }
  }

  if (sourceUrl) {
    try {
      const url = new URL(String(sourceUrl));
      const filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "")
        .replace(/\.(?:html?|php|pdf)$/i, "")
        .replace(/[_-]+/g, " ");
      const filenameCandidate = cleanPublicationProjectSegment(filename, normalizedAddress);

      if (filenameCandidate) {
        return filenameCandidate;
      }
    } catch {
      // Ignore malformed urls and fall back to the existing heuristics.
    }
  }

  return "";
}

export function extractPagePublicationDefaults(pageText) {
  const headerText = normalizeWhitespace(pageText).slice(0, 1600);
  const rangeMatch = headerText.match(
    new RegExp(
      `\\b(?:öffentliche auflage|auflage|publikation)\\b[\\s\\S]{0,80}?\\bvom\\b\\s*(${swissDateLikePatternSource})[\\s\\S]{0,40}?\\bbis\\b\\s*(${swissDateLikePatternSource})`,
      "i"
    )
  );

  if (rangeMatch?.[1] && rangeMatch?.[2]) {
    return {
      publicationDate: normalizeDate(rangeMatch[1]),
      deadlineDate: normalizeDate(rangeMatch[2])
    };
  }

  const isoDateMatch = headerText.match(/\b(20\d{2}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)?/);

  if (isoDateMatch?.[1]) {
    return {
      publicationDate: isoDateMatch[1],
      deadlineDate: ""
    };
  }

  return {
    publicationDate: "",
    deadlineDate: ""
  };
}
