// HTTP-Support-Kern (Pfade, Keys, CSV, Session-Aufloesung, Import-Notifications) – aus httpSupport.js aufgeteilt.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const currentFile = fileURLToPath(import.meta.url);

export const currentDir = dirname(currentFile);

export const rootDir = dirname(currentDir);

export const publicDir = join(rootDir, "public");

export const registrationKeyLifetimeDays = 30;

export const agisBaugesucheDatendocUrl =
  "https://www.ag.ch/geoportal/geodatenshop/Datendokumentation.aspx?Datensatzelement=3018";

export function nowIso() {
  return new Date().toISOString();
}

export function buildRegistrationKeyExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + registrationKeyLifetimeDays * 24 * 60 * 60 * 1000).toISOString();
}

export function generateRegistrationKey() {
  const raw = randomBytes(6).toString("hex").toUpperCase();
  return `HSA-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export const masterSetupKeyLifetimeHours = 48;

// Hochentropischer Einmal-Key für die Master-Ersteinrichtung.
export function generateMasterSetupKey() {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  return `HSA-SETUP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function buildMasterSetupExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + masterSetupKeyLifetimeHours * 60 * 60 * 1000).toISOString();
}

export const passwordResetKeyLifetimeHours = 2;

// Hochentropischer Einmal-Key für den Passwort-Reset.
export function generatePasswordResetKey() {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  const groups = [];
  for (let index = 0; index < raw.length; index += 4) groups.push(raw.slice(index, index + 4));
  return `HSA-RESET-${groups.join("-")}`;
}

export function buildPasswordResetExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + passwordResetKeyLifetimeHours * 60 * 60 * 1000).toISOString();
}

export function normalizeRegistrationKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(/\s+/g, "");
}

export function isMasterUser(user) {
  return user?.role === "Master";
}

export function handleHealthCheck(_request, response, databasePath) {
  response.json({
    status: "ok",
    databasePath
  });
}

export function escapeCsvValue(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');

  if (/[",\n]/.test(escaped)) {
    return `"${escaped}"`;
  }

  return escaped;
}

export function buildCsvResponse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(escapeCsvValue).join(",");
  const bodyRows = rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","));
  return [headerRow, ...bodyRows].join("\n");
}

export function shouldCreateImportNotification(item) {
  return ["protected-point", "protected-zone", "combined-hit", "manual-review"].includes(item?.protectionStatus);
}

export function buildImportNotificationEntries(changes, sourceLabel) {
  const createdAt = nowIso();

  return (changes ?? [])
    .filter((entry) => entry?.item && shouldCreateImportNotification(entry.item))
    .map((entry) => ({
      id: `NTF-${randomBytes(8).toString("hex")}`,
      applicationId: entry.item.id,
      changeType: entry.changeType ?? "updated",
      sourceLabel,
      protectionStatus: entry.item.protectionStatus,
      municipality: entry.item.municipality,
      address: entry.item.address,
      createdAt
    }));
}
