// Discovery-Belang: Such-Requests aus Formularen/OpenSearch ableiten und die
// Site-Suche ausfuehren. Aus applicationsSyncDiscovery.js ausgelagert.
import { fetchWithTimeout, resolveHttpUrlReference } from "../applicationsSyncCommon.js";
import { normalizeMunicipalityResolvedUrl } from "../applicationsSyncMunicipality.js";
import {
  discoverySearchPaths,
  discoverySearchTerms,
  extractHtmlAttributes,
  isSafePublicHttpUrl
} from "./discoveryValidation.js";
import { collectDiscoveryCandidatesFromHtml, mergeDiscoveryCandidate } from "./discoveryCandidates.js";

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
