// Discovery-Belang: Kandidaten aus HTML/Sitemap sammeln, bewerten und den
// besten Treffer waehlen. Aus applicationsSyncDiscovery.js ausgelagert.
import {
  extractEnclosingBlockHtml,
  extractRelevantHtmlFragment
} from "../applicationsSyncAddress.js";
import {
  fetchWithTimeout,
  nonPendingPermitPattern,
  normalizeWhitespace,
  resolveHttpUrlReference,
  resolveSitemapUrls,
  stripHtml
} from "../applicationsSyncCommon.js";
import { normalizeMunicipalityResolvedUrl } from "../applicationsSyncMunicipality.js";
import {
  defaultDiscoveryCandidateProbeLimit,
  defaultDiscoverySitemapProbeLimit,
  discoveryConcretePublicationPattern,
  discoveryListingPagePattern,
  discoveryPublicationTextPattern,
  discoveryResultListingTextPattern,
  discoverySinglePublicationPathPattern,
  discoveryWrongTopicPattern,
  isSafePublicHttpUrl
} from "./discoveryValidation.js";

export function collectDiscoveryCandidatesFromHtml(html, baseUrl) {
  const candidates = new Map();
  let baseHost;

  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return candidates;
  }

  const anchorRegex = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const resolved = resolveHttpUrlReference(href, baseUrl);

    if (!resolved || resolved.hostname.toLowerCase() !== baseHost || !isSafePublicHttpUrl(resolved.toString())) {
      continue;
    }

    const anchorText = normalizeWhitespace(stripHtml(match[4]));
    const contextText = normalizeWhitespace(stripHtml(extractEnclosingBlockHtml(html, match.index)));
    let pathText = "";

    try {
      pathText = decodeURIComponent(`${resolved.pathname}${resolved.search}`).toLowerCase();
    } catch {
      pathText = `${resolved.pathname}${resolved.search}`.toLowerCase();
    }

    if (discoveryWrongTopicPattern.test(anchorText) || discoveryWrongTopicPattern.test(pathText)) {
      continue;
    }

    let score = 0;
    const candidateText = `${anchorText} ${contextText}`.trim();

    if (/baugesuch|baupublikation|baugesuchspublikation|auflage-baugesuch|auflagebaugesuche/.test(pathText)) {
      score += 6;
    } else if (/öffentliche-auflage|öffentliche-auflage|amtliche-publikation/.test(pathText)) {
      score += 4;
    } else if (/publikation/.test(pathText)) {
      score += 2;
    }

    if (/baugesuch|baupublikation|baugesuchspublikation/i.test(candidateText)) {
      score += 5;
    } else if (/öffentliche auflage|öffentliche auflage/i.test(candidateText)) {
      score += 4;
    } else if (/amtliche publikation|amtliches publikationsorgan/i.test(candidateText)) {
      score += 3;
    } else if (/publikation/i.test(candidateText)) {
      score += 1;
    }

    if (discoveryResultListingTextPattern.test(contextText)) {
      score += 3;
    }

    if (discoverySinglePublicationPathPattern.test(pathText)) {
      score -= 4;
    }

    if (score <= 0) {
      continue;
    }

    const key = resolved.toString();
    candidates.set(key, Math.max(candidates.get(key) ?? 0, score));
  }

  return candidates;
}

export function mergeDiscoveryCandidate(target, url, score) {
  if (!url || !isSafePublicHttpUrl(url)) {
    return;
  }

  const normalized = normalizeMunicipalityResolvedUrl(url) || url;
  target.set(normalized, {
    url,
    score: Math.max(target.get(normalized)?.score ?? 0, score)
  });
}

export function scoreDiscoveryCandidateContent(url, html, baseScore = 0) {
  let score = baseScore;
  const text = normalizeWhitespace(stripHtml(extractRelevantHtmlFragment(html) || html));
  const urlText = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
      return String(url ?? "").toLowerCase();
    }
  })();
  const scoringText = `${urlText} ${text}`;
  const pageHasPublicationText = discoveryPublicationTextPattern.test(text);
  const urlHasPublicationText = discoveryPublicationTextPattern.test(urlText);
  const buildingTermCount = (scoringText.match(/baugesuch|baugesuche|baupublikation|baugesuchspublikation/gi) ?? [])
    .length;
  const pageBuildingTermCount = (text.match(/baugesuch|baugesuche|baupublikation|baugesuchspublikation/gi) ?? [])
    .length;
  const linkedBuildingTermCount = (String(html ?? "").match(/<a\b[^>]*>[\s\S]*?(?:baugesuch|baugesuche|baupublikation|baugesuchspublikation)[\s\S]*?<\/a>/gi) ?? [])
    .length;

  if (!pageHasPublicationText && !urlHasPublicationText) {
    return -1;
  }

  if (
    !pageHasPublicationText &&
    urlHasPublicationText &&
    linkedBuildingTermCount === 0 &&
    !discoveryConcretePublicationPattern.test(text) &&
    !discoveryResultListingTextPattern.test(text)
  ) {
    return -1;
  }

  if (/baugesuch|baugesuche|baupublikation|baugesuchspublikation|auflage-baugesuch|auflagebaugesuche/.test(urlText)) {
    score += 10;
  } else if (/öffentliche-auflage|öffentliche-auflage/.test(urlText)) {
    score += 7;
  } else if (/amtliche-publikation|publikation/.test(urlText)) {
    score += 4;
  }

  if (/baugesuch|baugesuche|baupublikation|baugesuchspublikation/i.test(text)) {
    score += 8;
  }

  if (/öffentliche auflage|öffentliche auflage/i.test(text)) {
    score += 5;
  }

  if (/amtliche publikation|amtliches publikationsorgan/i.test(text)) {
    score += 3;
  }

  if (discoveryConcretePublicationPattern.test(text)) {
    score += 5;
  }

  if (discoveryListingPagePattern.test(urlText)) {
    score += 7;
  }

  if (discoveryResultListingTextPattern.test(text)) {
    score += 5;
  }

  if (pageBuildingTermCount >= 2) {
    score += 3;
  }

  if (buildingTermCount >= 3) {
    score += 5;
  }

  if (linkedBuildingTermCount >= 2) {
    score += 8;
  }

  if (/ebauportal\.ag\.ch|gesuch\.rbv-wsw\.ch|login-geschützt|login geschützt/i.test(scoringText)) {
    score -= 6;
  }

  if (nonPendingPermitPattern.test(scoringText)) {
    score -= 18;
  }

  if (discoverySinglePublicationPathPattern.test(urlText)) {
    score -= 22;
  }

  return score;
}

export async function collectDiscoveryCandidatesFromSitemap(rootUrl, fetchImpl, requestTimeoutMs, candidates) {
  let root;

  try {
    root = new URL(rootUrl);
  } catch {
    return;
  }

  const sitemapUrls = [
    `${root.protocol}//${root.host}/sitemap.xml`,
    `${root.protocol}//${root.host}/sitemap_index.xml`
  ];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        sitemapUrl,
        { headers: { Accept: "application/xml,text/xml,application/rss+xml,application/atom+xml" } },
        requestTimeoutMs
      );

      if (!response.ok) {
        continue;
      }

      const xml = await response.text();
      const urls = await resolveSitemapUrls(
        xml,
        { sourceUrl: sitemapUrl },
        fetchImpl,
        requestTimeoutMs
      );

      for (const candidateUrl of urls.slice(0, defaultDiscoverySitemapProbeLimit)) {
        let candidate;

        try {
          candidate = new URL(candidateUrl);
        } catch {
          continue;
        }

        if (candidate.hostname.toLowerCase() !== root.hostname.toLowerCase()) {
          continue;
        }

        const decodedPath = (() => {
          try {
            return decodeURIComponent(`${candidate.pathname}${candidate.search}`).toLowerCase();
          } catch {
            return `${candidate.pathname}${candidate.search}`.toLowerCase();
          }
        })();

        if (discoveryWrongTopicPattern.test(decodedPath)) {
          continue;
        }

        if (!discoveryPublicationTextPattern.test(decodedPath)) {
          continue;
        }

        mergeDiscoveryCandidate(
          candidates,
          candidate.toString(),
          /baugesuch|baupublikation|baugesuchspublikation/.test(decodedPath) ? 8 : 4
        );
      }
    } catch {
      // Sitemap discovery is optional and must not break a municipality sync.
    }
  }
}

export async function chooseBestDiscoveryCandidate(candidates, baseUrl, fetchImpl, requestTimeoutMs) {
  const baseKey = normalizeMunicipalityResolvedUrl(baseUrl);
  const sortedCandidates = [...candidates.values()]
    .filter((candidate) => normalizeMunicipalityResolvedUrl(candidate.url) !== baseKey)
    .sort((left, right) => right.score - left.score)
    .slice(0, defaultDiscoveryCandidateProbeLimit);
  let bestUrl = "";
  let bestScore = 0;

  for (const candidate of sortedCandidates) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        candidate.url,
        { headers: { Accept: "text/html,application/xhtml+xml" } },
        requestTimeoutMs
      );

      if (!response.ok) {
        continue;
      }

      const score = scoreDiscoveryCandidateContent(candidate.url, await response.text(), candidate.score);

      if (score > bestScore) {
        bestScore = score;
        bestUrl = candidate.url;
      }
    } catch {
      // Candidate probing is best-effort.
    }
  }

  return bestScore >= 8 ? bestUrl : "";
}
