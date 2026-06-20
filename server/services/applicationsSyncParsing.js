// Barrel: oeffentliche API des Baugesuch-Imports. Bewusst nur die vom Service
// tatsaechlich genutzten Symbole – kein `export *` aller Internals, damit die
// API-Grenze klar ist und interne Helfer gekapselt bleiben.
export {
  defaultSyncRequestTimeoutMs,
  defaultMunicipalitySourceConcurrency,
  normalizeImportedPayload,
  mapWithConcurrency,
  looksLikeJsonSourceUrl,
  extractPdfTextFromBuffer
} from "./applicationsSyncCommon.js";

export {
  geocodeMunicipalityAddressWithPrecision,
  geocodeMunicipalityParcel
} from "./applicationsSyncGeocode.js";

export { refineImportedItems } from "./applicationsSyncRefinement.js";

export {
  buildSourceLabel,
  normalizeSourceType,
  fetchNormalizedItemsFromSource,
  assessImportedItems,
  mergeSyncResults
} from "./applicationsSyncSource.js";

export {
  buildAmtsblattResultUrl,
  parseAmtsblattEntries,
  buildAmtsblattItemFromEntry
} from "./applicationsSyncAmtsblatt.js";
