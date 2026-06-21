// Baugesuch-Import: Text-Helfer (aus applicationsSyncCommon.js aufgeteilt).
import { PDFParse } from "pdf-parse";
import {
  monthYearListingPattern,
  swissDateLikePatternSource
} from "./applicationsSyncConstants.js";
import {
  normalizeText
} from "./applicationsSyncNormalize.js";

export const defaultHtmlKeywordsPattern =
  /\b(baugesuch|baugesuche|baubewilligung|baupublikation|amtliche publikation|auflage|einsprachfrist|publikation)\b/i;

export const defaultHtmlExcludePattern =
  /\b(home|startseite|kontakt|impressum|datenschutz|login|abmelden|mehr erfahren|weiterlesen)\b/i;

export const relevantStructuredMetadataKeys = new Set([
  "headline",
  "name",
  "description",
  "articlebody",
  "text",
  "streetaddress",
  "postalcode",
  "addresslocality",
  "addressregion",
  "addresscountry",
  "location",
  "contentlocation",
  "datepublished",
  "datecreated",
  "startdate",
  "enddate",
  "validthrough",
  "identifier",
  "keywords"
]);

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeSourcePatternText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

export function createSourcePatternMatcher(pattern) {
  const terms = String(pattern ?? "")
    .split("|")
    .map((term) => normalizeSourcePatternText(term))
    .filter(Boolean)
    .slice(0, 24);

  if (terms.length === 0) {
    return null;
  }

  return (value) => {
    const text = normalizeSourcePatternText(value);
    return Boolean(text && terms.some((term) => text.includes(term)));
  };
}

export function looksLikeStandaloneDate(value) {
  const text = normalizeWhitespace(value);

  if (!text) {
    return false;
  }

  return Boolean(
    text.match(new RegExp(`^${swissDateLikePatternSource}$`, "i")) ||
      /^20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)?$/i.test(text) ||
      monthYearListingPattern.test(text) ||
      /^\d{4}$/.test(text)
  );
}

export function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&uuml;/gi, "ü")
    .replace(/&Uuml;/gi, "Ü")
    .replace(/&ouml;/gi, "ö")
    .replace(/&Ouml;/gi, "Ö")
    .replace(/&auml;/gi, "ä")
    .replace(/&Auml;/gi, "Ä")
    .replace(/&eacute;/gi, "é")
    .replace(/&egrave;/gi, "è")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gi, "&");
}

export function stripHtml(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(String(value ?? ""))
      .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

export async function extractPdfTextFromBuffer(data) {
  const parser = new PDFParse({
    data: data instanceof Uint8Array ? data : new Uint8Array(data)
  });

  try {
    const result = await parser.getText();
    return normalizeWhitespace(result?.text ?? "");
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Ignore parser cleanup errors after extraction.
    }
  }
}

export function extractAttributeValue(attributeText, attributeName) {
  const match = String(attributeText ?? "").match(
    new RegExp(`${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  );

  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

export function collectStructuredMetadataSnippets(value, key = "", snippets = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStructuredMetadataSnippets(entry, key, snippets);
    }

    return snippets;
  }

  if (value && typeof value === "object") {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      collectStructuredMetadataSnippets(entryValue, entryKey, snippets);
    }

    return snippets;
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return snippets;
  }

  const normalizedKey = normalizeText(key);

  if (!relevantStructuredMetadataKeys.has(normalizedKey)) {
    return snippets;
  }

  const normalizedValue = normalizeWhitespace(decodeHtmlEntities(String(value ?? "")));

  if (!normalizedValue || /^https?:\/\//i.test(normalizedValue)) {
    return snippets;
  }

  snippets.push(normalizedValue);
  return snippets;
}

export function extractStructuredMetadataText(html) {
  const snippets = [];
  const normalizedHtml = String(html ?? "");
  const jsonLdRegex =
    /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch = null;

  while ((jsonLdMatch = jsonLdRegex.exec(normalizedHtml)) !== null) {
    const rawJson = decodeHtmlEntities(jsonLdMatch[1] ?? "").trim();

    if (!rawJson) {
      continue;
    }

    try {
      const payload = JSON.parse(rawJson);
      collectStructuredMetadataSnippets(payload, "", snippets);
    } catch {
      // Ignore malformed JSON-LD blocks and keep parsing the remaining ones.
    }
  }

  const itempropContentRegex =
    /<meta\b[^>]*itemprop\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*content\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let itempropMatch = null;

  while ((itempropMatch = itempropContentRegex.exec(normalizedHtml)) !== null) {
    const itemprop = itempropMatch[1] ?? itempropMatch[2] ?? "";
    const content = itempropMatch[3] ?? itempropMatch[4] ?? "";
    collectStructuredMetadataSnippets(content, itemprop, snippets);
  }

  const itempropTextRegex =
    /<([a-z0-9]+)\b[^>]*itemprop\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/\1>/gi;
  let itempropTextMatch = null;

  while ((itempropTextMatch = itempropTextRegex.exec(normalizedHtml)) !== null) {
    const itemprop = itempropTextMatch[2] ?? itempropTextMatch[3] ?? "";
    const content = stripHtml(itempropTextMatch[4] ?? "");
    collectStructuredMetadataSnippets(content, itemprop, snippets);
  }

  return normalizeWhitespace(snippets.join(" "));
}

