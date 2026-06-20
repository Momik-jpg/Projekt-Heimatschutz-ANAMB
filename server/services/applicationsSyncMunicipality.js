// Gemeinde-spezifische Quellen- und Detailseitenlogik
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  extractRelevantHtmlFragment
} from "./applicationsSyncAddress.js";
import {
  bgReferencePattern,
  buildGeneratedSourceReference,
  collapseRepeatedLeadingPathSegments,
  decodeHtmlEntities,
  defaultHtmlKeywordsPattern,
  explicitPermitSignalPattern,
  extractAttributeValue,
  extractStructuredMetadataText,
  fetchWithTimeout,
  firstNonEmptyValue,
  genericMunicipalityArchivePattern,
  genericMunicipalityListingPattern,
  genericMunicipalityPublicationRoutePattern,
  municipalityBulletinPattern,
  municipalitySearchResultPattern,
  nonMunicipalPermitProcedurePattern,
  nonPendingPermitPattern,
  nonPermitMunicipalityTopicPattern,
  nonPermitMunicipalityUrlPattern,
  normalizeWhitespace,
  resolveHttpUrlReference,
  streetLikeAddressPattern,
  stripHtml
} from "./applicationsSyncCommon.js";
import {
  extractDeadlineDateFromText
} from "./applicationsSyncPublication.js";

export function looksLikeTrustedEmbeddedSource(resolvedUrl, sourceUrl) {
  try {
    const resolved = new URL(String(resolvedUrl ?? ""));
    const source = new URL(String(sourceUrl ?? ""));
    const sameOrigin = resolved.origin === source.origin;
    const officialPath =
      /\b(baugesuch|baugesuche|baubewilligung|publikation|auflage|amtlich|ebau|diba)\b/i.test(
        `${resolved.pathname} ${resolved.search}`
      );
    const officialHost = /\.ch$/i.test(resolved.hostname) || /\.ag\.ch$/i.test(resolved.hostname);

    return !looksLikePdfUrl(resolved.toString()) && (sameOrigin || (officialHost && officialPath));
  } catch {
    return false;
  }
}

export function extractEmbeddedMunicipalityFrameCandidates(html, sourceUrl) {
  const candidates = [];
  const seenUrls = new Set();
  const iframeRegex = /<iframe\b([^>]*)>/gi;
  let match = null;

  while ((match = iframeRegex.exec(String(html ?? ""))) !== null) {
    const attributes = match[1] ?? "";
    const srcdoc = extractAttributeValue(attributes, "srcdoc");

    if (srcdoc) {
      candidates.push({
        inlineHtml: srcdoc
      });
    }

    const src = resolveHttpUrlReference(extractAttributeValue(attributes, "src"), sourceUrl);

    if (!src) {
      continue;
    }

    try {
      const resolvedUrl = src.toString();

      if (!looksLikeTrustedEmbeddedSource(resolvedUrl, sourceUrl) || seenUrls.has(resolvedUrl)) {
        continue;
      }

      seenUrls.add(resolvedUrl);
      candidates.push({
        url: resolvedUrl
      });
    } catch {
      // Ignore malformed iframe urls.
    }
  }

  return candidates.slice(0, 3);
}

export function buildMunicipalitySourceReference(source, resolvedUrl, contextText) {
  return buildGeneratedSourceReference([source.id, source.municipality, resolvedUrl, contextText]);
}

export function normalizeMunicipalityResolvedUrl(resolvedUrl) {
  try {
    const url = new URL(String(resolvedUrl ?? ""));
    url.hash = "";
    url.pathname = collapseRepeatedLeadingPathSegments(url.pathname);
    return url.toString();
  } catch {
    return normalizeWhitespace(resolvedUrl);
  }
}

export function hasExplicitPermitSignal(value) {
  return explicitPermitSignalPattern.test(String(value ?? ""));
}

export function looksLikeGenericSearchResult(resolvedUrl, text) {
  const combined = normalizeWhitespace(`${resolvedUrl ?? ""} ${text ?? ""}`);
  return municipalitySearchResultPattern.test(combined) && !looksLikeMunicipalityDetailUrl(resolvedUrl);
}

export function looksLikeNonPermitMunicipalityContent(value, resolvedUrl = "") {
  const text = normalizeWhitespace(value);
  const combined = normalizeWhitespace(`${resolvedUrl} ${text}`);

  if (!text) {
    return false;
  }

  if (looksLikeGenericSearchResult(resolvedUrl, text)) {
    return true;
  }

  if (nonPermitMunicipalityUrlPattern.test(String(resolvedUrl ?? ""))) {
    return true;
  }

  if (genericMunicipalityPublicationRoutePattern.test(String(resolvedUrl ?? ""))) {
    return true;
  }

  if (municipalityBulletinPattern.test(combined)) {
    return true;
  }

  if (nonMunicipalPermitProcedurePattern.test(combined)) {
    return true;
  }

  if (nonPermitMunicipalityTopicPattern.test(combined) && !hasExplicitPermitSignal(combined)) {
    return true;
  }

  return false;
}

export function buildMunicipalityLinkedSourceReference(source, resolvedUrl, contextText) {
  const normalizedResolvedUrl = normalizeMunicipalityResolvedUrl(resolvedUrl);

  if (normalizedResolvedUrl && normalizedResolvedUrl !== normalizeMunicipalityResolvedUrl(source.sourceUrl)) {
    return buildGeneratedSourceReference([source.id, source.municipality, normalizedResolvedUrl]);
  }

  return buildMunicipalitySourceReference(source, resolvedUrl, contextText);
}

export function mergePageDefaults(...values) {
  return {
    publicationDate: firstNonEmptyValue(...values.map((value) => value?.publicationDate ?? "")),
    deadlineDate: firstNonEmptyValue(...values.map((value) => value?.deadlineDate ?? ""))
  };
}

export function looksLikePdfUrl(value) {
  const normalizedValue = String(value ?? "").trim();

  if (!normalizedValue) {
    return false;
  }

  try {
    const url = new URL(normalizedValue);

    if (/\.pdf$/i.test(url.pathname)) {
      return true;
    }

    const decodedPath = decodeURIComponent(`${url.pathname} ${url.search} ${url.hash}`);

    if (/\.pdf\b/i.test(decodedPath)) {
      return true;
    }

    for (const key of ["file", "download", "document", "doc", "attachment"]) {
      const paramValue = url.searchParams.get(key);

      if (paramValue && /\.pdf(?:$|[?#])/i.test(decodeURIComponent(paramValue))) {
        return true;
      }
    }

    return false;
  } catch {
    return /\.pdf(?:$|[?#])/i.test(normalizedValue);
  }
}

export function looksLikeListingSourceUrl(resolvedUrl, sourceUrl) {
  try {
    const resolved = new URL(resolvedUrl);
    const source = new URL(sourceUrl);

    if (resolved.toString() === source.toString()) {
      return true;
    }

    return /\/(?:category|tag|author|feed|newsarchive)(?:\/|$)|\/route\/rss/i.test(
      `${resolved.pathname}${resolved.search}`
    );
  } catch {
    return false;
  }
}

export function looksLikeMunicipalityDetailUrl(resolvedUrl) {
  try {
    const url = new URL(resolvedUrl);
    return /\/news\/\d+\b|detailansicht|tt_news|\/baugesuch[-_/]|\/bg[-_.]?20\d{2}/i.test(
      `${url.pathname}${url.search}`
    );
  } catch {
    return false;
  }
}

export function extractHtmlMetadataText(html) {
  const snippets = [];
  const normalizedHtml = String(html ?? "");
  const titleMatch = normalizedHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);

  if (titleMatch?.[1]) {
    snippets.push(stripHtml(titleMatch[1]));
  }

  const metaRegex =
    /<meta\b[^>]*(?:name|property)\s*=\s*(?:"(?:description|og:description|twitter:description|article:published_time)"|'(?:description|og:description|twitter:description|article:published_time)')[^>]*content\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let metaMatch = null;

  while ((metaMatch = metaRegex.exec(normalizedHtml)) !== null) {
    const content = decodeHtmlEntities(metaMatch[1] ?? metaMatch[2] ?? "");

    if (content) {
      snippets.push(content);
    }
  }

  const structuredMetadataText = extractStructuredMetadataText(normalizedHtml);

  if (structuredMetadataText) {
    snippets.push(structuredMetadataText);
  }

  return normalizeWhitespace(snippets.join(" "));
}

export async function loadEmbeddedMunicipalityRelevantHtml(html, source, fetchImpl, requestTimeoutMs, cache) {
  const candidates = extractEmbeddedMunicipalityFrameCandidates(html, source.sourceUrl);

  if (candidates.length === 0) {
    return "";
  }

  const snippets = [];

  for (const candidate of candidates) {
    if (candidate.inlineHtml) {
      const inlineRelevantHtml = extractRelevantHtmlFragment(candidate.inlineHtml);
      const inlineText = normalizeWhitespace(
        [extractHtmlMetadataText(candidate.inlineHtml), stripHtml(inlineRelevantHtml)].filter(Boolean).join(" ")
      );

      if (
        inlineText &&
        !genericMunicipalityListingPattern.test(inlineText) &&
        !genericMunicipalityArchivePattern.test(inlineText) &&
        (defaultHtmlKeywordsPattern.test(inlineText) || bgReferencePattern.test(inlineText))
      ) {
        snippets.push(inlineRelevantHtml);
      }

      continue;
    }

    if (!fetchImpl || !candidate.url) {
      continue;
    }

    const cacheKey = `iframe:${candidate.url}`;
    let embeddedHtml = "";

    if (cache.has(cacheKey)) {
      embeddedHtml = await cache.get(cacheKey);
    } else {
      const pending = (async () => {
        const response = await fetchWithTimeout(
          fetchImpl,
          candidate.url,
          {
            headers: {
              Accept: "text/html,application/xhtml+xml"
            }
          },
          requestTimeoutMs
        );

        if (!response.ok) {
          return "";
        }

        const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();

        if (
          contentType.includes("pdf") ||
          contentType.includes("application/octet-stream") ||
          !(contentType.includes("html") || contentType.includes("xml") || contentType.includes("xhtml"))
        ) {
          return "";
        }

        return response.text();
      })().catch(() => "");

      cache.set(cacheKey, pending);
      embeddedHtml = await pending;
    }

    if (!embeddedHtml) {
      continue;
    }

    const embeddedRelevantHtml = extractRelevantHtmlFragment(embeddedHtml);
    const embeddedText = normalizeWhitespace(
      [extractHtmlMetadataText(embeddedHtml), stripHtml(embeddedRelevantHtml)].filter(Boolean).join(" ")
    );

    if (
      embeddedText &&
      !genericMunicipalityListingPattern.test(embeddedText) &&
      !genericMunicipalityArchivePattern.test(embeddedText) &&
      !nonPendingPermitPattern.test(embeddedText) &&
      (defaultHtmlKeywordsPattern.test(embeddedText) ||
        bgReferencePattern.test(embeddedText) ||
        (streetLikeAddressPattern.test(embeddedText) && extractDeadlineDateFromText(embeddedText)))
    ) {
      snippets.push(embeddedRelevantHtml);
    }
  }

  return snippets.join("\n");
}
