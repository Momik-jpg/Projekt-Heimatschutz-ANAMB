// Amtsblatt-Parser und -Importe
// Teil des Baugesuch-Imports (aus applicationsSyncParsing.js aufgeteilt).
import {
  extractSwissCoordinatesFromText,
  normalizeImportedMunicipalityAddress,
  shortenText
} from "./applicationsSyncAddress.js";
import {
  addDays,
  decodeHtmlEntities,
  fetchWithTimeout,
  mapWithConcurrency,
  normalizeDate,
  normalizeWhitespace,
  resolveOfficialAargauMunicipality,
  streetLikeAddressPattern,
  stripHtml
} from "./applicationsSyncCommon.js";
import {
  geocodeMunicipalityAddress,
  geocodeMunicipalityParcel,
  requestedAddressHasHouseNumber
} from "./applicationsSyncGeocode.js";
import {
  extractDeadlineDateFromText,
  extractPublicationDateFromText,
  normalizeImportedProjectType
} from "./applicationsSyncPublication.js";

// ---------------------------------------------------------------------------
// Amtsblatt des Kantons Aargau (amtsblatt.ag.ch) — kantonsweite Quelle
// Die offizielle, öffentliche Publikationsplattform listet alle Baugesuche
// ("Gemeinden / Bau- und Rodungsgesuche") des Kantons. Die Ergebnisliste wird
// über den AJAX-Endpunkt "resultAjax" seitenweise geladen (ohne cHash) und
// enthält pro Eintrag bereits Stelle (Gemeinde), Rubrik, Titel, Datum und im
// Textkoerper strukturierte Felder (Bauherrschaft | Bauvorhaben | Standort).
// ---------------------------------------------------------------------------
export const amtsblattBaugesuchRubricPattern = /bau-?\s*und\s*rodungsgesuch/i;

// Erkennt Parzellennummern in vielen Schreibweisen: "Parzelle Nr. 1376",
// "Parzellen-Nr. 123", "Parzellen: 155", "Parz. 11", "Kat.-Nr. 7", "GB-Nr 9",
// "Grundstück 276", "Parzelle Hornussen Nr. 689", "Parzelle Nrn. 3733, 3769".
export const amtsblattParcelPattern =
  /\b(?:Parzellen?|Parz|Kat(?:aster)?|GB|Grundst(?:ü|ue)ck)\.?[-:\s]*(?:(?:(?:GB|Grundbuch)\s+)?[\p{L}() .'-]+?\s+)?(?:Nrn?\.?:?[-:\s]*)?(\d{1,6})/iu;

export const defaultAmtsblattMaxPages = Math.max(1, Number(process.env.AMTSBLATT_MAX_PAGES ?? 30));

export const defaultAmtsblattPageBatchSize = Math.min(
  50,
  Math.max(1, Number(process.env.AMTSBLATT_PAGE_BATCH_SIZE ?? 6))
);

// Beim grossen Archiv-Backfill kann die Live-Geokodierung abgeschaltet werden, damit
// tausende Baugesuche schnell und ohne Last-Spitze auf die Behörden-Dienste geladen
// werden. Die Schutzprüfung erfolgt dann später pro Fall.
export const amtsblattGeocodeEnabled = String(process.env.AMTSBLATT_GEOCODE ?? "").toLowerCase() !== "false";

export function isAmtsblattSourceUrl(sourceUrl) {
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
export function matchAmtsblattField(text, label, stopLabels) {
  const stop = stopLabels.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)\\s*(?:\\||${stop}|$)`, "i");
  const match = text.match(pattern);
  return match ? normalizeWhitespace(match[1]) : "";
}

// Body-Felder im Amtsblatt sind durch "|" getrennt und tragen je nach
// Gemeinde unterschiedliche Trenner ("Label: Wert" oder "Label | Wert").
// Diese Funktion liest den Wert zum ersten passenden Label aus beiden Formaten.
export function extractAmtsblattLabeledValue(text, labels) {
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
export function deriveAmtsblattMunicipality(stelle, location) {
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
        "Parzelle / Strasse",
        "Parzelle/Strasse",
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
  let locationPrecision = coordinates ? "precise" : "";

  // Standort an der Baugemeinde geokodieren: zuerst die Strasse, dann die Parzelle.
  if (!coordinates && geocodeFetchImpl && municipality && street) {
    coordinates = await geocodeMunicipalityAddress(street, municipality, geocodeFetchImpl, requestTimeoutMs, geocodeCache);
    if (coordinates) {
      locationPrecision = "precise";
    }
  }

  if (!coordinates && geocodeFetchImpl && municipality && parcel) {
    coordinates = await geocodeMunicipalityParcel(parcel, municipality, geocodeFetchImpl, requestTimeoutMs, geocodeCache);
    if (coordinates) {
      locationPrecision = "precise";
    }
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
    locationPrecision,
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

export function hasAmtsblattGeocodableLocation(entry) {
  const location = String(entry.location ?? "");

  if (extractSwissCoordinatesFromText(location)) {
    return true;
  }

  if ((location.match(amtsblattParcelPattern) ?? [])[1] || entry.parcel) {
    return true;
  }

  const streetSegment = location
    .replace(/\([^)]*\)/g, " ")
    .split(",")
    .map((value) => normalizeWhitespace(value))
    .find((value) => streetLikeAddressPattern.test(value));

  return Boolean(streetSegment && requestedAddressHasHouseNumber(streetSegment));
}

// Wenn die Ergebnisliste den Standort nicht enthält (Text war abgeschnitten),
// die Detailseite des Eintrags nachladen und Standort/Stelle/Bauvorhaben dort lesen.
export async function enrichAmtsblattEntryFromDetail(entry, origin, fetchImpl, requestTimeoutMs) {
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
        "Parzelle / Strasse",
        "Parzelle/Strasse",
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

    const streetMatch = bodyParcel
      ? null
      : detailText.match(
          /([A-ZÄÖÜ][A-Za-zÄÖÜäöüss.-]*(?:strasse|strasse|weg|gasse|platz|allee|ring|rain|halde|steig|matte|acker|feld|quai|ufer)\s*\d{0,4}\s*[a-z]?)/i
        );
    const bodyStreet = streetMatch ? normalizeWhitespace(streetMatch[1]) : "";

    if (!entry.location || !/\d/.test(entry.location)) {
      entry.location = [bodyStreet, bodyParcel ? `Parzelle ${bodyParcel}` : ""].filter(Boolean).join(", ") || entry.location;
    }
  } catch {
    // Detailseite optional; bei Fehler bleibt der Listeneintrag wie er ist.
  }
}

export async function buildAmtsblattImportedItems(
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
        if (geocodeFetchImpl && !hasAmtsblattGeocodableLocation(entry)) {
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
