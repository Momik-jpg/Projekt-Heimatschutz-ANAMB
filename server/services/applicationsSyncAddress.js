// Adress-, Parzellen- und Koordinaten-Extraktion
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  bgReferencePattern,
  clearlyNonAddressPattern,
  garbledStructuredTextPattern,
  genericDownloadPattern,
  genericLocationTermPattern,
  genericMunicipalityAnchorPattern,
  genericMunicipalityArchivePattern,
  genericMunicipalityListingPattern,
  looksLikeStandaloneDate,
  nonPendingPermitPattern,
  normalizeWhitespace,
  parcelLikeAddressPattern,
  projectLikeAddressPattern,
  streetLikeAddressPattern,
  stripHtml
} from "./applicationsSyncCommon.js";

export function sanitizeExtractedAddress(value) {
  const text = normalizeWhitespace(value)
    .replace(/^[,;:-]+\s*/, "")
    .replace(/\s*[,;:-]+$/, "");

  if (!text) {
    return "";
  }

  const cleanedText = normalizeWhitespace(
    text
      .replace(
        /\s+(?:öffentliche(?:\s+auflage)?|publiziert|publikation|veröffentlicht|frist(?:ende)?|einsprachfrist|auflage(?:frist)?|mehr lesen|zuletzt synchronisiert)\b[\s\S]*$/i,
        ""
      )
      .replace(
        /^(?:Bauherrschaft|Bauherr|Gesuchsteller(?:\/in)?|Grundeigentümer(?:\/in)?)\s*:\s*[^,;]+,\s*/i,
        ""
      )
      .replace(/^[–-]\s*20\d{2}(?:[-/.]\d+)?\s*-\s*,?\s*/i, "")
      .replace(
        /\b(?:öffentliche(?:\s+auflage)?|publiziert|publikation|veröffentlicht|frist(?:ende)?|einsprachfrist|auflage(?:frist)?|mehr lesen|zuletzt synchronisiert)\b[\s\S]*$/i,
        ""
      )
      .replace(/\.\s*(?:öffentliche(?:\s+auflage)?|publiziert|publikation|veröffentlicht|frist(?:ende)?|einsprachfrist|auflage(?:frist)?).*$/i, "")
      .replace(/\b(?:Zone(?:\(n\))?|Weitere Bewilligungen?|Kant(?:onale)?\.?\s+Zustimmung|Planauflage|Zusatzgesuche?)\b[\s\S]*$/i, "")
      .replace(/\bGebäude\s+Nr\.?\s*\d+[A-Za-z]?\b[;,]?\s*/gi, "")
      .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
  );
  const parcel = extractParcelFromText(cleanedText);

  if (!cleanedText) {
    return "";
  }

  if (!/[A-Za-zÄÖÜäöü0-9]/u.test(cleanedText)) {
    return "";
  }

  if (
    looksLikeStandaloneDate(cleanedText) ||
    /^(?:im|ab)?\s*(?:anfang|mitte|ende)?\s*(?:januar|februar|märz|maerz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+20\d{2}$/i.test(cleanedText) ||
    /^vom\s+\d{1,2}\.\s*(?:januar|februar|märz|maerz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+20\d{2}\s+bis\s+\d{1,2}\.\s*(?:januar|februar|märz|maerz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+20\d{2}$/i.test(cleanedText) ||
    /^(?:pdf|doc|src)\b[\w\s-]*\bbg\b/i.test(cleanedText) ||
    genericMunicipalityListingPattern.test(cleanedText) ||
    genericMunicipalityArchivePattern.test(cleanedText) ||
    garbledStructuredTextPattern.test(cleanedText)
  ) {
    return "";
  }

  if (nonPendingPermitPattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (genericDownloadPattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (bgReferencePattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (genericLocationTermPattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (
    clearlyNonAddressPattern.test(cleanedText) &&
    !streetLikeAddressPattern.test(cleanedText) &&
    !/\bParz(?:elle|\.| Nr\.?)?\b/i.test(cleanedText)
  ) {
    return "";
  }

  if (streetLikeAddressPattern.test(cleanedText)) {
    return cleanedText
      .replace(/^\s*Parz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\s*,?\s*/i, "")
      .replace(/\b(?:\d{4}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]+(?:\s*\([^)]+\))?)\b/gu, "")
      .replace(/^[,;:-]+\s*|\s*[,;:\-.]+$/g, "")
      .trim();
  }

  if (parcel) {
    return `Parzelle ${parcel}`;
  }

  return cleanedText;
}

export function shortenText(value, maxLength = 320) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

export function removeNonContentHtmlRegions(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(
      /<(div|section|ul)\b[^>]*(?:id|class)\s*=\s*(?:"[^"]*\b(?:navbar|navigation|sidebar|off-canvas|breadcrumb|menu|footer|header)[^"]*"|'[^']*\b(?:navbar|navigation|sidebar|off-canvas|breadcrumb|menu|footer|header)[^']*')[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    );
}

export function extractRelevantHtmlFragment(html) {
  const sanitizedHtml = removeNonContentHtmlRegions(html);
  const mainMatch = sanitizedHtml.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);

  if (mainMatch?.[0]) {
    return mainMatch[0];
  }

  const articleMatches = [...sanitizedHtml.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map((match) => match[0]);

  if (articleMatches.length > 0) {
    return articleMatches.join(" ");
  }

  return sanitizedHtml;
}

export function extractEnclosingBlockHtml(html, anchorIndex) {
  const blockTags = ["p", "li", "article", "section", "tr"];
  let bestMatch = "";
  let bestLength = Number.POSITIVE_INFINITY;

  for (const tag of blockTags) {
    const start = html.lastIndexOf(`<${tag}`, anchorIndex);
    const end = html.indexOf(`</${tag}>`, anchorIndex);

    if (start === -1 || end === -1 || start > anchorIndex || end < anchorIndex) {
      continue;
    }

    const blockHtml = html.slice(start, end + tag.length + 3);

    if (blockHtml.length < bestLength) {
      bestMatch = blockHtml;
      bestLength = blockHtml.length;
    }
  }

  return bestMatch;
}

export function extractMunicipalityUrlSignatureTokens(resolvedUrl) {
  try {
    const url = new URL(String(resolvedUrl ?? ""));
    const pathname = decodeURIComponent(url.pathname || "");
    const filename = pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.(?:html?|php|pdf)$/i, "")
      ?.replace(/[_-]+/g, " ")
      ?.trim() ?? "";
    const bgReference = pathname.match(/bg[-_.]?(20\d{2}(?:[-_.]?\d+)?)/i)?.[1] ?? "";

    return [...new Set(
      [pathname, filename, bgReference]
        .flatMap((value) => String(value ?? "").split(/\s+/))
        .map((value) => normalizeWhitespace(value).toLowerCase())
        .filter((value) => value.length >= 6)
    )];
  } catch {
    return [];
  }
}

export function narrowMunicipalityContextHtml(blockHtml, anchorText, resolvedUrl) {
  const normalizedBlockHtml = String(blockHtml ?? "").trim();

  if (!normalizedBlockHtml) {
    return "";
  }

  const blockSegments = normalizedBlockHtml
    .split(/(?:<br\s*\/?>\s*){2,}(?=\s*<strong>\s*(?:Bauherr|Bauherrschaft|Bauobjekt|Bauvorhaben|Bauplatz)\s*:)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (blockSegments.length <= 1) {
    return normalizedBlockHtml;
  }

  const normalizedAnchorText = normalizeWhitespace(anchorText);
  const genericAnchorText = genericMunicipalityAnchorPattern.test(normalizedAnchorText);
  const urlSignatureTokens = extractMunicipalityUrlSignatureTokens(resolvedUrl);
  let normalizedPathname = "";

  try {
    normalizedPathname = new URL(resolvedUrl).pathname;
  } catch {
    normalizedPathname = "";
  }

  let bestSegment = "";
  let bestScore = 0;
  let bestLength = Number.POSITIVE_INFINITY;

  for (const segment of blockSegments) {
    const strippedSegment = stripHtml(segment);
    const normalizedSegment = strippedSegment.toLowerCase();
    let score = 0;

    if (resolvedUrl && segment.includes(resolvedUrl)) {
      score += 10;
    }

    if (normalizedPathname && segment.includes(normalizedPathname)) {
      score += 8;
    }

    for (const token of urlSignatureTokens) {
      if (normalizedSegment.includes(token)) {
        score += token.startsWith("20") ? 6 : 3;
      }
    }

    if (normalizedAnchorText && !genericAnchorText && strippedSegment.includes(normalizedAnchorText)) {
      score += 4;
    }

    if (score > bestScore || (score === bestScore && score > 0 && segment.length < bestLength)) {
      bestSegment = segment;
      bestScore = score;
      bestLength = segment.length;
    }
  }

  return bestScore > 0 ? bestSegment : normalizedBlockHtml;
}

export function extractSwissCoordinatesFromText(value) {
  const match = String(value ?? "").match(/\b(2\d{6})\D+(1\d{6,7})\b/);

  if (!match) {
    return "";
  }

  return `${match[1]},${match[2]}`;
}

export function extractParcelFromText(value) {
  const match = String(value ?? "").match(
    /\bParz(?:ellen?|\.| Nr\.?)?\s*(?:[-:]|\s)*(?:(?:(?:GB|Grundbuch)\s+)?[\p{L}() .'-]+?\s+)?(?:Nrn?\.?|Nr\.?)?\s*(\d{1,6})\b/iu
  );
  return match?.[1] ?? "";
}

export function extractLabeledValue(value, label, trailingLabels = []) {
  const text = normalizeWhitespace(value);

  if (!text) {
    return "";
  }

  const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const trailingPattern = trailingLabels.length
    ? trailingLabels
        .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
        .join("|")
    : "";
  const pattern = trailingPattern
    ? new RegExp(`${labelPattern}\\s*:?\\s*(.+?)(?=\\b(?:${trailingPattern})\\b\\s*:|$)`, "i")
    : new RegExp(`${labelPattern}\\s*:?\\s*(.+)$`, "i");
  const match = text.match(pattern);

  return normalizeWhitespace(match?.[1] ?? "");
}

export function extractAddressFromText(value) {
  const text = normalizeWhitespace(value).replace(/\bBaugesuch(?:e)?\b[:\s-]*/i, "");
  const addressTrailingLabels = [
    "Bauherr",
    "Bauherrschaft",
    "Gesuchsteller/in",
    "Grundeigentümer/in",
    "Grundeigentümer",
    "Bauobjekt",
    "Bauvorhaben",
    "Bauprojekt",
    "Bewilligungen",
    "Weitere Bewilligung",
    "Weitere Bewilligungen",
    "Frist",
    "Auflagefrist",
    "Planauflage",
    "Projektverfasser",
    "Publiziert",
    "Publikation",
    "Zone",
    "Zone(n)"
  ];
  const labeledAddressValues = [
    extractLabeledValue(text, "Parzelle / Strasse", addressTrailingLabels),
    extractLabeledValue(text, "Parzelle/Strasse", addressTrailingLabels),
    extractLabeledValue(text, "Bauplatz", addressTrailingLabels),
    extractLabeledValue(text, "Baustelle", addressTrailingLabels),
    extractLabeledValue(text, "Standort", addressTrailingLabels),
    extractLabeledValue(text, "Lage", addressTrailingLabels)
  ].filter(Boolean);

  for (const labeledValue of labeledAddressValues) {
    const parcel = extractParcelFromText(labeledValue);
    const streetCandidate = sanitizeExtractedAddress(
      labeledValue
        .replace(/^\s*Parz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\s*,?\s*/i, "")
        .replace(/^\s*\d{1,6}\s*,\s*(?=[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-])/u, "")
        .replace(/,\s*Parz(?:elle|\.| Nr\.?)?.*$/i, "")
        .replace(/\bParz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\b/gi, "")
        .replace(/\bGebäude\s+Nr\.?\s*\d+[A-Za-z]?\b[;,]?\s*/gi, "")
        .replace(/\b(?:Zone(?:\(n\))?|Weitere Bewilligungen?|Kant(?:onale)?\.?\s+Zustimmung|Planauflage)\b.*$/i, "")
        .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
        .replace(/\s*\/\s*BG\s*20\d{2}\.\d+\b.*$/i, "")
        .replace(/\bBG\s*20\d{2}\.\d+\b.*$/i, "")
        .replace(/,\s*BG\s*20\d{2}\.\d+\b.*$/i, "")
        .trim()
    );

    if (
      streetCandidate &&
      (streetLikeAddressPattern.test(streetCandidate) ||
        (/\b\d{1,4}[A-Za-z]?\b/.test(streetCandidate) &&
          /[A-Za-zÄÖÜäöü]/u.test(streetCandidate) &&
          !looksLikeStandaloneDate(streetCandidate)))
    ) {
      return streetCandidate;
    }

    if (parcel) {
      return `Parzelle ${parcel}`;
    }
  }

  const patterns = [
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]*(?:strasse|strasse|weg|gasse|gässli|gaessli|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)\s+\d+[A-Za-z]?)\b/ui,
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]+)+(?:strasse|strasse|weg|gasse|gässli|gaessli|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)?\s+\d+[A-Za-z]?)\b/u
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const sanitized = sanitizeExtractedAddress(match[1]);

      if (sanitized) {
        return sanitized;
      }
    }
  }

  return "";
}

export function extractAddressFromPublicationTitle(value) {
  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    return "";
  }

  const slashSegments = normalizedValue
    .split(/\s*\/\s*/)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);

  for (let index = slashSegments.length - 1; index >= 0; index -= 1) {
    const candidate = extractAddressFromText(slashSegments[index]);

    if (candidate) {
      return candidate;
    }
  }

  return "";
}

export function extractAddressFromSourceUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const rawSegment =
      /^\d+$/.test(pathSegments.at(-1) ?? "") && pathSegments.length > 1
        ? pathSegments.at(-2) ?? ""
        : pathSegments.at(-1) ?? "";
    const lastSegment = decodeURIComponent(rawSegment)
      .replace(/\.(?:html?|php|pdf)$/i, "")
      .replace(/^bg[-_]?20\d{2}(?:[-_.]?\d+)?[-_]?/i, "")
      .replace(/_/g, " ")
      .replace(/-/g, " ");
    const normalizedSegment =
      !/[A-ZÄÖÜ]/u.test(lastSegment) && /[a-zäöü]/u.test(lastSegment)
        ? lastSegment
            .split(/\s+/)
            .map((segment) => {
              if (/^\d+[A-Za-z]?$/.test(segment)) {
                return segment;
              }

              return segment.charAt(0).toUpperCase() + segment.slice(1);
            })
            .join(" ")
        : lastSegment;

    return extractAddressFromText(normalizedSegment);
  } catch {
    return "";
  }
}

export function chooseMoreSpecificAddress(primaryAddress, secondaryAddress) {
  const primary = sanitizeExtractedAddress(primaryAddress);
  const secondary = sanitizeExtractedAddress(secondaryAddress);

  if (!primary) {
    return secondary;
  }

  if (!secondary) {
    return primary;
  }

  const primaryHasHouseNumber = /\d+[A-Za-z]?$/.test(primary);
  const secondaryHasHouseNumber = /\d+[A-Za-z]?$/.test(secondary);
  const primaryIsParcel = parcelLikeAddressPattern.test(primary);
  const secondaryIsParcel = parcelLikeAddressPattern.test(secondary);
  const primaryLooksStreetLike = streetLikeAddressPattern.test(primary);
  const secondaryLooksStreetLike = streetLikeAddressPattern.test(secondary);

  if (secondaryHasHouseNumber && !primaryHasHouseNumber) {
    return secondary;
  }

  if (primaryIsParcel && !secondaryIsParcel) {
    return secondary;
  }

  if (secondaryLooksStreetLike && !primaryLooksStreetLike) {
    return secondary;
  }

  if (primaryLooksStreetLike && secondaryLooksStreetLike) {
    if (secondary.includes("/") && !primary.includes("/")) {
      return secondary;
    }

    if (secondary.length > primary.length + 6) {
      return secondary;
    }
  }

  return primary;
}

export function formatImportedMunicipalityAddress(address) {
  const normalizedAddress = sanitizeExtractedAddress(address);

  if (!normalizedAddress) {
    return "";
  }

  if (/[A-ZÄÖÜ]/u.test(normalizedAddress) || !/[a-zäöü]/u.test(normalizedAddress)) {
    return normalizedAddress;
  }

  return normalizedAddress
    .split(/\s+/)
    .map((segment) => {
      if (/^\d+[A-Za-z]?$/.test(segment)) {
        return segment;
      }

      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(" ");
}

export function normalizeImportedMunicipalityAddress(address, parcel = "") {
  const normalizedAddress = sanitizeExtractedAddress(address);
  const looksStreetLike = streetLikeAddressPattern.test(normalizedAddress);
  const looksParcelLike = parcelLikeAddressPattern.test(normalizedAddress);

  if (
    !normalizedAddress ||
    normalizedAddress.length > 120 ||
    /(?:öffentliche auflage|baugesuch(?:-nr)?|publiziert|planauflage|auflagefrist|gemeindekanzlei)/i.test(normalizedAddress) ||
    (!looksStreetLike && !looksParcelLike && projectLikeAddressPattern.test(normalizedAddress)) ||
    /^\d{4,}/.test(normalizedAddress)
  ) {
    return parcel ? `Parzelle ${parcel}` : "";
  }

  return formatImportedMunicipalityAddress(normalizedAddress);
}
