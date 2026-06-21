import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSwissGeocodeQueryUrl,
  extractGeocodeStreetToken,
  extractSwissCoordinateMatchFromGeocoderPayload,
  formatLv95Coordinates,
  geocodeCandidateLocationMatches,
  geocodeCandidateMunicipalityMatches,
  requestedAddressHasHouseNumber
} from "../server/services/applicationsSyncGeocode.js";

test("buildSwissGeocodeQueryUrl enthaelt Adresse und Gemeinde", () => {
  const url = buildSwissGeocodeQueryUrl("Hauptstrasse 12", "Aarau");
  assert.ok(url.startsWith("https://api3.geo.admin.ch/"));
  assert.ok(/Hauptstrasse/i.test(decodeURIComponent(url)));
  assert.ok(/Aarau/i.test(decodeURIComponent(url)));
});

test("formatLv95Coordinates formatiert zwei Zahlen", () => {
  assert.equal(formatLv95Coordinates(2645000, 1249000), "2645000,1249000");
});

test("geocodeCandidateMunicipalityMatches / Strassentoken / Hausnummer", () => {
  assert.equal(geocodeCandidateMunicipalityMatches("Aarau", "Hauptstrasse 12 5000 Aarau"), true);
  assert.equal(geocodeCandidateMunicipalityMatches("Aarau", "Bahnhof 1 8000 Zürich"), false);
  assert.equal(extractGeocodeStreetToken("Hauptstrasse 12"), "hauptstrasse");
  assert.equal(requestedAddressHasHouseNumber("Hauptstrasse 12"), true);
  assert.equal(requestedAddressHasHouseNumber("Hauptstrasse"), false);
  assert.equal(
    geocodeCandidateLocationMatches("Hauptstrasse 12 5000 Aarau", { streetToken: "hauptstrasse", parcelToken: "" }),
    true
  );
});

test("extractSwissCoordinateMatchFromGeocoderPayload: results mit attrs.x/y (praezise)", () => {
  const payload = { results: [{ attrs: { label: "Hauptstrasse 12 5000 Aarau", x: 2645000, y: 1249000, origin: "address" } }] };
  const match = extractSwissCoordinateMatchFromGeocoderPayload(payload, "Aarau", { requestedAddress: "Hauptstrasse 12" });
  assert.equal(match.coordinates, "2645000,1249000");
  assert.equal(match.locationPrecision, "precise");
});

test("extractSwissCoordinateMatchFromGeocoderPayload: features mit geometry", () => {
  const payload = {
    features: [{ properties: { label: "Dorfweg 3 5000 Aarau" }, geometry: { coordinates: [2646000, 1250000] } }]
  };
  const match = extractSwissCoordinateMatchFromGeocoderPayload(payload, "Aarau", { requestedAddress: "Dorfweg 3" });
  assert.equal(match.coordinates, "2646000,1250000");
});

test("extractSwissCoordinateMatchFromGeocoderPayload: kein Treffer", () => {
  const payload = { results: [{ attrs: { label: "Hauptstrasse 12 5000 Aarau", x: 2645000, y: 1249000, origin: "address" } }] };
  assert.equal(extractSwissCoordinateMatchFromGeocoderPayload(payload, "Zürich", { requestedAddress: "Hauptstrasse 12" }), null);
  assert.equal(extractSwissCoordinateMatchFromGeocoderPayload({}, "Aarau", { requestedAddress: "Hauptstrasse 12" }), null);
  // Grober Geocoder-Ursprung (Gemeindeumriss) ohne Strassentreffer -> verworfen.
  const coarse = { results: [{ attrs: { label: "Aarau", x: 2645000, y: 1249000, origin: "gg25" } }] };
  assert.equal(extractSwissCoordinateMatchFromGeocoderPayload(coarse, "Aarau", { requestedAddress: "Hauptstrasse 12", allowApproximate: true }), null);
});
