import test from "node:test";
import assert from "node:assert/strict";
import {
  isAmtsblattSourceUrl,
  buildAmtsblattResultUrl,
  matchAmtsblattField,
  extractAmtsblattLabeledValue,
  deriveAmtsblattMunicipality,
  parseAmtsblattEntries,
  amtsblattParcelPattern,
  buildAmtsblattItemFromEntry,
  hasAmtsblattGeocodableLocation
} from "../server/services/applicationsSyncAmtsblatt.js";

test("isAmtsblattSourceUrl", () => {
  assert.equal(isAmtsblattSourceUrl("https://amtsblatt.ag.ch/publikationen/"), true);
  assert.equal(isAmtsblattSourceUrl("https://sub.amtsblatt.ag.ch/x"), true);
  assert.equal(isAmtsblattSourceUrl("https://example.com"), false);
  assert.equal(isAmtsblattSourceUrl("kein url"), false);
});

test("buildAmtsblattResultUrl setzt Seite und Kategorie", () => {
  const url = new URL(buildAmtsblattResultUrl("https://amtsblatt.ag.ch/publikationen/", 3));
  assert.equal(url.origin, "https://amtsblatt.ag.ch");
  assert.equal(url.searchParams.get("page"), "3");
  assert.equal(url.searchParams.get("filter[category][]"), "190");
  assert.equal(url.searchParams.get("tx_diamcore_publicationsearchresult[action]"), "resultAjax");
});

test("matchAmtsblattField (lazy bis zum naechsten Label)", () => {
  const text = "Rubrik: Bau- und Rodungsgesuch Bauherrschaft: Muster AG";
  assert.equal(matchAmtsblattField(text, "Rubrik", ["Bauherrschaft", "Bauvorhaben"]), "Bau- und Rodungsgesuch");
});

test("extractAmtsblattLabeledValue (| und ; getrennt)", () => {
  const text = "Bauvorhaben: Neubau | Standort: Hauptstrasse 15, 5400 Baden";
  assert.equal(extractAmtsblattLabeledValue(text, ["Bauvorhaben"]), "Neubau");
  assert.equal(extractAmtsblattLabeledValue(text, ["Standort"]), "Hauptstrasse 15, 5400 Baden");
  assert.equal(extractAmtsblattLabeledValue(text, ["Bauherrschaft"]), "");
});

test("deriveAmtsblattMunicipality (Stelle bevorzugt, sonst Ort aus Standort)", () => {
  assert.equal(deriveAmtsblattMunicipality("Gemeinde Baden", ""), "Baden");
  assert.equal(deriveAmtsblattMunicipality("", "Hauptstrasse 5, 5000 Aarau"), "Aarau");
  assert.equal(deriveAmtsblattMunicipality("", ""), "");
});

test("amtsblattParcelPattern erkennt Parzellennummern", () => {
  assert.equal("Parzelle Nr. 1376".match(amtsblattParcelPattern)?.[1], "1376");
  assert.equal("Kat.-Nr. 7".match(amtsblattParcelPattern)?.[1], "7");
});

test("parseAmtsblattEntries: Baugesuch-Block wird erkannt, anderer ignoriert", () => {
  const baugesuch =
    '<li class="publication-list__item--publication" data-detailurl="https://amtsblatt.ag.ch/p/123/publikation/">' +
    '<a class="publication-summary__title">Baugesuch in Baden</a>' +
    '<span class="box-publication-date">01.02.2026</span>' +
    "<div>Stelle: Gemeinde Baden | Rubrik: Bau- und Rodungsgesuch | Bauvorhaben: Neubau | Standort: Hauptstrasse 15, 5400 Baden</div>" +
    "</li>";
  const entries = parseAmtsblattEntries(`<ul>${baugesuch}</ul>`);
  assert.equal(entries.length, 1);
  assert.match(entries[0].title, /Baden/);
  assert.ok(entries[0].publicationDate);
  assert.match(entries[0].location, /Hauptstrasse 15/);

  const andere =
    '<li class="publication-list__item--publication" data-detailurl="https://amtsblatt.ag.ch/p/9/publikation/">' +
    '<a class="publication-summary__title">Gemeindeversammlung</a>' +
    "<div>Rubrik: Mitteilung | Traktanden: Budget</div></li>";
  assert.deepEqual(parseAmtsblattEntries(`<ul>${andere}</ul>`), []);
  assert.deepEqual(parseAmtsblattEntries(""), []);
});

test("buildAmtsblattItemFromEntry: belegte Frist -> explicit, Adresse aus Feld", async () => {
  const entry = {
    stelle: "Gemeinde Aarau",
    location: "Hauptstrasse 12 (Parzelle 345)",
    bauvorhaben: "Neubau Mehrfamilienhaus",
    title: "Bau- und Rodungsgesuch",
    publicationDate: "2026-06-01",
    bodyText: "Bauherrschaft Muster. Einsprachefrist bis 15.07.2026.",
    detailPath: "/eintrag/1"
  };
  const item = await buildAmtsblattItemFromEntry(entry, "https://amtsblatt.ag.ch", "https://amtsblatt.ag.ch/p/", null, 1000, new Map());
  assert.equal(item.municipality, "Aarau");
  assert.equal(item.address, "Hauptstrasse 12");
  assert.equal(item.parcel, "345");
  assert.equal(item.deadlineDate, "2026-07-15");
  assert.equal(item.deadlineProvenance, "explicit");
  assert.equal(item.addressProvenance, "official-field");
  assert.equal(item.protectionStatus, "manual-review", "ohne Geocoding -> manuelle Pruefung");
  assert.equal(item.ambiguousAddress, 1);
});

test("buildAmtsblattItemFromEntry: fehlende Frist -> missing, keine erfundene Frist", async () => {
  const item = await buildAmtsblattItemFromEntry(
    { stelle: "Gemeinde Aarau", location: "", bauvorhaben: "Umbau", title: "x", publicationDate: "", bodyText: "kein Datum", detailPath: "/e/2" },
    "https://amtsblatt.ag.ch",
    "https://amtsblatt.ag.ch/p/",
    null,
    1000,
    new Map()
  );
  assert.equal(item.deadlineDate, "");
  assert.equal(item.deadlineProvenance, "missing");
  assert.equal(item.address, "Adresse aus Amtsblatt prüfen");
  assert.equal(item.addressProvenance, "fallback");
  assert.match(item.automatedAssessment, /Frist fehlt/);
});

test("hasAmtsblattGeocodableLocation: Parzelle/Strasse ja, sonst nein", () => {
  assert.equal(hasAmtsblattGeocodableLocation({ location: "Hauptstrasse 12 (Parzelle 345)" }), true);
  assert.equal(hasAmtsblattGeocodableLocation({ location: "Dorfweg 5" }), true);
  assert.equal(hasAmtsblattGeocodableLocation({ location: "kein ort" }), false);
});

test("buildAmtsblattItemFromEntry: mit Geocoding -> no-hit und Koordinaten", async () => {
  const geo = async () =>
    new Response(
      JSON.stringify({ results: [{ attrs: { label: "Hauptstrasse 12 5000 Aarau", x: 2645000, y: 1249000, origin: "address" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  geo.skipSsrfValidation = true;
  const item = await buildAmtsblattItemFromEntry(
    { stelle: "Gemeinde Aarau", location: "Hauptstrasse 12", bauvorhaben: "Neubau", title: "x", publicationDate: "2026-06-01", bodyText: "Frist bis 15.07.2026", detailPath: "/e/9" },
    "https://amtsblatt.ag.ch",
    "https://amtsblatt.ag.ch/p/",
    geo,
    1000,
    new Map()
  );
  assert.equal(item.coordinates, "2645000,1249000");
  assert.equal(item.protectionStatus, "no-hit");
  assert.equal(item.ambiguousAddress, 0);
});
