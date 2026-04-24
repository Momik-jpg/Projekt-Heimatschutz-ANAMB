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

function buildAssessmentFromOfficialFeatures(features) {
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

      if (item.ambiguousAddress || item.protectionStatus === "manual-review") {
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
        return buildAssessmentFromOfficialFeatures(officialFeatures);
      } catch (error) {
        logger.warn?.(`AGIS-Neubewertung fehlgeschlagen fuer ${item.id}: ${error.message}`);
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
