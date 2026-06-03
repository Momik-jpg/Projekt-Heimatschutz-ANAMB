// Reine Anzeige-Label-Maps (kein DOM, kein State). Aus app.js ausgelagert.

export const protectionStatusLabels = {
  "no-hit": "Kein Schutz gefunden",
  "protected-point": "Gebäude geschützt",
  "protected-zone": "Gebiet geschützt",
  "combined-hit": "Gebäude + Gebiet",
  "manual-review": "Manuell prüfen"
};

export const workflowStatusLabels = {
  new: "Offen",
  "under-review": "Im Team",
  escalated: "Im Team",
  cleared: "Erledigt",
  archived: "Abgelegt"
};

export const municipalitySourceTypeLabels = {
  manual: "Manuell",
  html: "Gemeinde-Webseite",
  xml: "XML / RSS / Sitemap",
  json: "JSON-Datei",
  arcgis: "ArcGIS / AGIS",
  pdf: "Direkte PDF-Quelle"
};

export const municipalityDigitalStatusLabels = {
  unknown: "Noch offen",
  digital: "Digital",
  partial: "Teilweise digital",
  manual: "Nicht digital"
};

export const quickFilterLabels = {
  all: "Aktuell: offene und aktuelle Fälle.",
  important: "Aktuell: Schutztreffer.",
  manual: "Aktuell: Fälle mit offener Klärung.",
  open: "Aktuell: offene Fälle.",
  "due-soon": "Aktuell: nahe Fristen.",
  archive: "Aktuell: alle erfassten Baugesuche (inkl. Archiv)."
};

export const quickFilterNames = {
  all: "Arbeitsliste",
  important: "Schutztreffer",
  manual: "Von Hand prüfen",
  open: "Nur offen",
  "due-soon": "Frist bald",
  archive: "Alle / Archiv"
};
