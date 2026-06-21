import test from "node:test";
import assert from "node:assert/strict";
import { createAgisAssessmentService } from "../server/services/agisAssessmentService.js";

const emptyFeatures = {
  areaFeatures: [],
  pointFeatures: [],
  displayAreaFeatures: [],
  displayPointFeatures: [],
  matched: { area: false, points: false },
  meta: { official: true, source: "AGIS" }
};

const geometryReturning = (result) => ({ getOfficialFeatures: async () => result });

test("Konstruktor verlangt repository und geometry service", () => {
  assert.throws(() => createAgisAssessmentService({ agisGeometryService: geometryReturning(emptyFeatures) }), /repository/);
  assert.throws(() => createAgisAssessmentService({ repository: {} }), /geometry/);
});

test("assessItem: null / uneindeutig / ohne Koordinaten", async () => {
  const service = createAgisAssessmentService({ repository: {}, agisGeometryService: geometryReturning(emptyFeatures) });
  assert.equal(await service.assessItem(null), null);

  const ambiguous = await service.assessItem({ ambiguousAddress: 1 });
  assert.equal(ambiguous.protectionStatus, "manual-review");

  assert.equal(await service.assessItem({ coordinates: "" }), null);
});

test("assessItem: gueltige Koordinaten ohne Treffer -> Bewertung", async () => {
  const service = createAgisAssessmentService({ repository: {}, agisGeometryService: geometryReturning(emptyFeatures) });
  const result = await service.assessItem({ coordinates: "2660000,1240000" });
  assert.ok(result, "Bewertung vorhanden");
  assert.equal(typeof result.protectionStatus, "string");
  assert.deepEqual(result.agisLayers, []);
});

test("assessItem: Geometry-Fehler wird abgefangen -> null", async () => {
  const service = createAgisAssessmentService({
    repository: {},
    agisGeometryService: {
      getOfficialFeatures: async () => {
        throw new Error("AGIS weg");
      }
    },
    logger: { warn() {} }
  });
  assert.equal(await service.assessItem({ id: "BG-1", coordinates: "2660000,1240000" }), null);
});
