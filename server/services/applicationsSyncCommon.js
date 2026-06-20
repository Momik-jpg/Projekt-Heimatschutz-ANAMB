// Gemeinsame Normalisierungs-, HTTP- und Parser-Helfer
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import { createHash, randomBytes } from "node:crypto";
import { PDFParse } from "pdf-parse";
import { aargauMunicipalityNames } from "../seed/municipalitySources.js";

// Normalisierter Suchschlüssel für Gemeindenamen: ohne Diakritika, ohne
// Kantonszusatz "AG"/"(AG)", damit "Hausen AG" -> "Hausen" und "Arni" -> "Arni (AG)".
export function normalizeMunicipalityKey(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\(ag\)/g, " ")
    .replace(/\bag\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const officialAargauMunicipalityByKey = new Map(
  aargauMunicipalityNames.map((name) => [normalizeMunicipalityKey(name), name])
);

// Gibt den offiziellen Aargauer Gemeindenamen zurück oder "" wenn der Wert
// keine echte Aargauer Gemeinde ist (z. B. Projekttext oder Fremdkantons-Ort).
export function resolveOfficialAargauMunicipality(name) {
  const key = normalizeMunicipalityKey(name);
  return key ? officialAargauMunicipalityByKey.get(key) ?? "" : "";
}

export const protectionStatusAliasMap = new Map([
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

export const workflowStatusAliasMap = new Map([
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

export const defaultHtmlKeywordsPattern =
  /\b(baugesuch|baugesuche|baubewilligung|baupublikation|amtliche publikation|auflage|einsprachfrist|publikation)\b/i;

export const defaultHtmlExcludePattern =
  /\b(home|startseite|kontakt|impressum|datenschutz|login|abmelden|mehr erfahren|weiterlesen)\b/i;

export const genericMunicipalityListingPattern =
  /\b(facebook|instagram|youtube|linkedin|whatsapp|gemeinderatsnachrichten|nachrichten|newsletter|veranstaltungen|agenda|termine|vernehmlassung(?:en)?|news|aktuelles)\b/i;

export const genericMunicipalityArchivePattern = /\b(rss|archiv|archive|newsarchive|author|category|feed)\b/i;

export const genericMunicipalityPublicationRoutePattern =
  /\/_rtr\/(?:beschluesse|rechtsgueltigeamtlichepublikationen|reglemente|projektemain|budgetrechung|sucheeinerpublikation)(?:[/?#]|$)/i;

export const nonPendingPermitPattern =
  /\b(erteilte baubewilligungen?|baubewilligung(?:en)? erteilt|erteilte bewilligungen?)\b/i;

export const municipalitySearchResultPattern = /\b(suchergebnisse?|suchresultate|search results?|resultate)\b/i;

export const municipalityBulletinPattern = /\b(mitteilungsblatt|infoblatt)\b/i;

export const nonPermitMunicipalityUrlPattern =
  /(regionalebauverwaltung\.ch|\/bauen\/baubewilligungen\/ebau-aargau|(?:^|[\\/_-])bno(?:[\\/_-]|\\.|$)|nutzungsordnung)/i;

export const nonMunicipalPermitProcedurePattern =
  /\b(plangenehmigungsverfahren|elektrizit(?:ä|ae)tsgesetz|\beleg\b)\b/i;

export const nonPermitMunicipalityTopicPattern =
  /\b(mitteilungsblatt|infoblatt|gemeinderat|gemeindeversammlung|traktanden|protokoll|beschl(?:ü|ue)sse?|reglemente?|budget|rechnung|steuer|abstimmung|wahl|nutzungsplanung|bau-\s*und\s*nutzungsordnung|bno|teil(?:änderung|aenderung)|zonenvorschriften|gestaltungsplan|familiengartenzone|vorpr(?:ü|ue)fung|mitwirkung|genehmigung|kommunal(?:er|e|es)?\s+gesamtplan|politik\s+und\s+verwaltung|plangenehmigungsverfahren|elektrizit(?:ä|ae)tsgesetz|\beleg\b)\b/i;

export const explicitPermitSignalPattern =
  /\b(baugesuch(?:e)?|baupublikation(?:en)?|baubewilligung(?:en)?|bauherr(?:schaft)?|bauobjekt|bauvorhaben|bauprojekt|bauplatz|baustelle|objektadresse|standort|auflage\s+baugesuch)\b/i;

export const administrativePermitTemplatePattern =
  /(baugesuchumschlag|baugesuchsformular|baugesuch[_\s-]*formular|formular[_\s-]*baugesuch|gesuchsformular|bauformular|online[_\s-]*schalter)/i;

export const administrativePermitAttachmentPattern =
  /(katasterplan(?:kopie)?|situationsplan|grundriss|schnitt|fassadenplan|energienachweis)/i;

export const genericDownloadPattern = /\b(herunterladen|download)\b/i;

export const genericMunicipalityAnchorPattern =
  /^(?:zu den dokumenten|mehr lesen|öffnen|herunterladen|download|weiter|details?|artikel lesen)$/i;

export const monthYearListingPattern =
  /^(?:januar|februar|märz|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+20\d{2}$/i;

export const genericLocationTermPattern =
  /\b(baugesuch(?:e)?|baubewilligung(?:en)?|baupublikation(?:en)?|publikation(?:en)?|öffentliche auflage|öffentliche auflage|amtliche publikation(?:en)?|gemeindequelle|gemeinde-webseite|wohnraumstrategie|einbürgerungen|einbürgerungen|gemeinderatsnachrichten|facebook)\b/i;

export const clearlyNonAddressPattern =
  /\b(einwohnergemeinde|ortsbürgergemeinde|projektänderung|projektänderung|bauausschreibung|kanzlei|baupublikationen|auflagebaugesuche|amtliche publikationen?)\b/i;

export const projectLikeAddressPattern =
  /\b(sanierung|umbau|umnutzung|anbau|neubau|ersatzneubau|erweiterung|ausbau|rückbau|rueckbau|renovation|aufwertungsmassnahmen?|baugesuch|publikation)\b/i;

export const garbledProjectTypePattern = /^(?:[._-]*\d{2,}[._-]*)+$/;

export const garbledStructuredTextPattern =
  /\b(name-sort|datum-sort|data-page-length|_kategorieid|_thumbnail|customerid=|readspeaker|sind sie sicher, dass sie diesen eintrag löschen möchten|cms cms)\b/i;

export const unreliableProxyUrlPattern = /readspeaker\.com\/cgi-bin\/rsent/i;

export const streetLikeAddressPattern =
  /(?:strasse|strasse|weg|gasse|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)\b/i;

export const parcelLikeAddressPattern = /^Parzelle\s+\d{1,6}$/i;

export const addressPlaceholderPattern = /^Adresse\s+(?:prüfen|von\s+(?:Webseite|PDF)\s+prüfen|aus\s+Amtsblatt\s+prüfen)$/i;

export const standaloneHouseNumberPattern =
  /^(?:Haus(?:nummer|nr\.?)?|Geb(?:äude)?(?:\s+Nr\.?)?|Nr\.?)?\s*(\d{1,4}[a-z]?)$/iu;

// Generische "Strassenname + Hausnummer"-Adresse ohne bekanntes Strassen-Suffix
// (z. B. "Oberdorf 12", "Im Grund 4", "Vorstadt 3a"). Hausnummern auf 1-3 Stellen
// begrenzt, damit Jahreszahlen (2024) oder Postleitzahlen (5000) nicht fälschlich
// als Adresse geokodiert werden. So bekommen mehr echte Adressen automatisch
// Koordinaten statt "Von Hand prüfen".
export const houseNumberAddressPattern =
  /^[A-Za-zÄÖÜäöü][A-Za-zÄÖÜäöüéèà.'-]*(?:\s+[A-Za-zÄÖÜäöüéèà0-9.'-]+){0,3}\s+\d{1,3}\s?[a-z]?$/u;

export const streetAddressWithNumberPattern =
  /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-]*(?:\s+[A-ZÄÖÜa-zäöüéèà'’.-]+){0,4}(?:strasse|strasse|weg|gasse|gässli|gaessli|platz|allee|ring|rain|hof|matt|halde|park|dorf|steig|quai|ufer|matte|acker|feld|weid|zelg|zelgli|hubel|hueb|huebel|büel|bühl)\s+\d{1,4}[A-Za-z]?)\b/gu;

// Grobe Geocoder-Treffer (Gemeinde-, Bezirks-, Kantonsumriss, Ortschaftsname,
// Postleitzahl) sind keine genaue Verortung. Sie werden verworfen, damit ein
// unscharfer Treffer nie einen falschen "kein Schutz"-Befund erzeugt.
export const coarseGeocoderOrigins = new Set([
  "gg25",
  "kantone",
  "district",
  "gazetteer",
  "sn25",
  "zipcode"
]);

export const bgReferencePattern = /\bBG\s*20\d{2}(?:[-/.]\d+)?\b/i;

export const weekdayPatternSource =
  "(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)";

export const germanMonthPatternSource =
  "(?:januar|februar|märz|märz|april|mai|juni|juli|august|september|oktober|november|dezember)";

export const swissNumericDatePatternSource = "\\d{1,2}\\.\\d{1,2}\\.20\\d{2}";

export const swissTextualDatePatternSource = `(?:${weekdayPatternSource},?\\s*)?\\d{1,2}\\.\\s*${germanMonthPatternSource}\\s*20\\d{2}`;

export const swissDateLikePatternSource = `(?:${swissNumericDatePatternSource}|${swissTextualDatePatternSource})`;

export const defaultSyncRequestTimeoutMs = Number(process.env.SYNC_REQUEST_TIMEOUT_MS ?? 12000);

export const defaultMunicipalitySourceConcurrency = Number(process.env.MUNICIPALITY_SYNC_CONCURRENCY ?? 8);

export const defaultMunicipalityXmlLocationLimit = Number(process.env.MUNICIPALITY_XML_LOCATION_LIMIT ?? 80);

export const defaultSwissGeocoderUrl =
  process.env.SWISS_GEOCODER_URL ?? "https://api3.geo.admin.ch/rest/services/api/SearchServer";

export const defaultRemoteRequestHeaders = {
  "User-Agent": "HeimatschutzAargauBot/1.0",
  "Accept-Language": "de-CH,de;q=0.9,en;q=0.8"
};

export const germanMonthNumberMap = new Map([
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

export function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u");
}

export function normalizeLocationPrecision(value) {
  const normalized = normalizeText(value);

  if (["approximate", "coarse", "rough", "unscharf", "ungenau"].includes(normalized)) {
    return "approximate";
  }

  if (["precise", "exact", "genau"].includes(normalized)) {
    return "precise";
  }

  return "";
}

export function normalizeDate(value) {
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

export function addDays(dateValue, days) {
  const normalized = normalizeDate(dateValue);

  if (!normalized) {
    return "";
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function firstNonEmptyValue(...values) {
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

export function normalizeProtectionStatus(rawValue, ambiguousAddress) {
  if (ambiguousAddress) {
    return "manual-review";
  }

  const normalized = protectionStatusAliasMap.get(normalizeText(rawValue));
  return normalized ?? "no-hit";
}

export function normalizeWorkflowStatus(rawValue) {
  const normalized = workflowStatusAliasMap.get(normalizeText(rawValue));
  return normalized ?? "new";
}

export function normalizeCoordinates(item) {
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

export function normalizeFeatureCoordinates(feature) {
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

export function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  return [];
}

export function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function defaultAgisMatch(protectionStatus, ambiguousAddress) {
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

export function buildGeneratedSourceReference(parts) {
  const basis = parts.map((entry) => String(entry ?? "").trim()).filter(Boolean).join("|");
  const hash = createHash("sha1").update(basis || randomBytes(8).toString("hex")).digest("hex");
  return `AUTO-${hash.slice(0, 16).toUpperCase()}`;
}

export function createImportCandidate(rawItem, sourceUrl, fallbacks = {}) {
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

// Säubert Bauvorhaben-/Beschreibungstext bereits beim Import: entfernt HTML-Reste,
// ein vorangestelltes Rubrik-Label ("Bauvorhaben: …") und angehängten Fremdtext
// anderer Rubriken (Bauherr/Lage/Parzelle …). Verbessert Anzeige und Lern-Signaturen
// gleichermassen. Für bereits saubere Werte ist die Funktion eine Identität.
export function looksLikeMarkupJunk(value) {
  return /<[a-z/!]|=\s*["']|\bdata-[\w-]+|%5[bd]|class=|box[\s-]box|tx_[a-z_]+|filter%|\/publikation/i.test(value);
}

export function cleanProjectText(value) {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#0?39|apos);/gi, " ")
    .replace(/\b[\w-]+\s*=\s*"[^"]*"/g, " ")
    .replace(/\b[\w-]+\s*=\s*'[^']*'/g, " ")
    .replace(/[?&][\w.%[\]+-]+=[\w.%[\]+-]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\s*(?:Bauvorhaben|Bauprojekt|Bauobjekt|Projekt)\s*[:.–-]\s*/i, "")
    .replace(
      /\s*(?:Bauherr(?:schaft)?|Grundeigentümer(?:in)?|Eigentümer(?:in)?|Projektverfasser|Bauplatz|Standort|Lage|Parzelle|Auflage(?:frist)?|Publikation|Frist|Einsprache)\s*:.*$/i,
      ""
    );
  const cleaned = text.replace(/[\s,;:–-]+$/, "").trim();
  // Bleiben Markup-/Code-Reste übrig, gar nicht erst speichern.
  return looksLikeMarkupJunk(cleaned) ? "" : cleaned;
}

export function isDeadlineBeforePublication(deadlineDate, publicationDate) {
  return Boolean(deadlineDate && publicationDate && deadlineDate < publicationDate);
}

export function appendAutomatedAssessmentNote(value, note) {
  const assessment = String(value ?? "").trim();
  const normalizedNote = String(note ?? "").trim();

  if (!normalizedNote || assessment.includes(normalizedNote)) {
    return assessment;
  }

  return [assessment, normalizedNote].filter(Boolean).join(" ");
}

export function createNormalizedApplication(rawItem, sourceUrl, fallbacks = {}) {
  const item = createImportCandidate(rawItem, sourceUrl, fallbacks);
  const coordinates = normalizeCoordinates(item);
  const ambiguousAddress =
    Boolean(item.ambiguousAddress ?? item.ambiguous_address ?? fallbacks.ambiguousAddress ?? false) || !coordinates;
  const municipality = String(item.municipality ?? item.ort ?? fallbacks.municipality ?? "").trim();
  const parcel = String(item.parcel ?? item.parzelle ?? "").trim();
  const address = String(item.address ?? item.adresse ?? fallbacks.address ?? "").trim() || (parcel ? `Parzelle ${parcel}` : "");
  const publicationDate = normalizeDate(item.publicationDate ?? item.publication_date ?? item.publishedAt);
  const rawDeadlineDate = normalizeDate(item.deadlineDate ?? item.deadline_date ?? item.fristende);
  const invalidDeadlineDate = isDeadlineBeforePublication(rawDeadlineDate, publicationDate);
  const deadlineDate = invalidDeadlineDate ? "" : rawDeadlineDate;
  const projectType = cleanProjectText(item.projectType ?? item.project_type ?? item.bauvorhaben) || "Baugesuch";
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

  // Ein ungültiges Fristdatum ist ein reines Datenqualitätsproblem und darf den
  // Schutzstatus NICHT überschreiben (sonst verschwindet ein möglicher
  // Schutztreffer aus der Bewertung). Es wird nur das Fristdatum geleert (oben)
  // und unten als Hinweis vermerkt; AGIS bleibt für den Fall zuständig.
  const protectionStatus = normalizeProtectionStatus(
    item.protectionStatus ?? item.protection_status ?? item.agisMatch ?? item.agis_match,
    ambiguousAddress
  );
  const automatedAssessment = appendAutomatedAssessmentNote(
    item.automatedAssessment ?? item.automated_assessment ?? "",
    invalidDeadlineDate ? "Fristdatum liegt vor Publikationsdatum und muss von Hand geprüft werden." : ""
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
    description: cleanProjectText(item.description ?? item.beschreibung ?? fallbacks.description),
    protectionStatus,
    agisMatch: String(item.agisMatch ?? item.agis_match ?? defaultAgisMatch(protectionStatus, ambiguousAddress)).trim(),
    agisLayers: normalizeArray(item.agisLayers ?? item.agis_layers),
    workflowStatus: normalizeWorkflowStatus(item.workflowStatus ?? item.workflow_status),
    assignee: String(item.assignee ?? "").trim(),
    note: String(item.note ?? "").trim(),
    automatedAssessment,
    ambiguousAddress: ambiguousAddress ? 1 : 0,
    locationPrecision: coordinates
      ? normalizeLocationPrecision(item.locationPrecision ?? item.location_precision ?? fallbacks.locationPrecision)
      : ""
  };
}

export function parseApiPayload(payload) {
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

export async function fetchWithTimeout(fetchImpl, resource, options = {}, timeoutMs = defaultSyncRequestTimeoutMs) {
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultSyncRequestTimeoutMs;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), normalizedTimeout);

  try {
    return await fetchImpl(resource, {
      ...options,
      headers: {
        ...defaultRemoteRequestHeaders,
        ...options.headers
      },
      signal: options.signal ?? controller.signal
    });
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
