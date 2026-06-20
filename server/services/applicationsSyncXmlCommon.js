// Baugesuch-Import: XmlCommon-Helfer (aus applicationsSyncCommon.js aufgeteilt).
import {
  fetchWithTimeout
} from "./applicationsSyncNet.js";
import {
  escapeRegExp
} from "./applicationsSyncNormalize.js";
import {
  decodeHtmlEntities,
  normalizeWhitespace
} from "./applicationsSyncText.js";

export const defaultMunicipalityXmlLocationLimit = Number(process.env.MUNICIPALITY_XML_LOCATION_LIMIT ?? 80);

export function extractXmlBlocks(xml, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  return [...String(xml ?? "").matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

export function decodeXmlValue(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1"))
  );
}

export function extractXmlTagValue(xml, tagNames) {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
    const match = String(xml ?? "").match(pattern);

    if (match?.[1]) {
      const decoded = decodeXmlValue(match[1]);

      if (decoded) {
        return decoded;
      }
    }
  }

  return "";
}

export function extractXmlAttributeValue(xml, tagName, attributeName) {
  const pattern = new RegExp(
    `<${escapeRegExp(tagName)}\\b[^>]*\\b${escapeRegExp(attributeName)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))[^>]*\\/?>`,
    "i"
  );
  const match = String(xml ?? "").match(pattern);
  return decodeXmlValue(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

export function resolveXmlUrl(urlValue, baseUrl) {
  const normalizedValue = decodeXmlValue(urlValue);

  if (!normalizedValue) {
    return "";
  }

  try {
    return new URL(normalizedValue, baseUrl).toString();
  } catch {
    return "";
  }
}

export function extractFeedEntriesFromXml(xml, baseUrl) {
  const sourceXml = String(xml ?? "");
  const blocks = /<entry\b/i.test(sourceXml) ? extractXmlBlocks(sourceXml, "entry") : extractXmlBlocks(sourceXml, "item");

  return blocks.map((block, index) => {
    const title = extractXmlTagValue(block, ["title"]);
    const summary = extractXmlTagValue(block, ["description", "summary", "content", "content:encoded"]);
    const content = extractXmlTagValue(block, ["content:encoded", "content", "description", "summary"]);
    const publishedAt = extractXmlTagValue(block, ["pubDate", "published", "updated", "dc:date"]);
    const explicitLink = extractXmlTagValue(block, ["link", "guid"]);
    const atomHref = extractXmlAttributeValue(block, "link", "href");
    const enclosureHref = extractXmlAttributeValue(block, "enclosure", "url");
    const link = resolveXmlUrl(atomHref || explicitLink || enclosureHref, baseUrl);

    return {
      id: extractXmlTagValue(block, ["guid", "id"]) || `xml-entry-${index}`,
      title,
      summary,
      content,
      publishedAt,
      link,
      rawText: normalizeWhitespace([title, summary, content].filter(Boolean).join(" "))
    };
  });
}

export function extractSitemapUrlsFromXml(xml, baseUrl) {
  const sourceXml = String(xml ?? "");
  const directUrls = extractXmlBlocks(sourceXml, "url")
    .map((block) => resolveXmlUrl(extractXmlTagValue(block, ["loc"]), baseUrl))
    .filter(Boolean);
  const nestedSitemaps = extractXmlBlocks(sourceXml, "sitemap")
    .map((block) => resolveXmlUrl(extractXmlTagValue(block, ["loc"]), baseUrl))
    .filter(Boolean);

  return {
    directUrls: [...new Set(directUrls)],
    nestedSitemaps: [...new Set(nestedSitemaps)]
  };
}

export async function resolveSitemapUrls(xml, source, fetchImpl, requestTimeoutMs, depth = 0, seenSitemaps = new Set()) {
  const { directUrls, nestedSitemaps } = extractSitemapUrlsFromXml(xml, source.sourceUrl);

  if (depth >= 1 || nestedSitemaps.length === 0) {
    return directUrls.slice(0, defaultMunicipalityXmlLocationLimit);
  }

  const collectedUrls = [...directUrls];

  for (const nestedSitemapUrl of nestedSitemaps) {
    if (seenSitemaps.has(nestedSitemapUrl) || collectedUrls.length >= defaultMunicipalityXmlLocationLimit) {
      continue;
    }

    seenSitemaps.add(nestedSitemapUrl);

    try {
      const nestedResponse = await fetchWithTimeout(
        fetchImpl,
        nestedSitemapUrl,
        {
          headers: {
            Accept: "application/xml,text/xml,application/rss+xml,application/atom+xml"
          }
        },
        requestTimeoutMs
      );

      if (!nestedResponse.ok) {
        continue;
      }

      const nestedXml = await nestedResponse.text();
      const nestedUrls = await resolveSitemapUrls(
        nestedXml,
        { ...source, sourceUrl: nestedSitemapUrl },
        fetchImpl,
        requestTimeoutMs,
        depth + 1,
        seenSitemaps
      );

      collectedUrls.push(...nestedUrls);
    } catch {
      // Ignore broken nested sitemaps and keep processing the remaining feeds.
    }
  }

  return [...new Set(collectedUrls)].slice(0, defaultMunicipalityXmlLocationLimit);
}

