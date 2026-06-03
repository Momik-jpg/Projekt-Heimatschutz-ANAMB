// Reine Formatierungs- und Text-Helfer (kein DOM, kein State).
// Aus app.js ausgelagert, um die Oberfläche schrittweise zu modularisieren.

export function formatDate(dateValue) {
  if (!dateValue) {
    return "-";
  }

  return new Intl.DateTimeFormat("de-CH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(dateValue));
}

export function formatDateTime(dateValue) {
  if (!dateValue) {
    return "-";
  }

  return new Intl.DateTimeFormat("de-CH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(dateValue));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function truncateText(value, maxLength = 96) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildReadableAddress(item, { forList = false } = {}) {
  let value = normalizeWhitespace(item?.address);

  if (!value) {
    return "Adresse prüfen";
  }

  value = value
    .replace(/\.{2,}\s*\[mehr\].*$/i, "")
    .replace(/\s*\[…\].*$/i, "")
    .replace(/\s*\[mehr\].*$/i, "")
    .replace(/\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
    .replace(/\s*(?:Bauherr(?:schaft)?|Grundeigentümer(?:in)?|Projektverfasser|Bauprojekt|Bauvorhaben|Lage):.*$/i, "")
    .replace(/\s*,\s*(\d+[a-z]?)$/i, " $1")
    .trim();

  if (!value) {
    return "Adresse prüfen";
  }

  return forList ? truncateText(value, 54) : value;
}
