import test from "node:test";
import assert from "node:assert/strict";
import {
  aargauMunicipalityNames,
  aargauMunicipalities,
  aargauMunicipalitySources,
  aargauPublicationSources,
  aargauMunicipalitySourceLinks,
  amtsblattFallbackMunicipalities
} from "../server/seed/municipalitySources.js";

// Diese Tests schreiben die Abdeckungs-Garantien als regressionsgeschützte
// Invarianten fest: das kantonsweite Amtsblatt-Sicherheitsnetz, dass jede
// Gemeinde mindestens eine aktive Quelle hat, und dass das Amtsblatt-Fallback-Set
// wirksam (und tippfehlerfrei) ist. So bleibt "keine Gemeinde unabgedeckt" wahr,
// auch wenn der Seed später angepasst wird.

const AMTSBLATT_SUPPLEMENTAL_ID = "PUB-SHARED-AMTSBLATT-AARGAU";
const AGIS_SUPPLEMENTAL_ID = "PUB-SHARED-AGIS-BAUGESUCHE";

const sourceNameById = new Map(aargauPublicationSources.map((source) => [source.id, source.name]));
const municipalityIdByName = new Map(aargauMunicipalities.map((entry) => [entry.name, entry.id]));

const linksByMunicipalityId = new Map();
for (const link of aargauMunicipalitySourceLinks) {
  if (!linksByMunicipalityId.has(link.municipalityId)) {
    linksByMunicipalityId.set(link.municipalityId, []);
  }
  linksByMunicipalityId.get(link.municipalityId).push(link);
}

function primarySourceNameFor(municipalityName) {
  const municipalityId = municipalityIdByName.get(municipalityName);
  const links = linksByMunicipalityId.get(municipalityId) ?? [];
  const primary = links.find((link) => link.relationType === "primary");
  return primary ? sourceNameById.get(primary.sourceId) ?? "" : "";
}

test("jede Aargauer Gemeinde hat das Amtsblatt als aktivierte Zusatzquelle (Sicherheitsnetz)", () => {
  const ohneAmtsblatt = [];
  for (const municipality of aargauMunicipalities) {
    const links = linksByMunicipalityId.get(municipality.id) ?? [];
    const amtsblatt = links.find(
      (link) =>
        link.sourceId === AMTSBLATT_SUPPLEMENTAL_ID &&
        link.relationType === "supplemental" &&
        Boolean(link.enabled)
    );
    if (!amtsblatt) {
      ohneAmtsblatt.push(municipality.name);
    }
  }
  assert.deepEqual(ohneAmtsblatt, [], "Diese Gemeinden haben kein aktives Amtsblatt-Sicherheitsnetz");
});

test("jede Aargauer Gemeinde hat AGIS als aktivierte Zusatzquelle", () => {
  const ohneAgis = [];
  for (const municipality of aargauMunicipalities) {
    const links = linksByMunicipalityId.get(municipality.id) ?? [];
    const agis = links.find((link) => link.sourceId === AGIS_SUPPLEMENTAL_ID && Boolean(link.enabled));
    if (!agis) {
      ohneAgis.push(municipality.name);
    }
  }
  assert.deepEqual(ohneAgis, [], "Diese Gemeinden haben keine aktive AGIS-Zusatzquelle");
});

test("jede Aargauer Gemeinde hat mindestens eine aktivierte Quelle (keine ist dunkel)", () => {
  const dunkel = [];
  for (const municipality of aargauMunicipalities) {
    const links = linksByMunicipalityId.get(municipality.id) ?? [];
    if (!links.some((link) => Boolean(link.enabled))) {
      dunkel.push(municipality.name);
    }
  }
  assert.deepEqual(dunkel, []);
});

test("Katalog deckt alle bekannten Gemeinden ab (Anzahl stimmt)", () => {
  assert.equal(aargauMunicipalities.length, aargauMunicipalityNames.length);
  assert.equal(aargauMunicipalitySources.length, aargauMunicipalityNames.length);
});

test("amtsblattFallbackMunicipalities enthält nur echte Aargauer Gemeinden (Tippfehler-Schutz)", () => {
  const bekannt = new Set(aargauMunicipalityNames);
  const unbekannt = [...amtsblattFallbackMunicipalities].filter((name) => !bekannt.has(name));
  assert.deepEqual(unbekannt, [], "Diese Fallback-Namen existieren nicht und würden still ins Leere laufen");
});

test("jede Fallback-Gemeinde nutzt tatsächlich das Amtsblatt als Primärquelle", () => {
  assert.ok(amtsblattFallbackMunicipalities.size > 0, "Fallback-Set darf nicht leer sein");
  const nichtAmtsblatt = [];
  for (const name of amtsblattFallbackMunicipalities) {
    if (primarySourceNameFor(name) !== "Amtsblatt Aargau") {
      nichtAmtsblatt.push(`${name} -> ${primarySourceNameFor(name) || "(keine Primärquelle)"}`);
    }
  }
  assert.deepEqual(nichtAmtsblatt, [], "Fallback-Override hat bei diesen Gemeinden nicht gegriffen");
});

test("operative Quelle der Fallback-Gemeinden zeigt aufs Amtsblatt und ist aktiviert", () => {
  const operativeByName = new Map(aargauMunicipalitySources.map((source) => [source.municipality, source]));
  const abweichend = [];
  for (const name of amtsblattFallbackMunicipalities) {
    const source = operativeByName.get(name);
    if (!source || !/amtsblatt\.ag\.ch/i.test(source.sourceUrl ?? "") || !source.enabled) {
      abweichend.push(name);
    }
  }
  assert.deepEqual(abweichend, [], "Operative Quelle dieser Fallback-Gemeinden ist nicht das aktivierte Amtsblatt");
});

test("Besenbüren nutzt keine geschützte Gemeinde-Primärquelle mehr", () => {
  assert.ok(amtsblattFallbackMunicipalities.has("Besenbüren"));
  assert.equal(primarySourceNameFor("Besenbüren"), "Amtsblatt Aargau");

  const source = new Map(aargauMunicipalitySources.map((entry) => [entry.municipality, entry])).get("Besenbüren");
  assert.equal(source?.sourceUrl, "https://amtsblatt.ag.ch/publikationen/");
  assert.doesNotMatch(source?.sourceUrl ?? "", /besenbueren\.ch/i);
});
