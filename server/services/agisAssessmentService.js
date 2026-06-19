function parseSwissCoordinates(coordinates) {
  if (!coordinates) {
    return null;
  }

  const [firstValue, secondValue] = String(coordinates)
    .split(",")
    .map((value) => Number(value.trim()));

  if (!Number.isFinite(firstValue) || !Number.isFinite(secondValue)) {
    return null;
  }

  const looksLikeLv95East = (value) => value >= 2400000 && value <= 2900000;
  const looksLikeLv95North = (value) => value >= 1000000 && value <= 1400000;

  if (looksLikeLv95East(firstValue) && looksLikeLv95North(secondValue)) {
    return {
      east: firstValue,
      north: secondValue
    };
  }

  if (looksLikeLv95North(firstValue) && looksLikeLv95East(secondValue)) {
    return {
      east: secondValue,
      north: firstValue
    };
  }

  return {
    east: firstValue,
    north: secondValue
  };
}

const APPROXIMATE_LOCATION_REVIEW_BUFFER_METERS = 250;

function isApproximateLocationPrecision(value) {
  return ["approximate", "coarse", "rough", "unscharf", "ungenau"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );
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

function pointInPolygonPart(point, part) {
  const [shell, ...holes] = part ?? [];

  if (!shell?.length || !pointInRing(point, shell)) {
    return false;
  }

  return !holes.some((hole) => pointInRing(point, hole));
}

function distanceToSegment(point, start, end) {
  const [pointX, pointY] = point;
  const [startX, startY] = start;
  const [endX, endY] = end;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const ratio = Math.max(
    0,
    Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared)
  );
  const closestX = startX + ratio * deltaX;
  const closestY = startY + ratio * deltaY;
  return Math.hypot(pointX - closestX, pointY - closestY);
}

function distanceToRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let nearest = Number.POSITIVE_INFINITY;

  for (let index = 0; index < ring.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegment(point, ring[index], ring[(index + 1) % ring.length]));
  }

  return nearest;
}

function distanceToAreaFeature(point, feature) {
  let nearest = Number.POSITIVE_INFINITY;

  for (const part of feature?.parts ?? []) {
    if (pointInPolygonPart(point, part)) {
      return 0;
    }

    for (const ring of part ?? []) {
      nearest = Math.min(nearest, distanceToRing(point, ring));
    }
  }

  return nearest;
}

function distanceToPointFeature(point, feature) {
  const [east, north] = feature?.coordinates ?? [];

  if (!Number.isFinite(east) || !Number.isFinite(north)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.hypot(point[0] - east, point[1] - north);
}

function rememberNearestProtectionContext(current, candidate) {
  if (!Number.isFinite(candidate.distanceMeters)) {
    return current;
  }

  if (!current || candidate.distanceMeters < current.distanceMeters) {
    return candidate;
  }

  return current;
}

function findNearestProtectionContext(features, coordinates) {
  const point = [coordinates.east, coordinates.north];
  let nearest = null;

  for (const feature of features?.displayAreaFeatures ?? []) {
    nearest = rememberNearestProtectionContext(nearest, {
      distanceMeters: distanceToAreaFeature(point, feature),
      agisLayers: ["ISOS-Fläche"]
    });
  }

  for (const feature of features?.displayPointFeatures ?? []) {
    nearest = rememberNearestProtectionContext(nearest, {
      distanceMeters: distanceToPointFeature(point, feature),
      agisLayers: ["Gebäude im Inventar"]
    });
  }

  return nearest;
}

function buildAssessmentFromOfficialFeatures(features, options = {}) {
  const hasArea = Boolean(features?.matched?.area) || (features?.areaFeatures?.length ?? 0) > 0;
  const hasPoints = Boolean(features?.matched?.points) || (features?.pointFeatures?.length ?? 0) > 0;

  if (hasArea && hasPoints) {
    return {
      protectionStatus: "combined-hit",
      agisMatch: "ISOS-Fläche und Gebäude im Inventar",
      agisLayers: ["ISOS-Fläche", "Gebäude im Inventar"],
      automatedAssessment: "Der Standort liegt in einer geschützten Fläche und bei einem Inventarobjekt."
    };
  }

  if (hasPoints) {
    return {
      protectionStatus: "protected-point",
      agisMatch: "Treffer im Gebäudeinventar",
      agisLayers: ["Gebäude im Inventar"],
      automatedAssessment: "Der Standort liegt bei einem geschützten Inventarobjekt."
    };
  }

  if (hasArea) {
    return {
      protectionStatus: "protected-zone",
      agisMatch: "Treffer in ISOS-Fläche",
      agisLayers: ["ISOS-Fläche"],
      automatedAssessment: "Der Standort liegt in einer geschützten Fläche."
    };
  }

  if (isApproximateLocationPrecision(options.locationPrecision) && options.coordinates) {
    const nearestContext = findNearestProtectionContext(features, options.coordinates);

    if (
      nearestContext &&
      nearestContext.distanceMeters <= APPROXIMATE_LOCATION_REVIEW_BUFFER_METERS
    ) {
      const roundedDistance = Math.round(nearestContext.distanceMeters);

      return {
        protectionStatus: "manual-review",
        agisMatch: "Nahe Schutzobjekte bei unscharfer Lage",
        agisLayers: nearestContext.agisLayers,
        automatedAssessment:
          `Die Koordinate stammt aus einer ungenauen amtlichen Suche. Im Sicherheitsradius von ${APPROXIMATE_LOCATION_REVIEW_BUFFER_METERS} m liegt ein Schutzobjekt (${roundedDistance} m entfernt). Bitte Standort von Hand prüfen.`
      };
    }

    return {
      protectionStatus: "no-hit",
      agisMatch: "Kein Schutztreffer",
      agisLayers: [],
      automatedAssessment:
        `Die Koordinate stammt aus einer ungenauen amtlichen Suche. Im Sicherheitsradius von ${APPROXIMATE_LOCATION_REVIEW_BUFFER_METERS} m wurde kein geschützter Punkt und keine geschützte Fläche gefunden.`
    };
  }

  return {
    protectionStatus: "no-hit",
    agisMatch: "Kein Schutztreffer",
    agisLayers: [],
    automatedAssessment: "An dieser Koordinate wurde weder ein geschützter Punkt noch eine geschützte Fläche gefunden."
  };
}

function assessmentChanged(currentItem, nextAssessment) {
  return (
    currentItem.protectionStatus !== nextAssessment.protectionStatus ||
    currentItem.agisMatch !== nextAssessment.agisMatch ||
    JSON.stringify(currentItem.agisLayers ?? []) !== JSON.stringify(nextAssessment.agisLayers ?? []) ||
    currentItem.automatedAssessment !== nextAssessment.automatedAssessment
  );
}

export function createAgisAssessmentService({ repository, agisGeometryService, logger = console } = {}) {
  if (!repository) {
    throw new Error("A repository is required for the AGIS assessment service.");
  }

  if (!agisGeometryService) {
    throw new Error("An AGIS geometry service is required for the AGIS assessment service.");
  }

  return {
    async assessItem(item) {
      if (!item) {
        return null;
      }

      // Nur eine wirklich uneindeutige Adresse (kein verwertbarer Standort) wird
      // hier kurzgeschlossen. Der frühere Kurzschluss auf protectionStatus ===
      // "manual-review" war gefährlich: Fälle, die nur wegen eines reinen
      // Datenqualitätsproblems (z. B. ungültiges Fristdatum) auf "manual-review"
      // standen, aber gültige Koordinaten besitzen, wären nie wieder durch AGIS
      // geprüft worden. Ein echter Schutztreffer konnte dadurch dauerhaft
      // verdeckt bleiben. Solange Koordinaten vorhanden sind, bewertet AGIS neu.
      if (item.ambiguousAddress) {
        return {
          protectionStatus: "manual-review",
          agisMatch: "Noch nicht eindeutig zugeordnet",
          agisLayers: [],
          automatedAssessment: "Die Adresse ist nicht eindeutig genug für eine automatische AGIS-Zuordnung."
        };
      }

      const coordinates = parseSwissCoordinates(item.coordinates);

      if (!coordinates) {
        return null;
      }

      try {
        const officialFeatures = await agisGeometryService.getOfficialFeatures(coordinates);
        return buildAssessmentFromOfficialFeatures(officialFeatures, {
          coordinates,
          locationPrecision: item.locationPrecision
        });
      } catch (error) {
        logger.warn?.(`AGIS-Neubewertung fehlgeschlagen für ${item.id}: ${error.message}`);
        return null;
      }
    },

    async refreshItem(itemOrId) {
      const item = typeof itemOrId === "string" ? repository.getById(itemOrId) : itemOrId;

      if (!item) {
        return null;
      }

      const nextAssessment = await this.assessItem(item);

      if (!nextAssessment || !assessmentChanged(item, nextAssessment)) {
        return item;
      }

      return repository.updateAssessment(item.id, nextAssessment);
    },

    async refreshAll() {
      const items = repository.list();
      let updatedCount = 0;

      for (const item of items) {
        const updatedItem = await this.refreshItem(item);

        if (updatedItem && assessmentChanged(item, updatedItem)) {
          updatedCount += 1;
        }
      }

      return {
        total: items.length,
        updatedCount
      };
    }
  };
}
