// Deterministischer Abgleich von Amtsblatt- und Gemeinde-Quellnachweisen.
//
// Grundsatz (Design-Doc 2026-06-22): Es werden keine Werte erfunden, geschätzt
// oder aus Fristen/Importzeitpunkten zurückgerechnet. Das Amtsblatt ist die
// massgebliche Quelle; Gemeindequellen bestätigen, ergänzen fehlende Werte oder
// liefern einen Fallback mit ausdrücklich belegtem Publikationsdatum.
//
// Dieses Modul ist bewusst rein (keine DB, keine Seiteneffekte), damit der
// rechtlich heikle Abgleich vollständig deterministisch testbar bleibt.

export const SOURCE_KIND_AMTSBLATT = "amtsblatt";
export const SOURCE_KIND_MUNICIPALITY = "municipality";
export const SOURCE_KIND_IMPORT = "import";

export const RECONCILIATION_STATUS = Object.freeze({
  AMTSBLATT_CONFIRMED: "amtsblatt-confirmed",
  MUNICIPALITY_ONLY: "municipality-only",
  CONFLICT_REVIEW: "conflict-review",
  MISSING_PUBLICATION: "missing-publication",
  AMBIGUOUS_REVIEW: "ambiguous-review",
  IMPORT_REVIEW: "import-review"
});

export function sourceKindOf(source) {
  const normalized = baseNormalize(source);
  if (!normalized) return SOURCE_KIND_IMPORT;
  if (/\bamtsblatt\b/.test(normalized)) return SOURCE_KIND_AMTSBLATT;

  if (
    /\bgemeinde(?:seite|webseite|portal|quelle|import|feed|pdf)?\b/.test(normalized)
    || /\bkommunal(?:e|er|es)?\b/.test(normalized)
  ) {
    return SOURCE_KIND_MUNICIPALITY;
  }

  if (/\b(?:api|agis|arcgis|import|export|json|datensatz|dataset)\b/.test(normalized)) {
    return SOURCE_KIND_IMPORT;
  }

  if (
    /\bbaugesuch(?:e)?\b/.test(normalized)
    || /\bbaupublikation(?:en)?\b/.test(normalized)
    || /\bbauverwaltung\b/.test(normalized)
    || /\bauflage\b/.test(normalized)
    || /\bpdf(?: |-)auflage\b/.test(normalized)
  ) {
    return SOURCE_KIND_MUNICIPALITY;
  }

  return SOURCE_KIND_IMPORT;
}

function baseNormalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMunicipality(value) {
  return baseNormalize(value)
    .replace(/\s*\(?ag\)?\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeParcel(value) {
  return baseNormalize(value)
    .replace(/\b(?:parzelle|parz\.?|grundstuck|grundstuck-nr\.?|nr\.?|gb)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

export function normalizeAddress(value) {
  return baseNormalize(value)
    .replace(/strasse/g, "str")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeProject(value) {
  return baseNormalize(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Vergleicht zwei Quellnachweise/Fälle und liefert die zutreffende Abgleichregel
// oder null. Reihenfolge entspricht der Fachpriorität des Design-Docs.
export function matchRule(left, right) {
  const leftMun = normalizeMunicipality(left.municipality);
  const rightMun = normalizeMunicipality(right.municipality);
  if (!leftMun || leftMun !== rightMun) return null;

  const leftPub = String(left.publicationDate ?? "").trim();
  const rightPub = String(right.publicationDate ?? "").trim();
  const samePublication = Boolean(leftPub) && leftPub === rightPub;

  const leftParcel = normalizeParcel(left.parcel);
  const sameParcel = Boolean(leftParcel) && leftParcel === normalizeParcel(right.parcel);

  const leftAddress = normalizeAddress(left.address);
  const sameAddress = Boolean(leftAddress) && leftAddress === normalizeAddress(right.address);

  const leftProject = normalizeProject(left.projectType);
  const sameProject = Boolean(leftProject) && leftProject === normalizeProject(right.projectType);

  // Belegtes, übereinstimmendes Publikationsdatum + ein hartes Sachmerkmal.
  if (samePublication && sameParcel) return "publication+parcel";
  if (samePublication && sameAddress) return "publication+address";

  // Fehlt in einer Quelle das Publikationsdatum: zwei unabhängige Sachmerkmale
  // (Parzelle bzw. vollständige Adresse PLUS Bauvorhaben) sind erforderlich.
  const onePublicationMissing = !leftPub || !rightPub;
  if (onePublicationMissing && sameParcel && sameProject) return "parcel+project";
  if (onePublicationMissing && sameAddress && sameProject) return "address+project";

  return null;
}

// Sucht unter Kandidaten den eindeutigen Abgleichtreffer. Mehrere mögliche
// Treffer => keine automatische Zusammenführung (ambiguous).
export function findReconciliationMatch(incoming, candidates) {
  const matches = [];
  for (const candidate of candidates ?? []) {
    const rule = matchRule(incoming, candidate);
    if (rule) matches.push({ candidate, rule });
  }
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "matched", candidate: matches[0].candidate, rule: matches[0].rule };
}

export function canReconcileSources(incomingKind, candidateKind) {
  if (incomingKind === SOURCE_KIND_IMPORT || candidateKind === SOURCE_KIND_IMPORT) return false;
  if (incomingKind === SOURCE_KIND_AMTSBLATT && candidateKind === SOURCE_KIND_AMTSBLATT) return false;
  return true;
}

// Konflikte zwischen zwei belegten Nachweisen (nur harte, belegte Felder).
export function detectConflicts(left, right) {
  const conflicts = [];
  const compare = (field, leftValue, rightValue) => {
    if (leftValue && rightValue && leftValue !== rightValue) conflicts.push(field);
  };
  compare("municipality", normalizeMunicipality(left.municipality), normalizeMunicipality(right.municipality));
  compare("publicationDate", String(left.publicationDate ?? "").trim(), String(right.publicationDate ?? "").trim());
  compare("deadlineDate", String(left.deadlineDate ?? "").trim(), String(right.deadlineDate ?? "").trim());
  compare("parcel", normalizeParcel(left.parcel), normalizeParcel(right.parcel));
  compare("address", normalizeAddress(left.address), normalizeAddress(right.address));
  compare("projectType", normalizeProject(left.projectType), normalizeProject(right.projectType));
  return conflicts;
}

// Leitet den Abgleichstatus aus allen Nachweisen eines Falls ab.
export function deriveReconciliationStatus(evidences) {
  const list = evidences ?? [];
  if (list.length === 0) return RECONCILIATION_STATUS.MISSING_PUBLICATION;

  if (list.some((evidence) => ["ambiguous", "unmatched"].includes(String(evidence.matchStatus ?? "")))) {
    return RECONCILIATION_STATUS.AMBIGUOUS_REVIEW;
  }

  const hasAmtsblatt = list.some((evidence) => evidence.sourceKind === SOURCE_KIND_AMTSBLATT);
  const hasMunicipality = list.some((evidence) => evidence.sourceKind === SOURCE_KIND_MUNICIPALITY);
  const hasOnlyImportSources = list.every((evidence) => evidence.sourceKind === SOURCE_KIND_IMPORT);
  if (hasOnlyImportSources) return RECONCILIATION_STATUS.IMPORT_REVIEW;

  for (let leftIndex = 0; leftIndex < list.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < list.length; rightIndex += 1) {
      if (detectConflicts(list[leftIndex], list[rightIndex]).length > 0) {
        return RECONCILIATION_STATUS.CONFLICT_REVIEW;
      }
    }
  }

  const withPublication = list.filter((evidence) => String(evidence.publicationDate ?? "").trim());

  if (withPublication.length === 0) return RECONCILIATION_STATUS.MISSING_PUBLICATION;

  const publicationDates = new Set(withPublication.map((evidence) => String(evidence.publicationDate).trim()));
  const deadlineDates = new Set(
    list.map((evidence) => String(evidence.deadlineDate ?? "").trim()).filter(Boolean)
  );
  if (publicationDates.size > 1 || deadlineDates.size > 1) return RECONCILIATION_STATUS.CONFLICT_REVIEW;

  if (hasAmtsblatt) return RECONCILIATION_STATUS.AMTSBLATT_CONFIRMED;
  return hasMunicipality ? RECONCILIATION_STATUS.MUNICIPALITY_ONLY : RECONCILIATION_STATUS.IMPORT_REVIEW;
}

// Baut die kanonischen Feldwerte: Amtsblatt zuerst, fehlende Werte aus der
// Gemeindequelle ergänzt. Zwei unterschiedliche belegte Werte werden nicht
// still überschrieben - der Amtsblatt-Wert bleibt kanonisch (Konflikt wird über
// deriveReconciliationStatus sichtbar).
export function buildCanonicalFields(evidences) {
  const list = evidences ?? [];
  const amtsblatt = list.filter((evidence) => evidence.sourceKind === SOURCE_KIND_AMTSBLATT);
  const municipality = list.filter((evidence) => evidence.sourceKind === SOURCE_KIND_MUNICIPALITY);
  const imports = list.filter(
    (evidence) => ![SOURCE_KIND_AMTSBLATT, SOURCE_KIND_MUNICIPALITY].includes(evidence.sourceKind)
  );
  const ordered = [...amtsblatt, ...municipality, ...imports];

  const pick = (field) => {
    for (const evidence of ordered) {
      const value = String(evidence[field] ?? "").trim();
      if (value) return value;
    }
    return "";
  };

  return {
    publicationDate: pick("publicationDate"),
    deadlineDate: pick("deadlineDate"),
    municipality: pick("municipality"),
    address: pick("address"),
    parcel: pick("parcel"),
    projectType: pick("projectType")
  };
}
