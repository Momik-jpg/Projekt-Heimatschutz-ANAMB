#!/usr/bin/env node

const args = new Map();

for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];

  if (!value.startsWith("--")) {
    continue;
  }

  const [key, inlineValue] = value.slice(2).split("=");
  const nextValue = inlineValue ?? process.argv[index + 1];
  args.set(key, nextValue);

  if (inlineValue === undefined) {
    index += 1;
  }
}

process.env.AMTSBLATT_MAX_PAGES = args.get("pages") ?? process.env.AMTSBLATT_MAX_PAGES ?? "3000";
process.env.AMTSBLATT_PAGE_BATCH_SIZE = args.get("batch-size") ?? process.env.AMTSBLATT_PAGE_BATCH_SIZE ?? "12";
process.env.AMTSBLATT_GEOCODE = args.get("geocode") ?? process.env.AMTSBLATT_GEOCODE ?? "false";
process.env.AUTO_SYNC_ENABLED = "false";

const sourceUrl = args.get("source-url") ?? "https://amtsblatt.ag.ch/publikationen/";
const requestTimeoutMs = Number(args.get("timeout-ms") ?? process.env.SYNC_REQUEST_TIMEOUT_MS ?? 20000);
const startedAt = Date.now();
let requestCount = 0;
let highestPage = 0;
let importedCount = 0;
let updatedCount = 0;
let skippedCount = 0;
let failedPages = 0;
let rawPublicationCount = 0;

function formatElapsed() {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        html: "",
        status: response.status
      };
    }

    return {
      ok: true,
      html: await response.text(),
      status: response.status
    };
  } finally {
    clearTimeout(timer);
  }
}

const [
  { createDatabase },
  { createApplicationsRepository },
  { buildAmtsblattItemFromEntry, buildAmtsblattResultUrl, parseAmtsblattEntries }
] = await Promise.all([
  import("../server/db.js"),
  import("../server/repository/applicationsRepository.js"),
  import("../server/services/applicationsSyncService.js")
]);

const db = createDatabase();
const repository = createApplicationsRepository(db);
const beforeTotal = db.prepare("SELECT COUNT(*) AS count FROM applications").get().count;

console.log(`Amtsblatt-Backfill startet ${new Date().toLocaleTimeString("de-CH")}...`);
console.log(
  `Quelle: ${sourceUrl} | max. Seiten: ${process.env.AMTSBLATT_MAX_PAGES} | Batch: ${process.env.AMTSBLATT_PAGE_BATCH_SIZE} | Geocoding: ${process.env.AMTSBLATT_GEOCODE}`
);
console.log(`DB vorher: ${beforeTotal}`);

try {
  const maxPages = Number(process.env.AMTSBLATT_MAX_PAGES);
  const batchSize = Number(process.env.AMTSBLATT_PAGE_BATCH_SIZE);
  const origin = new URL(sourceUrl).origin;
  const geocodeCache = new Map();
  const seenReferences = new Set();
  let reachedEnd = false;

  for (let start = 1; start <= maxPages && !reachedEnd; start += batchSize) {
    const pageNumbers = [];

    for (let page = start; page < start + batchSize && page <= maxPages; page += 1) {
      pageNumbers.push(page);
    }

    const fetched = await Promise.all(
      pageNumbers.map(async (page) => {
        const url = buildAmtsblattResultUrl(sourceUrl, page);
        requestCount += 1;
        highestPage = Math.max(highestPage, page);

        try {
          const response = await fetchTextWithTimeout(url, requestTimeoutMs);
          const count = (response.html.match(/publication-list__item--publication/g) ?? []).length;
          return { page, ...response, count };
        } catch (error) {
          return { page, ok: false, html: "", count: 0, status: error.name ?? "error" };
        }
      })
    );

    fetched.sort((a, b) => a.page - b.page);

    const batchItems = [];
    let batchRawPublications = 0;
    let batchParsedEntries = 0;

    for (const result of fetched) {
      if (result.ok && result.count === 0) {
        reachedEnd = true;
        break;
      }

      if (!result.ok) {
        failedPages += 1;
        continue;
      }

      rawPublicationCount += result.count;
      batchRawPublications += result.count;

      for (const entry of parseAmtsblattEntries(result.html)) {
        batchParsedEntries += 1;
        const reference = `amtsblatt:${entry.detailPath}`;

        if (seenReferences.has(reference)) {
          continue;
        }

        seenReferences.add(reference);
        batchItems.push(
          await buildAmtsblattItemFromEntry(
            entry,
            origin,
            sourceUrl,
            process.env.AMTSBLATT_GEOCODE === "false" ? null : fetch,
            requestTimeoutMs,
            geocodeCache
          )
        );
      }
    }

    if (batchItems.length) {
      const importResult = repository.importItems(batchItems, new Date().toISOString());
      importedCount += importResult.importedCount;
      updatedCount += importResult.updatedCount;
    }

    skippedCount += Math.max(0, batchRawPublications - batchParsedEntries);

    const afterBatchTotal = db.prepare("SELECT COUNT(*) AS count FROM applications").get().count;
    console.log(
      `[${new Date().toLocaleTimeString("de-CH")}] Seiten ${pageNumbers[0]}-${pageNumbers.at(-1)} | Publikationen ${batchRawPublications} | Baugesuche ${batchItems.length} | neu ${importedCount} | aktualisiert ${updatedCount} | DB ${afterBatchTotal} | Laufzeit ${formatElapsed()}`
    );

    if (reachedEnd) {
      console.log(`Archiv-Ende erreicht bei Seite ${highestPage}.`);
    }
  }

  const afterTotal = db.prepare("SELECT COUNT(*) AS count FROM applications").get().count;
  const amtsblattTotal = db
    .prepare("SELECT COUNT(*) AS count FROM applications WHERE source = 'Amtsblatt Aargau'")
    .get().count;
  const dateRange = db
    .prepare(
      "SELECT MIN(publication_date) AS minDate, MAX(publication_date) AS maxDate FROM applications WHERE source = 'Amtsblatt Aargau'"
    )
    .get();

  console.log(
    `[${new Date().toLocaleTimeString("de-CH")}] Seitenabrufe: ${requestCount}, hoechste Seite: ${highestPage}, Laufzeit: ${formatElapsed()}`
  );
  console.log("Amtsblatt-Backfill fertig.");
  console.log(`Neu: ${importedCount}, aktualisiert: ${updatedCount}, uebersprungen: ${skippedCount}, fehlgeschlagene Seiten: ${failedPages}`);
  console.log(`Roh-Publikationen gelesen: ${rawPublicationCount}`);
  console.log(`DB nachher: ${afterTotal} total, Amtsblatt: ${amtsblattTotal}`);
  console.log(`Amtsblatt-Zeitraum: ${dateRange.minDate ?? "-"} bis ${dateRange.maxDate ?? "-"}`);
} finally {
  db.close();
}
