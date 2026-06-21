// Baugesuch-Import: Normalize-Helfer (aus applicationsSyncCommon.js aufgeteilt).
import {
  germanMonthNumberMap,
  germanMonthPatternSource,
  protectionStatusAliasMap,
  weekdayPatternSource,
  workflowStatusAliasMap
} from "./applicationsSyncConstants.js";

export function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u");
}

export function normalizeLocationPrecision(value) {
  const normalized = normalizeText(value);

  if (["approximate", "coarse", "rough", "unscharf", "ungenau"].includes(normalized)) {
    return "approximate";
  }

  if (["precise", "exact", "genau"].includes(normalized)) {
    return "precise";
  }

  return "";
}

export function normalizeDate(value) {
  if (!value) {
    return "";
  }

  const text = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const swissMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})$/);

  if (swissMatch) {
    const [, day, month, year] = swissMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const textualMatch = text.match(
    new RegExp(
      `^(?:${weekdayPatternSource},?\\s*)?(\\d{1,2})\\.\\s*(${germanMonthPatternSource})\\s*(20\\d{2})$`,
      "i"
    )
  );

  if (textualMatch) {
    const [, day, monthName, year] = textualMatch;
    const month = germanMonthNumberMap.get(normalizeText(monthName));

    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  const parsed = new Date(text);

  if (!Number.isFinite(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString().slice(0, 10);
}

export function addDays(dateValue, days) {
  const normalized = normalizeDate(dateValue);

  if (!normalized) {
    return "";
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }

    const text = String(value).trim();

    if (text) {
      return text;
    }
  }

  return "";
}

export function normalizeProtectionStatus(rawValue, ambiguousAddress) {
  if (ambiguousAddress) {
    return "manual-review";
  }

  const normalized = protectionStatusAliasMap.get(normalizeText(rawValue));
  return normalized ?? "no-hit";
}

export function normalizeWorkflowStatus(rawValue) {
  const normalized = workflowStatusAliasMap.get(normalizeText(rawValue));
  return normalized ?? "new";
}

export function normalizeCoordinates(item) {
  if (item.coordinates) {
    return String(item.coordinates).trim();
  }

  const east = Number(item.east ?? item.coordinateEast ?? item.lv95East);
  const north = Number(item.north ?? item.coordinateNorth ?? item.lv95North);

  if (Number.isFinite(east) && Number.isFinite(north)) {
    return `${east},${north}`;
  }

  return "";
}

export function normalizeFeatureCoordinates(feature) {
  if (!feature || typeof feature !== "object") {
    return {};
  }

  const geometry = feature.geometry ?? {};

  if (Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    return {
      east: geometry.x,
      north: geometry.y
    };
  }

  if (Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const [east, north] = geometry.coordinates;

    if (Number.isFinite(east) && Number.isFinite(north)) {
      return {
        east,
        north
      };
    }
  }

  return {};
}

export function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  return [];
}

export function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

