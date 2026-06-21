// Automatische Erkennung von Gemeinde-Publikationsquellen.
// Orchestrator + Facade: die Belange (Validierung, Kandidaten, Suche) liegen in
// ./discovery/*; diese Datei haelt die stabile API-Oberflaeche per Re-Export und
// die Gesamtstrategie discoverMunicipalityPublicationUrl().
import { fetchWithTimeout } from "./applicationsSyncCommon.js";
import { normalizeMunicipalityResolvedUrl } from "./applicationsSyncMunicipality.js";
import {
  discoveryCommonPaths,
  getRootMunicipalityUrl,
  isSafePublicHttpUrl,
  slugifyForAggregator
} from "./discovery/discoveryValidation.js";
import {
  chooseBestDiscoveryCandidate,
  collectDiscoveryCandidatesFromHtml,
  collectDiscoveryCandidatesFromSitemap,
  mergeDiscoveryCandidate,
  scoreDiscoveryCandidateContent
} from "./discovery/discoveryCandidates.js";
import { collectDiscoveryCandidatesFromSiteSearch } from "./discovery/discoverySearch.js";

// Stabile Export-Oberflaeche (Tests und applicationsSyncSource konsumieren sie):
export * from "./discovery/discoveryValidation.js";
export * from "./discovery/discoveryCandidates.js";
export * from "./discovery/discoverySearch.js";

// Tries to locate an official building-application / publication page for a
// municipality whose configured source may be stale or only the homepage.
// Strategy:
//   1) scan the configured page and homepage for strongly matching links,
//   2) inspect sitemap entries that look like building-publication pages,
//   3) probe a small set of common publication paths on the same host,
//   4) fall back to the cantonal "amtliche-nachrichten.ch" notice aggregator.
// Every network call is timeout-bounded, SSRF-guarded and best-effort.
export async function discoverMunicipalityPublicationUrl(html, source, fetchImpl, requestTimeoutMs) {
  const baseUrl = String(source.sourceUrl ?? "").trim();

  if (!isSafePublicHttpUrl(baseUrl)) {
    return "";
  }

  const candidates = new Map();
  const scannedPages = new Set();
  const rootUrl = getRootMunicipalityUrl(baseUrl);

  const addHtmlCandidates = (pageHtml, pageUrl) => {
    if (!pageHtml || scannedPages.has(normalizeMunicipalityResolvedUrl(pageUrl))) {
      return;
    }

    scannedPages.add(normalizeMunicipalityResolvedUrl(pageUrl));

    for (const [url, score] of collectDiscoveryCandidatesFromHtml(pageHtml, pageUrl)) {
      mergeDiscoveryCandidate(candidates, url, score);
    }
  };

  addHtmlCandidates(String(html ?? ""), baseUrl);

  if (rootUrl && normalizeMunicipalityResolvedUrl(rootUrl) !== normalizeMunicipalityResolvedUrl(baseUrl)) {
    try {
      const rootResponse = await fetchWithTimeout(
        fetchImpl,
        rootUrl,
        { headers: { Accept: "text/html,application/xhtml+xml" } },
        requestTimeoutMs
      );

      if (rootResponse.ok) {
        addHtmlCandidates(await rootResponse.text(), rootUrl);
      }
    } catch {
      // Homepage fallback is optional.
    }
  }

  let root;

  try {
    root = new URL(rootUrl || baseUrl);
  } catch {
    return "";
  }

  const bestLinkedCandidate = await chooseBestDiscoveryCandidate(candidates, baseUrl, fetchImpl, requestTimeoutMs);

  if (bestLinkedCandidate) {
    return bestLinkedCandidate;
  }

  await collectDiscoveryCandidatesFromSiteSearch(`${root.protocol}//${root.host}/`, fetchImpl, requestTimeoutMs, candidates);

  const bestSearchCandidate = await chooseBestDiscoveryCandidate(candidates, baseUrl, fetchImpl, requestTimeoutMs);

  if (bestSearchCandidate) {
    return bestSearchCandidate;
  }

  await collectDiscoveryCandidatesFromSitemap(`${root.protocol}//${root.host}/`, fetchImpl, requestTimeoutMs, candidates);

  const bestSitemapCandidate = await chooseBestDiscoveryCandidate(candidates, baseUrl, fetchImpl, requestTimeoutMs);

  if (bestSitemapCandidate) {
    return bestSitemapCandidate;
  }

  for (const path of discoveryCommonPaths) {
    const probeUrl = `${root.protocol}//${root.host}${path}`;

    if (!isSafePublicHttpUrl(probeUrl) || normalizeMunicipalityResolvedUrl(probeUrl) === normalizeMunicipalityResolvedUrl(baseUrl)) {
      continue;
    }

    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        probeUrl,
        { headers: { Accept: "text/html,application/xhtml+xml" } },
        requestTimeoutMs
      );

      if (response.ok && scoreDiscoveryCandidateContent(probeUrl, await response.text(), 5) >= 8) {
        return probeUrl;
      }
    } catch {
      // Probing is best-effort; ignore unreachable paths.
    }
  }

  const slug = slugifyForAggregator(source.municipality);

  if (slug) {
    const aggregatorUrl = `https://www.amtliche-nachrichten.ch/${slug}`;

    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        aggregatorUrl,
        { headers: { Accept: "text/html,application/xhtml+xml" } },
        requestTimeoutMs
      );

      if (response.ok && scoreDiscoveryCandidateContent(aggregatorUrl, await response.text(), 2) >= 8) {
        return aggregatorUrl;
      }
    } catch {
      // The aggregator may not list this municipality; ignore.
    }
  }

  return "";
}
