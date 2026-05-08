import { createHash, randomBytes } from "node:crypto";
import { PDFParse } from "pdf-parse";
import { aargauMunicipalityNames } from "../seed/municipalitySources.js";

// Normalisierter Suchschlüssel für Gemeindenamen: ohne Diakritika, ohne
// Kantonszusatz "AG"/"(AG)", damit "Hausen AG" -> "Hausen" und "Arni" -> "Arni (AG)".
function normalizeMunicipalityKey(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\(ag\)/g, " ")
    .replace(/\bag\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const officialAargauMunicipalityByKey = new Map(
  aargauMunicipalityNames.map((name) => [normalizeMunicipalityKey(name), name])
);

// Gibt den offiziellen Aargauer Gemeindenamen zurück oder "" wenn der Wert
// keine echte Aargauer Gemeinde ist (z. B. Projekttext oder Fremdkantons-Ort).
function resolveOfficialAargauMunicipality(name) {
  const key = normalizeMunicipalityKey(name);
  return key ? officialAargauMunicipalityByKey.get(key) ?? "" : "";
}

const protectionStatusAliasMap = new Map([
  ["no-hit", "no-hit"],
  ["kein schutz", "no-hit"],
  ["kein schutz gefunden", "no-hit"],
  ["protected-point", "protected-point"],
  ["gebaude geschutzt", "protected-point"],
  ["gebäude geschützt", "protected-point"],
  ["treffer im gebaudeinventar", "protected-point"],
  ["treffer im gebäudeinventar", "protected-point"],
  ["protected-zone", "protected-zone"],
  ["gebiet geschutzt", "protected-zone"],
  ["gebiet geschützt", "protected-zone"],
  ["treffer in isos-flache", "protected-zone"],
  ["treffer in isos-fläche", "protected-zone"],
  ["combined-hit", "combined-hit"],
  ["gebaude + gebiet", "combined-hit"],
  ["gebäude + gebiet", "combined-hit"],
  ["manual-review", "manual-review"],
  ["manuell prufen", "manual-review"],
  ["manuell prüfen", "manual-review"]
]);

const workflowStatusAliasMap = new Map([
  ["new", "new"],
  ["neu", "new"],
  ["under-review", "under-review"],
  ["in prufung", "under-review"],
  ["in prüfung", "under-review"],
  ["escalated", "under-review"],
  ["zuerst prufen", "under-review"],
  ["zuerst prüfen", "under-review"],
  ["cleared", "cleared"],
  ["erledigt", "cleared"],
  ["archived", "archived"],
  ["abgelegt", "archived"]
]);

const defaultHtmlKeywordsPattern =
  /\b(baugesuch|baugesuche|baubewilligung|baupublikation|amtliche publikation|auflage|einsprachfrist|publikation)\b/i;
const defaultHtmlExcludePattern =
  /\b(home|startseite|kontakt|impressum|datenschutz|login|abmelden|mehr erfahren|weiterlesen)\b/i;
const genericMunicipalityListingPattern =
  /\b(facebook|instagram|youtube|linkedin|whatsapp|gemeinderatsnachrichten|nachrichten|newsletter|veranstaltungen|agenda|termine|vernehmlassung(?:en)?|news|aktuelles)\b/i;
const genericMunicipalityArchivePattern = /\b(rss|archiv|archive|newsarchive|author|category|feed)\b/i;
const nonPendingPermitPattern =
  /\b(erteilte baubewilligungen?|baubewilligung(?:en)? erteilt|erteilte bewilligungen?)\b/i;
const genericDownloadPattern = /\b(herunterladen|download)\b/i;
const genericMunicipalityAnchorPattern =
  /^(?:zu den dokumenten|mehr lesen|öffnen|herunterladen|download|weiter|details?|artikel lesen)$/i;
const monthYearListingPattern =
  /^(?:januar|februar|märz|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+20\d{2}$/i;
const genericLocationTermPattern =
  /\b(baugesuch(?:e)?|baubewilligung(?:en)?|baupublikation(?:en)?|publikation(?:en)?|öffentliche auflage|öffentliche auflage|amtliche publikation(?:en)?|gemeindequelle|gemeinde-webseite|wohnraumstrategie|einbürgerungen|einbürgerungen|gemeinderatsnachrichten|facebook)\b/i;
const clearlyNonAddressPattern =
  /\b(einwohnergemeinde|ortsbürgergemeinde|projektänderung|projektänderung|bauausschreibung|kanzlei|baupublikationen|auflagebaugesuche|amtliche publikationen?)\b/i;
const projectLikeAddressPattern =
  /\b(sanierung|umbau|umnutzung|anbau|neubau|ersatzneubau|erweiterung|ausbau|rückbau|rueckbau|renovation|aufwertungsmassnahmen?|baugesuch|publikation)\b/i;
const garbledProjectTypePattern = /^(?:[._-]*\d{2,}[._-]*)+$/;
const garbledStructuredTextPattern =
  /\b(name-sort|datum-sort|data-page-length|_kategorieid|_thumbnail|customerid=|readspeaker|sind sie sicher, dass sie diesen eintrag löschen möchten|cms cms)\b/i;
const unreliableProxyUrlPattern = /readspeaker\.com\/cgi-bin\/rsent/i;
const streetLikeAddressPattern =
  /(?:strasse|strasse|weg|gasse|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)\b/i;
const parcelLikeAddressPattern = /^Parzelle\s+\d{1,6}$/i;
// Generische "Strassenname + Hausnummer"-Adresse ohne bekanntes Strassen-Suffix
// (z. B. "Oberdorf 12", "Im Grund 4", "Vorstadt 3a"). Hausnummern auf 1-3 Stellen
// begrenzt, damit Jahreszahlen (2024) oder Postleitzahlen (5000) nicht fälschlich
// als Adresse geokodiert werden. So bekommen mehr echte Adressen automatisch
// Koordinaten statt "Von Hand prüfen".
const houseNumberAddressPattern =
  /^[A-Za-zÄÖÜäöü][A-Za-zÄÖÜäöüéèà.'-]*(?:\s+[A-Za-zÄÖÜäöüéèà0-9.'-]+){0,3}\s+\d{1,3}\s?[a-z]?$/u;
// Grobe Geocoder-Treffer (Gemeinde-, Bezirks-, Kantonsumriss, Ortschaftsname,
// Postleitzahl) sind keine genaue Verortung. Sie werden verworfen, damit ein
// unscharfer Treffer nie einen falschen "kein Schutz"-Befund erzeugt.
const coarseGeocoderOrigins = new Set([
  "gg25",
  "kantone",
  "district",
  "gazetteer",
  "sn25",
  "zipcode"
]);
const bgReferencePattern = /\bBG\s*20\d{2}(?:[-/.]\d+)?\b/i;
const weekdayPatternSource =
  "(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)";
const germanMonthPatternSource =
  "(?:januar|februar|märz|märz|april|mai|juni|juli|august|september|oktober|november|dezember)";
const swissNumericDatePatternSource = "\\d{1,2}\\.\\d{1,2}\\.20\\d{2}";
const swissTextualDatePatternSource = `(?:${weekdayPatternSource},?\\s*)?\\d{1,2}\\.\\s*${germanMonthPatternSource}\\s*20\\d{2}`;
const swissDateLikePatternSource = `(?:${swissNumericDatePatternSource}|${swissTextualDatePatternSource})`;
const defaultSyncRequestTimeoutMs = Number(process.env.SYNC_REQUEST_TIMEOUT_MS ?? 12000);
const defaultMunicipalitySourceConcurrency = Number(process.env.MUNICIPALITY_SYNC_CONCURRENCY ?? 8);
const defaultMunicipalityXmlLocationLimit = Number(process.env.MUNICIPALITY_XML_LOCATION_LIMIT ?? 80);
const defaultSwissGeocoderUrl =
  process.env.SWISS_GEOCODER_URL ?? "https://api3.geo.admin.ch/rest/services/api/SearchServer";
const defaultRemoteRequestHeaders = {
  "User-Agent": "HeimatschutzAargauBot/1.0 (+https://projekt-heimatschutz-anamb-production.up.railway.app)",
  "Accept-Language": "de-CH,de;q=0.9,en;q=0.8"
};
const germanMonthNumberMap = new Map([
  ["januar", "01"],
  ["februar", "02"],
  ["märz", "03"],
  ["marz", "03"],
  ["märz", "03"],
  ["april", "04"],
  ["mai", "05"],
  ["juni", "06"],
  ["juli", "07"],
  ["august", "08"],
  ["september", "09"],
  ["oktober", "10"],
  ["november", "11"],
  ["dezember", "12"]
]);
const relevantStructuredMetadataKeys = new Set([
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

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u");
}

function normalizeDate(value) {
  if (!value) {
    return "";
  }

  const text = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const swissMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})$/);

  if (swissMatch) {
    const [, day, month, year] = swissMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const textualMatch = text.match(
    new RegExp(
      `^(?:${weekdayPatternSource},?\\s*)?(\\d{1,2})\\.\\s*(${germanMonthPatternSource})\\s*(20\\d{2})$`,
      "i"
    )
  );

  if (textualMatch) {
    const [, day, monthName, year] = textualMatch;
    const month = germanMonthNumberMap.get(normalizeText(monthName));

    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  const parsed = new Date(text);

  if (!Number.isFinite(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString().slice(0, 10);
}

function addDays(dateValue, days) {
  const normalized = normalizeDate(dateValue);

  if (!normalized) {
    return "";
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }

    const text = String(value).trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeProtectionStatus(rawValue, ambiguousAddress) {
  if (ambiguousAddress) {
    return "manual-review";
  }

  const normalized = protectionStatusAliasMap.get(normalizeText(rawValue));
  return normalized ?? "no-hit";
}

function normalizeWorkflowStatus(rawValue) {
  const normalized = workflowStatusAliasMap.get(normalizeText(rawValue));
  return normalized ?? "new";
}

function normalizeCoordinates(item) {
  if (item.coordinates) {
    return String(item.coordinates).trim();
  }

  const east = Number(item.east ?? item.coordinateEast ?? item.lv95East);
  const north = Number(item.north ?? item.coordinateNorth ?? item.lv95North);

  if (Number.isFinite(east) && Number.isFinite(north)) {
    return `${east},${north}`;
  }

  return "";
}

function normalizeFeatureCoordinates(feature) {
  if (!feature || typeof feature !== "object") {
    return {};
  }

  const geometry = feature.geometry ?? {};

  if (Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    return {
      east: geometry.x,
      north: geometry.y
    };
  }

  if (Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const [east, north] = geometry.coordinates;

    if (Number.isFinite(east) && Number.isFinite(north)) {
      return {
        east,
        north
      };
    }
  }

  return {};
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  return [];
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultAgisMatch(protectionStatus, ambiguousAddress) {
  if (ambiguousAddress) {
    return "Noch nicht eindeutig zugeordnet";
  }

  if (protectionStatus === "combined-hit") {
    return "ISOS-Fläche und Gebäude im Inventar";
  }

  if (protectionStatus === "protected-point") {
    return "Treffer im Gebäudeinventar";
  }

  if (protectionStatus === "protected-zone") {
    return "Treffer in ISOS-Fläche";
  }

  if (protectionStatus === "manual-review") {
    return "Noch nicht eindeutig zugeordnet";
  }

  return "Kein Schutztreffer";
}

function buildGeneratedSourceReference(parts) {
  const basis = parts.map((entry) => String(entry ?? "").trim()).filter(Boolean).join("|");
  const hash = createHash("sha1").update(basis || randomBytes(8).toString("hex")).digest("hex");
  return `AUTO-${hash.slice(0, 16).toUpperCase()}`;
}

function createImportCandidate(rawItem, sourceUrl, fallbacks = {}) {
  if (!rawItem || typeof rawItem !== "object") {
    return rawItem;
  }

  const attributes = rawItem.attributes ?? rawItem.properties ?? rawItem;
  const featureCoordinates = normalizeFeatureCoordinates(rawItem);
  const parcel = firstNonEmptyValue(attributes.parcel, attributes.ParzNr, attributes.parzelle);
  const address =
    firstNonEmptyValue(
      attributes.address,
      attributes.Address,
      attributes.ADRESSE,
      attributes.Adresse,
      attributes.STRASSE,
      attributes.Strasse,
      attributes.strasse,
      attributes.location,
      attributes.standort,
      fallbacks.address
    ) ||
    (parcel ? `Parzelle ${parcel}` : "");

  const publicationDate = normalizeDate(
    attributes.publicationDate ??
      attributes.publication_date ??
      attributes.PUBLIKATIONSDATUM ??
      attributes.Publikationsdatum ??
      attributes.GES_EINGANG ??
      attributes.GES_ERFDAT
  );
  const deadlineDate = normalizeDate(
    attributes.deadlineDate ??
      attributes.deadline_date ??
      attributes.FRISTENDE ??
      attributes.Fristende ??
      attributes.AUFLAGEENDE ??
      attributes.Auflageende ??
      attributes.EINSPRACHE_ENDE ??
      attributes.Einsprachfrist
  );

  const automatedAssessmentNotes = [];

  if (!address && parcel) {
    automatedAssessmentNotes.push("Adresse im Import nicht vorhanden. Parzelle als Platzhalter verwenden.");
  }

  if (!deadlineDate) {
    automatedAssessmentNotes.push("Frist im Import nicht vorhanden. Bitte Frist von Hand prüfen.");
  }

  return {
    ...attributes,
    source: firstNonEmptyValue(attributes.source, fallbacks.source, "AGIS Export"),
    sourceReference: firstNonEmptyValue(
      attributes.sourceReference,
      attributes.source_reference,
      attributes.reference,
      attributes.GES_ID,
      attributes.BER_GES_NR,
      attributes.GES_NR,
      attributes.GlobalID,
      rawItem.id,
      fallbacks.sourceReference
    ),
    sourceUrl: firstNonEmptyValue(attributes.sourceUrl, attributes.source_url, attributes.URL, sourceUrl),
    municipality: firstNonEmptyValue(
      attributes.municipality,
      attributes.Gemeinde,
      attributes.gemeinde,
      attributes.ort,
      fallbacks.municipality
    ),
    address,
    parcel,
    east: featureCoordinates.east ?? attributes.KOORD_X ?? attributes.east ?? attributes.coordinateEast,
    north: featureCoordinates.north ?? attributes.KOORD_Y ?? attributes.north ?? attributes.coordinateNorth,
    publicationDate,
    deadlineDate,
    projectType: firstNonEmptyValue(
      attributes.projectType,
      attributes.project_type,
      attributes.bauvorhaben,
      attributes.GES_TITEL,
      attributes.GES_ART,
      attributes.GES_CD_BEZ,
      fallbacks.projectType,
      "Baugesuch"
    ),
    description:
      firstNonEmptyValue(attributes.description, attributes.beschreibung, fallbacks.description) ||
      [attributes.GES_STATUS, attributes.ERLCD_BEZ, attributes.Gruppenbezeichnung]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join(" | "),
    automatedAssessment:
      firstNonEmptyValue(attributes.automatedAssessment, attributes.automated_assessment) ||
      automatedAssessmentNotes.join(" ")
  };
}

function createNormalizedApplication(rawItem, sourceUrl, fallbacks = {}) {
  const item = createImportCandidate(rawItem, sourceUrl, fallbacks);
  const coordinates = normalizeCoordinates(item);
  const ambiguousAddress =
    Boolean(item.ambiguousAddress ?? item.ambiguous_address ?? fallbacks.ambiguousAddress ?? false) || !coordinates;
  const municipality = String(item.municipality ?? item.ort ?? fallbacks.municipality ?? "").trim();
  const parcel = String(item.parcel ?? item.parzelle ?? "").trim();
  const address = String(item.address ?? item.adresse ?? fallbacks.address ?? "").trim() || (parcel ? `Parzelle ${parcel}` : "");
  const publicationDate = normalizeDate(item.publicationDate ?? item.publication_date ?? item.publishedAt);
  const deadlineDate = normalizeDate(item.deadlineDate ?? item.deadline_date ?? item.fristende);
  const projectType = String(item.projectType ?? item.project_type ?? item.bauvorhaben ?? "Baugesuch").trim();
  const sourceReference =
    String(item.sourceReference ?? item.source_reference ?? item.reference ?? item.id ?? "").trim() ||
    buildGeneratedSourceReference([
      fallbacks.sourceReferenceSeed,
      municipality,
      address,
      publicationDate,
      projectType,
      sourceUrl
    ]);

  if (!sourceReference || !municipality || !address) {
    return null;
  }

  const protectionStatus = normalizeProtectionStatus(
    item.protectionStatus ?? item.protection_status ?? item.agisMatch ?? item.agis_match,
    ambiguousAddress
  );

  return {
    id: String(item.id ?? `BG-${randomBytes(6).toString("hex").toUpperCase()}`),
    source: String(item.source ?? fallbacks.source ?? "API").trim() || "API",
    sourceReference,
    sourceUrl: String(item.sourceUrl ?? item.source_url ?? sourceUrl ?? "").trim() || sourceUrl,
    municipality,
    address,
    parcel,
    coordinates,
    publicationDate,
    deadlineDate,
    projectType,
    description: String(item.description ?? item.beschreibung ?? fallbacks.description ?? "").trim(),
    protectionStatus,
    agisMatch: String(item.agisMatch ?? item.agis_match ?? defaultAgisMatch(protectionStatus, ambiguousAddress)).trim(),
    agisLayers: normalizeArray(item.agisLayers ?? item.agis_layers),
    workflowStatus: normalizeWorkflowStatus(item.workflowStatus ?? item.workflow_status),
    assignee: String(item.assignee ?? "").trim(),
    note: String(item.note ?? "").trim(),
    automatedAssessment: String(item.automatedAssessment ?? item.automated_assessment ?? "").trim(),
    ambiguousAddress: ambiguousAddress ? 1 : 0
  };
}

function parseApiPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  if (Array.isArray(payload?.features)) {
    return payload.features;
  }

  return [];
}

export function normalizeImportedPayload(payload, sourceUrl = "", fallbacks = {}) {
  return parseApiPayload(payload)
    .map((item) => createNormalizedApplication(item, sourceUrl, fallbacks))
    .filter(Boolean);
}

async function fetchWithTimeout(fetchImpl, resource, options = {}, timeoutMs = defaultSyncRequestTimeoutMs) {
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultSyncRequestTimeoutMs;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), normalizedTimeout);

  try {
    return await fetchImpl(resource, {
      ...options,
      headers: {
        ...defaultRemoteRequestHeaders,
        ...(options.headers ?? {})
      },
      signal: options.signal ?? controller.signal
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function mapWithConcurrency(items, worker, concurrency = defaultMunicipalitySourceConcurrency) {
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

function isArcGisServiceUrl(sourceUrl) {
  try {
    const parsedUrl = new URL(sourceUrl);
    return /\/(MapServer|FeatureServer)(\/\d+)?(\/query)?$/i.test(parsedUrl.pathname);
  } catch {
    return false;
  }
}

function looksLikeXmlSourceUrl(sourceUrl) {
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

function looksLikeJsonSourceUrl(sourceUrl) {
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

function withOptionalTokenHeaders(headers, sourceToken) {
  if (!sourceToken) {
    return headers;
  }

  return {
    ...headers,
    Authorization: `Bearer ${sourceToken}`
  };
}

function finalizeArcGisQueryUrl(sourceUrl, sourceToken) {
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

async function resolveArcGisQueryUrl(sourceUrl, sourceToken, fetchImpl) {
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

function extractXmlBlocks(xml, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  return [...String(xml ?? "").matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function decodeXmlValue(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1"))
  );
}

function extractXmlTagValue(xml, tagNames) {
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

function extractXmlAttributeValue(xml, tagName, attributeName) {
  const pattern = new RegExp(
    `<${escapeRegExp(tagName)}\\b[^>]*\\b${escapeRegExp(attributeName)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))[^>]*\\/?>`,
    "i"
  );
  const match = String(xml ?? "").match(pattern);
  return decodeXmlValue(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function resolveXmlUrl(urlValue, baseUrl) {
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

function extractFeedEntriesFromXml(xml, baseUrl) {
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

function extractSitemapUrlsFromXml(xml, baseUrl) {
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

async function resolveSitemapUrls(xml, source, fetchImpl, requestTimeoutMs, depth = 0, seenSitemaps = new Set()) {
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

function buildXmlPageDefaults(entry) {
  const publicationDate = normalizeDate(entry.publishedAt) || extractPublicationDateFromText(entry.rawText);
  return {
    publicationDate,
    deadlineDate: extractDeadlineDateFromText(entry.rawText) || (publicationDate ? addDays(publicationDate, 30) : "")
  };
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function looksLikeStandaloneDate(value) {
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

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
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
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(String(value ?? ""))
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

async function extractPdfTextFromBuffer(data) {
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

function extractAttributeValue(attributeText, attributeName) {
  const match = String(attributeText ?? "").match(
    new RegExp(`${attributeName}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i")
  );

  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function looksLikeTrustedEmbeddedSource(resolvedUrl, sourceUrl) {
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

function extractEmbeddedMunicipalityFrameCandidates(html, sourceUrl) {
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

    const src = extractAttributeValue(attributes, "src");

    if (!src || src.startsWith("javascript:") || src.startsWith("mailto:")) {
      continue;
    }

    try {
      const resolvedUrl = new URL(src, sourceUrl).toString();

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

function collectStructuredMetadataSnippets(value, key = "", snippets = []) {
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

function extractStructuredMetadataText(html) {
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

function sanitizeExtractedAddress(value) {
  const text = normalizeWhitespace(value)
    .replace(/^[,;:\-]+\s*/, "")
    .replace(/\s*[,;:\-]+$/, "");

  if (!text) {
    return "";
  }

  const cleanedText = normalizeWhitespace(
    text
      .replace(
        /^(?:Bauherrschaft|Bauherr|Gesuchsteller(?:\/in)?|Grundeigentümer(?:\/in)?)\s*:\s*[^,;]+,\s*/i,
        ""
      )
      .replace(/^[–-]\s*20\d{2}(?:[-/.]\d+)?\s*-\s*,?\s*/i, "")
      .replace(
        /\b(?:publiziert|publikation|veröffentlicht|frist(?:ende)?|einsprachfrist|auflage(?:frist)?|mehr lesen|zuletzt synchronisiert)\b[\s\S]*$/i,
        ""
      )
      .replace(/\.\s*(?:publiziert|publikation|veröffentlicht|frist(?:ende)?|einsprachfrist|auflage(?:frist)?).*$/i, "")
      .replace(/\b(?:Zone(?:\(n\))?|Weitere Bewilligungen?|Kant(?:onale)?\.?\s+Zustimmung|Planauflage|Zusatzgesuche?)\b[\s\S]*$/i, "")
      .replace(/\bGebäude\s+Nr\.?\s*\d+[A-Za-z]?\b[;,]?\s*/gi, "")
      .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
  );
  const parcel = extractParcelFromText(cleanedText);

  if (!cleanedText) {
    return "";
  }

  if (!/[A-Za-zÄÖÜäöü0-9]/u.test(cleanedText)) {
    return "";
  }

  if (
    looksLikeStandaloneDate(cleanedText) ||
    genericMunicipalityListingPattern.test(cleanedText) ||
    genericMunicipalityArchivePattern.test(cleanedText) ||
    garbledStructuredTextPattern.test(cleanedText)
  ) {
    return "";
  }

  if (nonPendingPermitPattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (genericDownloadPattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (bgReferencePattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (genericLocationTermPattern.test(cleanedText) && !streetLikeAddressPattern.test(cleanedText)) {
    return "";
  }

  if (
    clearlyNonAddressPattern.test(cleanedText) &&
    !streetLikeAddressPattern.test(cleanedText) &&
    !/\bParz(?:elle|\.| Nr\.?)?\b/i.test(cleanedText)
  ) {
    return "";
  }

  if (streetLikeAddressPattern.test(cleanedText)) {
    return cleanedText
      .replace(/^\s*Parz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\s*,?\s*/i, "")
      .replace(/\b(?:\d{4}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.\-]+(?:\s*\([^)]+\))?)\b/gu, "")
      .replace(/^[,;:\-]+\s*|\s*[,;:\-.]+$/g, "")
      .trim();
  }

  if (parcel) {
    return `Parzelle ${parcel}`;
  }

  return cleanedText;
}

function shortenText(value, maxLength = 320) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function removeNonContentHtmlRegions(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(
      /<(div|section|ul)\b[^>]*(?:id|class)\s*=\s*(?:"[^"]*\b(?:navbar|navigation|sidebar|off-canvas|breadcrumb|menu|footer|header)[^"]*"|'[^']*\b(?:navbar|navigation|sidebar|off-canvas|breadcrumb|menu|footer|header)[^']*')[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    );
}

function extractRelevantHtmlFragment(html) {
  const sanitizedHtml = removeNonContentHtmlRegions(html);
  const mainMatch = sanitizedHtml.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);

  if (mainMatch?.[0]) {
    return mainMatch[0];
  }

  const articleMatches = [...sanitizedHtml.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map((match) => match[0]);

  if (articleMatches.length > 0) {
    return articleMatches.join(" ");
  }

  return sanitizedHtml;
}

function extractEnclosingBlockHtml(html, anchorIndex) {
  const blockTags = ["p", "li", "article", "section", "tr"];
  let bestMatch = "";
  let bestLength = Number.POSITIVE_INFINITY;

  for (const tag of blockTags) {
    const start = html.lastIndexOf(`<${tag}`, anchorIndex);
    const end = html.indexOf(`</${tag}>`, anchorIndex);

    if (start === -1 || end === -1 || start > anchorIndex || end < anchorIndex) {
      continue;
    }

    const blockHtml = html.slice(start, end + tag.length + 3);

    if (blockHtml.length < bestLength) {
      bestMatch = blockHtml;
      bestLength = blockHtml.length;
    }
  }

  return bestMatch;
}

function extractMunicipalityUrlSignatureTokens(resolvedUrl) {
  try {
    const url = new URL(String(resolvedUrl ?? ""));
    const pathname = decodeURIComponent(url.pathname || "");
    const filename = pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.(?:html?|php|pdf)$/i, "")
      ?.replace(/[_-]+/g, " ")
      ?.trim() ?? "";
    const bgReference = pathname.match(/bg[-_.]?(20\d{2}(?:[-_.]?\d+)?)/i)?.[1] ?? "";

    return [...new Set(
      [pathname, filename, bgReference]
        .flatMap((value) => String(value ?? "").split(/\s+/))
        .map((value) => normalizeWhitespace(value).toLowerCase())
        .filter((value) => value.length >= 6)
    )];
  } catch {
    return [];
  }
}

function narrowMunicipalityContextHtml(blockHtml, anchorText, resolvedUrl) {
  const normalizedBlockHtml = String(blockHtml ?? "").trim();

  if (!normalizedBlockHtml) {
    return "";
  }

  const blockSegments = normalizedBlockHtml
    .split(/(?:<br\s*\/?>\s*){2,}(?=\s*<strong>\s*(?:Bauherr|Bauherrschaft|Bauobjekt|Bauvorhaben|Bauplatz)\s*:)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (blockSegments.length <= 1) {
    return normalizedBlockHtml;
  }

  const normalizedAnchorText = normalizeWhitespace(anchorText);
  const genericAnchorText = genericMunicipalityAnchorPattern.test(normalizedAnchorText);
  const urlSignatureTokens = extractMunicipalityUrlSignatureTokens(resolvedUrl);
  let normalizedPathname = "";

  try {
    normalizedPathname = new URL(resolvedUrl).pathname;
  } catch {
    normalizedPathname = "";
  }

  let bestSegment = "";
  let bestScore = 0;
  let bestLength = Number.POSITIVE_INFINITY;

  for (const segment of blockSegments) {
    const strippedSegment = stripHtml(segment);
    const normalizedSegment = strippedSegment.toLowerCase();
    let score = 0;

    if (resolvedUrl && segment.includes(resolvedUrl)) {
      score += 10;
    }

    if (normalizedPathname && segment.includes(normalizedPathname)) {
      score += 8;
    }

    for (const token of urlSignatureTokens) {
      if (normalizedSegment.includes(token)) {
        score += token.startsWith("20") ? 6 : 3;
      }
    }

    if (normalizedAnchorText && !genericAnchorText && strippedSegment.includes(normalizedAnchorText)) {
      score += 4;
    }

    if (score > bestScore || (score === bestScore && score > 0 && segment.length < bestLength)) {
      bestSegment = segment;
      bestScore = score;
      bestLength = segment.length;
    }
  }

  return bestScore > 0 ? bestSegment : normalizedBlockHtml;
}

function extractSwissCoordinatesFromText(value) {
  const match = String(value ?? "").match(/\b(2\d{6})\D+(1\d{6,7})\b/);

  if (!match) {
    return "";
  }

  return `${match[1]},${match[2]}`;
}

function extractParcelFromText(value) {
  const match = String(value ?? "").match(/\bParz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?(\d{1,6})\b/i);
  return match?.[1] ?? "";
}

function extractLabeledValue(value, label, trailingLabels = []) {
  const text = normalizeWhitespace(value);

  if (!text) {
    return "";
  }

  const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const trailingPattern = trailingLabels.length
    ? trailingLabels
        .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
        .join("|")
    : "";
  const pattern = trailingPattern
    ? new RegExp(`${labelPattern}\\s*:?\\s*(.+?)(?=\\b(?:${trailingPattern})\\b\\s*:|$)`, "i")
    : new RegExp(`${labelPattern}\\s*:?\\s*(.+)$`, "i");
  const match = text.match(pattern);

  return normalizeWhitespace(match?.[1] ?? "");
}

function extractAddressFromText(value) {
  const text = normalizeWhitespace(value).replace(/\bBaugesuch(?:e)?\b[:\s-]*/i, "");
  const addressTrailingLabels = [
    "Bauherr",
    "Bauherrschaft",
    "Gesuchsteller/in",
    "Grundeigentümer/in",
    "Grundeigentümer",
    "Bauobjekt",
    "Bauvorhaben",
    "Bauprojekt",
    "Bewilligungen",
    "Weitere Bewilligung",
    "Weitere Bewilligungen",
    "Frist",
    "Auflagefrist",
    "Planauflage",
    "Projektverfasser",
    "Publiziert",
    "Publikation",
    "Zone",
    "Zone(n)"
  ];
  const labeledAddressValues = [
    extractLabeledValue(text, "Bauplatz", addressTrailingLabels),
    extractLabeledValue(text, "Baustelle", addressTrailingLabels),
    extractLabeledValue(text, "Standort", addressTrailingLabels),
    extractLabeledValue(text, "Lage", addressTrailingLabels)
  ].filter(Boolean);

  for (const labeledValue of labeledAddressValues) {
    const parcel = extractParcelFromText(labeledValue);
    const streetCandidate = sanitizeExtractedAddress(
      labeledValue
        .replace(/^\s*Parz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\s*,?\s*/i, "")
        .replace(/,\s*Parz(?:elle|\.| Nr\.?)?.*$/i, "")
        .replace(/\bParz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\b/gi, "")
        .replace(/\bGebäude\s+Nr\.?\s*\d+[A-Za-z]?\b[;,]?\s*/gi, "")
        .replace(/\b(?:Zone(?:\(n\))?|Weitere Bewilligungen?|Kant(?:onale)?\.?\s+Zustimmung|Planauflage)\b.*$/i, "")
        .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
        .replace(/\s*\/\s*BG\s*20\d{2}\.\d+\b.*$/i, "")
        .replace(/\bBG\s*20\d{2}\.\d+\b.*$/i, "")
        .replace(/,\s*BG\s*20\d{2}\.\d+\b.*$/i, "")
        .trim()
    );

    if (
      streetCandidate &&
      (streetLikeAddressPattern.test(streetCandidate) ||
        (/\b\d{1,4}[A-Za-z]?\b/.test(streetCandidate) &&
          /[A-Za-zÄÖÜäöü]/u.test(streetCandidate) &&
          !looksLikeStandaloneDate(streetCandidate)))
    ) {
      return streetCandidate;
    }

    if (parcel) {
      return `Parzelle ${parcel}`;
    }
  }

  const patterns = [
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.\-]*(?:strasse|strasse|weg|gasse|gässli|gaessli|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)\s+\d+[A-Za-z]?)\b/ui,
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.\-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.\-]+)+(?:strasse|strasse|weg|gasse|gässli|gaessli|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)?\s+\d+[A-Za-z]?)\b/u
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const sanitized = sanitizeExtractedAddress(match[1]);

      if (sanitized) {
        return sanitized;
      }
    }
  }

  return "";
}

function extractAddressFromPublicationTitle(value) {
  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    return "";
  }

  const slashSegments = normalizedValue
    .split(/\s*\/\s*/)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);

  for (let index = slashSegments.length - 1; index >= 0; index -= 1) {
    const candidate = extractAddressFromText(slashSegments[index]);

    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function extractAddressFromSourceUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const rawSegment =
      /^\d+$/.test(pathSegments.at(-1) ?? "") && pathSegments.length > 1
        ? pathSegments.at(-2) ?? ""
        : pathSegments.at(-1) ?? "";
    const lastSegment = decodeURIComponent(rawSegment)
      .replace(/\.(?:html?|php|pdf)$/i, "")
      .replace(/^bg[-_]?20\d{2}(?:[-_.]?\d+)?[-_]?/i, "")
      .replace(/_/g, " ")
      .replace(/-/g, " ");
    const normalizedSegment =
      !/[A-ZÄÖÜ]/u.test(lastSegment) && /[a-zäöü]/u.test(lastSegment)
        ? lastSegment
            .split(/\s+/)
            .map((segment) => {
              if (/^\d+[A-Za-z]?$/.test(segment)) {
                return segment;
              }

              return segment.charAt(0).toUpperCase() + segment.slice(1);
            })
            .join(" ")
        : lastSegment;

    return extractAddressFromText(normalizedSegment);
  } catch {
    return "";
  }
}

function chooseMoreSpecificAddress(primaryAddress, secondaryAddress) {
  const primary = sanitizeExtractedAddress(primaryAddress);
  const secondary = sanitizeExtractedAddress(secondaryAddress);

  if (!primary) {
    return secondary;
  }

  if (!secondary) {
    return primary;
  }

  const primaryHasHouseNumber = /\d+[A-Za-z]?$/.test(primary);
  const secondaryHasHouseNumber = /\d+[A-Za-z]?$/.test(secondary);
  const primaryIsParcel = parcelLikeAddressPattern.test(primary);
  const secondaryIsParcel = parcelLikeAddressPattern.test(secondary);
  const primaryLooksStreetLike = streetLikeAddressPattern.test(primary);
  const secondaryLooksStreetLike = streetLikeAddressPattern.test(secondary);

  if (secondaryHasHouseNumber && !primaryHasHouseNumber) {
    return secondary;
  }

  if (primaryIsParcel && !secondaryIsParcel) {
    return secondary;
  }

  if (secondaryLooksStreetLike && !primaryLooksStreetLike) {
    return secondary;
  }

  if (primaryLooksStreetLike && secondaryLooksStreetLike) {
    if (secondary.includes("/") && !primary.includes("/")) {
      return secondary;
    }

    if (secondary.length > primary.length + 6) {
      return secondary;
    }
  }

  return primary;
}

function formatImportedMunicipalityAddress(address) {
  const normalizedAddress = sanitizeExtractedAddress(address);

  if (!normalizedAddress) {
    return "";
  }

  if (/[A-ZÄÖÜ]/u.test(normalizedAddress) || !/[a-zäöü]/u.test(normalizedAddress)) {
    return normalizedAddress;
  }

  return normalizedAddress
    .split(/\s+/)
    .map((segment) => {
      if (/^\d+[A-Za-z]?$/.test(segment)) {
        return segment;
      }

      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(" ");
}

function normalizeImportedMunicipalityAddress(address, parcel = "") {
  const normalizedAddress = sanitizeExtractedAddress(address);
  const looksStreetLike = streetLikeAddressPattern.test(normalizedAddress);
  const looksParcelLike = parcelLikeAddressPattern.test(normalizedAddress);

  if (
    !normalizedAddress ||
    normalizedAddress.length > 120 ||
    /(?:öffentliche auflage|baugesuch(?:-nr)?|publiziert|planauflage|auflagefrist|gemeindekanzlei)/i.test(normalizedAddress) ||
    (!looksStreetLike && !looksParcelLike && projectLikeAddressPattern.test(normalizedAddress)) ||
    /^\d{4,}/.test(normalizedAddress)
  ) {
    return parcel ? `Parzelle ${parcel}` : "";
  }

  return formatImportedMunicipalityAddress(normalizedAddress);
}

function projectTypeSpecificity(projectType) {
  if (!projectType || projectType === "Nicht importieren") {
    return 0;
  }

  if (projectType === "Baugesuch") {
    return 1;
  }

  return 2;
}

function cleanProjectFilePathText(value) {
  let normalized = normalizeWhitespace(value);

  if (!normalized || !/\\|\/|\.(?:pln|dwg|dxf|ifc|pdf)\b/i.test(normalized)) {
    return normalized;
  }

  const projectKeywordMatch = normalized.match(/\b(?:Bauprojekt|Bauvorhaben)\b\s+(.+)/i);

  if (projectKeywordMatch?.[1]) {
    normalized = projectKeywordMatch[1];
  }

  normalized = normalized
    .replace(/\b\d{4}\s+[A-ZÄÖÜ][\wÄÖÜäöüéèà .'-]+?\s+1:\d+\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
    .replace(/\b1:\d+\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
    .replace(/\b\d{1,2}\.\d{1,2}\.20\d{2}\s+[A-Z]{2,}.*$/i, "")
    .replace(/^[\\/\w.-]+\.(?:pln|dwg|dxf|ifc|pdf)\b\s*/i, "")
    .replace(/^[A-Z]\s+(?=\b(?:Bauprojekt|Bauvorhaben)\b)/i, "")
    .replace(/\s*[,;:\-]+\s*$/g, "")
    .trim();

  return normalizeWhitespace(normalized);
}

function normalizeImportedProjectType(projectType, sourceUrl = "") {
  let normalizedProjectType = normalizeWhitespace(projectType).replace(/^[,;:\-]+\s*/, "");
  normalizedProjectType = cleanProjectFilePathText(normalizedProjectType);
  const hasAarauDetailFallback = /\.aarau\.ch\/.*\/bg[-_.]?20\d{2}/i.test(sourceUrl);

  if (!normalizedProjectType) {
    return hasAarauDetailFallback ? "Baugesuch" : "";
  }

  if (
    normalizedProjectType.length > 140 ||
    /(?:bauplatz|\blage\b|standort|bauherr|bauherrschaft|grundeigent|projektverfasser|publiziert|planauflage|weitere bewilligung|\[\s*mehr\s*\])/i.test(
      normalizedProjectType
    ) ||
    /^(?:zu den dokumenten|herunterladen|download|mehr lesen|seite drucken|öffnen|amtsblatt öffnen|agis-karte öffnen|übersichtsseite öffnen)$/i.test(
      normalizedProjectType
    ) ||
    /^öffentliche auflage\b/i.test(normalizedProjectType) ||
    garbledProjectTypePattern.test(normalizedProjectType) ||
    /^\d{4,}/.test(normalizedProjectType)
  ) {
    return hasAarauDetailFallback ? "Baugesuch" : "";
  }

  return normalizedProjectType;
}

function extractDateRangeFromText(value) {
  const text = normalizeWhitespace(value);
  const dashMatch = text.match(new RegExp(`(${swissDateLikePatternSource})\\s*[–-]\\s*(${swissDateLikePatternSource})`, "i"));

  if (dashMatch?.[1] && dashMatch?.[2]) {
    return {
      publicationDate: normalizeDate(dashMatch[1]),
      deadlineDate: normalizeDate(dashMatch[2])
    };
  }

  const rangeMatch = text.match(
    new RegExp(`\\bvom\\b\\s*(${swissDateLikePatternSource})[\\s\\S]{0,40}?\\bbis\\b\\s*(${swissDateLikePatternSource})`, "i")
  );

  if (!rangeMatch?.[1] || !rangeMatch?.[2]) {
    return {
      publicationDate: "",
      deadlineDate: ""
    };
  }

  return {
    publicationDate: normalizeDate(rangeMatch[1]),
    deadlineDate: normalizeDate(rangeMatch[2])
  };
}

function extractPublicationDateFromText(value) {
  const text = normalizeWhitespace(value);
  const range = extractDateRangeFromText(text);

  if (range.publicationDate) {
    return range.publicationDate;
  }

  const contextualMatch = text.match(
    new RegExp(`\\b(?:publiziert|publikation|veröffentlicht|auflage vom|aufgelegt am|vom)\\D{0,20}(${swissDateLikePatternSource})`, "i")
  );

  if (contextualMatch?.[1]) {
    return normalizeDate(contextualMatch[1]);
  }

  const isoDateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)?/);

  if (isoDateMatch?.[1]) {
    return isoDateMatch[1];
  }

  const firstMatch = text.match(new RegExp(`\\b(${swissDateLikePatternSource})\\b`, "i"));
  return firstMatch?.[1] ? normalizeDate(firstMatch[1]) : "";
}

function extractDeadlineDateFromText(value) {
  const text = normalizeWhitespace(value);
  const range = extractDateRangeFromText(text);

  if (range.deadlineDate) {
    return range.deadlineDate;
  }

  const contextualMatch = text.match(
    new RegExp(
      `\\b(?:frist(?:ende)?|einsprachfrist|auflage(?:frist)?(?: bis| ende)?|bis spätestens|bis)\\D{0,20}(${swissDateLikePatternSource})`,
      "i"
    )
  );

  if (contextualMatch?.[1]) {
    return normalizeDate(contextualMatch[1]);
  }

  return "";
}

function extractProjectTypeFromText(value, fallback = "", address = "", sourceUrl = "") {
  const projectTypeLabels = ["Bauobjekt", "Bauvorhaben", "Bauprojekt"];
  const projectTypeTrailingLabels = [
    "Bauplatz",
    "Baustelle",
    "Standort",
    "Lage",
    "Bauherr",
    "Bauherrschaft",
    "Gesuchsteller/in",
    "Grundeigentümer/in",
    "Grundeigentümer",
    "Projektverfasser",
    "Bewilligungen",
    "Weitere Bewilligung",
    "Weitere Bewilligungen",
    "Frist",
    "Auflagefrist",
    "Planauflage",
    "Publiziert",
    "Publikation"
  ];

  for (const label of projectTypeLabels) {
    const labeledValue = extractLabeledValue(value, label, projectTypeTrailingLabels);

    if (labeledValue) {
      return cleanPublicationProjectSegment(labeledValue, address).replace(/[.;:,]\s*$/u, "");
    }
  }

  const publicationTitleProjectType = extractProjectTypeFromPublicationTitle(value, address, sourceUrl);

  if (publicationTitleProjectType) {
    return publicationTitleProjectType;
  }

  const normalizedFallback = normalizeWhitespace(fallback);
  const normalizedValue = normalizeWhitespace(value);

  if (nonPendingPermitPattern.test(normalizedValue)) {
    return "Nicht importieren";
  }

  if (
    !normalizedFallback ||
    looksLikeStandaloneDate(normalizedFallback) ||
    genericMunicipalityListingPattern.test(normalizedFallback) ||
    genericMunicipalityArchivePattern.test(normalizedFallback) ||
    genericDownloadPattern.test(normalizedFallback)
  ) {
    return "Baugesuch";
  }

  return shortenText(normalizedFallback, 120);
}

function cleanPublicationProjectSegment(value, address = "") {
  if (!value) {
    return "";
  }

  const normalizedAddress = sanitizeExtractedAddress(address);
  let text = normalizeWhitespace(value)
    .replace(new RegExp(`\\s*-\\s*(?:frist|auflage|publiziert)\\b[\\s\\S]*$`, "i"), "")
    .replace(/\bBG\s*20\d{2}(?:[-/.]\d+)?\b/gi, "")
    .replace(/\bBaugesuch(?:e)?\b[:\s-]*/gi, "")
    .replace(/\bÖffentliche(?:r|)? Auflage\b[:\s-]*/gi, "")
    .replace(/\bAmtliche Publikation(?:en)?\b[:\s-]*/gi, "")
    .replace(/\bPublikation\b[:\s-]*/gi, "")
    .replace(/\b(?:Gesuchsteller(?:\/in)?|Grundeigentümer(?:\/in)?|Bauherr(?:schaft)?|Projektverfasser)\b.*$/i, "")
    .replace(/\bZusatzgesuche?\b.*$/i, "")
    .replace(/\bFrist bis\b[\s\S]*$/i, "")
    .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
    .replace(/^[,;/\s-]+|[,;/\s-]+$/g, "")
    .trim();

  if (normalizedAddress) {
    text = text
      .replace(new RegExp(`(?:,|/)?\\s*${escapeRegExp(normalizedAddress)}\\b`, "i"), "")
      .replace(/^[,;/\s-]+|[,;/\s-]+$/g, "")
      .trim();
  }

  if (
    !text ||
    garbledStructuredTextPattern.test(text) ||
    genericDownloadPattern.test(text) ||
    genericMunicipalityArchivePattern.test(text) ||
    genericMunicipalityListingPattern.test(text) ||
    monthYearListingPattern.test(text) ||
    looksLikeStandaloneDate(text)
  ) {
    return "";
  }

  return shortenText(text, 120);
}

function extractProjectTypeFromPublicationTitle(value, address = "", sourceUrl = "") {
  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    return "";
  }

  const rawSlashSegments = normalizedValue.split(/\s*\/\s*/).map((segment) => normalizeWhitespace(segment)).filter(Boolean);
  const baugesuchSegmentIndex = rawSlashSegments.findIndex((segment) => /\bbaugesuch\b/i.test(segment));

  if (baugesuchSegmentIndex >= 0 && rawSlashSegments[baugesuchSegmentIndex + 1]) {
    return cleanPublicationProjectSegment(rawSlashSegments[baugesuchSegmentIndex + 1], address);
  }

  const withoutDeadline = normalizedValue.replace(/\s*-\s*frist\b[\s\S]*$/i, "").trim();
  const normalizedAddress = sanitizeExtractedAddress(address);
  const publicationTitleSegments = normalizedValue
    .split(/\s*,\s*/)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);

  if (
    /^baugesuch$/i.test(publicationTitleSegments[0] ?? "") &&
    publicationTitleSegments.length >= 3 &&
    (streetLikeAddressPattern.test(publicationTitleSegments[2]) || /\bParz(?:elle|\.| Nr\.?)?\s*\d{1,6}\b/i.test(publicationTitleSegments[2]))
  ) {
    const likelyApplicant = publicationTitleSegments[1] ?? "";

    if (likelyApplicant && !streetLikeAddressPattern.test(likelyApplicant) && !/\bparz/i.test(likelyApplicant)) {
      return "Baugesuch";
    }
  }

  if (withoutDeadline.includes(";")) {
    const afterSemicolon = withoutDeadline.split(";").slice(1).join(";").trim();
    const semicolonCandidate = cleanPublicationProjectSegment(afterSemicolon, normalizedAddress);

    if (semicolonCandidate) {
      return semicolonCandidate;
    }
  }

  if (normalizedAddress) {
    const lowerTitle = withoutDeadline.toLowerCase();
    const lowerAddress = normalizedAddress.toLowerCase();
    const addressIndex = lowerTitle.indexOf(lowerAddress);

    if (addressIndex > 0) {
      const beforeAddress = withoutDeadline
        .slice(0, addressIndex)
        .replace(/[,\s;/-]+$/g, "")
        .trim();
      const segments = beforeAddress
        .split(/\s*[;,/]\s*/)
        .map((segment) => cleanPublicationProjectSegment(segment, normalizedAddress))
        .filter(Boolean);
      const lastSegment = segments.at(-1);

      if (lastSegment) {
        return lastSegment;
      }
    }
  }

  if (sourceUrl) {
    try {
      const url = new URL(String(sourceUrl));
      const filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "")
        .replace(/\.(?:html?|php|pdf)$/i, "")
        .replace(/[_-]+/g, " ");
      const filenameCandidate = cleanPublicationProjectSegment(filename, normalizedAddress);

      if (filenameCandidate) {
        return filenameCandidate;
      }
    } catch {
      // Ignore malformed urls and fall back to the existing heuristics.
    }
  }

  return "";
}

function extractPagePublicationDefaults(pageText) {
  const headerText = normalizeWhitespace(pageText).slice(0, 1600);
  const rangeMatch = headerText.match(
    new RegExp(
      `\\b(?:öffentliche auflage|auflage|publikation)\\b[\\s\\S]{0,80}?\\bvom\\b\\s*(${swissDateLikePatternSource})[\\s\\S]{0,40}?\\bbis\\b\\s*(${swissDateLikePatternSource})`,
      "i"
    )
  );

  if (rangeMatch?.[1] && rangeMatch?.[2]) {
    return {
      publicationDate: normalizeDate(rangeMatch[1]),
      deadlineDate: normalizeDate(rangeMatch[2])
    };
  }

  const isoDateMatch = headerText.match(/\b(20\d{2}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)?/);

  if (isoDateMatch?.[1]) {
    return {
      publicationDate: isoDateMatch[1],
      deadlineDate: ""
    };
  }

  return {
    publicationDate: "",
    deadlineDate: ""
  };
}

function buildMunicipalitySourceReference(source, resolvedUrl, contextText) {
  return buildGeneratedSourceReference([source.id, source.municipality, resolvedUrl, contextText]);
}

function normalizeMunicipalityResolvedUrl(resolvedUrl) {
  try {
    const url = new URL(String(resolvedUrl ?? ""));
    url.hash = "";
    return url.toString();
  } catch {
    return normalizeWhitespace(resolvedUrl);
  }
}

function buildMunicipalityLinkedSourceReference(source, resolvedUrl, contextText) {
  const normalizedResolvedUrl = normalizeMunicipalityResolvedUrl(resolvedUrl);

  if (normalizedResolvedUrl && normalizedResolvedUrl !== normalizeMunicipalityResolvedUrl(source.sourceUrl)) {
    return buildGeneratedSourceReference([source.id, source.municipality, normalizedResolvedUrl]);
  }

  return buildMunicipalitySourceReference(source, resolvedUrl, contextText);
}

function mergePageDefaults(...values) {
  return {
    publicationDate: firstNonEmptyValue(...values.map((value) => value?.publicationDate ?? "")),
    deadlineDate: firstNonEmptyValue(...values.map((value) => value?.deadlineDate ?? ""))
  };
}

function looksLikePdfUrl(value) {
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

function evaluateMunicipalityCandidateDetails(resolvedUrl, candidateText, pageDefaults = {}) {
  const publicationTitleAddress = extractAddressFromPublicationTitle(candidateText);
  const address = chooseMoreSpecificAddress(
    chooseMoreSpecificAddress(publicationTitleAddress, extractAddressFromText(candidateText)),
    extractAddressFromSourceUrl(resolvedUrl)
  );
  const parcel = extractParcelFromText(candidateText);
  const coordinates = extractSwissCoordinatesFromText(`${resolvedUrl} ${candidateText}`);
  const publicationDate = extractPublicationDateFromText(candidateText) || pageDefaults.publicationDate || "";
  const deadlineDate = extractDeadlineDateFromText(candidateText) || pageDefaults.deadlineDate || "";
  const hasStrongKeyword = /\b(baugesuch|baugesuche|baupublikation|baubewilligung)\b/i.test(
    `${resolvedUrl} ${candidateText}`
  );
  const looksLikePdf = looksLikePdfUrl(resolvedUrl);
  const hasStableIdentifiers = Boolean(address || parcel || coordinates);
  const hasPublicationMetadata = Boolean(publicationDate || deadlineDate);
  const looksGenericListingEntry =
    genericMunicipalityListingPattern.test(candidateText) ||
    genericMunicipalityArchivePattern.test(candidateText) ||
    garbledStructuredTextPattern.test(candidateText) ||
    nonPendingPermitPattern.test(candidateText) ||
    monthYearListingPattern.test(candidateText) ||
    /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.\-]+\s+20\d{2}$/u.test(candidateText);

  return {
    address,
    parcel,
    coordinates,
    publicationDate,
    deadlineDate,
    hasStrongKeyword,
    looksLikePdf,
    hasStableIdentifiers,
    hasPublicationMetadata,
    looksGenericListingEntry
  };
}

function looksLikeListingSourceUrl(resolvedUrl, sourceUrl) {
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

function looksLikeMunicipalityDetailUrl(resolvedUrl) {
  try {
    const url = new URL(resolvedUrl);
    return /\/news\/\d+\b|detailansicht|tt_news|\/baugesuch[-_/]|\/bg[-_.]?20\d{2}/i.test(
      `${url.pathname}${url.search}`
    );
  } catch {
    return false;
  }
}

function shouldInspectMunicipalityPdfDocument(
  resolvedUrl,
  sourceUrl,
  candidateText,
  pageDefaults = {},
  fallbackLabel = ""
) {
  if (looksLikeListingSourceUrl(resolvedUrl, sourceUrl) || !looksLikePdfUrl(resolvedUrl)) {
    return false;
  }

  const matchingText = normalizeWhitespace([candidateText, fallbackLabel, resolvedUrl].filter(Boolean).join(" "));
  const details = evaluateMunicipalityCandidateDetails(resolvedUrl, matchingText, pageDefaults);
  const projectType = normalizeImportedProjectType(
    extractProjectTypeFromText(matchingText, fallbackLabel, details.address, resolvedUrl),
    resolvedUrl
  );
  const hasConcreteHint =
    bgReferencePattern.test(matchingText) ||
    streetLikeAddressPattern.test(matchingText) ||
    /\bParz(?:elle|\.| Nr\.?)?\s*\d{1,6}\b/i.test(matchingText);
  const needsMoreData =
    !details.hasStableIdentifiers ||
    !details.hasPublicationMetadata ||
    projectTypeSpecificity(projectType) <= 1;

  if (
    !hasConcreteHint ||
    !needsMoreData ||
    details.looksGenericListingEntry ||
    nonPendingPermitPattern.test(matchingText)
  ) {
    return false;
  }

  return true;
}

function shouldInspectMunicipalityDetailPage(resolvedUrl, sourceUrl, candidateText, pageLooksLikePublicationPage) {
  if (looksLikeListingSourceUrl(resolvedUrl, sourceUrl)) {
    return false;
  }

  if (looksLikePdfUrl(resolvedUrl)) {
    return false;
  }

  if (looksLikeMunicipalityDetailUrl(resolvedUrl)) {
    return true;
  }

  if (!pageLooksLikePublicationPage) {
    return false;
  }

  const text = normalizeWhitespace(candidateText);

  return Boolean(
    text &&
      !defaultHtmlExcludePattern.test(text) &&
      !genericMunicipalityListingPattern.test(text) &&
      !genericMunicipalityArchivePattern.test(text) &&
      !nonPendingPermitPattern.test(text) &&
      (defaultHtmlKeywordsPattern.test(text) || bgReferencePattern.test(text))
  );
}

function extractHtmlMetadataText(html) {
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

async function loadEmbeddedMunicipalityRelevantHtml(html, source, fetchImpl, requestTimeoutMs, cache) {
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

function buildSwissGeocodeQueryUrl(address, municipality) {
  const query = `${address}, ${municipality}, Aargau, Schweiz`;
  const url = new URL(defaultSwissGeocoderUrl);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "address,parcel");
  url.searchParams.set("searchText", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("sr", "2056");
  return url.toString();
}

function extractSwissCoordinatesFromGeocoderPayload(payload, municipality) {
  const normalizedMunicipality = normalizeText(municipality);
  const candidates = [
    ...(Array.isArray(payload?.results) ? payload.results : []),
    ...(Array.isArray(payload?.features) ? payload.features : [])
  ];

  for (const candidate of candidates) {
    const attrs = candidate?.attrs ?? candidate?.properties ?? {};
    const origin = normalizeText(attrs.origin ?? attrs.featureId ?? "");

    // Nur grobe Treffer (Gemeinde-/Bezirks-/Kantonsumriss usw.) verwerfen.
    // Treffer ohne Origin-Angabe bleiben zugelassen (Abwärtskompatibilität).
    if (origin && coarseGeocoderOrigins.has(origin)) {
      continue;
    }

    const label = normalizeText(
      [
        candidate?.label,
        attrs.label,
        attrs.origin,
        attrs.municipality,
        attrs.gemeinde,
        attrs.detail,
        attrs.text
      ]
        .filter(Boolean)
        .join(" ")
    );

    if (normalizedMunicipality && label && !label.includes(normalizedMunicipality)) {
      continue;
    }

    const geometryCoordinates = candidate?.geometry?.coordinates;

    if (Array.isArray(geometryCoordinates) && geometryCoordinates.length >= 2) {
      const [east, north] = geometryCoordinates.map((value) => Number(value));

      if (Number.isFinite(east) && Number.isFinite(north)) {
        return `${east},${north}`;
      }
    }

    const east = Number(attrs.x ?? attrs.easting ?? attrs.east ?? candidate?.x);
    const north = Number(attrs.y ?? attrs.northing ?? attrs.north ?? candidate?.y);

    if (Number.isFinite(east) && Number.isFinite(north)) {
      return `${east},${north}`;
    }
  }

  return "";
}

async function geocodeMunicipalityAddress(address, municipality, fetchImpl, requestTimeoutMs, cache) {
  if (
    !fetchImpl ||
    !address ||
    !municipality ||
    (!streetLikeAddressPattern.test(address) &&
      !parcelLikeAddressPattern.test(address) &&
      !houseNumberAddressPattern.test(address))
  ) {
    return "";
  }

  const cacheKey = `${municipality}::${address}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

    const pending = (async () => {
    const response = await fetchWithTimeout(
      fetchImpl,
      buildSwissGeocodeQueryUrl(address, municipality),
      {
        headers: {
          Accept: "application/json"
        }
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      return "";
    }

    const payload = await response.json();
    return extractSwissCoordinatesFromGeocoderPayload(payload, municipality);
  })().catch(() => "");

  cache.set(cacheKey, pending);
  return pending;
}

function looseMunicipalityToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(ag\)/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/[^a-z0-9]/g, "");
}

// Verortet eine Parzelle über die amtliche Parzellensuche von geo.admin
// (origins=parcel, Format "<Gemeinde> <Nummer>"). So bekommen die vielen rein
// parzellenbasierten Baugesuche echte Koordinaten statt "Von Hand prüfen".
async function geocodeMunicipalityParcel(parcelNumber, municipality, fetchImpl, requestTimeoutMs, cache) {
  if (!fetchImpl || !parcelNumber || !municipality) {
    return "";
  }

  const cacheKey = `parcel::${municipality}::${parcelNumber}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const pending = (async () => {
    const url = new URL(defaultSwissGeocoderUrl);
    url.searchParams.set("type", "locations");
    url.searchParams.set("origins", "parcel");
    url.searchParams.set("searchText", `${municipality} ${parcelNumber}`);
    url.searchParams.set("limit", "20");
    url.searchParams.set("sr", "2056");

    const response = await fetchWithTimeout(
      fetchImpl,
      url.toString(),
      { headers: { Accept: "application/json" } },
      requestTimeoutMs
    );

    if (!response.ok) {
      return "";
    }

    const payload = await response.json();
    const wantedParcel = String(parcelNumber);
    const wantedMunicipality = looseMunicipalityToken(municipality);

    for (const candidate of Array.isArray(payload?.results) ? payload.results : []) {
      const attrs = candidate?.attrs ?? {};
      const detail = String(attrs.detail ?? "");
      const tokens = detail.trim().split(/\s+/);

      if (tokens[0] !== wantedParcel || !looseMunicipalityToken(detail).includes(wantedMunicipality)) {
        continue;
      }

      const x = Number(attrs.x);
      const y = Number(attrs.y);

      if (Number.isFinite(x) && Number.isFinite(y)) {
        return `${x},${y}`;
      }
    }

    return "";
  })().catch(() => "");

  cache.set(cacheKey, pending);
  return pending;
}

async function loadMunicipalityDetailPageData(
  resolvedUrl,
  source,
  fetchImpl,
  requestTimeoutMs,
  cache,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  if (cache.has(resolvedUrl)) {
    return cache.get(resolvedUrl);
  }

  const pending = (async () => {
    const response = await fetchWithTimeout(
      fetchImpl,
      resolvedUrl,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/pdf"
        }
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      return null;
    }

    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();

    if (
      contentType.includes("pdf") ||
      (contentType.includes("application/octet-stream") && looksLikePdfUrl(resolvedUrl))
    ) {
      if (typeof pdfTextExtractImpl !== "function") {
        return null;
      }

      const pdfBuffer = new Uint8Array(await response.arrayBuffer());
      const pdfText = await pdfTextExtractImpl(pdfBuffer, { resolvedUrl, source });

      if (!pdfText) {
        return null;
      }

      return {
        pageText: pdfText,
        pageDefaults: extractPagePublicationDefaults(pdfText)
      };
    }

    const html = await response.text();
    const metadataText = extractHtmlMetadataText(html);
    const relevantHtml = extractRelevantHtmlFragment(html);
    const structuredTableText = extractStructuredDetailTextFromHtml(relevantHtml);
    const bodyText = stripHtml(relevantHtml);
    const metadataDrivenText = normalizeWhitespace([metadataText, structuredTableText].filter(Boolean).join(" "));
    const prefersMetadataText =
      /\b(?:bauobjekt|bauvorhaben|bauprojekt|bauplatz|lage|bauherr|bauherrschaft)\b/i.test(metadataDrivenText) ||
      (/\b(?:baugesuch|baubewilligung)\b/i.test(metadataDrivenText) &&
        (streetLikeAddressPattern.test(metadataDrivenText) || /\bParz(?:elle|\.| Nr\.?)?\s*\d{1,6}\b/i.test(metadataDrivenText)));
    const pageText = prefersMetadataText
      ? metadataDrivenText
      : normalizeWhitespace([metadataText, structuredTableText, bodyText].filter(Boolean).join(" "));

    return {
      pageText,
      pageDefaults: mergePageDefaults(extractPagePublicationDefaults(metadataText), extractPagePublicationDefaults(pageText))
    };
  })().catch(() => null);

  cache.set(resolvedUrl, pending);
  return pending;
}

async function buildXmlFeedImportedItems(
  xml,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const entries = extractFeedEntriesFromXml(xml, source.sourceUrl);
  const geocodeCache = new Map();
  const detailCache = new Map();
  const items = [];
  const seenReferences = new Set();
  const seenResolvedUrls = new Set();

  for (const entry of entries) {
    if (!entry.rawText) {
      continue;
    }

    const resolvedUrl = entry.link || source.sourceUrl;
    let candidateText = entry.rawText;
    let candidateDefaults = buildXmlPageDefaults(entry);
    let candidateDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, candidateText, candidateDefaults);
    const currentProjectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, entry.title, candidateDetails.address, resolvedUrl),
      resolvedUrl
    );
    const shouldInspectPdf = entry.link
      ? shouldInspectMunicipalityPdfDocument(
          resolvedUrl,
          source.sourceUrl,
          candidateText,
          candidateDefaults,
          entry.title
        )
      : false;

    if (
      entry.link &&
      (shouldInspectMunicipalityDetailPage(resolvedUrl, source.sourceUrl, candidateText, true) || shouldInspectPdf)
    ) {
      const detailPage = await loadMunicipalityDetailPageData(
        resolvedUrl,
        source,
        fetchImpl,
        requestTimeoutMs,
        detailCache,
        pdfTextExtractImpl
      );

      if (detailPage?.pageText) {
        const detailText = normalizeWhitespace(detailPage.pageText);
        const detailDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, detailText, detailPage.pageDefaults);
        const detailProjectType = normalizeImportedProjectType(
          extractProjectTypeFromText(detailText, entry.title, detailDetails.address, resolvedUrl),
          resolvedUrl
        );

        candidateDefaults = mergePageDefaults(candidateDefaults, detailPage.pageDefaults);
        candidateDetails = {
          address: chooseMoreSpecificAddress(candidateDetails.address, detailDetails.address),
          parcel: detailDetails.parcel || candidateDetails.parcel,
          coordinates: detailDetails.coordinates || candidateDetails.coordinates,
          publicationDate: detailDetails.publicationDate || candidateDetails.publicationDate,
          deadlineDate: detailDetails.deadlineDate || candidateDetails.deadlineDate,
          hasStrongKeyword: candidateDetails.hasStrongKeyword || detailDetails.hasStrongKeyword,
          looksLikePdf: candidateDetails.looksLikePdf || detailDetails.looksLikePdf,
          hasStableIdentifiers: Boolean(
            chooseMoreSpecificAddress(candidateDetails.address, detailDetails.address) ||
              detailDetails.parcel ||
              candidateDetails.parcel ||
              detailDetails.coordinates ||
              candidateDetails.coordinates
          ),
          hasPublicationMetadata: Boolean(
            detailDetails.publicationDate ||
              candidateDetails.publicationDate ||
              detailDetails.deadlineDate ||
              candidateDetails.deadlineDate
          ),
          looksGenericListingEntry: candidateDetails.looksGenericListingEntry && detailDetails.looksGenericListingEntry
        };

        if (
          projectTypeSpecificity(detailProjectType) > projectTypeSpecificity(currentProjectType) ||
          detailDetails.hasStableIdentifiers ||
          detailDetails.hasPublicationMetadata
        ) {
          candidateText = detailText;
        }
      }
    }

    const matchingText = normalizeWhitespace([entry.title, entry.summary, entry.content, candidateText].filter(Boolean).join(" "));
    const includePattern = source.includePattern ? new RegExp(source.includePattern, "i") : null;
    const excludePattern = source.excludePattern ? new RegExp(source.excludePattern, "i") : null;
    const includedByPattern = includePattern ? includePattern.test(matchingText) || includePattern.test(resolvedUrl) : false;
    const excludedByPattern = excludePattern ? excludePattern.test(matchingText) || excludePattern.test(resolvedUrl) : false;
    const matchesFeedCandidate =
      !excludedByPattern &&
      !candidateDetails.looksGenericListingEntry &&
      !nonPendingPermitPattern.test(matchingText) &&
      (includePattern
        ? includedByPattern && (candidateDetails.hasStableIdentifiers || candidateDetails.hasPublicationMetadata)
        : defaultHtmlKeywordsPattern.test(matchingText) &&
          candidateDetails.hasStableIdentifiers &&
          candidateDetails.hasPublicationMetadata);

    if (
      !matchesFeedCandidate &&
      !matchesMunicipalityCandidate(source, resolvedUrl, candidateText, true, candidateDefaults, matchingText)
    ) {
      continue;
    }

    const normalizedResolvedUrl = normalizeMunicipalityResolvedUrl(resolvedUrl);

    if (normalizedResolvedUrl && seenResolvedUrls.has(normalizedResolvedUrl)) {
      continue;
    }

    const sourceReference = buildMunicipalityLinkedSourceReference(source, resolvedUrl, `${entry.id} ${candidateText}`);

    if (seenReferences.has(sourceReference)) {
      continue;
    }

    let coordinates = candidateDetails.coordinates;
    const parcel = candidateDetails.parcel;
    const address =
      normalizeImportedMunicipalityAddress(candidateDetails.address, parcel) ||
      (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");

    if (address === "Adresse von Webseite prüfen") {
      continue;
    }

    if (
      !coordinates &&
      geocodeFetchImpl &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    if (!coordinates && geocodeFetchImpl && parcel) {
      coordinates = await geocodeMunicipalityAddress(
        `Parzelle ${parcel}`,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const publicationDate = candidateDetails.publicationDate || candidateDefaults.publicationDate || "";
    const deadlineDate = candidateDetails.deadlineDate || candidateDefaults.deadlineDate || (publicationDate ? addDays(publicationDate, 30) : "");
    const projectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, entry.title || "Baugesuch", address, resolvedUrl),
      resolvedUrl
    );

    if (!candidateDetails.hasStableIdentifiers || (!publicationDate && !deadlineDate) || !projectType || projectType === "Nicht importieren") {
      continue;
    }

    seenReferences.add(sourceReference);

    if (normalizedResolvedUrl) {
      seenResolvedUrls.add(normalizedResolvedUrl);
    }

    const ambiguousAddress = !coordinates;
    const automatedAssessmentNotes = [];

    if (ambiguousAddress) {
      automatedAssessmentNotes.push("Standort konnte aus dem Feed nicht eindeutig geokodiert werden.");
    } else if (!candidateDetails.coordinates) {
      automatedAssessmentNotes.push("Standort wurde über den offiziellen schweizerischen Adresssuchdienst ergänzt.");
    }

    items.push({
      source: "Gemeinde-Feed",
      sourceReference,
      sourceUrl: resolvedUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType,
      description: shortenText(candidateText, 320),
      protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
      agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: automatedAssessmentNotes.join(" "),
      ambiguousAddress: ambiguousAddress ? 1 : 0
    });
  }

  return {
    rawCount: entries.length,
    items
  };
}

async function buildXmlSitemapImportedItems(
  xml,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const urls = await resolveSitemapUrls(xml, source, fetchImpl, requestTimeoutMs);
  const items = [];
  const seenReferences = new Set();
  const geocodeCache = new Map();
  const detailCache = new Map();

  for (const resolvedUrl of urls) {
    const detailPage = await loadMunicipalityDetailPageData(
      resolvedUrl,
      source,
      fetchImpl,
      requestTimeoutMs,
      detailCache,
      pdfTextExtractImpl
    );

    if (!detailPage?.pageText) {
      continue;
    }

    const candidateText = normalizeWhitespace(detailPage.pageText);
    const candidateDefaults = detailPage.pageDefaults;

    if (!matchesMunicipalityCandidate(source, resolvedUrl, candidateText, true, candidateDefaults, candidateText)) {
      continue;
    }

    let coordinates = extractSwissCoordinatesFromText(candidateText);
    const parcel = extractParcelFromText(candidateText);
    const address =
      normalizeImportedMunicipalityAddress(extractAddressFromText(candidateText), parcel) ||
      (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");

    if (address === "Adresse von Webseite prüfen") {
      continue;
    }

    if (
      !coordinates &&
      geocodeFetchImpl &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    if (!coordinates && geocodeFetchImpl && parcel) {
      coordinates = await geocodeMunicipalityAddress(
        `Parzelle ${parcel}`,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const publicationDate = extractPublicationDateFromText(candidateText) || candidateDefaults.publicationDate || "";
    const deadlineDate =
      extractDeadlineDateFromText(candidateText) ||
      candidateDefaults.deadlineDate ||
      (publicationDate ? addDays(publicationDate, 30) : "");
    const projectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, "Baugesuch", address, resolvedUrl),
      resolvedUrl
    );
    const sourceReference = buildMunicipalityLinkedSourceReference(source, resolvedUrl, candidateText);

    if (
      seenReferences.has(sourceReference) ||
      (!publicationDate && !deadlineDate) ||
      !projectType ||
      projectType === "Nicht importieren"
    ) {
      continue;
    }

    seenReferences.add(sourceReference);

    const ambiguousAddress = !coordinates;

    items.push({
      source: "Gemeinde-Sitemap",
      sourceReference,
      sourceUrl: resolvedUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType,
      description: shortenText(candidateText, 320),
      protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
      agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: ambiguousAddress
        ? "Sitemap-Eintrag erkannt, aber Standort noch nicht eindeutig geokodiert."
        : "Sitemap-Eintrag automatisch über offizielle Detailseite übernommen.",
      ambiguousAddress: ambiguousAddress ? 1 : 0
    });
  }

  return {
    rawCount: urls.length,
    items
  };
}

async function buildXmlImportedItems(
  xml,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const normalizedXml = String(xml ?? "");

  if (/<urlset\b|<sitemapindex\b/i.test(normalizedXml)) {
    return buildXmlSitemapImportedItems(
      normalizedXml,
      source,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
  }

  return buildXmlFeedImportedItems(
    normalizedXml,
    source,
    fetchImpl,
    requestTimeoutMs,
    geocodeFetchImpl,
    pdfTextExtractImpl
  );
}

function extractTableRowsFromHtml(html) {
  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch = null;

  while ((rowMatch = rowRegex.exec(String(html ?? ""))) !== null) {
    const cellMatches = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    const cells = cellMatches.map((match) => stripHtml(match[1])).filter(Boolean);

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

function extractStructuredDetailTextFromHtml(html) {
  const rows = extractTableRowsFromHtml(html);

  if (rows.length === 0) {
    return "";
  }

  const snippets = [];
  const headerText = normalizeWhitespace(rows[0]?.join(" ") ?? "");
  const looksPublicationGrid = /\b(bauherr|bauprojekt|bauplatz|öffentliche auflage|auflage)\b/i.test(headerText);

  if (looksPublicationGrid) {
    for (const row of rows.slice(1)) {
      if (row.length < 3) {
        continue;
      }

      snippets.push(
        normalizeWhitespace(
          `Bauherrschaft: ${row[0] ?? ""} Bauvorhaben: ${row[1] ?? ""} Bauplatz: ${row[2] ?? ""} Auflagefrist: ${row[3] ?? ""}`
        )
      );
    }
  }

  for (const row of rows) {
    if (
      row.length === 2 &&
      row[0].length <= 40 &&
      /[A-Za-zÄÖÜäöü]/u.test(row[0]) &&
      !/\d/.test(row[0])
    ) {
      snippets.push(`${row[0]}: ${row[1]}`);
    }
  }

  return normalizeWhitespace([...new Set(snippets.filter(Boolean))].join(" "));
}

function looksLikePublicationTable(rows) {
  const header = rows[0]?.join(" ") ?? "";
  return /\b(baugesuch\s*nr|bauherrschaft|bauvorhaben|auflage)\b/i.test(header);
}

function cleanTabularProjectText(value, address = "") {
  const normalizedAddress = sanitizeExtractedAddress(address);
  return cleanPublicationProjectSegment(
    normalizeWhitespace(value)
      .replace(/\bZusatzgesuche?\b.*$/i, "")
      .replace(/\b(?:Bauherrschaft|Bauherr|Gesuchsteller(?:\/in)?|Grundeigentümer(?:\/in)?|Projektverfasser)\b.*$/i, "")
      .replace(/\(\s*ohne Profilierung\s*\)/gi, "")
      .replace(/\bParz(?:elle|\.| Nr\.?)?\s*(?:Nr\.?\s*)?\d{1,6}\b/gi, "")
      .replace(/\b\d{4}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.\-]+(?:\s*\([^)]+\))?/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim(),
    normalizedAddress
  );
}

async function buildTabularImportedItems(relevantHtml, source, requestTimeoutMs, geocodeFetchImpl, geocodeCache) {
  const rows = extractTableRowsFromHtml(relevantHtml);

  if (rows.length < 2 || !looksLikePublicationTable(rows)) {
    return [];
  }

  const items = [];
  const seenReferences = new Set();

  for (const row of rows.slice(1)) {
    if (row.length < 3) {
      continue;
    }

    const rowText = normalizeWhitespace(row.join(" "));

    if (!rowText || genericMunicipalityListingPattern.test(rowText) || genericMunicipalityArchivePattern.test(rowText)) {
      continue;
    }

    const applicantCell = row[1] ?? "";
    const projectCell = row[2] ?? "";
    const timingCell = row.at(-1) ?? "";
    const parcel = extractParcelFromText(`${projectCell} ${applicantCell}`);
    const address =
      chooseMoreSpecificAddress(
        extractAddressFromText(`${projectCell} ${applicantCell}`),
        extractAddressFromText(`${applicantCell} ${projectCell}`)
      ) || (parcel ? `Parzelle ${parcel}` : "");
    const projectType =
      cleanTabularProjectText(projectCell, address) ||
      extractProjectTypeFromText(projectCell, "Baugesuch", address, source.sourceUrl);
    const range = extractDateRangeFromText(timingCell);
    let coordinates = "";

    if (
      geocodeFetchImpl &&
      address &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const sourceReference = buildMunicipalitySourceReference(source, source.sourceUrl, rowText);

    if (!address || !projectType || seenReferences.has(sourceReference)) {
      continue;
    }

    seenReferences.add(sourceReference);

    items.push({
      source: "Gemeinde-Webseite",
      sourceReference,
      sourceUrl: source.sourceUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate: range.publicationDate,
      deadlineDate: range.deadlineDate || (range.publicationDate ? addDays(range.publicationDate, 30) : ""),
      projectType,
      description: shortenText(rowText, 320),
      protectionStatus: coordinates ? "no-hit" : "manual-review",
      agisMatch: coordinates ? "Kein Schutztreffer" : "Noch nicht eindeutig zugeordnet",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: coordinates
        ? "Standort wurde aus der tabellarischen Gemeinde-Publikation übernommen."
        : "Standort aus tabellarischer Gemeinde-Publikation erkannt, aber nicht eindeutig geokodiert.",
      ambiguousAddress: coordinates ? 0 : 1
    });
  }

  return items;
}

function extractStructuredPublicationBlocks(html) {
  const normalizedHtml = String(html ?? "");

  if (
    !/<strong\b[^>]*>\s*Bauherr:\s*<\/strong>/i.test(normalizedHtml) ||
    !/<strong\b[^>]*>\s*Bauobjekt:\s*<\/strong>/i.test(normalizedHtml) ||
    !/<strong\b[^>]*>\s*Bauplatz:\s*<\/strong>/i.test(normalizedHtml)
  ) {
    return [];
  }

  return normalizedHtml
    .split(/(?=<strong\b[^>]*>\s*Bauherr:\s*<\/strong>)/i)
    .map((block) => block.trim())
    .filter(
      (block) =>
        /<strong\b[^>]*>\s*Bauobjekt:\s*<\/strong>/i.test(block) &&
        /<strong\b[^>]*>\s*Bauplatz:\s*<\/strong>/i.test(block)
    );
}

function extractStructuredPublicationField(blockHtml, label) {
  const match = String(blockHtml ?? "").match(
    new RegExp(
      `<strong\\b[^>]*>\\s*${label}:\\s*<\\/strong>\\s*([\\s\\S]*?)(?=<br\\b|<strong\\b|<a\\b|<em\\b|<\\/p>|$)`,
      "i"
    )
  );

  return normalizeWhitespace(stripHtml(match?.[1] ?? ""));
}

function extractStructuredPublicationHref(blockHtml, baseUrl) {
  const match = String(blockHtml ?? "").match(
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>[\s\S]*?<\/a>/i
  );
  const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";

  if (!href) {
    return "";
  }

  try {
    return new URL(decodeHtmlEntities(href), baseUrl).toString();
  } catch {
    return "";
  }
}

async function buildStructuredPublicationImportedItems(
  relevantHtml,
  source,
  requestTimeoutMs,
  geocodeFetchImpl,
  geocodeCache,
  pageDefaults
) {
  const blocks = extractStructuredPublicationBlocks(relevantHtml);

  if (blocks.length === 0) {
    return [];
  }

  const items = [];
  const seenReferences = new Set();

  for (const block of blocks) {
    if (/<em\b[^>]*>\s*(?:Wird zu einem späteren Zeitpunkt publiziert|Zurückgezogen)\.?\s*<\/em>/i.test(block)) {
      continue;
    }

    const bauobjekt = extractStructuredPublicationField(block, "Bauobjekt");
    const bauplatz = extractStructuredPublicationField(block, "Bauplatz");
    const blockText = normalizeWhitespace(stripHtml(block));
    const publicationDate = extractPublicationDateFromText(blockText) || pageDefaults.publicationDate || "";
    const deadlineDate = extractDeadlineDateFromText(blockText) || pageDefaults.deadlineDate || (publicationDate ? addDays(publicationDate, 30) : "");
    const resolvedUrl = extractStructuredPublicationHref(block, source.sourceUrl);
    const includePattern = source.includePattern ? new RegExp(source.includePattern, "i") : null;
    const excludePattern = source.excludePattern ? new RegExp(source.excludePattern, "i") : null;
    const matchingText = normalizeWhitespace([resolvedUrl, blockText, bauobjekt, bauplatz].filter(Boolean).join(" "));

    if (excludePattern && excludePattern.test(matchingText)) {
      continue;
    }

    if (includePattern && !includePattern.test(matchingText)) {
      continue;
    }

    const parcel = extractParcelFromText(bauplatz || blockText);
    const address =
      normalizeImportedMunicipalityAddress(
        chooseMoreSpecificAddress(extractAddressFromText(bauplatz), extractAddressFromText(blockText)),
        parcel
      ) || (parcel ? `Parzelle ${parcel}` : "");

    if (!bauobjekt || !address) {
      continue;
    }

    let coordinates = extractSwissCoordinatesFromText(block);

    if (
      !coordinates &&
      geocodeFetchImpl &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    if (!coordinates && geocodeFetchImpl && parcel) {
      coordinates = await geocodeMunicipalityAddress(
        `Parzelle ${parcel}`,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const sourceReference = resolvedUrl
      ? buildMunicipalityLinkedSourceReference(source, resolvedUrl, blockText)
      : buildMunicipalitySourceReference(source, source.sourceUrl, blockText);

    if (seenReferences.has(sourceReference)) {
      continue;
    }

    seenReferences.add(sourceReference);

    items.push({
      source: "Gemeinde-Webseite",
      sourceReference,
      sourceUrl: resolvedUrl || source.sourceUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType: cleanPublicationProjectSegment(bauobjekt, address) || bauobjekt,
      description: shortenText(blockText, 320),
      protectionStatus: coordinates ? "no-hit" : "manual-review",
      agisMatch: coordinates ? "Kein Schutztreffer" : "Noch nicht eindeutig zugeordnet",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: coordinates
        ? "Standort wurde aus dem offiziellen Publikationsblock übernommen."
        : "Offizieller Publikationsblock erkannt, aber nicht eindeutig geokodiert.",
      ambiguousAddress: coordinates ? 0 : 1
    });
  }

  return items;
}

function matchesMunicipalityCandidate(
  source,
  resolvedUrl,
  candidateText,
  pageLooksLikePublicationPage,
  pageDefaults,
  matchingText = candidateText
) {
  const includePattern = source.includePattern ? new RegExp(source.includePattern, "i") : null;
  const excludePattern = source.excludePattern ? new RegExp(source.excludePattern, "i") : null;
  const text = normalizeWhitespace(candidateText);
  const matchText = normalizeWhitespace(matchingText);
  const details = evaluateMunicipalityCandidateDetails(resolvedUrl, text, pageDefaults);

  if (
    !text ||
    defaultHtmlExcludePattern.test(text) ||
    unreliableProxyUrlPattern.test(resolvedUrl) ||
    genericMunicipalityArchivePattern.test(resolvedUrl) ||
    details.looksGenericListingEntry
  ) {
    return false;
  }

  const included = includePattern ? includePattern.test(matchText) || includePattern.test(resolvedUrl) : false;
  const excluded = excludePattern ? excludePattern.test(matchText) || excludePattern.test(resolvedUrl) : false;
  const qualifiesAsConcretePublication =
    (details.hasStrongKeyword && (details.hasStableIdentifiers || details.hasPublicationMetadata)) ||
    (details.hasStableIdentifiers && details.hasPublicationMetadata) ||
    (details.looksLikePdf && details.hasStableIdentifiers) ||
    (looksLikeMunicipalityDetailUrl(resolvedUrl) &&
      details.hasStableIdentifiers &&
      (details.hasStrongKeyword || bgReferencePattern.test(`${resolvedUrl} ${text}`)));

  if (includePattern) {
    return included && !excluded && qualifiesAsConcretePublication;
  }

  if (excluded) {
    return false;
  }

  if (nonPendingPermitPattern.test(text)) {
    return false;
  }

  return (
    qualifiesAsConcretePublication &&
    (defaultHtmlKeywordsPattern.test(text) ||
      details.looksLikePdf ||
      (pageLooksLikePublicationPage && details.hasStableIdentifiers && details.hasPublicationMetadata))
  );
}

async function buildHtmlImportedItems(
  html,
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const embeddedHtmlCache = new Map();
  const baseRelevantHtml = extractRelevantHtmlFragment(html);
  const embeddedRelevantHtml = await loadEmbeddedMunicipalityRelevantHtml(
    html,
    source,
    fetchImpl,
    requestTimeoutMs,
    embeddedHtmlCache
  );
  const relevantHtml = normalizeWhitespace([baseRelevantHtml, embeddedRelevantHtml].filter(Boolean).join(" "));
  const pageMetadataText = extractHtmlMetadataText(html);
  const pageText = normalizeWhitespace([pageMetadataText, stripHtml(relevantHtml)].filter(Boolean).join(" "));
  const pageLooksLikePublicationPage = defaultHtmlKeywordsPattern.test(`${source.sourceUrl} ${pageText}`);
  const pageDefaults = mergePageDefaults(extractPagePublicationDefaults(pageMetadataText), extractPagePublicationDefaults(pageText));
  const geocodeCache = new Map();
  const structuredItems = await buildStructuredPublicationImportedItems(
    relevantHtml,
    source,
    requestTimeoutMs,
    geocodeFetchImpl,
    geocodeCache,
    pageDefaults
  );

  if (structuredItems.length > 0) {
    return structuredItems;
  }

  const items = [];
  const seenReferences = new Set();
  const seenResolvedUrls = new Set();
  const detailCache = new Map();
  const anchorRegex = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match = null;

  while ((match = anchorRegex.exec(relevantHtml)) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";

    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      continue;
    }

    const resolvedUrl = new URL(decodeHtmlEntities(href), source.sourceUrl).toString();
    const anchorText = stripHtml(match[4]);
    const contextHtml = extractEnclosingBlockHtml(relevantHtml, match.index);
    const candidateContextHtml = narrowMunicipalityContextHtml(contextHtml, anchorText, resolvedUrl);
    const contextText = stripHtml(candidateContextHtml || contextHtml);
    let candidateText = normalizeWhitespace(contextText || anchorText);
    let candidateDefaults = pageDefaults;
    let candidateDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, candidateText, candidateDefaults);
    const currentProjectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, anchorText, candidateDetails.address, resolvedUrl),
      resolvedUrl
    );

    const shouldInspectDetail = shouldInspectMunicipalityDetailPage(
      resolvedUrl,
      source.sourceUrl,
      candidateText,
      pageLooksLikePublicationPage
    );
    const shouldInspectPdf = shouldInspectMunicipalityPdfDocument(
      resolvedUrl,
      source.sourceUrl,
      candidateText,
      candidateDefaults,
      anchorText
    );

    if (shouldInspectDetail || shouldInspectPdf) {
      const detailPage = await loadMunicipalityDetailPageData(
        resolvedUrl,
        source,
        fetchImpl,
        requestTimeoutMs,
        detailCache,
        pdfTextExtractImpl
      );

      if (detailPage?.pageText) {
        const originalCandidateDetails = candidateDetails;
        const mergedDefaults = mergePageDefaults(
          candidateDefaults,
          {
            publicationDate: candidateDetails.publicationDate,
            deadlineDate: candidateDetails.deadlineDate
          },
          detailPage.pageDefaults
        );
        const detailText = normalizeWhitespace(detailPage.pageText);
        const detailDetails = evaluateMunicipalityCandidateDetails(resolvedUrl, detailText, mergedDefaults);
        const detailProjectType = normalizeImportedProjectType(
          extractProjectTypeFromText(detailText, anchorText, detailDetails.address, resolvedUrl),
          resolvedUrl
        );
        const mergedAddress = chooseMoreSpecificAddress(candidateDetails.address, detailDetails.address);
        const mergedParcel = detailDetails.parcel || candidateDetails.parcel;
        const mergedCoordinates = detailDetails.coordinates || candidateDetails.coordinates;
        const mergedPublicationDate = detailDetails.publicationDate || candidateDetails.publicationDate;
        const mergedDeadlineDate = detailDetails.deadlineDate || candidateDetails.deadlineDate;
        candidateDefaults = mergedDefaults;
        candidateDetails = {
          address: mergedAddress,
          parcel: mergedParcel,
          coordinates: mergedCoordinates,
          publicationDate: mergedPublicationDate,
          deadlineDate: mergedDeadlineDate,
          hasStrongKeyword: candidateDetails.hasStrongKeyword || detailDetails.hasStrongKeyword,
          looksLikePdf: candidateDetails.looksLikePdf || detailDetails.looksLikePdf,
          hasStableIdentifiers: Boolean(mergedAddress || mergedParcel || mergedCoordinates),
          hasPublicationMetadata: Boolean(mergedPublicationDate || mergedDeadlineDate),
          looksGenericListingEntry: candidateDetails.looksGenericListingEntry && detailDetails.looksGenericListingEntry
        };

        if (
          looksLikeMunicipalityDetailUrl(resolvedUrl) &&
          (detailDetails.hasStableIdentifiers ||
            detailDetails.hasPublicationMetadata ||
            projectTypeSpecificity(detailProjectType) > 0)
        ) {
          candidateText = detailText;
        }

        if (
          projectTypeSpecificity(detailProjectType) > projectTypeSpecificity(currentProjectType) ||
          (!originalCandidateDetails.address && Boolean(detailDetails.address)) ||
          parcelLikeAddressPattern.test(candidateText) ||
          parcelLikeAddressPattern.test(originalCandidateDetails.address ?? "") ||
          (genericMunicipalityAnchorPattern.test(anchorText) &&
            detailProjectType &&
            detailProjectType !== "Baugesuch") ||
          (detailDetails.hasStableIdentifiers && !originalCandidateDetails.hasStableIdentifiers) ||
          (detailDetails.hasPublicationMetadata && !originalCandidateDetails.hasPublicationMetadata) ||
          (Boolean(detailDetails.address) &&
            Boolean(originalCandidateDetails.address) &&
            normalizeText(detailDetails.address) !== normalizeText(originalCandidateDetails.address))
        ) {
          candidateText = detailText;
        }
      }
    }

    const matchingContextText = normalizeWhitespace([candidateText, contextText, anchorText].filter(Boolean).join(" "));

    if (
      !matchesMunicipalityCandidate(
        source,
        resolvedUrl,
        candidateText,
        pageLooksLikePublicationPage,
        candidateDefaults,
        matchingContextText
      )
    ) {
      continue;
    }

    const normalizedResolvedUrl = normalizeMunicipalityResolvedUrl(resolvedUrl);

    if (normalizedResolvedUrl && seenResolvedUrls.has(normalizedResolvedUrl)) {
      continue;
    }

    const sourceReference = buildMunicipalityLinkedSourceReference(source, resolvedUrl, candidateText);

    if (seenReferences.has(sourceReference)) {
      continue;
    }

    seenReferences.add(sourceReference);

    if (normalizedResolvedUrl) {
      seenResolvedUrls.add(normalizedResolvedUrl);
    }

    let coordinates = candidateDetails.coordinates;
    const parcel = candidateDetails.parcel;
    const address =
      normalizeImportedMunicipalityAddress(candidateDetails.address, parcel) ||
      (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");
    const publicationDate = candidateDetails.publicationDate;
    const deadlineDate = candidateDetails.deadlineDate || (publicationDate ? addDays(publicationDate, 30) : "");
    const projectType = normalizeImportedProjectType(
      extractProjectTypeFromText(candidateText, anchorText, address, resolvedUrl),
      resolvedUrl
    );
    const automatedAssessmentNotes = [];

    if (address === "Adresse von Webseite prüfen") {
      continue;
    }

    if (
      !coordinates &&
      geocodeFetchImpl &&
      address &&
      address !== "Adresse von Webseite prüfen" &&
      (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
    ) {
      coordinates = await geocodeMunicipalityAddress(
        address,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    if (!coordinates && geocodeFetchImpl && parcel) {
      coordinates = await geocodeMunicipalityAddress(
        `Parzelle ${parcel}`,
        source.municipality,
        geocodeFetchImpl,
        requestTimeoutMs,
        geocodeCache
      );
    }

    const ambiguousAddress = !coordinates;

    if (!candidateDetails.hasStableIdentifiers) {
      if (address === "Adresse von Webseite prüfen" && !parcel && !coordinates) {
        continue;
      }

      continue;
    }

    if (!publicationDate && !deadlineDate) {
      continue;
    }

    if (!projectType || projectType === "Nicht importieren") {
      continue;
    }

    if (ambiguousAddress) {
      automatedAssessmentNotes.push("Standort konnte auf der Gemeindewebseite nicht eindeutig gefunden werden.");
    } else if (!candidateDetails.coordinates) {
      automatedAssessmentNotes.push("Standort wurde über den offiziellen schweizerischen Adresssuchdienst ergänzt.");
    }

    if (!deadlineDate) {
      automatedAssessmentNotes.push("Frist auf der Gemeindewebseite nicht eindeutig gefunden.");
    }

    items.push({
      source: "Gemeinde-Webseite",
      sourceReference,
      sourceUrl: resolvedUrl,
      municipality: source.municipality,
      address,
      parcel,
      coordinates,
      publicationDate,
      deadlineDate,
      projectType,
      description: shortenText(candidateText, 320),
      protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
      agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
      agisLayers: [],
      workflowStatus: "new",
      automatedAssessment: automatedAssessmentNotes.join(" "),
      ambiguousAddress: ambiguousAddress ? 1 : 0
    });
  }

  if (items.length === 0) {
    const tabularItems = await buildTabularImportedItems(
      relevantHtml,
      source,
      requestTimeoutMs,
      geocodeFetchImpl,
      geocodeCache
    );

    if (tabularItems.length > 0) {
      return tabularItems;
    }

    const sourcePageText = normalizeWhitespace([pageMetadataText, pageText].filter(Boolean).join(" "));
    const sourcePageDefaults = mergePageDefaults(pageDefaults, extractPagePublicationDefaults(sourcePageText));

    if (matchesMunicipalityCandidate(source, source.sourceUrl, sourcePageText, pageLooksLikePublicationPage, sourcePageDefaults)) {
      let coordinates = extractSwissCoordinatesFromText(`${source.sourceUrl} ${sourcePageText}`);
      const parcel = extractParcelFromText(sourcePageText);
      const address =
        normalizeImportedMunicipalityAddress(extractAddressFromText(sourcePageText), parcel) ||
        (parcel ? `Parzelle ${parcel}` : "Adresse von Webseite prüfen");

      if (
        !coordinates &&
        geocodeFetchImpl &&
        address &&
        address !== "Adresse von Webseite prüfen" &&
        (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
      ) {
        coordinates = await geocodeMunicipalityAddress(
          address,
          source.municipality,
          geocodeFetchImpl,
          requestTimeoutMs,
          geocodeCache
        );
      }

      if (!coordinates && geocodeFetchImpl && parcel) {
        coordinates = await geocodeMunicipalityAddress(
          `Parzelle ${parcel}`,
          source.municipality,
          geocodeFetchImpl,
          requestTimeoutMs,
          geocodeCache
        );
      }

      const publicationDate = extractPublicationDateFromText(sourcePageText) || sourcePageDefaults.publicationDate || "";
      const deadlineDate =
        extractDeadlineDateFromText(sourcePageText) ||
        sourcePageDefaults.deadlineDate ||
        (publicationDate ? addDays(publicationDate, 30) : "");
      const projectType = normalizeImportedProjectType(
        extractProjectTypeFromText(sourcePageText, "Baugesuch", address, source.sourceUrl),
        source.sourceUrl
      );

      if ((publicationDate || deadlineDate) && projectType && projectType !== "Nicht importieren" && address !== "Adresse von Webseite prüfen") {
        items.push({
          source: "Gemeinde-Webseite",
          sourceReference: buildMunicipalitySourceReference(source, source.sourceUrl, sourcePageText),
          sourceUrl: source.sourceUrl,
          municipality: source.municipality,
          address,
          parcel,
          coordinates,
          publicationDate,
          deadlineDate,
          projectType,
          description: shortenText(sourcePageText, 320),
          protectionStatus: coordinates ? "no-hit" : "manual-review",
          agisMatch: coordinates ? "Kein Schutztreffer" : "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          workflowStatus: "new",
          automatedAssessment: coordinates
            ? "Standort wurde über die direkte Publikationsseite ermittelt."
            : "Standort konnte auf der Gemeindewebseite nicht eindeutig gefunden werden.",
          ambiguousAddress: coordinates ? 0 : 1
        });
      }
    }
  }

  return items;
}

function buildSourceLabel(sourceConfig) {
  const normalizedSourceType = normalizeSourceType(sourceConfig);

  if (sourceConfig.municipality) {
    return `${sourceConfig.municipality} (${normalizedSourceType})`;
  }

  return sourceConfig.sourceLabel ?? "API";
}

function normalizeSourceType(sourceConfig) {
  const explicitSourceType = String(sourceConfig.sourceType ?? "").trim().toLowerCase();

  if (explicitSourceType === "manual") {
    return "manual";
  }

  if (explicitSourceType === "amtsblatt" || isAmtsblattSourceUrl(sourceConfig.sourceUrl)) {
    return "amtsblatt";
  }

  if (isArcGisServiceUrl(sourceConfig.sourceUrl)) {
    return "arcgis";
  }

  if (looksLikePdfUrl(sourceConfig.sourceUrl)) {
    return "pdf";
  }

  if (looksLikeXmlSourceUrl(sourceConfig.sourceUrl)) {
    return "xml";
  }

  if (explicitSourceType && explicitSourceType !== "html") {
    return explicitSourceType;
  }

  if (looksLikeJsonSourceUrl(sourceConfig.sourceUrl)) {
    return "json";
  }

  if (explicitSourceType) {
    return explicitSourceType;
  }

  return "json";
}

async function buildPdfImportedItems(
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const detailCache = new Map();
  const geocodeCache = new Map();
  const detailPage = await loadMunicipalityDetailPageData(
    source.sourceUrl,
    source,
    fetchImpl,
    requestTimeoutMs,
    detailCache,
    pdfTextExtractImpl
  );

  if (!detailPage?.pageText) {
    return {
      rawCount: 1,
      items: []
    };
  }

  const candidateText = normalizeWhitespace(detailPage.pageText);
  const candidateDefaults = detailPage.pageDefaults;

  if (!matchesMunicipalityCandidate(source, source.sourceUrl, candidateText, true, candidateDefaults, candidateText)) {
    return {
      rawCount: 1,
      items: []
    };
  }

  let coordinates = extractSwissCoordinatesFromText(`${source.sourceUrl} ${candidateText}`);
  const parcel = extractParcelFromText(candidateText);
  const address =
    normalizeImportedMunicipalityAddress(extractAddressFromText(candidateText), parcel) ||
    (parcel ? `Parzelle ${parcel}` : "Adresse von PDF prüfen");

  if (address === "Adresse von PDF prüfen") {
    return {
      rawCount: 1,
      items: []
    };
  }

  if (
    !coordinates &&
    geocodeFetchImpl &&
    (streetLikeAddressPattern.test(address) || parcelLikeAddressPattern.test(address) || houseNumberAddressPattern.test(address))
  ) {
    coordinates = await geocodeMunicipalityAddress(
      address,
      source.municipality,
      geocodeFetchImpl,
      requestTimeoutMs,
      geocodeCache
    );
  }

  if (!coordinates && geocodeFetchImpl && parcel) {
    coordinates = await geocodeMunicipalityAddress(
      `Parzelle ${parcel}`,
      source.municipality,
      geocodeFetchImpl,
      requestTimeoutMs,
      geocodeCache
    );
  }

  const publicationDate = extractPublicationDateFromText(candidateText) || candidateDefaults.publicationDate || "";
  const deadlineDate =
    extractDeadlineDateFromText(candidateText) ||
    candidateDefaults.deadlineDate ||
    (publicationDate ? addDays(publicationDate, 30) : "");
  const projectType = normalizeImportedProjectType(
    extractProjectTypeFromText(candidateText, "Baugesuch", address, source.sourceUrl),
    source.sourceUrl
  );

  if ((!publicationDate && !deadlineDate) || !projectType || projectType === "Nicht importieren") {
    return {
      rawCount: 1,
      items: []
    };
  }

  const ambiguousAddress = !coordinates;

  return {
    rawCount: 1,
    items: [
      {
        source: "Gemeinde-PDF",
        sourceReference: buildMunicipalitySourceReference(source, source.sourceUrl, candidateText),
        sourceUrl: source.sourceUrl,
        municipality: source.municipality,
        address,
        parcel,
        coordinates,
        publicationDate,
        deadlineDate,
        projectType,
        description: shortenText(candidateText, 320),
        protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
        agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
        agisLayers: [],
        workflowStatus: "new",
        automatedAssessment: ambiguousAddress
          ? "Standort konnte aus dem offiziellen PDF noch nicht eindeutig geokodiert werden."
          : "Standort wurde aus dem offiziellen PDF automatisch übernommen.",
        ambiguousAddress: ambiguousAddress ? 1 : 0
      }
    ]
  };
}

const discoveryWrongTopicPattern =
  /(einbürger|einbürger|fahrplan|verkehrsverbund|\bzvv\b|gemeindeversammlung|abstimmung|\bwahlen\b|newsletter|veranstaltung|\bagenda\b|kontakt|impressum|datenschutz|\blogin\b|\bjobs\b|stellen|bibliothek|kindergarten)/i;
const discoveryPublicationTextPattern =
  /(baugesuch|baupublikation|baugesuchspublikation|öffentliche auflage|öffentliche auflage|amtliche publikation|amtliches publikationsorgan|baubewilligung)/i;
const discoveryCommonPaths = [
  "/baugesuche",
  "/baupublikationen",
  "/amtliche-publikationen",
  "/publikationen",
  "/öffentliche-auflage",
  "/baugesuchspublikationen"
];

// Defensive guard against SSRF: only allow public http(s) hosts, never internal
// networks, loopback, link-local or *.local/*.internal names.
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

function isRootLikeMunicipalityUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    const path = parsed.pathname.replace(/\/+$/, "");
    return path === "" || path === "/";
  } catch {
    return false;
  }
}

function slugifyForAggregator(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ss/g, "ss")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectDiscoveryCandidatesFromHtml(html, baseUrl) {
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

    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) {
      continue;
    }

    let resolved;

    try {
      resolved = new URL(decodeHtmlEntities(href), baseUrl);
    } catch {
      continue;
    }

    if (resolved.hostname.toLowerCase() !== baseHost || !isSafePublicHttpUrl(resolved.toString())) {
      continue;
    }

    const anchorText = normalizeWhitespace(stripHtml(match[4]));
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

    if (/baugesuch|baupublikation|baugesuchspublikation|auflage-baugesuch|auflagebaugesuche/.test(pathText)) {
      score += 6;
    } else if (/öffentliche-auflage|öffentliche-auflage|amtliche-publikation/.test(pathText)) {
      score += 4;
    } else if (/publikation/.test(pathText)) {
      score += 2;
    }

    if (/baugesuch|baupublikation|baugesuchspublikation/i.test(anchorText)) {
      score += 5;
    } else if (/öffentliche auflage|öffentliche auflage/i.test(anchorText)) {
      score += 4;
    } else if (/amtliche publikation|amtliches publikationsorgan/i.test(anchorText)) {
      score += 3;
    } else if (/publikation/i.test(anchorText)) {
      score += 1;
    }

    if (score <= 0) {
      continue;
    }

    const key = resolved.toString();
    candidates.set(key, Math.max(candidates.get(key) ?? 0, score));
  }

  return candidates;
}

// Tries to locate an official building-application / publication page for a
// municipality whose configured source is only the homepage. Strategy:
//   1) scan the homepage for strongly matching links (same host only),
//   2) probe a small set of common publication paths on the same host,
//   3) fall back to the cantonal "amtliche-nachrichten.ch" notice aggregator.
// Every network call is timeout-bounded, SSRF-guarded and best-effort.
async function discoverMunicipalityPublicationUrl(html, source, fetchImpl, requestTimeoutMs) {
  const baseUrl = String(source.sourceUrl ?? "").trim();

  if (!isSafePublicHttpUrl(baseUrl)) {
    return "";
  }

  const candidates = collectDiscoveryCandidatesFromHtml(html, baseUrl);
  let bestUrl = "";
  let bestScore = 0;

  for (const [url, score] of candidates) {
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }

  if (
    bestUrl &&
    bestScore >= 4 &&
    normalizeMunicipalityResolvedUrl(bestUrl) !== normalizeMunicipalityResolvedUrl(baseUrl)
  ) {
    return bestUrl;
  }

  let root;

  try {
    root = new URL(baseUrl);
  } catch {
    return "";
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

      if (response.ok && discoveryPublicationTextPattern.test(await response.text())) {
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

      if (response.ok && discoveryPublicationTextPattern.test(await response.text())) {
        return aggregatorUrl;
      }
    } catch {
      // The aggregator may not list this municipality; ignore.
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Amtsblatt des Kantons Aargau (amtsblatt.ag.ch) — kantonsweite Quelle
// Die offizielle, öffentliche Publikationsplattform listet alle Baugesuche
// ("Gemeinden / Bau- und Rodungsgesuche") des Kantons. Die Ergebnisliste wird
// über den AJAX-Endpunkt "resultAjax" seitenweise geladen (ohne cHash) und
// enthält pro Eintrag bereits Stelle (Gemeinde), Rubrik, Titel, Datum und im
// Textkoerper strukturierte Felder (Bauherrschaft | Bauvorhaben | Standort).
// ---------------------------------------------------------------------------
const amtsblattBaugesuchRubricPattern = /bau-?\s*und\s*rodungsgesuch/i;
// Erkennt Parzellennummern in vielen Schreibweisen: "Parzelle Nr. 1376",
// "Parzellen-Nr. 123", "Parzellen: 155", "Parz. 11", "Kat.-Nr. 7", "GB-Nr 9",
// "Grundstück 276".
const amtsblattParcelPattern =
  /\b(?:Parzellen?|Parz|Kat(?:aster)?|GB|Grundst(?:ü|ue)ck)\.?[-:\s]*(?:Nr\.?:?[-:\s]*)?(\d{1,6})/i;
const defaultAmtsblattMaxPages = Math.max(1, Number(process.env.AMTSBLATT_MAX_PAGES ?? 30));
const defaultAmtsblattPageBatchSize = Math.min(
  50,
  Math.max(1, Number(process.env.AMTSBLATT_PAGE_BATCH_SIZE ?? 6))
);
// Beim grossen Archiv-Backfill kann die Live-Geokodierung abgeschaltet werden, damit
// tausende Baugesuche schnell und ohne Last-Spitze auf die Behörden-Dienste geladen
// werden. Die Schutzprüfung erfolgt dann später pro Fall.
const amtsblattGeocodeEnabled = String(process.env.AMTSBLATT_GEOCODE ?? "").toLowerCase() !== "false";

function isAmtsblattSourceUrl(sourceUrl) {
  try {
    return /(^|\.)amtsblatt\.ag\.ch$/i.test(new URL(String(sourceUrl)).hostname);
  } catch {
    return false;
  }
}

export function buildAmtsblattResultUrl(baseUrl, page) {
  const origin = new URL(baseUrl).origin;
  const params = new URLSearchParams();
  params.set("filter[type][0]", "tx_ekab_publication_domain_model_publication");
  // Kategorie 190 = "Gemeinden" (enthält die Bau- und Rodungsgesuche). Verdichtet
  // die Ergebnisliste deutlich gegenüber dem ungefilterten Strom aller Publikationen.
  params.set("filter[category][]", "190");
  params.set("page", String(page));
  params.set("timerange[type]", "1");
  params.set("tx_diamcore_publicationsearchresult[action]", "resultAjax");
  params.set("tx_diamcore_publicationsearchresult[controller]", "PublicationSearch");
  return `${origin}/publikationen/?${params.toString()}`;
}

// Definitionslisten-Felder (Stelle/Rubrik) sind im Text durch das nächste
// Label begrenzt (kein "|"). Lazy bis zum nächsten bekannten Label.
function matchAmtsblattField(text, label, stopLabels) {
  const stop = stopLabels.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)\\s*(?:\\||${stop}|$)`, "i");
  const match = text.match(pattern);
  return match ? normalizeWhitespace(match[1]) : "";
}

// Body-Felder im Amtsblatt sind durch "|" getrennt und tragen je nach
// Gemeinde unterschiedliche Trenner ("Label: Wert" oder "Label | Wert").
// Diese Funktion liest den Wert zum ersten passenden Label aus beiden Formaten.
function extractAmtsblattLabeledValue(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Trenner sind je nach Vorlage "|" oder ";"; Label-Wert-Trenner ":" oder "|".
    const pattern = new RegExp(`(?:^|[|;\\s])${escaped}\\s*[:|]\\s*([^|;]+?)\\s*(?:[|;]|$)`, "i");
    const match = text.match(pattern);

    if (match) {
      const value = normalizeWhitespace(match[1]);

      if (value) {
        return value;
      }
    }
  }

  return "";
}

// Die Gemeinde, in der GEBAUT wird, ist die publizierende Amtsstelle ("Stelle"),
// nicht der Wohnort der Bauherrschaft. Faellt die Stelle aus, wird der nachgestellte
// Ortsname aus dem Bauplatz herangezogen (nie aus der Bauherrschaft).
function deriveAmtsblattMunicipality(stelle, location) {
  if (stelle) {
    const candidate = normalizeWhitespace(
      stelle
        .split(",")[0]
        .replace(
          /^(Stadt|Einwohnergemeinde|Ortsbürgergemeinde|Ortsbürgergemeinde|Gemeindekanzlei|Gemeindeverwaltung|Gemeinde|Stadtkanzlei|Stadtbauamt|Bauverwaltung|Bauamt|Abteilung\s+Bau|Regionales?\s+Bauamt)\s+/i,
          ""
        )
        .replace(/\s+(Bau|Bauverwaltung|Bauamt|Hochbau|Tiefbau)$/i, "")
    );
    const official = resolveOfficialAargauMunicipality(candidate);

    if (official) {
      return official;
    }
  }

  if (location) {
    const segments = location
      .replace(/\([^)]*\)/g, " ")
      .split(",")
      .map((value) => normalizeWhitespace(value))
      .filter(Boolean);

    // Von hinten nach vorne den ersten Teil suchen, der eine echte Aargauer
    // Gemeinde ist (häufig nachgestellt: "Strasse 5, 5000 Aarau").
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const official = resolveOfficialAargauMunicipality(segments[index].replace(/^\d{4}\s+/, ""));

      if (official) {
        return official;
      }
    }
  }

  return "";
}

export function parseAmtsblattEntries(html) {
  const blocks = String(html ?? "").split("publication-list__item--publication");
  const entries = [];

  for (let index = 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    const detailMatch = block.match(/data-detailurl="([^"]+\/publikation\/)"/i);

    if (!detailMatch) {
      continue;
    }

    const titleMatch = block.match(/publication-summary__title[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    const dateMatch = block.match(/box-publication-date[^>]*>\s*([0-9]{1,2}\.[0-9]{1,2}\.20[0-9]{2})/i);
    const text = normalizeWhitespace(decodeHtmlEntities(stripHtml(block)));
    const rubric = matchAmtsblattField(text, "Rubrik", ["Bauherrschaft", "Bauvorhaben", "Standort", "Bauobjekt", "Objektadresse", "PDF "]);

    if (!amtsblattBaugesuchRubricPattern.test(rubric) && !amtsblattBaugesuchRubricPattern.test(text)) {
      continue;
    }

    entries.push({
      detailPath: detailMatch[1],
      title: titleMatch ? normalizeWhitespace(decodeHtmlEntities(stripHtml(titleMatch[1]))) : "",
      publicationDate: dateMatch ? normalizeDate(dateMatch[1]) : "",
      stelle: matchAmtsblattField(text, "Stelle", [
        "Rubrik",
        "Bauherrschaft",
        "Bauvorhaben",
        "Standort",
        "Bauobjekt",
        "Objektadresse"
      ]),
      rubric,
      // Bauplatz/Standort = wo gebaut wird. Reihenfolge nach Genauigkeit.
      location: extractAmtsblattLabeledValue(text, [
        "Standort",
        "Objektadresse",
        "Ortslage",
        "Bauobjekt",
        "Bauplatz",
        "Lage",
        "Baustelle",
        "Grundstück",
        "Grundstück"
      ]),
      bauvorhaben: extractAmtsblattLabeledValue(text, ["Bauvorhaben", "Bauprojekt"]),
      bodyText: text
    });
  }

  return entries;
}

export async function buildAmtsblattItemFromEntry(entry, origin, baseUrl, geocodeFetchImpl, requestTimeoutMs, geocodeCache) {
  const location = entry.location ?? "";
  const municipality = deriveAmtsblattMunicipality(entry.stelle, location);
  // Parzelle aus der Ortsangabe oder – als robuster Fallback – aus dem Detailtext.
  const parcel = (location.match(amtsblattParcelPattern) ?? [])[1] ?? entry.parcel ?? "";
  // Strasse = Bauplatz ohne Klammern/Parzellenangabe und ohne nachgestellten Ort.
  const street = (() => {
    const segments = location
      .replace(/\([^)]*\)/g, " ")
      .split(",")
      .map((value) => normalizeWhitespace(value))
      .filter(Boolean);
    const streetSegment = segments.find((segment) => streetLikeAddressPattern.test(segment));
    return streetSegment ? streetSegment.replace(/\bParz(?:elle)?\.?\s*\d+.*$/i, "").trim() : "";
  })();
  const address =
    normalizeImportedMunicipalityAddress(street, parcel) ||
    (parcel ? `Parzelle ${parcel}` : "Adresse aus Amtsblatt prüfen");
  const projectTypeRaw = entry.bauvorhaben || entry.title || "Baugesuch";
  const normalizedProjectType = normalizeImportedProjectType(projectTypeRaw, baseUrl);
  const projectType =
    normalizedProjectType && normalizedProjectType !== "Nicht importieren"
      ? normalizedProjectType
      : shortenText(projectTypeRaw, 120) || "Baugesuch";
  const publicationDate = entry.publicationDate || extractPublicationDateFromText(entry.bodyText) || "";
  const deadlineDate =
    extractDeadlineDateFromText(entry.bodyText) || (publicationDate ? addDays(publicationDate, 30) : "");

  let coordinates = extractSwissCoordinatesFromText(location);

  // Standort an der Baugemeinde geokodieren: zuerst die Strasse, dann die Parzelle.
  if (!coordinates && geocodeFetchImpl && municipality && street) {
    coordinates = await geocodeMunicipalityAddress(street, municipality, geocodeFetchImpl, requestTimeoutMs, geocodeCache);
  }

  if (!coordinates && geocodeFetchImpl && municipality && parcel) {
    coordinates = await geocodeMunicipalityParcel(parcel, municipality, geocodeFetchImpl, requestTimeoutMs, geocodeCache);
  }

  const ambiguousAddress = !coordinates;

  return {
    source: "Amtsblatt Aargau",
    sourceReference: `amtsblatt:${entry.detailPath}`,
    sourceUrl: `${origin}${entry.detailPath}`,
    municipality,
    address,
    parcel,
    coordinates,
    publicationDate,
    deadlineDate,
    projectType,
    description: shortenText(entry.bodyText, 320),
    protectionStatus: ambiguousAddress ? "manual-review" : "no-hit",
    agisMatch: ambiguousAddress ? "Noch nicht eindeutig zugeordnet" : "Kein Schutztreffer",
    agisLayers: [],
    workflowStatus: "new",
    automatedAssessment: ambiguousAddress
      ? "Baugesuch aus dem amtlichen Amtsblatt importiert. Standort noch nicht eindeutig geokodiert."
      : "Baugesuch aus dem amtlichen Amtsblatt importiert und automatisch geokodiert.",
    ambiguousAddress: ambiguousAddress ? 1 : 0
  };
}

// Wenn die Ergebnisliste den Standort nicht enthält (Text war abgeschnitten),
// die Detailseite des Eintrags nachladen und Standort/Stelle/Bauvorhaben dort lesen.
async function enrichAmtsblattEntryFromDetail(entry, origin, fetchImpl, requestTimeoutMs) {
  if (!entry.detailPath) {
    return;
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${origin}${entry.detailPath}`,
      { headers: { Accept: "text/html,application/xhtml+xml" } },
      requestTimeoutMs
    );

    if (!response.ok) {
      return;
    }

    const html = await response.text();
    const articleMatch = html.match(/<article\b[^>]*publication-detail[\s\S]*?<\/article>/i);
    const detailText = normalizeWhitespace(decodeHtmlEntities(stripHtml(articleMatch ? articleMatch[0] : html)));

    entry.location =
      extractAmtsblattLabeledValue(detailText, [
        "Standort",
        "Objektadresse",
        "Ortslage",
        "Bauobjekt",
        "Bauplatz",
        "Lage",
        "Baustelle",
        "Grundstück",
        "Grundstück"
      ]) || entry.location;

    if (!entry.stelle) {
      entry.stelle = matchAmtsblattField(detailText, "Stelle", [
        "Rubrik",
        "Bauherrschaft",
        "Bauvorhaben",
        "Standort",
        "Bauobjekt",
        "Objektadresse"
      ]);
    }

    if (!entry.bauvorhaben) {
      entry.bauvorhaben = extractAmtsblattLabeledValue(detailText, ["Bauvorhaben", "Bauprojekt"]);
    }

    // Robuster Fallback: Parzellennummer und Strasse direkt aus dem ganzen
    // Detailtext ziehen. Aargauer Baugesuche tragen fast immer eine Parzellennr.,
    // die über die amtliche Parzellensuche zuverlässig verortet werden kann.
    const bodyParcel = (detailText.match(amtsblattParcelPattern) ?? [])[1] ?? "";

    if (bodyParcel) {
      entry.parcel = bodyParcel;
    }

    const streetMatch = detailText.match(
      /([A-ZÄÖÜ][A-Za-zÄÖÜäöüss.\-]*(?:strasse|strasse|weg|gasse|platz|allee|ring|rain|halde|steig|matte|acker|feld|quai|ufer)\s*\d{0,4}\s*[a-z]?)/i
    );
    const bodyStreet = streetMatch ? normalizeWhitespace(streetMatch[1]) : "";

    if (!entry.location || !/\d/.test(entry.location)) {
      entry.location = [bodyStreet, bodyParcel ? `Parzelle ${bodyParcel}` : ""].filter(Boolean).join(", ") || entry.location;
    }
  } catch {
    // Detailseite optional; bei Fehler bleibt der Listeneintrag wie er ist.
  }
}

async function buildAmtsblattImportedItems(
  source,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  maxPages = defaultAmtsblattMaxPages
) {
  const baseUrl = String(source.sourceUrl ?? "").trim();
  const origin = new URL(baseUrl).origin;
  const geocodeCache = new Map();
  const seenReferences = new Set();
  const items = [];
  let rawCount = 0;

  // Seiten werden in parallelen Batches geladen (deutlich schneller als sequenziell),
  // aber geordnet verarbeitet: am ersten leeren Ergebnis ist das Archiv zu Ende.
  const batchSize = defaultAmtsblattPageBatchSize;
  let reachedEnd = false;

  for (let start = 1; start <= maxPages && !reachedEnd; start += batchSize) {
    const pageNumbers = [];

    for (let page = start; page < start + batchSize && page <= maxPages; page += 1) {
      pageNumbers.push(page);
    }

    const fetched = await mapWithConcurrency(
      pageNumbers,
      async (page) => {
        try {
          const response = await fetchWithTimeout(
            fetchImpl,
            buildAmtsblattResultUrl(baseUrl, page),
            { headers: { Accept: "text/html,application/xhtml+xml" } },
            requestTimeoutMs
          );

          if (!response.ok) {
            return { page, html: "", count: 0, ok: false };
          }

          const html = await response.text();
          return {
            page,
            html,
            count: (html.match(/publication-list__item--publication/g) ?? []).length,
            ok: true
          };
        } catch {
          return { page, html: "", count: 0, ok: false };
        }
      },
      batchSize
    );

    fetched.sort((a, b) => a.page - b.page);

    for (const result of fetched) {
      if (result.ok && result.count === 0) {
        reachedEnd = true;
        break;
      }

      if (!result.html) {
        continue;
      }

      rawCount += result.count;

      for (const entry of parseAmtsblattEntries(result.html)) {
        const reference = `amtsblatt:${entry.detailPath}`;

        if (seenReferences.has(reference)) {
          continue;
        }

        seenReferences.add(reference);

        // Fehlt in der Liste eine geocodierbare Ortsangabe (keine Nummer = keine
        // Parzelle/Hausnummer), Detailseite nachladen (nur im normalen Sync mit
        // Geokodierung, nicht beim grossen geocode-freien Massen-Backfill).
        if (geocodeFetchImpl && !(entry.location && /\d/.test(entry.location))) {
          await enrichAmtsblattEntryFromDetail(entry, origin, fetchImpl, requestTimeoutMs);
        }

        items.push(
          await buildAmtsblattItemFromEntry(entry, origin, baseUrl, geocodeFetchImpl, requestTimeoutMs, geocodeCache)
        );
      }
    }
  }

  return {
    rawCount,
    items
  };
}

async function fetchNormalizedItemsFromSource(
  sourceConfig,
  fetchImpl,
  requestTimeoutMs,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer
) {
  const sourceType = normalizeSourceType(sourceConfig);
  const sourceUrl = String(sourceConfig.sourceUrl ?? "").trim();
  const sourceToken = String(sourceConfig.sourceToken ?? "").trim();

  if (sourceType === "amtsblatt") {
    return buildAmtsblattImportedItems(
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      amtsblattGeocodeEnabled ? geocodeFetchImpl : null
    );
  }

  if (sourceType === "html") {
    const response = await fetchWithTimeout(
      fetchImpl,
      sourceUrl,
      {
      headers: {
        Accept: "text/html,application/xhtml+xml"
      }
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`Gemeindequelle konnte nicht geladen werden (${response.status}).`);
    }

    const html = await response.text();
    let items = await buildHtmlImportedItems(
      html,
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );

    // Auto-discovery: if a municipality only has its homepage configured and the
    // homepage itself yields nothing, try to find the real publication page.
    if (items.length === 0 && sourceConfig.allowDiscovery !== false && isRootLikeMunicipalityUrl(sourceUrl)) {
      const discoveredUrl = await discoverMunicipalityPublicationUrl(
        html,
        sourceConfig,
        fetchImpl,
        requestTimeoutMs
      );

      if (
        discoveredUrl &&
        isSafePublicHttpUrl(discoveredUrl) &&
        normalizeMunicipalityResolvedUrl(discoveredUrl) !== normalizeMunicipalityResolvedUrl(sourceUrl)
      ) {
        try {
          const discoveredResponse = await fetchWithTimeout(
            fetchImpl,
            discoveredUrl,
            { headers: { Accept: "text/html,application/xhtml+xml" } },
            requestTimeoutMs
          );

          if (discoveredResponse.ok) {
            const discoveredItems = await buildHtmlImportedItems(
              await discoveredResponse.text(),
              { ...sourceConfig, sourceUrl: discoveredUrl },
              fetchImpl,
              requestTimeoutMs,
              geocodeFetchImpl,
              pdfTextExtractImpl
            );

            if (discoveredItems.length > 0) {
              items = discoveredItems;
            }
          }
        } catch {
          // Discovery is a best-effort enhancement; never fail the sync over it.
        }
      }
    }

    return {
      rawCount: items.length,
      items
    };
  }

  if (sourceType === "pdf") {
    return buildPdfImportedItems(
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
  }

  if (sourceType === "xml") {
    const response = await fetchWithTimeout(
      fetchImpl,
      sourceUrl,
      {
        headers: withOptionalTokenHeaders(
          {
            Accept: "application/xml,text/xml,application/rss+xml,application/atom+xml"
          },
          sourceToken
        )
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`Quelle konnte nicht geladen werden (${response.status}).`);
    }

    const xml = await response.text();
    return buildXmlImportedItems(
      xml,
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
  }

  const requestUrl = sourceType === "arcgis"
    ? await resolveArcGisQueryUrl(sourceUrl, sourceToken, fetchImpl)
    : sourceUrl;
  const response = await fetchWithTimeout(
    fetchImpl,
    requestUrl,
    {
      headers: withOptionalTokenHeaders(
        {
          Accept: "application/json"
        },
        sourceToken
      )
    },
    requestTimeoutMs
  );

  if (!response.ok) {
    throw new Error(`Quelle konnte nicht geladen werden (${response.status}).`);
  }

  const payload = await response.json();

  if (payload?.error?.message) {
    throw new Error(`Quelle konnte nicht geladen werden: ${payload.error.message}`);
  }

  const items = normalizeImportedPayload(payload, sourceUrl, {
    source:
      sourceConfig.source ?? (sourceConfig.municipality ? "Gemeinde-Import" : "API"),
    municipality: sourceConfig.municipality ?? "",
    sourceReferenceSeed: sourceConfig.id ?? sourceUrl
  });

  return {
    rawCount: parseApiPayload(payload).length,
    items
  };
}

async function assessImportedItems(items, assessApplication) {
  const assessedItems = [];

  for (const item of items) {
    if (typeof assessApplication === "function") {
      assessedItems.push((await assessApplication(item)) ?? item);
      continue;
    }

    assessedItems.push(item);
  }

  return assessedItems;
}

function mergeSyncResults(results) {
  return results.reduce(
    (aggregate, result) => ({
      imported: aggregate.imported || result.imported,
      importedCount: aggregate.importedCount + (result.importedCount ?? 0),
      updatedCount: aggregate.updatedCount + (result.updatedCount ?? 0),
      skippedCount: aggregate.skippedCount + (result.skippedCount ?? 0),
      items: [...aggregate.items, ...(result.items ?? [])],
      changes: [...aggregate.changes, ...(result.changes ?? [])],
      notificationCount: aggregate.notificationCount + (result.notificationCount ?? 0),
      sourceSummaries: [...aggregate.sourceSummaries, ...(result.sourceSummaries ?? [])]
    }),
    {
      imported: false,
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      items: [],
      changes: [],
      notificationCount: 0,
      sourceSummaries: []
    }
  );
}

export function createApplicationsSyncService({
  repository,
  sourceUrl = process.env.SYNC_SOURCE_URL ?? "",
  getSourceUrl = null,
  sourceToken = process.env.SYNC_SOURCE_TOKEN ?? "",
  getSourceToken = null,
  sourceType = process.env.SYNC_SOURCE_TYPE ?? "",
  getSourceType = null,
  sourceMunicipality = process.env.SYNC_SOURCE_MUNICIPALITY ?? "",
  getSourceMunicipality = null,
  getMunicipalitySources = null,
  fetchImpl = fetch,
  geocodeFetchImpl = null,
  pdfTextExtractImpl = extractPdfTextFromBuffer,
  assessApplication = null,
  notifyImportChanges = null,
  requestTimeoutMs = defaultSyncRequestTimeoutMs,
  municipalitySourceConcurrency = defaultMunicipalitySourceConcurrency,
  applicationRetentionDays = Number(process.env.APPLICATION_RETENTION_DAYS ?? 0)
}) {
  const normalizedSourceUrl = String(sourceUrl ?? "").trim();
  const normalizedSourceToken = String(sourceToken ?? "").trim();
  const normalizedSourceType = String(sourceType ?? "").trim().toLowerCase();
  const normalizedSourceMunicipality = String(sourceMunicipality ?? "").trim();

  function resolveSourceUrl() {
    const dynamicSourceUrl = typeof getSourceUrl === "function" ? String(getSourceUrl() ?? "").trim() : "";
    return dynamicSourceUrl || normalizedSourceUrl;
  }

  function resolveSourceToken() {
    const dynamicSourceToken =
      typeof getSourceToken === "function" ? String(getSourceToken() ?? "").trim() : "";
    return dynamicSourceToken || normalizedSourceToken;
  }

  function resolveSourceType() {
    const dynamicSourceType =
      typeof getSourceType === "function" ? String(getSourceType() ?? "").trim().toLowerCase() : "";
    return dynamicSourceType || normalizedSourceType;
  }

  function resolveSourceMunicipality() {
    const dynamicSourceMunicipality =
      typeof getSourceMunicipality === "function" ? String(getSourceMunicipality() ?? "").trim() : "";
    return dynamicSourceMunicipality || normalizedSourceMunicipality;
  }

  function buildImportSourceName(normalizedSourceType, municipalityScoped = false) {
    if (normalizedSourceType === "amtsblatt") {
      return "Amtsblatt Aargau";
    }

    if (normalizedSourceType === "html") {
      return "Gemeinde-Webseite";
    }

    if (normalizedSourceType === "xml") {
      return "Gemeinde-Feed";
    }

    if (normalizedSourceType === "pdf") {
      return "Gemeinde-PDF";
    }

    if (normalizedSourceType === "arcgis") {
      return municipalityScoped ? "Gemeinde-Import" : "AGIS";
    }

    return municipalityScoped ? "Gemeinde-Import" : "API";
  }

  function resolveGlobalSourceType() {
    const sourceUrl = resolveSourceUrl();
    const explicitSourceType = resolveSourceType();
    const autoDetectedSourceType = normalizeSourceType({ sourceUrl });
    const sourceMunicipality = resolveSourceMunicipality();

    if (explicitSourceType) {
      return explicitSourceType;
    }

    if (sourceMunicipality && autoDetectedSourceType === "json" && !looksLikeJsonSourceUrl(sourceUrl)) {
      return "html";
    }

    return autoDetectedSourceType;
  }

  function resolveMunicipalitySources() {
    if (typeof getMunicipalitySources !== "function") {
      return [];
    }

    return getMunicipalitySources()
      .filter((source) => source.enabled && source.sourceUrl && source.sourceType !== "manual")
      .map((source) => {
        const normalizedSourceType = normalizeSourceType(source);

        return {
          ...source,
          sourceType: normalizedSourceType,
          source: buildImportSourceName(normalizedSourceType, true),
          pruneStale: true
        };
      });
  }

  async function syncConfiguredSource(sourceConfig) {
    const collected = await fetchNormalizedItemsFromSource(
      sourceConfig,
      fetchImpl,
      requestTimeoutMs,
      geocodeFetchImpl,
      pdfTextExtractImpl
    );
    const assessedItems = await assessImportedItems(collected.items, assessApplication);
    const result = repository.importItems(assessedItems, new Date().toISOString());
    const removedCount =
      sourceConfig.pruneStale && sourceConfig.source === "Gemeinde-Webseite" && sourceConfig.municipality && assessedItems.length > 0
        ? repository.pruneUntouchedMunicipalityImports({
            source: sourceConfig.source,
            municipality: sourceConfig.municipality,
            keepSourceReferences: assessedItems.map((item) => item.sourceReference)
          })
        : 0;
    const notificationCount =
      typeof notifyImportChanges === "function" && result.changes?.length
        ? notifyImportChanges(result.changes, buildSourceLabel(sourceConfig))
        : 0;

    return {
      imported: result.importedCount > 0 || result.updatedCount > 0,
      importedCount: result.importedCount,
      updatedCount: result.updatedCount,
      removedCount,
      skippedCount: Math.max(0, collected.rawCount - assessedItems.length),
      items: result.items,
      changes: result.changes ?? [],
      notificationCount,
      sourceSummaries: [
        {
          municipality: sourceConfig.municipality ?? "",
          sourceType: normalizeSourceType(sourceConfig),
          sourceLabel: buildSourceLabel(sourceConfig),
          importedCount: result.importedCount,
          updatedCount: result.updatedCount,
          removedCount,
          skippedCount: Math.max(0, collected.rawCount - assessedItems.length),
          notificationCount,
          error: ""
        }
      ]
    };
  }

  async function syncMunicipalitySources(sources) {
    const settledResults = await mapWithConcurrency(
      sources,
      async (source) => {
        try {
          return {
            ok: true,
            result: await syncConfiguredSource(source)
          };
        } catch (error) {
          return {
            ok: false,
            error,
            source
          };
        }
      },
      municipalitySourceConcurrency
    );
    const results = [];
    const errors = [];

    for (const settled of settledResults) {
      if (settled?.ok) {
        results.push(settled.result);
        continue;
      }

      errors.push({
        municipality: settled.source.municipality,
        sourceType: settled.source.sourceType,
        sourceLabel: buildSourceLabel(settled.source),
        importedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        notificationCount: 0,
        error: settled.error.message
      });
    }

    if (!results.length && errors.length) {
      throw new Error(`Alle aktivierten Gemeindequellen sind fehlgeschlagen. Erste Fehlermeldung: ${errors[0].error}`);
    }

    const merged = mergeSyncResults(results);

    return {
      ...merged,
      imported: merged.importedCount > 0 || merged.updatedCount > 0,
      source: "municipality-sources",
      sourceSummaries: [...merged.sourceSummaries, ...errors]
    };
  }

  return {
    isConfigured() {
      return Boolean(resolveSourceUrl()) || resolveMunicipalitySources().length > 0;
    },

    getSourceLabel() {
      const hasMunicipalitySources = resolveMunicipalitySources().length > 0;
      const hasGlobalSource = Boolean(resolveSourceUrl());
      const globalSourceType = hasGlobalSource ? resolveGlobalSourceType() : "";
      const hasWebsiteScrapingSource = ["html", "xml", "pdf"].includes(globalSourceType);
      const isAmtsblattSource = globalSourceType === "amtsblatt";
      const globalSourceName = isAmtsblattSource
        ? "Amtsblatt"
        : hasWebsiteScrapingSource
          ? "Website-Scraping"
          : "API";

      if (hasMunicipalitySources && hasGlobalSource) {
        return `Gemeindequellen + ${globalSourceName}`;
      }

      if (hasMunicipalitySources) {
        return "Gemeindequellen";
      }

      if (hasGlobalSource) {
        return globalSourceName;
      }

      return "Demo";
    },

    async sync() {
      const syncResults = [];
      const municipalitySources = resolveMunicipalitySources();

      if (municipalitySources.length > 0) {
        syncResults.push(await syncMunicipalitySources(municipalitySources));
      }

      if (resolveSourceUrl()) {
        const resolvedMunicipality = resolveSourceMunicipality();
        const resolvedSourceType = resolveGlobalSourceType();

        syncResults.push(
          await syncConfiguredSource({
            id: "GLOBAL-SYNC-SOURCE",
            sourceUrl: resolveSourceUrl(),
            sourceToken: resolveSourceToken(),
            sourceType: resolvedSourceType,
            municipality: resolvedMunicipality,
            sourceLabel: resolvedMunicipality
              ? `${resolvedMunicipality} (${resolvedSourceType})`
              : buildImportSourceName(resolvedSourceType),
            source: buildImportSourceName(resolvedSourceType),
            pruneStale: false
          })
        );
      }

      if (!syncResults.length) {
        const result = repository.simulateSync();

        if (typeof notifyImportChanges === "function" && result.changes?.length) {
          result.notificationCount = notifyImportChanges(result.changes, this.getSourceLabel());
        }

        return result;
      }

      const merged = mergeSyncResults(syncResults);

      // Ablaufdatum/Aufbewahrung: abgelaufene, unberührte Fälle entfernen.
      let removedExpiredCount = 0;

      if (applicationRetentionDays > 0 && typeof repository.pruneExpiredApplications === "function") {
        removedExpiredCount = repository.pruneExpiredApplications({ retentionDays: applicationRetentionDays });
      }

      return {
        ...merged,
        imported: merged.importedCount > 0 || merged.updatedCount > 0,
        item: merged.items[0] ?? null,
        remainingQueue: 0,
        removedExpiredCount,
        source: municipalitySources.length > 0 ? "mixed" : "api"
      };
    }
  };
}
