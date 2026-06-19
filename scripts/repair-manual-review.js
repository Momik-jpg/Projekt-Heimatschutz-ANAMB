#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDefaultDbPath } from "../server/db.js";
import { createAgisAssessmentService } from "../server/services/agisAssessmentService.js";
import { createAgisGeometryService } from "../server/services/agisGeometryService.js";
import {
  geocodeMunicipalityAddressWithPrecision,
  geocodeMunicipalityParcel
} from "../server/services/applicationsSyncService.js";

function parseArgs(argv) {
  const args = new Map();

  for (let index = 2; index < argv.length; index += 1) {
    const raw = argv[index];

    if (!raw.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = raw.slice(2).split("=");
    const isFlag = inlineValue === undefined && (argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined);

    if (isFlag) {
      args.set(key, true);
      continue;
    }

    args.set(key, inlineValue ?? argv[index + 1]);
    if (inlineValue === undefined) index += 1;
  }

  return args;
}

const args = parseArgs(process.argv);
const apply = args.has("apply");
const asJson = args.has("json");
const limit = Number(args.get("limit") ?? 0);
const exampleLimit = Number(args.get("examples") ?? 20);
const requestTimeoutMs = Number(args.get("timeout-ms") ?? process.env.SYNC_REQUEST_TIMEOUT_MS ?? 15000);
const maxParcelGroupGeocodeCandidates = 10;
const dbPath = resolve(args.get("db") ?? process.env.DATABASE_PATH ?? getDefaultDbPath());

const placeholderAddressPattern =
  /^adresse\s+(?:pruefen|prüfen|von\s+(?:webseite|pdf)\s+(?:pruefen|prüfen)|aus\s+amtsblatt\s+(?:pruefen|prüfen))$/i;
const parcelOnlyAddressPattern = /^parzelle(?:\s+nr\.?)?\s+(\d{1,6})$/i;
const streetWithNumberPattern = /[a-zäöü]{3,}.*\b\d{1,4}[a-z]?\b/i;
const weakStreetPattern =
  /\b[A-ZÄÖÜ]?[a-zäöü]{3,}(?:strasse|str\.|weg|gasse|platz|allee|ring|rain|halde|steig|matte|acker|feld|quai|ufer)\b/i;
const parcelPattern =
  /\b(?:Parzellen?|Parz)\s*\.?\s*(?:-|:|\s)*(?:(?:(?:GB|Grundbuch)\s+)?[\p{L}() .'-]+?\s+)?(?:Nrn?\.?|Nr\.?)?\s*(\d{1,6})\b/gui;
const parcelListPattern =
  /\b(?:Parzellen?|Parz)\s*\.?\s*(?:-|:|\s)*(?:(?:(?:GB|Grundbuch)\s+)?[\p{L}() .'-]+?\s+)?(?:Nrn?\.?|Nr\.?)?\s*(\d{1,6}(?:\s*(?:,|\/|und)\s*\d{1,6}){0,9})/gui;
const streetCandidatePattern =
  /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèàÉÈÀ.\- ]{0,58}(?:strasse|str\.|weg|gasse|platz|allee|ring|rain|halde|steig|matte|acker|feld|quai|ufer)\s*(?:\d{1,4}[A-Za-z]?)?)\b/g;
const namedAddressWithNumberPattern =
  /\b((?:Am|Im|In der|In den|An der|Auf der|Beim|Bei der|Obere|Untere|Unter|Ober)\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèàÉÈÀ.\- ]{2,54}\s+\d{1,4}[A-Za-z]?)\b/g;
const locationLabelPattern =
  /(?<!Auf)\b(?:Parzelle\s*\/\s*Strasse|Bauparzelle|Objektadresse|Bauplatz|Bauort|Baustelle|Standort|Ortslage|Lage)\s*:?\s*/gi;
const nextFieldPattern =
  /(?:\||\b(?:Parzelle\s*\/\s*Strasse|Bauparzelle|Objektadresse|Bauherr(?:schaft)?|Bauobjekt|Bauvorhaben|Projektverfasser|Grundeigentümer(?:in)?|Zone|Kant\.?\s*Bewilligungen?|weitere\s+Baubewilligungen?|Bemerkung|Öffentliche Auflage|Auflagefrist|Auflage|Allfällige|Einwendung|Baugesuchnummer|Publikation|Publ\.-Nr\.|Stelle|Rubrik|Frist)\b)/i;

function hasCoordinates(value) {
  if (!value) return false;
  const parts = String(value)
    .split(",")
    .map((part) => Number(part.trim()));
  return parts.length >= 2 && parts.every((part) => Number.isFinite(part));
}

function normalizeLocationPrecision(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (["approximate", "coarse", "rough", "unscharf", "ungenau"].includes(normalized)) {
    return "approximate";
  }

  if (["precise", "exact", "genau"].includes(normalized)) {
    return "precise";
  }

  return "";
}

function inferExistingLocationPrecision(row) {
  const storedPrecision = normalizeLocationPrecision(row.location_precision);

  if (storedPrecision) {
    return storedPrecision;
  }

  if (extractParcelCandidate(row) || streetWithNumberPattern.test(normalizeText(row.address))) {
    return "precise";
  }

  return "approximate";
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function htmlToSearchText(html) {
  const raw = String(html ?? "");
  const metaDescriptions = [...raw.matchAll(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
    .map((match) => match[1]);
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const bodyText = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return normalizeText(decodeHtmlEntities([title, ...metaDescriptions, bodyText].filter(Boolean).join(" ")));
}

async function fetchSourceSearchText(row, cache) {
  const url = normalizeText(row.source_url);

  if (!/^https?:\/\//i.test(url)) {
    return "";
  }

  if (cache.has(url)) {
    return cache.get(url);
  }

  const pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal
      });

      if (!response.ok || !String(response.headers.get("content-type") ?? "").includes("text/html")) {
        return "";
      }

      return htmlToSearchText(await response.text()).slice(0, 8000);
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  })();

  cache.set(url, pending);
  return pending;
}

function extractParcelCandidate(row) {
  const directParcel = normalizeText(row.parcel);

  if (/^\d{1,6}$/.test(directParcel)) {
    return directParcel;
  }

  const addressParcel =
    normalizeText(row.address).match(parcelOnlyAddressPattern)?.[1] ??
    normalizeText(row.address).match(/\bParzellen?\s+Nrn?\.?\s+(\d{1,6})\b/i)?.[1] ??
    "";
  return /^\d{1,6}$/.test(addressParcel) ? addressParcel : "";
}

function extractParcelCandidates(text) {
  const values = new Set();
  const parcelText = normalizeText(text).replace(/,\s*\d{4}\s+[A-ZÄÖÜ][\p{L}() .'-]+/gu, " ");

  for (const match of parcelText.matchAll(parcelListPattern)) {
    for (const value of match[1].match(/\d{1,6}/g) ?? []) {
      values.add(value);
    }
  }

  for (const match of parcelText.matchAll(parcelPattern)) {
    values.add(match[1]);
  }

  return [...values];
}

function cleanLocationCandidate(value) {
  let text = normalizeText(value)
    .replace(/^[,.;:/\s-]+/, "")
    .replace(/\s+öffentliche(?:\s+auflage)?\b.*$/i, "")
    .replace(/\s+auflage\b.*$/i, "")
    .replace(/\s+zone\b.*$/i, "")
    .replace(/\s+parz\s*\.?\s*:.*$/i, "")
    .replace(/\s+parzellen?\b.*$/i, "")
    .replace(/^\s*\d{1,6}\s*,\s*(?=[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèà'’.-])/u, "")
    .replace(/\s+gebäude\s+nr\.?\s+\d+.*$/i, "")
    .replace(/\s+\d{1,2}\.\s*(?:januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{4}.*$/i, "")
    .replace(/\s+\d{1,2}\.\s*[A-ZÄÖÜ][a-zäöü]+.*$/u, "")
    .trim();

  const slashSegments = text
    .split(/\s*\/\s*/)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
  const streetSegment = slashSegments.findLast((segment) => weakStreetPattern.test(segment));

  if (streetSegment) {
    text = streetSegment;
  }

  const streetMatch = [...text.matchAll(streetCandidatePattern)].at(-1)?.[1] ?? "";
  if (streetMatch) {
    text = normalizeText(streetMatch);
  }

  const namedAddressMatch = [...text.matchAll(namedAddressWithNumberPattern)].at(-1)?.[1] ?? "";
  if (namedAddressMatch) {
    text = normalizeText(namedAddressMatch);
  }

  return text;
}

function extractLabeledLocationCandidates(text) {
  const source = normalizeText(text);
  const candidates = [];
  let match = null;

  while ((match = locationLabelPattern.exec(source)) !== null) {
    const rest = source.slice(match.index + match[0].length);
    const nextFieldIndex = rest.search(nextFieldPattern);
    const segment = nextFieldIndex >= 0 ? rest.slice(0, nextFieldIndex) : rest;
    const cleaned = cleanLocationCandidate(segment);

    if (cleaned) {
      candidates.push(cleaned);
    }
  }

  return candidates;
}

function extractLabeledLocationSegments(text) {
  const source = normalizeText(text);
  const segments = [];
  let match = null;

  while ((match = locationLabelPattern.exec(source)) !== null) {
    const rest = source.slice(match.index + match[0].length);
    const nextFieldIndex = rest.search(nextFieldPattern);
    const segment = normalizeText(nextFieldIndex >= 0 ? rest.slice(0, nextFieldIndex) : rest);

    if (segment) {
      segments.push(segment);
    }
  }

  return segments;
}

function addCandidate(candidates, seen, candidate) {
  const query = normalizeText(candidate.query);

  if (!query || seen.has(`${candidate.kind}:${query}`)) {
    return;
  }

  if (placeholderAddressPattern.test(query)) {
    return;
  }

  seen.add(`${candidate.kind}:${query}`);
  candidates.push({ ...candidate, query });
}

function buildGeocodeCandidates(row, sourceText = "") {
  if (hasCoordinates(row.coordinates)) {
    return [{ kind: "has-coordinates", query: "" }];
  }

  const candidates = [];
  const seen = new Set();
  const baseTextPool = [
    row.address,
    row.parcel ? `Parzelle ${row.parcel}` : "",
    row.project_type,
    row.description
  ].filter(Boolean);
  const allTextPool = [
    ...baseTextPool,
    sourceText
  ].filter(Boolean);

  const directParcel = extractParcelCandidate(row);
  const labeledLocationSegments = sourceText ? extractLabeledLocationSegments(sourceText) : [];
  const labeledParcels = [...new Set(labeledLocationSegments.flatMap(extractParcelCandidates))];
  const parcelTextPool = [
    row.parcel ? `Parzelle ${row.parcel}` : "",
    row.project_type,
    row.description,
    sourceText
  ].filter(Boolean);
  const extractedParcels = [...new Set(parcelTextPool.flatMap(extractParcelCandidates))];
  const parcelGroupCandidates = labeledParcels.length > 1 ? labeledParcels : extractedParcels;
  const parcelCandidates =
    directParcel && extractedParcels.length <= 1
      ? [directParcel]
      : !directParcel && labeledParcels.length === 1
        ? labeledParcels
        : !directParcel && extractedParcels.length === 1
          ? extractedParcels
          : [];

  if (!directParcel && parcelGroupCandidates.length > 1 && parcelGroupCandidates.length <= maxParcelGroupGeocodeCandidates) {
    addCandidate(candidates, seen, {
      kind: "parcel-group",
      query: parcelGroupCandidates.join(", "),
      queries: parcelGroupCandidates,
      repairAddress: placeholderAddressPattern.test(normalizeText(row.address))
        ? `Parzellen ${parcelGroupCandidates.join(", ")}`
        : "",
      repairParcel: parcelGroupCandidates.join(", ")
    });
  }

  for (const parcel of parcelCandidates) {
    if (/^\d{1,6}$/.test(parcel)) {
      addCandidate(candidates, seen, {
        kind: "parcel",
        query: parcel,
        repairAddress: placeholderAddressPattern.test(normalizeText(row.address)) ? `Parzelle ${parcel}` : "",
        repairParcel: parcel
      });
    }
  }

  const addressTexts = [
    ...allTextPool.flatMap(extractLabeledLocationCandidates),
    cleanLocationCandidate(row.address),
    ...[row.address].flatMap((text) => [...normalizeText(text).matchAll(streetCandidatePattern)].map((match) => match[1])),
    ...[row.address].flatMap((text) => [...normalizeText(text).matchAll(namedAddressWithNumberPattern)].map((match) => match[1]))
  ];

  for (const value of addressTexts) {
    const query = cleanLocationCandidate(value);

    if (!query || query.length < 4 || /^(?:Gemeinde|Regionale Bauverwaltung)\b/i.test(query)) {
      continue;
    }

    addCandidate(candidates, seen, {
      kind: streetWithNumberPattern.test(query) ? "address" : "weak-address",
      query,
      repairAddress: query
    });
  }

  return candidates.length ? candidates : [{ kind: "no-location", query: "" }];
}

function parseCoordinatePair(value) {
  const parts = String(value ?? "")
    .split(",")
    .map((part) => Number(part.trim()));

  if (parts.length < 2 || !parts.every((part) => Number.isFinite(part))) {
    return null;
  }

  return {
    east: parts[0],
    north: parts[1]
  };
}

function averageCoordinates(values) {
  const coordinates = values.map(parseCoordinatePair).filter(Boolean);

  if (!coordinates.length) {
    return "";
  }

  const east = coordinates.reduce((sum, coordinate) => sum + coordinate.east, 0) / coordinates.length;
  const north = coordinates.reduce((sum, coordinate) => sum + coordinate.north, 0) / coordinates.length;
  return `${Math.round(east * 1000) / 1000},${Math.round(north * 1000) / 1000}`;
}

function listColumns(db) {
  return new Set(db.prepare("PRAGMA table_info(applications)").all().map((column) => column.name));
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureRepairSchema(db) {
  const columns = listColumns(db);

  if (!columns.has("location_precision")) {
    db.exec("ALTER TABLE applications ADD COLUMN location_precision TEXT NOT NULL DEFAULT '';");
  }
}

function backupDatabase(db, path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.manual-review-repair-${stamp}.bak`;
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)};`);
  return backupPath;
}

function selectCandidates(db) {
  const columns = listColumns(db);
  const locationPrecisionSelect = columns.has("location_precision")
    ? "location_precision"
    : "'' AS location_precision";
  const rows = db
    .prepare(
      `SELECT
        id,
        municipality,
        address,
        parcel,
        source,
        source_url,
        project_type,
        description,
        coordinates,
        ${locationPrecisionSelect},
        protection_status,
        agis_match,
        agis_layers,
        automated_assessment,
        ambiguous_address
      FROM applications
      WHERE (protection_status = 'manual-review' OR ambiguous_address = 1)
      ORDER BY municipality ASC, id ASC`
    )
    .all();

  return limit > 0 ? rows.slice(0, limit) : rows;
}

function appendAssessment(existing, next) {
  const current = normalizeText(existing);
  const addition = normalizeText(next);

  if (!addition || current.includes(addition)) {
    return current;
  }

  const parts = [existing, next]
    .map((part) => normalizeText(part))
    .filter(Boolean);
  return [...new Set(parts)].join(" ");
}

function buildRepairAssessmentNote(candidate, assessment) {
  if (candidate.kind === "existing-coordinates") {
    return `Repair: vorhandene Koordinate offiziell nachbewertet. ${assessment.automatedAssessment}`;
  }

  if (candidate.kind === "parcel-group") {
    return `Repair: Standort automatisch über mehrere amtliche Parzellen (${candidate.query}) geokodiert. ${assessment.automatedAssessment}`;
  }

  return `Repair: Standort automatisch per ${candidate.kind === "parcel" ? "Parzelle" : "Adresse"} geokodiert. ${assessment.automatedAssessment}`;
}

function parseAgisLayers(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const agisAssessmentService = createAgisAssessmentService({
  repository: {
    getById: () => null,
    list: () => [],
    updateAssessment: () => null
  },
  agisGeometryService: createAgisGeometryService({ fetchImpl: fetch }),
  logger: {
    warn: (message) => {
      if (!asJson) console.warn(message);
    }
  }
});

function combineAssessments(candidate, assessments) {
  const layers = [...new Set(assessments.flatMap((assessment) => assessment.agisLayers ?? []))];
  const statuses = new Set(assessments.map((assessment) => assessment.protectionStatus));
  const hasPoint = statuses.has("protected-point") || statuses.has("combined-hit") || layers.includes("Gebäude im Inventar");
  const hasZone = statuses.has("protected-zone") || statuses.has("combined-hit") || layers.includes("ISOS-Fläche");
  const parcelCount = candidate.queries?.length ?? assessments.length;

  if (hasPoint && hasZone) {
    return {
      protectionStatus: "combined-hit",
      agisMatch: "ISOS-Fläche und Gebäude im Inventar",
      agisLayers: layers,
      automatedAssessment: `Mindestens eine von ${parcelCount} amtlich geokodierten Parzellen liegt in einer geschützten Fläche oder bei einem Inventarobjekt.`
    };
  }

  if (hasPoint) {
    return {
      protectionStatus: "protected-point",
      agisMatch: "Treffer im Gebäudeinventar",
      agisLayers: layers.length ? layers : ["Gebäude im Inventar"],
      automatedAssessment: `Mindestens eine von ${parcelCount} amtlich geokodierten Parzellen liegt bei einem geschützten Inventarobjekt.`
    };
  }

  if (hasZone) {
    return {
      protectionStatus: "protected-zone",
      agisMatch: "Treffer in ISOS-Fläche",
      agisLayers: layers.length ? layers : ["ISOS-Fläche"],
      automatedAssessment: `Mindestens eine von ${parcelCount} amtlich geokodierten Parzellen liegt in einer geschützten Fläche.`
    };
  }

  if (statuses.has("manual-review")) {
    return {
      protectionStatus: "manual-review",
      agisMatch: "Nahe Schutzobjekte bei unscharfer Lage",
      agisLayers: layers,
      automatedAssessment: `Mindestens eine von ${parcelCount} amtlich geokodierten Parzellen braucht wegen Schutz-Nähe weiterhin eine fachliche Prüfung.`
    };
  }

  return {
    protectionStatus: "no-hit",
    agisMatch: "Kein Schutztreffer",
    agisLayers: [],
    automatedAssessment: `Alle ${parcelCount} amtlich geokodierten Parzellen wurden gegen AGIS geprüft; kein Schutztreffer.`
  };
}

async function assessGeocodeResult(row, geocode) {
  const coordinateTargets = geocode.coordinatesList?.length
    ? geocode.coordinatesList
    : [
        {
          query: geocode.candidate.query,
          coordinates: geocode.coordinates,
          locationPrecision: geocode.locationPrecision
        }
      ];
  const assessments = [];

  for (const target of coordinateTargets) {
    const assessment = await agisAssessmentService.assessItem({
      ...row,
      coordinates: target.coordinates,
      locationPrecision: target.locationPrecision,
      agisLayers: parseAgisLayers(row.agis_layers),
      protectionStatus: "no-hit",
      ambiguousAddress: false
    });

    if (!assessment) {
      return null;
    }

    assessments.push(assessment);
  }

  return coordinateTargets.length > 1 ? combineAssessments(geocode.candidate, assessments) : assessments[0];
}

async function tryGeocodeCandidates(candidates, row, geocodeCache) {
  const fallbackCandidate = candidates.find((candidate) => candidate.kind !== "no-location") ?? candidates[0];

  for (const candidate of candidates) {
    if (candidate.kind === "parcel-group") {
      const coordinatesList = [];

      for (const parcel of candidate.queries ?? []) {
        const coordinates = await geocodeMunicipalityParcel(
          parcel,
          row.municipality,
          fetch,
          requestTimeoutMs,
          geocodeCache
        );

        if (!coordinates) {
          coordinatesList.length = 0;
          break;
        }

        coordinatesList.push({
          query: parcel,
          coordinates,
          locationPrecision: "precise"
        });
      }

      if (coordinatesList.length === candidate.queries?.length) {
        return {
          candidate,
          coordinates: averageCoordinates(coordinatesList.map((entry) => entry.coordinates)),
          coordinatesList,
          locationPrecision: "precise"
        };
      }

      continue;
    }

    if (candidate.kind === "parcel") {
      const coordinates = await geocodeMunicipalityParcel(
        candidate.query,
        row.municipality,
        fetch,
        requestTimeoutMs,
        geocodeCache
      );

      if (coordinates) {
        return {
          candidate,
          coordinates,
          locationPrecision: "precise"
        };
      }

      continue;
    }

    if (candidate.kind === "address" || candidate.kind === "weak-address") {
      const match = await geocodeMunicipalityAddressWithPrecision(
        candidate.query,
        row.municipality,
        fetch,
        requestTimeoutMs,
        geocodeCache
      );

      if (match?.coordinates) {
        return {
          candidate,
          coordinates: match.coordinates,
          locationPrecision: match.locationPrecision
        };
      }
    }
  }

  return { candidate: fallbackCandidate, coordinates: "", locationPrecision: "" };
}

async function geocodeRow(row, geocodeCache, sourceTextCache) {
  const initialCandidates = buildGeocodeCandidates(row);
  const initialResult = await tryGeocodeCandidates(initialCandidates, row, geocodeCache);

  if (initialResult.coordinates) {
    return initialResult;
  }

  const sourceText = await fetchSourceSearchText(row, sourceTextCache);

  if (!sourceText) {
    return initialResult;
  }

  const enrichedCandidates = buildGeocodeCandidates(row, sourceText);
  return tryGeocodeCandidates(enrichedCandidates, row, geocodeCache);
}

async function repairCandidate(row, geocodeCache, sourceTextCache) {
  const geocode = hasCoordinates(row.coordinates)
    ? {
        candidate: {
          kind: "existing-coordinates",
          query: normalizeText(row.address || row.parcel || row.id)
        },
        coordinates: normalizeText(row.coordinates),
        locationPrecision: inferExistingLocationPrecision(row)
      }
    : await geocodeRow(row, geocodeCache, sourceTextCache);

  if (!geocode.coordinates) {
    return {
      id: row.id,
      municipality: row.municipality,
      address: row.address,
      query: geocode.candidate.query,
      kind: geocode.candidate.kind,
      status: "no-geocode"
    };
  }

  const assessment = await assessGeocodeResult(row, geocode);

  if (!assessment) {
    return {
      id: row.id,
      municipality: row.municipality,
      address: row.address,
      query: geocode.candidate.query,
      kind: geocode.candidate.kind,
      status: "no-assessment",
      coordinates: geocode.coordinates,
      locationPrecision: geocode.locationPrecision
    };
  }

  const automatedAssessment = appendAssessment(
    row.automated_assessment,
    buildRepairAssessmentNote(geocode.candidate, assessment)
  );

  return {
    id: row.id,
    municipality: row.municipality,
    address: row.address,
    query: geocode.candidate.query,
    repairAddress: geocode.candidate.repairAddress ?? "",
    repairParcel: geocode.candidate.repairParcel ?? "",
    kind: geocode.candidate.kind,
    status: "ready",
    coordinates: geocode.coordinates,
    locationPrecision: geocode.locationPrecision,
    protectionStatus: assessment.protectionStatus,
    agisMatch: assessment.agisMatch,
    agisLayers: assessment.agisLayers,
    automatedAssessment
  };
}

function applyRepair(db, result) {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `UPDATE applications
     SET coordinates = ?,
         location_precision = ?,
         address = CASE WHEN ? != '' THEN ? ELSE address END,
         parcel = CASE WHEN ? != '' THEN ? ELSE parcel END,
         ambiguous_address = 0,
         protection_status = ?,
         agis_match = ?,
         agis_layers = ?,
         automated_assessment = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    result.coordinates,
    result.locationPrecision,
    result.repairAddress ?? "",
    result.repairAddress ?? "",
    result.repairParcel ?? "",
    result.repairParcel ?? "",
    result.protectionStatus,
    result.agisMatch,
    JSON.stringify(result.agisLayers ?? []),
    result.automatedAssessment,
    updatedAt,
    result.id
  );
}

function normalizeInvalidDeadlines(db) {
  const assessmentNote = "Fristdatum liegt vor Publikationsdatum und muss von Hand geprüft werden.";

  // Nur das ungültige Fristdatum bereinigen und vermerken. Der Schutzstatus
  // bleibt unangetastet, damit ein möglicher Schutztreffer nicht verdeckt wird.
  return db
    .prepare(
      `UPDATE applications
       SET deadline_date = '',
           automated_assessment = CASE
             WHEN IFNULL(automated_assessment, '') = '' THEN ?
             WHEN automated_assessment LIKE '%' || ? || '%' THEN automated_assessment
             ELSE automated_assessment || ' ' || ?
           END,
           updated_at = ?
       WHERE IFNULL(publication_date, '') <> ''
         AND IFNULL(deadline_date, '') <> ''
         AND date(deadline_date) < date(publication_date)`
    )
    .run(assessmentNote, assessmentNote, assessmentNote, new Date().toISOString()).changes;
}

function summarize(results) {
  const summary = {
    mode: apply ? "apply" : "dry-run",
    dbPath,
    scanned: results.length,
    ready: results.filter((result) => result.status === "ready").length,
    applied: apply ? results.filter((result) => result.status === "ready").length : 0,
    noGeocode: results.filter((result) => result.status === "no-geocode").length,
    noAssessment: results.filter((result) => result.status === "no-assessment").length,
    byKind: {},
    byNextStatus: {},
    invalidDeadlinesNormalized: 0
  };

  for (const result of results) {
    summary.byKind[result.kind] = (summary.byKind[result.kind] ?? 0) + 1;
    if (result.status === "ready") {
      summary.byNextStatus[result.protectionStatus] = (summary.byNextStatus[result.protectionStatus] ?? 0) + 1;
    }
  }

  return summary;
}

async function main() {
  if (!existsSync(dbPath)) {
    throw new Error(`Datenbank nicht gefunden: ${dbPath}`);
  }

    const db = new DatabaseSync(dbPath, { readOnly: !apply });
    let backupPath = "";
    let invalidDeadlinesNormalized = 0;

  try {
    if (apply) {
      ensureRepairSchema(db);
      backupPath = backupDatabase(db, dbPath);
      invalidDeadlinesNormalized = normalizeInvalidDeadlines(db) ?? 0;
    }

    const rows = selectCandidates(db);
    const geocodeCache = new Map();
    const sourceTextCache = new Map();
    const results = [];

    for (const row of rows) {
      const result = await repairCandidate(row, geocodeCache, sourceTextCache);
      results.push(result);

      if (apply && result.status === "ready") {
        applyRepair(db, result);
      }
    }

    const summary = {
      ...summarize(results),
      invalidDeadlinesNormalized,
      backupPath,
      examples: results.filter((result) => result.status === "ready").slice(0, Math.max(0, exampleLimit))
    };

    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(apply ? "Repair: Von Hand prüfen angewendet" : "Repair: Von Hand prüfen Dry-Run");
    console.log("DB:", dbPath);
    if (backupPath) console.log("Backup:", backupPath);
    console.log("");
    console.log(`Geprüft:        ${summary.scanned}`);
    console.log(`Bereit:         ${summary.ready}`);
    console.log(`Angewendet:     ${summary.applied}`);
    console.log(`Kein Geocoding: ${summary.noGeocode}`);
    console.log(`Keine AGIS-Bewertung: ${summary.noAssessment}`);
    console.log(`Fristfehler bereinigt: ${summary.invalidDeadlinesNormalized}`);
    console.log("");
    console.log("Nach Status:");
    for (const [status, count] of Object.entries(summary.byNextStatus)) {
      console.log(`  ${String(count).padStart(4)}  ${status}`);
    }
    console.log("");
    console.log("Nach Kandidat:");
    for (const [kind, count] of Object.entries(summary.byKind)) {
      console.log(`  ${String(count).padStart(4)}  ${kind}`);
    }
    if (!apply && summary.ready > 0) {
      console.log("");
      console.log("Zum Anwenden: npm run repair:manual-review -- --apply");
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
