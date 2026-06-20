// Baugesuch-Import: Net-Helfer (aus applicationsSyncCommon.js aufgeteilt).
import { assertPublicHost } from "./safeFetch.js";
import {
  defaultMaxResponseBytes,
  defaultMunicipalitySourceConcurrency,
  defaultRemoteRequestHeaders,
  defaultSyncRequestTimeoutMs
} from "./applicationsSyncConstants.js";
import {
  decodeHtmlEntities
} from "./applicationsSyncText.js";

// Liest den Body innerhalb der laufenden Deadline und bricht bei Ueberschreitung
// des Grössenlimits ab (S2: verhindert unbegrenzte/langsame Bodies).
export async function readBoundedBody(response, maxBytes) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength ?? value.length ?? 0;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Antwort überschreitet das Grössenlimit von ${maxBytes} Bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Antwort überschreitet das Grössenlimit von ${maxBytes} Bytes.`);
    }
    return buffer;
  }

  if (typeof response.text === "function") {
    const buffer = Buffer.from(await response.text(), "utf8");
    if (buffer.length > maxBytes) {
      throw new Error(`Antwort überschreitet das Grössenlimit von ${maxBytes} Bytes.`);
    }
    return buffer;
  }

  return Buffer.alloc(0);
}

// Huellt eine bereits vollstaendig (und begrenzt) gelesene Antwort, damit
// Aufrufer weiterhin text()/json()/arrayBuffer() nutzen koennen.
export function makeBoundedResponse(response, bodyBuffer, finalUrl) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: finalUrl ?? response.url,
    redirected: Boolean(response.redirected),
    async text() {
      return bodyBuffer.toString("utf8");
    },
    async json() {
      return JSON.parse(bodyBuffer.toString("utf8"));
    },
    async arrayBuffer() {
      return bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength);
    }
  };
}

export async function fetchWithTimeout(fetchImpl, resource, options = {}, timeoutMs = defaultSyncRequestTimeoutMs) {
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultSyncRequestTimeoutMs;
  const maxBytes =
    Number.isFinite(options.maxResponseBytes) && options.maxResponseBytes > 0
      ? options.maxResponseBytes
      : defaultMaxResponseBytes;
  // SSRF nur fuer echte Netzwerk-Requests erzwingen; injizierte Mock-Fetches
  // (Tests) verwenden fiktive Hosts und werden nicht per DNS geprueft.
  const enforceSsrf = fetchImpl === globalThis.fetch;
  const { maxResponseBytes: _ignored, signal: _ignoredSignal, headers: optionHeaders, ...restOptions } = options;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), normalizedTimeout);

  try {
    const baseOptions = {
      ...restOptions,
      headers: {
        ...defaultRemoteRequestHeaders,
        ...optionHeaders
      },
      signal: controller.signal
    };

    let response;

    if (enforceSsrf) {
      const maxRedirects = 5;
      let currentUrl = String(resource);
      for (let hop = 0; ; hop += 1) {
        await assertPublicHost(new URL(currentUrl).hostname);
        response = await fetchImpl(currentUrl, { ...baseOptions, redirect: "manual" });

        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (location && hop < maxRedirects) {
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        const body = await readBoundedBody(response, maxBytes);
        return makeBoundedResponse(response, body, currentUrl);
      }
    }

    response = await fetchImpl(resource, baseOptions);
    const body = await readBoundedBody(response, maxBytes);
    return makeBoundedResponse(response, body, String(resource));
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function mapWithConcurrency(items, worker, concurrency = defaultMunicipalitySourceConcurrency) {
  const normalizedConcurrency = Math.max(
    1,
    Math.min(items.length || 1, Number.isFinite(concurrency) ? Math.trunc(concurrency) : defaultMunicipalitySourceConcurrency)
  );
  const results = [];
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: normalizedConcurrency }, () => runWorker()));
  return results;
}

export function isArcGisServiceUrl(sourceUrl) {
  try {
    const parsedUrl = new URL(sourceUrl);
    return /\/(MapServer|FeatureServer)(\/\d+)?(\/query)?$/i.test(parsedUrl.pathname);
  } catch {
    return false;
  }
}

export function looksLikeXmlSourceUrl(sourceUrl) {
  const normalizedValue = String(sourceUrl ?? "").trim();

  if (!normalizedValue || isArcGisServiceUrl(normalizedValue)) {
    return false;
  }

  try {
    const parsedUrl = new URL(normalizedValue);
    const decodedPath = decodeURIComponent(`${parsedUrl.pathname} ${parsedUrl.search}`);
    return /\.(?:xml|rss|atom)(?:$|[?#\s])/i.test(decodedPath) || /\b(?:feed|rss|atom|sitemap)\b/i.test(decodedPath);
  } catch {
    return /\.(?:xml|rss|atom)(?:$|[?#\s])/i.test(normalizedValue) || /\b(?:feed|rss|atom|sitemap)\b/i.test(normalizedValue);
  }
}

export function looksLikeJsonSourceUrl(sourceUrl) {
  const normalizedValue = String(sourceUrl ?? "").trim();

  if (!normalizedValue || isArcGisServiceUrl(normalizedValue) || looksLikeXmlSourceUrl(normalizedValue)) {
    return false;
  }

  try {
    const parsedUrl = new URL(normalizedValue);
    const decodedPath = decodeURIComponent(`${parsedUrl.pathname} ${parsedUrl.search}`);
    return (
      /\.(?:json|geojson)(?:$|[?#\s])/i.test(decodedPath) ||
      /\bf=(?:p?json|geojson)\b/i.test(decodedPath) ||
      /\bapi\b/i.test(parsedUrl.pathname)
    );
  } catch {
    return /\.(?:json|geojson)(?:$|[?#\s])/i.test(normalizedValue) || /\bf=(?:p?json|geojson)\b/i.test(normalizedValue);
  }
}

export function withOptionalTokenHeaders(headers, sourceToken) {
  if (!sourceToken) {
    return headers;
  }

  return {
    ...headers,
    Authorization: `Bearer ${sourceToken}`
  };
}

export function finalizeArcGisQueryUrl(sourceUrl, sourceToken) {
  const queryUrl = new URL(sourceUrl);

  if (!queryUrl.searchParams.has("where")) {
    queryUrl.searchParams.set("where", "1=1");
  }

  if (!queryUrl.searchParams.has("outFields")) {
    queryUrl.searchParams.set("outFields", "*");
  }

  if (!queryUrl.searchParams.has("returnGeometry")) {
    queryUrl.searchParams.set("returnGeometry", "true");
  }

  queryUrl.searchParams.set("f", "json");

  if (sourceToken && !queryUrl.searchParams.has("token")) {
    queryUrl.searchParams.set("token", sourceToken);
  }

  return queryUrl.toString();
}

export async function resolveArcGisQueryUrl(sourceUrl, sourceToken, fetchImpl) {
  const parsedUrl = new URL(sourceUrl);

  if (/\/(MapServer|FeatureServer)\/\d+\/query$/i.test(parsedUrl.pathname)) {
    return finalizeArcGisQueryUrl(parsedUrl.toString(), sourceToken);
  }

  if (/\/(MapServer|FeatureServer)\/\d+$/i.test(parsedUrl.pathname)) {
    parsedUrl.pathname = `${parsedUrl.pathname}/query`;
    return finalizeArcGisQueryUrl(parsedUrl.toString(), sourceToken);
  }

  if (/\/(MapServer|FeatureServer)$/i.test(parsedUrl.pathname)) {
    const metadataUrl = new URL(parsedUrl.toString());
    metadataUrl.searchParams.set("f", "json");

    if (sourceToken && !metadataUrl.searchParams.has("token")) {
      metadataUrl.searchParams.set("token", sourceToken);
    }

    const metadataResponse = await fetchImpl(metadataUrl.toString(), {
      headers: withOptionalTokenHeaders(
        {
          Accept: "application/json"
        },
        sourceToken
      )
    });

    if (!metadataResponse.ok) {
      throw new Error(`AGIS-Metadaten konnten nicht geladen werden (${metadataResponse.status}).`);
    }

    const metadataPayload = await metadataResponse.json();

    if (metadataPayload?.error?.message) {
      throw new Error(`AGIS-Metadaten konnten nicht geladen werden: ${metadataPayload.error.message}`);
    }

    const firstLayerId = metadataPayload?.layers?.[0]?.id ?? metadataPayload?.tables?.[0]?.id ?? 0;
    parsedUrl.pathname = `${parsedUrl.pathname}/${firstLayerId}/query`;
    return finalizeArcGisQueryUrl(parsedUrl.toString(), sourceToken);
  }

  return parsedUrl.toString();
}

export function collapseRepeatedLeadingPathSegments(pathname) {
  const rawSegments = String(pathname ?? "").split("/");
  const segments = rawSegments.filter(Boolean);

  for (let length = 2; length <= Math.floor(segments.length / 2); length += 1) {
    const first = segments.slice(0, length).join("/");
    const second = segments.slice(length, length * 2).join("/");

    if (first && first === second) {
      const collapsed = [...segments.slice(0, length), ...segments.slice(length * 2)];
      const trailingSlash = pathname.endsWith("/") ? "/" : "";
      return `/${collapsed.join("/")}${trailingSlash}`;
    }
  }

  return pathname;
}

export function resolveHttpUrlReference(value, baseUrl, { skipFragmentOnly = true } = {}) {
  const rawValue = decodeHtmlEntities(String(value ?? "")).trim();

  if (!rawValue || (skipFragmentOnly && rawValue.startsWith("#"))) {
    return null;
  }

  try {
    const resolved = new URL(rawValue, baseUrl);

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    resolved.pathname = collapseRepeatedLeadingPathSegments(resolved.pathname);
    return resolved;
  } catch {
    return null;
  }
}

