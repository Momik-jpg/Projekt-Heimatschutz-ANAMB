// Baugesuch-Import: Constants-Helfer (aus applicationsSyncCommon.js aufgeteilt).
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

// Linear-sicher (kein verschachteltes [._-]* an beiden Gruppen-Enden -> kein ReDoS).
export const garbledProjectTypePattern = /^(?:[._-]*\d{2,})+[._-]*$/;

export const garbledStructuredTextPattern =
  /\b(name-sort|datum-sort|data-page-length|_kategorieid|_thumbnail|customerid=|readspeaker|sind sie sicher, dass sie diesen eintrag löschen möchten|cms cms)\b/i;

export const unreliableProxyUrlPattern = /^https?:\/\/(?:[^/]+\.)?readspeaker\.com\/cgi-bin\/rsent(?:[/?#]|$)/i;

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

// Hartes Antwort-Grössenlimit gegen Speichererschöpfung durch boesartige Quellen.
export const defaultMaxResponseBytes = Number(process.env.SYNC_MAX_RESPONSE_BYTES ?? 10 * 1024 * 1024);

export const defaultMunicipalitySourceConcurrency = Number(process.env.MUNICIPALITY_SYNC_CONCURRENCY ?? 8);

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
