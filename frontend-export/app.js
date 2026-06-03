import {
  buildReadableAddress,
  escapeHtml,
  formatDate,
  formatDateTime,
  normalizeWhitespace,
  truncateText
} from "./format.js";
import {
  municipalityDigitalStatusLabels,
  municipalitySourceTypeLabels,
  protectionStatusLabels,
  quickFilterLabels,
  quickFilterNames,
  workflowStatusLabels
} from "./labels.js";
import { elements, mapState, state } from "./dom.js";
import {
  setLoginError,
  setRegisterError,
  setMasterSetupError,
  setMasterSetupSuccess,
  setForgotPasswordError,
  setForgotPasswordSuccess,
  setResetPasswordError,
  setResetPasswordSuccess,
  showToast,
  focusWithoutScroll,
  withBusyState,
  setTwoFactorError,
  setTwoFactorSuccess,
  closeConfirmDialog,
  openConfirmDialog
} from "./ui.js";

const DEFAULT_STALE_DEADLINE_DAYS = 30;
const DEFAULT_STALE_PUBLICATION_DAYS = 45;
const DEFAULT_AMBIGUOUS_INCLUDE_DAYS = 3;
const globalScrapingSourceTypes = new Set(["html", "xml", "pdf"]);

// --- Cloudflare Turnstile (Bot-Schutz) ---------------------------------------
// Wird nur aktiv, wenn der Server in /api/auth/config einen Site-Key meldet.
let turnstileConfig = { enabled: false, siteKey: "" };
let turnstileScriptPromise = null;
const turnstileWidgets = {}; // slotId -> { widgetId, token }

function loadTurnstileScript() {
  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("Turnstile konnte nicht geladen werden.")));
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

async function ensureTurnstileWidget(slotElement) {
  if (!turnstileConfig.enabled || !slotElement) {
    return;
  }

  try {
    await loadTurnstileScript();
  } catch {
    return;
  }

  if (!window.turnstile) {
    return;
  }

  slotElement.classList.remove("hidden");
  const slotId = slotElement.id;
  const existing = turnstileWidgets[slotId];

  if (existing && existing.widgetId !== undefined) {
    window.turnstile.reset(existing.widgetId);
    existing.token = "";
    return;
  }

  const entry = { widgetId: undefined, token: "" };
  entry.widgetId = window.turnstile.render(slotElement, {
    sitekey: turnstileConfig.siteKey,
    callback: (token) => {
      entry.token = token;
    },
    "expired-callback": () => {
      entry.token = "";
    },
    "error-callback": () => {
      entry.token = "";
    }
  });
  turnstileWidgets[slotId] = entry;
}

function turnstileToken(slotId) {
  return turnstileWidgets[slotId]?.token ?? "";
}

async function loadAuthConfig() {
  try {
    const config = await requestJson("/api/auth/config", { skipSessionReset: true });

    if (config?.turnstile?.enabled && config.turnstile.siteKey) {
      turnstileConfig = { enabled: true, siteKey: config.turnstile.siteKey };
    }
  } catch {
    // Ohne Config laeuft die App wie bisher (kein Bot-Schutz im Frontend).
  }
}

const ONLINEKARTEN_URL = "https://www.ag.ch/geoportal/apps/onlinekarten/";
const ONLINEKARTEN_OVERVIEW_URL =
  "https://www.ag.ch/de/themen/planen-bauen/raumentwicklung/grundlagen-und-kantonalplanung/online-karten";
const ONLINEKARTEN_BASEMAP = "base_landeskarten_sw::topicmaps.geo.ag.ch,1,true";
const ONLINEKARTEN_LAYERS = {
  area: "are_isos::topicmaps.geo.ag.ch;1;true",
  point: "dp_denkmalpflege::topicmaps.geo.ag.ch;1;true"
};
const ONLINEKARTEN_IDENTIFY_TOLERANCE = 50;
const rememberedUsernameStorageKey = "heimatschutz-remembered-username";
const defaultRequestTimeoutMs = 60000;



let searchTimeoutId = null;


function isMasterUser(user = state.currentUser) {
  return user?.role === "Master";
}

function updateMasterUi() {
  const masterVisible = isMasterUser();
  elements.toggleAdminPanelButton.classList.toggle("hidden", !masterVisible);
  elements.masterAccessPanel.classList.toggle("hidden", !masterVisible || !state.adminPanelExpanded);
  elements.toggleAdminPanelButton.textContent = state.adminPanelExpanded ? "Verwaltung ausblenden" : "Verwaltung einblenden";
  elements.toggleAdminPanelButton.setAttribute("aria-pressed", String(state.adminPanelExpanded));
}

function setAuthenticatedUser(user) {
  state.currentUser = user;
  elements.authShell.classList.toggle("hidden", Boolean(user));
  elements.appShell.classList.toggle("hidden", !user);
  elements.sessionUserName.textContent = user?.displayName ?? "-";
  elements.sessionUserRole.textContent = user?.role ?? "-";
  updateMasterUi();

  if (user) {
    setLoginError("");
    setRegisterError("");
  } else {
    state.dashboard = null;
    state.loadedItems = [];
    state.items = [];
    state.comments = [];
    state.registrationKeys = [];
    state.adminUsers = [];
    state.municipalitySources = [];
    state.municipalitySourceCatalog = [];
    state.municipalitySourceReport = null;
    state.sharedPublicationSources = [];
    state.municipalitySourceSummary = null;
    state.municipalitySourceSearch = "";
    state.selectedMunicipalitySourceId = null;
    state.syncSettings = null;
    state.selectedId = null;
    state.adminPanelExpanded = false;
    elements.loginPassword.value = "";
    clearRegisterForm();
    elements.manualImportJsonInput.value = "";
    elements.syncSourceTypeSelect.value = "";
    elements.syncSourceMunicipalityInput.value = "";
    elements.syncSourceUrlInput.value = "";
    elements.syncSourceTokenInput.value = "";
    elements.syncSettingsStatus.textContent = "Noch keine automatische Import-Quelle gespeichert.";
    elements.municipalitySourceSearchInput.value = "";
    renderRegistrationKeys([]);
    renderAdminUsers([]);
    renderMunicipalitySources();
  }
}

function getAssigneeValue() {
  return elements.detailAssignee.value.trim() || state.currentUser?.displayName || "";
}

function loadRememberedUsername() {
  const rememberedUsername = localStorage.getItem(rememberedUsernameStorageKey) ?? "";
  elements.loginUsername.value = rememberedUsername;
  elements.rememberUsernameCheckbox.checked = Boolean(rememberedUsername);
}

function persistRememberedUsername() {
  if (!elements.rememberUsernameCheckbox.checked) {
    localStorage.removeItem(rememberedUsernameStorageKey);
    return;
  }

  const username = elements.loginUsername.value.trim().toLowerCase();

  if (username) {
    localStorage.setItem(rememberedUsernameStorageKey, username);
  }
}



function clearRegisterForm() {
  elements.registerDisplayName.value = "";
  elements.registerUsername.value = "";
  elements.registerEmail.value = "";
  elements.registerPassword.value = "";
  elements.registerAccessKey.value = "";
}

function clearAdminPasswordResetForm() {
  elements.adminUserSelect.value = "";
  elements.adminPasswordResetInput.value = "";
}

function clearMunicipalitySourceForm() {
  elements.municipalitySourceCurrentLabel.textContent = "Bitte links eine Gemeinde auswählen.";
  elements.municipalityOfficialWebsiteLabel.textContent = "-";
  elements.municipalityPrimarySourceLabel.textContent = "-";
  elements.municipalityRatingBadge.textContent = "-";
  elements.municipalityRatingBadge.className = "badge neutral";
  elements.municipalityRatingRationale.textContent = "-";
  elements.municipalitySharedSourceLabel.textContent = "-";
  elements.municipalitySupplementalSourcesLabel.textContent = "-";
  elements.municipalityOfficialWebsiteLink.href = "#";
  elements.municipalityPrimarySourceLink.href = "#";
  elements.municipalityOfficialWebsiteLink.classList.add("hidden");
  elements.municipalityPrimarySourceLink.classList.add("hidden");
  elements.municipalitySourceTypeSelect.value = "manual";
  elements.municipalitySourceDigitalStatusSelect.value = "unknown";
  elements.municipalitySourceEnabledCheckbox.checked = false;
  elements.municipalitySourceUrlInput.value = "";
  elements.municipalitySourceTokenInput.value = "";
  elements.municipalitySourceIncludePatternInput.value = "";
  elements.municipalitySourceExcludePatternInput.value = "";
  elements.municipalitySourceNotesInput.value = "";
  elements.saveMunicipalitySourceButton.disabled = true;
}

function extractProjectFromDescription(description) {
  const normalized = normalizeWhitespace(description);

  if (!normalized) {
    return "";
  }

  const patterns = [
    /Bauobjekt:\s*(.+?)(?:\s+Bauplatz:|$)/i,
    /Bauvorhaben:\s*(.+?)(?:\s+Bauplatz:|$)/i,
    /Projekt:\s*(.+?)(?:\s+Bauplatz:|$)/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match?.[1]) {
      return normalizeWhitespace(match[1]);
    }
  }

  return "";
}

function buildReadableProjectType(item, { forList = false } = {}) {
  const address = normalizeWhitespace(item.address);
  const addressLower = address.toLowerCase();
  let value = normalizeWhitespace(item.projectType);

  if (!value) {
    value = extractProjectFromDescription(item.description);
  }

  if (!value) {
    return "";
  }

  value = value
    .replace(/\bVorlesen\b/gi, "")
    .replace(/\bHerunterladen\b/gi, "")
    .replace(/\S+\.pdf\b/gi, "")
    .replace(/\s+Auflagefrist.+$/i, "")
    .replace(/\(\s*\)/g, "")
    .replace(/["“”']/g, "")
    .replace(/\s*[(),;:\-]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (/\\|\/|\.(?:pln|dwg|dxf|ifc|pdf)\b/i.test(value)) {
    const projectKeywordMatch = value.match(/\b(?:Bauprojekt|Bauvorhaben)\b\s+(.+)/i);

    if (projectKeywordMatch?.[1]) {
      value = projectKeywordMatch[1];
    }

    value = value
      .replace(/\b\d{4}\s+[A-ZÄÖÜ][\wÄÖÜäöüéèà .'-]+?\s+1:\d+\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
      .replace(/\b1:\d+\s+\d{1,2}\.\d{1,2}\.20\d{2}.*$/i, "")
      .replace(/\b\d{1,2}\.\d{1,2}\.20\d{2}\s+[A-Z]{2,}.*$/i, "")
      .replace(/^[\\/\w.-]+\.(?:pln|dwg|dxf|ifc|pdf)\b\s*/i, "")
      .replace(/\s*[,;:\-]+\s*$/g, "")
      .trim();
  }

  if (address && value.toLowerCase().startsWith(`${addressLower} `)) {
    value = value.slice(address.length).trim();
  }

  if (/BG \d{4}\.\d{3}/i.test(value) && item.description) {
    const extracted = extractProjectFromDescription(item.description);
    if (extracted) {
      value = extracted;
    }
  }

  if ((value.match(/BG \d{4}\.\d{3}/gi) ?? []).length > 1) {
    const extracted = extractProjectFromDescription(item.description);
    value = extracted || "";
  }

  if (/Baugesuch, /i.test(value) && address) {
    value = value.replace(/^Baugesuch,\s*/i, "");
  }

  // Kein echtes Bauvorhaben, sondern ein Behörden-/Seitentitel aus dem Scrape
  // (z. B. "Gemeinderat Birmenstorf", "Amtliche Publikationen") -> verwerfen.
  const headingNoisePattern =
    /^(?:gemeinderat|gemeinde(?:rat|kanzlei|verwaltung)?|stadt(?:rat|kanzlei|verwaltung)?|einwohnergemeinde|ortsb[üu]rgergemeinde|amtliche publikation(?:en)?|publikation(?:en)?|aktuelles|news|baugesuche?|baupublikation(?:en)?)\b/i;
  const municipalityName = normalizeWhitespace(item.municipality ?? "");

  if (
    headingNoisePattern.test(value) ||
    (municipalityName && value.toLowerCase().includes(municipalityName.toLowerCase()) && value.length <= municipalityName.length + 14)
  ) {
    value = extractProjectFromDescription(item.description) || "";
  }

  // Einzelnes kurzes Wortfragment ohne Projektbezug (z. B. ein Name aus URL/Titel
  // wie "Testuz") ist kein Bauvorhaben -> verwerfen.
  if (
    /^[^\s]{1,14}$/.test(value) &&
    !/\d/.test(value) &&
    !/(bau|umbau|neubau|anbau|sanierung|umnutzung|abbruch|ersatz|garage|carport|pool|dach|fenster|fassade|wärmepumpe|wärmepumpe|photovoltaik|\bpv\b|gestaltungsplan|reklame|installation|terrasse|balkon|zaun|mauer|heizung)/i.test(value)
  ) {
    value = extractProjectFromDescription(item.description) || "";
  }

  if (!value || value.toLowerCase() === addressLower) {
    value = extractProjectFromDescription(item.description);
  }

  value = normalizeWhitespace(value);

  if (!value || value.toLowerCase() === addressLower) {
    return "";
  }

  return forList ? truncateText(value, 92) : value;
}

function formatNaturalList(values) {
  if (!values.length) {
    return "";
  }

  if (values.length === 1) {
    return values[0];
  }

  if (values.length === 2) {
    return `${values[0]} und ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")} und ${values[values.length - 1]}`;
}

function protectionStatusClass(status) {
  if (status === "no-hit") {
    return "ok";
  }

  if (status === "manual-review") {
    return "danger";
  }

  return "alert";
}

function isExactAddressReview(item) {
  return Boolean(item?.ambiguousAddress) && hasStreetLikeAddress(item);
}

function buildProtectionBadgeLabel(item) {
  if (isExactAddressReview(item)) {
    return "Adresse prüfen";
  }

  if (item?.ambiguousAddress) {
    return "Standort prüfen";
  }

  return humanizeAgisMatch(item?.agisMatch, false);
}

function buildProtectionBadgeClass(item) {
  if (isExactAddressReview(item)) {
    return "alert";
  }

  if (item?.ambiguousAddress) {
    return "danger";
  }

  return protectionStatusClass(item?.protectionStatus);
}

function workflowClass(status) {
  if (status === "cleared") {
    return "ok";
  }

  if (status === "archived") {
    return "neutral";
  }

  return "neutral";
}

function markerTone(status) {
  if (status === "neutral") {
    return "neutral";
  }

  if (status === "manual-review") {
    return "danger";
  }

  if (status === "no-hit") {
    return "ok";
  }

  return "alert";
}

function normalizeLayerName(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u")
    .replaceAll("é", "e")
    .replaceAll("è", "e")
    .replaceAll("à", "a");
}

function isOpenWorkflow(status) {
  return status !== "cleared" && status !== "archived";
}

function humanizeAgisMatch(match, ambiguousAddress) {
  if (ambiguousAddress) {
    return "Manuell prüfen";
  }

  if (match === "Kein Schutztreffer") {
    return "Kein Schutz";
  }

  if (match === "ISOS-Fläche und Gebäude im Inventar" || match === "ISOS-Fläche und Gebäude im Inventar") {
    return "Gebäude + Gebiet";
  }

  if (match === "Treffer im Gebäudeinventar" || match === "Treffer im Gebäudeinventar") {
    return "Gebäude geschützt";
  }

  if (match === "Treffer in ISOS-Fläche" || match === "Treffer in ISOS-Fläche") {
    return "Gebiet geschützt";
  }

  if (match === "Noch nicht eindeutig zugeordnet" || match === "Zuordnung offen") {
    return "Manuell prüfen";
  }

  return match;
}

function humanizeAgisLayer(layer) {
  if (layer === "Gebäude im Inventar" || layer === "Gebäude im Inventar") {
    return "Geschütztes Gebäude";
  }

  if (layer === "ISOS-Fläche" || layer === "ISOS-Fläche") {
    return "Geschützte Umgebung";
  }

  return layer;
}

function humanizeSourceLabel(source) {
  if (!source) {
    return "Quelle offen";
  }

  if (source === "Gemeinde-Webseite") {
    return "Gemeindequelle";
  }

  if (source === "Gemeinde-Import") {
    return "Gemeindeimport";
  }

  if (source === "JSON-Datei" || source === "JSON-Import") {
    return "JSON-Import";
  }

  if (source === "ArcGIS / AGIS") {
    return "AGIS";
  }

  return source;
}

function getCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

  function startOfDay(dateValue) {
    const date = new Date(dateValue);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function getReferenceDate() {
    return startOfDay(new Date());
  }

function getDaysUntilDeadline(deadlineDate) {
  if (!deadlineDate) {
    return null;
  }

  const deadline = startOfDay(deadlineDate);
  const referenceDate = getReferenceDate();
  return Math.round((deadline - referenceDate) / 86400000);
}

function buildDeadlineHint(item) {
  const daysUntilDeadline = getDaysUntilDeadline(item.deadlineDate);

  if (daysUntilDeadline === null) {
    return {
      text: "Keine Frist vorhanden",
      tone: "neutral"
    };
  }

  if (item.workflowStatus === "cleared" || item.workflowStatus === "archived") {
    return {
      text: `Frist: ${formatDate(item.deadlineDate)}`,
      tone: "neutral"
    };
  }

  if (daysUntilDeadline < 0) {
    return {
      text: `Frist abgelaufen seit ${Math.abs(daysUntilDeadline)} Tag${Math.abs(daysUntilDeadline) === 1 ? "" : "en"}`,
      tone: "danger"
    };
  }

  if (daysUntilDeadline === 0) {
    return {
      text: "Frist endet heute",
      tone: "danger"
    };
  }

  if (daysUntilDeadline <= 3) {
    return {
      text: `Frist in ${daysUntilDeadline} Tag${daysUntilDeadline === 1 ? "" : "en"}`,
      tone: "danger"
    };
  }

  if (daysUntilDeadline <= 7) {
    return {
      text: `Frist in ${daysUntilDeadline} Tag${daysUntilDeadline === 1 ? "" : "en"}`,
      tone: "alert"
    };
  }

  return {
    text: `Frist am ${formatDate(item.deadlineDate)}`,
    tone: "ok"
  };
}

function buildRecommendation(item) {
  if (item.ambiguousAddress || item.protectionStatus === "manual-review") {
    if (hasExactAddressWithoutCoordinates(item)) {
      return {
        title: "Standort kurz prüfen",
        text: "Die Adresse ist vorhanden, konnte aber nicht automatisch einem amtlichen Koordinatenpunkt zugeordnet werden."
      };
    }

    return {
      title: "Standort klären",
      text: "Die automatische Zuordnung war nicht eindeutig. Bitte Adresse oder Parzelle prüfen."
    };
  }

  if (item.protectionStatus === "combined-hit") {
    return {
      title: "Punkt und Fläche erkannt",
      text: "Der Standort liegt bei einem geschützten Objekt und gleichzeitig in einer geschützten Fläche."
    };
  }

  if (item.protectionStatus === "protected-point") {
    return {
      title: "Geschützter Punkt erkannt",
      text: "Der Standort liegt bei einem geschützten Punkt beziehungsweise Inventarobjekt."
    };
  }

  if (item.protectionStatus === "protected-zone") {
    return {
      title: "Geschützte Fläche erkannt",
      text: "Der Standort liegt in einer geschützten Fläche beziehungsweise in einem geschützten Bereich."
    };
  }

  return {
    title: "Kein Treffer erkannt",
    text: "Aktuell liegt der Standort weder bei einem geschützten Punkt noch in einer geschützten Fläche."
  };
}

function isImportantCase(item) {
  return (
    item.protectionStatus === "protected-point" ||
    item.protectionStatus === "protected-zone" ||
    item.protectionStatus === "combined-hit"
  );
}

function isManualCase(item) {
  return item.ambiguousAddress || item.protectionStatus === "manual-review";
}

function isDueSoonCase(item) {
  const daysUntilDeadline = getDaysUntilDeadline(item.deadlineDate);
  return isOpenWorkflow(item.workflowStatus) && daysUntilDeadline !== null && daysUntilDeadline >= 0 && daysUntilDeadline <= 7;
}

function getDaysSinceDate(dateValue) {
  if (!dateValue) {
    return null;
  }

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function isStaleWorklistCase(item) {
  if (!isOpenWorkflow(item.workflowStatus)) {
    return true;
  }

  const daysUntilDeadline = getDaysUntilDeadline(item.deadlineDate);

  if (daysUntilDeadline !== null) {
    return daysUntilDeadline < -DEFAULT_STALE_DEADLINE_DAYS;
  }

  const daysSincePublication = getDaysSinceDate(item.publicationDate);

  return daysSincePublication !== null && daysSincePublication > DEFAULT_STALE_PUBLICATION_DAYS;
}

function hasExplicitFieldFilters() {
  return Object.values(state.filters).some((value) => Boolean(value));
}

function shouldUseDefaultWorklistScope() {
  return !hasExplicitFieldFilters() && getActiveQuickFilters().includes("all");
}

function hasStreetLikeAddress(item) {
  const value = normalizeWhitespace(item.address ?? "");

  if (!value || /^parzelle\b/i.test(value)) {
    return false;
  }

  return /\d/.test(value);
}

function hasExactAddressWithoutCoordinates(item) {
  return Boolean(item?.ambiguousAddress) && hasStreetLikeAddress(item) && !parseSwissCoordinates(item?.coordinates ?? "");
}

function isNearDeadline(item, days = DEFAULT_AMBIGUOUS_INCLUDE_DAYS) {
  const daysUntilDeadline = getDaysUntilDeadline(item?.deadlineDate);
  return Number.isFinite(daysUntilDeadline) && daysUntilDeadline >= 0 && daysUntilDeadline <= days;
}

function isCurrentWorklistCase(item) {
  if (isStaleWorklistCase(item) || !isOpenWorkflow(item.workflowStatus)) {
    return false;
  }

  const daysUntilDeadline = getDaysUntilDeadline(item.deadlineDate);
  if (Number.isFinite(daysUntilDeadline) && daysUntilDeadline < 0) {
    return false;
  }

  if (item.protectionStatus !== "manual-review" && !item.ambiguousAddress) {
    return true;
  }

  if (item.protectionStatus !== "manual-review") {
    return true;
  }

  if (isNearDeadline(item)) {
    return true;
  }

  if (item.workflowStatus !== "new") {
    return true;
  }

  return hasStreetLikeAddress(item);
}

function isWorklistEligibleCase(item) {
  if (isStaleWorklistCase(item) || !isOpenWorkflow(item.workflowStatus)) {
    return false;
  }

  const daysUntilDeadline = getDaysUntilDeadline(item.deadlineDate);

  return !(Number.isFinite(daysUntilDeadline) && daysUntilDeadline < 0);
}

function buildVisibleItems(items) {
  // "Alle / Archiv" zeigt jeden erfassten Fall, auch überfällige und aeltere,
  // ohne die Arbeitslisten-Eingrenzung.
  if (getActiveQuickFilters().includes("archive")) {
    return applyQuickFilter(items);
  }

  const activeItems = items.filter((item) => isWorklistEligibleCase(item));
  const baseItems = shouldUseDefaultWorklistScope()
    ? activeItems.filter((item) => isCurrentWorklistCase(item))
    : activeItems;

  return applyQuickFilter(baseItems);
}

function normalizeQuickFilters(filters) {
  const normalized = [...new Set((Array.isArray(filters) ? filters : [filters]).filter(Boolean))];

  if (!normalized.length || normalized.includes("all")) {
    return ["all"];
  }

  return normalized;
}

function getActiveQuickFilters() {
  return normalizeQuickFilters(state.quickFilters);
}

function setQuickFilters(filters) {
  state.quickFilters = normalizeQuickFilters(filters);
}

function toggleQuickFilter(filterKey) {
  if (filterKey === "all") {
    setQuickFilters(["all"]);
    return;
  }

  const currentFilters = getActiveQuickFilters().filter((filter) => filter !== "all");
  const nextFilters = currentFilters.includes(filterKey)
    ? currentFilters.filter((filter) => filter !== filterKey)
    : [...currentFilters, filterKey];

  setQuickFilters(nextFilters);
}

function buildActiveQuickFilterText() {
    const activeFilters = getActiveQuickFilters();

    if (activeFilters.includes("all")) {
      return shouldUseDefaultWorklistScope()
        ? "Aktuell: offene und aktuelle Fälle."
        : "Aktuell: gefilterte Baugesuche.";
    }

    const filterNames = activeFilters.map((filter) => quickFilterNames[filter]).filter(Boolean);

    if (filterNames.length > 1) {
      return `Aktiv: ${formatNaturalList(filterNames)}.`;
    }

    return `Aktiv: ${filterNames[0]}.`;
  }

function applyQuickFilter(items) {
  const activeFilters = getActiveQuickFilters();

  if (activeFilters.includes("all")) {
    return items;
  }

  return items.filter((item) => {
    if (activeFilters.includes("important") && !isImportantCase(item)) {
      return false;
    }

    if (activeFilters.includes("manual") && !isManualCase(item)) {
      return false;
    }

    if (activeFilters.includes("open") && !isOpenWorkflow(item.workflowStatus)) {
      return false;
    }

    if (activeFilters.includes("due-soon") && !isDueSoonCase(item)) {
      return false;
    }

    return true;
  });
}

  function parseSwissCoordinates(coordinates) {
    if (!coordinates) {
      return null;
    }

    const [firstValue, secondValue] = coordinates.split(",").map((value) => Number(value.trim()));

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

function hasProtectedBuilding(item) {
  const normalizedLayers = (item.agisLayers ?? []).map((layer) => normalizeLayerName(layer));

  return (
    item.protectionStatus === "protected-point" ||
    item.protectionStatus === "combined-hit" ||
    normalizedLayers.some((layer) => layer.includes("inventar") || layer.includes("gebaude"))
  );
}

function hasProtectedArea(item) {
  const normalizedLayers = (item.agisLayers ?? []).map((layer) => normalizeLayerName(layer));

  return (
    item.protectionStatus === "protected-zone" ||
    item.protectionStatus === "combined-hit" ||
    normalizedLayers.some((layer) => layer.includes("isos") || layer.includes("ortsbild") || layer.includes("umgebung"))
  );
}

function buildAgisDataLink(item) {
  const coordinates = parseSwissCoordinates(item.coordinates);

  if (!coordinates) {
    return null;
  }

  const url = new URL(ONLINEKARTEN_URL);
  const activeLayers = [ONLINEKARTEN_LAYERS.area, ONLINEKARTEN_LAYERS.point].join("|");

  url.searchParams.set("layers", activeLayers);
  url.searchParams.set("basemap", ONLINEKARTEN_BASEMAP);
  url.searchParams.set("center", `${coordinates.east.toFixed(2)},${coordinates.north.toFixed(2)}`);
  url.searchParams.set("z", hasProtectedBuilding(item) ? "11" : "10");
  url.searchParams.set(
    "info",
    `${coordinates.east.toFixed(2)},${coordinates.north.toFixed(2)},${ONLINEKARTEN_IDENTIFY_TOLERANCE}`
  );

  return url.toString();
}

function buildDataLinkLabel(item) {
  if (hasProtectedBuilding(item)) {
    return "Inventar-Karte mit Standort öffnen";
  }

  if (hasProtectedArea(item)) {
    return "Ortsbild-Karte mit Standort öffnen";
  }

  return "AGIS-Karte mit Standort öffnen";
}

function buildSourceLinkLabel(item) {
  if (!item.sourceUrl) {
    return "";
  }

  const sourceUrl = String(item.sourceUrl).toLowerCase();

  if (item.source === "Amtsblatt" || sourceUrl.includes("amtsblatt.ag.ch")) {
    return "Amtsblatt öffnen";
  }

  if (sourceUrl.includes("/geoportal") || sourceUrl.includes("/online-karten")) {
    return "Übersichtsseite öffnen";
  }

  return "Quelle öffnen";
}

function buildSourceLink(item) {
  if (item.source === "Gemeindeseite" || item.source === "Gemeinde-Webseite" || item.source === "Gemeinde-Import") {
    return item.sourceUrl ?? ONLINEKARTEN_OVERVIEW_URL;
  }

  return item.sourceUrl ?? "";
}

function formatSwissCoordinates(coordinates) {
  const numberFormatter = new Intl.NumberFormat("de-CH");
  return `Koordinaten: ${numberFormatter.format(coordinates.east)} / ${numberFormatter.format(coordinates.north)}`;
}

  function swissToLatLng(coordinates) {
  if (!window.proj4) {
    return null;
  }

  if (!mapState.projectionReady) {
    window.proj4.defs(
      "EPSG:2056",
      "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs"
    );
    mapState.projectionReady = true;
  }

    const [longitude, latitude] = window.proj4("EPSG:2056", "WGS84", [coordinates.east, coordinates.north]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    const isInsideSwissBounds = latitude >= 45 && latitude <= 48.5 && longitude >= 5 && longitude <= 11;
    if (!isInsideSwissBounds) {
      return null;
    }

    return {
      latitude,
      longitude
  };
}

function swissPairToLatLng(pair) {
  const east = Number(pair?.[0]);
  const north = Number(pair?.[1]);

  if (!Number.isFinite(east) || !Number.isFinite(north)) {
    return null;
  }

  const position = swissToLatLng({ east, north });
  return position ? [position.latitude, position.longitude] : null;
}

function swissRingToLatLngs(ring) {
  return (ring ?? []).map((pair) => swissPairToLatLng(pair)).filter(Boolean);
}

function swissPolygonPartsToLatLngs(parts) {
  return (parts ?? [])
    .map((polygon) => polygon.map((ring) => swissRingToLatLngs(ring)).filter((ring) => ring.length >= 3))
    .filter((polygon) => polygon.length > 0);
}

function buildAreaPopup(feature) {
  const title = feature.properties?.title?.trim();
  const lines = [];

  if (feature.properties?.layerLabel) {
    lines.push(`<strong>${escapeHtml(feature.properties.layerLabel)}</strong>`);
  }

  if (title) {
    lines.push(escapeHtml(title));
  }

  if (feature.properties?.category) {
    lines.push(`Kategorie: ${escapeHtml(feature.properties.category)}`);
  }

  if (feature.properties?.significance) {
    lines.push(`Bedeutung: ${escapeHtml(feature.properties.significance)}`);
  }

  if (feature.properties?.preservationTarget) {
    lines.push(`Erhaltungsziel: ${escapeHtml(feature.properties.preservationTarget)}`);
  }

  return lines.join("<br>");
}

function buildPointPopup(feature) {
  const title = feature.properties?.title?.trim();
  const lines = [];

  if (feature.properties?.layerLabel) {
    lines.push(`<strong>${escapeHtml(feature.properties.layerLabel)}</strong>`);
  }

  if (title) {
    lines.push(escapeHtml(title));
  }

  if (feature.properties?.municipality || feature.properties?.address) {
    const placeText = [feature.properties?.municipality, feature.properties?.address].filter(Boolean).join(", ");
    lines.push(escapeHtml(placeText));
  }

  if (feature.properties?.reference) {
    lines.push(`Referenz: ${escapeHtml(feature.properties.reference)}`);
  }

  return lines.join("<br>");
}

function ensureMap() {
  if (mapState.instance || !elements.detailMap || !window.L) {
    return mapState.instance;
  }

  mapState.instance = window.L.map(elements.detailMap, {
    zoomControl: false,
    scrollWheelZoom: false
  });

  window.L.control.zoom({ position: "bottomright" }).addTo(mapState.instance);

  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(mapState.instance);

  mapState.marker = window.L.marker([47.3925, 8.0442], {
    icon: createLocationMarkerIcon()
  }).addTo(mapState.instance);
  mapState.overlayGroup = window.L.featureGroup().addTo(mapState.instance);

  return mapState.instance;
}

function createLocationMarkerIcon() {
  if (!window.L) {
    return null;
  }

  return window.L.divIcon({
    className: "custom-map-marker location-marker",
    html: '<span class="map-pin location"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -22]
  });
}

function clearMapOverlays() {
  mapState.overlayGroup?.clearLayers();
}

function getAreaLayerStyle(layerKey) {
  switch (layerKey) {
    case "municipality-zone":
      return {
        color: "#4b8b58",
        fillColor: "#8fd38e",
        fillOpacity: 0.2,
        weight: 1.6
      };
    case "zone-part":
      return {
        color: "#7e63a8",
        fillColor: "#c6b3e8",
        fillOpacity: 0.28,
        weight: 1.8
      };
    case "hint-zone":
      return {
        color: "#5d2d82",
        fillColor: "#8a52b4",
        fillOpacity: 0.36,
        weight: 1.8
      };
    case "perimeter-zone":
      return {
        color: "#8a7b63",
        fillColor: "#d8cfbc",
        fillOpacity: 0.18,
        weight: 1.4,
        dashArray: "6 4"
      };
    default:
      return {
        color: getCssVariable("--map-area-stroke"),
        fillColor: getCssVariable("--map-area-fill"),
        fillOpacity: 0.24,
        weight: 2
      };
  }
}

function getAreaLayerLegendLabel(layerKey) {
  switch (layerKey) {
    case "municipality-zone":
      return "Ortsbild in der Gemeinde";
    case "zone-part":
      return "Ortsbildteile";
    case "hint-zone":
      return "Hinweiszonen";
    case "perimeter-zone":
      return "PDF-Perimeter";
    default:
      return "Schutzzone";
  }
}

function getLegendSwatchClass(layerKey) {
  switch (layerKey) {
    case "municipality-zone":
      return "municipality";
    case "zone-part":
      return "part";
    case "hint-zone":
      return "hint";
    case "perimeter-zone":
      return "perimeter";
    default:
      return "area";
  }
}

function renderMapLegend(features) {
  const items = ['<span class="map-legend-item"><span class="map-legend-swatch location"></span><span>Standort</span></span>'];

  if (features.points) {
    items.push(
      '<span class="map-legend-item"><span class="map-legend-swatch point"></span><span>Inventarobjekte</span></span>'
    );
  }

  for (const layerKey of features.areaLayerKeys) {
    items.push(
      `<span class="map-legend-item"><span class="map-legend-swatch ${getLegendSwatchClass(layerKey)}"></span><span>${escapeHtml(
        getAreaLayerLegendLabel(layerKey)
      )}</span></span>`
    );
  }

  elements.mapLegend.innerHTML = items.join("");
  elements.mapLegend.classList.toggle("hidden", items.length === 0);
}

function buildMapOverlays(officialFeatures, markerLatLng) {
  const map = ensureMap();
  const displayAreaFeatures =
    officialFeatures.displayAreaFeatures?.length > 0 ? officialFeatures.displayAreaFeatures : officialFeatures.areaFeatures;
  const displayPointFeatures =
    officialFeatures.displayPointFeatures?.length > 0 ? officialFeatures.displayPointFeatures : officialFeatures.pointFeatures;
  const features = {
    area: displayAreaFeatures.length > 0,
    points: displayPointFeatures.length > 0,
    matchedArea: officialFeatures.areaFeatures.length > 0,
    matchedPoints: officialFeatures.pointFeatures.length > 0,
    areaLayerKeys: [...new Set(displayAreaFeatures.map((feature) => feature.properties?.layerKey).filter(Boolean))]
  };
  const layersForBounds = [mapState.marker];

  clearMapOverlays();

  for (const areaFeature of displayAreaFeatures) {
    const latLngParts = swissPolygonPartsToLatLngs(areaFeature.parts);

    if (latLngParts.length === 0) {
      continue;
    }

    const polygon = window.L.polygon(
      latLngParts.length === 1 ? latLngParts[0] : latLngParts,
      getAreaLayerStyle(areaFeature.properties?.layerKey)
    );

    const popup = buildAreaPopup(areaFeature);

    if (popup) {
      polygon.bindPopup(popup);
    }

    mapState.overlayGroup.addLayer(polygon);
    layersForBounds.push(polygon);
  }

  for (const pointFeature of displayPointFeatures) {
    const position = swissToLatLng({
      east: pointFeature.coordinates[0],
      north: pointFeature.coordinates[1]
    });

    if (!position) {
      continue;
    }

    const point = window.L.circleMarker([position.latitude, position.longitude], {
      radius: 7,
      color: getCssVariable("--map-point-stroke"),
      fillColor: getCssVariable("--map-point-fill"),
      fillOpacity: 0.92,
      weight: 2
    });

    const popup = buildPointPopup(pointFeature);

    if (popup) {
      point.bindPopup(popup);
    }

    mapState.overlayGroup.addLayer(point);
    layersForBounds.push(point);
  }

  const boundsGroup = window.L.featureGroup(layersForBounds);

  if (boundsGroup.getBounds().isValid()) {
    map.fitBounds(boundsGroup.getBounds(), {
      padding: [28, 28],
      animate: false,
      maxZoom: 17
    });
  } else {
    map.setView(markerLatLng, 17, {
      animate: false
    });
  }

  return features;
}

function describeMapFeatures(features) {
  if (features.matchedArea && features.matchedPoints) {
    return "Direkter AGIS-Treffer: Zonen und Inventarobjekte markiert";
  }

  if (features.matchedArea) {
    return "Direkter AGIS-Zonentreffer markiert";
  }

  if (features.matchedPoints) {
    return "Direkter Inventartreffer markiert";
  }

  if (features.area || features.points) {
    return "Amtliche Schutzlayer in der Umgebung eingeblendet";
  }

  return "Auf der Karte wurde kein AGIS-Treffer gefunden";
}

function updateMapNote(officialFeatures, features) {
  if (!features.area && !features.points) {
    elements.mapSymbolHint.classList.add("hidden");
    elements.mapSymbolHint.textContent = "";
    return;
  }

  const areaNote = features.areaLayerKeys.length > 0 ? "Grün/Lila = amtliche Schutzzonen" : "";
  const pointNote = features.points ? "Rot = Inventarobjekte" : "";
  const parts = ["Blau = Baugesuch", pointNote, areaNote].filter(Boolean);
  elements.mapSymbolHint.textContent = parts.join(" · ");
  elements.mapSymbolHint.classList.remove("hidden");
}

async function requestOfficialMapFeatures(coordinates) {
  const params = new URLSearchParams({
    east: String(coordinates.east),
    north: String(coordinates.north)
  });

  return requestJson(`/api/agis/features?${params.toString()}`);
}

function showMapFallback(message, status, coordinates = "") {
  elements.mapStatusLabel.textContent = status;
  elements.detailCoordinates.textContent = "";
  elements.detailMap.classList.add("hidden");
  elements.mapFallback.textContent = message;
  elements.mapFallback.classList.remove("hidden");
  elements.mapLegend.classList.add("hidden");
  elements.mapLegend.innerHTML = "";
  elements.mapSymbolHint.classList.add("hidden");
  elements.mapSymbolHint.textContent = "";
  clearMapOverlays();
}

async function updateMap(item) {
  mapState.requestToken += 1;
  const requestToken = mapState.requestToken;

  if (!item) {
    showMapFallback("Wählen Sie ein Baugesuch aus, um den Standort zu sehen.", "Noch kein Standort gewählt");
    return;
  }

  const parsedCoordinates = parseSwissCoordinates(item.coordinates);

  if (item.ambiguousAddress || !parsedCoordinates) {
    const hasExactAddress = hasExactAddressWithoutCoordinates(item);
    showMapFallback(
      hasExactAddress
        ? "Die Adresse ist vorhanden, wurde aber nicht automatisch im amtlichen Adressregister gefunden. Bitte Standort kurz prüfen."
        : "Für dieses Gesuch gibt es noch keinen genauen Standort. Bitte Adresse oder Parzelle von Hand prüfen.",
      hasExactAddress ? "Adresse nicht automatisch gefunden" : "Standort muss von Hand geklärt werden"
    );
    return;
  }

  const position = swissToLatLng(parsedCoordinates);

  if (!position) {
    showMapFallback(
      "Die Karte konnte im Moment nicht geladen werden. Die restlichen Angaben stehen trotzdem bereit.",
      "Karte vorübergehend nicht verfügbar",
      formatSwissCoordinates(parsedCoordinates)
    );
    return;
  }

  const map = ensureMap();

  if (!map || !mapState.marker) {
    showMapFallback(
      "Die Karte konnte im Moment nicht geladen werden. Die restlichen Angaben stehen trotzdem bereit.",
      "Karte vorübergehend nicht verfügbar",
      formatSwissCoordinates(parsedCoordinates)
    );
    return;
  }

  elements.mapStatusLabel.textContent = "Standort wird auf der Karte angezeigt";
  elements.detailCoordinates.textContent = "";
  elements.mapFallback.classList.add("hidden");
  elements.detailMap.classList.remove("hidden");

  const latLng = [position.latitude, position.longitude];
  mapState.marker.setIcon(createLocationMarkerIcon());
  mapState.marker.setLatLng(latLng).bindPopup(`<strong>${escapeHtml(item.municipality)}</strong><br>${escapeHtml(item.address)}`);
  map.setView(latLng, 17, {
    animate: false
  });
  clearMapOverlays();
  elements.mapLegend.classList.add("hidden");
  elements.mapLegend.innerHTML = "";
  elements.mapSymbolHint.classList.add("hidden");
  elements.mapSymbolHint.textContent = "";
  elements.mapStatusLabel.textContent = "AGIS-Treffer werden geladen";

  try {
    const officialFeatures = await requestOfficialMapFeatures(parsedCoordinates);

    if (requestToken !== mapState.requestToken) {
      return;
    }

    const features = buildMapOverlays(officialFeatures, latLng);
    elements.mapStatusLabel.textContent = describeMapFeatures(features);
    renderMapLegend(features);
    updateMapNote(officialFeatures, features);
  } catch (error) {
    if (requestToken !== mapState.requestToken) {
      return;
    }

    clearMapOverlays();
    elements.mapLegend.classList.add("hidden");
    elements.mapLegend.innerHTML = "";
    elements.mapStatusLabel.textContent = "AGIS-Daten momentan nicht verfügbar";
    elements.mapSymbolHint.textContent = "";
    elements.mapSymbolHint.classList.add("hidden");
  }

  requestAnimationFrame(() => {
    map.invalidateSize();
  });
}

async function requestJson(url, options = {}) {
  const { skipSessionReset = false, headers, timeoutMs = defaultRequestTimeoutMs, ...fetchOptions } = options;
  const timeoutController = timeoutMs > 0 && !fetchOptions.signal ? new AbortController() : null;
  const timeoutId = timeoutController
    ? setTimeout(() => timeoutController.abort(), timeoutMs)
    : null;
  let response;

  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      signal: timeoutController?.signal ?? fetchOptions.signal,
      ...fetchOptions
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Die Anfrage dauert zu lange. Bitte Verbindung prüfen und erneut versuchen.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let message = "Request failed";
    let payload = null;

    try {
      payload = await response.json();
      message = payload.error ?? message;
    } catch {
      message = await response.text();
    }

    if (response.status === 401 && !skipSessionReset) {
      setAuthenticatedUser(null);
      setLoginError("Ihre Sitzung ist abgelaufen. Bitte erneut anmelden.");
      focusWithoutScroll(elements.loginUsername);
    }

    const requestError = new Error(message);
    requestError.status = response.status;
    requestError.payload = payload;
    throw requestError;
  }

  return response.json();
}

function updateFilterOptions(dashboard) {
  const municipalityOptions = dashboard.municipalities
    .map((municipality) => `<option value="${escapeHtml(municipality)}">${escapeHtml(municipality)}</option>`)
    .join("");
  const protectionOptions = dashboard.protectionStatuses
    .map(
      (status) =>
        `<option value="${escapeHtml(status)}">${escapeHtml(protectionStatusLabels[status] ?? status)}</option>`
    )
    .join("");
  const workflowOptions = dashboard.workflowStatuses
    .map(
      (status) =>
        `<option value="${escapeHtml(status)}">${escapeHtml(workflowStatusLabels[status] ?? status)}</option>`
    )
    .join("");

  elements.municipalitySelect.innerHTML = `<option value="">Alle Gemeinden</option>${municipalityOptions}`;
  elements.protectionStatusSelect.innerHTML = `<option value="">Alle AGIS-Treffer</option>${protectionOptions}`;
  elements.workflowStatusSelect.innerHTML = `<option value="">Alle Team-Status</option>${workflowOptions}`;
  elements.detailWorkflowStatus.innerHTML = workflowOptions;

  elements.municipalitySelect.value = state.filters.municipality;
  elements.protectionStatusSelect.value = state.filters.protectionStatus;
  elements.workflowStatusSelect.value = state.filters.workflowStatus;
}

function updateQuickFilterButtons() {
  const activeFilters = getActiveQuickFilters();

  for (const button of elements.quickFilterButtons) {
    const isActive = activeFilters.includes(button.dataset.quickFilter);
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  elements.activeFilterText.textContent = buildActiveQuickFilterText();
}

function updateFontSizeUi() {
  document.documentElement.classList.toggle("large-text", state.largeTextEnabled);
  document.body.classList.toggle("large-text", state.largeTextEnabled);
  elements.fontSizeToggleButton.textContent = state.largeTextEnabled ? "Normale Schrift" : "Grössere Schrift";
  elements.fontSizeToggleButton.setAttribute("aria-pressed", String(state.largeTextEnabled));
}

function updateThemeUi() {
  document.body.classList.toggle("dark", state.darkModeEnabled);
  if (elements.themeToggleButton) {
    elements.themeToggleButton.textContent = state.darkModeEnabled ? "Hellmodus" : "Dunkelmodus";
    elements.themeToggleButton.setAttribute("aria-pressed", String(state.darkModeEnabled));
  }
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", state.darkModeEnabled ? "dark" : "light");
}

function findNextOpenItem() {
  const openItems = state.items.filter((item) => isOpenWorkflow(item.workflowStatus));

  if (openItems.length === 0) {
    return null;
  }

  const currentIndex = openItems.findIndex((item) => item.id === state.selectedId);

  if (currentIndex === -1) {
    return openItems[0];
  }

  return openItems[(currentIndex + 1) % openItems.length];
}

function updateNavigationUi() {
  const openItems = state.items.filter((item) => isOpenWorkflow(item.workflowStatus));
  const nextOpenItem = findNextOpenItem();
  const currentItemIsOpen = openItems.some((item) => item.id === state.selectedId);
  const canGoNext = Boolean(nextOpenItem) && (openItems.length > 1 || !currentItemIsOpen);
  elements.nextOpenButton.disabled = !canGoNext;
  elements.nextOpenButton.textContent = canGoNext ? "Nächstes offenes Gesuch" : "Kein weiteres offenes Gesuch";
}

function scrollDetailIntoView() {
  if (window.innerWidth <= 1280) {
    document.querySelector("#detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function selectApplication(id, options = {}) {
  state.selectedId = id;
  renderApplications();

  if (options.scrollToDetail) {
    scrollDetailIntoView();
  }
}

function renderDashboard() {
  const dashboard = state.dashboard;

  if (!dashboard) {
    return;
  }

  elements.statTotal.textContent = dashboard.stats.totalApplications;
  elements.statRelevant.textContent = dashboard.stats.relevantApplications;
  elements.statManual.textContent = dashboard.stats.manualReview;
  elements.statDueSoon.textContent = dashboard.stats.dueSoon;
  updateQuickFilterCounts(dashboard.stats);
  state.municipalitySourceSummary = dashboard.municipalitySourcesSummary ?? state.municipalitySourceSummary;
  elements.workspaceLastSyncChip.textContent = `Letzter Sync: ${dashboard.lastSyncAt ? formatDateTime(dashboard.lastSyncAt) : "Noch keiner"}`;
  elements.workspaceSyncModeChip.textContent = `Import: ${dashboard.syncStatus?.configured ? dashboard.syncStatus.sourceLabel : "Demo / manuell"}`;
  elements.workspaceCoverageChip.textContent = `Gemeindequellen: ${dashboard.municipalitySourcesSummary?.enabledCount ?? 0} aktiv`;
  renderNotifications(dashboard.notifications ?? []);
}

// Zähler in den Tab-Filtern (Amtlich-Kopf) aus den Dashboard-Kennzahlen setzen.
function updateQuickFilterCounts(stats) {
  if (!stats) {
    return;
  }

  const counts = {
    all: stats.totalApplications,
    important: stats.relevantApplications,
    manual: stats.manualReview,
    "due-soon": stats.dueSoon
  };

  for (const [filter, value] of Object.entries(counts)) {
    const badge = document.querySelector(`.a-tab-count[data-count-for="${filter}"]`);
    if (badge) {
      badge.textContent = Number.isFinite(value) ? value : 0;
    }
  }
}

function getTotalApplicationCount() {
  return state.dashboard?.stats?.totalApplications ?? state.loadedItems.length;
}

function buildResultCountLabel() {
  const totalCount = getTotalApplicationCount();

  if (shouldUseDefaultWorklistScope()) {
    return `${state.items.length} Arbeitsfälle · ${totalCount} gesamt`;
  }

  if (state.items.length !== totalCount) {
    return `${state.items.length} Treffer · ${totalCount} gesamt`;
  }

  return `${state.items.length} gesamt`;
}

function buildListLocationMeta(item) {
  const details = [];

  if (item.publicationDate) {
    details.push(`Publiziert ${formatDate(item.publicationDate)}`);
  }

  return details.join(" · ");
}

function buildListSourceBadge(item) {
  const label = humanizeSourceLabel(item.source);
  return label === "Gemeindequelle" ? "" : label;
}

function buildListAddressMeta(item) {
  return buildReadableProjectType(item, { forList: true });
}

function buildListAgisMeta(item) {
  if (item.ambiguousAddress && !shouldUseDefaultWorklistScope()) {
    return "Adresse oder Parzelle prüfen";
  }

  if (Array.isArray(item.agisLayers) && item.agisLayers.length) {
    return item.agisLayers.map(humanizeAgisLayer).slice(0, 2).join(" · ");
  }

  return "";
}

function buildListDeadlineMeta(item) {
    const deadlineHint = buildDeadlineHint(item);
    let secondary = "";
    let tone = deadlineHint.tone;

    if (deadlineHint.tone === "danger") {
      const overdueMatch = deadlineHint.text.match(/(\d+)\s+Tagen?/i);
      secondary = overdueMatch ? `${overdueMatch[1]} Tage überfällig` : deadlineHint.text.replace(/^Frist\s+/i, "");
      tone = "overdue";
    } else if (deadlineHint.tone === "alert") {
      secondary = deadlineHint.text.replace(/^Frist\s+/i, "");
    }

    return {
      primary: item.deadlineDate ? formatDate(item.deadlineDate) : "Keine Frist",
      secondary,
      tone
    };
  }

function buildListTeamMeta(item) {
  const assignee = item.assignee?.trim();

  if (assignee) {
    return `Zuständig: ${assignee}`;
  }

  return "";
}

function buildDetailSourceMeta(item) {
  const details = [humanizeSourceLabel(item.source)];

  if (item.publicationDate) {
    details.push(`publiziert ${formatDate(item.publicationDate)}`);
  }

  if (item.sourceUrl) {
    details.push("Quelle verlinkt");
  }

  return details.join(" · ");
}

function buildEmptyStateMessage() {
  if (state.loadedItems.length === 0) {
    if (isMasterUser()) {
      return "Noch keine Baugesuche geladen. Bitte zuerst synchronisieren oder einen Import starten.";
    }

    return "Zurzeit sind noch keine Baugesuche geladen.";
  }

  return "Keine Baugesuche für die aktuellen Filter gefunden.";
}

function renderApplications() {
  updateQuickFilterButtons();
  elements.resultCount.textContent = buildResultCountLabel();

  if (state.items.length === 0) {
    elements.applicationsTableBody.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-row empty-list-state">${escapeHtml(buildEmptyStateMessage())}</div>
        </td>
      </tr>
    `;
    renderDetail(null);
    updateNavigationUi();
    return;
  }

  if (!state.selectedId || !state.items.find((item) => item.id === state.selectedId)) {
    state.selectedId = state.items[0].id;
  }

  elements.applicationsTableBody.innerHTML = state.items
    .map((item) => {
      const agisLabel = buildProtectionBadgeLabel(item);
      const deadlineMeta = buildListDeadlineMeta(item);
      const locationMeta = buildListLocationMeta(item);
      const addressLabel = buildReadableAddress(item, { forList: true });
      const addressMeta = buildListAddressMeta(item);
      const teamMeta = buildListTeamMeta(item);

      return `
        <tr
          class="${[
            item.id === state.selectedId ? "selected-row" : "",
            ["protected-point", "protected-zone", "combined-hit"].includes(item.protectionStatus) ? "protected-row" : ""
          ]
            .filter(Boolean)
            .join(" ")}"
          data-id="${escapeHtml(item.id)}"
          tabindex="0"
          aria-label="${escapeHtml(`${item.municipality}, ${addressLabel}`)}"
        >
          <td data-label="Gemeinde">
            <div class="list-cell-stack">
              <span class="cell-location">${escapeHtml(item.municipality)}</span>
              ${locationMeta ? `<span class="cell-secondary cell-subtle">${escapeHtml(locationMeta)}</span>` : ""}
            </div>
          </td>
          <td data-label="Baugesuch">
            <div class="list-cell-stack">
              <span class="cell-address" title="${escapeHtml(buildReadableAddress(item))}">${escapeHtml(addressLabel)}</span>
              ${addressMeta ? `<span class="cell-secondary">${escapeHtml(addressMeta)}</span>` : ""}
            </div>
          </td>
          <td data-label="Treffer">
            <div class="list-cell-stack">
              <span class="badge ${buildProtectionBadgeClass(item)}">
                ${escapeHtml(agisLabel)}
              </span>
            </div>
          </td>
          <td data-label="Frist">
            <div class="list-cell-stack">
              <span class="cell-date cell-date-strong">${escapeHtml(deadlineMeta.primary)}</span>
              ${deadlineMeta.secondary ? `<span class="deadline-meta ${deadlineMeta.tone}">${escapeHtml(deadlineMeta.secondary)}</span>` : ""}
            </div>
          </td>
          <td data-label="Bearbeitung">
            <div class="list-cell-stack list-cell-team">
              <span class="badge ${workflowClass(item.workflowStatus)}">
                ${escapeHtml(workflowStatusLabels[item.workflowStatus] ?? item.workflowStatus)}
              </span>
              ${teamMeta ? `<span class="cell-secondary cell-subtle">${escapeHtml(teamMeta)}</span>` : ""}
            </div>
          </td>
        </tr>
      `
    })
    .join("");

  const selectedItem = state.items.find((item) => item.id === state.selectedId) ?? null;
  renderDetail(selectedItem);
  updateNavigationUi();
}

function renderDetail(item) {
  if (!item) {
    elements.emptyDetailState.classList.remove("hidden");
    elements.detailContent.classList.add("hidden");
    elements.commentsSection?.classList.add("hidden");
    elements.detailStatusBadge.textContent = "Keine Auswahl";
    elements.detailStatusBadge.className = "tag";
    elements.detailHelperText.textContent = "Hier stehen die wichtigsten Angaben und Ihre Bearbeitung.";
    elements.detailSourceLabel.textContent = "-";
    elements.detailSourceMeta.textContent = "-";
    elements.detailAssessmentLabel.textContent = "-";
    elements.detailRecommendationCompact.textContent = "-";
    elements.detailDeadlineCompact.textContent = "-";
    elements.detailDataLink.classList.add("hidden");
    elements.detailSourceLink.classList.add("hidden");
    renderComments([]);
    updateMap(null);
    return;
  }

  elements.emptyDetailState.classList.add("hidden");
  elements.detailContent.classList.remove("hidden");
  elements.commentsSection?.classList.remove("hidden");
  elements.detailStatusBadge.textContent = buildProtectionBadgeLabel(item);
  elements.detailStatusBadge.className = `tag ${buildProtectionBadgeClass(item)}`;
  elements.detailHelperText.textContent = "Hier stehen die wichtigsten Angaben und Ihre Bearbeitung.";
  elements.detailMunicipality.textContent = item.municipality;
  elements.detailAddress.textContent = buildReadableAddress(item);
  elements.detailParcelFact.textContent = item.parcel ? item.parcel : "–";
  elements.detailPublishedFact.textContent = item.publicationDate ? formatDate(item.publicationDate) : "–";
  elements.detailProjectType.textContent = buildReadableProjectType(item) || "Nicht näher beschrieben";
  elements.detailPublicationDate.textContent = formatDate(item.publicationDate);
  elements.detailLastSyncAt.textContent = item.lastSyncAt ? formatDateTime(item.lastSyncAt) : "-";
  elements.detailDeadlineDate.textContent = formatDate(item.deadlineDate);
  elements.detailAgisMatch.textContent = buildProtectionBadgeLabel(item);
  elements.detailAgisFact.textContent = buildProtectionBadgeLabel(item);
  elements.detailDescription.textContent = item.description;
  elements.detailAutomatedAssessment.textContent = item.automatedAssessment;
  elements.detailWorkflowStatus.value = item.workflowStatus;
  elements.detailAssignee.value = item.assignee?.trim() || state.currentUser?.displayName || "";
  elements.detailNote.value = item.note ?? "";
  elements.detailAssignee.placeholder = state.currentUser?.displayName ?? "Name oder Team";
  elements.commentInput.placeholder = `Zum Beispiel: ${state.currentUser?.displayName ?? "Ich"} habe die Karte geprüft, bitte noch die Unterlagen vergleichen.`;
  const recommendation = buildRecommendation(item);
  const deadlineHint = buildDeadlineHint(item);

  elements.detailRecommendationTitle.textContent = recommendation.title;
  elements.detailRecommendationText.textContent = recommendation.text;
  elements.detailRecommendationCompact.textContent = recommendation.title;
  elements.detailDeadlineCompact.textContent = deadlineHint.text;
  elements.detailDeadlineHint.textContent = deadlineHint.text;
  elements.detailDeadlineHint.className = `badge ${deadlineHint.tone}`;
  elements.detailSourceLabel.textContent = humanizeSourceLabel(item.source);
  elements.detailSourceMeta.textContent = buildDetailSourceMeta(item);
  elements.detailAssessmentLabel.textContent = buildProtectionBadgeLabel(item);
  const dataLink = buildAgisDataLink(item);
  const sourceLink = buildSourceLink(item);
  elements.detailDataLink.href = dataLink ?? "#";
  elements.detailDataLink.textContent = buildDataLinkLabel(item);
  elements.detailDataLink.classList.toggle("hidden", !dataLink);
  elements.detailSourceLink.href = sourceLink || "#";
  elements.detailSourceLink.textContent = buildSourceLinkLabel(item);
  elements.detailSourceLink.classList.toggle("hidden", !sourceLink);

  const badges = [...item.agisLayers];

  if (item.ambiguousAddress) {
    badges.push(hasExactAddressWithoutCoordinates(item) ? "Adresse nicht automatisch gefunden" : "Adresse unklar");
  }

  elements.detailAgisLayers.textContent = badges.map((layer) => humanizeAgisLayer(layer)).join(" · ");
  elements.detailAgisLayers.classList.add("hidden");

  updateMap(item);
  loadComments(item.id).catch((error) => showToast(error.message));
}

function renderComments(comments) {
  state.comments = comments;

  if (!comments.length) {
    elements.commentsList.innerHTML = "";
    elements.commentsEmptyState.classList.remove("hidden");
    elements.commentsSection?.removeAttribute("open");
    return;
  }

  elements.commentsEmptyState.classList.add("hidden");
  elements.commentsSection?.setAttribute("open", "");
  elements.commentsList.innerHTML = comments
    .map((comment) => {
      const isOwnComment = comment.userId === state.currentUser?.id;

      return `
        <article class="comment-card ${isOwnComment ? "own-comment" : ""}">
          <div class="comment-meta">
            <div>
              <strong>${escapeHtml(comment.userDisplayName)}</strong>
              <span class="comment-role">${escapeHtml(comment.userRole ?? "")}</span>
            </div>
            <time datetime="${escapeHtml(comment.createdAt)}">${escapeHtml(formatDateTime(comment.createdAt))}</time>
          </div>
          <p class="comment-message">${escapeHtml(comment.message)}</p>
        </article>
      `;
    })
    .join("");
}

function renderRegistrationKeys(keys) {
  state.registrationKeys = keys;

  if (!isMasterUser()) {
    elements.registrationKeysList.innerHTML = "";
    elements.registrationKeysEmptyState.classList.add("hidden");
    return;
  }

  if (!keys.length) {
    elements.registrationKeysList.innerHTML = "";
    elements.registrationKeysEmptyState.classList.remove("hidden");
    return;
  }

  elements.registrationKeysEmptyState.classList.add("hidden");
  elements.registrationKeysList.innerHTML = keys
      .map((key) => {
        const isAvailable = key.isAvailable && !key.usedAt;
        const statusLabel = isAvailable ? "Offen" : "Verwendet";
        const statusClass = isAvailable ? "ok" : "neutral";
        const noteMarkup = key.note ? `<p class="registration-key-note">${escapeHtml(key.note)}</p>` : "";
        const actionMarkup = isAvailable
          ? `<button class="ghost compact-button registration-key-delete-button" type="button" data-registration-key-id="${escapeHtml(key.id)}">Löschen</button>`
          : "";
        const usageMarkup = key.usedAt
          ? `<p class="registration-key-meta">Bereits verwendet</p>`
          : `<p class="registration-key-meta">Gültig bis ${escapeHtml(formatDateTime(key.expiresAt))}</p>`;

      return `
        <article class="registration-key-card ${isAvailable ? "available" : "used"}">
          <div class="registration-key-header">
            <div>
              <p class="panel-title">Registrierungsschlüssel</p>
              <code class="registration-key-code">${escapeHtml(key.keyCode)}</code>
            </div>
            <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
            ${noteMarkup}
            ${usageMarkup}
            ${actionMarkup}
          </article>
        `;
      })
      .join("");
}

function renderAdminUsers(users) {
  state.adminUsers = users;

  if (!isMasterUser()) {
    elements.adminUserSelect.innerHTML = `<option value="">Person auswählen</option>`;
    return;
  }

  const options = users
    .map(
      (user) =>
        `<option value="${escapeHtml(user.id)}">${escapeHtml(`${user.displayName} (${user.username})`)}</option>`
    )
    .join("");

  elements.adminUserSelect.innerHTML = `<option value="">Person auswählen</option>${options}`;
}

function shortenUrlForDisplay(value) {
  const text = String(value ?? "").trim();

  if (text.length <= 42) {
    return text;
  }

  return `${text.slice(0, 39)}…`;
}

function getRatingBadgeClass(rating) {
  switch (rating) {
    case "A":
      return "ok";
    case "B":
      return "neutral";
    case "C":
      return "alert";
    case "D":
      return "danger";
    default:
      return "neutral";
  }
}

function buildSharedPrimaryText(source) {
  if (!source?.primaryShared) {
    return "Primärquelle ist dieser Gemeinde eindeutig zugeordnet.";
  }

  if (source.primarySharedCount > 1) {
    return `Primärquelle wird von ${source.primarySharedCount} Gemeinden gemeinsam genutzt.`;
  }

  return "Primärquelle wird gemeinsam genutzt.";
}

function buildSupplementalSourcesText(source) {
  if (!source?.supplementalSources?.length) {
    return "Keine zusätzlichen Quellen hinterlegt.";
  }

  return source.supplementalSources
    .map((entry) => `${entry.name} (${entry.sourceKind})`)
    .join(" · ");
}

function getFilteredMunicipalitySources() {
  const search = state.municipalitySourceSearch.trim().toLowerCase();

  if (!search) {
    return state.municipalitySourceCatalog;
  }

  return state.municipalitySourceCatalog.filter((source) =>
    [
      source.municipality,
      source.officialWebsite,
      source.primarySourceName,
      source.primarySourceCanonicalUrl,
      source.primaryDirectUrl,
      source.rating,
      source.rationale,
      source.sharedSourceNote,
      buildSupplementalSourcesText(source),
      source.notes
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search)
  );
}

function populateMunicipalitySourceInsights(source) {
  if (!source) {
    elements.municipalityOfficialWebsiteLabel.textContent = "-";
    elements.municipalityPrimarySourceLabel.textContent = "-";
    elements.municipalityRatingBadge.textContent = "-";
    elements.municipalityRatingBadge.className = "badge neutral";
    elements.municipalityRatingRationale.textContent = "-";
    elements.municipalitySharedSourceLabel.textContent = "-";
    elements.municipalitySupplementalSourcesLabel.textContent = "-";
    elements.municipalityOfficialWebsiteLink.href = "#";
    elements.municipalityPrimarySourceLink.href = "#";
    elements.municipalityOfficialWebsiteLink.classList.add("hidden");
    elements.municipalityPrimarySourceLink.classList.add("hidden");
    return;
  }

  elements.municipalityOfficialWebsiteLabel.textContent = source.officialWebsite || "Keine offizielle Website hinterlegt";
  elements.municipalityOfficialWebsiteLink.href = source.officialWebsite || "#";
  elements.municipalityOfficialWebsiteLink.classList.toggle("hidden", !source.officialWebsite);

  const primarySourceLabel = source.primarySourceCanonicalUrl
    ? `${source.primarySourceName} · ${shortenUrlForDisplay(source.primarySourceCanonicalUrl)}`
    : source.primarySourceName || "Keine Primärquelle hinterlegt";
  elements.municipalityPrimarySourceLabel.textContent = primarySourceLabel;
  elements.municipalityPrimarySourceLink.href = source.primaryDirectUrl || source.primarySourceCanonicalUrl || "#";
  elements.municipalityPrimarySourceLink.classList.toggle(
    "hidden",
    !(source.primaryDirectUrl || source.primarySourceCanonicalUrl)
  );

  elements.municipalityRatingBadge.textContent = source.rating ? `Rating ${source.rating}` : "Ohne Rating";
  elements.municipalityRatingBadge.className = `badge ${getRatingBadgeClass(source.rating)}`;
  elements.municipalityRatingRationale.textContent = source.rationale || "Noch keine Begründung hinterlegt.";
  elements.municipalitySharedSourceLabel.textContent = source.sharedSourceNote || buildSharedPrimaryText(source);
  elements.municipalitySupplementalSourcesLabel.textContent = buildSupplementalSourcesText(source);
}

function renderMunicipalityCoverageReport(report = null) {
  const safeReport = report ?? {
    totalMunicipalities: 0,
    totalUniqueSources: 0,
    municipalitiesWithSharedPrimary: 0,
    ratings: { A: 0, B: 0, C: 0, D: 0 }
  };

  elements.municipalitySourcesTotalChip.textContent = `${safeReport.totalMunicipalities ?? 0} Gemeinden`;
  elements.municipalitySourcesConfiguredChip.textContent = `${safeReport.totalUniqueSources ?? 0} eindeutige Quellen`;
  elements.municipalityRatingAChip.textContent = `A: ${safeReport.ratings?.A ?? 0}`;
  elements.municipalityRatingBChip.textContent = `B: ${safeReport.ratings?.B ?? 0}`;
  elements.municipalityRatingCChip.textContent = `C: ${safeReport.ratings?.C ?? 0}`;
  elements.municipalityRatingDChip.textContent = `D: ${safeReport.ratings?.D ?? 0}`;
  elements.municipalitySharedSourcesChip.textContent = `${safeReport.municipalitiesWithSharedPrimary ?? 0} geteilte Primärquellen`;
  elements.municipalityCoverageReportText.textContent =
    `${safeReport.totalMunicipalities ?? 0} Gemeinden, ${safeReport.totalUniqueSources ?? 0} eindeutige Quellen, ` +
    `${safeReport.uncertainMunicipalities ?? 0} unsichere Bewertungen.`;
}

function renderSharedSources(sharedSources = []) {
  if (!sharedSources.length) {
    elements.sharedSourcesList.innerHTML = "";
    elements.sharedSourcesEmptyState.classList.remove("hidden");
    return;
  }

  elements.sharedSourcesEmptyState.classList.add("hidden");
  elements.sharedSourcesList.innerHTML = sharedSources
    .map(
      (source) => `
        <li class="shared-source-item">
          <div>
            <strong>${escapeHtml(source.name)}</strong>
            <span class="municipality-source-row-meta">${escapeHtml(source.sourceKind)} · ${source.municipalityCount} Gemeinden</span>
          </div>
          <a href="${escapeHtml(source.canonicalUrl || "#")}" target="_blank" rel="noreferrer">
            ${escapeHtml(shortenUrlForDisplay(source.canonicalUrl || ""))}
          </a>
        </li>
      `
    )
    .join("");
}

function populateMunicipalitySourceForm(source) {
  if (!source) {
    clearMunicipalitySourceForm();
    return;
  }

  elements.municipalitySourceCurrentLabel.textContent = `${source.municipality} wird jetzt bearbeitet.`;
  populateMunicipalitySourceInsights(source);
  elements.municipalitySourceTypeSelect.value = source.sourceType;
  elements.municipalitySourceDigitalStatusSelect.value = source.digitalStatus;
  elements.municipalitySourceEnabledCheckbox.checked = Boolean(source.enabled);
  elements.municipalitySourceUrlInput.value = source.sourceUrl ?? "";
  elements.municipalitySourceTokenInput.value = source.sourceToken ?? "";
  elements.municipalitySourceIncludePatternInput.value = source.includePattern ?? "";
  elements.municipalitySourceExcludePatternInput.value = source.excludePattern ?? "";
  elements.municipalitySourceNotesInput.value = source.notes ?? "";
  elements.saveMunicipalitySourceButton.disabled = false;
}

function renderMunicipalitySources(payload = null) {
  if (payload) {
    state.municipalitySources = payload.items ?? [];
    state.municipalitySourceSummary = payload.summary ?? null;
    state.municipalitySourceCatalog = payload.catalogItems ?? state.municipalitySourceCatalog;
    state.municipalitySourceReport = payload.report ?? state.municipalitySourceReport;
    state.sharedPublicationSources = payload.sharedSources ?? state.sharedPublicationSources;
  }

  if (!isMasterUser()) {
    elements.municipalitySourcesList.innerHTML = "";
    elements.municipalitySourcesEmptyState.classList.add("hidden");
    renderSharedSources([]);
    renderMunicipalityCoverageReport(null);
    clearMunicipalitySourceForm();
    return;
  }

  const summary = state.municipalitySourceSummary ?? {
    totalCount: 0,
    configuredCount: 0,
    enabledCount: 0
  };
  const filteredSources = getFilteredMunicipalitySources();

  renderMunicipalityCoverageReport(state.municipalitySourceReport);
  renderSharedSources(state.sharedPublicationSources);
  elements.municipalitySourcesEnabledChip.textContent = `${summary.enabledCount ?? 0} automatisch aktiv`;

  if (!filteredSources.length) {
    elements.municipalitySourcesList.innerHTML = "";
    elements.municipalitySourcesEmptyState.classList.remove("hidden");
    state.selectedMunicipalitySourceId = null;
    clearMunicipalitySourceForm();
    return;
  }

  elements.municipalitySourcesEmptyState.classList.add("hidden");

  if (
    !state.selectedMunicipalitySourceId ||
    !filteredSources.some((source) => source.operationalId === state.selectedMunicipalitySourceId)
  ) {
    state.selectedMunicipalitySourceId = filteredSources[0].operationalId;
  }

  elements.municipalitySourcesList.innerHTML = filteredSources
    .map((source) => {
      const configured = Boolean(source.primaryDirectUrl || source.primarySourceCanonicalUrl || source.officialWebsite);
      const selected = source.operationalId === state.selectedMunicipalitySourceId;
      const sourceBadgeClass = source.enabled ? "ok" : configured ? "alert" : "neutral";
      const sourceBadgeLabel = source.enabled ? "Automatisch" : configured ? "Bereit" : "Offen";
      const sourceHint = configured
        ? shortenUrlForDisplay(source.primaryDirectUrl || source.primarySourceCanonicalUrl || source.officialWebsite)
        : "Noch keine URL hinterlegt";
      const sharedText = source.primaryShared ? ` · geteilt mit ${source.primarySharedCount} Gemeinden` : "";

      return `
        <button
          class="municipality-source-row ${selected ? "selected" : ""}"
          type="button"
          data-municipality-source-id="${escapeHtml(source.operationalId)}"
        >
          <span class="municipality-source-row-main">
            <strong>${escapeHtml(source.municipality)}</strong>
            <span class="municipality-source-row-meta">${escapeHtml(source.primarySourceName || "Keine Primärquelle")} · ${escapeHtml(sourceHint)}</span>
            <span class="municipality-source-row-meta">${escapeHtml(source.rationale || "")}</span>
          </span>
          <span class="municipality-source-row-side">
            <span class="badge ${getRatingBadgeClass(source.rating)}">Rating ${escapeHtml(source.rating || "-")}</span>
            <span class="badge ${sourceBadgeClass}">${escapeHtml(sourceBadgeLabel)}</span>
            <span class="municipality-source-row-meta">
              ${escapeHtml(municipalitySourceTypeLabels[source.sourceType] ?? source.sourceType)}
              ·
              ${escapeHtml(municipalityDigitalStatusLabels[source.digitalStatus] ?? source.digitalStatus)}
              ${escapeHtml(sharedText)}
            </span>
          </span>
        </button>
      `;
    })
    .join("");

  const selectedSource =
    state.municipalitySourceCatalog.find((source) => source.operationalId === state.selectedMunicipalitySourceId) ?? null;
  populateMunicipalitySourceForm(selectedSource);
}

function renderSyncSettings(payload = null) {
  state.syncSettings = payload;

  if (!isMasterUser()) {
    elements.syncSourceTypeSelect.value = "";
    elements.syncSourceMunicipalityInput.value = "";
    elements.syncSourceUrlInput.value = "";
    elements.syncSourceTokenInput.value = "";
    elements.syncSettingsStatus.textContent = "Noch keine automatische Import-Quelle gespeichert.";
    return;
  }

  const sourceUrl = payload?.sourceUrl ?? "";
  const sourceToken = payload?.sourceToken ?? "";
  const sourceType = payload?.sourceType ?? "";
  const sourceMunicipality = payload?.sourceMunicipality ?? "";
  const municipalitySourcesSummary =
    payload?.municipalitySourcesSummary ??
    state.municipalitySourceSummary ??
    state.dashboard?.municipalitySourcesSummary ??
    null;
  const syncStatus = payload?.syncStatus ?? state.dashboard?.syncStatus ?? null;
  elements.syncSourceTypeSelect.value = sourceType;
  elements.syncSourceMunicipalityInput.value = sourceMunicipality;
  elements.syncSourceUrlInput.value = sourceUrl;
  elements.syncSourceTokenInput.value = sourceToken;
  updateSyncSourceUi();
  if (municipalitySourcesSummary) {
    state.municipalitySourceSummary = municipalitySourcesSummary;
  }

  if (!sourceUrl) {
    elements.syncSettingsStatus.textContent =
      `Noch keine globale Import-Quelle gespeichert. Aktivierte Gemeindequellen: ${municipalitySourcesSummary?.enabledCount ?? 0}.`;
    return;
  }

  const intervalHours = syncStatus?.intervalHours ?? 168;
  const nextRunAt = syncStatus?.job?.nextRunAt ? formatDateTime(syncStatus.job.nextRunAt) : "noch nicht geplant";
  const typeLabel = sourceType
    ? municipalitySourceTypeLabels[sourceType] ?? sourceType
    : "automatische Erkennung";
  const municipalityText = sourceMunicipality ? ` Gemeinde: ${sourceMunicipality}.` : "";
  const sourceModeText = sourceToken
    ? `Geschützte Quelle gespeichert (${typeLabel}). Der Zugriffsschlüssel wird beim Import mitverwendet.`
    : `Öffentliche Quelle gespeichert (${typeLabel}).`;
  elements.syncSettingsStatus.textContent = `${sourceModeText}${municipalityText} Aktivierte Gemeindequellen: ${municipalitySourcesSummary?.enabledCount ?? 0}. Die Quelle wird etwa alle ${intervalHours} Stunden geprüft. Nächster geplanter Lauf: ${nextRunAt}.`;
}

function updateSyncSourceUi() {
  const sourceType = elements.syncSourceTypeSelect.value;
  const municipalityRequired = globalScrapingSourceTypes.has(sourceType);

  elements.syncSourceMunicipalityInput.required = municipalityRequired;
  elements.syncSourceMunicipalityInput.placeholder = municipalityRequired
    ? "Pflicht für Website-, RSS-/Sitemap- und PDF-Scraping"
    : "Optional, zum Beispiel: Aarau";
}

function notificationHeadline(notification) {
  if (notification.changeType === "imported") {
    return "Neuer automatischer Treffer";
  }

  return "Automatisch aktualisiert";
}

function renderNotifications(notifications = []) {
  if (!isMasterUser() || !state.adminPanelExpanded) {
    elements.notificationsPanel.classList.add("hidden");
    elements.notificationsList.innerHTML = "";
    elements.notificationsEmptyState.classList.add("hidden");
    return;
  }

  const items = Array.isArray(notifications)
    ? notifications
        .filter(
          (notification) =>
            notification.protectionStatus &&
            notification.protectionStatus !== "manual-review" &&
            notification.protectionStatus !== "no-hit"
        )
        .slice(0, 3)
    : [];
  elements.notificationsPanel.classList.toggle("hidden", items.length === 0);

  if (!items.length) {
    elements.notificationsList.innerHTML = "";
    elements.notificationsEmptyState.classList.remove("hidden");
    return;
  }

  elements.notificationsEmptyState.classList.add("hidden");
  elements.notificationsList.innerHTML = items
    .map(
      (notification) => `
        <article class="notification-card">
          <div class="notification-copy">
            <p class="panel-title">${escapeHtml(notificationHeadline(notification))}</p>
            <strong>${escapeHtml(`${notification.municipality}, ${notification.address}`)}</strong>
            <p class="muted notification-meta">
              ${escapeHtml(protectionStatusLabels[notification.protectionStatus] ?? notification.protectionStatus)}
              · ${escapeHtml(notification.sourceLabel || "Import")}
              · ${escapeHtml(formatDateTime(notification.createdAt))}
            </p>
          </div>
          <button
            class="ghost compact-button"
            type="button"
            data-notification-application-id="${escapeHtml(notification.applicationId)}"
          >
            Öffnen
          </button>
        </article>
      `
    )
    .join("");
}

async function loadComments(applicationId) {
  state.commentsRequestToken += 1;
  const requestToken = state.commentsRequestToken;
  elements.commentsEmptyState.textContent = "Team-Kommentare werden geladen.";
  elements.commentsEmptyState.classList.remove("hidden");
  elements.commentsList.innerHTML = "";

  const payload = await requestJson(`/api/applications/${applicationId}/comments`);

  if (requestToken !== state.commentsRequestToken || state.selectedId !== applicationId) {
    return;
  }

  elements.commentsEmptyState.textContent = "Noch keine Team-Kommentare vorhanden.";
  renderComments(payload.items ?? []);
}

async function loadRegistrationKeys() {
  if (!isMasterUser()) {
    renderRegistrationKeys([]);
    return;
  }

  elements.registrationKeysEmptyState.textContent = "Registrierungsschlüssel werden geladen.";
  elements.registrationKeysEmptyState.classList.remove("hidden");
  elements.registrationKeysList.innerHTML = "";

  const payload = await requestJson("/api/admin/registration-keys");
  elements.registrationKeysEmptyState.textContent = "Noch keine Registrierungsschlüssel vorhanden.";
  renderRegistrationKeys(payload.items ?? []);
}

async function loadAdminUsers() {
  if (!isMasterUser()) {
    renderAdminUsers([]);
    return;
  }

  const payload = await requestJson("/api/admin/users");
  renderAdminUsers(payload.items ?? []);
}

async function loadSyncSettings() {
  if (!isMasterUser()) {
    renderSyncSettings(null);
    return;
  }

  const payload = await requestJson("/api/admin/sync-settings");
  renderSyncSettings(payload);
}

async function loadMunicipalitySources() {
  if (!isMasterUser()) {
    renderMunicipalitySources();
    return;
  }

  const payload = await requestJson("/api/admin/municipality-sources");
  renderMunicipalitySources(payload);
}

async function maybeRevealMasterSetup() {
  try {
    const payload = await requestJson("/api/auth/master-setup-status", {
      skipSessionReset: true
    });

    if (payload?.setupRequired) {
      elements.masterSetupForm.classList.remove("hidden");
    }
  } catch {
    // Status ist optional – bei Fehlern bleibt das Formular ausgeblendet.
  }
}

async function restoreSession() {
  const payload = await requestJson("/api/auth/session", {
    skipSessionReset: true
  });

  if (!payload.authenticated || !payload.user) {
    setAuthenticatedUser(null);
    return false;
  }

  setAuthenticatedUser(payload.user);
  return true;
}

async function showAuthenticatedApp() {
  await refreshAll();
  await loadRegistrationKeys();
  await loadAdminUsers();
  await loadTwoFactorStatus();
  await loadMunicipalitySources();
  await loadSyncSettings();
}


function renderTwoFactorStatus(enabled) {
  elements.twoFactorStatus.textContent = enabled
    ? "Status: aktiviert. Das Master-Login verlangt einen Code aus der Authenticator-App."
    : "Status: nicht aktiviert.";
  elements.twoFactorSetupButton.classList.toggle("hidden", enabled);
  elements.twoFactorSetupArea.classList.add("hidden");
  elements.twoFactorDisableArea.classList.toggle("hidden", !enabled);
}

async function loadTwoFactorStatus() {
  if (!isMasterUser()) {
    return;
  }

  setTwoFactorError("");
  setTwoFactorSuccess("");

  try {
    const payload = await requestJson("/api/admin/2fa/status");
    renderTwoFactorStatus(Boolean(payload.enabled));
  } catch {
    // 2FA-Status ist nicht kritisch für den Rest der Oberfläche.
  }
}

async function loadDashboard() {
  state.dashboard = await requestJson("/api/dashboard");
  updateFilterOptions(state.dashboard);
  renderDashboard();
}

async function loadApplications() {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(state.filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  const payload = await requestJson(`/api/applications?${params.toString()}`);
  state.loadedItems = payload.items;
  state.items = buildVisibleItems(payload.items);
  renderApplications();
}

async function refreshAll() {
  await loadDashboard();
  await loadApplications();
}

async function patchSelectedApplication(changes, successMessage) {
  if (!state.selectedId) {
    return;
  }

  await requestJson(`/api/applications/${state.selectedId}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  });

  await refreshAll();
  showToast(successMessage);
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoginError("");

    try {
      await withBusyState(elements.loginButton, "Anmelden...", async () => {
        const body = {
          username: elements.loginUsername.value.trim().toLowerCase(),
          password: elements.loginPassword.value
        };

        const totpCode = elements.loginTotp.value.trim();

        if (totpCode) {
          body.totp = totpCode;
        }

        const captchaToken = turnstileToken("loginTurnstile");

        if (captchaToken) {
          body.turnstileToken = captchaToken;
        }

        const payload = await requestJson("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(body),
          skipSessionReset: true
        });

        persistRememberedUsername();
        setAuthenticatedUser(payload.user);
        await showAuthenticatedApp();
        elements.loginPassword.value = "";
        elements.loginTotp.value = "";
        elements.loginTotpField.classList.add("hidden");
        showToast(`Angemeldet als ${payload.user.displayName}.`);
      });
    } catch (error) {
      // Master-Konto mit aktivierter 2FA: Code-Feld einblenden und nachfordern.
      if (error?.payload?.totpRequired) {
        elements.loginTotpField.classList.remove("hidden");
        focusWithoutScroll(elements.loginTotp);
        setLoginError(error.message);
        return;
      }

      // Ab dem 2. Versuch verlangt der Server eine Bot-Prüfung: Widget einblenden.
      if (error?.payload?.captchaRequired) {
        ensureTurnstileWidget(elements.loginTurnstile);
      }

      setLoginError(error.message);
    }
  });

  elements.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setRegisterError("");

    try {
      await withBusyState(elements.registerButton, "Konto wird erstellt...", async () => {
        const payload = await requestJson("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            displayName: elements.registerDisplayName.value,
            username: elements.registerUsername.value,
            email: elements.registerEmail.value,
            password: elements.registerPassword.value,
            accessKey: elements.registerAccessKey.value,
            turnstileToken: turnstileToken("registerTurnstile")
          }),
          skipSessionReset: true
        });

        setAuthenticatedUser(payload.user);
        clearRegisterForm();
        elements.loginPassword.value = "";
        await showAuthenticatedApp();
        showToast(`Konto erstellt und angemeldet als ${payload.user.displayName}.`);
      });
    } catch (error) {
      setRegisterError(error.message);
    }
  });

  elements.masterSetupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMasterSetupError("");
    setMasterSetupSuccess("");

    try {
      await withBusyState(elements.masterSetupButton, "Wird gesetzt...", async () => {
        const payload = await requestJson("/api/auth/master-setup", {
          method: "POST",
          body: JSON.stringify({
            key: elements.masterSetupKey.value.trim(),
            password: elements.masterSetupPassword.value
          }),
          skipSessionReset: true
        });

        elements.masterSetupKey.value = "";
        elements.masterSetupPassword.value = "";
        setMasterSetupSuccess(payload.message ?? "Master-Passwort wurde gesetzt. Sie können sich jetzt anmelden.");
        elements.loginUsername.value = "master";
        focusWithoutScroll(elements.loginPassword);
        showToast("Master-Passwort wurde gesetzt.");
      });
    } catch (error) {
      setMasterSetupError(error.message);
    }
  });

  elements.showRegisterButton.addEventListener("click", () => {
    elements.loginForm.classList.add("hidden");
    elements.registerForm.classList.remove("hidden");
    ensureTurnstileWidget(elements.registerTurnstile);
    focusWithoutScroll(elements.registerDisplayName);
  });

  elements.showLoginButton.addEventListener("click", () => {
    elements.registerForm.classList.add("hidden");
    elements.loginForm.classList.remove("hidden");
    focusWithoutScroll(elements.loginUsername);
  });

  elements.showForgotPasswordButton.addEventListener("click", () => {
    elements.forgotPasswordForm.classList.remove("hidden");
    elements.resetPasswordForm.classList.remove("hidden");
    ensureTurnstileWidget(elements.forgotTurnstile);
    focusWithoutScroll(elements.forgotPasswordEmail);
  });

  elements.forgotPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setForgotPasswordError("");
    setForgotPasswordSuccess("");

    try {
      await withBusyState(elements.forgotPasswordButton, "Wird gesendet...", async () => {
        const payload = await requestJson("/api/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({
            email: elements.forgotPasswordEmail.value.trim().toLowerCase(),
            turnstileToken: turnstileToken("forgotTurnstile")
          }),
          skipSessionReset: true
        });

        setForgotPasswordSuccess(
          payload.message ?? "Falls eine E-Mail hinterlegt ist, wurde ein Reset-Schlüssel versendet."
        );
        focusWithoutScroll(elements.resetPasswordKey);
      });
    } catch (error) {
      setForgotPasswordError(error.message);
    }
  });

  elements.resetPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setResetPasswordError("");
    setResetPasswordSuccess("");

    try {
      await withBusyState(elements.resetPasswordButton, "Wird gespeichert...", async () => {
        const payload = await requestJson("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({
            key: elements.resetPasswordKey.value.trim(),
            password: elements.resetPasswordValue.value
          }),
          skipSessionReset: true
        });

        elements.resetPasswordKey.value = "";
        elements.resetPasswordValue.value = "";
        setResetPasswordSuccess(payload.message ?? "Passwort wurde gesetzt. Sie können sich jetzt anmelden.");
        focusWithoutScroll(elements.loginPassword);
        showToast("Passwort wurde zurückgesetzt.");
      });
    } catch (error) {
      setResetPasswordError(error.message);
    }
  });

  elements.rememberUsernameCheckbox.addEventListener("change", () => {
    persistRememberedUsername();
  });

  elements.loginUsername.addEventListener("input", () => {
    if (elements.rememberUsernameCheckbox.checked) {
      persistRememberedUsername();
    }
  });

  elements.logoutButton.addEventListener("click", async () => {
    try {
      await requestJson("/api/auth/logout", {
        method: "POST",
        skipSessionReset: true
      });
    } catch {
      // Even if the request fails, we return to the login screen.
    }

    setAuthenticatedUser(null);
    setLoginError("");
    focusWithoutScroll(elements.loginUsername);
    showToast("Sie wurden abgemeldet.");
  });

  elements.createRegistrationKeyButton.addEventListener("click", async () => {
    try {
      await withBusyState(elements.createRegistrationKeyButton, "Wird erstellt...", async () => {
        const payload = await requestJson("/api/admin/registration-keys", {
          method: "POST",
          body: JSON.stringify({
            note: elements.registrationKeyNote.value
          })
        });

        elements.registrationKeyNote.value = "";
        await loadRegistrationKeys();
        showToast(`Neuer Registrierungsschlüssel erstellt: ${payload.keyCode}`);
      });
    } catch (error) {
      showToast(error.message);
    }
  });

    elements.adminPasswordResetButton.addEventListener("click", async () => {
      const userId = elements.adminUserSelect.value;
      const selectedUser = state.adminUsers.find((user) => user.id === userId);

      if (!userId || !selectedUser) {
        showToast("Bitte zuerst eine Person auswählen.");
        return;
      }

      if (elements.adminPasswordResetInput.value.length < 8) {
        showToast("Das neue Passwort muss mindestens 8 Zeichen lang sein.");
        return;
      }

      const confirmed = await openConfirmDialog({
        eyebrow: "Passwort zurücksetzen",
        title: "Neues Passwort setzen",
        message: `Möchten Sie für ${selectedUser.displayName} wirklich ein neues Passwort setzen?`,
        confirmLabel: "Ja, setzen"
      });

      if (!confirmed) {
        return;
      }

      try {
        await withBusyState(elements.adminPasswordResetButton, "Wird gesetzt...", async () => {
          const payload = await requestJson(`/api/admin/users/${userId}/password`, {
            method: "PATCH",
            body: JSON.stringify({
              password: elements.adminPasswordResetInput.value
            })
          });

          clearAdminPasswordResetForm();
          showToast(payload.message ?? `Passwort für ${selectedUser.displayName} gesetzt.`);
        });
      } catch (error) {
        showToast(error.message);
      }
    });

    elements.twoFactorSetupButton.addEventListener("click", async () => {
      setTwoFactorError("");
      setTwoFactorSuccess("");

      try {
        await withBusyState(elements.twoFactorSetupButton, "Wird vorbereitet...", async () => {
          const payload = await requestJson("/api/admin/2fa/setup", { method: "POST" });
          elements.twoFactorSecret.textContent = payload.secret;
          elements.twoFactorSetupArea.classList.remove("hidden");
          focusWithoutScroll(elements.twoFactorCode);
        });
      } catch (error) {
        setTwoFactorError(error.message);
      }
    });

    elements.twoFactorEnableButton.addEventListener("click", async () => {
      setTwoFactorError("");
      setTwoFactorSuccess("");

      try {
        await withBusyState(elements.twoFactorEnableButton, "Wird aktiviert...", async () => {
          const payload = await requestJson("/api/admin/2fa/enable", {
            method: "POST",
            body: JSON.stringify({ code: elements.twoFactorCode.value.trim() })
          });

          elements.twoFactorCode.value = "";
          renderTwoFactorStatus(true);
          setTwoFactorSuccess(payload.message ?? "Zwei-Faktor-Authentifizierung ist aktiviert.");
          showToast("2FA aktiviert.");
        });
      } catch (error) {
        setTwoFactorError(error.message);
      }
    });

    elements.twoFactorDisableButton.addEventListener("click", async () => {
      setTwoFactorError("");
      setTwoFactorSuccess("");

      try {
        await withBusyState(elements.twoFactorDisableButton, "Wird deaktiviert...", async () => {
          const payload = await requestJson("/api/admin/2fa/disable", {
            method: "POST",
            body: JSON.stringify({ code: elements.twoFactorDisableCode.value.trim() })
          });

          elements.twoFactorDisableCode.value = "";
          renderTwoFactorStatus(false);
          setTwoFactorSuccess(payload.message ?? "Zwei-Faktor-Authentifizierung ist deaktiviert.");
          showToast("2FA deaktiviert.");
        });
      } catch (error) {
        setTwoFactorError(error.message);
      }
    });

    elements.manualImportButton.addEventListener("click", async () => {
      const jsonText = elements.manualImportJsonInput.value.trim();

      if (!jsonText) {
        showToast("Bitte zuerst einen JSON-Export einfügen.");
        return;
      }

      try {
        await withBusyState(elements.manualImportButton, "Import läuft...", async () => {
          const payload = await requestJson("/api/admin/import-json", {
            method: "POST",
            body: JSON.stringify({
              jsonText
            }),
            timeoutMs: 120000
          });

          elements.manualImportJsonInput.value = "";
          await refreshAll();
          showToast(payload.message ?? "JSON-Export importiert.");
        });
      } catch (error) {
        showToast(error.message);
      }
    });

    elements.saveSyncSettingsButton.addEventListener("click", async () => {
      const sourceType = elements.syncSourceTypeSelect.value;
      const sourceUrl = elements.syncSourceUrlInput.value.trim();
      const sourceMunicipality = elements.syncSourceMunicipalityInput.value.trim();

      if (sourceUrl && globalScrapingSourceTypes.has(sourceType) && !sourceMunicipality) {
        showToast("Bitte die Gemeinde für das Scraping angeben.");
        elements.syncSourceMunicipalityInput.focus();
        return;
      }

      try {
        await withBusyState(elements.saveSyncSettingsButton, "Speichern...", async () => {
          const payload = await requestJson("/api/admin/sync-settings", {
            method: "PATCH",
            body: JSON.stringify({
              sourceType,
              sourceMunicipality,
              sourceUrl,
              sourceToken: elements.syncSourceTokenInput.value
            })
          });

          renderSyncSettings(payload);
          showToast(payload.message ?? "Automatische Import-Quelle gespeichert.");
        });
      } catch (error) {
        showToast(error.message);
      }
    });

    elements.syncSourceTypeSelect.addEventListener("change", updateSyncSourceUi);

    elements.runSyncNowButton.addEventListener("click", async () => {
      try {
        await withBusyState(elements.runSyncNowButton, "Synchronisiert...", async () => {
          const payload = await requestJson("/api/sync", {
            method: "POST",
            timeoutMs: 300000
          });

          await refreshAll();
          await loadMunicipalitySources();
          await loadSyncSettings();
          showToast(payload.message ?? "Synchronisation abgeschlossen.");
        });
      } catch (error) {
        showToast(error.message);
      }
    });

    elements.municipalitySourceSearchInput.addEventListener("input", (event) => {
      state.municipalitySourceSearch = event.target.value;
      renderMunicipalitySources();
    });

    elements.municipalitySourcesList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-municipality-source-id]");

      if (!button) {
        return;
      }

      state.selectedMunicipalitySourceId = button.dataset.municipalitySourceId;
      renderMunicipalitySources();
    });

    elements.municipalitySourceForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!state.selectedMunicipalitySourceId) {
        showToast("Bitte zuerst eine Gemeinde auswählen.");
        return;
      }

      try {
        await withBusyState(elements.saveMunicipalitySourceButton, "Speichern...", async () => {
          const payload = await requestJson(`/api/admin/municipality-sources/${state.selectedMunicipalitySourceId}`, {
            method: "PATCH",
            body: JSON.stringify({
              sourceType: elements.municipalitySourceTypeSelect.value,
              digitalStatus: elements.municipalitySourceDigitalStatusSelect.value,
              enabled: elements.municipalitySourceEnabledCheckbox.checked,
              sourceUrl: elements.municipalitySourceUrlInput.value,
              sourceToken: elements.municipalitySourceTokenInput.value,
              includePattern: elements.municipalitySourceIncludePatternInput.value,
              excludePattern: elements.municipalitySourceExcludePatternInput.value,
              notes: elements.municipalitySourceNotesInput.value
            })
          });

          const updatedItems = state.municipalitySources.map((source) =>
            source.id === payload.item.id ? payload.item : source
          );
          renderMunicipalitySources({
            items: updatedItems,
            summary: payload.summary ?? state.municipalitySourceSummary,
            catalogItems: payload.catalogItems ?? state.municipalitySourceCatalog,
            sharedSources: payload.sharedSources ?? state.sharedPublicationSources,
            report: payload.report ?? state.municipalitySourceReport
          });
          renderSyncSettings({
            ...(state.syncSettings ?? {}),
            municipalitySourcesSummary: payload.summary ?? state.municipalitySourceSummary,
            syncStatus: state.dashboard?.syncStatus ?? state.syncSettings?.syncStatus ?? null
          });
          showToast(payload.message ?? "Gemeindequelle gespeichert.");
        });
      } catch (error) {
        showToast(error.message);
      }
    });

    elements.notificationsList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-notification-application-id]");

      if (!button) {
        return;
      }

      selectApplication(button.dataset.notificationApplicationId, {
        scrollToDetail: true
      });
    });

    elements.registrationKeysList.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-registration-key-id]");

      if (!button) {
        return;
      }

      const keyId = button.dataset.registrationKeyId;

      if (!keyId) {
        return;
      }

      const confirmed = await openConfirmDialog({
        eyebrow: "Registrierungsschlüssel",
        title: "Schlüssel löschen",
        message: "Möchten Sie diesen offenen Registrierungsschlüssel wirklich löschen?",
        confirmLabel: "Ja, löschen"
      });

      if (!confirmed) {
        return;
      }

      try {
        await withBusyState(button, "Löschen...", async () => {
          await requestJson(`/api/admin/registration-keys/${keyId}`, {
            method: "DELETE"
          });

          await loadRegistrationKeys();
          showToast("Registrierungsschlüssel gelöscht.");
        });
      } catch (error) {
        showToast(error.message);
      }
    });

    elements.confirmAcceptButton.addEventListener("click", () => {
      closeConfirmDialog(true);
    });

    elements.confirmCancelButton.addEventListener("click", () => {
      closeConfirmDialog(false);
    });

    elements.confirmOverlay.addEventListener("click", (event) => {
      if (event.target === elements.confirmOverlay) {
        closeConfirmDialog(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.confirmOverlay.classList.contains("hidden")) {
        closeConfirmDialog(false);
      }
    });

  elements.commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.selectedId) {
      return;
    }

    try {
      await withBusyState(elements.commentSubmitButton, "Speichern...", async () => {
        await requestJson(`/api/applications/${state.selectedId}/comments`, {
          method: "POST",
          body: JSON.stringify({
            message: elements.commentInput.value
          })
        });

        elements.commentInput.value = "";
        await loadComments(state.selectedId);
        showToast("Team-Kommentar gespeichert.");
      });
    } catch (error) {
      showToast(error.message);
    }
  });

  elements.searchInput.addEventListener("input", (event) => {
    clearTimeout(searchTimeoutId);
    state.filters.search = event.target.value;

    searchTimeoutId = setTimeout(() => {
      loadApplications().catch((error) => showToast(error.message));
    }, 180);
  });

  // Masthead-Suchfeld (Amtlich-Kopf) springt auf die echte Listensuche.
  document.querySelector("#mastheadSearchButton")?.addEventListener("click", () => {
    elements.searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
    elements.searchInput.focus();
  });

  elements.filtersForm.addEventListener("change", (event) => {
    const target = event.target;
    state.filters[target.name] = target.value;
    loadApplications().catch((error) => showToast(error.message));
  });

  elements.resetFiltersButton.addEventListener("click", () => {
    state.filters = {
      search: "",
      municipality: "",
      protectionStatus: "",
      workflowStatus: ""
    };
    setQuickFilters(["all"]);

    elements.searchInput.value = "";
    elements.municipalitySelect.value = "";
    elements.protectionStatusSelect.value = "";
    elements.workflowStatusSelect.value = "";

    loadApplications().catch((error) => showToast(error.message));
  });

  elements.fontSizeToggleButton.addEventListener("click", () => {
    state.largeTextEnabled = !state.largeTextEnabled;
    localStorage.setItem("heimatschutz-large-text", state.largeTextEnabled ? "1" : "0");
    updateFontSizeUi();
  });

  elements.themeToggleButton?.addEventListener("click", () => {
    state.darkModeEnabled = !state.darkModeEnabled;
    localStorage.setItem("heimatschutz-dark-mode", state.darkModeEnabled ? "1" : "0");
    updateThemeUi();
    window.dispatchEvent(new CustomEvent("heimatschutz-dark-mode-change", {
      detail: { enabled: state.darkModeEnabled }
    }));
  });

  elements.toggleAdminPanelButton.addEventListener("click", () => {
    if (!isMasterUser()) {
      return;
    }

    state.adminPanelExpanded = !state.adminPanelExpanded;
    updateMasterUi();
  });

  // Zurück-Button auf der Verwaltungs-Seite schliesst die Admin-Ansicht.
  document.querySelector("#adminBackButton")?.addEventListener("click", () => {
    state.adminPanelExpanded = false;
    updateMasterUi();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  for (const button of elements.quickFilterButtons) {
    button.addEventListener("click", () => {
      toggleQuickFilter(button.dataset.quickFilter);
      state.items = buildVisibleItems(state.loadedItems);
      renderApplications();
    });
  }

  elements.applicationsTableBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");

    if (!row) {
      return;
    }

    selectApplication(row.dataset.id, { scrollToDetail: true });
  });

  elements.applicationsTableBody.addEventListener("keydown", (event) => {
    const row = event.target.closest("tr[data-id]");

    if (!row || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    selectApplication(row.dataset.id, { scrollToDetail: true });
  });

  elements.nextOpenButton.addEventListener("click", () => {
    const nextOpenItem = findNextOpenItem();

    if (!nextOpenItem) {
      return;
    }

    selectApplication(nextOpenItem.id, { scrollToDetail: true });
  });

  elements.detailForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await withBusyState(elements.saveButton, "Speichern...", () =>
        patchSelectedApplication(
          {
            workflowStatus: elements.detailWorkflowStatus.value,
            assignee: getAssigneeValue(),
            note: elements.detailNote.value
          },
          "Änderungen gespeichert."
        )
      );
    } catch (error) {
      showToast(error.message);
    }
  });

  elements.clearButton.addEventListener("click", async () => {
    try {
      await withBusyState(elements.clearButton, "Markieren...", () =>
        patchSelectedApplication(
          {
            workflowStatus: "cleared",
            assignee: getAssigneeValue(),
            note: elements.detailNote.value
          },
          "Gesuch als erledigt markiert."
        )
      );
    } catch (error) {
      showToast(error.message);
    }
  });

}

async function init() {
  state.largeTextEnabled = localStorage.getItem("heimatschutz-large-text") === "1";
  updateFontSizeUi();
  const storedDarkMode = localStorage.getItem("heimatschutz-dark-mode");
  state.darkModeEnabled =
    storedDarkMode === "1" ||
    (storedDarkMode === null && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  updateThemeUi();
  loadRememberedUsername();
  bindEvents();
  await loadAuthConfig();

  try {
    const hasSession = await restoreSession();

    if (hasSession) {
      await showAuthenticatedApp();
    } else {
      await maybeRevealMasterSetup();
      focusWithoutScroll(elements.loginUsername);
    }
  } catch (error) {
    setLoginError(error.message);
  }
}

init();
