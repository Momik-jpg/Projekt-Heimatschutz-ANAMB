const monthNumbers = new Map([
  ["januar", 1], ["februar", 2], ["märz", 3], ["marz", 3],
  ["april", 4], ["mai", 5], ["juni", 6], ["juli", 7],
  ["august", 8], ["september", 9], ["oktober", 10],
  ["november", 11], ["dezember", 12]
]);

const weekdayPattern = "(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)";
const monthPattern = "(?:januar|februar|märz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)";
const numericDatePartPattern = "\\d{1,2}\\.\\d{1,2}\\.(?:20\\d{2})?";
const textualDatePartPattern = `(?:${weekdayPattern},?\\s*)?\\d{1,2}\\.\\s*${monthPattern}(?:\\s*20\\d{2})?`;
const datePartPattern = `(?:${numericDatePartPattern}|${textualDatePartPattern})`;

function isoDate(year, month, day) {
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "";
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDatePart(value, fallbackYear = 0) {
  const text = String(value ?? "").trim().replace(/,$/, "");
  const isoMatch = text.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (isoMatch) return isoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

  const numericMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})?$/);
  if (numericMatch) {
    return isoDate(Number(numericMatch[3] || fallbackYear), Number(numericMatch[2]), Number(numericMatch[1]));
  }

  const textualMatch = text.match(
    new RegExp(`^(?:${weekdayPattern},?\\s*)?(\\d{1,2})\\.\\s*(${monthPattern})(?:\\s*(20\\d{2}))?$`, "i")
  );
  if (!textualMatch) return "";
  return isoDate(
    Number(textualMatch[3] || fallbackYear),
    monthNumbers.get(textualMatch[2].toLowerCase()),
    Number(textualMatch[1])
  );
}

function explicitYear(value) {
  return Number(String(value ?? "").match(/20\d{2}/)?.[0] ?? 0);
}

export function extractPublicationDateRange(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const dashMatch = text.match(new RegExp(`(${datePartPattern})\\s*[–—-]\\s*(${datePartPattern})`, "i"));
  const wordMatch = text.match(
    new RegExp(`\\bvom\\b\\s*(${datePartPattern})[\\s\\S]{0,40}?\\bbis\\b\\s*(${datePartPattern})`, "i")
  );
  const match = dashMatch || wordMatch;
  if (!match?.[1] || !match?.[2]) return { publicationDate: "", deadlineDate: "" };

  const year = explicitYear(match[2]) || explicitYear(match[1]);
  if (!year) return { publicationDate: "", deadlineDate: "" };

  let publicationDate = normalizeDatePart(match[1], year);
  const deadlineDate = normalizeDatePart(match[2], year);
  if (publicationDate && deadlineDate && publicationDate > deadlineDate && !explicitYear(match[1])) {
    publicationDate = normalizeDatePart(match[1], year - 1);
  }
  return publicationDate && deadlineDate
    ? { publicationDate, deadlineDate }
    : { publicationDate: "", deadlineDate: "" };
}

function localDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function normalizeImportedDates({ publicationDate, deadlineDate, text, referenceDate = new Date() } = {}) {
  const range = extractPublicationDateRange(text);
  let normalizedPublication = range.publicationDate || normalizeDatePart(publicationDate);
  const normalizedDeadline = range.deadlineDate || normalizeDatePart(deadlineDate);
  const today = localDateOnly(referenceDate);

  if (today && normalizedPublication > today) normalizedPublication = "";
  return { publicationDate: normalizedPublication, deadlineDate: normalizedDeadline };
}

export function cleanImportedAddress(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+box(?:\s+box[-\w]+){1,20}["']?(?:\s+[\s\S]*)?$/i, "")
    .replace(/\s+data-[\w-]+\s*=\s*["'][\s\S]*$/i, "")
    .replace(/\s+(?:Gegen das obenstehende|Gegen dieses Baugesuch|Einsprachen sind|Die öffentliche Auflage)\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,;:–—-]+$/, "")
    .trim();
}
