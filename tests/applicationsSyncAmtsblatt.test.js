import test from "node:test";
import assert from "node:assert/strict";
import {
  isAmtsblattSourceUrl,
  buildAmtsblattResultUrl,
  matchAmtsblattField,
  extractAmtsblattLabeledValue,
  deriveAmtsblattMunicipality,
  parseAmtsblattEntries,
  amtsblattParcelPattern
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
