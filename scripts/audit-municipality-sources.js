// Live-Audit der Gemeindequellen.
//
// Das Skript liest die lokale SQLite-Datenbank read-only, ruft jede
// hinterlegte Gemeinde-/Publikationsquelle ab und versucht bei schwachen
// Quellen, auf derselben offiziellen Domain eine bessere Baugesuch- oder
// Publikationsseite zu finden. Es schreibt einen JSON- und Markdown-Bericht
// unter output/.
//
// Aufruf:
//   node scripts/audit-municipality-sources.js
//   node scripts/audit-municipality-sources.js --timeout=10000 --concurrency=8
//   DATABASE_PATH=./data/heimatschutz.sqlite node scripts/audit-municipality-sources.js

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(currentDir);

const defaultRequestTimeoutMs = 8000;
const defaultConcurrency = 8;
const maxHtmlChars = 350_000;
const maxDiscoveryCandidates = 14;

const sharedOfficialHosts = new Set([
  "ag.ch",
  "www.ag.ch",
  "amtsblatt.ag.ch",
  "www.amtsblatt.ag.ch",
  "ebauportal.ag.ch",
  "www.ebauportal.ag.ch",
  "amtliche-nachrichten.ch",
  "www.amtliche-nachrichten.ch",
  "gesuch.rbv-wsw.ch",
  "www.gesuch.rbv-wsw.ch"
]);

const sourceSignalPattern =
  /(baugesuch|baugesuche|baupublikation|baugesuchspublikation|baugesuchsauflage|baubewilligung|auflagebaugesuche|planauflage|oeffentliche auflage|öffentliche auflage|amtliche publikation|amtliches publikationsorgan)/i;
const strongBuildingSignalPattern =
  /(bauherrschaft|bauobjekt|bauvorhaben|bauplatz|ortslage|orts lage|parzelle|parzellen|planauflage|einsprachefrist|einwendungen|auflage vom|auflagefrist|publikationsdatum|gesuchsteller)/i;
const resultListingPattern =
  /(rubrik|alle rubriken|baugesuche|anzeige der ergebnisse|ergebnisse\s+\d+\s+bis|insgesamt\s+\d+|laufende auflagen|öffentliche auflagen|oeffentliche auflagen)/i;
const wrongTopicPattern =
  /(einbürger|einbuerger|gemeindeversammlung|abstimmung|wahlen|newsletter|veranstaltung|agenda|jobs|stellen|bibliothek|kindergarten|datenschutz|impressum|facebook|instagram|youtube|erteilte baubewilligung|erteilte bewilligung|baubewilligung erteilt)/i;
const protectedPattern =
  /(login-geschützt|login geschützt|zugriff geschützt|anmeldung erforderlich|ebauportal|e-bau|e bau|smartserviceportal|gesuch\.rbv-wsw\.ch)/i;
const singlePublicationPathPattern =
  /(?:\/news-detail\/|\/archiv-detail\/|\/artikel\/|\/news\/\d+\b|\/_rte\/information\/\d+\b|\/\d{4}\/\d{2}\/\d{2}\/)/i;
const discoveryCommonPaths = [
  "/baugesuch",
  "/baugesuche",
  "/baupublikationen",
  "/amtliche-publikationen",
  "/amtlichepublikationen",
  "/amtlpublikationen",
  "/aktuelles/amtliche-publikationen",
  "/aktuelles/amtlichepublikationen",
  "/infospublikationen/baugesuchspublikationen",
  "/publikationen",
  "/oeffentliche-auflage",
  "/öffentliche-auflage",
  "/baugesuchspublikationen",
  "/baugesuchs-publikationen",
  "/auflagebaugesuche",
  "/laufende-auflagen",
  "/aktuelles",
  "/news",
  "/gemeinde/aktuelles",
  "/portraet/aktuelles"
];
const externallyVerifiedSourceUrls = new Map([
  [
    "https://ammerswil.ch/abteilungen",
    {
      checkedAt: "2026-06-05",
      evidenceUrls: [
        "https://ammerswil.ch/abteilungen",
        "https://www.boniswil.ch/gemeindeverwaltung/abteilungen/bauverwaltung.html/88"
      ],
      note:
        "Offizielle Ammerswil-Abteilungsseite nennt die Regionale Bauverwaltung Seengen; Boniswil bestätigt die gemeinsame Bauverwaltung Seengen-Boniswil-Ammerswil."
    }
  ],
  [
    "https://rottenschwil.ch",
    {
      checkedAt: "2026-06-05",
      evidenceUrls: [
        "https://rottenschwil.ch/",
        "https://rottenschwil.ch/news/aktuelle-mitteilungen/baugesuch-gerteis-paul"
      ],
      note:
        "Offizielle Rottenschwil-Website ist extern erreichbar und zeigt ein aktuelles Baugesuch mit Bauplatz, Parzelle und Auflagefrist."
    }
  ]
]);

function parseArgs(argv) {
  const options = {
    dbPath: resolve(process.env.DATABASE_PATH || join(rootDir, "data", "heimatschutz.sqlite")),
    outputDir: resolve(process.env.AUDIT_OUTPUT_DIR || join(rootDir, "output")),
    timeoutMs: defaultRequestTimeoutMs,
    concurrency: defaultConcurrency,
    quick: false,
    jsonOnly: false
  };

  for (const arg of argv) {
    if (arg === "--quick") {
      options.quick = true;
    } else if (arg === "--json") {
      options.jsonOnly = true;
    } else if (arg.startsWith("--db=")) {
      options.dbPath = resolve(arg.slice("--db=".length));
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = resolve(arg.slice("--output-dir=".length));
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length)) || defaultRequestTimeoutMs);
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = Math.max(1, Number(arg.slice("--concurrency=".length)) || defaultConcurrency);
    }
  }

  return options;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };

  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function normalizeWhitespace(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function stripHtml(value) {
  return normalizeWhitespace(
    String(value ?? "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractTitle(html) {
  const match = String(html ?? "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 160) : "";
}

function normalizeHost(hostname) {
  return String(hostname ?? "").toLowerCase().replace(/^www\./, "");
}

function getUrlHost(value) {
  try {
    return normalizeHost(new URL(String(value ?? "").trim()).hostname);
  } catch {
    return "";
  }
}

function isSafePublicHttpUrl(value) {
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

  if (host.includes(":") || host.endsWith(".local") || host.endsWith(".internal")) {
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

function resolveHttpUrlReference(href, baseUrl) {
  try {
    const resolved = new URL(String(href ?? "").trim(), baseUrl);

    if (!isSafePublicHttpUrl(resolved.toString())) {
      return null;
    }

    resolved.hash = "";
    return resolved;
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(value ?? "").trim();
  }
}

function getExternalVerification(url) {
  const candidates = [normalizeUrl(url), String(url ?? "").trim()];

  for (const candidate of candidates) {
    if (externallyVerifiedSourceUrls.has(candidate)) {
      return externallyVerifiedSourceUrls.get(candidate);
    }
  }

  return null;
}

function getRootUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return "";
  }
}

function decodePath(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return decodeURIComponent(`${parsed.pathname}${parsed.search}`).toLowerCase();
  } catch {
    return String(value ?? "").toLowerCase();
  }
}

function sourceUrlFromLink(row) {
  return String(row.direct_url || row.canonical_url || row.website_url || row.official_website || "").trim();
}

function isSharedOfficialSource(row, url = "") {
  const host = getUrlHost(url || row.direct_url || row.canonical_url || row.website_url);
  const sourceText = `${row.source_kind ?? ""} ${row.source_name ?? ""} ${row.operator_name ?? ""} ${row.shared_hint ?? ""}`;

  return (
    Boolean(row.is_shared) ||
    sharedOfficialHosts.has(host) ||
    /amtsblatt|e-?bau|kanton|regional|bezirksanzeiger|amtliche nachrichten/i.test(sourceText)
  );
}

function hostLooksOfficial(url, officialWebsite) {
  const urlHost = getUrlHost(url);
  const officialHost = getUrlHost(officialWebsite);

  if (!urlHost) {
    return false;
  }

  if (sharedOfficialHosts.has(urlHost)) {
    return true;
  }

  if (!officialHost) {
    return true;
  }

  return urlHost === officialHost || urlHost.endsWith(`.${officialHost}`) || officialHost.endsWith(`.${urlHost}`);
}

function buildHeaders(url = "") {
  const host = getUrlHost(url);
  const userAgent =
    host === "boniswil.ch"
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
      : "Heimatschutz-Aargau-Source-Audit/1.0 (+local read-only audit)";

  return {
    Accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/plain,*/*;q=0.8",
    "Accept-Language": "de-CH,de;q=0.9,en;q=0.5",
    "User-Agent": userAgent
  };
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function fetchPage(url, timeoutMs) {
  if (!isSafePublicHttpUrl(url)) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: "",
      title: "",
      text: "",
      error: "not-public-http-url"
    };
  }

  const attempts = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: buildHeaders(url),
        redirect: "follow",
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const canReadText = /(?:text|html|xml|json|javascript|rss|atom)/i.test(contentType) || !contentType;
      let raw = "";

      if (canReadText) {
        raw = (await response.text()).slice(0, maxHtmlChars);
      }

      return {
        ok: response.ok,
        status: response.status,
        finalUrl: response.url || url,
        contentType,
        title: extractTitle(raw),
        text: stripHtml(raw),
        rawHtml: raw,
        error: "",
        attempts: attempt
      };
    } catch (error) {
      attempts.push(error?.name === "AbortError" ? "timeout" : error?.message || "fetch-error");
    } finally {
      clearTimeout(timer);
    }

    if (attempt < 3) {
      await wait(300 * attempt);
    }
  }

  return {
    ok: false,
    status: 0,
    finalUrl: url,
    contentType: "",
    title: "",
    text: "",
    rawHtml: "",
    error: attempts.join(" | ") || "fetch-error",
    attempts: attempts.length
  };
}

function scoreSourcePage(url, page, row) {
  let score = 0;
  const signals = [];
  const pathText = decodePath(page.finalUrl || url);
  const text = `${page.title} ${page.text}`.slice(0, maxHtmlChars);
  const scoringText = `${pathText} ${text}`;
  const buildingMatches = scoringText.match(/baugesuch|baugesuche|baupublikation|baugesuchspublikation/gi) ?? [];

  if (/baugesuch|baugesuche|baupublikation|baugesuchspublikation|auflagebaugesuche/.test(pathText)) {
    score += 14;
    signals.push("url-baugesuch");
  } else if (/amtliche-publikation|amtlichepublikation|amtlpublikation|publikation|oeffentliche-auflage|öffentliche-auflage/.test(pathText)) {
    score += 8;
    signals.push("url-publikation");
  }

  if (sourceSignalPattern.test(text)) {
    score += 12;
    signals.push("text-baugesuch-publikation");
  }

  if (strongBuildingSignalPattern.test(text)) {
    score += 8;
    signals.push("konkrete-baugesuch-felder");
  }

  if (resultListingPattern.test(text)) {
    score += 6;
    signals.push("listen-seite");
  }

  if (buildingMatches.length >= 2) {
    score += 5;
    signals.push("mehrere-baugesuch-treffer");
  }

  if (/ebauportal\.ag\.ch|e-?bau|gesuch\.rbv-wsw\.ch/i.test(scoringText)) {
    score += 6;
    signals.push("ebau-regional");
  }

  if (isSharedOfficialSource(row, page.finalUrl || url)) {
    score += 4;
    signals.push("geteilte-amtliche-quelle");
  }

  if (wrongTopicPattern.test(`${pathText} ${page.title}`) && !sourceSignalPattern.test(text)) {
    score -= 10;
    signals.push("falsches-thema");
  }

  if (singlePublicationPathPattern.test(pathText) && !resultListingPattern.test(text)) {
    score -= 12;
    signals.push("einzelmeldung-statt-liste");
  }

  if (protectedPattern.test(scoringText)) {
    signals.push("login-oder-ebau-signal");
  }

  return {
    score,
    signals,
    hasSourceSignal: sourceSignalPattern.test(text),
    hasConcreteSignal: strongBuildingSignalPattern.test(text),
    hasProtectedSignal: protectedPattern.test(scoringText)
  };
}

function scoreCandidateAnchor(url, anchorText, contextText) {
  let score = 0;
  const pathText = decodePath(url);
  const candidateText = `${anchorText} ${contextText}`.trim();

  if (wrongTopicPattern.test(candidateText) || wrongTopicPattern.test(pathText)) {
    return 0;
  }

  if (/baugesuch|baugesuche|baupublikation|baugesuchspublikation|auflagebaugesuche/.test(pathText)) {
    score += 8;
  } else if (/amtliche-publikation|publikation|oeffentliche-auflage|öffentliche-auflage/.test(pathText)) {
    score += 5;
  }

  if (/baugesuch|baugesuche|baupublikation|baugesuchspublikation/i.test(candidateText)) {
    score += 8;
  } else if (/oeffentliche auflage|öffentliche auflage/i.test(candidateText)) {
    score += 5;
  } else if (/amtliche publikation|amtliches publikationsorgan/i.test(candidateText)) {
    score += 4;
  } else if (/publikation/i.test(candidateText)) {
    score += 2;
  }

  if (resultListingPattern.test(contextText)) {
    score += 3;
  }

  if (singlePublicationPathPattern.test(pathText)) {
    score -= 6;
  }

  return Math.max(0, score);
}

function addCandidate(candidates, url, score, reason) {
  if (!url || !isSafePublicHttpUrl(url) || score <= 0) {
    return;
  }

  const key = normalizeUrl(url);
  const current = candidates.get(key);

  if (!current || score > current.score) {
    candidates.set(key, {
      url,
      score,
      reason
    });
  }
}

function collectLinkCandidates(html, baseUrl, candidates) {
  let baseHost = "";

  try {
    baseHost = normalizeHost(new URL(baseUrl).hostname);
  } catch {
    return;
  }

  const anchorRegex = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = anchorRegex.exec(String(html ?? ""))) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const resolved = resolveHttpUrlReference(href, baseUrl);

    if (!resolved || normalizeHost(resolved.hostname) !== baseHost) {
      continue;
    }

    const anchorText = stripHtml(match[4]);
    const surrounding = String(html ?? "").slice(Math.max(0, match.index - 400), match.index + match[0].length + 400);
    const contextText = stripHtml(surrounding);
    const score = scoreCandidateAnchor(resolved.toString(), anchorText, contextText);
    addCandidate(candidates, resolved.toString(), score, "link");
  }
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractSitemapLocations(xml) {
  return [...String(xml ?? "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeHtmlEntities(match[1]));
}

async function collectSitemapCandidates(rootUrl, fetchCached, timeoutMs, candidates) {
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
  const seenSitemaps = new Set();
  const sitemapQueue = [...sitemapUrls];

  while (sitemapQueue.length > 0 && seenSitemaps.size < 8) {
    const sitemapUrl = sitemapQueue.shift();
    const sitemapKey = normalizeUrl(sitemapUrl);

    if (seenSitemaps.has(sitemapKey)) {
      continue;
    }

    seenSitemaps.add(sitemapKey);
    const page = await fetchCached(sitemapUrl, timeoutMs);

    if (!page.ok || !page.text) {
      continue;
    }

    for (const loc of extractSitemapLocations(page.rawHtml || page.text).slice(0, 500)) {
      const resolved = resolveHttpUrlReference(loc, sitemapUrl);

      if (!resolved || normalizeHost(resolved.hostname) !== normalizeHost(root.hostname)) {
        continue;
      }

      const pathText = decodePath(resolved.toString());

      if (/sitemap/i.test(pathText) && seenSitemaps.size < 8) {
        sitemapQueue.push(resolved.toString());
        continue;
      }

      if (!sourceSignalPattern.test(pathText)) {
        continue;
      }

      const score = /baugesuch|baupublikation|baugesuchspublikation/.test(pathText) ? 10 : 6;
      addCandidate(candidates, resolved.toString(), score, "sitemap");
    }
  }
}

async function discoverBetterSource(row, directPage, fetchCached, timeoutMs, quick) {
  const sourceUrl = sourceUrlFromLink(row);
  const rootUrl = getRootUrl(sourceUrl || row.official_website);
  const candidates = new Map();

  if (!rootUrl) {
    return null;
  }

  if (directPage?.rawHtml) {
    collectLinkCandidates(directPage.rawHtml, sourceUrl, candidates);
  }

  if (row.official_website && normalizeUrl(row.official_website) !== normalizeUrl(sourceUrl)) {
    const officialPage = await fetchCached(row.official_website, timeoutMs);

    if (officialPage.rawHtml) {
      collectLinkCandidates(officialPage.rawHtml, officialPage.finalUrl || row.official_website, candidates);
    }
  }

  for (const path of discoveryCommonPaths) {
    addCandidate(candidates, new URL(path, rootUrl).toString(), 5, "common-path");
  }

  if (!quick) {
    await collectSitemapCandidates(rootUrl, fetchCached, timeoutMs, candidates);

    const aggregatorSlug = slugify(row.municipality);
    if (aggregatorSlug) {
      addCandidate(candidates, `https://www.amtliche-nachrichten.ch/${aggregatorSlug}`, 3, "amtliche-nachrichten");
    }
  }

  const sortedCandidates = [...candidates.values()]
    .filter((candidate) => normalizeUrl(candidate.url) !== normalizeUrl(sourceUrl))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxDiscoveryCandidates);

  let best = null;

  for (const candidate of sortedCandidates) {
    const page = await fetchCached(candidate.url, timeoutMs);

    if (!page.ok) {
      continue;
    }

    const contentScore = scoreSourcePage(candidate.url, page, row);
    const combinedScore = candidate.score + contentScore.score;

    if (!best || combinedScore > best.score) {
      best = {
        url: candidate.url,
        status: page.status,
        finalUrl: page.finalUrl,
        title: page.title,
        score: combinedScore,
        reason: candidate.reason,
        signals: contentScore.signals
      };
    }
  }

  return best && best.score >= 18 ? best : null;
}

async function mapWithConcurrency(items, mapper, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function loadRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const sourceRows = db
      .prepare(
        `
          SELECT
            m.id AS municipality_id,
            m.name AS municipality,
            m.official_website,
            q.primary_source_id,
            q.rating,
            q.rationale,
            q.shared_source_note,
            q.uncertain,
            ps.id AS source_id,
            ps.name AS source_name,
            ps.source_kind,
            ps.operator_name,
            ps.website_url,
            ps.canonical_url,
            ps.is_shared,
            l.relation_type,
            l.direct_url,
            l.source_type,
            l.enabled,
            l.digital_status,
            l.include_pattern,
            l.exclude_pattern,
            l.shared_hint,
            l.notes
          FROM municipality_source_links l
          JOIN municipalities m
            ON m.id = l.municipality_id
          JOIN publication_sources ps
            ON ps.id = l.source_id
          LEFT JOIN municipality_quality_assessments q
            ON q.municipality_id = m.id
          ORDER BY m.name ASC,
            CASE WHEN l.relation_type = 'primary' THEN 0 ELSE 1 END,
            ps.name ASC
        `
      )
      .all();
    const operationalRows = db
      .prepare(
        `
          SELECT
            municipality,
            source_url,
            source_type,
            enabled,
            digital_status,
            notes
          FROM municipality_sources
          ORDER BY municipality ASC
        `
      )
      .all();
    const applicationSummary = db
      .prepare(
        `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN protection_status = 'manual-review' OR ambiguous_address = 1 THEN 1 ELSE 0 END) AS manual_review,
            SUM(CASE WHEN IFNULL(coordinates, '') <> '' THEN 1 ELSE 0 END) AS with_coordinates
          FROM applications
        `
      )
      .get();

    return {
      sourceRows,
      operationalRows,
      applicationSummary
    };
  } finally {
    db.close();
  }
}

function groupMunicipalities(sourceRows, operationalRows) {
  const operationalByMunicipality = new Map(operationalRows.map((row) => [row.municipality, row]));
  const municipalities = new Map();

  for (const row of sourceRows) {
    if (!municipalities.has(row.municipality_id)) {
      municipalities.set(row.municipality_id, {
        municipalityId: row.municipality_id,
        municipality: row.municipality,
        officialWebsite: row.official_website,
        rating: row.rating,
        uncertain: Boolean(row.uncertain),
        rationale: row.rationale,
        sharedSourceNote: row.shared_source_note,
        operational: operationalByMunicipality.get(row.municipality) ?? null,
        links: []
      });
    }

    municipalities.get(row.municipality_id).links.push(row);
  }

  for (const municipality of municipalities.values()) {
    municipality.primaryLink =
      municipality.links.find((link) => link.relation_type === "primary" && link.source_id === link.primary_source_id) ??
      municipality.links.find((link) => link.relation_type === "primary") ??
      municipality.links[0] ??
      null;
    municipality.supplementalCount = municipality.links.filter((link) => link.relation_type !== "primary").length;
  }

  return [...municipalities.values()].sort((left, right) => left.municipality.localeCompare(right.municipality, "de-CH"));
}

function classifyPrimary(row, page, score, discovery, externalVerification = null) {
  const url = sourceUrlFromLink(row);
  const shared = isSharedOfficialSource(row, url);
  const municipalityManaged = /municipality|regional/i.test(String(row.source_kind ?? ""));
  const official =
    hostLooksOfficial(page.finalUrl || url, row.official_website) ||
    hostLooksOfficial(url, row.official_website) ||
    municipalityManaged ||
    shared;
  const protectedOrLogin = page.status === 401 || page.status === 403 || score.hasProtectedSignal;

  if (!url) {
    return {
      status: "needs-review-no-url",
      confidence: 0,
      reason: "Keine URL hinterlegt."
    };
  }

  if (externalVerification && !page.ok) {
    return {
      status: "ok-external-verified",
      confidence: 84,
      reason: "Quelle ist lokal nicht abrufbar, aber über externe offizielle Verifikation bestätigt."
    };
  }

  if (discovery) {
    return {
      status: "ok-discovered",
      confidence: page.ok ? 90 : 86,
      reason: page.ok
        ? "Hinterlegte Quelle ist schwach, aber eine bessere amtliche Publikationsseite wurde gefunden."
        : "Hinterlegte Quelle ist nicht erreichbar, aber eine bessere amtliche Publikationsseite wurde gefunden."
    };
  }

  if (!page.ok && page.error) {
    return {
      status: "needs-review-unreachable",
      confidence: 35,
      reason: `Quelle nicht abrufbar (${page.error}).`
    };
  }

  if (!page.ok) {
    return {
      status: page.status === 401 || page.status === 403 ? "protected-or-login" : "needs-review-unreachable",
      confidence: page.status === 401 || page.status === 403 ? 78 : 35,
      reason: `HTTP ${page.status}.`
    };
  }

  if (shared && page.ok && (score.score >= 8 || protectedOrLogin || sharedOfficialHosts.has(getUrlHost(page.finalUrl || url)))) {
    return {
      status: protectedOrLogin ? "protected-shared-official" : "ok-shared-official",
      confidence: protectedOrLogin ? 82 : 94,
      reason: protectedOrLogin
        ? "Geteilte amtliche Quelle, aber Inhalt ist teilweise login-/Portal-basiert."
        : "Geteilte amtliche Quelle erreichbar und plausibel."
    };
  }

  if (score.score >= 22 && official) {
    return {
      status: "ok-direct",
      confidence: 96,
      reason: "Direkte Quelle erreichbar, offiziell und mit starken Baugesuch-Signalen."
    };
  }

  if (score.score >= 12 && official && score.hasSourceSignal) {
    return {
      status: "ok-direct-low",
      confidence: 88,
      reason: "Quelle erreichbar und plausibel, aber mit weniger konkreten Baugesuch-Signalen."
    };
  }

  if (official && /publication|listing|publikation/i.test(`${row.source_kind ?? ""} ${url} ${page.title}`)) {
    return {
      status: "ok-official-publication-list",
      confidence: 82,
      reason: "Offizielle Publikations-/News-Liste erreichbar; aktuell ohne starkes Baugesuch-Signal."
    };
  }

  if (official && municipalityManaged && page.ok) {
    return {
      status: "ok-official-autodiscovery",
      confidence: 78,
      reason: "Offizielle Gemeindequelle erreichbar; Auto-Discovery sucht Baugesuchseiten bei jedem Sync."
    };
  }

  if (protectedOrLogin && official) {
    return {
      status: "protected-or-login",
      confidence: 76,
      reason: "Offizielle Quelle erreichbar, aber nicht voll maschinell einsehbar."
    };
  }

  return {
    status: "needs-review-weak-signal",
    confidence: Math.max(45, Math.min(72, 45 + score.score)),
    reason: "Quelle erreichbar, aber ohne genug klare Baugesuch-/Publikationssignale."
  };
}

function summarize(results, allLinkAudits, applicationSummary, fetchedUrlCount) {
  const byStatus = {};
  const byRating = {};

  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    byRating[result.rating ?? ""] = (byRating[result.rating ?? ""] ?? 0) + 1;
  }

  const needsReview = results.filter((result) => result.status.startsWith("needs-review"));
  const protectedSources = results.filter((result) => result.status.startsWith("protected"));
  const okSources = results.length - needsReview.length;
  const expectedProtectedLinkedSources = allLinkAudits.filter((link) => link.expectedProtected);
  const externallyVerifiedLinkedSources = allLinkAudits.filter((link) => link.externallyVerified);
  const linkFailures = allLinkAudits.filter((link) => !link.ok && !link.expectedProtected && !link.externallyVerified);

  return {
    generatedAt: new Date().toISOString(),
    totalMunicipalities: results.length,
    okMunicipalities: okSources,
    needsReviewMunicipalities: needsReview.length,
    protectedMunicipalities: protectedSources.length,
    statusCounts: byStatus,
    ratingCounts: byRating,
    allLinkedSources: allLinkAudits.length,
    fetchedUniqueUrls: fetchedUrlCount,
    unreachableLinkedSources: linkFailures.length,
    expectedProtectedLinkedSources: expectedProtectedLinkedSources.length,
    externallyVerifiedLinkedSources: externallyVerifiedLinkedSources.length,
    applicationSummary
  };
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildMarkdown(report) {
  const lines = [];
  const statusRows = Object.entries(report.summary.statusCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([status, count]) => `| ${markdownEscape(status)} | ${count} |`);
  const needsReview = report.municipalities.filter((item) => item.status.startsWith("needs-review"));
  const protectedSources = report.municipalities.filter((item) => item.status.startsWith("protected"));

  lines.push("# Gemeindequellen Live-Audit");
  lines.push("");
  lines.push(`Erstellt: ${report.summary.generatedAt}`);
  lines.push(`Datenbank: ${report.dbPath}`);
  lines.push("");
  lines.push("## Kurzfazit");
  lines.push("");
  lines.push(`- Gemeinden geprüft: ${report.summary.totalMunicipalities}`);
  lines.push(`- Als plausibel/ok eingestuft: ${report.summary.okMunicipalities}`);
  lines.push(`- Davon geschützte oder nicht voll einsehbare Quellen: ${report.summary.protectedMunicipalities}`);
  lines.push(`- Manuell nachprüfen: ${report.summary.needsReviewMunicipalities}`);
  lines.push(`- Verknüpfte Quellen insgesamt: ${report.summary.allLinkedSources}`);
  lines.push(`- Eindeutige URLs live abgerufen: ${report.summary.fetchedUniqueUrls}`);
  lines.push(`- Nicht abrufbare verknüpfte Quellen: ${report.summary.unreachableLinkedSources}`);
  lines.push(`- Erwartet nicht browsbare Zusatzquellen: ${report.summary.expectedProtectedLinkedSources}`);
  if (report.summary.externallyVerifiedLinkedSources > 0) {
    lines.push(`- Lokal nicht erreichbar, extern bestätigt: ${report.summary.externallyVerifiedLinkedSources}`);
  }
  lines.push("");
  lines.push("## Statusverteilung");
  lines.push("");
  lines.push("| Status | Anzahl |");
  lines.push("| --- | ---: |");
  lines.push(...statusRows);
  lines.push("");

  if (needsReview.length) {
    lines.push("## Manuell Nachprüfen");
    lines.push("");
    lines.push("| Gemeinde | Status | Rating | Quelle | Grund | Vorschlag |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const item of needsReview) {
      lines.push(
        `| ${markdownEscape(item.municipality)} | ${markdownEscape(item.status)} | ${markdownEscape(item.rating)} | ${markdownEscape(item.primaryUrl)} | ${markdownEscape(item.reason)} | ${markdownEscape(item.recommendation)} |`
      );
    }
    lines.push("");
  }

  if (protectedSources.length) {
    lines.push("## Geschützte Quellen");
    lines.push("");
    lines.push("| Gemeinde | Status | Quelle | Hinweis |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of protectedSources) {
      lines.push(
        `| ${markdownEscape(item.municipality)} | ${markdownEscape(item.status)} | ${markdownEscape(item.primaryUrl)} | ${markdownEscape(item.reason)} |`
      );
    }
    lines.push("");
  }

  lines.push("## Alle Gemeinden");
  lines.push("");
  lines.push("| Gemeinde | Status | Vertrauen | Rating | Quelle | Gefundene bessere Quelle |");
  lines.push("| --- | --- | ---: | --- | --- | --- |");
  for (const item of report.municipalities) {
    lines.push(
      `| ${markdownEscape(item.municipality)} | ${markdownEscape(item.status)} | ${item.confidence}% | ${markdownEscape(item.rating)} | ${markdownEscape(item.primaryUrl)} | ${markdownEscape(item.discovery?.url ?? "")} |`
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function recommendationFor(result) {
  if (result.status === "needs-review-no-url") {
    return "Offizielle Gemeindewebsite manuell prüfen und Primärquelle ergänzen.";
  }

  if (result.status === "needs-review-unreachable") {
    return "URL im Browser öffnen, Redirect/Domain prüfen und Quelle aktualisieren.";
  }

  if (result.status === "needs-review-weak-signal") {
    return "Auf der Gemeindewebsite nach Baugesuch, Baupublikation oder amtliche Publikation suchen.";
  }

  if (result.status.startsWith("protected")) {
    return "Als amtlich markieren, aber für Detailprüfung Portalzugang oder Browserkontrolle verwenden.";
  }

  if (result.status === "ok-discovered") {
    return "Gefundene bessere URL als Primärquelle übernehmen, falls sie stabil ist.";
  }

  return "Keine Aktion nötig.";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { sourceRows, operationalRows, applicationSummary } = loadRows(options.dbPath);
  const municipalities = groupMunicipalities(sourceRows, operationalRows);
  const fetchCache = new Map();

  async function fetchCached(url, timeoutMs = options.timeoutMs) {
    const key = normalizeUrl(url);

    if (!fetchCache.has(key)) {
      fetchCache.set(key, fetchPage(url, timeoutMs));
    }

    return fetchCache.get(key);
  }

  const linkAudits = await mapWithConcurrency(
    sourceRows,
    async (row) => {
      const url = sourceUrlFromLink(row);

      if (!url) {
        return {
          municipality: row.municipality,
          relationType: row.relation_type,
          sourceName: row.source_name,
          url: "",
          ok: false,
          status: 0,
          error: "missing-url"
        };
      }

      const page = await fetchCached(url);
      const score = scoreSourcePage(url, page, row);
      const externalVerification = getExternalVerification(url);
      const externallyVerified = Boolean(externalVerification && !page.ok);
      const expectedProtected =
        !page.ok &&
        page.status === 403 &&
        row.source_kind === "shared-dataset" &&
        /services directory/i.test(`${page.title} ${page.text}`);

      return {
        municipality: row.municipality,
        relationType: row.relation_type,
        sourceName: row.source_name,
        sourceKind: row.source_kind,
        url,
        finalUrl: page.finalUrl,
        ok: page.ok || externallyVerified,
        status: page.status,
        error: page.error,
        expectedProtected,
        externallyVerified,
        externalVerification,
        title: page.title,
        score: score.score,
        signals: score.signals
      };
    },
    options.concurrency
  );

  const primaryResults = await mapWithConcurrency(
    municipalities,
    async (municipality) => {
      const row = municipality.primaryLink;

      if (!row) {
        const result = {
          municipality: municipality.municipality,
          officialWebsite: municipality.officialWebsite,
          status: "needs-review-no-url",
          confidence: 0,
          rating: municipality.rating,
          uncertain: municipality.uncertain,
          primarySourceName: "",
          primarySourceKind: "",
          primaryUrl: "",
          finalUrl: "",
          httpStatus: 0,
          title: "",
          sourceScore: 0,
          scoreSignals: [],
          discovery: null,
          reason: "Keine Primärquelle verknüpft.",
          supplementalCount: municipality.supplementalCount
        };
        return {
          ...result,
          recommendation: recommendationFor(result)
        };
      }

      const primaryUrl = sourceUrlFromLink(row);
      const page = primaryUrl
        ? await fetchCached(primaryUrl)
        : {
            ok: false,
            status: 0,
            finalUrl: "",
            title: "",
            text: "",
            rawHtml: "",
            error: "missing-url"
          };
      const sourceScore = scoreSourcePage(primaryUrl, page, row);
      const externalVerification = getExternalVerification(primaryUrl);
      const shouldDiscover =
        !options.quick &&
        primaryUrl &&
        (!page.ok || sourceScore.score < 22 || municipality.uncertain || row.relation_type !== "primary");
      const discovery = shouldDiscover ? await discoverBetterSource(row, page, fetchCached, options.timeoutMs, options.quick) : null;
      const classification = classifyPrimary(row, page, sourceScore, discovery, externalVerification);
      const result = {
        municipality: municipality.municipality,
        officialWebsite: municipality.officialWebsite,
        status: classification.status,
        confidence: classification.confidence,
        rating: municipality.rating,
        uncertain: municipality.uncertain,
        primarySourceName: row.source_name,
        primarySourceKind: row.source_kind,
        primaryUrl,
        finalUrl: page.finalUrl,
        httpStatus: page.status,
        title: page.title,
        sourceScore: sourceScore.score,
        scoreSignals: sourceScore.signals,
        discovery,
        externalVerification,
        reason: classification.reason,
        supplementalCount: municipality.supplementalCount,
        sharedSourceNote: municipality.sharedSourceNote,
        rationale: municipality.rationale,
        operational: municipality.operational
      };

      return {
        ...result,
        recommendation: recommendationFor(result)
      };
    },
    Math.max(1, Math.floor(options.concurrency / 2))
  );

  const report = {
    dbPath: options.dbPath,
    options: {
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      quick: options.quick
    },
    summary: summarize(primaryResults, linkAudits, applicationSummary, fetchCache.size),
    municipalities: primaryResults,
    linkedSources: linkAudits
  };

  mkdirSync(options.outputDir, { recursive: true });
  const timestamp = report.summary.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(options.outputDir, `municipality-source-audit-${timestamp}.json`);
  const markdownPath = join(options.outputDir, `municipality-source-audit-${timestamp}.md`);
  const latestJsonPath = join(options.outputDir, "municipality-source-audit-latest.json");
  const latestMarkdownPath = join(options.outputDir, "municipality-source-audit-latest.md");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = buildMarkdown(report);

  writeFileSync(jsonPath, json, "utf8");
  writeFileSync(latestJsonPath, json, "utf8");

  if (!options.jsonOnly) {
    writeFileSync(markdownPath, markdown, "utf8");
    writeFileSync(latestMarkdownPath, markdown, "utf8");
  }

  console.log("Gemeindequellen Live-Audit");
  console.log(`DB: ${options.dbPath}`);
  console.log(`Gemeinden: ${report.summary.totalMunicipalities}`);
  console.log(`Ok/plausibel: ${report.summary.okMunicipalities}`);
  console.log(`Geschuetzt/nicht voll einsehbar: ${report.summary.protectedMunicipalities}`);
  console.log(`Manuell nachpruefen: ${report.summary.needsReviewMunicipalities}`);
  console.log(`Verknuepfte Quellen: ${report.summary.allLinkedSources}`);
  console.log(`Eindeutige URLs abgerufen: ${report.summary.fetchedUniqueUrls}`);
  console.log(`Nicht abrufbare verknuepfte Quellen: ${report.summary.unreachableLinkedSources}`);
  console.log(`Erwartet nicht browsbare Zusatzquellen: ${report.summary.expectedProtectedLinkedSources}`);
  if (report.summary.externallyVerifiedLinkedSources > 0) {
    console.log(`Lokal nicht erreichbar, extern bestaetigt: ${report.summary.externallyVerifiedLinkedSources}`);
  }
  console.log(`JSON: ${jsonPath}`);

  if (!options.jsonOnly) {
    console.log(`Markdown: ${markdownPath}`);
  }

  if (report.summary.needsReviewMunicipalities > 0) {
    console.log("");
    console.log("Manuell nachpruefen:");
    for (const item of primaryResults.filter((entry) => entry.status.startsWith("needs-review"))) {
      console.log(`- ${item.municipality}: ${item.status} | ${item.reason} | ${item.primaryUrl}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
