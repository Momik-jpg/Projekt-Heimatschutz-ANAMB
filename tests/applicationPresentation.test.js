import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProjectScale,
  getApplicationRegion
} from "../server/domain/applicationPresentation.js";
import { aargauMunicipalityNames } from "../server/seed/municipalitySources.js";

test("ordnet repräsentative Gemeinden den vier Regionen zu", () => {
  assert.equal(getApplicationRegion("Aarau"), "Berner Aargau");
  assert.equal(getApplicationRegion("Rheinfelden"), "Fricktal");
  assert.equal(getApplicationRegion("Wettingen"), "Baden");
  assert.equal(getApplicationRegion("Muri"), "Freiamt");
  assert.equal(getApplicationRegion("Nicht erfasst"), "");
});

test("ordnet jede bekannte Aargauer Gemeinde einer Region zu", () => {
  const missing = aargauMunicipalityNames.filter((municipality) => !getApplicationRegion(municipality));
  assert.deepEqual(missing, []);
});

test("klassifiziert grosse vor mittleren und kleinen Vorhaben", () => {
  assert.equal(classifyProjectScale({ projectType: "Wohnüberbauung mit PV-Anlage" }), "gross");
  assert.equal(classifyProjectScale({ projectType: "Umbau MFH Pestalozzistrasse" }), "gross");
  assert.equal(classifyProjectScale({ projectType: "Anbau Einfamilienhaus" }), "mittel");
  assert.equal(classifyProjectScale({ projectType: "Neue Wärmepumpe" }), "klein");
  assert.equal(classifyProjectScale({ projectType: "Baugesuch" }), "nicht-klassiert");
});
