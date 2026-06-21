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
