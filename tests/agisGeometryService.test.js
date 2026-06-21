import test from "node:test";
import assert from "node:assert/strict";
import { createAgisGeometryService } from "../server/services/agisGeometryService.js";

test("Konstruktor verlangt eine Fetch-Implementierung", () => {
  assert.throws(() => createAgisGeometryService({ fetchImpl: 123 }), /fetch/);
});

test("getOfficialFeatures: leere AGIS-Antwort -> kein Treffer, mit Cache", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ features: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const service = createAgisGeometryService({ fetchImpl });

  const result = await service.getOfficialFeatures({ east: 2660000, north: 1240000 });
  assert.equal(result.matched.area, false);
  assert.equal(result.matched.points, false);
  assert.equal(result.meta.official, true);
  assert.equal(result.meta.source, "AGIS");
  assert.deepEqual(result.areaFeatures, []);

  const callsAfterFirst = calls;
  await service.getOfficialFeatures({ east: 2660000, north: 1240000 });
  assert.equal(calls, callsAfterFirst, "zweiter Aufruf nutzt den Cache");
});

test("getOfficialFeatures: Fetch-Fehler werden abgefangen -> leeres Ergebnis (graceful)", async () => {
  const fetchImpl = async () => {
    throw new Error("AGIS nicht erreichbar");
  };
  const service = createAgisGeometryService({ fetchImpl });
  const result = await service.getOfficialFeatures({ east: 1, north: 2 });
  assert.equal(result.matched.area, false);
  assert.equal(result.matched.points, false);
  assert.deepEqual(result.areaFeatures, []);
  assert.deepEqual(result.pointFeatures, []);
});

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("getOfficialFeatures: Flaechen- und Punkt-Treffer werden geparst", async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("are_isos")) {
      // Aussenring (im Uhrzeigersinn) + Loch (gegen Uhrzeigersinn) im Inneren.
      return jsonResponse({
        features: [
          {
            geometry: {
              rings: [
                [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]],
                [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
              ]
            },
            attributes: { OBJECTID: 1, BENENN_F: "Altstadt", KAT_F: "A", Bedeutung: "national" }
          }
        ]
      });
    }
    if (target.includes("dp_denkmalpflege")) {
      return jsonResponse({
        features: [
          {
            geometry: { x: 2660000, y: 1240000 },
            attributes: { TITEL: "Inventarobjekt", GEMEINDE: "Aarau", ADRESSE: "Hauptstrasse 12", SIGNATUR: "S-1" }
          }
        ]
      });
    }
    return jsonResponse({ features: [] });
  };

  const service = createAgisGeometryService({ fetchImpl });
  const result = await service.getOfficialFeatures({ east: 2660000, north: 1240000 });

  assert.equal(result.matched.area, true);
  assert.equal(result.matched.points, true);
  assert.equal(result.areaFeatures.length, 1);
  assert.equal(result.areaFeatures[0].properties.title, "Altstadt");
  assert.ok(result.areaFeatures[0].parts.length >= 1, "Polygon-Teile vorhanden");
  assert.equal(result.pointFeatures.length, 1);
  assert.equal(result.pointFeatures[0].properties.address, "Hauptstrasse 12");
  assert.ok(result.displayAreaFeatures.length >= 1);
  assert.ok(result.displayPointFeatures.length >= 1);
});

test("getOfficialFeatures: AGIS-Fehlerpayload einer Ebene wird toleriert", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("dp_denkmalpflege")) {
      return jsonResponse({ error: { message: "Layer überlastet" } });
    }
    return jsonResponse({ features: [] });
  };
  const service = createAgisGeometryService({ fetchImpl });
  const result = await service.getOfficialFeatures({ east: 2660001, north: 1240001 });
  // Flaeche leer, Punkte als rejected -> Fallback auf leere Liste, kein Wurf.
  assert.equal(result.matched.points, false);
  assert.deepEqual(result.pointFeatures, []);
});

test("getOfficialFeatures: nicht-ok-Antwort einer Ebene wird toleriert", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("are_isos")) {
      return new Response("boom", { status: 500 });
    }
    return jsonResponse({ features: [] });
  };
  const service = createAgisGeometryService({ fetchImpl });
  const result = await service.getOfficialFeatures({ east: 2660002, north: 1240002 });
  assert.equal(result.matched.area, false);
});
