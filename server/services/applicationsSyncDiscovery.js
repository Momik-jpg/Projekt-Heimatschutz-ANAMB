// Automatische Erkennung von Gemeinde-Publikationsquellen
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  extractEnclosingBlockHtml,
  extractRelevantHtmlFragment
} from "./applicationsSyncAddress.js";
import {
  decodeHtmlEntities,
  fetchWithTimeout,
  nonPendingPermitPattern,
  normalizeWhitespace,
  resolveHttpUrlReference,
  resolveSitemapUrls,
  stripHtml
} from "./applicationsSyncCommon.js";
import {
  normalizeMunicipalityResolvedUrl
} from "./applicationsSyncMunicipality.js";

export const discoveryWrongTopicPattern =
  /(einbürger|einbürger|fahrplan|verkehrsverbund|\bzvv\b|gemeindeversammlung|abstimmung|\bwahlen\b|newsletter|veranstaltung|\bagenda\b|kontakt|impressum|datenschutz|\blogin\b|\bjobs\b|stellen|bibliothek|kindergarten|erteilte baubewilligung|erteilte bewilligung|baubewilligung erteilt)/i;

export const discoveryPublicationTextPattern =
  /(baugesuch|baupublikation|baugesuchspublikation|öffentliche auflage|öffentliche auflage|amtliche publikation|amtliches publikationsorgan|baubewilligung)/i;

export const discoveryConcretePublicationPattern =
  /(bauherrschaft|bauobjekt|bauplatz|orts?lage|parzelle|planauflage|einwendungen|einsprachefrist|auflage vom|rubrik auswählen\s+alle rubriken[\s\S]*baugesuche)/i;

export const discoveryCommonPaths = [
  "/baugesuche",
  "/baupublikationen",
  "/amtliche-publikationen",
  "/amtlichepublikationen",
  "/amtlpublikationen",
  "/aktuelles/amtliche-publikationen",
  "/aktuelles/amtlichepublikationen",
  "/infospublikationen/baugesuchspublikationen",
  "/publikationen",
  "/öffentliche-auflage",
  "/oeffentliche-auflage",
  "/baugesuchspublikationen",
  "/baugesuchs-publikationen",
  "/auflagebaugesuche",
  "/aktuelles",
  "/news",
  "/gemeinde/aktuelles",
  "/portraet/aktuelles"
];

export const defaultDiscoveryCandidateProbeLimit = Math.max(3, Number(process.env.MUNICIPALITY_DISCOVERY_CANDIDATE_LIMIT ?? 12));

export const defaultDiscoverySitemapProbeLimit = Math.max(5, Number(process.env.MUNICIPALITY_DISCOVERY_SITEMAP_LIMIT ?? 60));

export const discoverySearchTerms = [
  "Baugesuche",
  "Baugesuch",
  "Baupublikation",
  "Baugesuchspublikation",
  "Öffentliche Auflage",
  "Amtliche Publikation Baugesuch"
];

export const discoverySearchPaths = ["/suche/", "/suche", "/search/", "/search", "/recherche/", "/recherche"];

export const discoverySinglePublicationPathPattern =
  /(?:\/news-detail\/|\/archiv-detail\/|\/artikel\/|\/news\/\d+\b|\/_rte\/information\/\d+\b|\/\d{4}\/\d{2}\/\d{2}\/)/i;

export const discoveryListingPagePattern =
  /(?:baugesuche?$|baupublikationen?|baugesuchspublikationen?|baugesuchs-publikationen?|auflagebaugesuche|amtliche-publikationen?|amtlichepublikationen?|amtlpublikationen?|infospublikationen|publikationen?|oeffentliche-auflage|öffentliche-auflage|laufende-auflagen|aktuell(?:es)?$)/i;

export const discoveryResultListingTextPattern =
  /(anzeige der ergebnisse|ergebnisse\s+\d+\s+bis|insgesamt\s+\d+|rubrik|alle rubriken|amtliche publikationen|amtliches publikationsorgan|limmatwelle|öffentliche auflagen|öffentliche auflagen)/i;

// Defensive guard against SSRF: only allow public http(s) hosts, never internal
// networks, loopback, link-local or *.local/*.internal names.
export function isSafePublicHttpUrl(value) {
  let parsed;

  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return false;
  }

  if (host.includes(":")) {
    // IPv6 literal (e.g. ::1) — reject to stay on the safe side.
    return false;
  }

  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);

    if (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return false;
    }
  }

  return true;
}

export function getRootMunicipalityUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return "";
  }
}

export function slugifyForAggregator(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractHtmlAttributes(tag) {
  const attributes = {};
  const attributeRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match = null;

  while ((match = attributeRegex.exec(String(tag ?? ""))) !== null) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }

  return attributes;
}

export function buildDiscoverySearchRequestsFromHtml(html, baseUrl) {
  const requests = [];
  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch = null;

  while ((formMatch = formRegex.exec(String(html ?? ""))) !== null) {
    const formAttributes = extractHtmlAttributes(formMatch[1]);
    const formBody = formMatch[2] ?? "";
    const action = formAttributes.action || baseUrl;
    let actionUrl = "";

    try {
      actionUrl = new URL(action, baseUrl).toString();
    } catch {
      continue;
    }

    const method = String(formAttributes.method || "get").toLowerCase() === "post" ? "POST" : "GET";
    const formHint = `${actionUrl} ${formAttributes.id ?? ""} ${formAttributes.class ?? ""} ${formBody}`;

    if (!/suche|search|recherche|indexedsearch|kesearch/i.test(formHint)) {
      continue;
    }

    const params = new URLSearchParams();
    const inputTags = [...formBody.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
    let searchFieldName = "";

    for (const tag of inputTags) {
      const inputAttributes = extractHtmlAttributes(tag);
      const name = inputAttributes.name;

      if (!name) {
        continue;
      }

      const type = String(inputAttributes.type || "text").toLowerCase();

      if (type === "button" || type === "image" || type === "file") {
        continue;
      }

      params.set(name, inputAttributes.value ?? "");

      if (
        !searchFieldName &&
        (/\[(?:sword|query|q|search)\]$/i.test(name) ||
          /(?:^|[_-])(?:sword|query|q|search)$/i.test(name))
      ) {
        searchFieldName = name;
      }
    }

    if (!searchFieldName) {
      const textInput = inputTags
        .map((tag) => extractHtmlAttributes(tag))
        .find((input) => input.name && /^(?:text|search)?$/i.test(input.type || "text"));
      searchFieldName = textInput?.name ?? "";
    }

    if (!searchFieldName) {
      continue;
    }

    for (const term of discoverySearchTerms) {
      const searchParams = new URLSearchParams(params);
      searchParams.set(searchFieldName, term);
      requests.push({
        url: actionUrl,
        method,
        body: searchParams
      });
    }
  }

  return requests;
}

export function collectOpenSearchDescriptionUrlsFromHtml(html, baseUrl) {
  const urls = [];
  let baseHost = "";

  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return urls;
  }

  for (const match of String(html ?? "").matchAll(/<link\b[^>]*>/gi)) {
    const attributes = extractHtmlAttributes(match[0]);
    const rel = String(attributes.rel ?? "").toLowerCase();
    const type = String(attributes.type ?? "").toLowerCase();
    const href = attributes.href ?? "";

    if (!href || !/\bsearch\b/.test(rel) || !/opensearchdescription\+xml/.test(type)) {
      continue;
    }

    const resolved = resolveHttpUrlReference(href, baseUrl);

    if (!resolved || resolved.hostname.toLowerCase() !== baseHost || !isSafePublicHttpUrl(resolved.toString())) {
      continue;
    }

    urls.push(resolved.toString());
  }

  return urls;
}

export function buildDiscoverySearchRequestsFromOpenSearchXml(xml, descriptionUrl) {
  const requests = [];
  const seenTemplates = new Set();
  let descriptionHost = "";

  try {
    descriptionHost = new URL(descriptionUrl).hostname.toLowerCase();
  } catch {
    return requests;
  }

  for (const match of String(xml ?? "").matchAll(/<Url\b[^>]*>/gi)) {
    const attributes = extractHtmlAttributes(match[0]);
    const type = String(attributes.type ?? "text/html").toLowerCase();
    const template = attributes.template ?? "";

    if (!template || !/html|xhtml/.test(type) || !/\{searchTerms\??\}/i.test(template)) {
      continue;
    }

    if (seenTemplates.has(template)) {
      continue;
    }

    seenTemplates.add(template);

    for (const term of discoverySearchTerms) {
      const searchUrl = template
        .replace(/\{searchTerms\??\}/gi, encodeURIComponent(term))
        .replace(/\{[^}]+\}/g, "");

      const resolved = resolveHttpUrlReference(searchUrl, descriptionUrl);

      if (!resolved || resolved.hostname.toLowerCase() !== descriptionHost || !isSafePublicHttpUrl(resolved.toString())) {
        continue;
      }

      requests.push({
        url: resolved.toString(),
        method: "GET",
        body: new URLSearchParams()
      });
    }
  }

  return requests;
}

export async function buildDiscoverySearchRequestsFromOpenSearchLinks(html, baseUrl, fetchImpl, requestTimeoutMs) {
  const requests = [];

  for (const descriptionUrl of collectOpenSearchDescriptionUrlsFromHtml(html, baseUrl)) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        descriptionUrl,
        { headers: { Accept: "application/opensearchdescription+xml,application/xml,text/xml" } },
        requestTimeoutMs
      );

      if (!response.ok) {
        continue;
      }

      requests.push(...buildDiscoverySearchRequestsFromOpenSearchXml(await response.text(), descriptionUrl));
    } catch {
      // OpenSearch is optional; regular site search still runs below.
    }
  }

  return requests;
}

export function buildFallbackDiscoverySearchRequests(rootUrl) {
  const requests = [];
  const queryNames = [
    "q",
    "query",
    "search",
    "s",
    "term",
    "tx_kesearch_pi1[sword]",
    "tx_indexedsearch_pi2[search][sword]"
  ];

  for (const path of discoverySearchPaths) {
    let actionUrl = "";

    try {
      actionUrl = new URL(path, rootUrl).toString();
    } catch {
      continue;
    }

    for (const queryName of queryNames) {
      for (const term of discoverySearchTerms) {
        const body = new URLSearchParams();
        body.set(queryName, term);
        requests.push({
          url: actionUrl,
          method: "GET",
          body
        });
      }
    }
  }

  return requests;
}

export function buildDiscoverySearchRequestUrl(request) {
  const query = request.body?.toString?.() ?? "";

  if (request.method !== "GET" || !query) {
    return request.url;
  }

  return `${request.url}${request.url.includes("?") ? "&" : "?"}${query}`;
}

export async function collectDiscoveryCandidatesFromSiteSearch(rootUrl, fetchImpl, requestTimeoutMs, candidates) {
  let root;

  try {
    root = new URL(rootUrl);
  } catch {
    return;
  }

  const searchPageUrls = [
    rootUrl,
    ...discoverySearchPaths.map((path) => `${root.protocol}//${root.host}${path}`)
  ];
  const seenSearchPages = new Set();
  const seenRequests = new Set();

  for (const searchPageUrl of searchPageUrls) {
    const normalizedSearchPageUrl = normalizeMunicipalityResolvedUrl(searchPageUrl);

    if (seenSearchPages.has(normalizedSearchPageUrl) || !isSafePublicHttpUrl(searchPageUrl)) {
      continue;
    }

    seenSearchPages.add(normalizedSearchPageUrl);

    try {
      const pageResponse = await fetchWithTimeout(
        fetchImpl,
        searchPageUrl,
        { headers: { Accept: "text/html,application/xhtml+xml" } },
        requestTimeoutMs
      );

      if (!pageResponse.ok) {
        continue;
      }

      const pageHtml = await pageResponse.text();
      const searchRequests = [
        ...(await buildDiscoverySearchRequestsFromOpenSearchLinks(pageHtml, searchPageUrl, fetchImpl, requestTimeoutMs)),
        ...buildDiscoverySearchRequestsFromHtml(pageHtml, searchPageUrl),
        ...(normalizedSearchPageUrl === normalizeMunicipalityResolvedUrl(rootUrl)
          ? []
          : buildFallbackDiscoverySearchRequests(searchPageUrl).slice(0, discoverySearchTerms.length * 2))
      ];

      for (const request of searchRequests) {
        const requestKey = `${request.method}:${request.url}:${request.body.toString()}`;

        if (seenRequests.has(requestKey)) {
          continue;
        }

        seenRequests.add(requestKey);

        try {
          const response = await fetchWithTimeout(
            fetchImpl,
            request.method === "GET" ? buildDiscoverySearchRequestUrl(request) : request.url,
            request.method === "GET"
              ? { headers: { Accept: "text/html,application/xhtml+xml" } }
              : {
                  method: "POST",
                  headers: {
                    Accept: "text/html,application/xhtml+xml",
                    "Content-Type": "application/x-www-form-urlencoded"
                  },
                  body: request.body
                },
            requestTimeoutMs
          );

          if (!response.ok) {
            continue;
          }

          const resultHtml = await response.text();

          for (const [url, score] of collectDiscoveryCandidatesFromHtml(resultHtml, request.url)) {
            mergeDiscoveryCandidate(candidates, url, score + 4);
          }
        } catch {
          // Site search is optional; keep discovery best-effort.
        }
      }
    } catch {
      // Some municipalities have no searchable page.
    }
  }
}

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
