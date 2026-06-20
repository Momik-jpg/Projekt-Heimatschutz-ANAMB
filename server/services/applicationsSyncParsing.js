// Barrel: bündelt die Parser-/Import-Module des Baugesuch-Imports.
// Aufgeteilt aus dem früheren 6127-Zeilen-Monolithen; Re-Export hält den
// Service-Import (applicationsSyncService.js) unverändert.
export * from "./applicationsSyncAddress.js";
export * from "./applicationsSyncAmtsblatt.js";
export * from "./applicationsSyncCommon.js";
export * from "./applicationsSyncDiscovery.js";
export * from "./applicationsSyncGeocode.js";
export * from "./applicationsSyncHtml.js";
export * from "./applicationsSyncMunicipality.js";
export * from "./applicationsSyncPdf.js";
export * from "./applicationsSyncPublication.js";
export * from "./applicationsSyncRefinement.js";
export * from "./applicationsSyncSource.js";
export * from "./applicationsSyncXml.js";
