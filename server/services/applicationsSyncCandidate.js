// Baugesuch-Import: Candidate-Helfer (aus applicationsSyncCommon.js aufgeteilt).
import { createHash, randomBytes } from "node:crypto";
import {
  firstNonEmptyValue,
  normalizeArray,
  normalizeCoordinates,
  normalizeDate,
  normalizeFeatureCoordinates,
  normalizeLocationPrecision,
  normalizeProtectionStatus,
  normalizeWorkflowStatus
} from "./applicationsSyncNormalize.js";

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
  const rawAddress = String(item.address ?? item.adresse ?? fallbacks.address ?? "").trim();
  const address = rawAddress || (parcel ? `Parzelle ${parcel}` : "");
  const publicationDate = normalizeDate(item.publicationDate ?? item.publication_date ?? item.publishedAt);
  const rawDeadlineDate = normalizeDate(item.deadlineDate ?? item.deadline_date ?? item.fristende);
  const invalidDeadlineDate = isDeadlineBeforePublication(rawDeadlineDate, publicationDate);
  const deadlineDate = invalidDeadlineDate ? "" : rawDeadlineDate;
  const deadlineProvenance = deadlineDate
    ? String(item.deadlineProvenance ?? item.deadline_provenance ?? "explicit").trim() || "explicit"
    : "missing";
  const addressProvenance =
    String(item.addressProvenance ?? item.address_provenance ?? "").trim() ||
    (rawAddress ? "official-field" : "fallback");
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
    addressProvenance,
    parcel,
    coordinates,
    publicationDate,
    deadlineDate,
    deadlineProvenance,
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
