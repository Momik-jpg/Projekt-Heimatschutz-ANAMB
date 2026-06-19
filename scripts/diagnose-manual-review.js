// Diagnose-Tool: Warum landen Baugesuche in "Von Hand prüfen"?
//
// Liest die SQLite-Datenbank READ-ONLY (keine Migration, kein Seeding, keine
// Schreibzugriffe) und gruppiert alle Fälle mit protection_status =
// 'manual-review' ODER ambiguous_address = 1 nach Ursache. So sieht das Team
// datenbasiert, welche Art von Ortsproblem übrig bleibt. Konkretes
// Automationspotenzial bitte immer mit scripts/repair-manual-review.js
// verifizieren, weil der offizielle Geocoder/Fuzzy-Treffer sonst falsche
// Standortannahmen erzeugen kann.
//
// Aufruf:
//   node scripts/diagnose-manual-review.js
//   DATABASE_PATH=./data/heimatschutz.sqlite node scripts/diagnose-manual-review.js
//   node scripts/diagnose-manual-review.js --json

import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(currentDir);
const dbPath = resolve(process.env.DATABASE_PATH || join(rootDir, "data", "heimatschutz.sqlite"));
const asJson = process.argv.includes("--json");

// Platzhalter-Adressen, die der Importer setzt, wenn er nichts Brauchbares fand.
const addressPlaceholderPattern =
  /^adresse\s+(?:pruefen|prüfen|von\s+(?:webseite|pdf)\s+(?:pruefen|prüfen)|aus\s+amtsblatt\s+(?:pruefen|prüfen))$/i;
const parcelOnlyAddressPattern = /^parzellen?(?:\s+nrn?\.?|\s+nr\.?)?\s+\d{1,6}$/i;
// Eine "starke" Adresse hat einen Strassennamen mit Hausnummer.
const streetWithNumberPattern = /[a-zäöü]{3,}.*\b\d{1,4}[a-z]?\b/i;
const namedAddressWithNumberPattern =
  /\b(?:Am|Im|In der|In den|An der|Auf der|Beim|Bei der|Obere|Untere|Unter|Ober)\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüéèàÉÈÀ.\- ]{2,54}\s+\d{1,4}[A-Za-z]?\b/u;

function hasCoordinates(value) {
  if (!value) return false;
  const parts = String(value)
    .split(",")
    .map((v) => Number(v.trim()));
  return parts.length >= 2 && parts.every((n) => Number.isFinite(n));
}

function isStrongAddress(address) {
  const text = String(address ?? "").trim();
  if (!text || text.length < 5) return false;
  if (addressPlaceholderPattern.test(text)) return false;
  if (parcelOnlyAddressPattern.test(text)) return false;
  return streetWithNumberPattern.test(text) || namedAddressWithNumberPattern.test(text);
}

function classify(row) {
  const coords = hasCoordinates(row.coordinates);
  const strongAddress = isStrongAddress(row.address);
  const hasParcel = Boolean(String(row.parcel ?? "").trim());
  const parcelOnlyAddress = parcelOnlyAddressPattern.test(String(row.address ?? "").trim());
  const hasAnyAddress =
    Boolean(String(row.address ?? "").trim()) && !addressPlaceholderPattern.test(String(row.address ?? "").trim());

  if (coords) {
    // Koordinaten vorhanden, aber der Status ist weiterhin Hand-Prüfung. Das
    // ist meistens ein bewusst unscharfer Strassen-Treffer in Schutz-Nähe und
    // darf nicht als sicher entfernbar gezählt werden.
    return { reason: "has-coords", fixable: false };
  }
  if (hasParcel && parcelOnlyAddress) {
    return { reason: "parcel-only", fixable: true };
  }
  if (strongAddress) {
    return { reason: "address-strong-no-coords", fixable: false };
  }
  if (hasParcel) {
    return { reason: "parcel-only", fixable: true };
  }
  if (hasAnyAddress) {
    return { reason: "address-weak", fixable: false };
  }
  return { reason: "no-location", fixable: false };
}

const reasonLabels = {
  "has-coords": "Hat Koordinaten, bleibt aber wegen unscharfer Lage/Schutz-Nähe manuell",
  "address-strong-no-coords": "Strasse+Nr. vorhanden, aber kein sicherer Geocoding-Treffer",
  "parcel-only": "Nur Parzelle (keine Strasse+Nr.)  -> Parzellen-Geocoding (geo.admin)",
  "address-weak": "Adresse unklar/unvollständig oder Infrastruktur-Standort",
  "no-location": "Keine verwertbare Ortsangabe  -> nicht automatisierbar, echte Prüfung"
};

function main() {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    console.error(`Konnte die Datenbank nicht read-only öffnen: ${dbPath}\n${error.message}`);
    process.exit(1);
  }

  const total = db.prepare("SELECT COUNT(*) AS n FROM applications").get().n;
  const rows = db
    .prepare(
      `SELECT id, municipality, address, parcel, coordinates, protection_status, ambiguous_address, automated_assessment
       FROM applications
       WHERE protection_status = 'manual-review' OR ambiguous_address = 1`
    )
    .all();
  db.close();

  const buckets = new Map();
  let fixable = 0;
  const items = rows.map((row) => {
    const c = classify(row);
    buckets.set(c.reason, (buckets.get(c.reason) ?? 0) + 1);
    if (c.fixable) fixable += 1;
    return { ...row, ...c };
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          dbPath,
          total,
          manualReview: rows.length,
          conservativeAutomationPotential: fixable,
          reasons: Object.fromEntries(buckets),
          items: items.map((i) => ({
            id: i.id,
            municipality: i.municipality,
            address: i.address,
            parcel: i.parcel,
            hasCoords: hasCoordinates(i.coordinates),
            reason: i.reason,
            fixable: i.fixable
          }))
        },
        null,
        2
      )
    );
    return;
  }

  const pct = (n) => (total ? `${Math.round((n / total) * 1000) / 10}%` : "0%");
  console.log("Diagnose: Von Hand prüfen");
  console.log("DB:", dbPath);
  console.log("");
  console.log(`Baugesuche gesamt:     ${total}`);
  console.log(`In Hand-Prüfung:      ${rows.length}  (${pct(rows.length)})`);
  console.log(`Konservativ automatisch entfernbar: ${fixable} von ${rows.length}`);
  console.log("");
  console.log("Gründe:");
  for (const [reason, label] of Object.entries(reasonLabels)) {
    const n = buckets.get(reason) ?? 0;
    if (n > 0) console.log(`  ${String(n).padStart(4)}  ${label}`);
  }

  if (items.length) {
    console.log("");
    console.log("Fälle (max. 25):");
    console.log("  ID            Gemeinde            Adresse / Parzelle");
    for (const i of items.slice(0, 25)) {
      const loc = String(i.parcel ?? "").trim() && !isStrongAddress(i.address)
          ? `Parzelle ${i.parcel}`
          : i.address || "(leer)";
      console.log(
        `  ${String(i.id).padEnd(13)} ${String(i.municipality ?? "").slice(0, 18).padEnd(18)} ${String(loc).slice(0, 40)}`
      );
    }
  }
}

main();
