// Geocoding (Swiss LV95) für Adressen und Parzellen
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  addressPlaceholderPattern,
  clearlyNonAddressPattern,
  coarseGeocoderOrigins,
  defaultSwissGeocoderUrl,
  fetchWithTimeout,
  houseNumberAddressPattern,
  normalizeText,
  normalizeWhitespace,
  parcelLikeAddressPattern,
  projectLikeAddressPattern,
  standaloneHouseNumberPattern,
  streetLikeAddressPattern,
  swissDateLikePatternSource
} from "./applicationsSyncCommon.js";

export function buildSwissGeocodeQueryUrl(address, municipality) {
  const queryMunicipality = normalizeSwissGeocodeMunicipalityName(municipality);
  // geo.admin SearchServer findet deutlich mehr echte Adressen ohne den Zusatz
  // ", Aargau, Schweiz" - dieser Zusatz erzeugte regelmaessig 0 Treffer. Die
  // Gemeinde bleibt als Praezisierung; die Trefferpruefung filtert Fremdorte.
  const query = `${address}, ${queryMunicipality}`;
  const url = new URL(defaultSwissGeocoderUrl);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "address,parcel");
  url.searchParams.set("searchText", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("sr", "2056");
  return url.toString();
}

export function normalizeSwissGeocodeMunicipalityName(municipality) {
  return String(municipality ?? "")
    .replace(/\(AG\)/gi, " AG")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatLv95Coordinates(firstValue, secondValue) {
  const first = Number(firstValue);
  const second = Number(secondValue);

  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return "";
  }

  const firstLooksEast = first >= 2400000 && first <= 2900000;
  const firstLooksNorth = first >= 1000000 && first <= 1400000;
  const secondLooksEast = second >= 2400000 && second <= 2900000;
  const secondLooksNorth = second >= 1000000 && second <= 1400000;

  if (firstLooksEast && secondLooksNorth) {
    return `${first},${second}`;
  }

  if (firstLooksNorth && secondLooksEast) {
    return `${second},${first}`;
  }

  return `${first},${second}`;
}

// Wortschnipsel, die nie ein Strassenname sind. Sie werden bei der
// Strassen-Erkennung ignoriert, damit z. B. "Bauplatz: Dorfstrasse" die
// Strasse "Dorfstrasse" liefert und nicht das Label "Bauplatz".
export const geocodeStreetStopwords = new Set([
  "adresse", "aus", "amtsblatt", "pruefen", "lage", "bauplatz", "baustelle",
  "standort", "bauobjekt", "bauvorhaben", "bauherr", "bauherrschaft", "neubau",
  "umbau", "abbruch", "anbau", "ersatzneubau", "sanierung", "gartengestaltung",
  "garten", "umnutzung", "parzelle", "parzellen", "gemeinde", "schweiz",
  "aargau", "kanton", "zone", "frist", "der", "die", "das", "und", "von",
  "ueber", "mit", "fuer", "den", "dem", "ohne", "sowie", "objekt", "projekt"
]);

export function geocodeLocalityTokens(text) {
  return String(text ?? "")
    .split(/\s+/)
    .map((word) => looseMunicipalityToken(word))
    .filter(Boolean);
}

// Gleicht die gewuenschte Gemeinde gegen Label UND amtliches "detail"-Feld ab.
// Das detail-Feld enthaelt die politische Gemeinde in ue/oe/ae-Schreibweise
// (z. B. "... 4008 kuettigen ch ag"), waehrend das Label oft nur den Postort
// zeigt (z. B. "Rombach"). So werden korrekte Treffer in Ortsteilen,
// fusionierten und "(AG)"-Gemeinden nicht mehr faelschlich verworfen.
export function geocodeCandidateMunicipalityMatches(municipality, haystack) {
  const wanted = looseMunicipalityToken(municipality);

  if (!wanted) {
    return true;
  }

  if (geocodeLocalityTokens(haystack).includes(wanted)) {
    return true;
  }

  // Mehrwort-Gemeinden (z. B. "Beinwil am See" -> "beinwilamsee") als
  // zusammenhaengenden Token zulassen; kurze Namen brauchen einen exakten
  // Token-Treffer, damit "Birr" nicht auf "Birrhard" matcht.
  return wanted.length >= 8 && looseMunicipalityToken(haystack).includes(wanted);
}

// Hauptsaechlicher Strassen-Token der gewuenschten Adresse (laengstes
// aussagekraeftiges Wort, Strassen-Suffixe bevorzugt). Dient als
// Sicherheitsnetz gegen Fuzzy-Treffer von geo.admin, die zwar in der richtigen
// Gemeinde, aber an der falschen Strasse liegen (z. B. Seckistrasse -> Juchweg).
export function extractGeocodeStreetToken(address) {
  const entries = normalizeWhitespace(address)
    .replace(/[.,;:/()]/g, " ")
    .split(/\s+/)
    .map((word) => ({ raw: word, token: looseMunicipalityToken(word) }))
    .filter(
      (entry) =>
        /[A-Za-zÄÖÜäöü]/.test(entry.raw) &&
        entry.token.length >= 4 &&
        !geocodeStreetStopwords.has(entry.token)
    );
  const suffixed = entries.filter((entry) => streetLikeAddressPattern.test(entry.raw));
  const pool = suffixed.length ? suffixed : entries;
  return pool.map((entry) => entry.token).sort((left, right) => right.length - left.length)[0] ?? "";
}

export function extractGeocodeParcelToken(address) {
  const match = normalizeWhitespace(address).match(/^Parzellen?\s+(?:Nrn?\.?\s+)?(\d{1,6})$/i);
  return match ? match[1] : "";
}

// Strasse OHNE Hausnummer ("Hafenstrasse", "Zuercherstrasse") ist nur ortsgenau:
// geo.admin liefert dann irgendein Haus der Strasse. Solche Treffer gelten als
// "approximate", damit die AGIS-Bewertung den 250-m-Schutzradius anwendet und kein
// falscher "kein Schutz"-Befund an einem zufaelligen Punkt entsteht.
export function requestedAddressHasHouseNumber(address) {
  const text = normalizeWhitespace(address)
    .replace(new RegExp(swissDateLikePatternSource, "gi"), " ")
    .replace(/\b\d{4,}\b/g, " ");
  return /\b\d{1,3}\s?[a-z]?\b/i.test(text);
}

// Verlangt, dass der Treffer wirklich zur gesuchten Strasse bzw. Parzelle passt.
// Ohne erkennbare Strasse/Parzelle wird kein Treffer akzeptiert, statt blind die
// erste Adresse der Gemeinde zu uebernehmen.
export function geocodeCandidateLocationMatches(haystack, { streetToken, parcelToken }) {
  if (parcelToken) {
    const numericTokens = String(haystack)
      .split(/\s+/)
      .map((word) => word.replace(/\D/g, ""))
      .filter(Boolean);

    if (numericTokens.includes(parcelToken)) {
      return true;
    }
  }

  if (streetToken) {
    if (streetToken.length >= 6) {
      return looseMunicipalityToken(haystack).includes(streetToken);
    }

    return geocodeLocalityTokens(haystack).includes(streetToken);
  }

  return false;
}

export function extractSwissCoordinateMatchFromGeocoderPayload(
  payload,
  municipality,
  { allowApproximate = false, requestedAddress = "" } = {}
) {
  const candidates = [
    ...(Array.isArray(payload?.results) ? payload.results : []),
    ...(Array.isArray(payload?.features) ? payload.features : [])
  ];
  const streetToken = extractGeocodeStreetToken(requestedAddress);
  const parcelToken = extractGeocodeParcelToken(requestedAddress);
  let approximateMatch = null;

  for (const candidate of candidates) {
    const attrs = candidate?.attrs ?? candidate?.properties ?? {};
    const origin = normalizeText(attrs.origin ?? attrs.featureId ?? "");
    const isApproximate = origin && coarseGeocoderOrigins.has(origin);

    const haystack = [
      candidate?.label,
      attrs.label,
      attrs.detail,
      attrs.municipality,
      attrs.gemeinde,
      attrs.text
    ]
      .filter(Boolean)
      .join(" ");

    if (!geocodeCandidateMunicipalityMatches(municipality, haystack)) {
      continue;
    }

    if (!geocodeCandidateLocationMatches(haystack, { streetToken, parcelToken })) {
      continue;
    }

    let coordinates = "";
    const geometryCoordinates = candidate?.geometry?.coordinates;

    if (Array.isArray(geometryCoordinates) && geometryCoordinates.length >= 2) {
      const [east, north] = geometryCoordinates.map((value) => Number(value));

      if (Number.isFinite(east) && Number.isFinite(north)) {
        coordinates = formatLv95Coordinates(east, north);
      }
    }

    if (!coordinates) {
      const east = Number(attrs.x ?? attrs.easting ?? attrs.east ?? candidate?.x);
      const north = Number(attrs.y ?? attrs.northing ?? attrs.north ?? candidate?.y);

      if (Number.isFinite(east) && Number.isFinite(north)) {
        coordinates = formatLv95Coordinates(east, north);
      }
    }

    if (!coordinates) {
      continue;
    }

    const isPrecise = !isApproximate && (Boolean(parcelToken) || requestedAddressHasHouseNumber(requestedAddress));

    if (!isPrecise) {
      if (allowApproximate && !approximateMatch) {
        approximateMatch = {
          coordinates,
          locationPrecision: "approximate"
        };
      }

      continue;
    }

    return {
      coordinates,
      locationPrecision: "precise"
    };
  }

  return approximateMatch;
}

export function canQueryMunicipalityAddressGeocode(address) {
  return (
    streetLikeAddressPattern.test(address) ||
    parcelLikeAddressPattern.test(address) ||
    houseNumberAddressPattern.test(address)
  );
}

export function shouldAttemptMunicipalityAddressGeocode(address) {
  const text = normalizeWhitespace(address);

  if (!text || addressPlaceholderPattern.test(text) || standaloneHouseNumberPattern.test(text)) {
    return false;
  }

  if (parcelLikeAddressPattern.test(text)) {
    return true;
  }

  if (projectLikeAddressPattern.test(text) || clearlyNonAddressPattern.test(text)) {
    return false;
  }

  return canQueryMunicipalityAddressGeocode(text);
}

export async function fetchMunicipalityAddressGeocodeMatch(address, municipality, fetchImpl, requestTimeoutMs, cache) {
  if (!fetchImpl || !address || !municipality || !canQueryMunicipalityAddressGeocode(address)) {
    return null;
  }

  const cacheKey = `address-geocode-match::${municipality}::${address}`;

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
      return null;
    }

    const payload = await response.json();
    return extractSwissCoordinateMatchFromGeocoderPayload(payload, municipality, {
      allowApproximate: true,
      requestedAddress: address
    });
  })().catch(() => null);

  cache.set(cacheKey, pending);
  return pending;
}
export async function geocodeMunicipalityAddressWithPrecision(address, municipality, fetchImpl, requestTimeoutMs, cache) {
  if (!shouldAttemptMunicipalityAddressGeocode(address)) {
    return null;
  }

  return fetchMunicipalityAddressGeocodeMatch(address, municipality, fetchImpl, requestTimeoutMs, cache);
}

export async function geocodeMunicipalityAddress(address, municipality, fetchImpl, requestTimeoutMs, cache) {
  const match = await fetchMunicipalityAddressGeocodeMatch(address, municipality, fetchImpl, requestTimeoutMs, cache);

  // Grobe Treffer bleiben für bestehende string-only-Aufrufer unsichtbar.
  return match?.locationPrecision === "precise" ? match.coordinates : "";
}

export function looseMunicipalityToken(value) {
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
export async function geocodeMunicipalityParcel(parcelNumber, municipality, fetchImpl, requestTimeoutMs, cache) {
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
    url.searchParams.set("searchText", `${normalizeSwissGeocodeMunicipalityName(municipality)} ${parcelNumber}`);
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
        return formatLv95Coordinates(x, y);
      }
    }

    return "";
  })().catch(() => "");

  cache.set(cacheKey, pending);
  return pending;
}
