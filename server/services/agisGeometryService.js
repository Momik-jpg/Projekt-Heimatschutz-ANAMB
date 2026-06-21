const AREA_SERVICE_URL = "https://www.ag.ch/geoportal/rest/services/are_isos/MapServer";
const POINT_SERVICE_URL = "https://www.ag.ch/geoportal/rest/services/dp_denkmalpflege/MapServer";
const DIRECT_AREA_LAYER_PRIORITY = [
  { id: 21, key: "zone-part", label: "Ortsbildteile (ISOS-I-basiert)" },
  { id: 15, key: "perimeter-zone", label: "Ortsbilder PDF-Perimeter (ISOS-I-basiert)" },
  { id: 20, key: "hint-zone", label: "Hinweis Polygone (ISOS-I-basiert)" }
];
const CONTEXT_AREA_LAYERS = [
  { id: 18, key: "municipality-zone", label: "Ortsbilder in den Gemeinden (ISOS-I-basiert)" },
  { id: 21, key: "zone-part", label: "Ortsbildteile (ISOS-I-basiert)" },
  { id: 20, key: "hint-zone", label: "Hinweis Polygone (ISOS-I-basiert)" }
];
const DIRECT_POINT_LAYER = {
  id: 8,
  key: "inventory-point",
  label: "Bauinventarobjekte"
};
const DIRECT_POINT_SEARCH_BUFFER_METERS = 120;
const CONTEXT_AREA_SEARCH_BUFFER_METERS = 1500;
const CONTEXT_POINT_SEARCH_BUFFER_METERS = 1500;

function buildEnvelope(east, north, bufferMeters) {
  return {
    xmin: east - bufferMeters,
    ymin: north - bufferMeters,
    xmax: east + bufferMeters,
    ymax: north + bufferMeters,
    spatialReference: {
      wkid: 2056
    }
  };
}

function coordinatesEqual(first, second) {
  return first[0] === second[0] && first[1] === second[1];
}

function ensureClosedRing(ring) {
  const normalized = ring
    .map((pair) => [Number(pair[0]), Number(pair[1])])
    .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));

  if (normalized.length < 3) {
    return [];
  }

  if (!coordinatesEqual(normalized[0], normalized.at(-1))) {
    normalized.push([...normalized[0]]);
  }

  return normalized;
}

function isClockwiseRing(ring) {
  let total = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    total += (x2 - x1) * (y2 + y1);
  }

  return total >= 0;
}

function pointInRing(point, ring) {
  const [pointX, pointY] = point;
  let inside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    const intersects =
      y1 > pointY !== y2 > pointY &&
      pointX < ((x2 - x1) * (pointY - y1)) / ((y2 - y1) || Number.EPSILON) + x1;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function groupArcGisRings(rings) {
  const outerPolygons = [];
  const holes = [];

  for (const rawRing of rings ?? []) {
    const ring = ensureClosedRing(rawRing);

    if (ring.length < 4) {
      continue;
    }

    if (isClockwiseRing(ring)) {
      outerPolygons.push({
        shell: ring,
        holes: []
      });
    } else {
      holes.push(ring);
    }
  }

  if (outerPolygons.length === 0) {
    return holes.map((ring) => [ring.slice().reverse()]);
  }

  for (const hole of holes) {
    const container = outerPolygons.find((polygon) => pointInRing(hole[0], polygon.shell));

    if (container) {
      container.holes.push(hole);
      continue;
    }

    outerPolygons.push({
      shell: hole.slice().reverse(),
      holes: []
    });
  }

  return outerPolygons.map((polygon) => [polygon.shell, ...polygon.holes]);
}

function pickFirstString(attributes, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = attributes?.[fieldName];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizeAreaFeatures(features, layer) {
  return (features ?? [])
    .map((feature, index) => {
      const parts = groupArcGisRings(feature.geometry?.rings ?? []);
      const attributes = feature.attributes ?? {};

      if (parts.length === 0) {
        return null;
      }

      return {
        id: `${layer.id}:${attributes.OBJECTID ?? index}`,
        parts,
        properties: {
          title: pickFirstString(attributes, ["BENENN_F", "BENENN_E", "ORT", "ORTSBILD", "GDE_I", "GEMEINDE"]),
          category: pickFirstString(attributes, ["KAT_F", "KAT_E", "Kategorie", "RASTER", "KATZUSATZ"]),
          significance: pickFirstString(attributes, ["Bedeutung", "E_STUF"]),
          preservationTarget: pickFirstString(attributes, ["ERHALT_F", "ERHALT_E"]),
          inventorySheet: pickFirstString(attributes, ["Inventarblatt", "PDF_1"]),
          layerId: layer.id,
          layerKey: layer.key,
          layerLabel: layer.label
        }
      };
    })
    .filter(Boolean);
}

function normalizePointFeatures(features, layer) {
  return (features ?? [])
    .map((feature, index) => {
      const x = Number(feature.geometry?.x);
      const y = Number(feature.geometry?.y);
      const attributes = feature.attributes ?? {};

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }

      return {
        id: `${layer.id}:${pickFirstString(attributes, ["SIGNATUR", "Signatur"]) || index}`,
        coordinates: [x, y],
        properties: {
          title: pickFirstString(attributes, ["TITEL", "Titel"]),
          municipality: pickFirstString(attributes, ["GEMEINDE", "Gemeinde"]),
          address: pickFirstString(attributes, ["ADRESSE", "Adresse"]),
          reference: pickFirstString(attributes, ["SIGNATUR", "Signatur"]),
          detailUrl: pickFirstString(attributes, ["URL", "Url"]),
          layerId: layer.id,
          layerKey: layer.key,
          layerLabel: layer.label
        }
      };
    })
    .filter(Boolean);
}

function dedupeFeatures(features) {
  const seenIds = new Set();
  return (features ?? []).filter((feature) => {
    if (!feature?.id || seenIds.has(feature.id)) {
      return false;
    }

    seenIds.add(feature.id);
    return true;
  });
}

async function requestArcGisJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`AGIS request failed with status ${response.status}`);
  }

  const payload = await response.json();

  if (payload?.error?.message) {
    throw new Error(payload.error.message);
  }

  return payload;
}

async function queryLayer(fetchImpl, baseUrl, layerId, params) {
  const url = new URL(`${baseUrl}/${layerId}/query`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return requestArcGisJson(fetchImpl, url);
}

async function queryDirectAreaFeatures(fetchImpl, east, north) {
  for (const layer of DIRECT_AREA_LAYER_PRIORITY) {
    let payload;

    try {
      payload = await queryLayer(fetchImpl, AREA_SERVICE_URL, layer.id, {
        geometry: `${east},${north}`,
        geometryType: "esriGeometryPoint",
        inSR: "2056",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*",
        returnGeometry: "true",
        f: "json"
      });
    } catch {
      continue;
    }

    const features = normalizeAreaFeatures(payload.features, layer);

    if (features.length > 0) {
      return {
        features,
        layerId: layer.id,
        layerLabel: layer.label
      };
    }
  }

  return {
    features: [],
    layerId: null,
    layerLabel: null
  };
}

async function queryContextAreaFeatures(fetchImpl, east, north) {
  const features = [];

  for (const layer of CONTEXT_AREA_LAYERS) {
    try {
      const payload = await queryLayer(fetchImpl, AREA_SERVICE_URL, layer.id, {
        geometry: JSON.stringify(buildEnvelope(east, north, CONTEXT_AREA_SEARCH_BUFFER_METERS)),
        geometryType: "esriGeometryEnvelope",
        inSR: "2056",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*",
        returnGeometry: "true",
        f: "json"
      });

      features.push(...normalizeAreaFeatures(payload.features, layer));
    } catch {
    }
  }

  return dedupeFeatures(features);
}

async function queryDirectPointFeatures(fetchImpl, east, north) {
  const payload = await queryLayer(fetchImpl, POINT_SERVICE_URL, DIRECT_POINT_LAYER.id, {
    geometry: JSON.stringify(buildEnvelope(east, north, DIRECT_POINT_SEARCH_BUFFER_METERS)),
    geometryType: "esriGeometryEnvelope",
    inSR: "2056",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "Titel,Gemeinde,Adresse,Signatur",
    returnGeometry: "true",
    f: "json"
  });

  return {
    features: normalizePointFeatures(payload.features, DIRECT_POINT_LAYER),
    layerId: DIRECT_POINT_LAYER.id,
    layerLabel: DIRECT_POINT_LAYER.label
  };
}

async function queryContextPointFeatures(fetchImpl, east, north) {
  const payload = await queryLayer(fetchImpl, POINT_SERVICE_URL, DIRECT_POINT_LAYER.id, {
    geometry: JSON.stringify(buildEnvelope(east, north, CONTEXT_POINT_SEARCH_BUFFER_METERS)),
    geometryType: "esriGeometryEnvelope",
    inSR: "2056",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "URL,TITEL,GEMEINDE,ADRESSE,SIGNATUR",
    returnGeometry: "true",
    f: "json"
  });

  return dedupeFeatures(normalizePointFeatures(payload.features, DIRECT_POINT_LAYER));
}

export function createAgisGeometryService(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cache = new Map();

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for the AGIS geometry service.");
  }

  return {
    async getOfficialFeatures({ east, north }) {
      const cacheKey = `${Math.round(east)}:${Math.round(north)}`;

      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }

      const resultPromise = (async () => {
        const [areaOutcome, pointOutcome, contextAreaOutcome, contextPointOutcome] = await Promise.allSettled([
          queryDirectAreaFeatures(fetchImpl, east, north),
          queryDirectPointFeatures(fetchImpl, east, north),
          queryContextAreaFeatures(fetchImpl, east, north),
          queryContextPointFeatures(fetchImpl, east, north)
        ]);

        if (
          areaOutcome.status === "rejected" &&
          pointOutcome.status === "rejected" &&
          contextAreaOutcome.status === "rejected" &&
          contextPointOutcome.status === "rejected"
        ) {
          throw contextPointOutcome.reason ?? pointOutcome.reason ?? areaOutcome.reason ?? contextAreaOutcome.reason;
        }

        const areaResult =
          areaOutcome.status === "fulfilled"
            ? areaOutcome.value
            : {
                features: [],
                layerId: null,
                layerLabel: null
              };
        const pointResult =
          pointOutcome.status === "fulfilled"
            ? pointOutcome.value
            : {
                features: [],
                layerId: DIRECT_POINT_LAYER.id,
                layerLabel: DIRECT_POINT_LAYER.label
              };
        const contextAreaFeatures = contextAreaOutcome.status === "fulfilled" ? contextAreaOutcome.value : [];
        const contextPointFeatures = contextPointOutcome.status === "fulfilled" ? contextPointOutcome.value : [];

        return {
          areaFeatures: areaResult.features,
          pointFeatures: pointResult.features,
          displayAreaFeatures: dedupeFeatures([...contextAreaFeatures, ...areaResult.features]),
          displayPointFeatures: dedupeFeatures([...contextPointFeatures, ...pointResult.features]),
          matched: {
            area: areaResult.features.length > 0,
            points: pointResult.features.length > 0
          },
          meta: {
            official: true,
            source: "AGIS",
            areaServiceUrl: AREA_SERVICE_URL,
            pointServiceUrl: POINT_SERVICE_URL,
            areaLayerId: areaResult.layerId,
            areaLayerLabel: areaResult.layerLabel,
            pointLayerId: pointResult.layerId,
            pointLayerLabel: pointResult.layerLabel,
            pointSearchBufferMeters: DIRECT_POINT_SEARCH_BUFFER_METERS,
            displayAreaSearchBufferMeters: CONTEXT_AREA_SEARCH_BUFFER_METERS,
            displayPointSearchBufferMeters: CONTEXT_POINT_SEARCH_BUFFER_METERS
          }
        };
      })();

      cache.set(cacheKey, resultPromise);

      try {
        const result = await resultPromise;
        cache.set(cacheKey, result);
        return result;
      } catch (error) {
        cache.delete(cacheKey);
        throw error;
      }
    }
  };
}
