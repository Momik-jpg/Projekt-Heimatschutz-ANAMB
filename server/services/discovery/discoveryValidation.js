// Discovery-Belang: Muster, Konstanten und SSRF-sichere URL-/HTML-Helfer.
// Aus applicationsSyncDiscovery.js ausgelagert (Leaf-Ebene, keine internen Deps).
import { decodeHtmlEntities } from "../applicationsSyncCommon.js";

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
